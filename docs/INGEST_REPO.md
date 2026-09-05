# Connecting a GitHub repo to CARMA memory

Turn the knowledge you already have — agent specs, decision records (ADRs), and
"company OS" markdown — into **recallable institutional memory**. Once ingested,
your agents can pull the relevant precedent at decision time via `GET /search` or
the MCP `search_memory` tool, instead of re-deriving it from scratch.

Two importers cover "everything in the repo":

- `scripts/ingest-repo.mjs` (`npm run ingest-repo`) — current **markdown** (specs, ADRs, OS docs).
- `scripts/ingest-git.mjs` (`npm run ingest-git`) — **git history**, the reasoning behind every
  change, with original dates preserved (see §2b).

Both walk the source, classify content, and upsert signed JSON-AM `trace://` envelopes via
`POST /memory` under deterministic, idempotent URIs.

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
