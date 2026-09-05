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
- **[planned]** Refresh endpoint `POST /capability` requires mTLS client cert

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
- **[planned]** TLS 1.3 mandatory (terminate at the platform/proxy in front of CARMA)
- **[partial]** MCP over stdio (trusted local) today; TLS WebSocket transport planned
- **[done]** HSTS available via `HSTS_ENABLED`; no secrets in URLs (tokens are headers only)

## 5. Auditing
- **[done]** Append-only `audit_log` table (`adapters/migrations/0003_audit_log.sql`)
- **[done]** Logs URI, actor, action, trust domain, result, request id, timestamp
- **[planned]** Retention policy (1 year) and alerting on capability misuse

## 6. Key Management
- **[planned]** Keys in KMS/Vault (currently supplied as env PEMs — use a secret manager in prod)
- **[planned]** Rotation every 90 days; old keys retained 30 days for verification (kid header is
  emitted to support rotation)
