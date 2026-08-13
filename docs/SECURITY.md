# Security Rules and Controls

## 1. Authentication
- All requests must present a JWT capability token in `Authorization: Bearer <token>`
- Tokens signed with EdDSA using trust domain private key
- Token validation includes iss, aud, exp, nbf, iat checks
- Token lifetime max 15 minutes for write, 60 minutes for read
- Refresh endpoint POST /capability requires mTLS client cert

## 2. Authorization
- Trust domain isolation enforced at URI resolver
- Actions: read, write, link, delegate
- Resource patterns enforced via glob matching
- Capability grants audited in provenance chain

## 3. Integrity
- All envelopes signed with JWS Ed25519
- Signature verified before serving
- Provenance chain immutable
- Canonical JSON encoding before signing

## 4. Transport
- TLS 1.3 mandatory
- MCP over WebSocket with TLS
- HSTS enabled
- No secrets in URLs

## 5. Auditing
- Append-only audit log
- Log URI, actor, action, timestamp, result
- Retention 1 year
- Alerts on capability misuse

## 6. Key Management
- Keys stored in KMS/Vault
- Rotation every 90 days
- Old keys kept for verification 30 days
