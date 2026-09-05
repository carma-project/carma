-- Decision/outcome model + memory lineage (JSON-AM v0.1.3-draft).
-- These columns are a denormalized projection of the signed envelope so recall
-- can filter/rank without parsing JSONB. The envelope remains the source of
-- truth and stays immutable; outcomes and supersessions update columns only.
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'active';
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS supersedes TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS superseded_by TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS outcome_status TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS outcome_score REAL;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS outcome_uri TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS confidence REAL;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS importance REAL;

-- Recall filters on (trust_domain, status) and excludes non-active rows.
CREATE INDEX IF NOT EXISTS agent_memory_status_idx ON agent_memory (status);
CREATE INDEX IF NOT EXISTS agent_memory_domain_status_idx ON agent_memory (trust_domain, status);
