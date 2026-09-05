-- Append-only audit trail (docs/SECURITY.md §5). Records every access decision:
-- actor, action, URI, trust domain, result, and request id.
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGSERIAL PRIMARY KEY,
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT,
  action TEXT,
  uri TEXT,
  trust_domain TEXT,
  result TEXT,
  request_id TEXT,
  detail JSONB
);

CREATE INDEX IF NOT EXISTS audit_log_ts_idx ON audit_log (ts DESC);
CREATE INDEX IF NOT EXISTS audit_log_actor_idx ON audit_log (actor);
CREATE INDEX IF NOT EXISTS audit_log_trust_domain_idx ON audit_log (trust_domain);
