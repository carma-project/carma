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

### MCP (agents / Claude, etc.)
- Run the CARMA MCP server: `npm run mcp` (stdio).
- Tool `store_trace({ task, content, boundContext })` → returns the memory
  pointer (`trace://<domain>/...`).
- Tool `search_memory({ query, k })` → JSON-AM pointers ranked by similarity.
- A stdio connection is treated as a trusted local channel; tools operate under
  `TRUST_DOMAIN` and sign with `PRIVATE_KEY`.

### HTTP (capability-gated)
- `POST /memory` with a `write` capability token → stores a trace, returns the
  pointer.
- `GET /search?q=...&k=5&domain=acme` with a `read` token → ranked pointers.
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
