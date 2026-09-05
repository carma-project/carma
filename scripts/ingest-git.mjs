// Ingest a repo's *git history* into CARMA memory — the reasoning behind every
// change, not just the current docs. Each commit becomes a signed JSON-AM
// `trace://` decision whose author date is preserved (so recall's recency decay
// reflects real chronology). Reverts are recorded as a `failure` outcome on the
// commit they undo, giving CARMA outcome signal straight from history.
//
// URIs are deterministic (trace://<domain>/gh/<repo>/commit/<sha>) and commits
// are immutable, so re-runs are idempotent.
//
// Usage (one-time backfill of all history):
//   PRIVATE_KEY="$(cat priv.pem)" node --import tsx scripts/ingest-git.mjs \
//     --dir /path/to/repo --url https://carma... --domain cyberorbit \
//     --repo cyberorbit/app --max 100000
//
// Incremental (e.g. nightly): --since "30 days ago"  or  --since 2024-01-01
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { issueCapability } from '../server/capability.js';

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

function git(args) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

function repoSlug() {
  const explicit = arg('repo', '');
  if (explicit) return explicit.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  try {
    const remote = git(['config', '--get', 'remote.origin.url']).trim();
    const m = remote.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* not a git repo / no remote */
  }
  return path.basename(dir);
}
const repo = repoSlug();

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

// Pull commits as NUL-separated records; fields are unit-separator (\x1f) split.
// %b (body) may contain newlines but never NUL/US, so parsing stays robust.
const US = '\x1f';
function readCommits() {
  const range = [];
  if (branch) range.push(branch);
  const opts = ['log', '-z', `--max-count=${max}`, '--date=iso-strict', `--format=%H${US}%aI${US}%an${US}%P${US}%s${US}%b`, ...range];
  if (since) opts.push(`--since=${since}`);
  if (until) opts.push(`--until=${until}`);
  let raw;
  try {
    raw = git(opts);
  } catch (e) {
    die(`git log failed in ${dir}: ${e.message}`);
  }
  return raw
    .split('\0')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, author, parents, subject, ...bodyParts] = rec.split(US);
      return { sha, date, author, parents: (parents || '').trim().split(/\s+/).filter(Boolean), subject: subject || '', body: bodyParts.join(US).trim() };
    });
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

const commits = readCommits();
console.log(`CARMA git ingest → ${baseUrl}  domain=${domain}  repo=${repo}`);
console.log(`${commits.length} commit(s)${branch ? ` on ${branch}` : ''}${since ? ` since ${since}` : ''}${dryRun ? '  [DRY RUN]' : ''}\n`);

const token = dryRun ? null : await getToken();
const ingested = new Set();
let created = 0;
let failed = 0;
let outcomes = 0;

for (const c of commits) {
  const isMerge = c.parents.length > 1;
  const uri = `trace://${domain}/gh/${repo}/commit/${c.sha}`;
  const content = [c.subject, c.body].filter(Boolean).join('\n\n');
  const boundContext = [`repo:${repo}`, `commit:${c.sha.slice(0, 12)}`, `author:${c.author}`, ...(isMerge ? ['merge'] : [])];
  // Commits are episodic history: modest salience so they enter 'working' and
  // fade unless recalled/reinforced (curated docs/ADRs are the consolidated tier).
  const memory = {
    uri,
    task: c.subject,
    content,
    decision: { choice: c.subject },
    boundContext,
    confidence: 0.6,
    importance: isMerge ? 0.45 : 0.55,
    occurredAt: c.date,
    trustDomain: domain,
  };

  if (dryRun) {
    console.log(`  [commit ${c.sha.slice(0, 8)}] ${c.date.slice(0, 10)}  ${c.subject.slice(0, 72)}`);
    created++;
    ingested.add(c.sha);
    continue;
  }

  const r = await post(token, '/memory', memory);
  if (r.status === 201) {
    created++;
    ingested.add(c.sha);
  } else {
    failed++;
    console.log(`  ✗ ${c.sha.slice(0, 8)} — HTTP ${r.status} ${r.text.slice(0, 140)}`);
  }
}

// Reverts → record a failure outcome on the commit they undo (only when that
// commit was part of this history, so /outcome can resolve it).
if (!noOutcomes && !dryRun) {
  for (const c of commits) {
    const m = c.body.match(/This reverts commit ([0-9a-f]{7,40})/i);
    if (!m) continue;
    const target = commits.find((x) => x.sha.startsWith(m[1]) || m[1].startsWith(x.sha));
    if (!target || !ingested.has(target.sha)) continue;
    const r = await post(token, '/outcome', {
      decisionUri: `trace://${domain}/gh/${repo}/commit/${target.sha}`,
      status: 'failure',
      score: -0.7,
      evidence: `Reverted by ${c.sha.slice(0, 8)}: ${c.subject}`,
    });
    if (r.status === 201) outcomes++;
  }
}

console.log(`\n${dryRun ? 'would ingest' : 'ingested'} ${created} commit(s)${failed ? `, ${failed} failed` : ''}${outcomes ? `; recorded ${outcomes} revert outcome(s)` : ''}`);
process.exit(failed ? 1 : 0);
