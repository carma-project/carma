// Ingest a repo's *git history* into CARMA memory — the reasoning behind every
// change, not just the current docs. Each commit becomes a signed JSON-AM
// `trace://` decision whose author date is preserved (so recall's recency decay
// reflects real chronology). Reverts are recorded as a `failure` outcome on the
// commit they undo, giving CARMA outcome signal straight from history.
//
// Commit parsing + revert detection live in server/ingest/extract.ts and are
// shared with CARMA's native ingestion engine (POST /ingest). URIs are
// deterministic (trace://<domain>/gh/<repo>/commit/<sha>) and commits are
// immutable, so re-runs are idempotent.
//
// Usage (one-time backfill of all history):
//   PRIVATE_KEY="$(cat priv.pem)" node --import tsx scripts/ingest-git.mjs \
//     --dir /path/to/repo --url https://carma... --domain cyberorbit \
//     --repo cyberorbit/app --max 100000
//
// Incremental (e.g. nightly): --since "30 days ago"  or  --since 2024-01-01
import path from 'node:path';
import { issueCapability } from '../server/capability.js';
import { extractGitItems, repoSlug } from '../server/ingest/extract.js';

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
const branch = arg('branch', '');
const since = arg('since', '');
const until = arg('until', '');
const max = Number(arg('max', '5000'));
const dryRun = flag('dry-run');
const noOutcomes = flag('no-outcomes');
if (!domain) die('--domain (or TRUST_DOMAIN) is required.');

const repo = repoSlug(dir, arg('repo', ''));

async function getToken() {
  const explicit = arg('token', process.env.CARMA_TOKEN || '');
  if (explicit) return explicit;
  if (process.env.PRIVATE_KEY) {
    return issueCapability(
      { domains: [`trust://${domain}`], actions: ['read', 'write'], subject: `git-sync:${repo}`, ttl: '15m' },
      process.env.PRIVATE_KEY
    );
  }
  die('No credentials: set CARMA_TOKEN (or --token), or PRIVATE_KEY to mint one.');
}

async function post(token, pathname, payload) {
  const res = await fetch(baseUrl + pathname, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-JSON */
  }
  return { status: res.status, json, text };
}

let items, reverts;
try {
  ({ items, reverts } = extractGitItems(dir, { domain, repo, branch, since, until, max }));
} catch (e) {
  die(`git log failed in ${dir}: ${e.message}`);
}

console.log(`CARMA git ingest → ${baseUrl}  domain=${domain}  repo=${repo}`);
console.log(`${items.length} commit(s)${branch ? ` on ${branch}` : ''}${since ? ` since ${since}` : ''}${dryRun ? '  [DRY RUN]' : ''}\n`);

const token = dryRun ? null : await getToken();
const ingested = new Set();
let created = 0;
let failed = 0;
let outcomes = 0;

for (const it of items) {
  if (dryRun) {
    console.log(`  [commit] ${it.input.occurredAt?.slice(0, 10)}  ${String(it.input.task).slice(0, 72)}`);
    created++;
    ingested.add(it.uri);
    continue;
  }
  const r = await post(token, '/memory', { uri: it.uri, trustDomain: it.trustDomain, ...it.input });
  if (r.status === 201) {
    created++;
    ingested.add(it.uri);
  } else {
    failed++;
    console.log(`  ✗ ${it.uri.slice(-8)} — HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }
}

if (!noOutcomes && !dryRun) {
  for (const rv of reverts) {
    if (!ingested.has(rv.decisionUri)) continue;
    const r = await post(token, '/outcome', { decisionUri: rv.decisionUri, status: rv.status, score: rv.score, evidence: rv.evidence });
    if (r.status === 201) outcomes++;
  }
}

console.log(`\n${dryRun ? 'would ingest' : 'ingested'} ${created} commit(s)${failed ? `, ${failed} failed` : ''}${outcomes ? `; recorded ${outcomes} revert outcome(s)` : ''}`);
process.exit(failed ? 1 : 0);
