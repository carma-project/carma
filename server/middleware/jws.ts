import { SignJWT, jwtVerify } from 'jose';

export async function signEnvelope(envelope: any, privateKey: Uint8Array) {
  const jwt = await new SignJWT(envelope)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'carma-key' })
    .setIssuedAt()
    .sign(privateKey);
  return jwt;
}

export async function verifyEnvelope(token: string, publicKey: Uint8Array) {
  const { payload } = await jwtVerify(token, publicKey, { algorithms: ['EdDSA'] });
  return payload;
}
