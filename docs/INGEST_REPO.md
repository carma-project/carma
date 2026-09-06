# Connecting a GitHub repo to CARMA memory

Turn the knowledge you already have — agent specs, decision records (ADRs), and
"company OS" markdown — into **recallable institutional memory**. Once ingested,
your agents can pull the relevant precedent at decision time via `GET /search` or
the MCP `search_memory` tool, instead of re-deriving it from scratch.

There are two ways to get a repo in, and they share the same extraction logic
(`server/ingest/extract.ts`), so a repo looks identical however it arrives:

- **Native ingestion (recommended):** CARMA pulls configured sources into its own memory,
  in-process, on a schedule — no external cron/CI, no round-trip token. This is the acquisition
  side of the memory architecture, the counterpart to the `dream` consolidation pass. See §0.
- **External importers:** `scripts/ingest-repo.mjs` / `scripts/ingest-git.mjs` push a repo into
  CARMA via `POST /memory` from anywhere with network access to CARMA. Use these for air-gapped
  sources CARMA can't reach, or ad-hoc backfills. See §1–§2c.

Both cover "everything in the repo": current **markdown** (specs, ADRs, OS docs) *and* **git
history** — the reasoning behind every change, with original dates preserved (§2b). Content is
classified and upserted as signed JSON-AM `trace://` envelopes under deterministic, idempotent URIs.

## 0. Native ingestion (CARMA pulls the repo itself)

Declare your systems as **sources** and CARMA maintains its own memory from them — the same way it
already runs consolidation ("dreaming") internally. Nothing external is required; the standalone
container clones/updates the repo and stores memory itself (its runtime image ships with `git`).

Configure `SOURCES` (inline JSON) or `SOURCES_FILE` (a path to that JSON):

```jsonc
// SOURCES = [ ... ]
[
  {
    "id": "handbook",                       // stable id (used for scheduling/state)
    "type": "git",                          // only connector today; more coming
    "url": "https://github.com/acme/handbook.git",  // or a local path CARMA can read
    "repo": "acme/handbook",                // slug for URIs (auto-derived if omitted)
    "branch": "main",                        // optional
    "docs": true,                            // ingest markdown (default true)
    "history": true,                         // ingest git commits (default true)
    "intervalMinutes": 60,                   // scheduler cadence; 0/omitted = manual only
    "tokenEnv": "HANDBOOK_GIT_TOKEN"         // env var with a PAT for private https clones
  }
]
```

Then either trigger a pull on demand or let the scheduler do it:

```sh
# On demand (write capability). Omit sourceId to run every source; dryRun previews counts.
curl -s -X POST "$CARMA_URL/ingest" -H "Authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' --data '{"sourceId":"handbook"}'

# Automatic: set once on the CARMA service
INGEST_ON_BOOT=true               # backfill all sources shortly after startup
INGEST_SCHEDULER_ENABLED=true     # then pull each source on its intervalMinutes
```

Config vars: `SOURCES` / `SOURCES_FILE`, `INGEST_WORK_DIR` (checkout cache, default
`/tmp/carma-sources`), `INGEST_ON_BOOT`, `INGEST_SCHEDULER_ENABLED`, `INGEST_SCHEDULER_TICK_MS`.
`GET /api/status` reports each source and its last run under `ingest.sources[]`.

Because native ingestion runs server-internal (trusted, like `dream`), it signs memory with the
server's `PRIVATE_KEY` directly — no capability token is minted for the write path. Bulk pulls skip
per-write near-duplicate review (that would flood the queue); run `POST /consolidate` (`npm run
dream`) afterwards to dedup and abstract. This closes the loop entirely inside the container:
**pull** (ingest) → **consolidate** (dream) → **post-train** (`POST /distill`).

### More than git: pluggable connectors

`git` is one connector. The same source registry (and the same `POST /ingest` / scheduler / status)
also supports pulling from other systems, so CARMA draws on "repos for history, databases for all
info, multiple systems for context":

| `type` | pulls | key fields |
| --- | --- | --- |
| `git` | markdown + commit history | `url`/`path`, `repo?`, `branch?`, `docs?`, `history?`, `tokenEnv?` |
| `postgres` | rows from a read-only SQL query | `dsnEnv`/`dsn`, `query`, `columns:{id,title,content,date?,decision?}`, `ssl?` |
| `http` | a JSON list from any API | `url`, `itemsPath?`, `fields:{id,title,content,date?,decision?}`, `tokenEnv?`, `headers?` |
| `github` | issues + PRs (with comment threads) | `repo:"owner/name"`, `tokenEnv?`, `state?`, `since?`, `maxPages?`, `includeComments?` |

