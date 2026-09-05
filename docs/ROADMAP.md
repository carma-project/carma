# CARMA Roadmap

## Phase 1 - Prototype ✓
- [x] Spec draft
- [x] Basic server skeleton
- [x] Docs

## Phase 2 - Production Ready
- [x] Full JWS signing/verification — Ed25519 compact JWS over canonical envelope
      JSON (`server/middleware/jws.ts`); envelopes are signed on ingest and
      verifiable via `verifyEnvelope`.
- [x] Postgres adapter with migrations — versioned, idempotent migrations
      (`adapters/migrations/*.sql`) applied by `npm run migrate`.
- [x] JWT capability issuance — `issueCapability` (`server/capability.ts`) + the
      `npm run mint-token` CLI. (A full mTLS-gated `POST /capability` refresh
      endpoint per docs/SECURITY.md is still future work.)
- [x] MCP server implementation — `store_trace` / `search_memory` tools and
      Postgres-backed resource reads over **stdio and Streamable HTTP**
      (`server/mcp/`, `POST /mcp`). Provider/harness-agnostic; HTTP sessions are
      capability-token gated with per-session action enforcement.
- [x] Tests and CI — unit + integration + MCP tests (`npm test`) and a GitHub
      Actions workflow with a pgvector service.

## Phase 2.5 - Trace ingestion & RAG ✓
- [x] Trace ingestion — `POST /memory` and the MCP `store_trace` tool build a
      signed JSON-AM `trace://` envelope and persist it.
- [x] RAG index — pgvector `embedding` column + pluggable embeddings
      (`server/embedding.ts`, local deterministic default); `GET /search` and the
      MCP `search_memory` tool return JSON-AM pointers ranked by similarity.
- [ ] Pluggable external embedding providers (e.g. hosted embeddings API) — the
      provider interface exists; only the local provider is implemented.

## Phase 2.6 - Production hardening ✓ (in progress)
- [x] Central validated config + fail-fast `STRICT_BOOT` + redacted boot summary
- [x] Per-action token-lifetime ceilings (`enforceTokenLifetime`)
- [x] Append-only audit log (`audit_log`) on every access decision
- [x] Per-client rate limiting (429 + `Retry-After`)
- [x] Input hardening (body/content/boundContext/k limits) + consistent JSON errors
- [x] Structured JSON logs + per-request `X-Request-Id`; security headers
- [x] `/ready` readiness probe; graceful shutdown; crash guards
- [x] DB SSL modes + pool sizing/timeouts; advisory-locked migrations
- [ ] mTLS-gated `POST /capability` issuance/refresh
- [ ] iss/aud token checks + resource-pattern glob matching
- [ ] Serve-path signature auto-verification; KMS/Vault-backed keys + rotation

## Phase 2.7 - Distillation & fine-tuning ✓
- [x] Dataset builder: signed traces -> OpenAI-compatible chat JSONL
- [x] Pluggable `FineTuneProvider` (bring-your-own model backend)
- [x] `local` provider (offline export + simulated job) and `fireworks` provider
      (Fireworks AI SFT: create/upload dataset + launch job + status)
- [x] `POST /distill` + `GET /finetune` + `npm run distill` CLI
- [x] Signed, addressable dataset manifest (`memory://.../dataset/...`) with full
      source-trace provenance; distillation is `distill`-gated and audited
- [ ] Job lifecycle tracking table + webhooks; auto-deploy of the hosted model
- [ ] DPO/RFT and eval-set support; external embedding + reranking for selection

## Phase 3 - Ecosystem
- [ ] Federation via ANS
- [ ] Bridge adapters (Markdown, File)
- [~] Web UI — a built-in configuration/readiness UI ships at `/`; a full
      management UI is still open.
