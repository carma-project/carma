import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { buildDataset } from '../server/distill/dataset.js';
import { getFineTuneProvider, LocalProvider, FireworksProvider } from '../server/distill/providers/index.js';
import { normalizeModel } from '../server/distill/providers/fireworks.js';

const rows = [
  { uri: 'trace://acme/1', envelope: { id: 'trace://acme/1', task: 'scan host', content: 'ran nmap, found open redis' } },
  { uri: 'trace://acme/2', envelope: { id: 'trace://acme/2', task: 'triage', content: 'redis is unauth -> RCE risk' } },
  { uri: 'trace://acme/3', envelope: { id: 'trace://acme/3', task: '', content: 'no task, should be skipped' } },
];

test('buildDataset: chat JSONL, skips incomplete rows', () => {
  const ds = buildDataset(rows, { format: 'chat', system: 'You are a security analyst.' });
  assert.equal(ds.count, 2);
  assert.equal(ds.skipped, 1);
  assert.deepEqual(ds.includedUris, ['trace://acme/1', 'trace://acme/2']);
  const first = JSON.parse(ds.jsonl.split('\n')[0]);
  assert.deepEqual(first.messages[0], { role: 'system', content: 'You are a security analyst.' });
  assert.equal(first.messages[1].role, 'user');
  assert.equal(first.messages[1].content, 'scan host');
  assert.equal(first.messages[2].role, 'assistant');
  assert.equal(first.messages[2].content, 'ran nmap, found open redis');
  assert.ok(ds.jsonl.endsWith('\n'));
});

test('buildDataset: completion format', () => {
  const ds = buildDataset(rows, { format: 'completion' });
  assert.equal(ds.count, 2);
  const first = JSON.parse(ds.jsonl.split('\n')[0]);
  assert.deepEqual(first, { prompt: 'scan host', completion: 'ran nmap, found open redis' });
});

test('getFineTuneProvider: local default; fireworks requires keys', () => {
  const local = getFineTuneProvider({ finetuneProvider: 'local', distillOutputDir: '/tmp/x' });
  assert.ok(local instanceof LocalProvider);
  assert.throws(() => getFineTuneProvider({ finetuneProvider: 'fireworks' }));
  assert.throws(() => getFineTuneProvider({ finetuneProvider: 'nope' }));
});

test('LocalProvider.submit writes JSONL and returns a succeeded job', async () => {
  const dir = path.join(os.tmpdir(), 'carma-distill-test-' + Date.now());
  const p = new LocalProvider({ outputDir: dir });
  const jsonl = '{"messages":[{"role":"user","content":"a"},{"role":"assistant","content":"b"}]}\n';
  const job = await p.submit({ datasetJsonl: jsonl, count: 1, baseModel: 'demo' });
  assert.equal(job.status, 'succeeded');
  assert.ok(job.model.startsWith('local/demo::'));
  assert.equal(readFileSync(job.datasetPath, 'utf8'), jsonl);
});

test('normalizeModel: short name -> fireworks account path; full path preserved', () => {
  assert.equal(normalizeModel('llama-v3p1-8b-instruct', 'acme'), 'accounts/fireworks/models/llama-v3p1-8b-instruct');
  assert.equal(normalizeModel('accounts/acme/models/x', 'acme'), 'accounts/acme/models/x');
});

test('FireworksProvider.submit performs create->upload->job with correct requests', async () => {
  const calls = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (u, init) => {
    calls.push({ url: String(u), method: init?.method || 'GET', body: init?.body });
    // Return a job resource on the 3rd call (create job); empty ok otherwise.
    const isJob = String(u).endsWith('/supervisedFineTuningJobs');
    const payload = isJob
      ? { name: 'accounts/acme/supervisedFineTuningJobs/job-123', state: 'JOB_STATE_PENDING', outputModel: 'accounts/acme/models/carma-x' }
      : {};
    return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
  };
  try {
    const p = new FireworksProvider({ apiKey: 'k', accountId: 'acme', baseUrl: 'https://api.fireworks.ai' });
    const job = await p.submit({ datasetJsonl: '{"messages":[]}\n', count: 3, baseModel: 'llama-v3p1-8b-instruct' });
    assert.equal(calls.length, 3);
    assert.ok(calls[0].url.endsWith('/v1/accounts/acme/datasets'));
    assert.match(calls[1].url, /\/v1\/accounts\/acme\/datasets\/.*:upload$/);
    assert.ok(calls[2].url.endsWith('/v1/accounts/acme/supervisedFineTuningJobs'));
    const jobBody = JSON.parse(calls[2].body);
    assert.equal(jobBody.baseModel, 'accounts/fireworks/models/llama-v3p1-8b-instruct');
    assert.match(jobBody.dataset, /^accounts\/acme\/datasets\//);
    assert.match(jobBody.outputModel, /^accounts\/acme\/models\/carma-/);
    assert.equal(job.jobId, 'job-123');
    assert.equal(job.status, 'JOB_STATE_PENDING');
  } finally {
    globalThis.fetch = orig;
  }
});
