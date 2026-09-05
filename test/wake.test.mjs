import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { issueCapability } from '../server/capability.js';

const DB = process.env.DATABASE_URL;
const DOMAIN = 'wake-' + Date.now();
const PORT = 7160 + (process.pid % 130);

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
      res.on('end', () => {
        let json = null;
        try {
          json = b ? JSON.parse(b) : null;
        } catch {
          /* non-JSON (e.g. plain-text 403/404) */
        }
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
  'Wake: session-start priming over HTTP and MCP (identity + recent + relevant, initialize instructions)',
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

    const rwToken = await issueCapability({ domains: [`trust://${DOMAIN}`], actions: ['read', 'write'], subject: 'seed', ttl: '10m' }, pkcs8);
    const roToken = await issueCapability({ domains: [`trust://${DOMAIN}`], actions: ['read'], subject: 'ro', ttl: '10m' }, pkcs8);

    const IDENTITY_MARK = 'always redact bearer tokens and never log Authorization headers';
    const rwTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${rwToken}` } },
    });
    const client = new Client({ name: 'wake-test', version: '0.0.0' }, { capabilities: {} });

    try {
      await waitHealth();

      // --- Seed a "self" (identity) layer + recent activity --------------------
      // Ingested agent-spec: identity comes from boundContext type:agent-spec.
      const spec = (await reqJson('POST', '/memory', rwToken, {
        task: 'Operating principles',
        content: IDENTITY_MARK,
        boundContext: ['repo:acme/os', 'path:AGENTS.md', 'type:agent-spec'],
        confidence: 0.9,
        importance: 0.9,
      })).json;
      assert.ok(spec.uri, 'seeded agent-spec');

      // A pinned decision is also identity.
      const pin = (await reqJson('POST', '/memory', rwToken, { task: 'infra choice', content: 'we standardize on Postgres + pgvector for recall' })).json;
      assert.equal((await reqJson('POST', '/pin', rwToken, { uri: pin.uri, pinned: true })).status, 200);

      // Recent episodic decisions ("what was I just doing").
      const r1 = (await reqJson('POST', '/memory', rwToken, { task: 'triage SSRF on gateway', content: 'blocked link-local metadata egress at the proxy', decision: { choice: 'egress allowlist' } })).json;
      await reqJson('POST', '/outcome', rwToken, { decisionUri: r1.uri, status: 'success', score: 0.9 });
      await reqJson('POST', '/memory', rwToken, { task: 'rotate signing keys', content: 'documented Ed25519 rotation runbook', decision: { choice: 'quarterly rotation' } });

      // --- 1) HTTP /wake is read-gated ----------------------------------------
      const noAuth = await reqJson('POST', '/wake', null, {});
      assert.equal(noAuth.status, 403, 'wake requires a token');

      // --- 2) HTTP /wake composes identity + recent (no task) -----------------
      const wake = (await reqJson('POST', '/wake', roToken, {})).json;
      assert.ok(wake.counts.identity >= 2, `identity layer present: ${JSON.stringify(wake.counts)}`);
      assert.ok(wake.counts.recent >= 1, 'recent layer present');
      const identityUris = wake.identity.map((x) => x.uri);
      assert.ok(identityUris.includes(spec.uri), 'agent-spec is identity');
      assert.ok(identityUris.includes(pin.uri), 'pinned memory is identity');
      assert.match(wake.digest, /WHO YOU ARE/);
      assert.match(wake.digest, /WHAT YOU WERE RECENTLY DOING/);
      assert.match(wake.digest, new RegExp(DOMAIN));

      // --- 3) HTTP /wake with a task adds a relevant precedent layer ----------
      const wakeTask = (await reqJson('POST', '/wake', roToken, { task: 'server-side request forgery in the gateway' })).json;
      assert.ok(wakeTask.relevant.length >= 1, 'task surfaces relevant precedent');
      assert.ok(wakeTask.relevant.some((p) => p.uri === r1.uri), 'the SSRF decision is recalled as relevant');
      assert.match(wakeTask.digest, /RELEVANT PRECEDENT/);

      // GET form works too.
      const wakeGet = (await reqJson('GET', `/wake?task=${encodeURIComponent('SSRF gateway')}`, roToken)).json;
      assert.ok(wakeGet.trustDomain === DOMAIN && typeof wakeGet.digest === 'string');

      // --- 4) MCP: initialize instructions carry the wake brief ---------------
      await client.connect(rwTransport);
      const instructions = client.getInstructions();
      assert.ok(instructions && instructions.includes('WHO YOU ARE'), 'MCP initialize instructions carry the wake brief');
      assert.match(instructions, new RegExp(DOMAIN));

      // --- 5) MCP: `wake` tool is exposed and returns the brief ---------------
      const tools = (await client.listTools()).tools.map((t) => t.name);
      assert.ok(tools.includes('wake'), 'wake tool exposed');
      const toolRes = await client.callTool({ name: 'wake', arguments: { task: 'SSRF gateway' } });
      const payload = JSON.parse(toolRes.content[0].text);
      assert.ok(payload.counts.identity >= 2 && payload.relevant.length >= 1);
      assert.ok(payload.identity.map((x) => x.uri).includes(spec.uri));

      // --- 6) MCP: the wake brief is also a readable resource -----------------
      const resources = (await client.listResources()).resources.map((r) => r.uri);
      const wakeResUri = `memory://${DOMAIN}/wake`;
      assert.ok(resources.includes(wakeResUri), 'wake resource listed');
      const read = await client.readResource({ uri: wakeResUri });
      const resPayload = JSON.parse(read.contents[0].text);
      assert.ok(resPayload.counts.identity >= 2 && typeof resPayload.digest === 'string');
    } finally {
      await client.close().catch(() => {});
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
    }
  }
);
