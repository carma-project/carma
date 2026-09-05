// Ingest a GitHub repo's markdown (agent specs, decision records, "company OS"
// docs) into CARMA memory so it becomes recallable institutional knowledge.
//
// It walks a directory, classifies each markdown file (decision | agent-spec |
// doc), splits it into sections for better recall, and upserts each section as
// a signed JSON-AM `trace://` envelope via `POST /memory`. URIs are derived
// deterministically from the repo + path + heading, so re-running updates in
// place (idempotent) instead of creating duplicates — safe to run on every push.
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
import fs from 'node:fs';
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

const dir = path.resolve(arg('dir', '.'));
const baseUrl = (arg('url', process.env.CARMA_URL || 'http://localhost:7100')).replace(/\/$/, '');
const domain = arg('domain', process.env.TRUST_DOMAIN || '');
const dryRun = flag('dry-run');
const noSplit = flag('no-split');
const excludeArg = arg('exclude', '');
const excludes = excludeArg ? excludeArg.split(',').map((s) => s.trim()).filter(Boolean) : [];

function die(msg) {
  console.error('✗ ' + msg);
  process.exit(1);
}
if (!domain) die('--domain (or TRUST_DOMAIN) is required.');

// Repo slug for stable URIs: explicit --repo, else the git remote, else dir name.
function repoSlug() {
  const explicit = arg('repo', '');
  if (explicit) return explicit.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  try {
    const remote = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], { encoding: 'utf8' }).trim();
    const m = remote.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* not a git repo */
  }
  return path.basename(dir);
}
const repo = repoSlug();

// ---- token ----
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

// ---- walk markdown ----
function walk(root) {
  const out = [];
  const skipDir = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'vendor', '.venv']);
  (function rec(d) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!skipDir.has(ent.name)) rec(full);
      } else if (/\.mdx?$/i.test(ent.name)) {
        const rel = path.relative(root, full);
        if (!excludes.some((x) => rel.includes(x))) out.push(rel);
      }
    }
  })(root);
  return out.sort();
}

// ---- minimal front-matter (--- ... ---) ----
function parseFrontMatter(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    let v = kv[2].trim().replace(/^["']|["']$/g, '');
    if (/^\[.*\]$/.test(v)) v = v.slice(1, -1).split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

// ---- classification ----
function classify(rel, meta) {
  const t = String(meta['carma.type'] || meta.type || '').toLowerCase();
  if (t === 'decision' || t === 'adr') return 'decision';
  if (t === 'agent-spec' || t === 'agent' || t === 'spec') return 'agent-spec';
  if (t === 'doc' || t === 'os' || t === 'reference') return 'doc';
  const p = rel.toLowerCase();
  const base = path.basename(p);
  if (/(^|\/)(decisions?|adrs?)(\/|$)/.test(p) || /^adr[-_]?\d+.*\.mdx?$/.test(base) || /[-_]decision\.mdx?$/.test(base)) return 'decision';
  if (/(^|\/)(agents?|specs?|\.cursor)(\/|$)/.test(p) || base === 'agents.md' || /\.agent\.mdx?$/.test(base)) return 'agent-spec';
  return 'doc';
}

// Salience defaults per type; front-matter can override.
const DEFAULTS = {
  decision: { confidence: 0.85, importance: 0.9 },
  'agent-spec': { confidence: 0.9, importance: 0.85 },
  doc: { confidence: 0.8, importance: 0.7 },
};
function num(v, def) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : def;
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
}

// Split a doc into sections at H1/H2 for finer-grained recall. Content before
// the first heading becomes a preamble section titled by the doc title.
function sections(body, docTitle) {
  if (noSplit) return [{ heading: docTitle, body: body.trim() }];
  const lines = body.split('\n');
  const out = [];
  let cur = null; // current heading section (body is an array of lines)
  let preamble = []; // lines before the first heading
  for (const line of lines) {
    const h = line.match(/^(#{1,2})\s+(.*)$/);
    if (h) {
      if (cur) out.push(cur);
      else {
        const pre = preamble.join('\n').trim();
        if (pre) out.push({ heading: docTitle, body: pre });
      }
      cur = { heading: h[2].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) out.push(cur);
  else if (out.length === 0) out.push({ heading: docTitle, body: preamble.join('\n').trim() });
  return out
    .map((s) => ({ heading: s.heading, body: Array.isArray(s.body) ? s.body.join('\n').trim() : s.body }))
    .filter((s) => s.body);
}

function firstH1(body) {
  const m = body.match(/^#\s+(.*)$/m);
  return m ? m[1].trim() : null;
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

const files = walk(dir);
console.log(`CARMA repo ingest → ${baseUrl}  domain=${domain}  repo=${repo}`);
console.log(`${files.length} markdown file(s) under ${dir}${dryRun ? '  [DRY RUN]' : ''}\n`);

const token = dryRun ? null : await getToken();
let created = 0;
let failed = 0;
const byType = {};

for (const rel of files) {
  const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
  const { meta, body } = parseFrontMatter(raw);
  const type = classify(rel, meta);
  byType[type] = (byType[type] || 0) + 1;
  const docTitle = String(meta.title || firstH1(body) || path.basename(rel).replace(/\.mdx?$/i, ''));
  const d = DEFAULTS[type];
  const confidence = num(meta.confidence, d.confidence);
  const importance = num(meta.importance, d.importance);
  const fileUri = `trace://${domain}/gh/${repo}/${rel}`;

  let secs = sections(body, docTitle);
  if (secs.length === 0) secs = [{ heading: docTitle, body: body.trim() || docTitle }];
  for (const sec of secs) {
    if (!sec.body && !sec.heading) continue;
    const uri = secs.length > 1 ? `${fileUri}#${slug(sec.heading)}` : fileUri;
    const task = docTitle === sec.heading ? docTitle : `${docTitle} — ${sec.heading}`;
    const content = sec.body || sec.heading;
    const boundContext = [`repo:${repo}`, `path:${rel}`, `type:${type}`];
    const memory = { uri, task, content, boundContext, confidence, importance, trustDomain: domain };
    if (type === 'decision') memory.decision = { choice: sec.heading || docTitle };
    if (meta.supersedes) memory.supersedes = String(meta.supersedes);

    if (dryRun) {
      console.log(`  [${type}] ${uri}`);
      created++;
      continue;
    }
    const r = await post(token, memory);
    if (r.status === 201) {
      created++;
      const tag = r.json?.reviewQueued ? ` (near-duplicate → review ${r.json.reviewId})` : '';
      console.log(`  ✓ [${type}] ${uri}${tag}`);
    } else {
      failed++;
      console.log(`  ✗ [${type}] ${uri} — HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
  }
}

console.log(`\nclassified: ${Object.entries(byType).map(([k, v]) => `${k}=${v}`).join('  ') || '(none)'}`);
console.log(`${dryRun ? 'would ingest' : 'ingested'} ${created} section(s)${failed ? `, ${failed} failed` : ''}`);
process.exit(failed ? 1 : 0);
