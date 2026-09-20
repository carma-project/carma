// Shared request validation for traces and outcomes. Both the REST routes
// (server/index.js) and the MCP tools (server/mcp/index.ts) go through here, so
// an agent harness cannot store what the HTTP API would reject.
import { sanitizeUri } from './middleware/guardrails.js';

export const OUTCOME_STATUSES = ['pending', 'success', 'failure', 'mixed', 'unknown'];

const DEFAULT_LIMITS = { contentMaxLength: 100_000, boundContextMax: 256, elementMaxLength: 2048 };

function limitsOf(limits) {
  return {
    contentMaxLength: limits?.contentMaxLength ?? DEFAULT_LIMITS.contentMaxLength,
    boundContextMax: limits?.boundContextMax ?? DEFAULT_LIMITS.boundContextMax,
    elementMaxLength: limits?.elementMaxLength ?? DEFAULT_LIMITS.elementMaxLength,
  };
}

export function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// Coerce a caller-supplied integer (query string, JSON body, tool argument)
// into [lo, hi]; anything unparseable falls back to `def`. Keeps negative,
// fractional or NaN values away from SQL LIMIT clauses.
export function clampInt(v, def, lo, hi) {
  if (v == null || v === '') return def;
  const n = Math.trunc(Number(v));
  if (!Number.isFinite(n)) return def;
  return Math.min(hi, Math.max(lo, n));
}

export function numInRange(v, name, lo, hi) {
  if (v == null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${name} must be a number`);
  if (v < lo || v > hi) throw new Error(`${name} must be in [${lo}, ${hi}]`);
  return v;
}

export function validateOutcome(o, limits) {
  const L = limitsOf(limits);
  if (!isPlainObject(o)) throw new Error('outcome must be an object');
  if (!OUTCOME_STATUSES.includes(o.status)) {
    throw new Error(`outcome.status must be one of ${OUTCOME_STATUSES.join(', ')}`);
  }
  const score = numInRange(o.score, 'outcome.score', -1, 1);
  if (o.evidence != null && typeof o.evidence !== 'string') throw new Error('outcome.evidence must be a string');
  if ((o.evidence || '').length > L.contentMaxLength) throw new Error('outcome.evidence exceeds limit');
  return { status: o.status, ...(score != null ? { score } : {}), ...(o.evidence ? { evidence: o.evidence } : {}) };
}

// Validate and normalize the body of POST /memory or the arguments of the MCP
// store_trace tool. Every free-text field is bounded: task+content by
// CONTENT_MAX_LENGTH, decision.choice likewise, and each boundContext /
// alternatives entry by elementMaxLength — nothing reaches the envelope
// unbounded up to BODY_LIMIT_BYTES.
export function validateTraceInput(body, limits) {
  const L = limitsOf(limits);
  if (!isPlainObject(body)) throw new Error('trace must be a JSON object');
  const task = body.task ?? null;
  const content = body.content ?? null;
  if (task != null && typeof task !== 'string') throw new Error('task must be a string');
  if (content != null && typeof content !== 'string') throw new Error('content must be a string');
  if (!task && !content) throw new Error('trace requires task or content');
  if ((task || '').length + (content || '').length > L.contentMaxLength) {
    throw new Error('trace content exceeds limit');
  }

  const boundContext = body.boundContext ?? [];
  if (!Array.isArray(boundContext)) throw new Error('boundContext must be an array');
  if (boundContext.length > L.boundContextMax) throw new Error('boundContext too large');
  if (!boundContext.every((x) => typeof x === 'string' && x.length <= L.elementMaxLength)) {
    throw new Error(`boundContext entries must be strings of at most ${L.elementMaxLength} characters`);
  }

  let decision = null;
  if (body.decision != null) {
    if (!isPlainObject(body.decision) || typeof body.decision.choice !== 'string') {
      throw new Error('decision must be an object with a string choice');
    }
    if (body.decision.choice.length > L.contentMaxLength) throw new Error('decision.choice exceeds limit');
    let alternatives;
    if (body.decision.alternatives != null) {
      const alts = body.decision.alternatives;
      const ok =
        Array.isArray(alts) &&
        alts.length <= L.boundContextMax &&
        alts.every((a) => typeof a === 'string' && a.length <= L.elementMaxLength);
      if (!ok) {
        throw new Error(
          `decision.alternatives must be an array of at most ${L.boundContextMax} strings of at most ${L.elementMaxLength} characters`
        );
      }
      alternatives = alts;
    }
    decision = { choice: body.decision.choice, ...(alternatives ? { alternatives } : {}) };
  }

  const outcome = body.outcome != null ? validateOutcome(body.outcome, L) : null;
  const confidence = numInRange(body.confidence, 'confidence', 0, 1);
  const importance = numInRange(body.importance, 'importance', 0, 1);

  let supersedes = null;
  if (body.supersedes != null) supersedes = sanitizeUri(body.supersedes);

  let occurredAt = null;
  if (body.occurredAt != null) {
    if (typeof body.occurredAt !== 'string' || Number.isNaN(Date.parse(body.occurredAt))) {
      throw new Error('occurredAt must be an ISO 8601 date string');
    }
    if (Date.parse(body.occurredAt) > Date.now() + 5 * 60 * 1000) throw new Error('occurredAt cannot be in the future');
    occurredAt = new Date(body.occurredAt).toISOString();
  }

  return { task, content, boundContext, decision, outcome, confidence, importance, supersedes, occurredAt };
}
