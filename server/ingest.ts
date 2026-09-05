import { signEnvelope } from './middleware/jws.js';
import { validateEnvelope } from './middleware/guardrails.js';
import { embed, toVectorLiteral } from './embedding.js';

export interface IngestContext {
  uri: string;
  trustDomain: string;
  subject?: string;
  privateKeyPem: string;
}

export interface TraceInput {
  task?: string | null;
  content?: string | null;
  boundContext?: string[];
}

// Build a signed JSON-AM trace:// envelope, validate it, embed its text, and
// persist it together with its vector so it becomes a retrievable RAG pointer.
export async function storeTrace(adapter: any, ctx: IngestContext, input: TraceInput) {
  const task = input?.task ?? null;
  const content = input?.content ?? null;
  const boundContext = input?.boundContext ?? [];

  if (!content && !task) throw new Error('trace requires task or content');
  if (!ctx.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing');

  const now = new Date().toISOString();
  const envelope: any = {
    '@context': 'https://json-am.org/context/v0.1',
    id: ctx.uri,
    type: 'ATIR',
    uriScheme: 'trace',
    trustDomain: ctx.trustDomain,
    version: '0.1.2-draft',
    issuedAt: now,
    provenance: { createdBy: ctx.subject ?? 'carma', createdAt: now },
    task,
    boundContext,
    content,
  };

  envelope.signature = await signEnvelope(envelope, ctx.privateKeyPem);
  validateEnvelope(envelope);

  const text = [task, content, ...(boundContext || [])].filter(Boolean).join('\n');
  const embedding = toVectorLiteral(await embed(text));

  await adapter.store({
    uri: ctx.uri,
    kind: 'trace',
    trustDomain: ctx.trustDomain,
    envelope,
    signature: envelope.signature,
    content: text,
    embedding,
  });

  return { uri: ctx.uri, stored: true };
}

export function newTraceUri(trustDomain: string): string {
  return `trace://${trustDomain}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
