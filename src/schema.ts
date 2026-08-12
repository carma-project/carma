// CARMA core schema - JSON-AM v0.1.2-draft
export type URIScheme = 'memory' | 'context' | 'trace' | 'agent' | 'trust';
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
export interface MemoryRecord extends EnvelopeBase { type: 'Memory'; memoryKind: 'episodic'|'semantic'|'skill'; }
export interface ATIR extends EnvelopeBase { type: 'ATIR'; task: string; boundContext: string[]; }
