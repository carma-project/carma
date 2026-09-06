# CARMA — Context Addressable Reasoning and Memory Architecture

Reference implementation of JSON-AM v0.1.3-draft.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

CARMA resolves `memory://`, `context://`, `trace://` URIs over HTTP, verifies JWT capability tokens, signs envelopes with JWS Ed25519, ingests reasoning traces into a pgvector-backed RAG index, and exposes memories/traces as MCP tools and resources.

## For companies

In the AI era, models are rented and commoditizing — your durable advantage is
**owned, portable, governed memory of your own reasoning**. CARMA is the open,
self-hostable substrate for that layer:

- **Own your memory, avoid lock-in.** An open standard (JSON-AM) + MCP means any
  agent or model plugs into the same memory you control — not a vendor's silo.
- **Governed by design.** Trust-domain isolation, least-privilege capability
  tokens, Ed25519-signed provenance, and an append-only audit log make agent
  memory safe for regulated and multi-tenant use.
- **Reasoning as reusable capital.** Traces are retrievable by meaning (RAG) and
  can be distilled into specialized models — interaction history becomes an asset.

See [`docs/WHY_CARMA.md`](docs/WHY_CARMA.md) for the full rationale, including how
[Cyberorbit](docs/WHY_CARMA.md#applied-carma-on-cyberorbit-ai-pentesting) uses
CARMA as the governed memory/trace store for AI pentesting.

## Quick start

```bash
# Ed25519 keys for signing (PRIVATE_KEY) and token verification (PUBLIC_KEY)
docker compose up -d --build   # app on :7100, pgvector Postgres, migrations auto-applied
```

Open `http://localhost:7100/` for the configuration/readiness UI.

### Ingest a trace and search (RAG)

```bash
# HTTP: mint a write token, store a trace, then search
TOKEN=$(PRIVATE_KEY="$(cat priv.pem)" npm run --silent mint-token -- --domains trust://acme --actions read,write)
curl -sX POST localhost:7100/memory -H "Authorization: Bearer $TOKEN" \
  -d '{"task":"configure db","content":"set DATABASE_URL and run migrations"}'
curl -s "localhost:7100/search?q=database%20connection&k=5" -H "Authorization: Bearer $TOKEN"
```

### Decision memory & precedent recall

Every trace can record the **decision** made and, later, its **outcome**; knowledge can be
**revised** (`supersedes`) or **retracted**. Recall then returns *precedents* — the reasoning, the
choice, and how it turned out — ranked by a blend of semantic similarity, outcome signal (reasoning
that *worked* resurfaces), and recency, over the accumulated corpus of all decisions. Superseded and
retracted memories are excluded from recall but preserved for audit and lineage. Schema:
JSON-AM v0.1.3-draft ([`docs/JSON-AM.md`](docs/JSON-AM.md)).

```bash
# store a decision, then record how it turned out; recall prefers what worked
URI=$(curl -sX POST localhost:7100/memory -H "Authorization: Bearer $TOKEN" \
  -d '{"task":"exploit redis","content":"unauth redis on 6379","decision":{"choice":"module-load RCE"}}' | jq -r .uri)
curl -sX POST localhost:7100/outcome -H "Authorization: Bearer $TOKEN" \
  -d "{\"decisionUri\":\"$URI\",\"status\":\"success\",\"score\":0.9,\"evidence\":\"got code exec\"}"
curl -s "localhost:7100/search?q=redis%20rce&k=5" -H "Authorization: Bearer $TOKEN"
```

### Connect any agent (MCP, provider-neutral)

CARMA speaks the open [Model Context Protocol](https://modelcontextprotocol.io) over **two
transports**, so any MCP-compatible harness — regardless of framework or model provider — can
recall and store memory. Tools: `store_trace`, `record_outcome`, `retract_memory`, `search_memory`;
resources: `memory://<domain>/*`.

- **Local harnesses** (Claude Desktop, Cursor, LangGraph, custom SDK clients): `npm run mcp` (stdio).
- **Remote harnesses**: MCP Streamable HTTP at `POST /mcp` on the main server. Open a session with
  an `initialize` carrying a bearer capability token; per-session permissions come from that token
  (`read` for search/resource reads, `write` for `store_trace`/`record_outcome`/`retract_memory`).

### Distill your reasoning into a hostable model

Turn accumulated traces into a fine-tune job on a pluggable provider (bring your
own model backend; `fireworks` and an offline `local` provider are built in):

```bash
# local (offline) provider: exports chat-JSONL + a signed dataset manifest
npm run distill -- --domain acme --kind trace

# Fireworks AI supervised fine-tuning
FINETUNE_PROVIDER=fireworks FIREWORKS_API_KEY=... FIREWORKS_ACCOUNT_ID=... \
  npm run distill -- --domain acme --base-model accounts/fireworks/models/llama-v3p1-8b-instruct
```

See [`docs/DISTILLATION.md`](docs/DISTILLATION.md).

## Deploy for your organization

To stand CARMA up for your own org — deploy privately, connect your repo/database/issue
tracker/internal APIs, and start the ingest → consolidate → distill → recall loop — follow
the provider-neutral runbook in [`docs/GO_LIVE.md`](docs/GO_LIVE.md) (host-specific notes for
Railway are in [`docs/DEPLOY_RAILWAY.md`](docs/DEPLOY_RAILWAY.md)). Copy
[`docs/examples/sources.example.json`](docs/examples/sources.example.json) as your sources
template.

## Endpoints
- `GET /` — configuration/readiness UI · `GET /api/status` — deploy diagnostics
- `GET /health` — liveness · `GET /ready` — readiness
- `POST /memory` — ingest a decision trace (write) · `GET /search?q=` — precedent recall (read)
- `POST /outcome` — record how a decision turned out (write) · `POST /retract` — retract a memory (write)
- `GET /resolve?uri=` — resolve an envelope (read)
- `POST /distill` — distill reasoning into a fine-tune job (distill) · `GET /finetune?jobId=` — job status (read)
- `POST /mcp` — MCP Streamable HTTP transport for remote agent harnesses (capability-gated)

## Scripts
- `npm run dev` / `npm start` — run the HTTP server
- `npm run migrate` — apply Postgres migrations (pgvector)
- `npm run mcp` — run the MCP server over stdio (HTTP transport is served at `/mcp` by `npm start`)
- `npm run mint-token` — issue a capability token
- `npm run distill` — distill reasoning/memory into a fine-tune job
- `npm test` — unit + integration + MCP tests

## Sites
- Spec: https://json-am.org
- Implementation: https://carma.json-am.org

## License
Apache 2.0
