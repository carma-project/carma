# CARMA Docs

## Overview
CARMA is the reference implementation of JSON-AM for Context Addressable Reasoning and Memory.

## Quick Start
```bash
docker compose up --build
curl http://localhost:7100/resolve?uri=memory://acme/sem/worldview
```

## Go live for your organization
Provider-neutral runbook: [`GO_LIVE.md`](GO_LIVE.md) — deploy privately, connect your
repo/database/issue tracker/internal APIs, and start the ingest → consolidate → distill →
recall loop. Copy [`examples/sources.example.json`](examples/sources.example.json) as your
sources template.

## Railway Deploy
Host-specific notes: [`DEPLOY_RAILWAY.md`](DEPLOY_RAILWAY.md) (see also `railway.toml`).
