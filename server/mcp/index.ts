import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListResourcesRequestSchema, ReadResourceRequestSchema } from '@modelcontextprotocol/sdk/types.js';

export class CARMAMCPServer {
  server = new Server({ name: 'carma', version: '0.1.0' }, { capabilities: { resources: {} } });

  constructor() {
    this.server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: [{ uri: 'memory://acme/sem/*', name: 'acme Memories' }]
    }));
    this.server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      return { contents: [{ uri: req.params.uri, text: JSON.stringify({}) }] };
    });
  }
}
