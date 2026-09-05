// Native ingestion: CARMA pulls a configured git source into its own memory
// in-process (POST /ingest), preserving commit chronology and recording revert
// outcomes — the same result as the external CLIs, but driven by the server.
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
const DOMAIN = 'internal-ingest-' + Date.now();
const DOMAIN_BOOT = 'boot-ingest-' + Date.now();
const PORT = 7580 + (process.pid % 100);
const PORT_BOOT = 7620 + (process.pid % 100);

function reqJson(method, p, token, body, port = PORT) {
  const payload = body ? JSON.stringify(body) : null;
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, (res) => {
      let b = '';
      res.on('data', (c) => (b += c));
      res.on('end', () => resolve({ status: res.statusCode, json: b ? JSON.parse(b) : null }));
    });
    r.on('error', reject);
    if (payload) r.end(payload);
    else r.end();
  });
}
async function waitHealth(port = PORT) {
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
  throw new Error('server not healthy');
}

// A repo with both curated docs (markdown) and reasoning history (commits+revert).
function buildRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'carma-src-'));
  const g = (args, date) =>
    execFileSync('git', ['-C', dir, ...args], {
      stdio: ['ignore', 'ignore', 'ignore'],
      env: date ? { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } : process.env,
    });
  g(['init', '-q']);
  g(['config', 'user.email', 't@t.co']);
  g(['config', 'user.name', 'Tester']);

  fs.mkdirSync(path.join(dir, 'docs'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'docs', 'handbook.md'),
    '# Onboarding Handbook\n\nNew engineers set up the Cyberorbit staging environment before touching production.\n'
  );
  fs.mkdirSync(path.join(dir, 'decisions'), { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'decisions', 'adr-001-storage.md'),
    '# Use Postgres with pgvector for memory storage\n\nWe chose Postgres pgvector over a dedicated vector database for operational simplicity.\n'
  );
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
  'native ingestion: POST /ingest pulls a git source (docs + history) into memory in-process',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const spki = await exportSPKI(publicKey);
    const pkcs8 = await exportPKCS8(privateKey);
    const { dir, revSha } = buildRepo();

    const sources = [{ id: 'app', type: 'git', url: dir, repo: 'acme/app' }];
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

      // Dry run first: reports counts, writes nothing.
      const dry = await reqJson('POST', '/ingest', token, { dryRun: true });
      assert.equal(dry.status, 200, 'dry-run ok');
      assert.equal(dry.json.dryRun, true);
      assert.ok(dry.json.reports[0].docs.count >= 2, 'dry-run counts docs');
      assert.ok(dry.json.reports[0].commits.count >= 3, 'dry-run counts commits');

      // Real ingest: docs + commits + revert outcome, all in-process.
      const run = await reqJson('POST', '/ingest', token, {});
      assert.equal(run.status, 200, 'ingest ok');
      const rep = run.json.reports[0];
      assert.equal(rep.sourceId, 'app');
      assert.equal(rep.repo, 'acme/app');
      assert.ok(rep.docs.count >= 2, `docs stored (${rep.docs.count})`);
      assert.equal(rep.docs.failed, 0, 'no doc failures');
      assert.ok(rep.commits.count >= 3, `commits stored (${rep.commits.count})`);
      assert.equal(rep.outcomes.count, 1, 'revert recorded one failure outcome');

      // Curated doc is recallable and lives under the deterministic repo URI.
      const docHit = (await reqJson('GET', `/search?q=${encodeURIComponent('onboarding staging environment')}&k=5`, token)).json;
      const hb = docHit.results.find((r) => r.uri === `trace://${DOMAIN}/gh/acme/app/docs/handbook.md`);
      assert.ok(hb, 'handbook doc recalled at deterministic uri');

      // Commit history preserved its real date (recency decay reflects chronology).
      const authHit = (await reqJson('GET', `/search?q=${encodeURIComponent('authentication jwt keys')}&k=5`, token)).json;
      const auth = authHit.results.find((r) => /HS256/.test(r.reasoning || ''));
      assert.ok(auth, 'auth commit recalled');
      const env = (await reqJson('GET', `/resolve?uri=${encodeURIComponent(auth.uri)}`, token)).json;
      assert.equal(env.envelope.issuedAt, '2023-02-01T10:00:00.000Z', 'issuedAt = commit author date');

      // Revert produced a failure outcome on the commit it undid.
      const cacheUri = `trace://${DOMAIN}/gh/acme/app/commit/${revSha}`;
      const cacheRecall = (await reqJson('GET', `/search?q=${encodeURIComponent('cache recall results')}&k=5`, token)).json;
      const cacheHit = cacheRecall.results.find((r) => r.uri === cacheUri);
      assert.ok(cacheHit, 'cache commit recalled');
      assert.equal(cacheHit.outcome.status, 'failure', 'revert produced a failure outcome');

      // Status surfaces the source and its last run.
      const status = (await reqJson('GET', '/api/status', token)).json;
      assert.ok(Array.isArray(status.ingest.sources), 'status lists sources');
      const src = status.ingest.sources.find((s) => s.id === 'app');
      assert.ok(src && src.lastRunAt, 'source shows lastRunAt');
      assert.ok(src.lastResult && src.lastResult.commits.count >= 3, 'lastResult has counts');

      // Idempotent: re-running upserts in place (deterministic URIs), no errors.
      const again = await reqJson('POST', '/ingest', token, { sourceId: 'app' });
      assert.equal(again.status, 200, 're-ingest ok');
      assert.equal(again.json.reports[0].docs.failed, 0);
      assert.equal(again.json.reports[0].commits.failed, 0);

      // Unknown source id is a clean 404.
      const bad = await reqJson('POST', '/ingest', token, { sourceId: 'nope' });
      assert.equal(bad.status, 404, 'unknown source id -> 404');
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

