# Security Rules and Controls

## Authentication
- JWT capability tokens with EdDSA
- Token expiry enforced
- Key rotation every 90 days

## Authorization
- Trust domain isolation
- Action based permissions
- Resource pattern matching

## Integrity
- JWS signing on all envelopes
- Provenance chain verification
- Replay protection via nonce

## Transport
- TLS 1.3 for HTTP
- MCP over secure channel
- No plaintext secrets

## Auditing
- Log all resolves
- Log capability grants
- Immutable audit trail
