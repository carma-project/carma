# Architecture

## Components
- API Gateway: `/resolve`, `/memory` (ingest), `/search` (RAG), `/api/status`, `/` (config UI)
- Security Layer: JWT capability verify (`server/middleware/jwt.ts`), JWS envelope sign/verify (`server/middleware/jws.ts`)
- URI Resolver: parses scheme and trust domain
- Ingest: build → sign → embed → persist (`server/ingest.ts`)
- RAG index: pgvector embeddings + cosine search (`server/embedding.ts`, `adapters/postgres.ts`)
- MCP server: `store_trace`, `search_memory`, resource reads over stdio + Streamable HTTP
  (`server/mcp/`, `POST /mcp`) — harness/provider-agnostic, capability-gated on HTTP
- Adapters: Postgres (Markdown, File future)
- Federation Layer: ANS/DNS-AID (future)

## Read data flow (`/resolve`, `/search`)
1. Agent sends request with a capability JWT
2. Security verifies the token and enforces domain/action
3. Resolver routes to the adapter (exact URI or vector search)
4. Adapter fetches the envelope / ranked pointers
5. Return JSON-AM envelope(s)

## Write data flow (`/memory`, MCP `store_trace`)
1. Caller submits a trace (HTTP `write` token, MCP HTTP session with `write`, or trusted MCP stdio)
2. Build a `trace://` JSON-AM envelope with provenance
3. Sign the envelope (Ed25519 JWS) and validate guardrails
4. Embed the trace text
5. Persist envelope + embedding as a retrievable RAG pointer

## Trust Domains
- acme internal
- customer-*
- public
