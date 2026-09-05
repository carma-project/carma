import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import {
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { storeTrace, newTraceUri } from '../ingest.js';
import { embed, toVectorLiteral } from '../embedding.js';

export interface MCPConfig {
  trustDomain: string;
  privateKeyPem: string;
  // Actions this session is permitted to perform. When omitted (e.g. a trusted
  // local stdio channel) all actions are allowed. For remote HTTP sessions this
  // is derived from the caller's capability token so the same governance model
  // applies across transports.
  allowedActions?: string[];
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
            'Store a reasoning trace as a signed JSON-AM trace:// envelope and index it in the RAG store. Returns the memory pointer (URI).',
          inputSchema: {
            type: 'object',
            properties: {
              task: { type: 'string', description: 'The task or goal the trace addresses.' },
              content: { type: 'string', description: 'The reasoning trace text.' },
              boundContext: {
                type: 'array',
                items: { type: 'string' },
                description: 'URIs of context/memories this trace was bound to.',
              },
            },
            required: ['content'],
          },
        },
        {
          name: 'search_memory',
          description:
            'Semantic search over stored memories/traces. Returns JSON-AM pointers (URIs) ranked by similarity.',
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
          args
        );
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
        const results = await this.adapter.search({
          embedding,
          k: args.k ?? 5,
          trustDomain: this.config.trustDomain,
        });
        return {
          content: [{ type: 'text', text: JSON.stringify({ query: args.query, results }) }],
        };
      }
      throw new Error(`Unknown tool: ${name}`);
    });
  }
}
