import { Pool } from 'pg';

export interface MemoryRecord {
  uri: string;
  kind: string;
  trustDomain: string;
  envelope: any;
  signature: string;
  content: string;
  embedding: string | null; // pgvector literal, e.g. "[0.1,0.2,...]"; null = not recall-indexed
  status?: string;
  supersedes?: string | null;
  outcomeStatus?: string | null;
  outcomeScore?: number | null;
  confidence?: number | null;
  importance?: number | null;
  tier?: string;
}

// Recall ranking weights. Blends semantic similarity with an outcome signal
// (prefer reasoning that worked), recency decay, a reinforcement bonus for
// recurring memories, and a *slight* boost for human-pinned memories — closer
// to human recall than raw cosine distance.
export interface RecallWeights {
  sim?: number;
  outcome?: number;
  recency?: number;
  halfLifeDays?: number;
  reinforce?: number;
  pinnedBoost?: number;
}
const DEFAULT_WEIGHTS: Required<RecallWeights> = {
  sim: 1.0,
  outcome: 0.4,
  recency: 0.15,
  halfLifeDays: 30,
  reinforce: 0.05,
  pinnedBoost: 0.1,
};

export interface PoolOptions {
  ssl?: any;
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

export class PostgresAdapter {
  private pool: any;
  constructor(connectionString: string, opts: PoolOptions = {}) {
    this.pool = new Pool({
      connectionString,
      ssl: opts.ssl ?? false,
      max: opts.max ?? 10,
      idleTimeoutMillis: opts.idleTimeoutMillis ?? 30000,
      connectionTimeoutMillis: opts.connectionTimeoutMillis ?? 5000,
    });
    // A pool 'error' on an idle client is otherwise an unhandled 'error' event
    // that crashes the process.
    this.pool.on('error', () => {});
  }

