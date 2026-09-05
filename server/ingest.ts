import { signEnvelope } from './middleware/jws.js';
import { validateEnvelope } from './middleware/guardrails.js';
import { embed, toVectorLiteral } from './embedding.js';

export interface IngestContext {
  uri: string;
  trustDomain: string;
  subject?: string;
  privateKeyPem: string;
}

export interface DecisionInput {
  choice: string;
  alternatives?: string[];
}

export type OutcomeStatus = 'pending' | 'success' | 'failure' | 'mixed' | 'unknown';
export interface OutcomeInput {
  status: OutcomeStatus;
  score?: number;
  observedAt?: string;
  evidence?: string;
}

export interface TraceInput {
  task?: string | null;
  content?: string | null;
  boundContext?: string[];
  decision?: DecisionInput | null;
  outcome?: OutcomeInput | null;
  confidence?: number | null;
  importance?: number | null;
  // When set, this trace is a revision that supersedes the given memory URI.
  supersedes?: string | null;
}

// Derive a signed usefulness signal in [-1, 1] from an outcome, so recall can
// prefer reasoning that worked. Explicit score wins; otherwise map by status.
export function outcomeScore(outcome?: OutcomeInput | null): number | null {
  if (!outcome) return null;
  if (typeof outcome.score === 'number') return Math.max(-1, Math.min(1, outcome.score));
  switch (outcome.status) {
    case 'success':
      return 1;
    case 'failure':
      return -1;
    case 'mixed':
      return 0;
    default:
      return null; // pending / unknown -> neutral (no signal)
  }
}

// Build a signed JSON-AM trace:// envelope for one decision, validate it, embed
// its text, and persist it together with its vector so it becomes a retrievable
// RAG pointer. Optionally records the decision made, initial outcome, salience
// hints, and a supersedes link (revision).
export async function storeTrace(adapter: any, ctx: IngestContext, input: TraceInput) {
  const task = input?.task ?? null;
  const content = input?.content ?? null;
  const boundContext = input?.boundContext ?? [];
  const decision = input?.decision ?? null;
  const outcome = input?.outcome ?? null;
  const supersedes = input?.supersedes ?? null;

  if (!content && !task) throw new Error('trace requires task or content');
  if (!ctx.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing');

  const now = new Date().toISOString();
  const envelope: any = {
    '@context': 'https://json-am.org/context/v0.1',
    id: ctx.uri,
    type: 'ATIR',
    uriScheme: 'trace',
    trustDomain: ctx.trustDomain,
    version: '0.1.3-draft',
    issuedAt: now,
    provenance: { createdBy: ctx.subject ?? 'carma', createdAt: now },
    task,
    boundContext,
    content,
  };
  if (decision) envelope.decision = decision;
  if (outcome) envelope.outcome = outcome;
  if (typeof input?.confidence === 'number') envelope.confidence = input.confidence;
  if (typeof input?.importance === 'number') envelope.importance = input.importance;
  if (supersedes) envelope.lineage = { supersedes };

  envelope.signature = await signEnvelope(envelope, ctx.privateKeyPem);
  validateEnvelope(envelope);

  const text = [task, content, decision?.choice, ...(boundContext || [])].filter(Boolean).join('\n');
  const embedding = toVectorLiteral(await embed(text));

  await adapter.store({
    uri: ctx.uri,
    kind: 'trace',
    trustDomain: ctx.trustDomain,
    envelope,
    signature: envelope.signature,
    content: text,
    embedding,
    status: 'active',
    supersedes: supersedes ?? null,
    outcomeStatus: outcome?.status ?? null,
    outcomeScore: outcomeScore(outcome),
    confidence: typeof input?.confidence === 'number' ? input.confidence : null,
    importance: typeof input?.importance === 'number' ? input.importance : null,
  });

  // Revision: mark the prior version superseded so recall returns only the head.
  if (supersedes) {
    await adapter.markSuperseded(supersedes, ctx.uri, ctx.trustDomain);
  }

  return { uri: ctx.uri, stored: true, supersedes: supersedes ?? undefined };
}

export interface OutcomeContext {
  trustDomain: string;
  subject?: string;
  privateKeyPem: string;
}

// Record that a prior decision produced an outcome. Persists a first-class,
// signed Outcome envelope (so it is addressable/auditable/distillable) and
// updates the decision row's denormalized outcome columns that recall reads.
export async function recordOutcome(
  adapter: any,
  ctx: OutcomeContext,
  input: { decisionUri: string; status: OutcomeStatus; score?: number; evidence?: string }
) {
  if (!ctx.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing');
  const decision = await adapter.resolve(input.decisionUri);
  if (!decision) throw new Error('Decision not found: ' + input.decisionUri);
  if (decision.trust_domain && decision.trust_domain !== ctx.trustDomain) {
    throw new Error('Decision belongs to a different trust domain');
  }

  const now = new Date().toISOString();
  const outcome: OutcomeInput = {
    status: input.status,
    ...(typeof input.score === 'number' ? { score: input.score } : {}),
    observedAt: now,
    ...(input.evidence ? { evidence: input.evidence } : {}),
  };
  const uri = `memory://${ctx.trustDomain}/outcome/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const envelope: any = {
    '@context': 'https://json-am.org/context/v0.1',
    id: uri,
    type: 'Outcome',
    uriScheme: 'memory',
    trustDomain: ctx.trustDomain,
    version: '0.1.3-draft',
    issuedAt: now,
    provenance: { createdBy: ctx.subject ?? 'carma', createdAt: now },
    decisionUri: input.decisionUri,
    outcome,
  };
  envelope.signature = await signEnvelope(envelope, ctx.privateKeyPem);
  validateEnvelope(envelope);

  // Outcome envelopes are not semantic-recall targets themselves (embedding
  // null), but stay resolvable and part of the corpus for distillation.
  await adapter.store({
    uri,
    kind: 'outcome',
    trustDomain: ctx.trustDomain,
    envelope,
    signature: envelope.signature,
    content: input.evidence ?? '',
    embedding: null,
    status: 'active',
    supersedes: null,
    outcomeStatus: input.status,
    outcomeScore: outcomeScore(outcome),
    confidence: null,
    importance: null,
  });

  await adapter.attachOutcome(input.decisionUri, {
    outcomeStatus: input.status,
    outcomeScore: outcomeScore(outcome),
    outcomeUri: uri,
  });

  return { outcomeUri: uri, decisionUri: input.decisionUri, status: input.status };
}

// Retract a memory: excluded from recall, preserved for audit/lineage.
export async function retractMemory(
  adapter: any,
  ctx: { trustDomain: string },
  uri: string
) {
  const row = await adapter.resolve(uri);
  if (!row) throw new Error('Memory not found: ' + uri);
  if (row.trust_domain && row.trust_domain !== ctx.trustDomain) {
    throw new Error('Memory belongs to a different trust domain');
  }
  await adapter.setStatus(uri, 'retracted');
  return { uri, status: 'retracted' };
}

export function newTraceUri(trustDomain: string): string {
  return `trace://${trustDomain}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
