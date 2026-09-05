import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { PostgresAdapter } from '../adapters/postgres.js';
import { storeTrace, newTraceUri, recordOutcome, retractMemory } from '../server/ingest.js';
import { localEmbed, toVectorLiteral } from '../server/embedding.js';
import { runDistillation } from '../server/distill/pipeline.js';
import os from 'os';
import { readFileSync } from 'fs';

const DB = process.env.DATABASE_URL;

test(
  'RAG ingest + semantic search over Postgres/pgvector',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const adapter = new PostgresAdapter(DB);
    try {
      // Unique domain per run so the assertions are isolated from prior rows.
      const dom = 'itest-' + Date.now();
      const dbTrace = newTraceUri(dom);
      const weatherTrace = newTraceUri(dom);
      await storeTrace(
        adapter,
        { uri: dbTrace, trustDomain: dom, subject: 'test', privateKeyPem: pkcs8 },
        { task: 'configure database', content: 'set the postgres connection string DATABASE_URL and run migrations' }
      );
      await storeTrace(
        adapter,
        { uri: weatherTrace, trustDomain: dom, subject: 'test', privateKeyPem: pkcs8 },
        { task: 'weather note', content: 'today the weather is sunny and warm outside' }
      );

      // The stored envelope is signed and resolvable by its pointer.
      const row = await adapter.resolve(dbTrace);
      assert.ok(row, 'trace should resolve');
      assert.equal(row.envelope.type, 'ATIR');
      assert.ok(row.envelope.signature, 'envelope should carry a JWS signature');

      // Semantic search returns the DB-related trace ahead of the weather one.
      const embedding = toVectorLiteral(localEmbed('database connection settings'));
      const results = await adapter.search({ embedding, k: 5, trustDomain: dom });
      assert.ok(results.length >= 2);
      assert.equal(results[0].uri, dbTrace);
      assert.ok(Number(results[0].score) >= Number(results[results.length - 1].score));

      // Append-only audit trail is writable and the table is reported ready.
      const chk = await adapter.check();
      assert.equal(chk.auditReady, true);
      await adapter.audit({ actor: 'itest', action: 'read', uri: dbTrace, trustDomain: dom, result: 'allow', requestId: 'r-' + dom });
      const c = await adapter.query('SELECT count(*)::int AS n FROM audit_log WHERE request_id = $1', ['r-' + dom]);
      assert.equal(c.rows[0].n, 1);
    } finally {
      await adapter.close();
    }
  }
);

test(
  'Distillation pipeline: traces -> dataset -> local fine-tune -> signed manifest',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const adapter = new PostgresAdapter(DB);
    try {
      const dom = 'dtest-' + Date.now();
      for (const [task, content] of [
        ['scan host', 'ran nmap and found an unauthenticated redis on 6379'],
        ['triage finding', 'unauth redis allows RCE via config set dir + module load'],
        ['recommend fix', 'require AUTH, bind to localhost, and firewall port 6379'],
      ]) {
        await storeTrace(adapter, { uri: newTraceUri(dom), trustDomain: dom, subject: 'test', privateKeyPem: pkcs8 }, { task, content });
      }

      const outputDir = os.tmpdir() + '/carma-distill-e2e-' + Date.now();
      const config = {
        privateKeyPem: pkcs8,
        finetuneProvider: 'local',
        distillOutputDir: outputDir,
        distillMaxExamples: 50000,
        distillSystemPrompt: 'You are a penetration testing assistant.',
        fireworksBaseModel: 'accounts/fireworks/models/llama-v3p1-8b-instruct',
      };
      const result = await runDistillation(adapter, config, { trustDomain: dom, kind: 'trace', subject: 'tester' });

      assert.equal(result.examples, 3);
      assert.equal(result.provider, 'local');
      assert.equal(result.status, 'succeeded');
      assert.ok(result.datasetUri.startsWith(`memory://${dom}/dataset/`));

      // The manifest is a signed, resolvable JSON-AM envelope with provenance.
      const row = await adapter.resolve(result.datasetUri);
      assert.ok(row && row.envelope);
      assert.equal(row.envelope.type, 'Dataset');
      assert.ok(row.envelope.signature);
      assert.equal(row.envelope.distillation.examples, 3);
      assert.equal(row.envelope.provenance.sourceUris.length, 3);

      // The dataset file the local provider wrote is valid chat JSONL.
      const files = readFileSync(outputDir + '/' + result.jobId + '.jsonl', 'utf8').trim().split('\n');
      assert.equal(files.length, 3);
      const ex = JSON.parse(files[0]);
      assert.equal(ex.messages[0].role, 'system');
      assert.equal(ex.messages[1].role, 'user');
      assert.equal(ex.messages[2].role, 'assistant');
    } finally {
      await adapter.close();
    }
  }
);

