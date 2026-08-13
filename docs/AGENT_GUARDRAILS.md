# Agent Guardrails for CARMA

## Capability Enforcement
- Agents must present valid JWT capability token
- Actions limited to token claims
- No cross-trust-domain access without explicit capability

## Envelope Validation
- Verify @context URL
- Verify JWS signature
- Reject envelopes with missing provenance

## URI Validation
- Only memory://, context://, trace://, agent://, trust:// schemes allowed
- No path traversal
- Enforce trust domain prefix

## Audit
- Log all resolves
- Log capability use
- Store audit trail