The `github` connector also derives outcome signal (merged PR → success, "not planned" → failure).
Connectors live in `server/ingest/connectors/`; adding one never touches the write path. For a full,
multi-system wiring see [`CYBERORBIT.md`](CYBERORBIT.md) and
[`examples/cyberorbit-sources.json`](examples/cyberorbit-sources.json).

## How files are mapped

| Signal | Result |
| --- | --- |
| path under `decisions/`, `adr/`, `adr-*.md`, `*-decision.md`, or front-matter `type: decision` | **decision** — sets `decision.choice`, salience `confidence 0.85 / importance 0.9` |
| path under `agents/`, `specs/`, `.cursor/`, `AGENTS.md`, `*.agent.md`, or `type: agent-spec` | **agent-spec** — authoritative, `confidence 0.9 / importance 0.85` |
| any other markdown | **doc** — `confidence 0.8 / importance 0.7` |

Those salience defaults mean specs/decisions/OS docs enter as the **`consolidated`**
tier (recall-boosted, exempt from decay), not transient `working` memory.

Front-matter (optional, YAML `--- ... ---`) overrides everything:

```markdown
---
type: decision          # decision | agent-spec | doc
confidence: 0.95        # 0..1, overrides the default
importance: 0.9         # 0..1
supersedes: trace://cyberorbit/gh/acme/handbook/decisions/adr-000-old.md
---
# Decision title becomes decision.choice
```

### Sectioning & idempotency

Files are split at `#`/`##` headings so recall returns the *relevant section*, not a
whole handbook. Each section gets a **deterministic URI**:

```
trace://<domain>/gh/<owner>/<repo>/<path>#<heading-slug>
```

Because `POST /memory` upserts on URI, re-running updates in place — safe to run on
every push. Pass `--no-split` to store one memory per file.

## 1. One-time backfill (local)

```sh
# from a CARMA checkout; PRIVATE_KEY is the Ed25519 PKCS8 PEM CARMA runs with
PRIVATE_KEY="$(cat priv.pem)" npm run ingest-repo -- \
  --dir /path/to/your/knowledge-repo \
  --url https://carma.up.railway.app \
  --domain cyberorbit \
  --repo cyberorbit/handbook \
  --dry-run          # preview classification; drop --dry-run to ingest
```

Flags: `--dir` (source, default `.`), `--url` (CARMA base URL), `--domain` (trust
domain), `--repo` (owner/repo slug for URIs; auto-detected from git remote if omitted),
`--exclude a,b` (skip paths containing these substrings), `--no-split`, `--dry-run`.

Auth precedence: `--token` / `CARMA_TOKEN`, else mint a short-lived token from
`PRIVATE_KEY`.

## 2. Continuous sync (GitHub Actions)

Copy [`examples/carma-sync.yml`](examples/carma-sync.yml) into your knowledge repo at
`.github/workflows/carma-sync.yml`. On every push touching markdown it re-ingests the
changed docs.

Configure two repo secrets:

- `CARMA_URL` — your deployment, e.g. `https://carma.up.railway.app`
- `CARMA_PRIVATE_KEY` — the Ed25519 PKCS8 PEM (same `PRIVATE_KEY` CARMA runs with)

> **Why the key, not a static token?** CARMA age-caps *write* tokens (default 15 min),
> so a long-lived token stored as a secret would be rejected. The importer mints a fresh
> short-lived token per run. For a stricter posture, front CARMA with an mTLS proxy and
> issue tokens via `POST /capability` (see `docs/DEPLOY_RAILWAY.md`) instead of putting
> the signing key in CI.

## 2b. Ingest git history (the *why* behind every change)

If "all your company history lives in the repo," most of it is in **git history**, not just
the current markdown. `scripts/ingest-git.mjs` (`npm run ingest-git`) imports commits as dated
decisions so that reasoning is recallable too:

```sh
PRIVATE_KEY="$(cat priv.pem)" npm run ingest-git -- \
  --dir /path/to/your/repo --url https://carma.up.railway.app \
  --domain cyberorbit --repo cyberorbit/app --max 100000     # full backfill
# incremental (e.g. nightly):  --since "30 days ago"   or  --since 2024-01-01
```

- Each commit → `trace://<domain>/gh/<repo>/commit/<sha>` with `decision.choice` = the subject
  and the body as reasoning. Immutable shas make it idempotent.
