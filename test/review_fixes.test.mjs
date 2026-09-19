// Regression tests for the rewrite review: all DB-free. The HTTP cases boot the
// real server without DATABASE_URL — every assertion here is decided before
// the adapter is touched.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SignJWT, generateKeyPair, exportSPKI, exportPKCS8 } from 'jose';
import { issueCapability } from '../server/capability.js';
import { verifyCapability } from '../server/middleware/jwt.js';
import { enforceCapability, enforceTokenLifetime, sanitizeUri } from '../server/middleware/guardrails.js';
import { parseConfig } from '../server/config.js';
import { extractMarkdownItems } from '../server/ingest/extract.js';
import { ensureCheckout, redactUrlCredentials } from '../server/ingest/connectors/git.js';
import { storeTrace } from '../server/ingest.js';

const { publicKey, privateKey } = await generateKeyPair('EdDSA');
const spki = await exportSPKI(publicKey);
const pkcs8 = await exportPKCS8(privateKey);

test('sanitizeUri: scheme regex is anchored and input must be a string', () => {
  assert.equal(sanitizeUri('memory://acme/sem/x'), 'memory://acme/sem/x');
  assert.throws(() => sanitizeUri('x-context://evil/x'), /Invalid scheme/);
  assert.throws(() => sanitizeUri('http://evil/x?u=memory://acme/x'), /Invalid scheme/);
  assert.throws(() => sanitizeUri(['memory://a/x']), /Invalid URI/);
  assert.throws(() => sanitizeUri(undefined), /Invalid URI/);
});

test('enforceCapability: resource patterns narrow a grant when present', () => {
  const scoped = { jsonam: { domains: ['trust://acme'], actions: ['read'], resources: ['memory://acme/sem/*'] } };
  assert.ok(enforceCapability(scoped, 'memory://acme/sem/worldview', 'read'));
  assert.throws(() => enforceCapability(scoped, 'memory://acme/episodic/1', 'read'), /Resource not permitted/);
  const open = { jsonam: { domains: ['trust://acme'], actions: ['read'], resources: [] } };
  assert.ok(enforceCapability(open, 'memory://acme/episodic/1', 'read'));
});

test('enforceTokenLifetime: privileged actions use the short ceiling', () => {
  const limits = { read: 3600, write: 900 };
  const iat = Math.floor(Date.now() / 1000) - 1000;
  assert.ok(enforceTokenLifetime({ iat }, 'read', limits));
  assert.throws(() => enforceTokenLifetime({ iat }, 'distill', limits));
});

test('verifyCapability: exp/iat are required; issuer and audience are enforced when configured', async () => {
  const noExp = await new SignJWT({ jsonam: { domains: ['trust://acme'], actions: ['read'] } })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setIssuedAt()
    .sign(privateKey);
  await assert.rejects(verifyCapability(noExp, publicKey));

  const token = await issueCapability(
    { domains: ['trust://acme'], actions: ['read'], issuer: 'https://auth.test', audience: 'carma' },
    pkcs8
  );
  const payload = await verifyCapability(token, publicKey, { issuer: 'https://auth.test', audience: 'carma' });
  assert.equal(payload.iss, 'https://auth.test');
  await assert.rejects(verifyCapability(token, publicKey, { issuer: 'https://rogue.test' }));
  await assert.rejects(verifyCapability(token, publicKey, { audience: 'other' }));
});

test('parseConfig: direct mTLS never falls back to the public root store', () => {
  const base = { CAPABILITY_ENDPOINT_ENABLED: 'true', MTLS_MODE: 'direct', TLS_CERT: 'cert', TLS_KEY: 'key', PRIVATE_KEY: 'k', TRUST_DOMAIN: 'acme' };
  assert.equal(parseConfig(base).mtlsDirectTls, false);
  assert.equal(parseConfig({ ...base, CAPABILITY_CLIENT_CA: 'ca' }).mtlsDirectTls, true);
});

test('extractMarkdownItems: symlinks are never followed', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'carma-outside-'));
  const secret = path.join(outside, 'secret.md');
  fs.writeFileSync(secret, '# leaked\nSECRET-MATERIAL');
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'carma-repo-'));
  fs.writeFileSync(path.join(repo, 'real.md'), '# Real doc\ncontent');
  fs.symlinkSync(secret, path.join(repo, 'leak.md'));
  fs.symlinkSync(outside, path.join(repo, 'leakdir'));
  const items = extractMarkdownItems(repo, { domain: 'acme', repo: 'org/repo' });
  assert.ok(!JSON.stringify(items).includes('SECRET-MATERIAL'));
  assert.ok(items.some((i) => i.uri.endsWith('/real.md')));
  assert.ok(!items.some((i) => i.uri.includes('leak')));
});

