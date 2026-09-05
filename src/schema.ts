// CARMA core schema - JSON-AM v0.1.3-draft
export type URIScheme = 'memory' | 'context' | 'trace' | 'agent' | 'trust';

// Lifecycle of an addressable memory. Recall returns `active` by default;
// `superseded`/`retracted` stay in the store for audit + lineage but are
// excluded from recall. `candidate` is working memory awaiting consolidation.
export type MemoryStatus = 'active' | 'superseded' | 'retracted' | 'candidate';

export interface EnvelopeBase {
  '@context': 'https://json-am.org/context/v0.1';
  id: string;
  type: string;
  uriScheme: URIScheme;
  trustDomain: string;
  version: string;
  issuedAt: string;
  provenance: { createdBy: string; createdAt: string };
}

export interface MemoryRecord extends EnvelopeBase {
  type: 'Memory';
  memoryKind: 'episodic' | 'semantic' | 'skill';
}

// v0.1.3-draft additions (all optional -> backward compatible with 0.1.2):

// The choice a decision trace committed to, plus the alternatives weighed.
export interface Decision {
  choice: string;
  alternatives?: string[];
}

// How a decision turned out. Recorded when known (often after the fact) via a
// separate Outcome envelope; `score` is a signed usefulness signal in [-1, 1].
export type OutcomeStatus = 'pending' | 'success' | 'failure' | 'mixed' | 'unknown';
export interface Outcome {
  status: OutcomeStatus;
  score?: number;
  observedAt?: string;
  evidence?: string;
}

// Memory revision graph. A new version records `supersedes`; the prior version
// is marked superseded. `revises` is a softer "builds on" link.
export interface Lineage {
  supersedes?: string;
  revises?: string;
}

// ATIR = Addressable Task/Intent/Reasoning trace: one recorded decision.
export interface ATIR extends EnvelopeBase {
  type: 'ATIR';
  task: string;
  boundContext: string[];
  content?: string; // the reasoning trace
  decision?: Decision;
  outcome?: Outcome; // usually starts absent/pending; updated via OutcomeReport
  lineage?: Lineage;
  confidence?: number; // model self-assessed confidence in [0, 1]
  importance?: number; // salience hint in [0, 1]
  status?: MemoryStatus;
}

// A first-class, addressable record that a prior decision produced an outcome.
// Kept separate so signed decision envelopes stay immutable; the decision row's
// denormalized outcome columns are what recall weighting reads.
export interface OutcomeReport extends EnvelopeBase {
  type: 'Outcome';
  decisionUri: string;
  outcome: Outcome;
}

// A distilled, reusable principle abstracted from several concrete decisions on
// the same task during offline consolidation ("dreaming"). It is episodic memory
// promoted to semantic memory: the recurring "what we do and why" plus links back
// to the source decisions it generalizes. Semantic memories are recall-indexed and
// feed distillation.
export interface Semantic extends EnvelopeBase {
  type: 'Semantic';
  task: string;
  content: string; // the principle / summary
  semantic: {
    principle: string; // the recommended choice / rule of thumb
    derivedFrom: string[]; // source decision URIs
    supportCount: number; // how many decisions it generalizes
    successRate?: number; // fraction of sources with a success outcome
    model?: string; // which memory model produced it (provenance)
  };
  confidence?: number;
  importance?: number;
  status?: MemoryStatus;
}
