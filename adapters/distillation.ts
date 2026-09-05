import { PostgresAdapter } from './postgres.js';
import { buildDataset } from '../server/distill/dataset.js';

// Thin export helper over the current schema. Streams stored envelopes as
// OpenAI-compatible chat JSONL lines (see server/distill/dataset.ts). For the
// full pipeline (dataset -> provider -> signed manifest) use
// server/distill/pipeline.ts.
export class DistillationAdapter {
  constructor(private store: PostgresAdapter) {}

  async *exportTraces(opts: { trustDomain?: string; kind?: string; limit?: number } = {}) {
    const rows = await this.store.listEnvelopes({
      trustDomain: opts.trustDomain ?? null,
      kind: opts.kind ?? 'trace',
      limit: opts.limit ?? 10000,
    });
    const { jsonl } = buildDataset(rows, { format: 'chat' });
    for (const line of jsonl.split('\n')) {
      if (line) yield line;
    }
  }
}
