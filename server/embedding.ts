// Embedding provider for the RAG index.
//
// Default provider is a self-contained, deterministic hashed bag-of-words
// embedder: no network calls, no API keys, reproducible in tests and CI.
// Cosine similarity between vectors then reflects lexical overlap, which is
// enough to demonstrate retrieval end to end. The provider is pluggable so a
// real semantic model (e.g. an external embeddings API) can be dropped in;
// switching providers requires matching EMBED_DIM and re-embedding stored rows.

export const EMBED_DIM = Number(process.env.EMBED_DIM || 256);
const PROVIDER = process.env.EMBEDDING_PROVIDER || 'local';

function hashToken(tok: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < tok.length; i++) {
    h ^= tok.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % EMBED_DIM;
}

export function localEmbed(text: string): number[] {
  const v = new Float64Array(EMBED_DIM);
  const tokens = String(text || '').toLowerCase().match(/[a-z0-9]+/g) || [];
  for (const tok of tokens) v[hashToken(tok)] += 1;
  let norm = 0;
  for (let i = 0; i < EMBED_DIM; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Array(EMBED_DIM);
  for (let i = 0; i < EMBED_DIM; i++) out[i] = v[i] / norm;
  return out;
}

export async function embed(text: string): Promise<number[]> {
  if (PROVIDER === 'local') return localEmbed(text);
  throw new Error(`Unsupported EMBEDDING_PROVIDER: ${PROVIDER}`);
}

// pgvector accepts a bracketed, comma-separated literal cast to ::vector.
export function toVectorLiteral(arr: number[]): string {
  return '[' + arr.map((x) => Number(x).toFixed(6)).join(',') + ']';
}
