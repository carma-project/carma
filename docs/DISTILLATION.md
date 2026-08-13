# Agent and Model Distillation with CARMA

## Overview
CARMA enables distillation via portable reasoning traces and addressable memories.

## Workflow
1. Capture trace:// envelopes from teacher model
2. Export linked memory:// and context:// envelopes
3. Package ATIR for replay
4. Train student model on trace + context pairs

## Adapter
distillation adapter exports traces as JSONL with context
