import { jwtVerify, JWTPayload } from 'jose';

export async function verifyCapability(token: string, publicKey: Uint8Array) {
  const { payload } = await jwtVerify(token, publicKey, {
    algorithms: ['EdDSA']
  });
  const jsonam = (payload as any).jsonam;
  if (!jsonam) throw new Error('No jsonam claims');
  return jsonam;
}
