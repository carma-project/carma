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

Deploy this repo. `railway.toml` sets `builder = "DOCKERFILE"`, so Railway builds the
container from the repo `Dockerfile` (whose `CMD` runs `migrate && start`). To deploy a
**prebuilt image** instead, use Railway's *Deploy from Docker Image* — that path ignores
`railway.toml`'s builder; just set the healthcheck path to `/health` in the service settings.

Set variables on the CARMA service:

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

### Optional: mTLS-gated token issuance (`POST /capability`)

By default, tokens are minted out-of-band with `npm run mint-token` (needs `PRIVATE_KEY`).
Enable `POST /capability` so clients (e.g. Cyberorbit) request scoped, short-lived tokens
without ever holding the signing key. It is **off by default** and gated by a verified
client certificate.

Railway terminates TLS at its edge and does **not** perform client-certificate mTLS there,
so pick one of:

- **`MTLS_MODE=proxy`** (works on Railway) — put your own mTLS-terminating proxy (nginx,
  Envoy, a gateway) in front of CARMA. The proxy verifies the client cert and forwards the
  identity plus a shared secret. Set `CAPABILITY_ENDPOINT_ENABLED=true`, `MTLS_MODE=proxy`,
  `CAPABILITY_PROXY_SECRET=<random>`, and have the proxy send `x-proxy-authorization: <secret>`,
  `x-client-subject: <cn>` (optionally `x-client-verify: SUCCESS`, `x-client-fingerprint: <sha256>`).
- **`MTLS_MODE=direct`** (self-hosted / L4 passthrough) — CARMA terminates TLS itself. Set
  `TLS_CERT`, `TLS_KEY`, and `CAPABILITY_CLIENT_CA` (PEMs); the listener becomes HTTPS and
  verifies client certs against that CA.

Bound what can be issued with `CAPABILITY_DOMAINS` (default `TRUST_DOMAIN`),
`CAPABILITY_MAX_ACTIONS` (default `read,write`), and `CAPABILITY_MAX_TTL` (default `15m`).
A presented (still-valid) token narrows the refreshed grant — refresh can never escalate.

## 4. Deploy

On boot the start command runs `node adapters/migrate.mjs` (idempotent,
advisory-locked) then starts the server. A fresh deploy therefore migrates the schema
automatically. The healthcheck path is `/health` (liveness); `/ready` reports full
readiness (keys + DB + schema).

If the DB isn't reachable or lacks pgvector, migration fails and the deploy is marked
failed — check the deploy logs for `failed  0002_rag_pgvector.sql` (extension missing)
or a connection/SSL error.

## 5. Verify

From your machine (the app must be publicly exposed):

```bash
curl https://<your-app>.up.railway.app/health         # -> ok
curl https://<your-app>.up.railway.app/ready           # -> 200 when fully ready
curl https://<your-app>.up.railway.app/api/status | jq # booleans: publicKey, privateKey, db, rag, audit
```

The built-in configuration UI is at `/` and shows the same readiness diagnostics.

### End-to-end smoke test (from inside the container)

The container image is `node:20-alpine`, which ships without `curl` or `jq`. Instead
of installing those, run the bundled Node smoke test from the service shell
(Railway dashboard → your service → Shell, or `railway ssh`):

```sh
npm run smoke
```

It reads `PORT`, `TRUST_DOMAIN`, and `PRIVATE_KEY` from the environment, mints a
short-lived capability token in-process, then exercises the full path against
`http://localhost:$PORT`: `/api/status` (readiness), `POST /memory` (ingest a
decision), `POST /outcome` (record the result), `GET /search` (precedent recall,
confirming the outcome comes back), and `POST /consolidate` (a dream dry-run). It
prints per-step checks and exits non-zero if any fail. Override the target with
`--url`, `--domain`, or `--k`, e.g. `npm run smoke -- --k 5`.

## Troubleshooting

- **`type "vector" does not exist` / `CREATE EXTENSION ... vector` failed** — the
  Postgres image doesn't include pgvector. Use a pgvector image/template (step 1).
- **`self-signed certificate` / SSL errors during migrate or at runtime** — set
  `DATABASE_SSL=require` (public proxy) or `disable` (private networking).
- **Endpoints return `403`** — `PUBLIC_KEY` isn't set/valid, or the request lacks a
  capability token. Mint one with `npm run mint-token` (needs `PRIVATE_KEY`).
- **Deploy healthcheck fails but logs show `carma_listening`** — the healthcheck path
  must be `/health` (set in `railway.toml`).
