import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { PostgresAdapter } from '../adapters/postgres.js';
import { storeTrace, newTraceUri, recordOutcome } from '../server/ingest.js';
import { runDream } from '../server/consolidate/dream.js';
import { LocalMemoryModel } from '../server/memory/model.js';

const DB = process.env.DATABASE_URL;

// Fixed dream config for deterministic tests.
const CFG = {
  dreamDecayDays: 30,
  dreamMinReinforceKeep: 1,
  dreamSimThreshold: 0.92,
  dreamMinClusterSize: 3,
  dreamMaxReviews: 100,
  dreamMaxAbstractions: 50,
  reinforcePromoteAt: 3,
};

async function pk() {
  const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  return exportPKCS8(privateKey);
}

// Push a memory's created_at into the past so decay/age logic can be exercised.
async function ageDays(adapter, uri, days) {
  await adapter.query(`UPDATE agent_memory SET created_at = now() - ($2 * interval '1 day') WHERE uri = $1`, [uri, days]);
}
async function statusOf(adapter, uri) {
  const r = await adapter.query('SELECT status FROM agent_memory WHERE uri = $1', [uri]);
  return r.rows[0]?.status;
}
async function tierOf(adapter, uri) {
  const r = await adapter.query('SELECT tier FROM agent_memory WHERE uri = $1', [uri]);
  return r.rows[0]?.tier;
}

test(
  'dream: decay archives stale unproven working memories; recompute promotes proven ones',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const priv = await pk();
    const adapter = new PostgresAdapter(DB);
    const model = new LocalMemoryModel();
    try {
      const dom = 'dream-decay-' + Date.now();
      const ctx = (uri) => ({ uri, trustDomain: dom, subject: 'test', privateKeyPem: priv });
      const noConsolidate = { consolidate: false };

      // Stale, unproven, unreinforced working memory -> should be archived.
      const stale = newTraceUri(dom);
      await storeTrace(adapter, ctx(stale), { task: 'note a', content: 'an old scratch note about temporary config', confidence: 0.2, importance: 0.2 }, noConsolidate);
      await ageDays(adapter, stale, 60);

      // Old working memory that proved out (success) -> kept + promoted.
      const proven = newTraceUri(dom);
      await storeTrace(adapter, ctx(proven), { task: 'note b', content: 'chose retry-with-backoff for the flaky upstream', decision: { choice: 'retry with backoff' }, confidence: 0.2, importance: 0.2 }, noConsolidate);
      await ageDays(adapter, proven, 60);
      await recordOutcome(adapter, { trustDomain: dom, subject: 'test', privateKeyPem: priv }, { decisionUri: proven, status: 'success', score: 0.9 });

      // Old but human-pinned -> exempt from decay.
      const pinned = newTraceUri(dom);
      await storeTrace(adapter, ctx(pinned), { task: 'note c', content: 'keep this rule about secret rotation', confidence: 0.2, importance: 0.2 }, noConsolidate);
      await ageDays(adapter, pinned, 60);
      await adapter.setTier(pinned, 'pinned');

      // Recent working memory -> too fresh to decay.
      const fresh = newTraceUri(dom);
      await storeTrace(adapter, ctx(fresh), { task: 'note d', content: 'a fresh unrelated observation', confidence: 0.2, importance: 0.2 }, noConsolidate);

      const report = await runDream(adapter, model, CFG, { trustDomain: dom, privateKeyPem: priv, steps: ['decay', 'promote'] });

      assert.equal(await statusOf(adapter, stale), 'archived', 'stale unproven working memory is archived');
      assert.ok(report.decayed.uris.includes(stale));

      assert.equal(await statusOf(adapter, proven), 'active', 'proven memory is not archived');
      assert.equal(await tierOf(adapter, proven), 'consolidated', 'proven working memory is promoted');
      assert.ok(report.promoted.uris.includes(proven));

      assert.equal(await statusOf(adapter, pinned), 'active');
      assert.equal(await tierOf(adapter, pinned), 'pinned', 'pinned memory untouched');

      assert.equal(await statusOf(adapter, fresh), 'active', 'fresh memory not decayed');
    } finally {
      await adapter.close();
    }
  }
);

test(
  'dream: batch near-duplicate detection enqueues a review with a model-proposed resolution (idempotent)',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const priv = await pk();
    const adapter = new PostgresAdapter(DB);
    const model = new LocalMemoryModel();
    try {
      const dom = 'dream-dedup-' + Date.now();
      const ctx = (uri) => ({ uri, trustDomain: dom, subject: 'test', privateKeyPem: priv });
      const content = 'use mutual TLS between internal services and rotate certs via SPIFFE';
      // consolidate:false so on-write does NOT enqueue — the dream pass must.
      const a = newTraceUri(dom);
      const b = newTraceUri(dom);
      await storeTrace(adapter, ctx(a), { task: 'auth', content, confidence: 0.9 }, { consolidate: false });
      await storeTrace(adapter, ctx(b), { task: 'auth', content, confidence: 0.9 }, { consolidate: false });

      assert.equal(await adapter.pendingReviewCount(dom), 0, 'no on-write reviews');

      const report = await runDream(adapter, model, CFG, { trustDomain: dom, privateKeyPem: priv, steps: ['dedup'] });
      assert.equal(report.reviews.count, 1, 'one near-duplicate review raised');
      const pair = report.reviews.pairs[0];
      assert.ok(['merge', 'keep_separate', 'reject'].includes(pair.proposed), 'carries a proposed resolution');
      assert.equal(pair.proposed, 'merge', 'identical content -> proposed merge');
      assert.ok(pair.reviewId != null);

      const reviews = await adapter.listReviews({ trustDomain: dom, status: 'pending' });
      assert.equal(reviews.length, 1);
      assert.equal(reviews[0].source, 'dream');
      assert.equal(reviews[0].proposed_resolution, 'merge');
      assert.ok(reviews[0].proposed_reason);

      // Idempotent: a second pass must not re-raise the same pair.
      const report2 = await runDream(adapter, model, CFG, { trustDomain: dom, privateKeyPem: priv, steps: ['dedup'] });
      assert.equal(report2.reviews.count, 0, 'existing pending review is not duplicated');
      assert.equal(await adapter.pendingReviewCount(dom), 1);
    } finally {
      await adapter.close();
    }
  }
);

