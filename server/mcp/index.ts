import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
  McpError,
  ErrorCode,
} from '@modelcontextprotocol/sdk/types.js';
import { storeTrace, newTraceUri, recordOutcome, retractMemory } from '../ingest.js';
import type { ConsolidationPolicy } from '../ingest.js';
import { embed, toVectorLiteral } from '../embedding.js';
import { toPrecedent } from '../recall.js';
import { composeWake } from '../wake/wake.js';
import { sanitizeUri } from '../middleware/guardrails.js';
import { validateTraceInput, validateOutcome, clampInt } from '../validate.js';

function domainOf(uri: string): string | null {
  const parts = uri.split('://');
  return parts.length > 1 ? parts[1].split('/')[0] : null;
}

// One audit row per tool call / resource read (allow, deny, error) — the same
// trail the REST routes leave, written by the transport that owns the actor.
export interface AuditEntry {
  action: string;
  result: 'allow' | 'deny' | 'error';
  uri?: string;
  trustDomain?: string;
  detail?: any;
}

export interface MCPConfig {
  trustDomain: string;
  privateKeyPem: string;
  // Actions this session is permitted to perform. When omitted (e.g. a trusted
  // local stdio channel) all actions are allowed. For remote HTTP sessions this
  // is derived from the caller's capability token so the same governance model
  // applies across transports.
  allowedActions?: string[];
  // Actor recorded in envelope provenance and audit rows: the token subject for
  // HTTP sessions, 'mcp-stdio' for the local channel.
  subject?: string;
  // Optional precedent-recall weights (see adapters/postgres.ts). Defaults apply
  // when omitted.
  recallWeights?: { sim?: number; outcome?: number; recency?: number; halfLifeDays?: number };
  // Wake layer sizes for the `wake` tool / resource (defaults apply when omitted).
  wake?: { recent?: number; identity?: number; relevant?: number };
  // Consolidation policy for store_trace (CONSOLIDATE_SIM_THRESHOLD, tier
  // admission) — the same one POST /memory applies.
  policy?: ConsolidationPolicy;
  // Input limits shared with the REST API (CONTENT_MAX_LENGTH, ...).
  limits?: { contentMaxLength?: number; boundContextMax?: number; searchKMax?: number };
  // Optional text surfaced as the MCP `initialize` `instructions` — used to
  // carry the agent's wake brief (identity + recent) so a harness reloads its
  // self on connect. Computed per session before the server is constructed.
  instructions?: string;
  audit?: (entry: AuditEntry) => void;
}

// Messages a client may see verbatim: validation and not-found errors. Anything
// else (driver errors, signing-key state) is reported generically; the raw
// message goes to the audit sink only.
const CLIENT_SAFE =
  /^(trace |task |content |boundContext|decision|outcome|confidence|importance|supersedes|occurredAt|Invalid URI|Invalid scheme|Path traversal|URI too long|Decision not found|Memory not found|Decision belongs|Memory belongs)/;

function safeMessage(e: any): string {
  const m = e?.message || String(e);
  return CLIENT_SAFE.test(m) ? m : 'internal error';
}

// Audit action names match the REST routes so one query covers both transports.
const ACTION_OF: Record<string, string> = {
  store_trace: 'write',
  record_outcome: 'outcome',
  retract_memory: 'retract',
  search_memory: 'search',
  wake: 'wake',
};

// MCP server exposing CARMA to agents over any MCP transport (stdio for local
// harnesses, Streamable HTTP for remote ones). A stdio connection is treated as
// a trusted local channel (as MCP integrations typically are), so tools operate
// under the configured trust domain and sign envelopes with PRIVATE_KEY. Remote
// HTTP sessions are capability-token gated and carry allowedActions.
export class CARMAMCPServer {
  server: Server;

  private allows(action: string): boolean {
    const allowed = this.config.allowedActions;
    return !allowed || allowed.includes(action);
  }

  private audit(entry: AuditEntry) {
    try {
      this.config.audit?.(entry);
    } catch {
      /* audit must never break a call */
    }
  }

