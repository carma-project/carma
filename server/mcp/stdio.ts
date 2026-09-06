import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CARMAMCPServer } from './index.js';
import { composeWake } from '../wake/wake.js';
import { PostgresAdapter } from '../../adapters/postgres.js';

// Launches the CARMA MCP server over stdio (for MCP clients such as Claude
// Desktop). Run with: node --import tsx server/mcp/stdio.ts
const adapter = new PostgresAdapter(process.env.DATABASE_URL || '');
const trustDomain = process.env.TRUST_DOMAIN || 'acme';
const wake = {
  recent: Number(process.env.WAKE_RECENT) || 5,
  identity: Number(process.env.WAKE_IDENTITY) || 8,
  relevant: Number(process.env.WAKE_RELEVANT) || 5,
};

// Compose the wake brief so it rides along on `initialize` as server
// instructions — the local harness reloads the agent's identity/self on connect
// (surviving a context compaction). Best-effort: never block startup.
let instructions;
if (!/^(0|false|no|off)$/i.test(process.env.MCP_WAKE_INSTRUCTIONS || '')) {
  try {
    const brief = await composeWake(adapter, { trustDomain, recent: wake.recent, identity: wake.identity });
    if (brief.counts.identity > 0 || brief.counts.recent > 0) instructions = brief.digest;
  } catch (e) {
    console.error('wake instructions unavailable:', (e as Error).message);
  }
}

const carma = new CARMAMCPServer(adapter, {
  trustDomain,
  privateKeyPem: process.env.PRIVATE_KEY || '',
  wake,
  instructions,
});

const transport = new StdioServerTransport();
await carma.server.connect(transport);
// stderr keeps stdout clean for the MCP protocol stream.
console.error('CARMA MCP server ready (stdio)');
