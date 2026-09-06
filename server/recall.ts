// Shape a raw recall row (adapter.search) into a precedent: the reasoning
// behind a past decision, the choice made, how it turned out, and its lineage —
// so an agent recalls *why* and *whether it worked*, not just a pointer.
export function toPrecedent(row: any) {
  const e = row.envelope || {};
  const outcome =
    row.outcome_status || typeof row.outcome_score === 'number'
      ? { status: row.outcome_status ?? null, score: row.outcome_score ?? null }
      : e.outcome ?? null;
  return {
    uri: row.uri,
    kind: row.kind,
    score: row.score != null ? Number(row.score) : null,
    similarity: row.similarity != null ? Number(row.similarity) : null,
    task: e.task ?? null,
    decision: e.decision ?? null,
    reasoning: e.content ?? null,
    outcome,
    status: row.status ?? e.status ?? 'active',
    tier: row.tier ?? null,
    pinned: row.tier === 'pinned',
    reinforcementCount: row.reinforcement_count != null ? Number(row.reinforcement_count) : null,
    lineage: {
      supersedes: e.lineage?.supersedes ?? row.supersedes ?? null,
      supersededBy: row.superseded_by ?? null,
    },
    createdAt: row.created_at ?? e.issuedAt ?? null,
  };
}

// Extract recall weights from a parsed config (server/config.js). Any missing
// value falls back to the adapter's defaults.
export function weightsFromConfig(config: any) {
  return {
    sim: config?.recallWSim,
    outcome: config?.recallWOutcome,
    recency: config?.recallWRecency,
    halfLifeDays: config?.recallHalfLifeDays,
    reinforce: config?.recallWReinforce,
    pinnedBoost: config?.recallPinnedBoost,
  };
}

// Wake layer sizes derived from config (server/config.js).
export function wakeDefaultsFromConfig(config: any) {
  return {
    recent: config?.wakeRecent,
    identity: config?.wakeIdentity,
    relevant: config?.wakeRelevant,
  };
}

// Consolidation policy (on-write) derived from config.
export function policyFromConfig(config: any) {
  return {
    consolidate: true,
    simThreshold: config?.consolidateSimThreshold,
    tierMinConfidence: config?.tierConsolidateMinConfidence,
    tierMinImportance: config?.tierConsolidateMinImportance,
  };
}
