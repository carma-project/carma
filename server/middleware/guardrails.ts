// Anchored over the full string: every alternative must match from the start,
// so lookalike schemes such as x-context:// cannot slip through.
const URI_PATTERN = /^(memory|context|trace|agent|trust):\/\/[^\s/]+(\/[^\s]*)?$/;

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

export function enforceCapability(tokenClaims: any, uri: string, action: string) {
  const { domains, actions, resources } = tokenClaims.jsonam || tokenClaims;
  if (!Array.isArray(actions) || !actions.includes(action)) throw new Error('Action not permitted');
  const parts = String(uri).split('://');
  if (parts.length < 2) throw new Error('Invalid URI');
  const trustDomain = parts[1].split('/')[0];
  if (!Array.isArray(domains) || !domains.includes(`trust://${trustDomain}`)) throw new Error('Domain not permitted');
  // Resource patterns narrow a grant within its domains. An empty list (what
  // issueCapability mints by default) means the whole domain; a non-empty list
  // must match the URI.
  if (Array.isArray(resources) && resources.length > 0) {
    if (!resources.some((p: unknown) => typeof p === 'string' && globToRegExp(p).test(uri))) {
      throw new Error('Resource not permitted');
    }
  }
  return true;
}

// Cap token age per action (defence in depth on top of `exp`). Only plain reads
// get the longer ceiling; every mutating or privileged action (write, distill,
// ...) is held to the short one, so a leaked token limits blast radius.
export function enforceTokenLifetime(
  payload: any,
  action: string,
  limits: { read: number; write: number }
) {
  const iat = payload?.iat;
  if (typeof iat !== 'number') throw new Error('Token missing iat');
  const maxAge = action === 'read' ? limits.read : limits.write;
  const ageSec = Math.floor(Date.now() / 1000) - iat;
  if (ageSec > maxAge) throw new Error(`Token too old for action '${action}'`);
  return true;
}

export function validateEnvelope(envelope: any) {
  if (envelope['@context'] !== 'https://json-am.org/context/v0.1') throw new Error('Invalid context');
  if (!envelope.signature) throw new Error('Missing signature');
  if (!envelope.provenance) throw new Error('Missing provenance');
  return true;
}

export function sanitizeUri(uri: unknown): string {
  if (typeof uri !== 'string') throw new Error('Invalid URI');
  if (uri.length > 2048) throw new Error('URI too long');
  if (!URI_PATTERN.test(uri)) throw new Error('Invalid scheme');
  if (uri.includes('..')) throw new Error('Path traversal');
  return uri;
}
