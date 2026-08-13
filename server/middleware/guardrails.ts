export function enforceCapability(tokenClaims: any, uri: string, action: string) {
  const { domains, actions, resources } = tokenClaims.jsonam || tokenClaims;
  if (!actions.includes(action)) throw new Error('Action not permitted');
  const parts = uri.split('://');
  if (parts.length < 2) throw new Error('Invalid URI');
  const trustDomain = parts[1].split('/')[0];
  if (!domains.includes(`trust://${trustDomain}`)) throw new Error('Domain not permitted');
  return true;
}

export function validateEnvelope(envelope: any) {
  if (envelope['@context'] !== 'https://json-am.org/context/v0.1') throw new Error('Invalid context');
  if (!envelope.signature) throw new Error('Missing signature');
  if (!envelope.provenance) throw new Error('Missing provenance');
  return true;
}

export function sanitizeUri(uri: string) {
  if (!/^memory:|context:|trace:|agent:|trust:/.test(uri)) throw new Error('Invalid scheme');
  if (uri.includes('..')) throw new Error('Path traversal');
  return uri;
}
