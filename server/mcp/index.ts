import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { storeTrace, newTraceUri, recordOutcome, retractMemory } from '../ingest.js';
import { embed, toVectorLiteral } from '../embedding.js';
import { toPrecedent } from '../recall.js';
import { composeWake } from '../wake/wake.js';

export interface MCPConfig {
  trustDomain: string;
  privateKeyPem: string;
  // Actions this session is permitted to perform. When omitted (e.g. a trusted
  // local stdio channel) all actions are allowed. For remote HTTP sessions this
  // is derived from the caller's capability token so the same governance model
  // applies across transports.
  allowedActions?: string[];
  // Optional precedent-recall weights (see adapters/postgres.ts). Defaults apply
  // when omitted.
  recallWeights?: { sim?: number; outcome?: number; recency?: number; halfLifeDays?: number };
  // Wake layer sizes for the `wake` tool / resource (defaults apply when omitted).
  wake?: { recent?: number; identity?: number; relevant?: number };
  // Optional text surfaced as the MCP `initialize` `instructions` — used to
  // carry the agent's wake brief (identity + recent) so a harness reloads its
  // self on connect. Computed per session before the server is constructed.
  instructions?: string;
}

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
      if (!this.allows('read')) {
        throw new Error("Permission denied: capability lacks 'read' action");
      }
      // The wake brief is a composed view, not a stored envelope.
      if (req.params.uri === this.wakeUri()) {
        const payload = await this.wake();
        return {
          contents: [{ uri: req.params.uri, mimeType: 'application/json', text: JSON.stringify(payload) }],
        };
      }
      const row = await this.adapter.resolve(req.params.uri);
      return {
        contents: [
          {
            uri: req.params.uri,
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
      const { name, arguments: args = {} } = req.params as any;
      if (name === 'store_trace') {
        if (!this.allows('write')) {
          return {
            content: [{ type: 'text', text: "Permission denied: capability lacks 'write' action" }],
            isError: true,
          };
        }
        const uri = newTraceUri(this.config.trustDomain);
        const result = await storeTrace(
          this.adapter,
          {
            uri,
            trustDomain: this.config.trustDomain,
            subject: 'mcp',
            privateKeyPem: this.config.privateKeyPem,
          },
          {
            task: args.task,
            content: args.content,
            boundContext: args.boundContext,
            decision: args.decision,
            outcome: args.outcome,
            confidence: args.confidence,
            importance: args.importance,
            supersedes: args.supersedes,
          }
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'record_outcome') {
        if (!this.allows('write')) {
          return {
            content: [{ type: 'text', text: "Permission denied: capability lacks 'write' action" }],
            isError: true,
          };
        }
        const result = await recordOutcome(
          this.adapter,
          { trustDomain: this.config.trustDomain, subject: 'mcp', privateKeyPem: this.config.privateKeyPem },
          { decisionUri: String(args.decisionUri), status: args.status, score: args.score, evidence: args.evidence }
        );
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'retract_memory') {
        if (!this.allows('write')) {
          return {
            content: [{ type: 'text', text: "Permission denied: capability lacks 'write' action" }],
            isError: true,
          };
        }
        const result = await retractMemory(this.adapter, { trustDomain: this.config.trustDomain }, String(args.uri));
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }
      if (name === 'search_memory') {
        if (!this.allows('read')) {
          return {
            content: [{ type: 'text', text: "Permission denied: capability lacks 'read' action" }],
            isError: true,
          };
        }
        const embedding = toVectorLiteral(await embed(String(args.query ?? '')));
        const rows = await this.adapter.search({
          embedding,
          k: args.k ?? 5,
          trustDomain: this.config.trustDomain,
          weights: this.config.recallWeights,
        });
        const results = rows.map(toPrecedent);
        return {
          content: [{ type: 'text', text: JSON.stringify({ query: args.query, results }) }],
        };
      }
      if (name === 'wake') {
        if (!this.allows('read')) {
          return {
            content: [{ type: 'text', text: "Permission denied: capability lacks 'read' action" }],
            isError: true,
          };
        }
        const payload = await this.wake({
          task: args.task,
          recent: args.recent,
          identity: args.identity,
          relevant: args.relevant,
        });
        return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
      }
      throw new Error(`Unknown tool: ${name}`);
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
