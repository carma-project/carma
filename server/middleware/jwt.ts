import { jwtVerify } from 'jose';
import type { KeyLike } from 'jose';

export interface VerifyOptions {
  // When set, the token's iss / aud claims must match (JWT_ISSUER / JWT_AUDIENCE).
  issuer?: string;
  audience?: string;
}

// Verify an EdDSA capability token and return the full JWT payload (including
// `sub` and the `jsonam` capability claims). Callers use enforceCapability on
// the returned payload. exp and iat are mandatory so every token has a bounded
// lifetime and the per-action age ceiling always applies.
export async function verifyCapability(
  token: string,
  publicKey: KeyLike | Uint8Array,
  options: VerifyOptions = {}
) {
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['EdDSA'],
    requiredClaims: ['exp', 'iat', 'jsonam'],
    ...(options.issuer ? { issuer: options.issuer } : {}),
    ...(options.audience ? { audience: options.audience } : {}),
  });
  const jsonam = (payload as any).jsonam;
  if (!jsonam || typeof jsonam !== 'object' || !Array.isArray(jsonam.domains) || !Array.isArray(jsonam.actions)) {
    throw new Error('No jsonam claims');
  }
  return payload;
}
