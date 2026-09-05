-- RAG index: store an embedding vector alongside each JSON-AM pointer so
-- memories/traces can be retrieved by semantic similarity, not just exact URI.
CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS embedding vector(256);

CREATE INDEX IF NOT EXISTS agent_memory_embedding_idx
  ON agent_memory USING hnsw (embedding vector_cosine_ops);
