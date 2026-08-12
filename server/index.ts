// Minimal CARMA HTTP resolver
export const RESOLVE_PATH = '/resolve';
export function handleResolve(uri: string) {
  // TODO: parse URI, verify JWT, fetch from adapter, sign JWS
  return { id: uri, type: 'Memory' };
}
