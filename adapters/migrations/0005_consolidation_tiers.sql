-- Consolidation & memory tiers (human-like memory).
-- tier: working (candidate, decays) -> consolidated (durable) -> pinned (human-kept).
-- reinforcement_count strengthens recurring memories; crossing a threshold
-- promotes working -> consolidated. All are runtime/projection metadata, not
-- part of the signed envelope.
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS tier TEXT NOT NULL DEFAULT 'working';
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS reinforcement_count INT NOT NULL DEFAULT 0;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS last_reinforced_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS agent_memory_tier_idx ON agent_memory (trust_domain, tier);

-- Human review queue: near-duplicate writes are NOT merged silently — they are
-- queued for a human to decide merge / keep-separate / reject.
CREATE TABLE IF NOT EXISTS memory_review (
  id BIGSERIAL PRIMARY KEY,
  trust_domain TEXT,
  candidate_uri TEXT,
  similar_uri TEXT,
  similarity REAL,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | merged | kept_separate | rejected
  resolution TEXT,
  resolver TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS memory_review_pending_idx ON memory_review (trust_domain, status);
