# Architecture

## Components
- API Gateway: /resolve, /memory, /capability
- Security Layer: JWT verify, JWS verify
- URI Resolver: parses scheme and trust domain
- Link Engine: edge registry, graph traversal
- Adapters: Postgres, Markdown, File
- Federation Layer: ANS/DNS-AID

## Data Flow
1. Agent sends request with JWT
2. Security verifies token
3. Resolver routes to adapter
4. Adapter fetches envelope
5. Core signs response
6. Return JWS envelope

## Trust Domains
- acme internal
- customer-*
- public
