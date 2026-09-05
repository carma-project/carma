// Native ingestion engine: CARMA pulls a source into its own memory, in-process.
// This is the acquisition counterpart to `dream` (which maintains memory). A
// pluggable connector (see server/ingest/connectors/) turns a source into
// normalized items + derived outcomes; this module owns the common write path —
// signing, tiering, and persistence via storeTrace/recordOutcome directly (no
// HTTP, no capability token, exactly like the consolidation pass). Triggered by
// POST /ingest or the internal scheduler.
import { storeTrace, recordOutcome } from '../ingest.js';
import { getConnector } from './connectors/index.js';
import type { Source } from './sources.js';

export interface RunOptions {
  dryRun?: boolean;
  subject?: string;
  log?: (event: string, detail?: any) => void;
}

// Pull one source into memory. Returns a report; `dryRun` computes counts
// (after collecting from the source) without writing.
export async function runSource(adapter: any, config: any, source: Source, opts: RunOptions = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log || (() => {});
  const subject = opts.subject || 'carma-ingest';
  const startedAt = new Date().toISOString();

  const trustDomain = source.trustDomain || config.trustDomain;
  if (!trustDomain) throw new Error(`source ${source.id}: no trustDomain (set source.trustDomain or TRUST_DOMAIN)`);
  const connector = getConnector(source.type);
  if (!connector) throw new Error(`source ${source.id}: unsupported type "${source.type}"`);
  if (!dryRun && !config.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing ingested memory');

  const { items, outcomes = [], meta } = await connector(source, config, { trustDomain, subject, dryRun, log });

  const report: any = {
    sourceId: source.id,
    type: source.type,
    trustDomain,
    dryRun,
    startedAt,
    meta: meta || {},
    stored: { count: 0, failed: 0 },
    outcomes: { count: 0 },
    byType: {},
  };

  // Bulk acquisition skips per-write near-duplicate review (that would flood the
  // queue); dreaming does dedup in batch afterwards. Tiering still applies, so
  // curated docs/specs enter 'consolidated' and episodic items enter 'working'.
  const policy = {
    consolidate: false,
    tierMinConfidence: config.tierConsolidateMinConfidence,
    tierMinImportance: config.tierConsolidateMinImportance,
  };
  const ctxBase = { trustDomain, subject, privateKeyPem: config.privateKeyPem };
  const stored = new Set<string>();

  for (const it of items) {
    report.byType[it.type] = (report.byType[it.type] || 0) + 1;
    if (dryRun) {
      report.stored.count++;
      stored.add(it.uri);
      continue;
    }
    try {
      await storeTrace(adapter, { uri: it.uri, ...ctxBase }, it.input, policy);
      report.stored.count++;
      stored.add(it.uri);
    } catch (e: any) {
      report.stored.failed++;
      log('ingest_item_failed', { source: source.id, uri: it.uri, error: e.message });
    }
  }

  if (!dryRun) {
    for (const o of outcomes) {
      if (!stored.has(o.decisionUri)) continue;
      try {
        await recordOutcome(adapter, ctxBase, {
          decisionUri: o.decisionUri,
          status: o.status,
          score: o.score,
          evidence: o.evidence,
        });
        report.outcomes.count++;
      } catch (e: any) {
        log('ingest_outcome_failed', { source: source.id, uri: o.decisionUri, error: e.message });
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
