import test from 'node:test';
import assert from 'node:assert/strict';
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { boundGrant } from '../server/capability_issue.js';
import { parseDurationSeconds } from '../server/config.js';
import { clientIdentity } from '../server/mtls.js';

// ---------------------------------------------------------------------------
// Unit: duration parsing
// ---------------------------------------------------------------------------
test('parseDurationSeconds: bare seconds and suffixes', () => {
  assert.equal(parseDurationSeconds('900', 0), 900);
  assert.equal(parseDurationSeconds('30s', 0), 30);
  assert.equal(parseDurationSeconds('15m', 0), 900);
  assert.equal(parseDurationSeconds('2h', 0), 7200);
  assert.equal(parseDurationSeconds('1d', 0), 86400);
  assert.equal(parseDurationSeconds('', 42), 42);
  assert.equal(parseDurationSeconds('garbage', 42), 42);
});

// ---------------------------------------------------------------------------
// Unit: grant bounding
// ---------------------------------------------------------------------------
const POLICY = { domains: ['trust://acme'], actions: ['read', 'write'], maxTtlSeconds: 900 };

test('boundGrant: empty request grants the full policy set', () => {
  const g = boundGrant({ requested: {}, policy: POLICY });
  assert.deepEqual(g.domains, ['trust://acme']);
  assert.deepEqual(g.actions, ['read', 'write']);
  assert.equal(g.ttlSeconds, 900);
});

test('boundGrant: requested actions are intersected with policy (no escalation)', () => {
  const g = boundGrant({ requested: { actions: ['read', 'write', 'distill'] }, policy: POLICY });
  assert.deepEqual(g.actions, ['read', 'write']);
});

test('boundGrant: bare domain names are normalized and intersected', () => {
  const g = boundGrant({ requested: { domains: ['acme'] }, policy: POLICY });
  assert.deepEqual(g.domains, ['trust://acme']);
});

test('boundGrant: ttl is clamped to the policy ceiling', () => {
  assert.equal(boundGrant({ requested: { ttl: 999999 }, policy: POLICY }).ttlSeconds, 900);
  assert.equal(boundGrant({ requested: { ttl: 120 }, policy: POLICY }).ttlSeconds, 120);
});

test('boundGrant: refresh cannot widen a narrower prior grant', () => {
  const g = boundGrant({
    requested: { actions: ['read', 'write'] },
    policy: POLICY,
    priorGrant: { domains: ['trust://acme'], actions: ['read'] },
  });
  assert.deepEqual(g.actions, ['read']);
});

test('boundGrant: throws when nothing is permitted', () => {
  assert.throws(() => boundGrant({ requested: { domains: ['other'] }, policy: POLICY }), /No permitted domains/);
  assert.throws(() => boundGrant({ requested: { actions: ['delete'] }, policy: POLICY }), /No permitted actions/);
  assert.throws(() => boundGrant({ requested: { ttl: -5 }, policy: POLICY }), /positive number/);
});

// ---------------------------------------------------------------------------
// Unit: client identity resolution (direct + proxy)
// ---------------------------------------------------------------------------
const PROXY_CFG = {
  mtlsMode: 'proxy',
  mtlsProxySecret: 's3cret',
  mtlsProxySecretHeader: 'x-proxy-authorization',
  mtlsProxySubjectHeader: 'x-client-subject',
  mtlsProxyVerifyHeader: 'x-client-verify',
  mtlsProxyFingerprintHeader: 'x-client-fingerprint',
  capabilityTrustedFingerprints: [],
};

