// Ingest a GitHub repo's markdown (agent specs, decision records, "company OS"
// docs) into CARMA memory so it becomes recallable institutional knowledge.
//
// Classification, sectioning, and URI derivation live in server/ingest/extract.ts
// and are shared with CARMA's *native* ingestion engine (POST /ingest), so a repo
// pushed in from CI looks identical to one CARMA pulls itself. URIs are
// deterministic (repo + path + heading), so re-runs upsert in place (idempotent).
//
// Usage (local backfill):
//   PRIVATE_KEY="$(cat priv.pem)" node --import tsx scripts/ingest-repo.mjs \
//     --dir /path/to/company-repo --url https://carma.example.com \
//     --domain cyberorbit --repo cyberorbit/handbook
//
// Usage (CI, with a pre-minted write token):
//   CARMA_TOKEN=... node --import tsx scripts/ingest-repo.mjs --dir . --url ... --domain ...
//
// Auth precedence: --token / CARMA_TOKEN, else mint a short-lived token from
// PRIVATE_KEY (Ed25519 PKCS8 PEM).
import path from 'node:path';
import { issueCapability } from '../server/capability.js';
import { extractMarkdownItems, repoSlug } from '../server/ingest/extract.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}
function flag(name) {
  return process.argv.includes('--' + name);
}
function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}

const dir = path.resolve(arg('dir', '.'));
const baseUrl = arg('url', process.env.CARMA_URL || 'http://localhost:7100').replace(/\/$/, '');
const domain = arg('domain', process.env.TRUST_DOMAIN || '');
const dryRun = flag('dry-run');
const noSplit = flag('no-split');
const excludeArg = arg('exclude', '');
const exclude = excludeArg ? excludeArg.split(',').map((s) => s.trim()).filter(Boolean) : [];
if (!domain) die('--domain (or TRUST_DOMAIN) is required.');

const repo = repoSlug(dir, arg('repo', ''));

async function getToken() {
  const explicit = arg('token', process.env.CARMA_TOKEN || '');
  if (explicit) return explicit;
  if (process.env.PRIVATE_KEY) {
    return issueCapability(
      { domains: [`trust://${domain}`], actions: ['read', 'write'], subject: `repo-sync:${repo}`, ttl: '15m' },
      process.env.PRIVATE_KEY
    );
  }
  die('No credentials: set CARMA_TOKEN (or --token), or PRIVATE_KEY to mint one.');
}

async function post(token, memory) {
  const res = await fetch(baseUrl + '/memory', {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(memory),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON error body */
  }
  return { status: res.status, json, text };
}

const items = extractMarkdownItems(dir, { domain, repo, exclude, noSplit });
const byType = {};
for (const it of items) byType[it.type] = (byType[it.type] || 0) + 1;

console.log(`CARMA repo ingest → ${baseUrl}  domain=${domain}  repo=${repo}`);
console.log(`${items.length} section(s) from markdown under ${dir}${dryRun ? '  [DRY RUN]' : ''}\n`);

const token = dryRun ? null : await getToken();
let created = 0;
let failed = 0;

for (const it of items) {
  if (dryRun) {
    console.log(`  [${it.type}] ${it.uri}`);
    created++;
    continue;
  }
  const r = await post(token, { uri: it.uri, trustDomain: it.trustDomain, ...it.input });
  if (r.status === 201) {
    created++;
    const tag = r.json?.reviewQueued ? ` (near-duplicate → review ${r.json.reviewId})` : '';
    console.log(`  ✓ [${it.type}] ${it.uri}${tag}`);
  } else {
    failed++;
    console.log(`  ✗ [${it.type}] ${it.uri} — HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }
}

console.log(`\nclassified: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
console.log(`${dryRun ? 'would ingest' : 'ingested'} ${created} section(s)${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
