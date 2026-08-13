# Secret and Token Management

## JWT Capability Tokens
- Issued via POST /capability with mTLS
- Signed with EdDSA
- Short lived: 15 min write, 60 min read
- Refresh endpoint rate limited

## Signing Keys
- Ed25519 key pair per trust domain
- Private key stored in KMS/Vault, never in code
- Public key published at /.well-known/jwks.json
- Rotation every 90 days, overlap 30 days

## Environment Variables
- DATABASE_URL, PRIVATE_KEY, PUBLIC_KEY, JWT_ISSUER
- Loaded from Railway variables or .env.local
- Never commit .env files

## Key Rotation Procedure
1. Generate new key pair
2. Publish public key
3. Dual sign for 30 days
4. Retire old key
