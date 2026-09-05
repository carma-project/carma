// Pure grant-bounding logic for the mTLS-gated POST /capability endpoint.
// Kept side-effect free so it can be unit-tested without a server or TLS.

function normDomain(d) {
  return String(d).includes('://') ? String(d) : `trust://${d}`;
}

function intersect(requested, allowed) {
  const allow = new Set(allowed);
  // No explicit request -> grant the full allowed set (bounded by policy).
  if (!requested || !requested.length) return allowed.slice();
  return requested.filter((x) => allow.has(x));
}

// Compute the effective grant for an issuance request.
//   requested   : { domains?: string[], actions?: string[], ttl?: number(seconds) }
//   policy      : { domains: string[], actions: string[], maxTtlSeconds: number }
//   priorGrant  : { domains: string[], actions: string[] } | null
//                 On refresh, the new grant can never exceed the presented
//                 (still-valid) token's grant — refresh cannot escalate.
// Returns { domains, actions, ttlSeconds }. Throws if the result would be empty.
export function boundGrant({ requested = {}, policy, priorGrant = null }) {
  const reqDomains = (requested.domains || []).map(normDomain);
  const policyDomains = (policy.domains || []).map(normDomain);

  let domains = intersect(reqDomains, policyDomains);
  let actions = intersect(requested.actions, policy.actions);

  if (priorGrant) {
    domains = intersect(domains, (priorGrant.domains || []).map(normDomain));
    actions = intersect(actions, priorGrant.actions || []);
  }

  // De-dup while preserving order.
  domains = [...new Set(domains)];
  actions = [...new Set(actions)];

  if (!domains.length) throw new Error('No permitted domains for this client');
  if (!actions.length) throw new Error('No permitted actions for this client');

  const maxTtl = policy.maxTtlSeconds;
  let ttlSeconds = maxTtl;
  if (requested.ttl != null) {
    const t = Number(requested.ttl);
    if (!Number.isFinite(t) || t <= 0) throw new Error('ttl must be a positive number of seconds');
    ttlSeconds = Math.min(Math.trunc(t), maxTtl);
  }

  return { domains, actions, ttlSeconds };
}
