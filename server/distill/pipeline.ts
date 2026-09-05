import { getFineTuneProvider } from './providers/index.js';
import { buildDataset } from './dataset.js';
import { signEnvelope } from '../middleware/jws.js';
import { validateEnvelope } from '../middleware/guardrails.js';
import { embed, toVectorLiteral } from '../embedding.js';

export interface DistillParams {
  trustDomain: string;
  kind?: string | null;
  since?: string | null;
  limit?: number;
  format?: 'chat' | 'completion';
  baseModel?: string;
  suffix?: string;
  subject?: string;
}

// Select stored reasoning/memory -> build a training dataset -> submit a
// fine-tune job to the configured provider -> persist a signed, addressable
// dataset manifest (memory://.../dataset/...) capturing full provenance.
export async function runDistillation(adapter: any, config: any, params: DistillParams) {
  const trustDomain = params.trustDomain;
  if (!trustDomain) throw new Error('trustDomain is required for distillation');
  if (!config.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing the dataset manifest');

  const kind = params.kind ?? 'trace';
  const limit = Math.min(params.limit ?? config.distillMaxExamples, config.distillMaxExamples);
  const rows = await adapter.listEnvelopes({ trustDomain, kind, since: params.since ?? null, limit });

  const ds = buildDataset(rows, {
    format: params.format || 'chat',
    system: config.distillSystemPrompt || null,
  });
  if (ds.count === 0) {
    throw new Error('No training examples matched the selection (need traces with both task and content)');
  }

  const baseModel = params.baseModel || config.fireworksBaseModel;
  const provider = getFineTuneProvider(config);
  const job = await provider.submit({
    datasetJsonl: ds.jsonl,
    count: ds.count,
    baseModel,
    suffix: params.suffix,
    meta: { trustDomain, kind },
  });

  const now = new Date().toISOString();
  const uri = `memory://${trustDomain}/dataset/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const manifest: any = {
    '@context': 'https://json-am.org/context/v0.1',
    id: uri,
    type: 'Dataset',
    uriScheme: 'memory',
    trustDomain,
    version: '0.1.2-draft',
    issuedAt: now,
    provenance: {
      createdBy: params.subject || 'carma',
      createdAt: now,
      sourceUris: ds.includedUris,
    },
    distillation: {
      kind,
      format: ds.format,
      examples: ds.count,
      skipped: ds.skipped,
      provider: job.provider,
      baseModel,
      jobId: job.jobId,
      status: job.status,
      model: job.model || null,
    },
  };
  manifest.signature = await signEnvelope(manifest, config.privateKeyPem);
  validateEnvelope(manifest);

  const summary = `training dataset ${kind} ${ds.count} examples via ${job.provider} base ${baseModel} model ${job.model || ''}`;
  await adapter.store({
    uri,
    kind: 'dataset',
    trustDomain,
    envelope: manifest,
    signature: manifest.signature,
    content: summary,
    embedding: toVectorLiteral(await embed(summary)),
  });

  return {
    datasetUri: uri,
    examples: ds.count,
    skipped: ds.skipped,
    provider: job.provider,
    baseModel,
    jobId: job.jobId,
    status: job.status,
    model: job.model || null,
  };
}

export async function fineTuneStatus(config: any, jobId: string) {
  const provider = getFineTuneProvider(config);
  return provider.status(jobId);
}
