// HTTP/API connector: fetch a JSON endpoint that returns a list of records and
// turn each into a memory. Generic bridge to any internal service or SaaS with a
// JSON API (wikis, runbooks, CRMs, chat exports, ...).
//
// Source fields:
//   url                the endpoint to GET
//   headers            extra request headers (object)
//   tokenEnv           env var -> Authorization: Bearer <token>
//   itemsPath          dot-path to the array in the response (default: the root)
//   fields             { id, title, content, date?, decision? } field-name mapping
//   confidence/importance  salience for the produced memories
import type { CollectContext, CollectResult } from './index.js';
import type { IngestItem } from '../extract.js';

function getPath(obj: any, dotted: string): any {
  return dotted.split('.').reduce((o, k) => (o == null ? o : o[k]), obj);
}
function slugId(v: any): string {
  return String(v).trim().replace(/[^A-Za-z0-9._:-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'record';
}

export async function collectHttp(source: any, _config: any, ctx: CollectContext): Promise<CollectResult> {
  const trustDomain = ctx.trustDomain;
  if (!source.url) throw new Error(`source ${source.id}: http needs a url`);
  const headers: Record<string, string> = { accept: 'application/json', ...(source.headers || {}) };
  if (source.tokenEnv && process.env[source.tokenEnv]) headers['authorization'] = `Bearer ${process.env[source.tokenEnv]}`;

  const res = await fetch(source.url, { headers });
  if (!res.ok) throw new Error(`source ${source.id}: HTTP ${res.status} from ${source.url}`);
  const data = await res.json();
  const arr = source.itemsPath ? getPath(data, source.itemsPath) : data;
  if (!Array.isArray(arr)) {
    throw new Error(`source ${source.id}: expected a JSON array${source.itemsPath ? ` at "${source.itemsPath}"` : ''}`);
  }

  const f = source.fields || {};
  const idF = f.id || 'id';
  const titleF = f.title || 'title';
  const contentF = f.content || 'body';
  const dateF = f.date || null;
  const decisionF = f.decision || null;
  const confidence = typeof source.confidence === 'number' ? source.confidence : 0.65;
  const importance = typeof source.importance === 'number' ? source.importance : 0.6;

  const items: IngestItem[] = [];
  for (const rec of arr) {
    if (!rec || typeof rec !== 'object') continue;
    const rawId = rec[idF];
    if (rawId == null) continue;
    const task = rec[titleF] != null ? String(rec[titleF]) : null;
    const content = rec[contentF] != null ? String(rec[contentF]) : null;
    if (!task && !content) continue;
    const uri = `trace://${trustDomain}/${source.id}/${slugId(rawId)}`;
    const input: any = {
      task,
      content,
      boundContext: [`source:${source.id}`, 'kind:http'],
      confidence,
      importance,
    };
    if (dateF && rec[dateF]) {
      const d = new Date(rec[dateF]);
      if (!Number.isNaN(d.getTime())) input.occurredAt = d.toISOString();
    }
    if (decisionF && rec[decisionF] != null) input.decision = { choice: String(rec[decisionF]) };
    items.push({ uri, trustDomain, type: 'record', input });
  }
  return { items, outcomes: [], meta: { records: items.length } };
}
