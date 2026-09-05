# Security Rules and Controls

> Implementation status is annotated inline: **[done]** implemented in this repo,
> **[partial]** partially implemented, **[planned]** on the roadmap. See `AGENTS.md`
> for the operational knobs (env vars) behind these controls.

## 1. Authentication
- **[done]** All requests must present a JWT capability token in `Authorization: Bearer <token>`
- **[done]** Tokens signed with EdDSA using the trust domain private key (`server/capability.ts`)
- **[partial]** Token validation includes exp/nbf/iat (via `jose`); iss/aud checks are planned
- **[done]** Token lifetime max 15 min write / 60 min read — enforced per action
  (`enforceTokenLifetime`, configurable via `TOKEN_MAX_AGE_*`)
- **[done]** Issuance/refresh endpoint `POST /capability` gated by mTLS client cert
  (`server/mtls.js`, `server/capability_issue.js`). Off by default
  (`CAPABILITY_ENDPOINT_ENABLED`); identity is a verified client cert (direct TLS,
  `MTLS_MODE=direct`) or a trusted proxy's forwarded identity (`MTLS_MODE=proxy`).
  Issued grants are bounded by policy (`CAPABILITY_DOMAINS`, `CAPABILITY_MAX_ACTIONS`,
  `CAPABILITY_MAX_TTL`) and, on refresh, by any presented token — refresh can never
  escalate. Clients never hold the signing key.

## 2. Authorization
- **[done]** Trust domain isolation enforced at the resolver (`enforceCapability`)
- **[done]** Actions: read, write, link, delegate (read/write exercised by the API)
- **[planned]** Resource-pattern glob matching (resources claim is carried but not yet matched)
- **[done]** Access decisions recorded in the audit log

## 3. Integrity
- **[done]** Envelopes signed with JWS Ed25519 (`server/middleware/jws.ts`)
- **[done]** Canonical (recursively key-sorted) JSON encoding before signing — stable across
  Postgres JSONB round-trips; `verifyEnvelope` re-checks the body against the signature
- **[partial]** Signature verified before serving — verification helper exists and is tested;
  serve-path auto-verification is planned
- **[partial]** Provenance recorded on each envelope; immutability relies on the append-only store

## 4. Transport
- **[partial]** TLS mandatory in production — terminate at the platform/proxy in front of
  CARMA. When `MTLS_MODE=direct`, CARMA itself terminates TLS (min TLS 1.2) so it can
  verify client certs for `POST /capability`.
- **[done]** MCP over stdio (trusted local) and Streamable HTTP (`POST /mcp`); HTTP sessions
  require a bearer capability token and enforce per-session actions (read/write). Terminate TLS
  at the platform/proxy in front of the HTTP transport.
- **[done]** HSTS available via `HSTS_ENABLED`; no secrets in URLs (tokens are headers only)

## 5. Auditing
- **[done]** Append-only `audit_log` table (`adapters/migrations/0003_audit_log.sql`)
- **[done]** Logs URI, actor, action, trust domain, result, request id, timestamp
- **[planned]** Retention policy (1 year) and alerting on capability misuse

## 6. Key Management
- **[planned]** Keys in KMS/Vault (currently supplied as env PEMs — use a secret manager in prod)
- **[planned]** Rotation every 90 days; old keys retained 30 days for verification (kid header is
  emitted to support rotation)
