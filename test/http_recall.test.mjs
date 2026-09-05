import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { issueCapability } from '../server/capability.js';

const DB = process.env.DATABASE_URL;
const DOMAIN = 'httprecall-' + Date.now();
const PORT = 7150 + (process.pid % 150);

function reqJson(method, path, token, body) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port: PORT, path, method, headers }, (res) => {
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

test(
  'HTTP decision memory: outcome-weighted recall, supersede, retract',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const spki = await exportSPKI(publicKey);
    const pkcs8 = await exportPKCS8(privateKey);
    const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
      env: { ...process.env, PORT: String(PORT), TRUST_DOMAIN: DOMAIN, PUBLIC_KEY: spki, PRIVATE_KEY: pkcs8, DATABASE_URL: DB, RATE_LIMIT_ENABLED: 'false', LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d) => (logs += d));
    child.stderr.on('data', (d) => (logs += d));
    const token = await issueCapability({ domains: [`trust://${DOMAIN}`], actions: ['read', 'write'], subject: 'test', ttl: '10m' }, pkcs8);
    const text = 'unauthenticated redis on 6379; attempt module-load RCE';
    try {
      await waitHealth();

      const a = (await reqJson('POST', '/memory', token, { task: 'exploit redis', content: text, decision: { choice: 'module-load RCE' } })).json;
      const b = (await reqJson('POST', '/memory', token, { task: 'exploit redis', content: text, decision: { choice: 'module-load RCE' } })).json;
      assert.ok(a.uri && b.uri);

      // Flat /outcome contract: { decisionUri, status, score?, evidence? }
      const oa = await reqJson('POST', '/outcome', token, { decisionUri: a.uri, status: 'success', score: 0.95, evidence: 'code exec' });
      assert.equal(oa.status, 201, JSON.stringify(oa.json));
      assert.ok(oa.json.outcomeUri.startsWith(`memory://${DOMAIN}/outcome/`));
      await reqJson('POST', '/outcome', token, { decisionUri: b.uri, status: 'failure', score: -0.8 });

      // Precedent recall: successful reasoning ranks first and carries decision+outcome.
      const recall = (await reqJson('GET', `/search?q=${encodeURIComponent('redis rce')}&k=5`, token)).json;
      assert.equal(recall.results[0].uri, a.uri);
      assert.equal(recall.results[0].outcome.status, 'success');
      assert.equal(recall.results[0].decision.choice, 'module-load RCE');
      assert.ok(recall.results[0].reasoning.includes('redis'));
      const bp = recall.results.find((r) => r.uri === b.uri);
      assert.ok(Number(recall.results[0].score) > Number(bp.score), 'success outranks failure');

      // Revision: supersede hides the old version, records lineage.
      const v1 = (await reqJson('POST', '/memory', token, { task: 'fix', content: 'disable redis entirely' })).json;
      const v2 = (await reqJson('POST', '/memory', token, { task: 'fix', content: 'require AUTH and firewall 6379', supersedes: v1.uri })).json;
      const fix = (await reqJson('GET', `/search?q=${encodeURIComponent('remediate redis')}&k=10`, token)).json;
      const fixUris = fix.results.map((r) => r.uri);
      assert.ok(fixUris.includes(v2.uri));
      assert.ok(!fixUris.includes(v1.uri));
      assert.equal(fix.results.find((r) => r.uri === v2.uri).lineage.supersedes, v1.uri);

      // Retraction: excluded from recall, still resolvable for audit.
      const r = (await reqJson('POST', '/memory', token, { task: 'finding', content: 'critical rce web-01' })).json;
      assert.equal((await reqJson('POST', '/retract', token, { uri: r.uri, reason: 'false positive' })).status, 200);
      const after = (await reqJson('GET', `/search?q=${encodeURIComponent('critical rce web-01')}&k=5`, token)).json;
      assert.ok(!after.results.map((x) => x.uri).includes(r.uri));
      assert.equal((await reqJson('GET', `/resolve?uri=${encodeURIComponent(r.uri)}`, token)).status, 200);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
    }
  }
);
