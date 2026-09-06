import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { issueCapability } from '../server/capability.js';

const DB = process.env.DATABASE_URL;
const DOMAIN = 'status-' + Date.now();

function get(port, path, token) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => {
        let json = null;
        try {
          json = b ? JSON.parse(b) : null;
        } catch {
          /* non-JSON (e.g. UI html or plain 404) */
        }
        resolve({ status: res.statusCode, json, text: b });
      });
    });
    r.on('error', reject);
    r.end();
  });
}

function waitHealth(port) {
  return (async () => {
    for (let i = 0; i < 80; i++) {
      try {
        const s = await new Promise((res, rej) => {
          const r = http.get({ host: '127.0.0.1', port, path: '/health' }, (x) => res(x.statusCode));
          r.on('error', rej);
        });
        if (s === 200) return;
      } catch {}
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error('server not healthy on ' + port);
  })();
}

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return { spki: await exportSPKI(publicKey), pkcs8: await exportPKCS8(privateKey) };
}

function spawnServer(port, extraEnv, spki, pkcs8) {
  return spawn('node', ['--import', 'tsx', 'server/index.js'], {
    env: {
      ...process.env,
      PORT: String(port),
      TRUST_DOMAIN: DOMAIN,
      PUBLIC_KEY: spki,
      PRIVATE_KEY: pkcs8,
      DATABASE_URL: DB,
      RATE_LIMIT_ENABLED: 'false',
      LOG_LEVEL: 'warn',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

test(
  'Exposure: default-hardened /api/status is coarse without a token, full with a read token; UI served',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const PORT = 7500 + (process.pid % 120);
    const { spki, pkcs8 } = await keys();
    const child = spawnServer(PORT, {}, spki, pkcs8);
    try {
      await waitHealth(PORT);
      const roToken = await issueCapability({ domains: [`trust://${DOMAIN}`], actions: ['read'], subject: 'ro', ttl: '10m' }, pkcs8);

      // Anonymous: coarse readiness only — no recon (trust domain, sources, ingest).
      const anon = await get(PORT, '/api/status');
      assert.equal(anon.status, 200);
      assert.ok(anon.json && typeof anon.json.ready === 'boolean');
      assert.ok(anon.json.components && typeof anon.json.components.database === 'boolean');
      assert.equal(anon.json.trustDomain, undefined);
      assert.equal(anon.json.ingest, undefined);
      assert.equal(anon.json.mcp, undefined);

      // With a read token: full detail.
      const full = await get(PORT, '/api/status', roToken);
      assert.equal(full.status, 200);
      assert.equal(full.json.trustDomain, DOMAIN);
      assert.ok(full.json.ingest && full.json.mcp);

      // UI is served by default.
      const ui = await get(PORT, '/');
      assert.equal(ui.status, 200);
      assert.match(ui.text, /</);
    } finally {
      child.kill('SIGKILL');
    }
  }
);

test(
  'Exposure: STATUS_PUBLIC exposes full status anonymously; UI_ENABLED=false disables the UI',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const PORT = 7640 + (process.pid % 120);
    const { spki, pkcs8 } = await keys();
    const child = spawnServer(PORT, { STATUS_PUBLIC: 'true', UI_ENABLED: 'false' }, spki, pkcs8);
    try {
      await waitHealth(PORT);
      // Anonymous now sees full detail (opt-in).
      const anon = await get(PORT, '/api/status');
      assert.equal(anon.status, 200);
      assert.equal(anon.json.trustDomain, DOMAIN);

      // UI disabled -> not served (falls through to 404).
      const ui = await get(PORT, '/');
      assert.equal(ui.status, 404);
    } finally {
      child.kill('SIGKILL');
    }
  }
);
