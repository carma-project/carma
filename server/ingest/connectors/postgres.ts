// Postgres/SQL connector: run a read-only query against a source database and
// turn each row into a memory. Lets CARMA pull "all info" out of the systems a
// company already runs (incident records, decision logs, ticket tables, ...).
//
// Source fields:
//   dsn | dsnEnv        connection string (prefer dsnEnv to keep creds out of SOURCES)
//   query              SQL SELECT to run (read-only; you control the shape)
//   ssl                true -> TLS without CA verification (managed PG)
//   columns            { id, title, content, date?, decision? } column-name mapping
//   confidence/importance  salience for the produced memories
import pg from 'pg';
import type { CollectContext, CollectResult } from './index.js';
import type { IngestItem } from '../extract.js';

// Make an arbitrary row id safe for a URI path segment.
function slugId(v: any): string {
  return String(v).trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'row';
}

export async function collectPostgres(source: any, _config: any, ctx: CollectContext): Promise<CollectResult> {
  const trustDomain = ctx.trustDomain;
  const dsn = source.dsnEnv ? process.env[source.dsnEnv] : source.dsn || (source.url && source.url.startsWith('postgres') ? source.url : '');
  if (!dsn) throw new Error(`source ${source.id}: postgres needs dsn or dsnEnv (a connection string)`);
  if (!source.query || typeof source.query !== 'string') throw new Error(`source ${source.id}: postgres needs a "query"`);

  const cols = source.columns || {};
  const idCol = cols.id || 'id';
  const titleCol = cols.title || 'title';
  const contentCol = cols.content || 'content';
  const dateCol = cols.date || null;
  const decisionCol = cols.decision || null;
  const confidence = typeof source.confidence === 'number' ? source.confidence : 0.7;
  const importance = typeof source.importance === 'number' ? source.importance : 0.6;

  const client = new pg.Client({
    connectionString: dsn,
    ssl: source.ssl ? { rejectUnauthorized: false } : undefined,
    statement_timeout: 60000,
  });
  const items: IngestItem[] = [];
  await client.connect();
  try {
    const res = await client.query(source.query);
    for (const row of res.rows) {
      const rawId = row[idCol];
      if (rawId == null) continue;
      const task = row[titleCol] != null ? String(row[titleCol]) : null;
      const content = row[contentCol] != null ? String(row[contentCol]) : null;
      if (!task && !content) continue;
      const uri = `trace://${trustDomain}/${source.id}/${slugId(rawId)}`;
      const input: any = {
        task,
        content,
        boundContext: [`source:${source.id}`, 'kind:postgres'],
        confidence,
        importance,
      };
      if (dateCol && row[dateCol]) {
        const d = new Date(row[dateCol]);
        if (!Number.isNaN(d.getTime())) input.occurredAt = d.toISOString();
      }
      if (decisionCol && row[decisionCol] != null) input.decision = { choice: String(row[decisionCol]) };
      items.push({ uri, trustDomain, type: 'row', input });
    }
  } finally {
    await client.end();
  }
  return { items, outcomes: [], meta: { rows: items.length } };
}