  // Tool outcomes are results, not protocol errors: the model sees the failure
  // as something it can correct, and the client never receives internal text.
  private denied(action: string, tool: string) {
    this.audit({ action: ACTION_OF[tool] ?? tool, result: 'deny', trustDomain: this.config.trustDomain, detail: { tool, reason: `capability lacks '${action}' action` } });
    return {
      content: [{ type: 'text', text: `Permission denied: capability lacks '${action}' action` }],
      isError: true,
    };
  }

  private failed(tool: string, e: any, uri?: string) {
    this.audit({ action: ACTION_OF[tool] ?? tool, result: 'error', uri, trustDomain: this.config.trustDomain, detail: { tool, error: e?.message || String(e) } });
    return { content: [{ type: 'text', text: `${tool} failed: ${safeMessage(e)}` }], isError: true };
  }

  constructor(private adapter: any, private config: MCPConfig) {
    this.server = new Server(
      { name: 'carma', version: '0.1.0' },
      {
        capabilities: { resources: {}, tools: {} },
        // The wake brief rides along on `initialize` so a harness reloads the
        // agent's identity/self as soon as it connects (surviving compaction).
        ...(config.instructions ? { instructions: config.instructions } : {}),
      }
    );

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
        {
          uri: this.wakeUri(),
          name: `${this.config.trustDomain} wake brief`,
          description:
            'Session-start "wake" brief: the agent\'s durable identity (pinned + semantic ' +
            'principles + agent-specs) and most recent decisions. Read this at the start of a ' +
            'session (or after a context compaction) to reload who you are and what you were doing.',
          mimeType: 'application/json',
        },
        {
          uri: `memory://${this.config.trustDomain}/*`,
          name: `${this.config.trustDomain} memories`,
          description: 'Addressable JSON-AM memories and traces in this trust domain.',
        },
      ],
    }));

    this.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const trustDomain = this.config.trustDomain;
      if (!this.allows('read')) {
        this.audit({ action: 'read', result: 'deny', uri: String(req.params.uri), trustDomain, detail: { reason: "capability lacks 'read' action" } });
        throw new McpError(ErrorCode.InvalidRequest, "Permission denied: capability lacks 'read' action");
      }
      // The wake brief is a composed view, not a stored envelope.
      if (req.params.uri === this.wakeUri()) {
        let payload: any;
        try {
          payload = await this.wake();
        } catch (e: any) {
          this.audit({ action: 'wake', result: 'error', trustDomain, detail: { resource: true, error: e?.message } });
          throw new McpError(ErrorCode.InternalError, 'internal error');
        }
        this.audit({ action: 'wake', result: 'allow', trustDomain, detail: { resource: true, ...payload.counts } });
        return {
          contents: [{ uri: req.params.uri, mimeType: 'application/json', text: JSON.stringify(payload) }],
        };
      }
      // Resource reads are confined to this session's trust domain — the same
      // rule REST /resolve applies through enforceCapability.
      let uri: string;
      try {
        uri = sanitizeUri(req.params.uri);
      } catch (e: any) {
        throw new McpError(ErrorCode.InvalidParams, e.message);
      }
      if (domainOf(uri) !== trustDomain) {
        this.audit({ action: 'read', result: 'deny', uri, trustDomain, detail: { reason: 'resource outside this session trust domain' } });
        throw new McpError(ErrorCode.InvalidRequest, 'Permission denied: resource outside this session trust domain');
      }
      let row: any;
      try {
        row = await this.adapter.resolve(uri);
      } catch (e: any) {
        this.audit({ action: 'read', result: 'error', uri, trustDomain, detail: { error: e?.message } });
        throw new McpError(ErrorCode.InternalError, 'internal error');
      }
      this.audit({ action: 'read', result: 'allow', uri, trustDomain, detail: { found: Boolean(row) } });
      return {
        contents: [
          {
            uri,
            mimeType: 'application/json',
            text: JSON.stringify(row?.envelope ?? row ?? { error: 'Not found' }),
          },
        ],
      };
    });

    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: 'store_trace',
          description:
            'Store a reasoning trace for one decision as a signed JSON-AM trace:// envelope and index it for recall. ' +
            'Optionally record the decision made, an initial outcome, salience hints, and a supersedes link (revision). Returns the memory pointer (URI).',
          inputSchema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The task/situation the decision addresses.' },
              content: { type: 'string', description: 'The reasoning trace text.' },
              boundContext: {
                type: 'array',
                items: { type: 'string' },
                description: 'URIs of context/memories (precedents) this reasoning was bound to.',
              },
              decision: {
                type: 'object',
                description: 'The choice committed to and alternatives weighed.',
                properties: {
                  choice: { type: 'string' },
                  alternatives: { type: 'array', items: { type: 'string' } },
                },
                required: ['choice'],
              },
              outcome: {
                type: 'object',
                description: 'Initial outcome if already known (usually recorded later via record_outcome).',
                properties: {
                  status: { type: 'string', enum: ['pending', 'success', 'failure', 'mixed', 'unknown'] },
                  score: { type: 'number', description: 'Signed usefulness in [-1, 1].' },
                  evidence: { type: 'string' },
                },
                required: ['status'],
              },
              confidence: { type: 'number', description: 'Model self-assessed confidence in [0, 1].' },
              importance: { type: 'number', description: 'Salience hint in [0, 1].' },
              supersedes: { type: 'string', description: 'URI of a prior memory this revision replaces.' },
            },
            required: ['content'],
          },
        },
        {
          name: 'record_outcome',
          description:
            'Record how a prior decision turned out. Persists a signed Outcome envelope and updates recall weighting so reasoning that worked resurfaces.',
          inputSchema: {
            type: 'object',
            properties: {
              decisionUri: { type: 'string', description: 'URI of the decision/trace this outcome is for.' },
              status: { type: 'string', enum: ['pending', 'success', 'failure', 'mixed', 'unknown'] },
              score: { type: 'number', description: 'Signed usefulness in [-1, 1].' },
              evidence: { type: 'string', description: 'What was observed.' },
            },
            required: ['decisionUri', 'status'],
          },
        },
        {
          name: 'retract_memory',
          description:
            'Retract a memory (e.g. found to be wrong). Excluded from future recall but preserved for audit and lineage.',
          inputSchema: {
            type: 'object',
            properties: {
              uri: { type: 'string', description: 'URI of the memory to retract.' },
              reason: { type: 'string' },
            },
            required: ['uri'],
          },
        },
        {
          name: 'search_memory',
          description:
            'Precedent recall over stored decisions/memories. Returns precedents (reasoning, the decision made, how it turned out, and lineage) ' +
            'ranked by a blend of semantic similarity, outcome signal, and recency. Superseded/retracted memories are excluded.',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string', description: 'Natural-language search query.' },
              k: { type: 'number', description: 'Max results (default 5).' },
            },
            required: ['query'],
          },
        },
        {
          name: 'wake',
          description:
            'Wake up / reload self at the start of a session (or after a context compaction). Returns the agent\'s durable identity ' +
            '(human-pinned memories, abstracted principles, and agent-specs), its most recent decisions, and — when a task is given — ' +
            'the top precedents for it. Use this instead of relying on a summarized context window, so personality and self-understanding persist. ' +
            'The response includes a ready-to-inject natural-language brief in `digest`.',
          inputSchema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'What this session is about, to also surface relevant precedent (optional).' },
              recent: { type: 'number', description: 'How many recent decisions to include.' },
              identity: { type: 'number', description: 'How many identity/self memories to include.' },
              relevant: { type: 'number', description: 'How many task-relevant precedents to include (needs task).' },
            },
          },
        },
      ],
    }));

    this.server.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: rawArgs } = req.params as any;
      const args: any = rawArgs && typeof rawArgs === 'object' && !Array.isArray(rawArgs) ? rawArgs : {};
      const subject = this.config.subject ?? 'mcp';
      const trustDomain = this.config.trustDomain;
      const limits = this.config.limits;

      if (name === 'store_trace') {
        if (!this.allows('write')) return this.denied('write', name);
        const uri = newTraceUri(trustDomain);
        try {
          // The same validation POST /memory applies (types, ranges, length caps).
          const input = validateTraceInput(args, limits);
          if (input.supersedes && domainOf(input.supersedes) !== trustDomain) {
            throw new Error('supersedes must reference a memory in the same trust domain');
          }
          const result = await storeTrace(
            this.adapter,
            { uri, trustDomain, subject, privateKeyPem: this.config.privateKeyPem },
            input,
            this.config.policy
          );
          this.audit({
            action: 'write',
            result: 'allow',
            uri,
            trustDomain,
            detail: { tool: name, tier: result.tier, reviewQueued: Boolean(result.reviewQueued), ...(input.supersedes ? { supersedes: input.supersedes } : {}) },
          });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
          return this.failed(name, e, uri);
        }
      }
      if (name === 'record_outcome') {
        if (!this.allows('write')) return this.denied('write', name);
        let decisionUri: string | undefined;
        try {
          decisionUri = sanitizeUri(args.decisionUri);
          if (domainOf(decisionUri) !== trustDomain) throw new Error('Decision belongs to a different trust domain');
          const outcome = validateOutcome({ status: args.status, score: args.score, evidence: args.evidence }, limits);
          const result = await recordOutcome(
            this.adapter,
            { trustDomain, subject, privateKeyPem: this.config.privateKeyPem },
            { decisionUri, status: outcome.status, score: outcome.score, evidence: outcome.evidence }
          );
          this.audit({ action: 'outcome', result: 'allow', uri: decisionUri, trustDomain, detail: { tool: name, status: outcome.status, outcomeUri: result.outcomeUri } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
          return this.failed(name, e, decisionUri);
        }
      }
      if (name === 'retract_memory') {
        if (!this.allows('write')) return this.denied('write', name);
        let uri: string | undefined;
        try {
          uri = sanitizeUri(args.uri);
          if (domainOf(uri) !== trustDomain) throw new Error('Memory belongs to a different trust domain');
          const result = await retractMemory(this.adapter, { trustDomain }, uri);
          const reason = typeof args.reason === 'string' ? args.reason.slice(0, 1000) : null;
          this.audit({ action: 'retract', result: 'allow', uri, trustDomain, detail: { tool: name, reason } });
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (e) {
          return this.failed(name, e, uri);
        }
      }
      if (name === 'search_memory') {
        if (!this.allows('read')) return this.denied('read', name);
        try {
          const query = String(args.query ?? '');
          const k = clampInt(args.k, 5, 1, limits?.searchKMax ?? 50);
          const embedding = toVectorLiteral(await embed(query));
          const rows = await this.adapter.search({ embedding, k, trustDomain, weights: this.config.recallWeights });
          const results = rows.map(toPrecedent);
          this.audit({ action: 'search', result: 'allow', trustDomain, detail: { tool: name, q: query.slice(0, 200), k, hits: results.length } });
          return { content: [{ type: 'text', text: JSON.stringify({ query: args.query, results }) }] };
        } catch (e) {
          return this.failed(name, e);
        }
      }
      if (name === 'wake') {
        if (!this.allows('read')) return this.denied('read', name);
        try {
          const max = limits?.searchKMax ?? 50;
          const payload = await this.wake({
            task: args.task != null ? String(args.task) : null,
            recent: clampInt(args.recent, undefined, 0, max),
            identity: clampInt(args.identity, undefined, 0, max),
            relevant: clampInt(args.relevant, undefined, 0, max),
          });
          this.audit({ action: 'wake', result: 'allow', trustDomain, detail: { tool: name, ...payload.counts } });
          return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
        } catch (e) {
          return this.failed(name, e);
        }
      }
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    });
  }

  private wakeUri(): string {
    return `memory://${this.config.trustDomain}/wake`;
  }

  // Compose the wake brief for this session's trust domain (read-only).
  async wake(opts: { task?: string | null; recent?: number; identity?: number; relevant?: number } = {}) {
    return composeWake(this.adapter, {
      trustDomain: this.config.trustDomain,
      task: opts.task ?? null,
      recent: opts.recent ?? this.config.wake?.recent,
      identity: opts.identity ?? this.config.wake?.identity,
      relevant: opts.relevant ?? this.config.wake?.relevant,
      recallWeights: this.config.recallWeights,
    });
  }
}
