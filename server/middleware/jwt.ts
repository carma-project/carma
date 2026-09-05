import { jwtVerify, KeyLike } from 'jose';

// Verify an EdDSA capability token and return the full JWT payload (including
// `sub` and the `jsonam` capability claims). Callers use enforceCapability on
// the returned payload.
export async function verifyCapability(token: string, publicKey: KeyLike | Uint8Array) {
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['EdDSA'],
  });
  if (!(payload as any).jsonam) throw new Error('No jsonam claims');
  return payload;
}
