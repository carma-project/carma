-- CARMA agent memory store (JSON-AM envelopes).
-- Safe to run on a fresh database (creates the table) or against an existing
-- agent_memory table (adds the JSON-AM columns).
CREATE TABLE IF NOT EXISTS agent_memory (
  id BIGSERIAL PRIMARY KEY,
  data JSONB
);

-- Map existing agent_memory to JSON-AM envelopes
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS uri TEXT UNIQUE;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS envelope JSONB;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS trust_domain TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS signature TEXT;

-- Example view for JSON-AM
CREATE OR REPLACE VIEW jsonam_envelopes AS
SELECT uri, envelope, trust_domain, signature
FROM agent_memory
WHERE envelope IS NOT NULL;
