import { SignJWT, importPKCS8 } from 'jose';

export interface CapabilityGrant {
  domains: string[];
  actions: string[];
  resources?: string[];
  subject?: string;
  ttl?: string;
}

// Issue an EdDSA capability token signed with the trust domain private key.
// This is the minting side of the JWT capability model verified by
// verifyCapability/enforceCapability. (A full mTLS-gated POST /capability
// refresh endpoint remains future work per docs/SECURITY.md.)
export async function issueCapability(grant: CapabilityGrant, privateKeyPem: string) {
  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  return await new SignJWT({
    jsonam: {
      domains: grant.domains,
      actions: grant.actions,
      resources: grant.resources ?? [],
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'carma-key' })
    .setSubject(grant.subject ?? 'carma')
    .setIssuedAt()
    .setExpirationTime(grant.ttl ?? '1h')
    .sign(key);
}
