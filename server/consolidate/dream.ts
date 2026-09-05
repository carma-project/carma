import { signEnvelope } from '../middleware/jws.js';
import { validateEnvelope } from '../middleware/guardrails.js';
import { embed, toVectorLiteral } from '../embedding.js';
import type { MemoryModel, MemLike } from '../memory/model.js';

export type DreamStep = 'decay' | 'promote' | 'dedup' | 'abstract';

export interface DreamOptions {
  trustDomain: string;
  subject?: string;
  privateKeyPem?: string;
  dryRun?: boolean;
  steps?: DreamStep[];
  limit?: number;
}

interface DreamConfig {
  dreamDecayDays: number;
  dreamMinReinforceKeep: number;
  dreamSimThreshold: number;
  dreamMinClusterSize: number;
  dreamMaxReviews: number;
  dreamMaxAbstractions: number;
  reinforcePromoteAt: number;
}

function memLike(row: any): MemLike {
  const e = row.envelope || {};
  return {
    uri: row.uri,
    task: e.task ?? null,
    content: e.content ?? null,
    choice: e.decision?.choice ?? null,
    outcomeStatus: row.outcome_status ?? e.outcome?.status ?? null,
    outcomeScore: row.outcome_score ?? null,
  };
}

// Rough salience: which memory in a near-duplicate pair is the stronger one to
// keep. The weaker one becomes the review "candidate" (the one a reject/merge
// acts on), the stronger the retained "similar".
function salience(row: any): number {
  let s = 0;
  if (row.tier === 'pinned') s += 100;
  else if (row.tier === 'consolidated') s += 10;
  if (row.outcome_status === 'success') s += 5;
  else if (row.outcome_status === 'failure') s -= 5;
  s += Number(row.reinforcement_count || 0);
  s += Math.min(Number(row.age_days || 0) / 365, 1); // older = a bit more established
  return s;
}

function normTask(t?: string | null): string {
  return String(t || '').trim().toLowerCase().replace(/\s+/g, ' ');
}

