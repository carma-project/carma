// Offline consolidation ("dreaming") from the command line: decay stale working
// memories, recompute tiers from outcomes, batch-detect near-duplicates into the
// human review queue (with a model-proposed resolution), and abstract recurring
// decisions into semantic memories.
//
// Usage:
//   DATABASE_URL=... PRIVATE_KEY="$(cat priv.pem)" \
//   node --import tsx scripts/dream.mjs --domain acme [--dry-run] \
//     [--steps decay,promote,dedup,abstract] [--decay-days 30]
//
// MEMORY_MODEL_PROVIDER=fireworks FIREWORKS_API_KEY=... uses a hosted model for
// the proposals/abstraction; the default is the offline `local` model.
import { config } from '../server/config.js';
import { PostgresAdapter } from '../adapters/postgres.js';
import { runDream } from '../server/consolidate/dream.js';
import { getMemoryModel } from '../server/memory/model.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes('--' + name);
}

if (!config.databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const cfg = { ...config };
if (arg('decay-days')) cfg.dreamDecayDays = Number(arg('decay-days'));
if (arg('sim')) cfg.dreamSimThreshold = Number(arg('sim'));
if (arg('min-cluster')) cfg.dreamMinClusterSize = Number(arg('min-cluster'));

const adapter = new PostgresAdapter(config.databaseUrl, { ssl: config.dbSslConfig, max: config.dbPoolMax });
const model = getMemoryModel(config);

try {
  const report = await runDream(adapter, model, cfg, {
    trustDomain: arg('domain', config.trustDomain),
    subject: 'cli',
    privateKeyPem: config.privateKeyPem,
    dryRun: flag('dry-run'),
    steps: arg('steps') ? arg('steps').split(',').map((s) => s.trim()) : undefined,
  });
  console.log(JSON.stringify(report, null, 2));
} catch (e) {
  console.error('dream failed:', e.message);
  process.exitCode = 1;
} finally {
  await adapter.close();
}
