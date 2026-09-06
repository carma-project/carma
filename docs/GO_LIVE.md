# Go live: connect your systems and start the memory loop

This is the provider-neutral runbook for standing CARMA up for **your** organization.
You deploy one private CARMA container plus its own pgvector Postgres. CARMA makes
**outbound** pulls from your systems (repo, database, issue tracker, internal APIs),
consolidates what it learns, optionally distills it into a model you host, and serves
recall to any agent harness. CARMA itself never needs to be publicly exposed.

```
 repos ─┐
 DBs  ──┼─►  CARMA  ── pull (POST /ingest / scheduler)
 GH   ──┤      │      ── consolidate (POST /consolidate, "dreaming")
 APIs ──┘      └──────── post-train (POST /distill → your finetune backend)
                              │
                        a model you own  ◄── agents recall via MCP / GET /search
```

Substitute your own values for the placeholders (`your-org`, `acme`, `<APP_URL>`,
`SRC_*` env names). Deployment examples use Railway; any host that runs a Node 20
container against a pgvector Postgres works the same way. Railway specifics live in
[`DEPLOY_RAILWAY.md`](DEPLOY_RAILWAY.md).

---

## 1. Provision Postgres with pgvector

CARMA's migration runs `CREATE EXTENSION IF NOT EXISTS vector`, so the database **must**
ship pgvector — a stock Postgres image will fail to migrate. Use a pgvector image or
template (e.g. `pgvector/pgvector:pg16`). You'll end up with a `DATABASE_URL` for it.
This is CARMA's **own** store, separate from any database you ingest from.

## 2. Generate an Ed25519 keypair (once)

CARMA verifies capability tokens with a public key and signs stored envelopes with a
private key (both Ed25519 PEM):

```bash
node -e '
const { generateKeyPairSync } = require("crypto");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log(publicKey.export({ type: "spki",  format: "pem" }));
console.log(privateKey.export({ type: "pkcs8", format: "pem" }));
'
```

The public key becomes `PUBLIC_KEY`, the private key `PRIVATE_KEY`. Keep the private
key in your secret store only.

## 3. Deploy CARMA and set core env

Deploy this repo (its `Dockerfile` `CMD` runs `migrate && start`; migrations are
idempotent and advisory-locked, so they run automatically on every boot). Set:

```sh
# identity + signing + CARMA's own store
TRUST_DOMAIN=acme                 # your default domain for ingest/search
PUBLIC_KEY="-----BEGIN PUBLIC KEY----- ..."     # SPKI PEM from step 2
PRIVATE_KEY="-----BEGIN PRIVATE KEY----- ..."   # PKCS8 PEM from step 2
DATABASE_URL=postgres://…         # the pgvector store from step 1
DATABASE_SSL=require              # 'disable' if you connect over private networking
STRICT_BOOT=true                  # fail fast if keys/DB/schema are missing

# expose the MCP Streamable HTTP transport for agents
MCP_HTTP_ENABLED=true             # served at MCP_HTTP_PATH (default /mcp)

# native ingestion (runs inside the container — no external cron/CI)
SOURCES_FILE=/app/docs/examples/sources.example.json   # your sources (see step 4)
INGEST_ON_BOOT=true               # backfill on first deploy
INGEST_SCHEDULER_ENABLED=true     # then keep pulling on each source's intervalMinutes
```

Do **not** set `PORT` — the host injects it and the server honors it. The runtime image
already includes `git`, so the git connector clones repos itself.

Optional, for post-training (§7):

```sh
FINETUNE_PROVIDER=fireworks       # or 'local'; others can be added
FIREWORKS_API_KEY=…
FIREWORKS_ACCOUNT_ID=…
MEMORY_MODEL_PROVIDER=fireworks   # optional hosted reasoning for dedup/abstraction
```

## 4. Configure your sources

Sources are a JSON array, supplied via `SOURCES` (inline JSON) or `SOURCES_FILE` (a path).
Copy [`examples/sources.example.json`](examples/sources.example.json) and keep only the
connectors you need. Four connector types ship today:

| type | locator | brings in |
| --- | --- | --- |
| `git` | `url` (+ `repo`, `branch`) | markdown docs (`docs:true`) — agent specs, ADRs, company-OS files — and full commit history (`history:true`); a revert becomes a failure signal |
| `postgres` | `dsnEnv` (or `dsn`/`url`) | rows from your `query`, mapped by `columns` (`id`, `title`, `content`, `date`, and optionally `decision`) |
| `github` | `repo` | issues + PRs (titles, descriptions, `includeComments` review threads); merged PR → success, "not planned" → failure |
| `http` | `url` | records from a JSON API — `itemsPath` locates the array, `fields` maps record keys |

Guidelines:

- **Credentials via env indirection.** Reference secrets with `tokenEnv` / `dsnEnv`
  (e.g. `SRC_GITHUB_TOKEN`, `SRC_DB_DSN`) and set those env vars on the service — never
  inline a DSN or token in the JSON. A source's connection string and query are never
  echoed in `/api/status` or logs.
