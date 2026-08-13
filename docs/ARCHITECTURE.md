# Architecture

CARMA = Context Addressable Reasoning and Memory Architecture

## Trust Domains
- trust://cyberorbit — internal Company AI
  Capabilities: read + write + delegate
  Data: signals, worldview, lessons, maxims

- trust://customer-{org} — Orbit customer-facing AI
  Capabilities: read + link only
  Data: findings, reports, CVE, MITRE

## Clients
Primary client today: Claude via MCP
Hermes agent is spec author, Company AI is internal orchestrator

## Flow
1. Claude requests memory://cyberorbit/sem/worldview with Bearer JWT
2. CARMA verifies JWT, resolves via Postgres adapter
3. Returns signed JWS envelope
