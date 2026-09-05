# Why CARMA

## The one-line thesis

In the AI era, models are rented and commoditizing; the durable advantage is a
company's **owned, portable, governed memory of its own reasoning**. CARMA is
the open substrate for owning that layer instead of renting it inside a vendor's
chat product.

## What CARMA is

CARMA (Context Addressable Reasoning and Memory Architecture) is a self-hostable
reference implementation of **JSON-AM** — a spec that treats memory and
reasoning as *addressable, signed, permissioned resources*:

- `memory://` / `context://` / `trace://` URIs address durable knowledge and
  reasoning traces.
- Every stored item is a **signed JSON-AM envelope** (Ed25519 JWS) with a
  provenance chain — you can prove where it came from and that it wasn't
  tampered with.
- Access is gated by **capability tokens** scoped to a **trust domain** and to
  actions (`read`, `write`, `link`, `delegate`).
- Agents read and write through **MCP** tools (`store_trace`, `search_memory`)
  and over HTTP, and retrieve by meaning via a **pgvector RAG index**.

## Why it matters for a company

### 1. The moat moves from models to memory
Frontier models are increasingly interchangeable and rented. What compounds and
is hard to copy is your *context and reasoning* — why decisions were made, what
worked, how your organization thinks. Today that evaporates inside vendor chat
memory. CARMA turns each interaction into a persistent, addressable envelope in
**your** trust domain, so the asset that appreciates over time is one you own.

### 2. No lock-in — an open standard, not a vendor API
Because addressing (JSON-AM) and access (MCP) are open, any agent — one model
today, a different one tomorrow, an internal fine-tune next year — plugs into the
same memory. The memory layer itself is not controlled by a single vendor. That
solves the N×M integration problem at the substrate.

### 3. Governance is the enterprise unlock
For autonomous agents acting on company data, "AI memory" without isolation,
authorization, and provenance is a liability. CARMA makes those first-class:
- **Trust-domain isolation** — tenants/teams/customers can't read across domains.
- **Capability tokens** — least-privilege, action-scoped, time-boxed access.
- **Signed provenance + append-only audit** — answer "who authorized this
  agent to read this?" and "where did this answer come from?".

### 4. Reasoning traces become reusable capital
Stored traces are retrievable by meaning (RAG), so agents build on prior
reasoning, institutional knowledge accrues, and traces can later be **distilled**
into a cheaper specialized model **you host**. CARMA ships a distillation
pipeline (`docs/DISTILLATION.md`) that turns your signed traces into a fine-tune
job on a **pluggable model provider** — companies bring their own backend; the
built-in `fireworks` provider runs Fireworks AI supervised fine-tuning, and an
offline `local` provider exports the dataset for any other trainer. Interaction
history stops being exhaust and becomes retrieval **and** training capital that
never leaves your trust domain.

### 5. Federation is the longer game
Cross-domain memory sharing with cryptographic trust (roadmap) enables
partner/customer knowledge exchange where permissions and provenance travel with
the data.

## Applied: CARMA on Cyberorbit (AI pentesting)

Cyberorbit is an AI pentesting platform, which makes it a demanding — and ideal —
CARMA tenant. A pentest generates exactly the kind of sensitive, high-value
reasoning that must be remembered, retrieved, and rigorously governed:

- **Engagement memory.** Each engagement is its own trust domain
  (`trust://cyberorbit/<client>`), so findings, recon notes, and exploit
  reasoning for one client are cryptographically isolated from every other.
- **Reasoning traces as evidence.** Agents `store_trace` their step-by-step
  reasoning ("observed X → hypothesized Y → confirmed CVE-… → recommended fix").
  Because envelopes are signed with provenance, those traces are defensible
  evidence for a report, not just chat logs.
- **RAG over prior engagements.** `search_memory` lets an agent recall "have we
  seen this misconfiguration pattern before, and what worked?" across the
  (authorized) history — turning every past engagement into leverage on the next.
- **Least-privilege agents.** A recon agent gets a short-lived `read` token for
  its domain; only a vetted writer gets `write`. Write tokens are minted with
  tight lifetimes (minutes), so a leaked token expires fast.
- **Audit for compliance.** Pentesting touches regulated environments. The
  append-only audit log (actor, action, URI, result, timestamp) gives the
  chain-of-custody and access trail that client contracts and frameworks demand.
- **Self-hosted.** Sensitive security data never has to leave Cyberorbit's own
  infrastructure — CARMA runs in your VPC next to the platform.

The net effect: Cyberorbit's agents get a shared, searchable, *provable* memory
that is safe to point at real client data — the difference between a demo and a
product you can sell into security-conscious enterprises.

## Honest maturity

CARMA is production-oriented but still hardening. See `docs/ROADMAP.md` for
current status. The default embedding provider is deterministic/local (swap in a
real semantic model via `EMBEDDING_PROVIDER` for production retrieval), and key
management should be backed by a KMS/Vault rather than raw env PEMs in a
high-assurance deployment. The security, audit, and operational hardening
described in `docs/SECURITY.md` and `AGENTS.md` are being implemented
incrementally.
