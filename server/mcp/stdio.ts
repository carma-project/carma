import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CARMAMCPServer } from './index.js';
import { PostgresAdapter } from '../../adapters/postgres.js';

// Launches the CARMA MCP server over stdio (for MCP clients such as Claude
// Desktop). Run with: node --import tsx server/mcp/stdio.ts
const adapter = new PostgresAdapter(process.env.DATABASE_URL || '');
const carma = new CARMAMCPServer(adapter, {
  trustDomain: process.env.TRUST_DOMAIN || 'acme',
  privateKeyPem: process.env.PRIVATE_KEY || '',
});

const transport = new StdioServerTransport();
await carma.server.connect(transport);
// stderr keeps stdout clean for the MCP protocol stream.
console.error('CARMA MCP server ready (stdio)');