test('clientIdentity proxy: trusts forwarded identity only with matching secret', () => {
  const ok = clientIdentity({ headers: { 'x-proxy-authorization': 's3cret', 'x-client-subject': 'cyberorbit', 'x-client-verify': 'SUCCESS' } }, PROXY_CFG);
  assert.equal(ok?.subject, 'cyberorbit');
  assert.equal(ok?.mode, 'proxy');

  assert.equal(clientIdentity({ headers: { 'x-proxy-authorization': 'wrong', 'x-client-subject': 'cyberorbit' } }, PROXY_CFG), null);
  assert.equal(clientIdentity({ headers: { 'x-client-subject': 'cyberorbit' } }, PROXY_CFG), null);
  assert.equal(clientIdentity({ headers: { 'x-proxy-authorization': 's3cret' } }, PROXY_CFG), null);
  assert.equal(clientIdentity({ headers: { 'x-proxy-authorization': 's3cret', 'x-client-subject': 'x', 'x-client-verify': 'FAILED' } }, PROXY_CFG), null);
});

test('clientIdentity proxy: fingerprint pinning rejects unlisted certs', () => {
  const cfg = { ...PROXY_CFG, capabilityTrustedFingerprints: ['aa:bb'.replace(/:/g, '').toLowerCase()] };
  assert.equal(clientIdentity({ headers: { 'x-proxy-authorization': 's3cret', 'x-client-subject': 'c', 'x-client-fingerprint': 'CC:DD' } }, cfg), null);
  assert.ok(clientIdentity({ headers: { 'x-proxy-authorization': 's3cret', 'x-client-subject': 'c', 'x-client-fingerprint': 'AA:BB' } }, cfg));
});

test('clientIdentity direct: requires an authorized peer certificate', () => {
  const cfg = { mtlsMode: 'direct', capabilityTrustedFingerprints: [] };
  const authorized = {
    socket: { authorized: true, getPeerCertificate: () => ({ subject: { CN: 'cyberorbit' }, fingerprint256: 'AB:CD' }) },
    headers: {},
  };
  assert.equal(clientIdentity(authorized, cfg)?.subject, 'cyberorbit');

  const unauthorized = { socket: { authorized: false, getPeerCertificate: () => ({ subject: { CN: 'x' } }) }, headers: {} };
  assert.equal(clientIdentity(unauthorized, cfg), null);

  const noCert = { socket: { authorized: true, getPeerCertificate: () => ({}) }, headers: {} };
  assert.equal(clientIdentity(noCert, cfg), null);

  const noSocket = { headers: {} };
  assert.equal(clientIdentity(noSocket, cfg), null);
});

// ---------------------------------------------------------------------------
// Integration: real mTLS over HTTPS against the running server
// ---------------------------------------------------------------------------
function genCerts() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carma-mtls-'));
  const p = (f) => path.join(dir, f);
  const run = (args) => execFileSync('openssl', args, { stdio: ['ignore', 'ignore', 'ignore'] });
  run(['req', '-x509', '-newkey', 'ed25519', '-nodes', '-keyout', p('ca.key'), '-out', p('ca.crt'), '-subj', '/CN=CARMA Test CA', '-days', '2']);
  run(['req', '-newkey', 'ed25519', '-nodes', '-keyout', p('server.key'), '-out', p('server.csr'), '-subj', '/CN=localhost']);
  fs.writeFileSync(p('san.ext'), 'subjectAltName=IP:127.0.0.1,DNS:localhost');
  run(['x509', '-req', '-in', p('server.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('server.crt'), '-days', '2', '-extfile', p('san.ext')]);
  run(['req', '-newkey', 'ed25519', '-nodes', '-keyout', p('client.key'), '-out', p('client.csr'), '-subj', '/CN=cyberorbit']);
  run(['x509', '-req', '-in', p('client.csr'), '-CA', p('ca.crt'), '-CAkey', p('ca.key'), '-CAcreateserial', '-out', p('client.crt'), '-days', '2']);
  const read = (f) => fs.readFileSync(p(f), 'utf8');
  return { dir, ca: read('ca.crt'), serverCert: read('server.crt'), serverKey: read('server.key'), clientCert: read('client.crt'), clientKey: read('client.key') };
}

function parseMaybe(b) {
  if (!b) return null;
  try {
    return JSON.parse(b);
  } catch {
    return null;
  }
}

const HTTPS_PORT = 7300 + (process.pid % 120);

function httpsJson(port, method, path, { ca, cert, key, token, body } = {}) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const r = https.request({ host: '127.0.0.1', port, path, method, headers, ca, cert, key, rejectUnauthorized: true }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: parseMaybe(b), text: b }));
    });
    r.on('error', reject);
    if (payload) r.end(payload);
    else r.end();
  });
}

