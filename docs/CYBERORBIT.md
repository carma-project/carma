# Plumbing Cyberorbit into CARMA

This wires Cyberorbit's own systems into a single, private CARMA container so it
becomes Cyberorbit's **sovereign memory + post-training substrate**: CARMA pulls
context from the repo, the platform database, and the issue tracker; consolidates
it; and distills it into a model Cyberorbit hosts. Everything runs inside the
container — no external cron/CI — and CARMA never needs public exposure.

```
 repos ─┐
 DBs  ──┼─►  CARMA  ── pull (POST /ingest / scheduler)
 GH   ──┘      │      ── consolidate (POST /consolidate, "dreaming")
               └──────── post-train (POST /distill → Fireworks SFT)
                              │
                        a model Cyberorbit owns  ◄── agents recall via MCP / GET /search
```

## 1. Sources

Use [`examples/cyberorbit-sources.json`](examples/cyberorbit-sources.json) as the
starting point. It wires four connectors under trust domain `cyberorbit`:

| id | type | what it brings in |
| --- | --- | --- |
| `cyberorbit-repo` | `git` | agent specs (`.cursor/`, `AGENTS.md`), ADRs (`decisions/`), company-OS docs, **and full commit history** (every change + reasoning; reverts → failure signal) |
| `cyberorbit-findings` | `postgres` | pentest findings + the remediation **decision** taken — the distilled reasoning to post-train on |
| `cyberorbit-tracker` | `github` | issues + PRs (titles, descriptions, **review threads**); merged PR → success, "not planned" → failure |
| `cyberorbit-playbooks` | `http` | optional internal runbooks/playbooks exposed as a JSON API |

Adjust the SQL query and column mapping to your schema, and drop any source that
doesn't apply. Prefer `dsnEnv`/`tokenEnv` (env-var creds) over inlining secrets —
the source's connection string and query are never echoed in `/api/status` or logs.

## 2. Deploy config (Railway service env / Secrets)

On the CARMA service set:

```sh
# identity + signing (generate the Ed25519 keypair once; see docs/DEPLOY_RAILWAY.md)
TRUST_DOMAIN=cyberorbit
PUBLIC_KEY="-----BEGIN PUBLIC KEY----- ..."      # SPKI PEM
PRIVATE_KEY="-----BEGIN PRIVATE KEY----- ..."    # PKCS8 PEM
DATABASE_URL=postgres://…                          # CARMA's OWN store (pgvector)
DATABASE_SSL=require
STRICT_BOOT=true

# native ingestion
SOURCES_FILE=/app/docs/examples/cyberorbit-sources.json   # or paste JSON into SOURCES
INGEST_ON_BOOT=true               # backfill on first deploy
INGEST_SCHEDULER_ENABLED=true     # then keep pulling on each source's intervalMinutes

# source credentials (read-only!) referenced by the sources file
CYBERORBIT_DB_DSN=postgres://readonly:…@…/cyberorbit   # a READ-ONLY role
CYBERORBIT_GITHUB_TOKEN=ghp_…                          # repo:read / issues:read
CYBERORBIT_KB_TOKEN=…                                  # only if using the http source

# post-training uses Fireworks (Cyberorbit's chosen backend; others can BYO)
FINETUNE_PROVIDER=fireworks
FIREWORKS_API_KEY=fw_…
FIREWORKS_ACCOUNT_ID=…
MEMORY_MODEL_PROVIDER=fireworks   # optional: hosted reasoning for dedup/abstraction
```

The runtime image already includes `git`, so the native git connector clones the
repo itself. Migrations run automatically on boot.

## 3. Verify the loop

`GET /api/status` → `ingest.sources[]` shows each source and its last run. Or drive
it manually with a short-lived token (mint from `PRIVATE_KEY`, or via `POST /capability`):

```sh
TOKEN=…   # read+write on trust://cyberorbit

# Pull: preview, then ingest everything (or one source)
curl -s -X POST "$CARMA/ingest" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{"dryRun":true}'
curl -s -X POST "$CARMA/ingest" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{}'

# Consolidate: decay stale, promote proven, dedup, abstract recurring → semantic
curl -s -X POST "$CARMA/consolidate" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{"trustDomain":"cyberorbit"}'

# Post-train: build a signed dataset from the corpus and launch a Fireworks SFT job
curl -s -X POST "$CARMA/distill" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"trustDomain":"cyberorbit","kind":"trace","baseModel":"accounts/fireworks/models/llama-v3p1-8b-instruct"}'
```

## 4. How Cyberorbit agents use it

Recall is provider-neutral — any harness reaches CARMA the same way:

- **MCP** (recommended for agents): point the harness at `POST {MCP_HTTP_PATH}` (`/mcp`) and call
  `search_memory({ query, k })` for precedent, `store_trace(...)` to write new reasoning at end of
  turn/session, `record_outcome(...)` when a decision's result is known.
- **HTTP**: `GET /search?q=…&k=5&domain=cyberorbit` returns precedents ranked by similarity ×
  outcome × recency, carrying the reasoning, decision, outcome, and lineage.

Scoped access without handing out the signing key: enable `POST /capability`
(mTLS-gated) so Cyberorbit services mint short-lived, least-privilege tokens
(see `docs/DEPLOY_RAILWAY.md` and `docs/SECURITY.md`).

## 5. Keeping it private

CARMA stays on Railway private networking; the connectors make **outbound** calls
to the repo/DB/GitHub, so nothing about CARMA is publicly exposed. Give the DB
source a read-only role and the GitHub token read-only scopes — CARMA only ever
reads from your systems and writes into its own store.
