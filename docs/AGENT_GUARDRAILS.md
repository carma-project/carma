# Agent Guardrails

## Capability Enforcement
- Every request must include JWT capability token
- Token claims validated: iss, aud, exp, nbf, iat
- jsonam.domains must intersect with URI trust domain
- jsonam.actions must include requested action
- jsonam.resources pattern must match URI

## Envelope Validation
- Verify @context == https://json-am.org/context/v0.1
- Verify JWS signature using trust domain public key
- Verify provenance chain is unbroken
- Reject envelopes with expired issuedAt

## URI Validation
- Allowed schemes: memory, context, trace, agent, trust
- Path must not contain .. or // traversal
- Trust domain prefix must match token

## Rate Limiting
- 100 req/min per token
- 1000 req/min per trust domain

## Audit
- Log all resolves
- Log capability grants
- Alert on 3 failed auth attempts
