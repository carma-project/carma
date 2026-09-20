import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CARMAMCPServer } from './index.js';
import { composeWake } from '../wake/wake.js';
import { PostgresAdapter } from '../../adapters/postgres.js';
import { config } from '../config.js';
import { weightsFromConfig, policyFromConfig, wakeDefaultsFromConfig } from '../recall.js';

// Launches the CARMA MCP server over stdio (for MCP clients such as Claude
// Desktop). Run with: node --import tsx server/mcp/stdio.ts
//
// Configuration comes from the same validated config as the HTTP server, so
// DATABASE_SSL, pool sizing, recall weights, consolidation policy and the wake
// toggle behave identically on both transports.
if (!config.trustDomain) {
  console.error('CARMA MCP (stdio): TRUST_DOMAIN is required');
  process.exit(1);
}
// stderr keeps stdout clean for the MCP protocol stream.
for (const w of config.warnings) console.error('config warning:', w);

const adapter = new PostgresAdapter(config.databaseUrl, {
  ssl: config.dbSslConfig,
  max: config.dbPoolMax,
  idleTimeoutMillis: config.dbIdleTimeoutMs,
  connectionTimeoutMillis: config.dbConnectTimeoutMs,
});
const trustDomain = config.trustDomain;
const wake = wakeDefaultsFromConfig(config);

// Compose the wake brief so it rides along on `initialize` as server
// instructions — the local harness reloads the agent's identity/self on connect
// (surviving a context compaction). Best-effort: never block startup.
let instructions: string | undefined;
if (config.mcpWakeInstructions) {
  try {
    const brief = await composeWake(adapter, {
      trustDomain,
      recent: wake.recent,
      identity: wake.identity,
      recallWeights: weightsFromConfig(config),
    });
    if (brief.counts.identity > 0 || brief.counts.recent > 0) instructions = brief.digest;
  } catch (e) {
    console.error('wake instructions unavailable:', (e as Error).message);
  }
}

const carma = new CARMAMCPServer(adapter, {
  trustDomain,
  privateKeyPem: config.privateKeyPem,
  subject: 'mcp-stdio',
  recallWeights: weightsFromConfig(config),
  wake,
  policy: policyFromConfig(config),
  limits: { contentMaxLength: config.contentMaxLength, boundContextMax: config.boundContextMax, searchKMax: config.searchKMax },
  instructions,
  // stdio is a trusted local channel, but its decisions are still recorded
  // (best-effort, never blocking the protocol stream).
  audit: (entry) => {
    if (config.databaseUrl) adapter.audit({ actor: 'mcp-stdio', ...entry }).catch(() => {});
  },
});

const transport = new StdioServerTransport();
await carma.server.connect(transport);
console.error('CARMA MCP server ready (stdio)');
