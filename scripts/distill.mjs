// Distill stored reasoning/memory into a fine-tune job from the command line.
// Usage:
//   DATABASE_URL=... PRIVATE_KEY="$(cat priv.pem)" \
//   FINETUNE_PROVIDER=fireworks FIREWORKS_API_KEY=... FIREWORKS_ACCOUNT_ID=... \
//   node --import tsx scripts/distill.mjs --domain acme --kind trace --limit 5000 \
//     --base-model accounts/fireworks/models/llama-v3p1-8b-instruct
import { config } from '../server/config.js';
import { PostgresAdapter } from '../adapters/postgres.js';
import { runDistillation } from '../server/distill/pipeline.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

if (!config.databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const adapter = new PostgresAdapter(config.databaseUrl, {
  ssl: config.dbSslConfig,
  max: config.dbPoolMax,
});

try {
  const result = await runDistillation(adapter, config, {
    trustDomain: arg('domain', config.trustDomain),
    kind: arg('kind', 'trace'),
    limit: Number(arg('limit', String(config.distillMaxExamples))),
    format: arg('format', 'chat'),
    baseModel: arg('base-model', config.fireworksBaseModel),
    suffix: arg('suffix', ''),
    subject: 'cli',
  });
  console.log(JSON.stringify(result, null, 2));
} catch (e) {
  console.error('distill failed:', e.message);
  process.exitCode = 1;
} finally {
  await adapter.close();
}