test(
  'Precedent recall: outcome-weighted ranking, supersession, retraction, outcome record',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    const adapter = new PostgresAdapter(DB);
    const q = toVectorLiteral(localEmbed('exploit an unauthenticated redis instance for rce'));
    try {
      // --- Outcome-weighted ranking: two equally-similar decisions, opposite outcomes.
      const dom = 'recall-' + Date.now();
      const text = 'exploit unauthenticated redis on 6379 via module load for RCE';
      const okUri = newTraceUri(dom);
      const badUri = newTraceUri(dom);
      // success stored first (older); failure stored second (newer) so recency
      // favors the failure — outcome weighting must still surface success first.
      await storeTrace(adapter, { uri: okUri, trustDomain: dom, subject: 't', privateKeyPem: pkcs8 },
        { task: 'exploit redis', content: text, decision: { choice: 'module load RCE' }, outcome: { status: 'success' } });
      await storeTrace(adapter, { uri: badUri, trustDomain: dom, subject: 't', privateKeyPem: pkcs8 },
        { task: 'exploit redis', content: text, decision: { choice: 'module load RCE' }, outcome: { status: 'failure' } });

      const ranked = await adapter.search({ embedding: q, k: 5, trustDomain: dom });
      assert.equal(ranked[0].uri, okUri, 'successful precedent should rank first');
      assert.equal(ranked[0].outcome_status, 'success');
      assert.ok(Number(ranked[0].score) > Number(ranked[1].score));

      // --- Supersession: a revision replaces the prior version in recall.
      const supDom = 'sup-' + Date.now();
      const v1 = newTraceUri(supDom);
      await storeTrace(adapter, { uri: v1, trustDomain: supDom, subject: 't', privateKeyPem: pkcs8 },
        { task: 'redis fix', content: 'recommend disabling redis entirely' });
      const v2 = newTraceUri(supDom);
      await storeTrace(adapter, { uri: v2, trustDomain: supDom, subject: 't', privateKeyPem: pkcs8 },
        { task: 'redis fix', content: 'recommend requiring AUTH and firewalling 6379', supersedes: v1 });

      const supHits = await adapter.search({ embedding: toVectorLiteral(localEmbed('how to fix redis')), k: 10, trustDomain: supDom });
      const supUris = supHits.map((r) => r.uri);
      assert.ok(supUris.includes(v2), 'head revision is recalled');
      assert.ok(!supUris.includes(v1), 'superseded version is excluded from recall');
      const oldRow = await adapter.query('SELECT status, superseded_by FROM agent_memory WHERE uri=$1', [v1]);
      assert.equal(oldRow.rows[0].status, 'superseded');
      assert.equal(oldRow.rows[0].superseded_by, v2);
      // The new envelope records the backward lineage link.
      const v2env = await adapter.resolve(v2);
      assert.equal(v2env.envelope.lineage.supersedes, v1);

      // --- Retraction: excluded from recall, preserved in the store.
      const retDom = 'ret-' + Date.now();
      const r1 = newTraceUri(retDom);
      await storeTrace(adapter, { uri: r1, trustDomain: retDom, subject: 't', privateKeyPem: pkcs8 },
        { task: 'finding', content: 'critical RCE on host X' });
      await retractMemory(adapter, { trustDomain: retDom }, r1);
      const retHits = await adapter.search({ embedding: toVectorLiteral(localEmbed('critical RCE host')), k: 5, trustDomain: retDom });
      assert.ok(!retHits.map((r) => r.uri).includes(r1), 'retracted memory is excluded from recall');
      const retRow = await adapter.query('SELECT status FROM agent_memory WHERE uri=$1', [r1]);
      assert.equal(retRow.rows[0].status, 'retracted');
      assert.ok(await adapter.resolve(r1), 'retracted memory still resolvable for audit');

      // --- recordOutcome: signed Outcome envelope + denormalized columns for recall.
      const oDom = 'outcome-' + Date.now();
      const dUri = newTraceUri(oDom);
      await storeTrace(adapter, { uri: dUri, trustDomain: oDom, subject: 't', privateKeyPem: pkcs8 },
        { task: 'try payload', content: 'attempt SSTI on the profile field' });
      const rec = await recordOutcome(adapter, { trustDomain: oDom, subject: 't', privateKeyPem: pkcs8 },
        { decisionUri: dUri, status: 'success', score: 0.9, evidence: 'got code execution' });
      const dRow = await adapter.query('SELECT outcome_status, outcome_score, outcome_uri FROM agent_memory WHERE uri=$1', [dUri]);
      assert.equal(dRow.rows[0].outcome_status, 'success');
      assert.ok(Number(dRow.rows[0].outcome_score) > 0.8);
      assert.equal(dRow.rows[0].outcome_uri, rec.outcomeUri);
      const oEnv = await adapter.resolve(rec.outcomeUri);
      assert.equal(oEnv.envelope.type, 'Outcome');
      assert.equal(oEnv.envelope.decisionUri, dUri);
      assert.ok(oEnv.envelope.signature, 'outcome envelope is signed');
    } finally {
      await adapter.close();
    }
  }
);
