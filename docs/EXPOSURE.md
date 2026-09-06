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