- **Chronology is preserved:** the commit's author date is sent as `occurredAt`, which sets the
  envelope `issuedAt` and the stored `created_at` that recall's recency decay reads. A backfill of
  years of history keeps its real timeline instead of collapsing to "now". (`provenance.createdAt`
  still records the ingest time for audit.)
- **Outcome signal from history:** a `Revert …` commit records a `failure` outcome on the commit it
  undoes, so recall learns which changes didn't hold.
- Commits enter the **`working`** tier (episodic — they decay unless recalled/reinforced), while
  curated docs/ADRs from the markdown importer are `consolidated`. Run `npm run dream` periodically
  to consolidate recurring patterns and let stale one-offs fade.

Flags mirror the markdown importer plus `--branch`, `--since`, `--until`, `--max`, `--no-outcomes`.

## 2c. When CARMA is private (not on the public internet)

> **Simplest answer: use native ingestion (§0).** If CARMA can reach the repo (public GitHub, or a
> git host inside your network), let CARMA pull it — `SOURCES` + `INGEST_SCHEDULER_ENABLED` need no
> external runner at all. The options below are for the reverse case: CARMA is private *and* you
> prefer to push from an external box, or the source is somewhere only that box can reach.

The importer makes an **outbound** connection to CARMA, so it just has to run somewhere with
network access to your CARMA URL. GitHub-hosted Actions runners live on the public internet and
**cannot reach a private CARMA** — so run the sync inside your network instead. Three options:

1. **Self-hosted GitHub runner (in your network).** Keep [`carma-sync.yml`](examples/carma-sync.yml)
   but change `runs-on: ubuntu-latest` → `runs-on: self-hosted` (a runner registered inside the VPC
   that can reach CARMA). Everything else is identical.
2. **Internal scheduler.** Run [`scripts/sync-repo.sh`](../scripts/sync-repo.sh) from any in-network
   cron/systemd timer or in-VPC CI. It runs both importers for a checked-out repo:
   ```sh
   CARMA_URL=http://carma.internal:7100 TRUST_DOMAIN=cyberorbit \
   REPO_DIR=/srv/repo REPO_SLUG=cyberorbit/app PRIVATE_KEY="$(cat priv.pem)" \
     ./scripts/sync-repo.sh            # add --dry-run to preview
   ```
3. **Railway cron service (recommended for a Railway deployment).** Build the tiny
   [`Dockerfile.sync`](examples/Dockerfile.sync) job image (CARMA + `git`) and deploy it as a **cron**
   service in the *same Railway project* as CARMA. It reaches CARMA over private networking
   (`http://carma.railway.internal:PORT`) and clones your repo each run
   ([`sync-entrypoint.sh`](examples/sync-entrypoint.sh)):
   ```sh
   docker build -f docs/examples/Dockerfile.sync -t carma-sync .
   ```
   Set on the cron service: `REPO_URL`, `CARMA_URL=http://carma.railway.internal:<port>`,
   `TRUST_DOMAIN`, `PRIVATE_KEY`, and `GIT_TOKEN` (for a private repo). CARMA never leaves the
   private network.

> **Heads-up:** the git-history importer shells out to `git`, which is **not** in CARMA's
> `node:20-alpine` runtime image. Use a box/image that has `git` (the `Dockerfile.sync` image adds
> it); the markdown importer needs only `node`.
>
> **Credentials:** write tokens are age-capped (~15 min), so mint per run from `PRIVATE_KEY` rather
> than storing a long-lived token. If you'd rather not place the signing key in the sync job, front
> CARMA with an mTLS proxy and issue tokens via `POST /capability` (see `docs/DEPLOY_RAILWAY.md`).

## 3. How your agents recall it

Any agent/harness recalls precedent the same way — HTTP or MCP, provider-agnostic:

```sh
curl -s "$CARMA_URL/search?q=why%20did%20we%20pick%20postgres&k=3&domain=cyberorbit" \
  -H "Authorization: Bearer $TOKEN"
```

Results are ranked by similarity × outcome × recency and carry the reasoning,
`decision`, `outcome`, `lineage`, and tier. Over MCP, point the harness at
`POST {MCP_HTTP_PATH}` (`/mcp`) and call `search_memory` — see `docs/MCP` in `AGENTS.md`.

## Keeping knowledge current

- **Revisions:** when a decision changes, add `supersedes:` front-matter pointing at the
  old memory URI; recall then returns only the new head, with lineage preserved.
- **Outcomes:** record how a decision turned out with `POST /outcome` so recall prefers
  reasoning that actually worked.
- **Consolidation:** near-duplicates across docs are queued for human review (never merged
  silently); run `npm run dream` / `POST /consolidate` to maintain the corpus over time.
