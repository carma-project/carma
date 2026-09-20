import { SignJWT, importPKCS8 } from 'jose';

export interface CapabilityGrant {
  domains: string[];
  actions: string[];
  resources?: string[];
  subject?: string;
  ttl?: string;
  // Default to JWT_ISSUER / JWT_AUDIENCE so minted tokens satisfy a server that
  // verifies them (server/middleware/jwt.ts); omitted when neither is set.
  issuer?: string;
  audience?: string;
}

// Issue an EdDSA capability token signed with the trust domain private key.
// This is the minting side of the JWT capability model verified by
// verifyCapability/enforceCapability.
export async function issueCapability(grant: CapabilityGrant, privateKeyPem: string) {
  const key = await importPKCS8(privateKeyPem, 'EdDSA');
  const issuer = grant.issuer ?? process.env.JWT_ISSUER;
  const audience = grant.audience ?? process.env.JWT_AUDIENCE;
  // A bare number is seconds; anything else is a time span ('15m', '1h').
  const ttl = grant.ttl ?? '1h';
  const expiresAt = /^\d+$/.test(String(ttl)) ? Math.floor(Date.now() / 1000) + Number(ttl) : String(ttl);
  let jwt = new SignJWT({
    jsonam: {
      domains: grant.domains,
      actions: grant.actions,
      resources: grant.resources ?? [],
    },
  })
    .setProtectedHeader({ alg: 'EdDSA', kid: 'carma-key' })
    .setSubject(grant.subject ?? 'carma')
    .setIssuedAt()
    .setExpirationTime(expiresAt);
  if (issuer) jwt = jwt.setIssuer(issuer);
  if (audience) jwt = jwt.setAudience(audience);
  return await jwt.sign(key);
}