  async audit(entry: {
    actor?: string;
    action?: string;
    uri?: string;
    trustDomain?: string;
    result?: string;
    requestId?: string;
    detail?: any;
  }) {
    await this.pool.query(
      `INSERT INTO audit_log (actor, action, uri, trust_domain, result, request_id, detail)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        entry.actor ?? null,
        entry.action ?? null,
        entry.uri ?? null,
        entry.trustDomain ?? null,
        entry.result ?? null,
        entry.requestId ?? null,
        entry.detail ? JSON.stringify(entry.detail) : null,
      ]
    );
  }

  async resolve(uri: string) {
    const query =
      'SELECT uri, kind, trust_domain, envelope, signature, created_at FROM agent_memory WHERE uri = $1';
    const res = await this.pool.query(query, [uri]);
    if (res.rows.length === 0) return null;
    return res.rows[0];
  }

  async store(rec: MemoryRecord) {
    const query = `
      INSERT INTO agent_memory
        (uri, kind, trust_domain, envelope, signature, content, embedding,
         status, supersedes, outcome_status, outcome_score, confidence, importance, tier)
      VALUES ($1, $2, $3, $4, $5, $6, $7::vector, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (uri) DO UPDATE SET
        kind = EXCLUDED.kind,
        trust_domain = EXCLUDED.trust_domain,
        envelope = EXCLUDED.envelope,
        signature = EXCLUDED.signature,
        content = EXCLUDED.content,
        embedding = EXCLUDED.embedding,
        status = EXCLUDED.status,
        supersedes = EXCLUDED.supersedes,
        outcome_status = EXCLUDED.outcome_status,
        outcome_score = EXCLUDED.outcome_score,
        confidence = EXCLUDED.confidence,
        importance = EXCLUDED.importance,
        tier = EXCLUDED.tier
      RETURNING uri`;
    const res = await this.pool.query(query, [
      rec.uri,
      rec.kind,
      rec.trustDomain,
      JSON.stringify(rec.envelope),
      rec.signature,
      rec.content,
      rec.embedding,
      rec.status ?? 'active',
      rec.supersedes ?? null,
      rec.outcomeStatus ?? null,
      rec.outcomeScore ?? null,
      rec.confidence ?? null,
      rec.importance ?? null,
      rec.tier ?? 'working',
    ]);
    return res.rows[0];
  }

  // Top active neighbor by cosine similarity (for consolidation dedup checks).
  async nearestNeighbor(opts: { embedding: string; trustDomain?: string | null; excludeUri?: string }) {
    if (!opts.embedding) return null;
    const params: any[] = [opts.embedding];
    let where = "embedding IS NOT NULL AND status = 'active'";
    if (opts.trustDomain) {
      params.push(opts.trustDomain);
      where += ` AND trust_domain = $${params.length}`;
    }
    if (opts.excludeUri) {
      params.push(opts.excludeUri);
      where += ` AND uri <> $${params.length}`;
    }
    const res = await this.pool.query(
      `SELECT uri, 1 - (embedding <=> $1::vector) AS similarity
       FROM agent_memory WHERE ${where}
       ORDER BY embedding <=> $1::vector LIMIT 1`,
      params
    );
    return res.rows[0] || null;
  }

  // --- Consolidation review queue -------------------------------------------
  async enqueueReview(item: { trustDomain: string; candidateUri: string; similarUri: string; similarity: number }) {
    const res = await this.pool.query(
      `INSERT INTO memory_review (trust_domain, candidate_uri, similar_uri, similarity)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [item.trustDomain, item.candidateUri, item.similarUri, item.similarity]
    );
    return res.rows[0].id;
  }

  async listReviews(opts: { trustDomain?: string | null; status?: string; limit?: number } = {}) {
    const params: any[] = [];
    let where = '1=1';
    if (opts.trustDomain) {
      params.push(opts.trustDomain);
      where += ` AND trust_domain = $${params.length}`;
    }
    params.push(opts.status ?? 'pending');
    where += ` AND status = $${params.length}`;
    params.push(Math.min(opts.limit ?? 100, 1000));
    const res = await this.pool.query(
      `SELECT id, trust_domain, candidate_uri, similar_uri, similarity, status, created_at
       FROM memory_review WHERE ${where} ORDER BY created_at ASC LIMIT $${params.length}`,
      params
    );
    return res.rows;
  }

  async getReview(id: number | string) {
    const res = await this.pool.query(`SELECT * FROM memory_review WHERE id = $1`, [id]);
    return res.rows[0] || null;
  }

  async closeReview(id: number | string, status: string, resolution: string, resolver?: string) {
    await this.pool.query(
      `UPDATE memory_review SET status = $1, resolution = $2, resolver = $3, resolved_at = now() WHERE id = $4`,
      [status, resolution, resolver ?? null, id]
    );
  }

  // Strengthen a recurring memory; auto-promote working -> consolidated when it
  // crosses the reinforcement threshold.
  async reinforce(uri: string, promoteAt = 3) {
    const res = await this.pool.query(
      `UPDATE agent_memory
         SET reinforcement_count = reinforcement_count + 1,
             last_reinforced_at = now(),
             tier = CASE WHEN tier = 'working' AND reinforcement_count + 1 >= $2 THEN 'consolidated' ELSE tier END
       WHERE uri = $1
       RETURNING reinforcement_count, tier`,
      [uri, promoteAt]
    );
    return res.rows[0] || null;
  }

  async setTier(uri: string, tier: string) {
    await this.pool.query(`UPDATE agent_memory SET tier = $1 WHERE uri = $2`, [tier, uri]);
  }

  // Mark a prior memory as superseded by a newer revision (recall returns head).
  async markSuperseded(oldUri: string, newUri: string, trustDomain?: string | null) {
    const params: any[] = [newUri, oldUri];
    let extra = '';
    if (trustDomain) {
      params.push(trustDomain);
      extra = ` AND trust_domain = $${params.length}`;
    }
    await this.pool.query(
      `UPDATE agent_memory SET status = 'superseded', superseded_by = $1 WHERE uri = $2${extra}`,
      params
    );
  }

  // Update a decision row's denormalized outcome columns (used by recall).
  async attachOutcome(
    decisionUri: string,
    o: { outcomeStatus: string | null; outcomeScore: number | null; outcomeUri: string | null }
  ) {
    await this.pool.query(
      `UPDATE agent_memory SET outcome_status = $1, outcome_score = $2, outcome_uri = $3 WHERE uri = $4`,
      [o.outcomeStatus, o.outcomeScore, o.outcomeUri, decisionUri]
    );
  }

  async setStatus(uri: string, status: string) {
    await this.pool.query(`UPDATE agent_memory SET status = $1 WHERE uri = $2`, [status, uri]);
  }

  // Precedent recall: retrieve active memories ranked by a blend of semantic
  // similarity, outcome signal (prefer reasoning that worked), and recency.
  // Returns the envelope + outcome/lineage so callers get the reasoning behind
  // the decision and how it turned out — not just a pointer. Superseded and
  // retracted memories are excluded (set includeInactive to override).
  async search(opts: {
    embedding: string;
    k?: number;
    trustDomain?: string | null;
    kind?: string | null;
    weights?: RecallWeights;
    includeInactive?: boolean;
  }) {
    const w = { ...DEFAULT_WEIGHTS, ...(opts.weights || {}) };
    const params: any[] = [opts.embedding];
    let where = 'embedding IS NOT NULL';
    if (!opts.includeInactive) where += " AND status = 'active'";
    if (opts.trustDomain) {
      params.push(opts.trustDomain);
      where += ` AND trust_domain = $${params.length}`;
    }
    if (opts.kind) {
      params.push(opts.kind);
      where += ` AND kind = $${params.length}`;
    }
    params.push(w.sim);
    const pSim = params.length;
    params.push(w.outcome);
    const pOut = params.length;
    params.push(w.recency);
    const pRec = params.length;
    params.push(Math.max(1, w.halfLifeDays) * 86400);
    const pHalf = params.length;
    params.push(opts.k ?? 5);
    const pK = params.length;

    params.push(w.reinforce);
    const pReinf = params.length;
    params.push(w.pinnedBoost);
    const pPin = params.length;

    const simExpr = `(1 - (embedding <=> $1::vector))`;
    // Neutral (0) when no outcome is known, so undecided memories aren't penalized.
    const outExpr = `COALESCE(outcome_score, CASE outcome_status WHEN 'success' THEN 1 WHEN 'failure' THEN -1 WHEN 'mixed' THEN 0 ELSE 0 END, 0)`;
    const recExpr = `EXP(- EXTRACT(EPOCH FROM (now() - created_at)) / $${pHalf})`;
    // Bounded reinforcement bonus in [0,1); recurring memories surface higher.
    const reinfExpr = `(1 - EXP(- reinforcement_count::float / 3))`;
    // Slight additive boost for human-pinned memories (not an override).
    // Float constants so PG doesn't infer the weight param as integer.
    const pinExpr = `CASE WHEN tier = 'pinned' THEN 1.0 ELSE 0.0 END`;
    const scoreExpr = `($${pSim}::float8 * ${simExpr} + $${pOut}::float8 * (${outExpr}) + $${pRec}::float8 * ${recExpr} + $${pReinf}::float8 * ${reinfExpr} + $${pPin}::float8 * ${pinExpr})`;

    const query = `
      SELECT uri, kind, trust_domain, envelope, status, supersedes, superseded_by,
             outcome_status, outcome_score, tier, reinforcement_count, created_at,
             ${simExpr} AS similarity,
             ${scoreExpr} AS score
      FROM agent_memory
      WHERE ${where}
      ORDER BY score DESC
      LIMIT $${pK}`;
    const res = await this.pool.query(query, params);
    return res.rows;
  }

  // Resolve a pending consolidation review. merge -> reinforce the canonical
  // memory and supersede the duplicate; keep_separate -> promote the candidate
  // to consolidated; reject -> retract the candidate. Never merges silently.
  async resolveReview(
    id: number | string,
    resolution: 'merge' | 'keep_separate' | 'reject',
    opts: { resolver?: string; promoteAt?: number } = {}
  ) {
    const review = await this.getReview(id);
    if (!review) throw new Error('Review not found: ' + id);
    if (review.status !== 'pending') throw new Error('Review already resolved: ' + id);

    if (resolution === 'merge') {
      const r = await this.reinforce(review.similar_uri, opts.promoteAt ?? 3);
      await this.markSuperseded(review.candidate_uri, review.similar_uri, review.trust_domain);
      await this.closeReview(id, 'merged', 'merge', opts.resolver);
      return { id, resolution: 'merge', canonical: review.similar_uri, merged: review.candidate_uri, reinforcement: r?.reinforcement_count, tier: r?.tier };
    }
    if (resolution === 'keep_separate') {
      await this.setTier(review.candidate_uri, 'consolidated');
      await this.closeReview(id, 'kept_separate', 'keep_separate', opts.resolver);
      return { id, resolution: 'keep_separate', promoted: review.candidate_uri };
    }
    if (resolution === 'reject') {
      await this.setStatus(review.candidate_uri, 'retracted');
      await this.closeReview(id, 'rejected', 'reject', opts.resolver);
      return { id, resolution: 'reject', retracted: review.candidate_uri };
    }
    throw new Error('Unknown resolution: ' + resolution);
  }

  async pendingReviewCount(trustDomain?: string | null) {
    const params: any[] = [];
    let where = "status = 'pending'";
    if (trustDomain) {
      params.push(trustDomain);
      where += ` AND trust_domain = $${params.length}`;
    }
    const res = await this.pool.query(`SELECT count(*)::int AS n FROM memory_review WHERE ${where}`, params);
    return res.rows[0].n;
  }

  // Bulk selection of stored envelopes for distillation/export.
  async listEnvelopes(opts: { trustDomain?: string | null; kind?: string | null; since?: string | null; limit?: number } = {}) {
    const params: any[] = [];
    let where = 'envelope IS NOT NULL';
    if (opts.trustDomain) {
      params.push(opts.trustDomain);
      where += ` AND trust_domain = $${params.length}`;
    }
    if (opts.kind) {
      params.push(opts.kind);
      where += ` AND kind = $${params.length}`;
    }
    if (opts.since) {
      params.push(opts.since);
      where += ` AND created_at >= $${params.length}`;
    }
    params.push(Math.min(opts.limit ?? 1000, 1_000_000));
    const query = `
      SELECT uri, kind, trust_domain, envelope, content, created_at
      FROM agent_memory
      WHERE ${where}
      ORDER BY created_at ASC
      LIMIT $${params.length}`;
    const res = await this.pool.query(query, params);
    return res.rows;
  }

  async create(envelope: any) {
    const query = `INSERT INTO agent_memory (uri, data) VALUES ($1, $2)`;
    await this.pool.query(query, [envelope.id, JSON.stringify(envelope)]);
  }

  // Generic escape hatch used by e.g. the distillation adapter.
  async query(text: string, params: any[] = []) {
    return this.pool.query(text, params);
  }

  async close() {
    await this.pool.end();
  }

  async check() {
    const t = await this.pool.query("SELECT to_regclass('public.agent_memory') AS tbl");
    const audit = await this.pool.query("SELECT to_regclass('public.audit_log') AS tbl");
    const ext = await this.pool.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
    let hasEmbedding = false;
    try {
      const col = await this.pool.query(
        "SELECT 1 FROM information_schema.columns WHERE table_name = 'agent_memory' AND column_name = 'embedding'"
      );
      hasEmbedding = col.rows.length > 0;
    } catch {
      /* ignore */
    }
    return {
      connected: true,
      schemaReady: t.rows[0]?.tbl !== null,
      ragReady: ext.rows.length > 0 && hasEmbedding,
      auditReady: audit.rows[0]?.tbl !== null,
    };
  }
}
