// Provider-neutral "memory model" used by offline consolidation (dreaming).
// Two jobs, mirroring Mem0 (arXiv:2504.19413): (1) propose a consolidation
// operation for a near-duplicate pair (ADD/UPDATE/DELETE/NOOP -> our
// keep_separate/merge/merge/reject), and (2) abstract a cluster of recurring
// decisions into a reusable principle (episodic -> semantic).
//
// CARMA is not locked to a provider: the default `local` model is deterministic
// and offline (no network, no keys), so consolidation always works. A hosted
// model (`fireworks`, OpenAI-compatible chat) can be plugged in for richer
// reasoning and falls back to local on any error. The model only *proposes* — a
// human still resolves every review.

export interface MemLike {
  uri: string;
  task?: string | null;
  content?: string | null;
  choice?: string | null;
  outcomeStatus?: string | null;
  outcomeScore?: number | null;
}

export type Resolution = 'merge' | 'keep_separate' | 'reject';

export interface ConsolidationProposal {
  resolution: Resolution;
  reason: string;
}

export interface ClusterSummary {
  principle: string;
  summary: string;
  successRate: number;
}

export interface MemoryModel {
  name: string;
  proposeConsolidation(candidate: MemLike, neighbor: MemLike, similarity: number): Promise<ConsolidationProposal>;
  summarizeCluster(task: string, members: MemLike[]): Promise<ClusterSummary>;
}

