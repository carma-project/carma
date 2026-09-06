import test from 'node:test';
import assert from 'node:assert/strict';
import { getMemoryModel, ChatMemoryModel, LocalMemoryModel } from '../server/memory/model.ts';

test('getMemoryModel: provider selection', () => {
  // Default / misconfigured -> offline local model.
  assert.equal(getMemoryModel({}).name, 'local');
  assert.equal(getMemoryModel({ memoryModelProvider: 'local' }).name, 'local');
  // openai without a base URL cannot be built -> falls back to local.
  assert.equal(getMemoryModel({ memoryModelProvider: 'openai' }).name, 'local');
  // fireworks without a key -> falls back to local.
  assert.equal(getMemoryModel({ memoryModelProvider: 'fireworks' }).name, 'local');

  const fw = getMemoryModel({ memoryModelProvider: 'fireworks', fireworksApiKey: 'k', memoryModelName: 'm', fireworksBaseUrl: 'https://api.fireworks.ai' });
  assert.equal(fw.name, 'fireworks');
  assert.ok(fw instanceof ChatMemoryModel);

  // Generic OpenAI-compatible endpoint (e.g. self-hosted vLLM/Ollama).
  const oa = getMemoryModel({ memoryModelProvider: 'openai', memoryModelBaseUrl: 'http://vllm:8000/v1', memoryModelName: 'qwen2.5' });
  assert.equal(oa.name, 'openai');
  assert.ok(oa instanceof ChatMemoryModel);
});

test('ChatMemoryModel: unreachable endpoint falls back to local reasoning (never throws)', async () => {
  // Point at a dead port; keyless (like Ollama). Every call must fall back to
  // the deterministic local model rather than break dreaming.
  const m = new ChatMemoryModel({ model: 'x', baseUrl: 'http://127.0.0.1:1/v1', chatPath: '/v1/chat/completions', requireKey: false, name: 'openai' });
  const local = new LocalMemoryModel();

  const cand = { uri: 'a', choice: 'use redis', outcomeStatus: 'success', content: 'x' };
  const neigh = { uri: 'b', choice: 'use redis', outcomeStatus: 'success', content: 'x' };
  const prop = await m.proposeConsolidation(cand, neigh, 0.99);
  const localProp = await local.proposeConsolidation(cand, neigh, 0.99);
  assert.ok(['merge', 'keep_separate', 'reject'].includes(prop.resolution));
  assert.equal(prop.resolution, localProp.resolution);

  const cluster = await m.summarizeCluster('task', [cand, neigh]);
  assert.ok(cluster.principle && typeof cluster.summary === 'string');
});
