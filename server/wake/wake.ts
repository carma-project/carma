// "Waking up": the session-start counterpart to ingestion (acquisition) and
// dreaming (consolidation). When an agent begins a new session — or after a
// context-window compaction summarizes away its working state — it loses its
// sense of self: who it is, how it operates, what it was just doing. Wake
// reconstitutes that from durable memory instead of a lossy summary. It composes
// three layers and renders a compact brief the agent loads at session start:
//
//   1. identity — the agent's durable self: human-pinned memories, abstracted
//      semantic principles, and ingested agent-specs (personality + operating
//      rules). This is the part a compaction must never erase.
//   2. recent   — the most recent decisions ("what was I just doing").
//   3. relevant — when the session has a task/goal, the top precedents for it
//      (similarity × outcome × recency), so it wakes already oriented.
//
// Wake is a read-only compose over existing memory — it stores nothing and signs
// nothing (like /search), so it is cheap and safe to run on every connect.
import { embed, toVectorLiteral } from '../embedding.js';
import { toPrecedent } from '../recall.js';

export interface WakeOptions {
  trustDomain: string;
  // What this session is about, if known. Enables the task-relevant layer.
  task?: string | null;
  // Layer sizes (fall back to the provided defaults / built-ins).
  recent?: number;
  identity?: number;
  relevant?: number;
  // Recall ranking weights for the relevant layer (see adapters/postgres.ts).
  recallWeights?: any;
  // Compose the task-relevant layer when a task is given (default true).
  includeRelevant?: boolean;
  // Include open consolidation reviews count in the brief (default true).
  includeReviews?: boolean;
}

const DEFAULTS = { recent: 5, identity: 8, relevant: 5 };

function firstLine(s?: string | null, max = 200): string | null {
  const t = String(s || '').trim();
  if (!t) return null;
  const line = t.split('\n').map((x) => x.trim()).find(Boolean) || t;
  return line.length > max ? line.slice(0, max - 1) + '\u2026' : line;
}

function identityView(row: any) {
  const e = row.envelope || {};
  const principle = e.semantic?.principle || e.decision?.choice || null;
  const summary = e.semantic?.summary || firstLine(e.content) || null;
  const label =
    row.tier === 'pinned'
      ? 'pinned'
      : row.kind === 'semantic'
      ? 'principle'
      : (e.boundContext || []).includes('type:agent-spec')
      ? 'agent-spec'
      : row.tier || 'consolidated';
  return {
    uri: row.uri,
    kind: row.kind,
    tier: row.tier ?? null,
    label,
    task: e.task ?? e.semantic?.task ?? null,
    principle,
    summary,
  };
}

function recentView(row: any) {
  const e = row.envelope || {};
  return {
    uri: row.uri,
    kind: row.kind,
    tier: row.tier ?? null,
    task: e.task ?? null,
    decision: e.decision?.choice ?? null,
    outcome: row.outcome_status ?? e.outcome?.status ?? null,
    when: row.created_at ?? e.issuedAt ?? null,
  };
}

function shortWhen(when: any): string | null {
  if (!when) return null;
  const d = new Date(when);
  if (Number.isNaN(d.getTime())) return String(when);
  return d.toISOString().slice(0, 10);
}

// Render the composed layers into a natural-language brief. This is the text an
// agent injects at session start (also used verbatim as the MCP `initialize`
// instructions), so it reads as a direct reorientation, not a data dump.
export function wakeDigest(payload: any): string {
  const lines: string[] = [];
  lines.push(
    `You are resuming work in the "${payload.trustDomain}" memory domain. ` +
      `Reload your working identity from these durable memories rather than relying on any summarized context.`
  );

  if (payload.identity.length) {
    lines.push('');
    lines.push('WHO YOU ARE (durable principles, specs & pinned decisions):');
    for (const it of payload.identity) {
      const head = it.principle || it.task || it.summary || it.uri;
      const detail = it.summary && it.summary !== head ? ` — ${it.summary}` : '';
      lines.push(`- [${it.label}] ${head}${detail}`);
    }
  }

  if (payload.recent.length) {
    lines.push('');
    lines.push('WHAT YOU WERE RECENTLY DOING:');
    for (const it of payload.recent) {
      const when = shortWhen(it.when);
      const decision = it.decision ? ` → ${it.decision}` : '';
      const outcome = it.outcome && it.outcome !== 'pending' ? ` (${it.outcome})` : '';
      lines.push(`- ${when ? when + ': ' : ''}${it.task || it.uri}${decision}${outcome}`);
    }
  }

  if (payload.relevant && payload.relevant.length) {
    lines.push('');
    lines.push(`RELEVANT PRECEDENT for "${payload.task}":`);
    for (const p of payload.relevant) {
      const decision = p.decision?.choice ? ` → ${p.decision.choice}` : '';
      const status = p.outcome?.status && p.outcome.status !== 'pending' ? ` (${p.outcome.status})` : '';
      lines.push(`- ${p.task || p.uri}${decision}${status}`);
    }
  }

  if (payload.openReviews > 0) {
    lines.push('');
    lines.push(`${payload.openReviews} memory consolidation review(s) await a human decision.`);
  }

  if (payload.identity.length === 0 && payload.recent.length === 0) {
    lines.push('');
    lines.push('No durable memory yet — this domain is new. Start recording decisions with store_trace.');
  }
  return lines.join('\n');
}

// Compose a wake brief for a trust domain. Read-only; no writes, no signing.
export async function composeWake(adapter: any, opts: WakeOptions) {
  const trustDomain = opts.trustDomain;
  if (!trustDomain) throw new Error('trustDomain is required for wake');
  const nIdentity = opts.identity ?? DEFAULTS.identity;
  const nRecent = opts.recent ?? DEFAULTS.recent;
  const nRelevant = opts.relevant ?? DEFAULTS.relevant;
  const task = opts.task ? String(opts.task).trim() : '';

  const identityRows = await adapter.identityMemories({ trustDomain, limit: nIdentity });
  const identity = identityRows.map(identityView);
  const identityUris = new Set(identity.map((x: any) => x.uri));

  // Recent excludes anything already surfaced as identity (avoid duplication).
  const recentRows = await adapter.recentMemories({ trustDomain, limit: nRecent + identity.length });
  const recent = recentRows
    .map(recentView)
    .filter((r: any) => !identityUris.has(r.uri))
    .slice(0, nRecent);

  let relevant: any[] = [];
  if (task && opts.includeRelevant !== false) {
    try {
      const embedding = toVectorLiteral(await embed(task));
      const rows = await adapter.search({
        embedding,
        k: nRelevant,
        trustDomain,
        weights: opts.recallWeights,
      });
      const seen = new Set([...identityUris]);
      relevant = rows
        .map(toPrecedent)
        .filter((p: any) => !seen.has(p.uri))
        .slice(0, nRelevant);
    } catch {
      // Embedding/search failure must not break waking up.
      relevant = [];
    }
  }

  let openReviews = 0;
  if (opts.includeReviews !== false) {
    try {
      openReviews = await adapter.pendingReviewCount(trustDomain);
    } catch {
      openReviews = 0;
    }
  }

  const payload: any = {
    trustDomain,
    generatedAt: new Date().toISOString(),
    task: task || null,
    identity,
    recent,
    relevant,
    openReviews,
    counts: { identity: identity.length, recent: recent.length, relevant: relevant.length },
  };
  payload.digest = wakeDigest(payload);
  return payload;
}
