# CARMA Rules

## Trust Domain Rules
- trust://cyberorbit: read/write/delegate
- trust://customer-{org}: read/link only
- trust://public: no capability required

## Capability Rules
- JWT must contain jsonam.claims
- Actions limited to domain
- Expires enforced

## Envelope Rules
- All envelopes must have @context
- Signatures required for write
- Provenance chain must be preserved