- **Least privilege.** Give database sources a **read-only** role and tokens read-only
  scopes. CARMA only ever reads from your systems and writes into its own store.
- **Cadence.** `intervalMinutes` sets the scheduler cadence per source; `0` means
  manual-only (`POST /ingest`).
- **Weighting (optional).** `confidence` / `importance` (0–1) seed how strongly a
  source's items count in recall and consolidation.

Set the source credentials on the service, e.g.:

```sh
SRC_GITHUB_TOKEN=ghp_…            # repo:read / issues:read (private repos + github source)
SRC_DB_DSN=postgres://readonly:…@…/yourdb    # a READ-ONLY role
SRC_HTTP_TOKEN=…                  # only if you keep an http source
```

## 5. First boot: migrate + backfill

On deploy the container migrates the schema, then (with `INGEST_ON_BOOT=true`) does a
one-time backfill of every source. Confirm it's healthy:

```sh
curl <APP_URL>/health     # -> ok           (liveness)
curl <APP_URL>/ready      # -> 200 when keys + DB + schema are ready
```

`GET <APP_URL>/api/status` reports readiness booleans and `ingest.sources[]` with each
source's last run. The built-in config UI at `/` shows the same diagnostics. Note: by default the
full `/api/status` detail requires a read token (anonymous callers get only coarse readiness); set
`STATUS_PUBLIC=true` for anonymous detail, or `UI_ENABLED=false` to disable the UI. See
[`EXPOSURE.md`](EXPOSURE.md) for the recommended no-public-listener (Zero-Trust tunnel) topology.

## 6. Verify end-to-end (smoke test)

The image is `node:20-alpine` (no `curl`/`jq`), so run the bundled Node smoke test from
the service shell — it mints a short-lived token in-process and exercises
`ingest → outcome → search → consolidate(dry-run)`, printing per-step checks:

```sh
npm run smoke            # override target/domain with: npm run smoke -- --url … --domain … --k 5
```

## 7. Drive the loop manually (with a scoped token)

Mint a short-lived capability token (needs `PRIVATE_KEY`; run from the service shell):

```sh
TOKEN=$(npm run --silent mint-token -- --domains trust://acme --actions read,write --ttl 1h)

# Pull: preview, then ingest everything (or add {"sourceId":"…"} for one source)
curl -s -X POST "<APP_URL>/ingest" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{"dryRun":true}'
curl -s -X POST "<APP_URL>/ingest" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{}'

# Consolidate ("dreaming"): decay stale, promote proven, dedup, abstract recurring → semantic
curl -s -X POST "<APP_URL>/consolidate" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{"trustDomain":"acme"}'

# Post-train (optional): build a signed dataset and launch an SFT job on your backend
curl -s -X POST "<APP_URL>/distill" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  --data '{"trustDomain":"acme","kind":"trace","baseModel":"<your-base-model>"}'
```

## 8. Wire your agents to recall

Recall is provider-neutral — any harness reaches CARMA the same way:

- **MCP (recommended for agents).** Point the harness at `POST <APP_URL>/mcp` with
  `Authorization: Bearer <token>`. Tools:
  - `wake({ task })` — at session start (or after a context compaction) to reload the
    agent's durable identity + recent decisions (and precedent for `task`), so
    personality/self-understanding survive.
  - `search_memory({ query, k })` — precedent ranked by similarity × outcome × recency.
  - `store_trace(...)` — write new reasoning at end of turn/session.
  - `record_outcome(...)` — when a decision's result becomes known.
- **HTTP.** `GET <APP_URL>/search?q=…&k=5&domain=acme` returns the same ranked
  precedents, each carrying the reasoning, decision, outcome, and lineage.

## 9. Scoped tokens without sharing the signing key (optional)

By default tokens are minted out-of-band with `npm run mint-token`. To let services
request short-lived, least-privilege tokens without ever holding `PRIVATE_KEY`, enable
the mTLS-gated `POST /capability` endpoint (`CAPABILITY_ENDPOINT_ENABLED=true`) and bound
it with `CAPABILITY_DOMAINS`, `CAPABILITY_MAX_ACTIONS`, `CAPABILITY_MAX_TTL`. A presented
still-valid token can only narrow a refresh, never escalate. See
[`DEPLOY_RAILWAY.md`](DEPLOY_RAILWAY.md) §3 and [`SECURITY.md`](SECURITY.md).

## 10. Keep it private

Put CARMA on private networking. The connectors make **outbound** calls to your
repo/DB/tracker/APIs, so nothing about CARMA needs public exposure. Read-only source
credentials + a private CARMA endpoint mean the only thing leaving your perimeter is
what you explicitly point a connector at.

For external agent sessions that live outside your network, reach CARMA over a
Zero-Trust tunnel (Cloudflare Tunnel+Access or Tailscale) rather than a public port,
and lock down the anonymous surface (`STATUS_PUBLIC` unset, optionally
`UI_ENABLED=false`). The full topology, token-provisioning patterns for MCP
harnesses, and self-hosted model (vLLM/Ollama) options are in [`EXPOSURE.md`](EXPOSURE.md).
