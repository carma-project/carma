import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportPKCS8 } from 'jose';
import { PostgresAdapter } from '../adapters/postgres.js';
import { storeTrace, newTraceUri } from '../server/ingest.js';
import { localEmbed, toVectorLiteral } from '../server/embedding.js';

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
    } finally {
      await adapter.close();
    }
  }
);
