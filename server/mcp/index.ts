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
      { capabilities: { resources: {}, tools: {} } }
    );

    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [
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
      throw new Error(`Unknown tool: ${name}`);
    });
  }
}
