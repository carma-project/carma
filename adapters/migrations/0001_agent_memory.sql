-- Base agent_memory store for JSON-AM envelopes.
CREATE TABLE IF NOT EXISTS agent_memory (
  id BIGSERIAL PRIMARY KEY,
  uri TEXT UNIQUE,
  kind TEXT,
  trust_domain TEXT,
  envelope JSONB,
  data JSONB,
  signature TEXT,
  content TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Columns kept for compatibility with pre-existing agent_memory tables.
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS uri TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS kind TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS trust_domain TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS envelope JSONB;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS signature TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS content TEXT;

CREATE OR REPLACE VIEW jsonam_envelopes AS
SELECT uri, envelope, trust_domain, signature
FROM agent_memory
WHERE envelope IS NOT NULL;