function norm(s?: string | null): string {
  return String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

function firstSentence(s?: string | null, max = 200): string {
  const t = String(s || '').trim();
  if (!t) return '';
  const cut = t.split(/(?<=[.!?])\s/)[0] || t;
  return cut.length > max ? cut.slice(0, max - 1) + '\u2026' : cut;
}

function successRateOf(members: MemLike[]): number {
  const decided = members.filter((m) => m.outcomeStatus && m.outcomeStatus !== 'pending' && m.outcomeStatus !== 'unknown');
  if (decided.length === 0) return 0;
  const ok = decided.filter((m) => m.outcomeStatus === 'success').length;
  return ok / decided.length;
}

// Deterministic, offline reasoning. No network. Fully unit-testable.
export class LocalMemoryModel implements MemoryModel {
  name = 'local';
  private mergeAt: number;
  constructor(opts: { mergeAt?: number } = {}) {
    this.mergeAt = opts.mergeAt ?? 0.97;
  }

  async proposeConsolidation(candidate: MemLike, neighbor: MemLike, similarity: number): Promise<ConsolidationProposal> {
    const sameChoice = candidate.choice && neighbor.choice && norm(candidate.choice) === norm(neighbor.choice);
    const candFailed = candidate.outcomeStatus === 'failure';
    const neighborOk = neighbor.outcomeStatus === 'success';

    // A duplicate that failed where its near-twin succeeded is contradicted
    // knowledge — propose retracting it (Mem0 DELETE).
    if (candFailed && neighborOk) {
      return { resolution: 'reject', reason: 'Near-duplicate that failed where the retained memory succeeded.' };
    }
    // Same decision + very high similarity -> redundant; fold into one (UPDATE/NOOP).
    if (sameChoice && similarity >= this.mergeAt) {
      return { resolution: 'merge', reason: `Same decision ("${candidate.choice}") and near-identical (sim ${similarity.toFixed(3)}).` };
    }
    // Similar context but a different choice -> distinct option worth keeping (ADD).
    if (candidate.choice && neighbor.choice && !sameChoice) {
      return { resolution: 'keep_separate', reason: 'Similar context but a different decision — distinct precedent.' };
    }
    // Highly similar, no conflicting signal -> merge; otherwise keep separate.
    if (similarity >= this.mergeAt) {
      return { resolution: 'merge', reason: `Near-identical content (sim ${similarity.toFixed(3)}).` };
    }
    return { resolution: 'keep_separate', reason: `Related but distinct (sim ${similarity.toFixed(3)}).` };
  }

  async summarizeCluster(task: string, members: MemLike[]): Promise<ClusterSummary> {
    // Principle = most common decision choice, breaking ties toward choices that
    // led to success.
    const tally = new Map<string, { choice: string; count: number; success: number }>();
    for (const m of members) {
      if (!m.choice) continue;
      const key = norm(m.choice);
      const e = tally.get(key) || { choice: m.choice, count: 0, success: 0 };
      e.count += 1;
      if (m.outcomeStatus === 'success') e.success += 1;
      tally.set(key, e);
    }
    const ranked = [...tally.values()].sort((a, b) => b.success - a.success || b.count - a.count);
    const principle = ranked[0]?.choice || firstSentence(members[0]?.content) || task;
    const successRate = successRateOf(members);

    const rationales = [...new Set(members.map((m) => firstSentence(m.content)).filter(Boolean))].slice(0, 5);
    const pct = Math.round(successRate * 100);
    const summary =
      `On "${task}", the recurring decision is "${principle}" ` +
      `(${members.length} decisions, ${pct}% recorded success). ` +
      (rationales.length ? `Key rationale: ${rationales.join(' ')}` : '');
    return { principle, summary: summary.trim(), successRate };
  }
}

// OpenAI-compatible chat model. Used only when explicitly configured; any
// failure falls back to the local model so dreaming never breaks. Works with
// Fireworks (default path shape) or any OpenAI-compatible server — a self-hosted
// vLLM or Ollama — by supplying `baseUrl` + `chatPath`. The API key is optional
// so keyless self-hosted endpoints (e.g. Ollama) work.
export class ChatMemoryModel implements MemoryModel {
  name: string;
  private fallback = new LocalMemoryModel();
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private chatPath: string;
  private requireKey: boolean;
  constructor(opts: { apiKey?: string; model: string; baseUrl?: string; name?: string; chatPath?: string; requireKey?: boolean }) {
    this.apiKey = opts.apiKey || '';
    this.model = opts.model;
    this.baseUrl = (opts.baseUrl || 'https://api.fireworks.ai').replace(/\/$/, '');
    // Fireworks serves chat at /inference/v1/...; standard OpenAI servers (vLLM,
    // Ollama) use /v1/chat/completions.
    this.chatPath = opts.chatPath || '/inference/v1/chat/completions';
    // Fireworks needs a key; self-hosted OpenAI-compatible servers may not.
    this.requireKey = opts.requireKey ?? true;
    this.name = opts.name || 'fireworks';
  }

  private async chatJson(system: string, user: string): Promise<any | null> {
    if (this.requireKey && !this.apiKey) return null;
    try {
      const headers: Record<string, string> = { 'content-type': 'application/json' };
      if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
      const res = await fetch(`${this.baseUrl}${this.chatPath}`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: this.model,
          temperature: 0,
          max_tokens: 512,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) return null;
      const data: any = await res.json();
      const text = data?.choices?.[0]?.message?.content;
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  }

  async proposeConsolidation(candidate: MemLike, neighbor: MemLike, similarity: number): Promise<ConsolidationProposal> {
    const out = await this.chatJson(
      'You consolidate an AI agent\'s decision memory. Decide how a candidate memory relates to a near-duplicate. ' +
        'Reply as JSON {"resolution":"merge|keep_separate|reject","reason":"..."}. ' +
        'merge = redundant, fold together; keep_separate = distinct precedent; reject = candidate is contradicted/obsolete.',
      JSON.stringify({ similarity, candidate, neighbor })
    );
    if (out && ['merge', 'keep_separate', 'reject'].includes(out.resolution)) {
      return { resolution: out.resolution, reason: String(out.reason || 'model proposal') };
    }
    return this.fallback.proposeConsolidation(candidate, neighbor, similarity);
  }

  async summarizeCluster(task: string, members: MemLike[]): Promise<ClusterSummary> {
    const out = await this.chatJson(
      'You abstract recurring AI-agent decisions into one reusable principle. ' +
        'Reply as JSON {"principle":"short rule of thumb","summary":"1-3 sentences"}.',
      JSON.stringify({ task, decisions: members.map((m) => ({ choice: m.choice, reasoning: m.content, outcome: m.outcomeStatus })) })
    );
    const successRate = successRateOf(members);
    if (out && out.principle && out.summary) {
      return { principle: String(out.principle), summary: String(out.summary), successRate };
    }
    return this.fallback.summarizeCluster(task, members);
  }
}

// Select the memory model from config. `local` (default) is offline/deterministic.
export function getMemoryModel(config: any): MemoryModel {
  if (config?.memoryModelProvider === 'fireworks' && config?.fireworksApiKey) {
    return new ChatMemoryModel({
      apiKey: config.fireworksApiKey,
      model: config.memoryModelName,
      baseUrl: config.fireworksBaseUrl,
      chatPath: '/inference/v1/chat/completions',
      name: 'fireworks',
    });
  }
  // Any OpenAI-compatible endpoint (self-hosted vLLM/Ollama, or a hosted API).
  if (config?.memoryModelProvider === 'openai' && config?.memoryModelBaseUrl) {
    return new ChatMemoryModel({
      apiKey: config.memoryModelApiKey,
      model: config.memoryModelName,
      baseUrl: config.memoryModelBaseUrl,
      chatPath: '/v1/chat/completions',
      requireKey: false,
      name: 'openai',
    });
  }
  return new LocalMemoryModel();
}
