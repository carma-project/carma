import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, exportSPKI, exportPKCS8, importSPKI } from 'jose';
import { localEmbed, EMBED_DIM } from '../server/embedding.js';
import { signEnvelope, verifyEnvelope } from '../server/middleware/jws.js';
import { issueCapability } from '../server/capability.js';
import { verifyCapability } from '../server/middleware/jwt.js';
import { enforceCapability, sanitizeUri, validateEnvelope } from '../server/middleware/guardrails.js';

function cosine(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) d += a[i] * b[i];
  return d;
}

test('localEmbed is deterministic and L2-normalized', () => {
  const a = localEmbed('database connection settings');
  const b = localEmbed('database connection settings');
  assert.equal(a.length, EMBED_DIM);
  assert.deepEqual(a, b);
  const norm = Math.sqrt(a.reduce((s, x) => s + x * x, 0));
  assert.ok(Math.abs(norm - 1) < 1e-9);
});

test('cosine similarity reflects lexical overlap', () => {
  const q = localEmbed('database connection string');
  const near = localEmbed('how to configure the database connection');
  const far = localEmbed('the weather is sunny today');
  assert.ok(cosine(q, near) > cosine(q, far));
});

test('JWS envelope sign/verify roundtrip (Ed25519) + tamper detection', async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  const spki = await exportSPKI(publicKey);
  const env = {
    '@context': 'https://json-am.org/context/v0.1',
    id: 'trace://acme/x',
    provenance: { createdBy: 't', createdAt: 'now' },
  };
  env.signature = await signEnvelope(env, pkcs8);
  assert.ok(await verifyEnvelope(env, spki));
  env.content = 'tampered';
  await assert.rejects(() => verifyEnvelope(env, spki));
});

test('capability issue -> verify -> enforce', async () => {
  const { publicKey, privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519', extractable: true });
  const pkcs8 = await exportPKCS8(privateKey);
  const pub = await importSPKI(await exportSPKI(publicKey), 'EdDSA');
  const token = await issueCapability(
    { domains: ['trust://acme'], actions: ['read', 'write'], subject: 'alice' },
    pkcs8
  );
  const payload = await verifyCapability(token, pub);
  assert.equal(payload.sub, 'alice');
  assert.ok(enforceCapability(payload, 'memory://acme/sem/x', 'read'));
  assert.ok(enforceCapability(payload, 'trace://acme/123', 'write'));
  assert.throws(() => enforceCapability(payload, 'memory://other/sem/x', 'read')); // wrong domain
  assert.throws(() => enforceCapability(payload, 'memory://acme/sem/x', 'delete')); // action not granted
});

test('sanitizeUri + validateEnvelope guards', () => {
  assert.equal(sanitizeUri('trace://acme/x'), 'trace://acme/x');
  assert.throws(() => sanitizeUri('evil://acme/x')); // bad scheme
  assert.throws(() => sanitizeUri('memory://acme/../y')); // path traversal
  assert.throws(() => validateEnvelope({})); // missing context/signature/provenance
});