function waitHealthHttps(port, ca) {
  return (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const s = await new Promise((res, rej) => {
          const r = https.get({ host: '127.0.0.1', port, path: '/health', ca, rejectUnauthorized: true }, (x) => res(x.statusCode));
          r.on('error', rej);
        });
        if (s === 200) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('server not healthy');
  })();
}

test('POST /capability: direct mTLS issues bounded, scoped tokens', async () => {
  const certs = genCerts();
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const spki = await exportSPKI(publicKey);
  const pkcs8 = await exportPKCS8(privateKey);
  const DB = process.env.DATABASE_URL;
  const DOMAIN = 'mtls-' + Date.now();

  const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
    env: {
      ...process.env,
      PORT: String(HTTPS_PORT),
      TRUST_DOMAIN: DOMAIN,
      PUBLIC_KEY: spki,
      PRIVATE_KEY: pkcs8,
      DATABASE_URL: DB || '',
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'warn',
      CAPABILITY_ENDPOINT_ENABLED: 'true',
      MTLS_MODE: 'direct',
      TLS_CERT: certs.serverCert,
      TLS_KEY: certs.serverKey,
      CAPABILITY_CLIENT_CA: certs.ca,
      CAPABILITY_MAX_ACTIONS: 'read,write',
      CAPABILITY_MAX_TTL: '10m',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));

  const withCert = { ca: certs.ca, cert: certs.clientCert, key: certs.clientKey };
  try {
    await waitHealthHttps(HTTPS_PORT, certs.ca);

    // 1) No client certificate -> 401.
    const anon = await httpsJson(HTTPS_PORT, 'POST', '/capability', { ca: certs.ca, body: {} });
    assert.equal(anon.status, 401, JSON.stringify(anon.json));

    // 2) Valid client cert -> 201 with the subject taken from the cert CN.
    const issued = await httpsJson(HTTPS_PORT, 'POST', '/capability', { ...withCert, body: { actions: ['read', 'write', 'distill'], ttl: 999999 } });
    assert.equal(issued.status, 201, JSON.stringify(issued.json));
    assert.equal(issued.json.subject, 'cyberorbit');
    assert.deepEqual(issued.json.actions.sort(), ['read', 'write'], 'distill dropped by policy');
    assert.equal(issued.json.expiresIn, 600, 'ttl clamped to 10m ceiling');
    assert.deepEqual(issued.json.domains, [`trust://${DOMAIN}`]);
    assert.ok(typeof issued.json.token === 'string' && issued.json.token.length > 20);

    // 3) Refresh with a read-only token cannot re-acquire write.
    const readOnly = await httpsJson(HTTPS_PORT, 'POST', '/capability', { ...withCert, body: { actions: ['read'] } });
    const narrowed = await httpsJson(HTTPS_PORT, 'POST', '/capability', { ...withCert, token: readOnly.json.token, body: { actions: ['read', 'write'] } });
    assert.deepEqual(narrowed.json.actions, ['read'], 'refresh cannot escalate');

    // 4) The issued token actually works on a bearer endpoint (needs DB).
    if (DB) {
      const stored = await httpsJson(HTTPS_PORT, 'POST', '/memory', { ...withCert, token: issued.json.token, body: { task: 'recon', content: 'mtls issued token e2e', decision: { choice: 'proceed' } } });
      assert.equal(stored.status, 201, JSON.stringify(stored.json));
      const found = await httpsJson(HTTPS_PORT, 'GET', `/search?q=${encodeURIComponent('mtls issued token')}&k=3`, { ...withCert, token: issued.json.token });
      assert.equal(found.status, 200, JSON.stringify(found.json));
      assert.ok(found.json.results.some((r) => r.uri === stored.json.uri));
    }
  } catch (e) {
    throw new Error(e.message + '\n--- server logs ---\n' + logs);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
    fs.rmSync(certs.dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Integration: proxy mode over plain HTTP with a shared secret
// ---------------------------------------------------------------------------
const HTTP_PORT = 7420 + (process.pid % 120);

function reqJson(port, method, path, headers = {}, body) {
  const payload = body ? JSON.stringify(body) : null;
  const h = { ...headers };
  if (payload) {
    h['Content-Type'] = 'application/json';
    h['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method, headers: h }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: parseMaybe(b), text: b }));
    });
    r.on('error', reject);
    if (payload) r.end(payload);
    else r.end();
  });
}

test('POST /capability: proxy mode trusts forwarded identity only with the shared secret', async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const spki = await exportSPKI(publicKey);
  const pkcs8 = await exportPKCS8(privateKey);
  const DOMAIN = 'mtlsproxy-' + Date.now();

  const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
    env: {
      ...process.env,
      PORT: String(HTTP_PORT),
      TRUST_DOMAIN: DOMAIN,
      PUBLIC_KEY: spki,
      PRIVATE_KEY: pkcs8,
      DATABASE_URL: process.env.DATABASE_URL || '',
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'warn',
      CAPABILITY_ENDPOINT_ENABLED: 'true',
      MTLS_MODE: 'proxy',
      CAPABILITY_PROXY_SECRET: 'proxy-shared-secret',
      CAPABILITY_MAX_ACTIONS: 'read,write',
      CAPABILITY_MAX_TTL: '5m',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (d) => (logs += d));
  child.stderr.on('data', (d) => (logs += d));

  try {
    for (let i = 0; i < 80; i++) {
      try {
        const s = await new Promise((res, rej) => {
          const r = http.get({ host: '127.0.0.1', port: HTTP_PORT, path: '/health' }, (x) => res(x.statusCode));
          r.on('error', rej);
        });
        if (s === 200) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }

    // Wrong / missing secret -> 401.
    assert.equal((await reqJson(HTTP_PORT, 'POST', '/capability', { 'x-proxy-authorization': 'nope', 'x-client-subject': 'cyberorbit' }, {})).status, 401);
    assert.equal((await reqJson(HTTP_PORT, 'POST', '/capability', { 'x-client-subject': 'cyberorbit' }, {})).status, 401);

    // Correct secret + subject -> 201.
    const ok = await reqJson(HTTP_PORT, 'POST', '/capability', { 'x-proxy-authorization': 'proxy-shared-secret', 'x-client-subject': 'cyberorbit', 'x-client-verify': 'SUCCESS' }, { actions: ['read'] });
    assert.equal(ok.status, 201, JSON.stringify(ok.json));
    assert.equal(ok.json.subject, 'cyberorbit');
    assert.deepEqual(ok.json.actions, ['read']);
    assert.equal(ok.json.expiresIn, 300);
  } catch (e) {
    throw new Error(e.message + '\n--- server logs ---\n' + logs);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
  }
});

// Disabled by default: the endpoint must not exist unless explicitly enabled.
const OFF_PORT = 7550 + (process.pid % 120);
test('POST /capability: 404 when the endpoint is disabled', async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const spki = await exportSPKI(publicKey);
  const pkcs8 = await exportPKCS8(privateKey);
  const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
    env: { ...process.env, PORT: String(OFF_PORT), TRUST_DOMAIN: 'off', PUBLIC_KEY: spki, PRIVATE_KEY: pkcs8, DATABASE_URL: process.env.DATABASE_URL || '', RATE_LIMIT_ENABLED: 'false', LOG_LEVEL: 'warn' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
    for (let i = 0; i < 80; i++) {
      try {
        const s = await new Promise((res, rej) => {
          const r = http.get({ host: '127.0.0.1', port: OFF_PORT, path: '/health' }, (x) => res(x.statusCode));
          r.on('error', rej);
        });
        if (s === 200) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    assert.equal((await reqJson(OFF_PORT, 'POST', '/capability', {}, {})).status, 404);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    if (!child.killed) child.kill('SIGKILL');
  }
});
