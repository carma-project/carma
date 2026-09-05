# JSON-AM envelope schema (CARMA reference)

CARMA stores every memory as a signed **JSON-AM envelope** addressed by URI
(`memory://`, `context://`, `trace://`, `agent://`, `trust://`). The reference
schema lives in `src/schema.ts`; envelopes are signed with Ed25519 JWS over
canonical JSON (`server/middleware/jws.ts`) and validated by
`server/middleware/guardrails.ts`.

## Do we need to change the JSON-AM spec?

Yes — but only **additively**. Modeling *decisions*, *outcomes*, and *revision
lineage* is a genuine schema concern (it's what turns an accumulating pile of
traces into recallable, self-correcting institutional memory), so it belongs in
JSON-AM rather than being bolted on per application. The change is designed to
be backward compatible:

- **`@context` stays `https://json-am.org/context/v0.1`.** The context URL is
  coarse-grained; the fine-grained schema version travels in the `version`
  field.
- **`version` bumps `0.1.2-draft` → `0.1.3-draft`.**
- **All new fields are optional.** Every `0.1.2` envelope is still a valid
  `0.1.3` envelope; existing readers ignore unknown fields, and existing signed
  envelopes remain valid (nothing is renamed or removed).

If/when this stabilises, the changes graduate into the canonical spec at
[json-am.org](https://json-am.org); the `-draft` suffix marks it as not yet
frozen.

## v0.1.3-draft additions

Added to the reasoning-trace envelope (`type: "ATIR"`), all optional:

| Field | Type | Meaning |
| --- | --- | --- |
| `content` | string | The reasoning trace text (was already emitted; now in the schema). |
| `decision` | `{ choice, alternatives? }` | The choice committed to and the options weighed. |
| `outcome` | `{ status, score?, observedAt?, evidence? }` | How it turned out. `status ∈ pending\|success\|failure\|mixed\|unknown`; `score ∈ [-1,1]`. Usually starts absent/`pending` and is filled in later. |
| `lineage` | `{ supersedes?, revises? }` | Revision graph. A new version records `supersedes`; the prior version is marked superseded. |
| `confidence` | number `[0,1]` | Model self-assessed confidence. |
| `importance` | number `[0,1]` | Salience hint for consolidation. |
| `status` | `active\|superseded\|retracted\|candidate` | Lifecycle; recall returns `active` only. |

New envelope type:

| Type | Fields | Purpose |
| --- | --- | --- |
| `Outcome` | `decisionUri`, `outcome` | A first-class, signed, addressable record that a prior decision produced an outcome. Kept separate so signed decision envelopes stay immutable. |

## Why outcomes are separate envelopes

A decision envelope is signed and immutable (provenance/audit). When the outcome
becomes known later, we don't mutate the signed decision — we write a new signed
`Outcome` envelope that references it (`decisionUri`) and update a *denormalized*
projection (columns on the decision row: `outcome_status`, `outcome_score`,
`outcome_uri`) that recall reads. The envelope stays the source of truth; the
columns exist only so recall can filter/rank without parsing JSONB.

## Storage projection

`adapters/migrations/0004_decision_outcome_lineage.sql` adds the queryable
projection used by recall ranking and lifecycle filters: `status`,
`supersedes`, `superseded_by`, `outcome_status`, `outcome_score`, `outcome_uri`,
`confidence`, `importance`. These mirror the signed envelope; the envelope
remains authoritative.

## Recall (precedent retrieval)

Recall ranks **active** memories by a blend, not raw cosine similarity, so it
behaves more like human recall — recent, important, and *previously-successful*
reasoning surfaces first:

```
score = w_sim · similarity
      + w_outcome · outcome_signal   (success +1 … failure −1; unknown 0)
      + w_recency · exp(−age / halflife)
```

Weights are configurable (`RECALL_W_SIM`, `RECALL_W_OUTCOME`,
`RECALL_W_RECENCY`, `RECALL_HALF_LIFE_DAYS`). A recall result is a **precedent**
— the reasoning, the decision made, how it turned out, and its lineage — not
just a pointer, so an agent (or a fine-tuning run) learns *why* and *whether it
worked*.
