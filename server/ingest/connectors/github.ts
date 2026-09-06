// GitHub connector: ingest issues and pull requests — titles, descriptions, and
// (optionally) the comment threads — which is where much of the decision
// discussion actually lives. Each becomes a dated decision memory; closed/merged
// state becomes an outcome signal so recall learns which proposals landed.
//
// Source fields:
//   repo               "owner/name" (required)
//   tokenEnv           env var with a GitHub token (default env GITHUB_TOKEN)
//   apiBase            API base (default https://api.github.com; overridable for testing/GHE)
//   state              all | open | closed (default all)
//   since              ISO date; only items updated since then
//   maxPages           pagination cap (default 5 -> up to 500 items)
//   includeComments    fetch + append conversation comments (default true; costs one
//                      API call per commented item, so a token is recommended)
//   maxComments        per-item comment cap (default 50)
import type { CollectContext, CollectResult } from './index.js';
import type { IngestItem, OutcomeItem } from '../extract.js';

function ghHeaders(source: any): Record<string, string> {
  const headers: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'carma-ingest',
    'x-github-api-version': '2022-11-28',
  };
  const token = source.tokenEnv ? process.env[source.tokenEnv] : process.env.GITHUB_TOKEN;
  if (token) headers['authorization'] = `Bearer ${token}`;
  return headers;
}

export async function collectGithub(source: any, _config: any, ctx: CollectContext): Promise<CollectResult> {
  const trustDomain = ctx.trustDomain;
  const repo = source.repo;
  if (!repo || !String(repo).includes('/')) throw new Error(`source ${source.id}: github needs repo "owner/name"`);
  const [owner, name] = String(repo).split('/');
  const apiBase = (source.apiBase || 'https://api.github.com').replace(/\/$/, '');
  const headers = ghHeaders(source);
  const state = source.state || 'all';
  const maxPages = Number.isFinite(Number(source.maxPages)) ? Number(source.maxPages) : 5;
  const includeComments = source.includeComments !== false;
  const maxComments = Number.isFinite(Number(source.maxComments)) ? Number(source.maxComments) : 50;

  const items: IngestItem[] = [];
  const outcomes: OutcomeItem[] = [];
  let issues = 0;
  let prs = 0;

  for (let page = 1; page <= maxPages; page++) {
    const params = new URLSearchParams({ state, per_page: '100', page: String(page), sort: 'created', direction: 'asc' });
    if (source.since) params.set('since', source.since);
    const res = await fetch(`${apiBase}/repos/${owner}/${name}/issues?${params}`, { headers });
    if (!res.ok) throw new Error(`source ${source.id}: GitHub ${res.status} listing issues`);
    const arr = await res.json();
    if (!Array.isArray(arr) || arr.length === 0) break;

    for (const it of arr) {
      const isPr = Boolean(it.pull_request);
      const kind = isPr ? 'pull' : 'issues';
      const uri = `trace://${trustDomain}/gh/${owner}/${name}/${kind}/${it.number}`;
      let content = [it.title, it.body].filter(Boolean).join('\n\n');

      if (includeComments && Number(it.comments) > 0 && it.comments_url) {
        try {
          const cres = await fetch(`${it.comments_url}?per_page=100`, { headers });
          if (cres.ok) {
            const comments = await cres.json();
            const rendered = (Array.isArray(comments) ? comments : [])
              .slice(0, maxComments)
              .map((c: any) => `${c.user?.login || '?'}: ${c.body || ''}`.trim())
              .filter(Boolean);
            if (rendered.length) content += `\n\n--- discussion ---\n${rendered.join('\n\n')}`;
          }
        } catch {
          /* comments are best-effort; the item still ingests without them */
        }
      }

      const input: any = {
        task: it.title,
        content,
        decision: { choice: it.title },
        boundContext: [`repo:${owner}/${name}`, isPr ? 'pr' : 'issue', `#${it.number}`, `author:${it.user?.login || '?'}`],
        confidence: 0.65,
        importance: isPr ? 0.7 : 0.6,
        occurredAt: it.created_at,
      };
      items.push({ uri, trustDomain, type: isPr ? 'pr' : 'issue', input });
      if (isPr) prs++;
      else issues++;

      // Closed/merged state -> outcome signal.
      if (it.state === 'closed') {
        if (isPr && it.pull_request?.merged_at) {
          outcomes.push({ decisionUri: uri, status: 'success', score: 0.8, evidence: `PR #${it.number} merged` });
        } else if (it.state_reason === 'not_planned') {
          outcomes.push({ decisionUri: uri, status: 'failure', score: -0.5, evidence: `#${it.number} closed as not planned` });
        } else if (isPr) {
          outcomes.push({ decisionUri: uri, status: 'failure', score: -0.3, evidence: `PR #${it.number} closed without merge` });
        } else {
          outcomes.push({ decisionUri: uri, status: 'success', score: 0.5, evidence: `#${it.number} closed as completed` });
        }
      }
    }
    if (arr.length < 100) break;
  }
  return { items, outcomes, meta: { repo, issues, prs } };
}
