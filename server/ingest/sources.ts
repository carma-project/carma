// Source registry: declarative descriptions of the external systems CARMA pulls
// context from. Today the only connector type is `git`; the shape is
// intentionally connector-agnostic so `postgres`, `http`, issue trackers, etc.
// can be added without changing callers. Sources are configured via the SOURCES
// env (a JSON array) or SOURCES_FILE (a path to that JSON).

export interface Source {
  id: string;
  type: string; // 'git'
  url: string; // git URL or local path
  trustDomain: string | null; // defaults to server TRUST_DOMAIN at run time
  branch: string | null;
  since: string | null; // incremental window for history, e.g. "30 days ago"
  repo: string | null; // slug for URIs; derived from remote/dir when null
  docs: boolean; // ingest markdown (specs / decisions / OS docs)
  history: boolean; // ingest git commit history
  maxCommits: number;
  exclude: string[];
  intervalMinutes: number; // scheduler cadence; 0 = manual (POST /ingest) only
  tokenEnv: string | null; // env var holding a git token for private https clones
}

export function normalizeSource(raw: any): Source {
  const n = Number(raw.intervalMinutes);
  const mc = Number(raw.maxCommits);
  return {
    id: String(raw.id),
    type: String(raw.type || 'git').toLowerCase(),
    url: String(raw.url || raw.path || ''),
    trustDomain: raw.trustDomain ? String(raw.trustDomain) : null,
    branch: raw.branch ? String(raw.branch) : null,
    since: raw.since ? String(raw.since) : null,
    repo: raw.repo ? String(raw.repo).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '') : null,
    docs: raw.docs !== false,
    history: raw.history !== false,
    maxCommits: Number.isFinite(mc) && mc > 0 ? Math.trunc(mc) : 100000,
    exclude: Array.isArray(raw.exclude) ? raw.exclude.map(String) : [],
    intervalMinutes: Number.isFinite(n) && n > 0 ? n : 0,
    tokenEnv: raw.tokenEnv ? String(raw.tokenEnv) : null,
  };
}

// Parse an array of raw source objects into validated Sources, dropping entries
// that are missing an id or url (callers surface a warning for those).
export function parseSources(rawArr: any): Source[] {
  if (!Array.isArray(rawArr)) return [];
  const seen = new Set<string>();
  const out: Source[] = [];
  for (const raw of rawArr) {
    if (!raw || !raw.id || !(raw.url || raw.path)) continue;
    const s = normalizeSource(raw);
    if (seen.has(s.id)) continue; // ids must be unique (stable per source)
    seen.add(s.id);
    out.push(s);
  }
  return out;
}

// Non-secret projection for /api/status and boot logs.
export function summarizeSource(s: Source) {
  return {
    id: s.id,
    type: s.type,
    trustDomain: s.trustDomain,
    repo: s.repo,
    docs: s.docs,
    history: s.history,
    intervalMinutes: s.intervalMinutes,
  };
}
