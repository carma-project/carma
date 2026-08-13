import { SignJWT, jwtVerify, createSecretKey } from 'jose';

export async function signEnvelope(envelope: any, secret: string) {
  const key = createSecretKey(Buffer.from(secret, 'utf-8'));
  const jwt = await new SignJWT(envelope)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'carma-key' })
    .setIssuedAt()
    .sign(key);
  return jwt;
}

export async function verifyEnvelope(token: string, secret: string) {
  const key = createSecretKey(Buffer.from(secret, 'utf-8'));
  const { payload } = await jwtVerify(token, key, { algorithms: ['EdDSA'] });
  return payload;
}
