# Setup Guide

The full, provider-neutral runbook is [`GO_LIVE.md`](GO_LIVE.md); operator reference
(every endpoint, env var, and script) is [`../AGENTS.md`](../AGENTS.md). This page is
the short version.

## Prerequisites
Node 20+, Docker, Postgres 15+ **with pgvector** (`pgvector/pgvector:pg16` works).

## Local
1. Generate an Ed25519 key pair (see `GO_LIVE.md` §2):
   ```bash
   node -e '
   const { generateKeyPairSync } = require("crypto");
   const { publicKey, privateKey } = generateKeyPairSync("ed25519");
   console.log(publicKey.export({ type: "spki", format: "pem" }));
   console.log(privateKey.export({ type: "pkcs8", format: "pem" }));'
   ```
2. Export `PUBLIC_KEY` and `PRIVATE_KEY` (the compose file reads them from the shell
   or a local `.env`, which is git-ignored).
3. `docker compose up --build` — starts pgvector Postgres, applies
   `adapters/migrations/*.sql`, and serves CARMA on `:7100`.
4. `curl http://localhost:7100/health` → `ok`; `curl http://localhost:7100/ready` → `200`
   once keys, database and schema are all good.

Every data endpoint needs a capability token:

```bash
TOKEN=$(PRIVATE_KEY="$(cat private.pem)" npm run --silent mint-token -- --domains trust://acme --actions read,write)
curl -s "http://localhost:7100/search?q=database&k=5" -H "Authorization: Bearer $TOKEN"
```

Optional: set `JWT_ISSUER` / `JWT_AUDIENCE` on the server and the tokens you mint
will carry and be checked for matching `iss` / `aud` claims.

## Railway
1. Connect the repo (it builds from the `Dockerfile`; migrations run on every boot).
2. Add a pgvector Postgres service and point `DATABASE_URL` at it — reference the
   database service's own variables rather than hand-typing credentials.
3. Set `PUBLIC_KEY`, `PRIVATE_KEY`, `TRUST_DOMAIN` (and `DATABASE_SSL=require` for
   managed Postgres over TLS).
4. Deploy. Step-by-step notes: [`DEPLOY_RAILWAY.md`](DEPLOY_RAILWAY.md).

## Checks
```bash
npm test          # unit + DB-free HTTP tests; integration/MCP tests run when DATABASE_URL is set
npm run smoke     # end-to-end against a running server (mints a token in-process)
```
