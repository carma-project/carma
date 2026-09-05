// Connector coverage: CARMA pulls from a SQL database, a generic JSON API, and
// GitHub issues/PRs — each through the same source registry + write path. The
// postgres connector runs against the real test DB; http/github run against
// local mock servers so the test is hermetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import pg from 'pg';
import { generateKeyPair, exportPKCS8, exportSPKI } from 'jose';
import { issueCapability } from '../server/capability.js';

const DB = process.env.DATABASE_URL;
const DOMAIN = 'connectors-' + Date.now();
const PORT = 7660 + (process.pid % 100);
const TABLE = `carma_src_${Date.now()}`;

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
function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}
function send(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

test(
  'connectors: postgres (SQL), http (JSON API), and github (issues/PRs) all ingest via the source registry',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const spki = await exportSPKI(publicKey);
    const pkcs8 = await exportPKCS8(privateKey);

    // --- seed a source SQL table in the test DB ---
    const seed = new pg.Client({ connectionString: DB });
    await seed.connect();
    await seed.query(
      `CREATE TABLE ${TABLE} (id int primary key, title text, body text, made_at timestamptz, verdict text)`
    );
    await seed.query(
      `INSERT INTO ${TABLE} (id, title, body, made_at, verdict) VALUES
       (1, 'Incident 42: prod outage', 'Root cause was an unbounded query against the ledger.', '2024-05-01T09:00:00Z', 'add a statement timeout'),
       (2, 'Runbook: rotate signing keys', 'Rotate the Ed25519 keypair quarterly and redeploy.', '2024-06-01T09:00:00Z', 'automate rotation'),
       (3, 'Vendor review: pgvector', 'Chose pgvector for operational simplicity over a dedicated store.', '2024-07-01T09:00:00Z', 'adopt pgvector')`
    );

    // --- http mock: a JSON API returning a list under items[] ---
    const httpMock = http.createServer((req, res) => {
      send(res, 200, {
        items: [
          { key: 'kb-1', name: 'How we handle secrets', text: 'Secrets live in the vault, never in git.', when: '2024-04-01T00:00:00Z' },
          { key: 'kb-2', name: 'On-call expectations', text: 'Ack within 5 minutes; escalate after 15.', when: '2024-04-02T00:00:00Z' },
        ],
      });
    });
    const httpPort = await listen(httpMock);

    // --- github mock: issues endpoint (issues + PRs) + comments ---
    const ghMock = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      if (u.pathname === '/repos/acme/app/issues') {
        if (u.searchParams.get('page') !== '1') return send(res, 200, []);
        const base = `http://127.0.0.1:${ghMock.address().port}`;
        return send(res, 200, [
          { number: 1, title: 'Investigate auth timeout', body: 'Users report 30s hangs on login.', state: 'open', comments: 1, comments_url: `${base}/repos/acme/app/issues/1/comments`, user: { login: 'alice' }, created_at: '2024-02-01T10:00:00Z' },
          { number: 2, title: 'Add rate limiting to the API', body: 'Token bucket per client.', state: 'closed', comments: 0, pull_request: { merged_at: '2024-03-01T10:00:00Z' }, user: { login: 'bob' }, created_at: '2024-02-15T10:00:00Z' },
          { number: 3, title: 'Rewrite the gateway in Rust', body: 'Proposal to rewrite.', state: 'closed', state_reason: 'not_planned', comments: 0, user: { login: 'carol' }, created_at: '2024-02-20T10:00:00Z' },
        ]);
      }
      if (u.pathname === '/repos/acme/app/issues/1/comments') {
        return send(res, 200, [{ user: { login: 'dave' }, body: 'I traced it to the database connection pool exhaustion.' }]);
      }
      return send(res, 404, { message: 'not found' });
    });
    const ghPort = await listen(ghMock);

    const sources = [
      { id: 'db', type: 'postgres', dsn: DB, query: `SELECT id, title, body, made_at, verdict FROM ${TABLE} ORDER BY id`, columns: { id: 'id', title: 'title', content: 'body', date: 'made_at', decision: 'verdict' } },
      { id: 'kb', type: 'http', url: `http://127.0.0.1:${httpPort}/`, itemsPath: 'items', fields: { id: 'key', title: 'name', content: 'text', date: 'when' } },
      { id: 'tracker', type: 'github', repo: 'acme/app', apiBase: `http://127.0.0.1:${ghPort}`, includeComments: true },
    ];

    const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
      env: {
        ...process.env,
        PORT: String(PORT),
        TRUST_DOMAIN: DOMAIN,
        PUBLIC_KEY: spki,
        PRIVATE_KEY: pkcs8,
        DATABASE_URL: DB,
        SOURCES: JSON.stringify(sources),
        INGEST_ON_BOOT: 'false',
        INGEST_SCHEDULER_ENABLED: 'false',
        RATE_LIMIT_ENABLED: 'false',
        LOG_LEVEL: 'warn',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let logs = '';
    child.stdout.on('data', (d) => (logs += d));
    child.stderr.on('data', (d) => (logs += d));
    const token = await issueCapability(
      { domains: [`trust://${DOMAIN}`], actions: ['read', 'write'], subject: 'test', ttl: '10m' },
      pkcs8
    );

    try {
      await waitHealth();

      await test('postgres: SQL rows become dated decision memories', async () => {
        const run = (await reqJson('POST', '/ingest', token, { sourceId: 'db' })).json;
        const rep = run.reports[0];
        assert.equal(rep.stored.failed, 0);
        assert.equal(rep.stored.count, 3, 'three rows ingested');
        assert.equal(rep.byType.row, 3);
        const hit = (await reqJson('GET', `/search?q=${encodeURIComponent('unbounded query outage timeout')}&k=3`, token)).json;
        const inc = hit.results.find((r) => r.uri === `trace://${DOMAIN}/db/1`);
        assert.ok(inc, 'incident row recalled at deterministic uri');
        assert.equal(inc.decision.choice, 'add a statement timeout', 'verdict column mapped to decision');
        const env = (await reqJson('GET', `/resolve?uri=${encodeURIComponent(inc.uri)}`, token)).json;
        assert.equal(env.envelope.issuedAt, '2024-05-01T09:00:00.000Z', 'made_at preserved as issuedAt');
      });

      await test('http: a JSON API list becomes memories', async () => {
        const run = (await reqJson('POST', '/ingest', token, { sourceId: 'kb' })).json;
        const rep = run.reports[0];
        assert.equal(rep.stored.failed, 0);
        assert.equal(rep.byType.record, 2, 'two API records ingested');
        const hit = (await reqJson('GET', `/search?q=${encodeURIComponent('where do secrets live')}&k=3`, token)).json;
        assert.ok(hit.results.find((r) => r.uri === `trace://${DOMAIN}/kb/kb-1`), 'kb record recalled');
      });

      await test('github: issues + PRs ingest with discussion and outcome signal', async () => {
        const run = (await reqJson('POST', '/ingest', token, { sourceId: 'tracker' })).json;
        const rep = run.reports[0];
        assert.equal(rep.stored.failed, 0);
        assert.equal(rep.byType.issue, 2, 'two issues');
        assert.equal(rep.byType.pr, 1, 'one PR');
        assert.equal(rep.outcomes.count, 2, 'merged PR + not-planned issue recorded outcomes');

        // Comment thread folded into the issue content.
        const issueUri = `trace://${DOMAIN}/gh/acme/app/issues/1`;
        const env = (await reqJson('GET', `/resolve?uri=${encodeURIComponent(issueUri)}`, token)).json;
        assert.match(env.envelope.content, /connection pool exhaustion/, 'comment thread appended');
        assert.equal(env.envelope.issuedAt, '2024-02-01T10:00:00.000Z', 'issue created_at preserved');

        // Merged PR carries a success outcome; recall surfaces it.
        const prHit = (await reqJson('GET', `/search?q=${encodeURIComponent('rate limiting token bucket')}&k=5`, token)).json;
        const pr = prHit.results.find((r) => r.uri === `trace://${DOMAIN}/gh/acme/app/pull/2`);
        assert.ok(pr, 'PR recalled');
        assert.equal(pr.outcome.status, 'success', 'merged PR -> success outcome');

        // "Not planned" issue carries a failure outcome.
        const rustHit = (await reqJson('GET', `/search?q=${encodeURIComponent('rewrite gateway rust')}&k=5`, token)).json;
        const rust = rustHit.results.find((r) => r.uri === `trace://${DOMAIN}/gh/acme/app/issues/3`);
        assert.ok(rust, 'rejected issue recalled');
        assert.equal(rust.outcome.status, 'failure', 'not-planned -> failure outcome');
      });
    } catch (e) {
      throw new Error(e.message + '\n--- server logs ---\n' + logs);
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 300));
      if (!child.killed) child.kill('SIGKILL');
      httpMock.close();
      ghMock.close();
      await seed.query(`DROP TABLE IF EXISTS ${TABLE}`).catch(() => {});
      await seed.end().catch(() => {});
    }
  }
);
