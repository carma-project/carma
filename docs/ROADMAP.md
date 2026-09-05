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
- [x] JWT capability issuance — `issueCapability` (`server/capability.ts`), the
      `npm run mint-token` CLI, and the mTLS-gated `POST /capability`
      issuance/refresh endpoint (`server/mtls.js`, `server/capability_issue.js`).
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
- [x] mTLS-gated `POST /capability` issuance/refresh — client-cert (direct TLS) or
      trusted-proxy identity; policy-bounded grants, refresh cannot escalate; off by
      default (`CAPABILITY_ENDPOINT_ENABLED`). `server/mtls.js`, `server/capability_issue.js`.
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

## Phase 2.8 - Decision memory & precedent recall ✓
- [x] JSON-AM v0.1.3-draft (additive): `decision`, `outcome`, `lineage`,
      `confidence`, `importance`, `status` on traces + a first-class `Outcome`
      envelope type (`src/schema.ts`, `docs/JSON-AM.md`).
- [x] Outcome recording — signed `Outcome` envelope + denormalized columns via
      `POST /outcome` / MCP `record_outcome`.
- [x] Revision & retraction — `supersedes` on ingest marks prior versions
      superseded; `POST /retract` / MCP `retract_memory` excludes from recall
      while preserving audit/lineage.
- [x] Precedent recall — similarity × outcome × recency ranking over active
      memories; results carry reasoning + decision + outcome + lineage
      (`adapters/postgres.ts`, `server/recall.ts`); weights configurable.
- [x] Consolidation on write — near-duplicate detection enqueues a human review
      (`merge`/`keep_separate`/`reject`) instead of silent merge; reinforcement
      count feeds recall + tier promotion; `working`→`consolidated`→`pinned`
      tiers; `POST /pin`, `GET /reviews`, `POST /reviews/resolve`
      (`adapters/postgres.ts`, `server/ingest.ts`, migration `0005`).
- [x] "Dreaming" — offline consolidation job (`npm run dream` / `POST /consolidate`,
      `server/consolidate/dream.ts`): decay/evict stale `working` memories (→ `archived`),
      recompute salience/tier from outcomes, batch near-duplicate clustering into the
      review queue **with a model-proposed resolution**, and episodic→semantic abstraction
      of recurring decisions into signed, recall-indexed `Semantic` memories. `dryRun`
      supported. Reasoning via the pluggable, provider-neutral memory model
      (`server/memory/model.ts`; `local` default, `fireworks` optional).
- [x] Episodic→semantic abstraction — recurring precedents on a task condense into a
      reusable principle (`Semantic` envelope, migration additive) that feeds distillation
      (selectable as `kind=semantic`).
- [x] "Waking up" — session-start priming (`server/wake/wake.ts`, `POST /wake`, MCP `wake` tool +
      `memory://<domain>/wake` resource): composes the agent's durable identity (pinned + semantic
      principles + agent-specs), recent decisions, and (with a task) relevant precedent into a
      `digest`. The MCP `initialize` response carries that brief as server `instructions`
      (`MCP_WAKE_INSTRUCTIONS`), so a harness reloads the agent's self on connect — the recall
      counterpart to ingest (acquire) and dream (consolidate), and the fix for a context-window
      compaction erasing an agent's personality/self-understanding. Read-only compose (no writes).
- [ ] Outcome-weighted dataset selection for fine-tuning — prefer success/pinned/reinforced,
      exclude retracted/superseded/failure when building the training corpus.
- [ ] LLM-assisted resolution is currently *proposal-only*; auto-apply high-confidence NOOP/UPDATE
      merges behind a policy flag (still human-reversible) is future work.
- [ ] Governed cross-domain (federated) recall.

