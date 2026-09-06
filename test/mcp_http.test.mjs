import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { issueCapability } from '../server/capability.js';

const DB = process.env.DATABASE_URL;
const DOMAIN = 'httpmcp-' + Date.now();

function get(path, port) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', reject);
  });
}

async function waitForHealth(port, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await get('/health', port);
      if (r.status === 200) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('server did not become healthy in time');
}

// POST an MCP initialize with no auth and assert the server rejects it (401).
function initWithoutAuth(port) {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'noauth', version: '0.0.0' },
    },
  });
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on('error', reject);
    req.end(payload);
  });
}

test(
  'MCP over Streamable HTTP: any harness can connect, list tools, recall & ingest',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const spki = await exportSPKI(publicKey);
    const pkcs8 = await exportPKCS8(privateKey);

    const port = 7141 + (process.pid % 200);
    const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
      env: {
        ...process.env,
        PORT: String(port),
        TRUST_DOMAIN: DOMAIN,
        PUBLIC_KEY: spki,
        PRIVATE_KEY: pkcs8,
        DATABASE_URL: DB,
        RATE_LIMIT_ENABLED: 'false',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let serverLog = '';
    child.stdout.on('data', (d) => (serverLog += d));
    child.stderr.on('data', (d) => (serverLog += d));

    const rwToken = await issueCapability(
      { domains: [`trust://${DOMAIN}`], actions: ['read', 'write'], subject: 'harness-rw', ttl: '10m' },
      pkcs8
    );
    const roToken = await issueCapability(
      { domains: [`trust://${DOMAIN}`], actions: ['read'], subject: 'harness-ro', ttl: '10m' },
      pkcs8
    );

    const rwTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${rwToken}` } },
    });
    const rwClient = new Client({ name: 'carma-http-test', version: '0.0.0' }, { capabilities: {} });

    const roTransport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${roToken}` } },
    });
    const roClient = new Client({ name: 'carma-http-ro', version: '0.0.0' }, { capabilities: {} });

    try {
      await waitForHealth(port);

      // 1) Unauthenticated initialize is rejected.
      const noAuth = await initWithoutAuth(port);
      assert.equal(noAuth.status, 401, `expected 401, got ${noAuth.status}: ${noAuth.body}`);

      // 2) A read+write harness connects and sees the tools.
      await rwClient.connect(rwTransport);
      const tools = await rwClient.listTools();
      const names = tools.tools.map((t) => t.name).sort();
      assert.deepEqual(names, ['record_outcome', 'retract_memory', 'search_memory', 'store_trace', 'wake']);

      // 3) Ingest a reasoning trace over HTTP MCP.
      const stored = await rwClient.callTool({
        name: 'store_trace',
        arguments: { task: 'http mcp', content: 'remote agent stored a reasoning trace over streamable http transport' },
      });
      const storedObj = JSON.parse(stored.content[0].text);
      assert.ok(storedObj.uri.startsWith(`trace://${DOMAIN}/`));
      assert.equal(storedObj.stored, true);

      // 4) Recall it via semantic search.
      const searched = await rwClient.callTool({
        name: 'search_memory',
        arguments: { query: 'reasoning trace streamable http', k: 3 },
      });
      const res = JSON.parse(searched.content[0].text);
      assert.ok(Array.isArray(res.results) && res.results.length >= 1);

      // 5) A read-only harness can search but is denied write (store_trace).
      await roClient.connect(roTransport);
      const roSearch = await roClient.callTool({ name: 'search_memory', arguments: { query: 'reasoning', k: 1 } });
      assert.ok(JSON.parse(roSearch.content[0].text).results !== undefined);

      const denied = await roClient.callTool({
        name: 'store_trace',
        arguments: { content: 'read-only harness should not be able to write' },
      });
      assert.equal(denied.isError, true, 'read-only token must be denied write');
      assert.match(denied.content[0].text, /Permission denied/);
    } finally {
      await rwClient.close().catch(() => {});
      await roClient.close().catch(() => {});
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
    }
  }
);
