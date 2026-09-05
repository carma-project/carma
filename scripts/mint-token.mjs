// Mint an EdDSA capability token for testing / operations.
// Usage:
//   PRIVATE_KEY="$(cat priv.pem)" node scripts/mint-token.mjs \
//     --domains trust://acme --actions read,write --ttl 1h --sub alice
import { issueCapability } from '../server/capability.js';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const privateKeyPem = process.env.PRIVATE_KEY || '';
if (!privateKeyPem) {
  console.error('PRIVATE_KEY (Ed25519 PKCS8 PEM) env var is required');
  process.exit(1);
}

const domains = arg('domains', 'trust://acme').split(',').map((s) => s.trim());
const actions = arg('actions', 'read').split(',').map((s) => s.trim());
const resources = arg('resources', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const ttl = arg('ttl', '1h');
const subject = arg('sub', 'carma');

const token = await issueCapability({ domains, actions, resources, subject, ttl }, privateKeyPem);
process.stdout.write(token + '\n');
