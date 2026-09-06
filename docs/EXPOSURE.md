# Exposure & network posture

CARMA holds an organization's most sensitive asset — the accumulated reasoning,
decisions, and (for a security org) findings behind them. Treat its network
exposure accordingly. This doc covers what is exposed, how to run CARMA with **no
public listener**, and how external agent sessions still reach it.

## What's exposed

**Data plane — capability-gated.** Every endpoint that touches memory requires an
Ed25519-signed, scoped, TTL'd capability token (`resolve`, `memory`, `search`,
`wake`, `outcome`, `retract`, `pin`, `reviews`, `distill`, `finetune`,
`consolidate`, `ingest`, and the MCP transport at `/mcp`). An anonymous caller
gets `403`.

**Unauthenticated surface — minimized.**

- `GET /health` — liveness only (`ok`). Always open (probes/orchestrators need it).
- `GET /ready` — readiness booleans (keys/DB/schema). Open.
- `GET /api/status` — **coarse** by default: anonymous callers get only
  `{ ready, components:{…} }`. The full detail (trust domain, configured sources
  incl. repo slugs, ingest state) requires a **read capability**. Set
  `STATUS_PUBLIC=true` to expose the full detail anonymously (local/dev only).
- `GET /` and `/ui` — the config UI. Set `UI_ENABLED=false` to stop serving it
  (returns `404`) in hardened deployments.

Source secrets (`dsn`/`url`/`query`/tokens) never appear in `/api/status` or logs
regardless of the above.

## Recommended posture: no public listener

The strongest and simplest posture is to give CARMA **no public inbound port at
all** and reach it over a Zero-Trust overlay:

```
 external agent session ──(identity-gated edge)──►  tunnel  ──►  CARMA (private)
   (Claude/Cursor/…)                                             no public port
```

1. Run CARMA on private networking (e.g. Railway private `*.railway.internal`), no
   public domain. Keep `MCP_HTTP_ENABLED=true` so agents use MCP over HTTP.
2. Front it with one of:
   - **Cloudflare Tunnel + Access** — CARMA dials *out* to the tunnel; there is no
     port to scan. Access authenticates each caller (SSO or service tokens) at the
     edge.
   - **Tailscale / WireGuard** — CARMA joins a private tailnet; only tailnet
     members (laptops, agent hosts) can reach it. ACLs scope who.
3. In-VPC agents (e.g. product/back-end services) can talk to CARMA directly on the
   private network without the tunnel.

Nothing about CARMA is publicly reachable in this model; the connectors it uses to
ingest are **outbound** (git/DB/GitHub/HTTP), so no inbound exposure is required
for ingestion either.

### Reaching a private CARMA from off-network agents

Two concrete recipes for the overlay above; both keep CARMA with **no public port**.
CARMA is agnostic to which you use (or neither, for in-VPC agents that reach the
private address directly) — networking is a pluggable deployment concern, not a
built-in.

**Railway — Tailscale Forwarder (managed sidecar).** When CARMA runs on Railway
private networking (`*.railway.internal`, which only resolves inside the project),
add the **Tailscale Forwarder** template to the same project to bridge your tailnet
into that private network — no code, nothing exposed publicly:

1. In the Tailscale admin console, create a **reusable** auth key.
2. Project canvas → Create → Choose Template → **Tailscale Forwarder**.
3. Configure it:
   - `TS_AUTHKEY` = the reusable key.
   - `TS_STATE_DIR=/app/data` **and mount a volume at `/app/data`** (stable node
     identity; avoids a duplicate machine on every restart).
   - `CONNECTION_MAPPING_1=https:7100:${{carma.RAILWAY_PRIVATE_DOMAIN}}:${{carma.PORT}}`
     — the `https:` prefix has the forwarder terminate TLS with a cert for its
     tailnet machine name (needs MagicDNS + HTTPS enabled on the tailnet); drop it
     for plain TCP (still WireGuard-encrypted over the tailnet).
4. Join your laptop / agent host to the same tailnet, then point the MCP client at
   `https://<forwarder-machine-name>:7100/mcp` (e.g.
   `carma-project-production-tailscale-forwarder`) with the bearer token.

Note `railway connect --tunnel-only` is **database-only**, so it can't tunnel the
MCP port; use the forwarder (durable) or, for a quick one-off, a native
`ssh -N -L 7100:localhost:<CARMA_PORT> <copied-target>@ssh.railway.com` forward and
point the client at `http://localhost:7100/mcp`.

**Self-hosted Docker — Tailscale sidecar.** For a Docker host you control, run a
Tailscale sidecar next to CARMA so CARMA is served *on the tailnet* and binds no host
port. See [`../docker-compose.tailscale.yml`](../docker-compose.tailscale.yml): a
`tailscale` service joins the tailnet and `carma` shares its network namespace, so
tailnet members reach `http://carma:7100/mcp` and nobody else can. (This uses a
kernel `tun` device; on hosts that forbid one, use a userspace forwarder like the
Railway template above instead.)

**Cloudflare Tunnel + Access** is the equivalent recipe when you want an
identity-gated public hostname rather than an overlay: `cloudflared` dials out from
beside CARMA, and Access authenticates each caller (SSO / service token) at the edge.

### If a public endpoint is unavoidable

Put an mTLS-terminating proxy or authenticating gateway in front (verify a client
cert / OAuth / IP allowlist), and keep `STATUS_PUBLIC` unset and `UI_ENABLED=false`
so the anonymous surface is just `/health`. CARMA's mTLS-gated `POST /capability`
(`MTLS_MODE=proxy`) already fits behind such a proxy for token issuance.

## Tokens for external MCP harnesses

Most MCP harnesses (Claude Desktop, Cursor, …) take a **static** `Authorization`
bearer, not a mint-then-connect flow. Two patterns:

- **Edge-injected token (best):** the Access edge (a Cloudflare Worker / small
  sidecar) calls `POST /capability` for the authenticated user and injects the
  short-lived token as the request header — users never handle tokens.
- **Per-agent scoped token:** mint a medium-TTL, least-privilege token via
  `npm run mint-token` / `POST /capability`, put it in the harness config, and
  rotate on a schedule.

Capability tokens are least-privilege: scope them to the minimum domain + actions
the agent needs (`read` for recall, `write` to also store traces/outcomes).

## Self-hosted models are part of sovereignty

Keeping the model in your perimeter is the same instinct as keeping CARMA private.
CARMA's model layer is provider-neutral:

- **Recall / inference:** any OpenAI-compatible model — a self-hosted **vLLM** or
  **Ollama** — reaches the corpus via MCP (`/mcp`) or `GET /search`.
- **CARMA's own reasoning (dreaming/abstraction):** set
  `MEMORY_MODEL_PROVIDER=openai` and `INFERENCE_BASE_URL=http://vllm:8000/v1`
  (or an Ollama endpoint) — keyless is fine. Falls back to the offline `local`
  model on any error, so consolidation never breaks.
- **Post-training:** `POST /distill` builds a signed OpenAI-compatible dataset;
  the `local` provider exports it so you can fine-tune on your own GPUs
  (e.g. **Unsloth**) and serve via vLLM — a model you own end-to-end. See
  `docs/DISTILLATION.md`.

## Near-term note (single principal)

With a single trust domain and one operator, per-identity capability scoping is not
needed yet — one least-privilege token (or edge-injected token) suffices. When more
agents/roles are added, introduce per-function trust domains and a per-identity
issuance policy at the `POST /capability` layer.
