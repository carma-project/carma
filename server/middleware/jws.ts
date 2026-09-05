import { CompactSign, compactVerify, importPKCS8, importSPKI } from 'jose';

// Envelopes are signed with a detached-style compact JWS over the canonical
// JSON of the envelope (excluding the `signature` field itself). Ed25519
// (EdDSA) asymmetric keys are used, matching docs/SECRET_MANAGEMENT.md.

// Deterministic JSON with recursively sorted object keys, so the signature is
// stable across transports that do not preserve key order (e.g. Postgres JSONB).
function stableStringify(value: any): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(value[k])).join(',') + '}';
}

function canonical(envelope: any): string {
  const { signature, ...rest } = envelope ?? {};
  return stableStringify(rest);
}

export async function signEnvelope(envelope: any, privateKeyPem: string) {
  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  return await new CompactSign(new TextEncoder().encode(canonical(envelope)))
    .setProtectedHeader({ alg: 'EdDSA', kid: 'carma-key' })
    .sign(key);
}

export async function verifyEnvelope(envelope: any, publicKeyPem: string) {
  const key = await importSPKI(publicKeyPem, 'EdDSA');
  const { payload } = await compactVerify(envelope.signature, key);
  const signed = new TextDecoder().decode(payload);
  if (signed !== canonical(envelope)) throw new Error('Envelope body does not match signature');
  return true;
}
