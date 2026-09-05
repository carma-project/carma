// Self-contained end-to-end smoke test for a running CARMA server.
//
// Why this exists: the production container image (node:20-alpine) ships without
// `curl` or `jq`, so the shell-based smoke test can't run inside it. This script
// depends only on Node 20 (global `fetch`) and the server's own token minting,
// so it runs anywhere CARMA runs.
//
// Usage (inside the container, or anywhere that can reach the server):
//   npm run smoke
//
// It reads configuration from the same env vars the server uses:
//   PORT          (default 7100)  - the port the server listens on
//   TRUST_DOMAIN  (required)      - trust domain to ingest/search under
//   PRIVATE_KEY   (required)      - Ed25519 PKCS8 PEM used to mint a capability
//   CARMA_URL     (optional)      - override base URL (default http://localhost:PORT)
//
// Override any step target with flags:
//   --url http://host:port   --domain other-domain   --k 3
import { issueCapability } from '../server/capability.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const port = process.env.PORT || '7100';
const baseUrl = (arg('url', process.env.CARMA_URL || `http://localhost:${port}`)).replace(/\/$/, '');
const domain = arg('domain', process.env.TRUST_DOMAIN || '');
const k = Number(arg('k', '3'));
const privateKeyPem = process.env.PRIVATE_KEY || '';

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
}

if (!domain) fail('TRUST_DOMAIN (or --domain) is required.');
if (!privateKeyPem) fail('PRIVATE_KEY (Ed25519 PKCS8 PEM) is required to mint a token.');

let pass = 0;
let checks = 0;
function check(label, ok, detail) {
  checks++;
  if (ok) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

async function req(method, path, { token, body } = {}) {
  const headers = { accept: 'application/json' };
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  let res;
  try {
    res = await fetch(baseUrl + path, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    fail(`Cannot reach ${baseUrl} (${e.message}). Is the server up and is CARMA_URL/PORT correct?`);
  }
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

console.log(`CARMA smoke test → ${baseUrl}  (domain=${domain})\n`);

// 1) Mint a capability token in-process (same signer the server verifies).
const token = await issueCapability(
  { domains: [`trust://${domain}`], actions: ['read', 'write', 'distill'], subject: 'smoke', ttl: '10m' },
  privateKeyPem
);

// 2) Readiness / configuration.
console.log('1. GET /api/status');
{
  const { status, json } = await req('GET', '/api/status');
  check('responds 200', status === 200, `got ${status}`);
  if (json) {
    check('server ready', json.ready === true, JSON.stringify({
      publicKey: json.publicKey,
      privateKey: json.privateKey,
      database: json.database,
      rag: json.rag,
      audit: json.audit,
    }));
  }
}

// 3) Ingest a decision trace.
console.log('\n2. POST /memory (ingest decision)');
let uri;
{
  const { status, json, text } = await req('POST', '/memory', {
    token,
    body: {
      task: 'recon',
      content: 'nmap: 22/tcp open on host X; weak SSH banner',
      decision: { choice: 'try SSH credential stuffing' },
      confidence: 0.8,
      importance: 0.8,
      trustDomain: domain,
    },
  });
  uri = json?.uri;
  check('responds 201', status === 201, text?.slice(0, 200));
  check('returns a memory uri', Boolean(uri), JSON.stringify(json));
  if (uri) console.log(`     stored ${uri} (tier=${json?.tier ?? '?'})`);
}

// 4) Record the outcome of that decision.
console.log('\n3. POST /outcome (record result)');
if (uri) {
  const { status, json, text } = await req('POST', '/outcome', {
    token,
    body: { decisionUri: uri, status: 'success', score: 0.9 },
  });
  check('responds 201', status === 201, text?.slice(0, 200));
  check('links outcome to decision', Boolean(json?.outcomeUri), JSON.stringify(json));
} else {
  check('skipped (no uri from ingest)', false);
}

// 5) Recall via semantic search — should surface the decision with its outcome.
console.log('\n4. GET /search (precedent recall)');
{
  const q = encodeURIComponent('open SSH port on a host');
  const { status, json, text } = await req('GET', `/search?q=${q}&k=${k}&domain=${encodeURIComponent(domain)}`, { token });
  check('responds 200', status === 200, text?.slice(0, 200));
  check('returns at least one result', (json?.results?.length || 0) > 0, `count=${json?.count}`);
  const top = json?.results?.[0];
  if (top) {
    check('top hit carries the outcome', Boolean(top.outcome), JSON.stringify(top.outcome));
    console.log('     top result:', JSON.stringify({ uri: top.uri, decision: top.decision, outcome: top.outcome, tier: top.tier }, null, 0));
  }
}

// 6) Dream dry-run — proves the consolidation path is wired without mutating data.
console.log('\n5. POST /consolidate (dream, dry-run)');
{
  const { status, json, text } = await req('POST', '/consolidate', {
    token,
    body: { dryRun: true, trustDomain: domain },
  });
  check('responds 200', status === 200, text?.slice(0, 200));
  if (json) {
    console.log('     report:', JSON.stringify({
      dryRun: json.dryRun,
      decayed: json.decayed?.count,
      promoted: json.promoted?.count,
      reviews: json.reviews?.count,
      abstractions: json.abstractions?.count,
    }));
  }
}

console.log(`\n${pass === checks ? '✓' : '✗'} ${pass}/${checks} checks passed`);
process.exit(pass === checks ? 0 : 1);