test(
  'dream: episodic->semantic abstraction creates a recall-indexed principle (idempotent)',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const priv = await pk();
    const adapter = new PostgresAdapter(DB);
    const model = new LocalMemoryModel();
    try {
      const dom = 'dream-abstract-' + Date.now();
      const ctx = (uri) => ({ uri, trustDomain: dom, subject: 'test', privateKeyPem: priv });
      const nc = { consolidate: false };
      const task = 'deploy strategy for stateless services';

      const d1 = newTraceUri(dom);
      const d2 = newTraceUri(dom);
      const d3 = newTraceUri(dom);
      await storeTrace(adapter, ctx(d1), { task, content: 'blue-green avoided downtime last release', decision: { choice: 'blue-green' }, confidence: 0.6 }, nc);
      await storeTrace(adapter, ctx(d2), { task, content: 'blue-green again gave a clean rollback path', decision: { choice: 'blue-green' }, confidence: 0.6 }, nc);
      await storeTrace(adapter, ctx(d3), { task, content: 'canary was slow to catch a regression', decision: { choice: 'canary' }, confidence: 0.6 }, nc);
      await recordOutcome(adapter, { trustDomain: dom, subject: 'test', privateKeyPem: priv }, { decisionUri: d1, status: 'success', score: 0.9 });
      await recordOutcome(adapter, { trustDomain: dom, subject: 'test', privateKeyPem: priv }, { decisionUri: d2, status: 'success', score: 0.9 });

      const report = await runDream(adapter, model, CFG, { trustDomain: dom, privateKeyPem: priv, steps: ['abstract'] });
      assert.equal(report.abstractions.count, 1, 'one semantic memory abstracted');
      const created = report.abstractions.created[0];
      assert.equal(created.supportCount, 3);
      assert.equal(created.principle, 'blue-green', 'principle = most successful/frequent choice');

      const sem = await adapter.resolve(created.uri);
      assert.ok(sem, 'semantic memory is stored');
      assert.equal(sem.envelope.type, 'Semantic');
      assert.equal(sem.envelope.semantic.derivedFrom.length, 3, 'links back to its source decisions');
      assert.ok(sem.envelope.signature, 'semantic envelope is signed');

      // It is recall-indexed (findable by semantic search).
      const { localEmbed, toVectorLiteral } = await import('../server/embedding.js');
      const hits = await adapter.search({ embedding: toVectorLiteral(localEmbed('how should we deploy stateless services')), k: 5, trustDomain: dom, kind: 'semantic' });
      assert.ok(hits.some((h) => h.uri === created.uri), 'semantic memory is retrievable');

      // Idempotent: a second pass does not create a duplicate principle.
      const report2 = await runDream(adapter, model, CFG, { trustDomain: dom, privateKeyPem: priv, steps: ['abstract'] });
      assert.equal(report2.abstractions.count, 0, 'task already abstracted');
    } finally {
      await adapter.close();
    }
  }
);

test(
  'dream: dry-run reports intended changes without mutating',
  { skip: DB ? false : 'DATABASE_URL not set' },
  async () => {
    const priv = await pk();
    const adapter = new PostgresAdapter(DB);
    const model = new LocalMemoryModel();
    try {
      const dom = 'dream-dry-' + Date.now();
      const ctx = (uri) => ({ uri, trustDomain: dom, subject: 'test', privateKeyPem: priv });
      const nc = { consolidate: false };
      const task = 'incident comms playbook';

      const stale = newTraceUri(dom);
      await storeTrace(adapter, ctx(stale), { task: 'scratch', content: 'temporary throwaway note', confidence: 0.2, importance: 0.2 }, nc);
      await ageDays(adapter, stale, 90);

      for (let i = 0; i < 3; i++) {
        const u = newTraceUri(dom);
        await storeTrace(adapter, ctx(u), { task, content: `post a status page update quickly (${i})`, decision: { choice: 'status page first' }, confidence: 0.5 }, nc);
      }

      const report = await runDream(adapter, model, CFG, { trustDomain: dom, privateKeyPem: priv, dryRun: true });
      assert.ok(report.dryRun);
      assert.ok(report.decayed.count >= 1, 'reports a decay candidate');
      assert.equal(report.abstractions.count, 1, 'reports an abstraction candidate');

      // Nothing actually changed.
      assert.equal(await statusOf(adapter, stale), 'active', 'dry-run did not archive');
      const sem = await adapter.listActiveMemories({ trustDomain: dom, kind: 'semantic' });
      assert.equal(sem.length, 0, 'dry-run created no semantic memory');
    } finally {
      await adapter.close();
    }
  }
);
