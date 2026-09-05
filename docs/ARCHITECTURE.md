# Architecture

## Components
- API Gateway: `/resolve`, `/memory` (ingest), `/outcome`, `/retract`, `/search` (recall), `/distill`, `/api/status`, `/` (config UI)
- Security Layer: JWT capability verify (`server/middleware/jwt.ts`), JWS envelope sign/verify (`server/middleware/jws.ts`)
- URI Resolver: parses scheme and trust domain
- Ingest: build → sign → embed → persist; decision/outcome/lineage (`server/ingest.ts`, JSON-AM v0.1.3-draft — see `docs/JSON-AM.md`)
- Precedent recall: pgvector similarity blended with outcome signal + recency, active-only (`server/embedding.ts`, `server/recall.ts`, `adapters/postgres.ts`)
- MCP server: `store_trace`, `search_memory`, resource reads over stdio + Streamable HTTP
  (`server/mcp/`, `POST /mcp`) — harness/provider-agnostic, capability-gated on HTTP
- Adapters: Postgres (Markdown, File future)
- Federation Layer: ANS/DNS-AID (future)

## Read data flow (`/resolve`, `/search`)
1. Agent sends request with a capability JWT
2. Security verifies the token and enforces domain/action
3. Resolver routes to the adapter (exact URI or precedent recall)
4. Adapter fetches the envelope, or ranks active memories by similarity × outcome × recency
5. Return the JSON-AM envelope(s), or precedents (reasoning + decision + outcome + lineage)

## Outcome + revision flow (`/outcome`, `/retract`, `supersedes`)
1. `POST /outcome` writes a signed `Outcome` envelope referencing the decision and updates the decision's denormalized outcome columns (recall weighting)
2. A `supersedes` on ingest marks the prior version `superseded` (excluded from recall); the new envelope records the backward `lineage.supersedes` link
3. `POST /retract` sets `status=retracted` — excluded from recall, preserved for audit

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