test('ensureCheckout: a source id cannot escape INGEST_WORK_DIR', () => {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'carma-work-'));
  for (const id of ['..', '.', '']) {
    assert.throws(() => ensureCheckout({ id, url: 'https://example.invalid/repo.git' }, work));
  }
  assert.ok(fs.existsSync(work));
});

test('redactUrlCredentials strips embedded tokens from git error text', () => {
  const out = redactUrlCredentials('fatal: could not read from https://x-access-token:ghp_secret123@github.com/org/repo.git');
  assert.ok(!out.includes('ghp_secret123'));
  assert.ok(out.includes('https://***@github.com/org/repo.git'));
});

test('storeTrace: a future occurredAt is clamped to now', async () => {
  let stored;
  const adapter = {
    store: async (rec) => {
      stored = rec;
      return { uri: rec.uri };
    },
    nearestNeighbor: async () => null,
  };
  const future = new Date(Date.now() + 365 * 86400 * 1000).toISOString();
  await storeTrace(adapter, { uri: 'trace://acme/t', trustDomain: 'acme', privateKeyPem: pkcs8 }, { content: 'x', occurredAt: future });
  assert.ok(Date.parse(stored.createdAt) <= Date.now() + 1000);
  assert.ok(Date.parse(stored.envelope.issuedAt) <= Date.now() + 1000);
});

// ---------------------------------------------------------------------------
// HTTP: the real server, no database
// ---------------------------------------------------------------------------
const PORT = 7500 + (process.pid % 200);

function req(method, p, token, body) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try {
          json = JSON.parse(b);
        } catch {}
        resolve({ status: res.statusCode, json, text: b });
      });
    });
    r.on('error', reject);
    if (payload) r.end(payload);
    else r.end();
  });
}

async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      if ((await req('GET', '/health')).status === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not healthy');
}

test('HTTP: writes are bound to the authorized trust domain; auth failures are JSON 401/403', async () => {
  const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
    env: {
      ...process.env,
      PORT: String(PORT),
      TRUST_DOMAIN: 'acme',
      PUBLIC_KEY: spki,
      PRIVATE_KEY: pkcs8,
      DATABASE_URL: '',
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'error',
      SOURCES: JSON.stringify([{ id: 'repo', type: 'git', url: 'https://example.invalid/repo.git' }]),
    },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  try {
    await waitHealth();
    const acme = await issueCapability({ domains: ['trust://acme'], actions: ['read', 'write'], subject: 't' }, pkcs8);
    const other = await issueCapability({ domains: ['trust://other'], actions: ['read', 'write'], subject: 't' }, pkcs8);

    const noAuth = await req('POST', '/memory', null, { content: 'x' });
    assert.equal(noAuth.status, 401);
    assert.deepEqual(noAuth.json, { error: 'Unauthorized' });

    // body.trustDomain cannot redirect a write authorized on a different URI.
    const redirect = await req('POST', '/memory', acme, { content: 'x', uri: 'trace://acme/t1', trustDomain: 'victim' });
    assert.equal(redirect.status, 400);

    // Without a uri, the write lands in body.trustDomain — which the token must cover.
    const foreign = await req('POST', '/memory', acme, { content: 'x', trustDomain: 'victim' });
    assert.equal(foreign.status, 403);
    assert.deepEqual(foreign.json, { error: 'Forbidden' });

    const sup = await req('POST', '/memory', acme, { content: 'x', supersedes: 'trace://victim/1' });
    assert.equal(sup.status, 400);

    const future = await req('POST', '/memory', acme, { content: 'x', occurredAt: '2999-01-01T00:00:00Z' });
    assert.equal(future.status, 400);

    const bad = await req('POST', '/memory', acme, { content: 'x', uri: 'x-context://acme/t' });
    assert.equal(bad.status, 400);

    // /ingest authorizes on the domain the sources write into, not body.trustDomain.
    const ingest = await req('POST', '/ingest', other, { trustDomain: 'other' });
    assert.equal(ingest.status, 403);

    const search = await req('GET', '/search?q=x&domain=other', acme);
    assert.equal(search.status, 403);
    assert.deepEqual(search.json, { error: 'Forbidden' });
  } finally {
    child.kill('SIGTERM');
  }
});