## Phase 2.9 - Consolidation research (Mem0, arXiv:2504.19413) — planned
Informed by "Mem0: Building Production-Ready AI Agents with Scalable Long-Term Memory".
- [x] LLM-assisted consolidation proposal — the dream dedup pass runs the configured
      (provider-neutral) memory model to classify each near-duplicate (merge / keep_separate /
      reject, mapping Mem0's ADD/UPDATE/DELETE/NOOP) and pre-fills the human review recommendation
      (`proposed_resolution`/`proposed_reason`, migration `0006`). Human still decides; CARMA keeps
      append-only + supersede (Mem0^g's "mark invalid, don't delete") rather than physical deletion.
- [x] Extraction / gisting (episodic→semantic) — the dream abstract pass condenses recurring
      decisions on a task into a concise `Semantic` principle for cheap recall (recall the gist,
      resolve full envelopes on demand). Local extractive summarizer by default; hosted chat model
      optional. Next: gist single verbose traces too, and a compact recall mode that returns gists.
- [ ] Async summary refresh — background per-domain summary that provides global context to
      extraction/consolidation without blocking the write path (Mem0's async summary module).
- [ ] Optional relationship/graph layer — evolve `boundContext`/`lineage` into a
      (decision)-[informed_by]->(precedent), (decision)-[produced]->(outcome) graph for
      multi-hop/temporal precedent queries (Mem0^g helped most on temporal/open-domain).
- [ ] Eval harness — LLM-as-judge recall-quality eval (LOCOMO-style) to measure precedent
      recall accuracy vs. token/latency cost as weights and consolidation policy change.

## Phase 2.10 - Native ingestion & the sovereign pipeline ✓ (in progress)
The vision: a standalone CARMA container is not a passive brain but a **sovereign
AI substrate** a company owns — it pulls context from its own systems, consolidates
it, and post-trains a model on that distilled reasoning. The whole loop runs *inside*
the container, no external orchestration required:
**pull** (ingest) → **consolidate** (dream) → **post-train** (distill).
- [x] Source registry — connector-agnostic source definitions via `SOURCES` /
      `SOURCES_FILE` (`server/ingest/sources.ts`), surfaced in `GET /api/status`.
- [x] Native git connector — CARMA clones/fast-forwards a repo and ingests its
      markdown **and** git history in-process via `storeTrace` (no HTTP, no token),
      preserving commit chronology and revert outcomes (`server/ingest/run.ts`,
      shared extractors in `server/ingest/extract.ts`). Runtime image now ships `git`.
- [x] Trigger surfaces — on-demand `POST /ingest` (write-gated, `dryRun`, per-source
      or all) and an internal scheduler (`INGEST_ON_BOOT`, `INGEST_SCHEDULER_ENABLED`,
      per-source `intervalMinutes`) — the acquisition counterpart to the dream scheduler.
- [x] Unified extraction — the standalone CLIs (`ingest-repo`/`ingest-git`) and the
      native engine share one extractor, so external push and internal pull are identical.
- [x] More connectors — pluggable connector registry (`server/ingest/connectors/`) with
      `git`, `postgres` (read-only SQL query → memory), `http` (JSON API list → memory), and
      `github` (issues/PRs + comment threads; merged/closed → outcome signal). Adding a
      connector never touches the write path. Cyberorbit wiring: `docs/CYBERORBIT.md` +
      `docs/examples/cyberorbit-sources.json`.
- [ ] Chat/other connectors (Slack, Linear, Jira) — same registry; likely thin wrappers over `http`.
- [ ] Incremental/state-aware pulls — persist per-source cursors (last commit/sha,
      high-water marks) in the DB so scheduled runs only fetch deltas at scale.
- [ ] Self-driving pipeline — optional post-ingest `dream` + threshold-triggered
      `distill`, so acquisition → consolidation → post-training runs unattended.
- [ ] PR/issue ingestion (titles, descriptions, review threads) via the GitHub API —
      where much of the decision discussion actually lives.

## Phase 3 - Ecosystem
- [ ] Federation via ANS
- [ ] Bridge adapters (Markdown, File)
- [~] Web UI — a built-in configuration/readiness UI ships at `/`; a full
      management UI is still open.
