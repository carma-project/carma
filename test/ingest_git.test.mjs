import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { issueCapability } from '../server/capability.js';

const DB = process.env.DATABASE_URL;
const DOMAIN = 'gitingest-' + Date.now();
const PORT = 7480 + (process.pid % 100);

function reqJson(method, p, token, body) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    if (payload) r.end(payload);
    else r.end();
  });
}
async function waitHealth() {
  for (let i = 0; i < 80; i++) {
    try {
      const s = await new Promise((res, rej) => {
        const r = http.get({ host: '127.0.0.1', port: PORT, path: '/health' }, (x) => res(x.statusCode));
        r.on('error', rej);
      });
      if (s === 200) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server not healthy');
}

function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carma-git-'));
  const g = (args, date) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
    });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t.co']);
  g(['config', 'user.name', 'Tester']);
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'Add initial auth using JWT HS256'], '2023-02-01T10:00:00');
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v2');
  g(['add', '-A']);
  g(['commit', '-q', '-m', 'Add aggressive in-memory cache for recall'], '2024-01-10T10:00:00');
  const revSha = execFileSync('git', ['-C', dir, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  fs.writeFileSync(path.join(dir, 'app.txt'), 'v1');
  g(['add', '-A']);
  g(['commit', '-q', '-m', `Revert cache change\n\nThis reverts commit ${revSha}. Stale results in prod.`], '2024-02-01T10:00:00');
  return { dir, revSha };
}

test(
  'git-history ingest: commits become dated memories; reverts record a failure outcome',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const spki = await exportSPKI(publicKey);
    const pkcs8 = await exportPKCS8(privateKey);
    const { dir, revSha } = buildRepo();

    const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
      env: { ...process.env, PORT: String(PORT), TRUST_DOMAIN: DOMAIN, PUBLIC_KEY: spki, PRIVATE_KEY: pkcs8, DATABASE_URL: DB, RATE_LIMIT_ENABLED: 'false', LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d) => (logs += d));
    child.stderr.on('data', (d) => (logs += d));
    const token = await issueCapability({ domains: [`trust://${DOMAIN}`], actions: ['read', 'write'], subject: 'test', ttl: '10m' }, pkcs8);

    try {
      await waitHealth();
      execFileSync('node', ['--import', 'tsx', 'scripts/ingest-git.mjs', '--dir', dir, '--url', `http://127.0.0.1:${PORT}`, '--domain', DOMAIN, '--repo', 'acme/app'], {
        env: { ...process.env, PRIVATE_KEY: pkcs8 },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Preserved chronology: the imported commit's issuedAt is its author date.
      const authUri = `trace://${DOMAIN}/gh/acme/app/commit/`;
      const found = (await reqJson('GET', `/search?q=${encodeURIComponent('authentication keys jwt')}&k=5`, token)).json;
      assert.ok(found.results.length >= 1);
      const authHit = found.results.find((r) => /HS256/.test(r.reasoning || ''));
      assert.ok(authHit, 'auth commit recalled');
      const env = (await reqJson('GET', `/resolve?uri=${encodeURIComponent(authHit.uri)}`, token)).json;
      assert.equal(env.envelope.issuedAt, '2023-02-01T10:00:00.000Z', 'issuedAt = commit author date');
      assert.ok(authHit.uri.startsWith(authUri));

      // Revert recorded a failure outcome on the reverted commit.
      const cacheUri = `trace://${DOMAIN}/gh/acme/app/commit/${revSha}`;
      const cacheEnv = (await reqJson('GET', `/resolve?uri=${encodeURIComponent(cacheUri)}`, token)).json;
      assert.equal(cacheEnv.envelope.decision.choice, 'Add aggressive in-memory cache for recall');
      const cacheRecall = (await reqJson('GET', `/search?q=${encodeURIComponent('cache recall results')}&k=5`, token)).json;
      const cacheHit = cacheRecall.results.find((r) => r.uri === cacheUri);
      assert.ok(cacheHit, 'cache commit recalled');
      assert.equal(cacheHit.outcome.status, 'failure', 'revert produced a failure outcome');
    } catch (e) {
      throw new Error(e.message + '\n--- server logs ---\n' + logs);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }
);
