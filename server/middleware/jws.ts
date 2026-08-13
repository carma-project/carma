import { SignJWT } from 'jose';

export async function signEnvelope(envelope: any, privateKey: Uint8Array) {
  const signer = new SignJWT(envelope)
    .setProtectedHeader({ alg: 'EdDSA', kid: 'carma-key' });
  return await signer.sign(privateKey);
}
