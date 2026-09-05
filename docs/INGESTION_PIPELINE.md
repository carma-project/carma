# Ingestion Pipeline

Reasoning traces enter CARMA, become signed JSON-AM `trace://` envelopes, and
are indexed for retrieval. Two ingress paths share one code path
(`server/ingest.ts` → `storeTrace`):

1. build a `trace://` JSON-AM envelope (with provenance),
2. sign it (Ed25519 compact JWS, `server/middleware/jws.ts`),
3. validate it against the guardrails,
4. embed its text (`server/embedding.ts`), and
5. persist the envelope + embedding as a retrievable RAG pointer
   (`agent_memory`).

## Ingress paths

### MCP (any agent harness — provider-neutral)
- **stdio:** run the CARMA MCP server with `npm run mcp` (local harnesses).
- **Streamable HTTP:** `POST /mcp` on the main server (remote harnesses); open a session with an
  authenticated `initialize` (bearer capability token). Connect with any MCP Streamable HTTP client.
- Tool `store_trace({ task, content, boundContext, decision?, outcome?, confidence?, importance?, supersedes? })`
  → returns the memory pointer (`trace://<domain>/...`). Requires `write`.
- Tool `record_outcome({ decisionUri, status, score?, evidence? })` → records how a
  decision turned out (signed `Outcome` envelope + recall weighting). Requires `write`.
- Tool `retract_memory({ uri, reason? })` → excludes a memory from recall, preserved for audit. Requires `write`.
- Tool `search_memory({ query, k })` → precedent recall (reasoning + decision + outcome + lineage)
  ranked by similarity × outcome × recency. Requires `read`.
- A stdio connection is a trusted local channel (all actions); HTTP sessions carry the token's
  actions. Both operate under `TRUST_DOMAIN` and sign with `PRIVATE_KEY`.

### HTTP (capability-gated)
- `POST /memory` (`write`) → stores a decision trace (`{ task, content, boundContext?,
  decision?, outcome?, confidence?, importance?, supersedes? }`), returns the pointer.
- `POST /outcome` (`write`) → `{ decisionUri, status, score?, evidence? }` records an outcome.
- `POST /retract` (`write`) → `{ uri, reason? }` retracts a memory.
- `GET /search?q=...&k=5&domain=acme` (`read`) → precedent recall (reasoning + decision +
  outcome + lineage), outcome/recency-weighted.
- Resolve a stored envelope: `GET /resolve?uri=trace://...` (`read` token).

## RAG index
- Embeddings live in the pgvector `embedding vector(256)` column on
  `agent_memory`; cosine distance (`<=>`) drives ranking (see
  `adapters/migrations/0002_rag_pgvector.sql`).
- The default embedder is local and deterministic (no external API). The
  provider is pluggable via `EMBEDDING_PROVIDER` for a real semantic model.

## Future
- Markdown adapter watching `company/*.md` to auto-create memory envelopes.
- Distillation export via `DistillationAdapter`.