// Offline consolidation ("dreaming"): the batch counterpart to on-write
// consolidation. Runs four idempotent passes over a trust domain's active
// memory and returns a report. `dryRun` computes the report without mutating.
export async function runDream(
  adapter: any,
  model: MemoryModel,
  config: DreamConfig,
  opts: DreamOptions
) {
  const trustDomain = opts.trustDomain;
  if (!trustDomain) throw new Error('trustDomain is required for consolidation');
  const dryRun = Boolean(opts.dryRun);
  const steps = new Set<DreamStep>(opts.steps && opts.steps.length ? opts.steps : ['decay', 'promote', 'dedup', 'abstract']);

  const rows = await adapter.listActiveMemories({ trustDomain, limit: opts.limit ?? 5000 });
  const byUri = new Map<string, any>(rows.map((r: any) => [r.uri, r]));
  const traces = rows.filter((r: any) => r.kind === 'trace');
  const archived = new Set<string>();

  const report: any = {
    trustDomain,
    dryRun,
    model: model.name,
    scanned: rows.length,
    decayed: { count: 0, uris: [] as string[] },
    promoted: { count: 0, uris: [] as string[] },
    reviews: { count: 0, pairs: [] as any[] },
    abstractions: { count: 0, created: [] as any[] },
  };

  // 1) Decay/evict: stale, unproven, unreinforced *working* memories are archived
  //    (excluded from recall, preserved for audit). Consolidated/pinned are exempt.
  if (steps.has('decay')) {
    for (const r of traces) {
      if (r.tier !== 'working') continue;
      if (Number(r.age_days) <= config.dreamDecayDays) continue;
      if (Number(r.reinforcement_count || 0) >= config.dreamMinReinforceKeep) continue;
      if (r.outcome_status === 'success') continue;
      if (!dryRun) await adapter.setStatus(r.uri, 'archived');
      archived.add(r.uri);
      report.decayed.uris.push(r.uri);
    }
    report.decayed.count = report.decayed.uris.length;
  }

  // 2) Salience/tier recompute: working memories that proved out (success) or
  //    recurred enough (reinforcement) are promoted to consolidated.
  if (steps.has('promote')) {
    for (const r of traces) {
      if (r.tier !== 'working' || archived.has(r.uri)) continue;
      const proven = r.outcome_status === 'success';
      const recurring = Number(r.reinforcement_count || 0) >= config.reinforcePromoteAt;
      if (!proven && !recurring) continue;
      if (!dryRun) await adapter.setTier(r.uri, 'consolidated');
      report.promoted.uris.push(r.uri);
    }
    report.promoted.count = report.promoted.uris.length;
  }

  // 3) Batch near-duplicate detection -> human review queue, each with a
  //    model-proposed resolution (merge / keep_separate / reject). Never resolved
  //    automatically.
  if (steps.has('dedup')) {
    const pairs = await adapter.findNearDuplicatePairs({
      trustDomain,
      kind: 'trace',
      threshold: config.dreamSimThreshold,
      limit: config.dreamMaxReviews * 4,
    });
    const seen = new Set<string>();
    for (const p of pairs) {
      if (report.reviews.count >= config.dreamMaxReviews) break;
      const a = p.a_uri;
      const b = p.b_uri;
      if (a === b || archived.has(a) || archived.has(b)) continue;
      const key = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const ra = byUri.get(a);
      const rb = byUri.get(b);
      if (!ra || !rb) continue;
      if (await adapter.reviewExistsFor(trustDomain, a, b)) continue;
      // Weaker memory = candidate (the one reject/merge acts on).
      const [cand, keep] = salience(ra) <= salience(rb) ? [ra, rb] : [rb, ra];
      const sim = Number(p.similarity);
      const proposal = await model.proposeConsolidation(memLike(cand), memLike(keep), sim);
      let reviewId: any = null;
      if (!dryRun) {
        reviewId = await adapter.enqueueReview({
          trustDomain,
          candidateUri: cand.uri,
          similarUri: keep.uri,
          similarity: sim,
          proposedResolution: proposal.resolution,
          proposedReason: proposal.reason,
          source: 'dream',
        });
      }
      report.reviews.pairs.push({
        reviewId,
        candidate: cand.uri,
        similar: keep.uri,
        similarity: sim,
        proposed: proposal.resolution,
        reason: proposal.reason,
      });
      report.reviews.count += 1;
    }
  }

  // 4) Episodic -> semantic: recurring decisions on the same task are abstracted
  //    into one reusable, recall-indexed principle that also feeds distillation.
  if (steps.has('abstract')) {
    const existingSemanticTasks = new Set<string>(
      rows
        .filter((r: any) => r.kind === 'semantic')
        .map((r: any) => normTask(r.envelope?.semantic?.task ?? r.envelope?.task))
    );
    const clusters = new Map<string, any[]>();
    for (const r of traces) {
      if (archived.has(r.uri)) continue;
      const t = normTask(r.envelope?.task);
      if (!t) continue;
      let bucket = clusters.get(t);
      if (!bucket) {
        bucket = [];
        clusters.set(t, bucket);
      }
      bucket.push(r);
    }
    for (const [t, members] of clusters) {
      if (report.abstractions.count >= config.dreamMaxAbstractions) break;
      if (members.length < config.dreamMinClusterSize) continue;
      if (existingSemanticTasks.has(t)) continue; // idempotent
      const taskLabel = members[0].envelope?.task || t;
      const summary = await model.summarizeCluster(taskLabel, members.map(memLike));
      const derivedFrom = members.map((m) => m.uri);
      const uri = `memory://${trustDomain}/semantic/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const created: any = {
        uri,
        task: taskLabel,
        principle: summary.principle,
        supportCount: members.length,
        successRate: summary.successRate,
      };
      if (!dryRun) {
        if (!opts.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing semantic memory');
        const now = new Date().toISOString();
        const envelope: any = {
          '@context': 'https://json-am.org/context/v0.1',
          id: uri,
          type: 'Semantic',
          uriScheme: 'memory',
          trustDomain,
          version: '0.1.3-draft',
          issuedAt: now,
          provenance: { createdBy: opts.subject || 'carma-dream', createdAt: now },
          task: taskLabel,
          content: summary.summary,
          semantic: {
            task: taskLabel,
            principle: summary.principle,
            derivedFrom,
            supportCount: members.length,
            successRate: summary.successRate,
            model: model.name,
          },
          confidence: summary.successRate,
          importance: 0.9,
        };
        envelope.signature = await signEnvelope(envelope, opts.privateKeyPem);
        validateEnvelope(envelope);
        const text = [taskLabel, summary.principle, summary.summary].filter(Boolean).join('\n');
        await adapter.store({
          uri,
          kind: 'semantic',
          trustDomain,
          envelope,
          signature: envelope.signature,
          content: text,
          embedding: toVectorLiteral(await embed(text)),
          status: 'active',
          confidence: summary.successRate,
          importance: 0.9,
          tier: 'consolidated',
        });
      }
      report.abstractions.created.push(created);
      report.abstractions.count += 1;
    }
  }

  return report;
}
