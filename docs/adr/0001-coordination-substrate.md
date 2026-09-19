# ADR 0001 — CARMA as a coordination substrate for agents and humans

Status: proposed · Date: 2026-09-19

## Question

Can CARMA be used to orchestrate between its connected sources — as a communication
channel between agents, and between agents and humans?

## Assessment

Yes, as a **coordination substrate**, not as a real-time message bus. The distinction
decides the design.

### What already exists

CARMA has most of the bones of a channel; what it lacks is delivery semantics.

- **An append-only, signed, addressable log** with per-domain access control and
  provenance on every record (`agent_memory`, JSON-AM envelopes, Ed25519 JWS).
- **Agents already read and write it through MCP** (`store_trace`, `search_memory`,
  `wake`), and the Streamable HTTP transport already carries an SSE stream — the
  pipe for server→agent push exists and is unused for that.
- **A human↔agent handoff already exists**: the consolidation review queue
  (`memory_review`, `GET /reviews`, `POST /reviews/resolve`) is "agent proposes,
  human resolves". A human inbox would generalize it.
- **`agent://` is already a URI scheme** in the spec; agent identities are
  addressable, nothing sends to them yet.
- **Wake is already the read side of coordination**: "what was I just doing, what is
  recent, what is relevant to this task" is one field away from "what is addressed to
  me and unacknowledged".

### Two framings

1. **Blackboard (recommended).** Agents and humans coordinate by writing to and reading
   from shared, signed, searchable memory. This is a well-understood multi-agent
   architecture, and CARMA's differentiators are strengths here: every handoff is
   attributed, auditable, replayable — and *distillable*. The record of how agents
   coordinate becomes training data, not just what they decided.
2. **Real-time broker (not recommended).** Presence, fan-out, ephemeral traffic and
   latency budgets. Signing every message into pgvector-backed Postgres is the wrong
   tool, and it would dilute CARMA's identity into competing with mature messaging
   products.

### "Between sources" means two different things

- **Correlating** across sources (this commit ↔ that PR ↔ this finding ↔ that
  outcome) is the unbuilt Link Engine from `ARCHITECTURE.md` and the graph-layer item
  in roadmap 2.9. In scope; `lineage` / `boundContext` are the seeds.
- **Acting** on sources (open a PR, post to Slack, write a row) crosses a boundary the
  docs draw deliberately: *CARMA only ever reads from your systems and writes into its
  own store.* Keep it. The principle: **CARMA remembers and routes; agents act.** An
  agent picks a handoff up from CARMA, acts in GitHub, and records decision + outcome
  back. CARMA stays the ledger, never the hand.

## Proposed design (all additive)

1. **A `Message` / `Handoff` envelope kind** in JSON-AM (or a trace with addressing):
   `to` (`agent://` or `trust://` URIs), `thread`, `inReplyTo`, `ack`.
2. **An inbox resource** — `memory://<domain>/inbox/<agent>` — with MCP resource
   subscriptions (`resources/subscribe` → `notifications/resources/updated`) over the
   SSE stream that is already there. Real push to agents with no new transport.
3. **Per-recipient cursors** — the same primitive roadmap 2.10 already wants for
   incremental ingest.
4. **Human side**: generalize `memory_review` into "decisions awaiting a human", plus
   the first *outbound* connector (Slack webhook / email) — an explicit, opt-in
   crossing of the read-only boundary, flagged as such.
5. **Cross-domain sends** gated by capability grants on both sides — the stepping stone
   to federation (roadmap 2.8's open "governed cross-domain recall").

## Watch-outs

- **Prompt injection gets a promotion.** Memory content already flows into MCP
  `initialize` instructions via wake; a channel turns agent-to-agent messages into
  instruction carriers. Messages must stay data with attribution, never be elevated
  to instructions, and sender identity must be capability-checked.
- **It depends on the authorization work that is still open.** A channel is the first
  feature where *who sent this* and *who may receive it* are load-bearing.
  Issuer/audience checks, resource-pattern enforcement and cross-domain enforcement
  (see the September 2026 review) stop being hygiene and become prerequisites.

## Placement

After the roadmap 2.8 cross-domain work, alongside 2.9 (graph layer) and 2.10
(connectors), before Phase 3 federation. Tracked in `ROADMAP.md` under Phase 3.

## Decision

Deferred until the open authorization items are closed; when picked up, build the
blackboard variant in the order listed above.
