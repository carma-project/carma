# CARMA Rules

## Trust Domain Rules
- trust://acme: internal, read/write/delegate
- trust://customer-* : read/link only
- trust://public: no capability required

## Capability Rules
- JWT issued by trust authority
- Max lifetime 60 min read, 15 min write
- Scopes: domains, actions, resources
- Revocation checked on each request

## Envelope Rules
- All envelopes must have @context, id, type, uriScheme, trustDomain, version, issuedAt, provenance
- MemoryRecord requires memoryKind
- ATIR requires task and boundContext
- Signatures required for write

## Link Rules
- Links must reference existing URIs
- Edge types from registry only
- No cycles in provenance
