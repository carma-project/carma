# CARMA — Context Addressable Reasoning and Memory Architecture

Reference implementation of JSON-AM v0.1.2-draft.

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](https://www.apache.org/licenses/LICENSE-2.0)

CARMA resolves `memory://`, `context://`, `trace://` URIs over HTTP, verifies JWT capability tokens, signs envelopes with JWS Ed25519, ingests reasoning traces into a pgvector-backed RAG index, and exposes memories/traces as MCP tools and resources.

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

Agents can instead use the MCP server (`npm run mcp`): tools `store_trace` and `search_memory`.

## Endpoints
- `GET /` — configuration/readiness UI · `GET /api/status` — deploy diagnostics
- `GET /health` — liveness
- `POST /memory` — ingest a trace (write) · `GET /search?q=` — semantic search (read)
- `GET /resolve?uri=` — resolve an envelope (read)

## Scripts
- `npm run dev` / `npm start` — run the HTTP server
- `npm run migrate` — apply Postgres migrations (pgvector)
- `npm run mcp` — run the MCP server (stdio)
- `npm run mint-token` — issue a capability token
- `npm test` — unit + integration + MCP tests

## Sites
- Spec: https://json-am.org
- Implementation: https://carma.json-am.org

## License
Apache 2.0
