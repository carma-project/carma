# Distillation & Fine-tuning with CARMA

## Overview

CARMA turns a company's own signed reasoning traces and memories into a
training corpus and launches a fine-tune job on a **pluggable model provider**,
producing a model you can host. Companies bring their own provider; the built-in
options are `local` (offline, export + simulate) and `fireworks` (Fireworks AI
supervised fine-tuning).

## Pipeline (`server/distill/pipeline.ts`)

1. **Select** stored envelopes by trust domain / kind / time
   (`PostgresAdapter.listEnvelopes`).
2. **Build dataset** (`server/distill/dataset.ts`) — OpenAI-compatible chat JSONL
   (`{ "messages": [{role,content}, ...] }`), the format Fireworks SFT expects.
   A trace maps as `task -> user`, `content -> assistant`; an optional system
   prompt and thinking traces (`reasoning_content`) are supported.
3. **Submit** to the configured provider (`FineTuneProvider.submit`).
4. **Record provenance** — persist a signed, addressable **dataset manifest**
   envelope at `memory://<domain>/dataset/<id>` capturing the source trace URIs,
   example count, provider, base model, job id, and resulting model. This makes
   every training set auditable and reproducible.

## Providers (`server/distill/providers/`)

Implement `FineTuneProvider` (`submit`, `status`) to plug in any backend.

- **local** — writes the JSONL dataset to `DISTILL_OUTPUT_DIR` and returns a
  succeeded synthetic job. No API key; great for export and CI.
- **fireworks** — Fireworks AI SFT via REST:
  `POST /v1/accounts/{acct}/datasets` → `:upload` (JSONL) →
  `POST /v1/accounts/{acct}/supervisedFineTuningJobs`; status via
  `GET .../supervisedFineTuningJobs/{jobId}`. Deploy the resulting model to a
  dedicated Fireworks deployment to host it.

## Interfaces

- HTTP: `POST /distill` (capability action `distill`) →
  `{ datasetUri, examples, provider, baseModel, jobId, status, model }`.
  `GET /finetune?jobId=...` → provider job status.
- CLI: `npm run distill -- --domain acme --kind trace --limit 5000 --base-model <model>`.

## Configuration

`FINETUNE_PROVIDER` (`local` | `fireworks`), `FIREWORKS_API_KEY`,
`FIREWORKS_ACCOUNT_ID`, `FIREWORKS_BASE_MODEL`, `FIREWORKS_BASE_URL`,
`DISTILL_OUTPUT_DIR`, `DISTILL_MAX_EXAMPLES`, `DISTILL_SYSTEM_PROMPT`.

## Notes

- Fireworks requires a minimum of 3 examples and chat-format JSONL.
- Only traces with both a `task` and `content` become supervised examples;
  others are counted as `skipped`.
- Governance: distillation is trust-domain scoped, capability-gated (`distill`),
  and every run is audited; the dataset manifest is signed like any envelope.
