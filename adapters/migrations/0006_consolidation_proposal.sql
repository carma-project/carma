-- Offline consolidation ("dreaming") support.
-- A review may carry a machine-proposed resolution (from the pluggable memory
-- model) that pre-fills the human decision. The human still resolves the review;
-- CARMA never merges/rejects on the model's say-so alone. `source` records how the
-- review was raised: 'ingest' (on write) or 'dream' (offline batch consolidation).
ALTER TABLE memory_review ADD COLUMN IF NOT EXISTS proposed_resolution TEXT; -- merge | keep_separate | reject
ALTER TABLE memory_review ADD COLUMN IF NOT EXISTS proposed_reason TEXT;
ALTER TABLE memory_review ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'ingest';

-- Distinct pair lookup so the dream job doesn't re-enqueue an open review for the
-- same near-duplicate pair (either ordering).
CREATE INDEX IF NOT EXISTS memory_review_pair_idx
  ON memory_review (trust_domain, candidate_uri, similar_uri, status);
