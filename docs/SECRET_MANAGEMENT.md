# Secret and Token Management

## JWT Capability Tokens
- Issued by trust domain authority
- Short lived: 15 min
- Refresh via POST /capability

## Signing Keys
- Ed25519 key pairs per trust domain
- Store in KMS / Vault
- Rotate quarterly

## Environment Variables
- DATABASE_URL
- PRIVATE_KEY
- PUBLIC_KEY
- Never commit secrets

## Railway
- Use Railway variables
- Enable secret scanning
