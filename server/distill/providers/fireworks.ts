import { FineTuneProvider, JobResult, SubmitInput } from './types.js';

// Fireworks AI supervised fine-tuning (SFT) provider.
//
// Flow (REST, docs.fireworks.ai):
//   1. POST /v1/accounts/{acct}/datasets            create dataset entry
//   2. POST /v1/accounts/{acct}/datasets/{id}:upload  upload JSONL (multipart)
//   3. POST /v1/accounts/{acct}/supervisedFineTuningJobs  launch SFT job
//   status: GET /v1/accounts/{acct}/supervisedFineTuningJobs/{jobId}
// Dataset is OpenAI-compatible chat JSONL, which is exactly what buildDataset
// produces. Model names are Fireworks resource paths (accounts/.../models/...).

export interface FireworksOptions {
  apiKey: string;
  accountId: string;
  baseUrl?: string;
}

export function normalizeModel(model: string, accountId: string): string {
  if (!model) throw new Error('baseModel is required for Fireworks');
  if (model.startsWith('accounts/')) return model;
  // Base models live under the shared `fireworks` account.
  return `accounts/fireworks/models/${model}`;
}

async function ensureOk(res: any, what: string): Promise<any> {
  if (!res.ok) {
    let body = '';
    try {
      body = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Fireworks ${what} failed: HTTP ${res.status} ${body}`.trim());
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

export class FireworksProvider implements FineTuneProvider {
  name = 'fireworks';
  private base: string;

  constructor(private opts: FireworksOptions) {
    if (!opts.apiKey) throw new Error('FIREWORKS_API_KEY required for the fireworks provider');
    if (!opts.accountId) throw new Error('FIREWORKS_ACCOUNT_ID required for the fireworks provider');
    this.base = `${opts.baseUrl || 'https://api.fireworks.ai'}/v1/accounts/${opts.accountId}`;
  }

  private headers(json = true): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.opts.apiKey}` };
    if (json) h['Content-Type'] = 'application/json';
    return h;
  }

  async submit(input: SubmitInput): Promise<JobResult> {
    const datasetId = `${input.suffix ? input.suffix + '-' : 'carma-'}${Date.now().toString(36)}`;

    // 1) create dataset entry (client supplies exampleCount)
    let res = await fetch(`${this.base}/datasets`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ datasetId, dataset: { userUploaded: {}, exampleCount: String(input.count) } }),
    });
    await ensureOk(res, 'create dataset');

    // 2) upload the JSONL file (multipart form-data; let fetch set the boundary)
    const form = new FormData();
    form.append('file', new Blob([input.datasetJsonl], { type: 'application/jsonl' }), `${datasetId}.jsonl`);
    res = await fetch(`${this.base}/datasets/${datasetId}:upload`, {
      method: 'POST',
      headers: this.headers(false),
      body: form,
    });
    await ensureOk(res, 'upload dataset');

    // 3) launch the supervised fine-tuning job
    const outputModel = `carma-${datasetId}`;
    const jobBody = {
      baseModel: normalizeModel(input.baseModel, this.opts.accountId),
      dataset: `accounts/${this.opts.accountId}/datasets/${datasetId}`,
      outputModel: `accounts/${this.opts.accountId}/models/${outputModel}`,
    };
    res = await fetch(`${this.base}/supervisedFineTuningJobs`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(jobBody),
    });
    const job = await ensureOk(res, 'create job');

    const jobId = job?.name?.split('/').pop() || job?.supervisedFineTuningJobId || outputModel;
    return {
      provider: 'fireworks',
      jobId,
      status: job?.state || 'JOB_STATE_PENDING',
      model: job?.outputModel || jobBody.outputModel,
      datasetId,
    };
  }

  async status(jobId: string): Promise<JobResult> {
    const res = await fetch(`${this.base}/supervisedFineTuningJobs/${jobId}`, {
      headers: this.headers(false),
    });
    const job = await ensureOk(res, 'get job');
    return {
      provider: 'fireworks',
      jobId,
      status: job?.state || job?.status?.code || 'UNKNOWN',
      model: job?.outputModel,
    };
  }
}