test(
  'native ingestion: INGEST_ON_BOOT pulls sources automatically at startup (no external trigger)',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const spki = await exportSPKI(publicKey);
    const pkcs8 = await exportPKCS8(privateKey);
    const { dir } = buildRepo();

    const sources = [{ id: 'app', type: 'git', url: dir, repo: 'acme/app' }];
    const child = spawn('node', ['--import', 'tsx', 'server/index.js'], {
      env: {
        ...process.env,
        PORT: String(PORT_BOOT),
        TRUST_DOMAIN: DOMAIN_BOOT,
        PUBLIC_KEY: spki,
        PRIVATE_KEY: pkcs8,
        DATABASE_URL: DB,
        SOURCES: JSON.stringify(sources),
        INGEST_ON_BOOT: 'true',
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
      { domains: [`trust://${DOMAIN_BOOT}`], actions: ['read', 'write'], subject: 'test', ttl: '10m' },
      pkcs8
    );

    try {
      await waitHealth(PORT_BOOT);

      // The boot backfill runs asynchronously ~1.5s after listen; poll status
      // until the source reports a completed run.
      let ran = null;
      for (let i = 0; i < 60; i++) {
        const status = (await reqJson('GET', '/api/status', token, null, PORT_BOOT)).json;
        const src = status.ingest.sources.find((s) => s.id === 'app');
        if (src && src.lastRunAt && src.lastResult && src.lastResult.commits.count >= 3) {
          ran = src;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      assert.ok(ran, 'source auto-ingested at boot without an external trigger');
      assert.ok(ran.lastResult.docs.count >= 2, 'boot ingest stored docs');

      // And the memory is immediately recallable.
      const hit = (await reqJson('GET', `/search?q=${encodeURIComponent('onboarding staging environment')}&k=5`, token, null, PORT_BOOT)).json;
      assert.ok(hit.results.find((r) => r.uri === `trace://${DOMAIN_BOOT}/gh/acme/app/docs/handbook.md`), 'boot-ingested doc recalled');
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
