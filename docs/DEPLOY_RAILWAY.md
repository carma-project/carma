# Deploying CARMA on Railway

CARMA is a Node 20 service that needs a **pgvector-enabled Postgres**. On Railway you
run two services in one project: a Postgres (with the `vector` extension) and the
CARMA app. Migrations run automatically on boot.

## 1. Provision Postgres with pgvector

CARMA's migration `0002_rag_pgvector.sql` runs `CREATE EXTENSION IF NOT EXISTS vector`,
so the database **must** ship pgvector. Railway's default Postgres image does not.
Pick one:

- Add the **pgvector** template from the Railway marketplace, or
- Deploy a Postgres service from a pgvector image (e.g. `pgvector/pgvector:pg16`).

Either way you get a `DATABASE_URL` variable on that service.

## 2. Generate an Ed25519 keypair

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

Keep the private key secret. You can rotate later by re-issuing tokens.

## 3. Create the CARMA service

Deploy this repo (Railway uses `railway.toml` → Nixpacks). Set variables on the CARMA
service:

| Variable | Value | Notes |
| --- | --- | --- |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` | Reference the Postgres service variable. |
| `DATABASE_SSL` | `require` | Use `require` for the public proxy URL; `disable` if you use the private `*.railway.internal` host. |
| `TRUST_DOMAIN` | e.g. `acme` | Default domain for ingest/search. |
| `PUBLIC_KEY` | *(SPKI PEM)* | Paste the multi-line public key from step 2. |
| `PRIVATE_KEY` | *(PKCS8 PEM)* | Paste the multi-line private key from step 2. |
| `STRICT_BOOT` | `true` | Recommended: fail fast if keys/DB are missing. |
| `MCP_HTTP_ENABLED` | `true` | Optional: expose the MCP Streamable HTTP transport at `/mcp`. |

Do **not** set `PORT` — Railway injects it and the server honors it.

Multi-line values (the PEM keys) paste fine in Railway's variable editor; keep the
`-----BEGIN/END-----` lines intact.

## 4. Deploy

On boot the start command runs `node adapters/migrate.mjs` (idempotent,
advisory-locked) then starts the server. A fresh deploy therefore migrates the schema
automatically. The healthcheck path is `/health` (liveness); `/ready` reports full
readiness (keys + DB + schema).

If the DB isn't reachable or lacks pgvector, migration fails and the deploy is marked
failed — check the deploy logs for `failed  0002_rag_pgvector.sql` (extension missing)
or a connection/SSL error.

## 5. Verify

```bash
curl https://<your-app>.up.railway.app/health         # -> ok
curl https://<your-app>.up.railway.app/ready           # -> 200 when fully ready
curl https://<your-app>.up.railway.app/api/status | jq # booleans: publicKey, privateKey, db, rag, audit
```

The built-in configuration UI is at `/` and shows the same readiness diagnostics.

## Troubleshooting

- **`type "vector" does not exist` / `CREATE EXTENSION ... vector` failed** — the
  Postgres image doesn't include pgvector. Use a pgvector image/template (step 1).
- **`self-signed certificate` / SSL errors during migrate or at runtime** — set
  `DATABASE_SSL=require` (public proxy) or `disable` (private networking).
- **Endpoints return `403`** — `PUBLIC_KEY` isn't set/valid, or the request lacks a
  capability token. Mint one with `npm run mint-token` (needs `PRIVATE_KEY`).
- **Deploy healthcheck fails but logs show `carma_listening`** — the healthcheck path
  must be `/health` (set in `railway.toml`).
