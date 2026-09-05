// Pure, in-process extractors that turn a repo checkout into CARMA memory
// items — with no HTTP and no token. Both the standalone CLIs
// (scripts/ingest-repo.mjs, scripts/ingest-git.mjs) and the server's native
// ingestion engine (server/ingest/run.ts) build on these, so classification,
// sectioning, and commit parsing stay identical whether a repo is pushed into
// CARMA from outside or pulled by CARMA itself.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { TraceInput } from '../ingest.js';

export type ItemType = 'doc' | 'agent-spec' | 'decision' | 'commit';

// A ready-to-store memory: a deterministic URI + trust domain + the trace body.
// storeTrace(adapter, {uri, trustDomain, ...}, item.input) or an equivalent
// POST /memory both consume this.
export interface IngestItem {
  uri: string;
  trustDomain: string;
  type: ItemType;
  input: TraceInput;
}

// A revert in history is outcome signal: the commit it undoes failed.
export interface RevertOutcome {
  decisionUri: string;
  status: 'failure';
  score: number;
  evidence: string;
}

export interface MarkdownOptions {
  domain: string;
  repo: string;
  exclude?: string[];
  noSplit?: boolean;
}

export interface GitOptions {
  domain: string;
  repo: string;
  branch?: string;
  since?: string;
  until?: string;
  max?: number;
}

// Repo slug for stable URIs: explicit wins, else the git remote, else dir name.
export function repoSlug(dir: string, explicit?: string): string {
  if (explicit) return explicit.replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
  try {
    const remote = execFileSync('git', ['-C', dir, 'config', '--get', 'remote.origin.url'], {
      encoding: 'utf8',
    }).trim();
    const m = remote.match(/[/:]([^/:]+\/[^/]+?)(?:\.git)?$/);
    if (m) return m[1];
  } catch {
    /* not a git repo / no remote */
  }
  return path.basename(dir);
}

// ------------------------------- markdown --------------------------------

function walk(root: string, excludes: string[]): string[] {
  const out: string[] = [];
  const skipDir = new Set(['.git', 'node_modules', '.next', 'dist', 'build', 'vendor', '.venv']);
  (function rec(d: string) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (!skipDir.has(ent.name)) rec(full);
      } else if (/\.mdx?$/i.test(ent.name)) {
        const rel = path.relative(root, full);
        if (!excludes.some((x) => rel.includes(x))) out.push(rel);
      }
    }
  })(root);
  return out.sort();
}

// Minimal front-matter (--- ... ---) parser.
function parseFrontMatter(text: string): { meta: Record<string, any>; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, any> = {};
  for (const line of m[1].split('\n')) {
    const kv = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    if (!kv) continue;
    let v: any = kv[2].trim().replace(/^["']|["']$/g, '');
    if (/^\[.*\]$/.test(v)) {
      v = v
        .slice(1, -1)
        .split(',')
        .map((s: string) => s.trim().replace(/^["']|["']$/g, ''))
        .filter(Boolean);
    }
    meta[kv[1].toLowerCase()] = v;
  }
  return { meta, body: text.slice(m[0].length) };
}

// Classify a markdown file into decision | agent-spec | doc by front-matter or path.
function classify(rel: string, meta: Record<string, any>): ItemType {
  const t = String(meta['carma.type'] || meta.type || '').toLowerCase();
  if (t === 'decision' || t === 'adr') return 'decision';
  if (t === 'agent-spec' || t === 'agent' || t === 'spec') return 'agent-spec';
  if (t === 'doc' || t === 'os' || t === 'reference') return 'doc';
  const p = rel.toLowerCase();
  const base = path.basename(p);
  if (/(^|\/)(decisions?|adrs?)(\/|$)/.test(p) || /^adr[-_]?\d+.*\.mdx?$/.test(base) || /[-_]decision\.mdx?$/.test(base))
    return 'decision';
  if (/(^|\/)(agents?|specs?|\.cursor)(\/|$)/.test(p) || base === 'agents.md' || /\.agent\.mdx?$/.test(base))
    return 'agent-spec';
  return 'doc';
}

// Salience defaults per type; front-matter can override.
const DEFAULTS: Record<ItemType, { confidence: number; importance: number }> = {
  decision: { confidence: 0.85, importance: 0.9 },
  'agent-spec': { confidence: 0.9, importance: 0.85 },
  doc: { confidence: 0.8, importance: 0.7 },
  commit: { confidence: 0.6, importance: 0.55 },
};

function num(v: any, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : def;
}

function slug(s: string): string {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'section';
}

// Split a doc into sections at H1/H2 for finer-grained recall. Content before
// the first heading becomes a preamble section titled by the doc title.
function sections(body: string, docTitle: string, noSplit: boolean): { heading: string; body: string }[] {
  if (noSplit) return [{ heading: docTitle, body: body.trim() }];
  const lines = body.split('\n');
  const out: { heading: string; body: string[] | string }[] = [];
  let cur: { heading: string; body: string[] } | null = null;
  let preamble: string[] = [];
  for (const line of lines) {
    const h = line.match(/^(#{1,2})\s+(.*)$/);
    if (h) {
      if (cur) out.push(cur);
      else {
        const pre = preamble.join('\n').trim();
        if (pre) out.push({ heading: docTitle, body: pre });
      }
      cur = { heading: h[2].trim(), body: [] };
    } else if (cur) {
      cur.body.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) out.push(cur);
  else if (out.length === 0) out.push({ heading: docTitle, body: preamble.join('\n').trim() });
  return out
    .map((s) => ({ heading: s.heading, body: Array.isArray(s.body) ? s.body.join('\n').trim() : s.body }))
    .filter((s) => s.body);
}

function firstH1(body: string): string | null {
  const m = body.match(/^#\s+(.*)$/m);
  return m ? m[1].trim() : null;
}

// Turn every markdown file under `dir` into one or more storable memories.
export function extractMarkdownItems(dir: string, opts: MarkdownOptions): IngestItem[] {
  const { domain, repo } = opts;
  const excludes = opts.exclude ?? [];
  const noSplit = Boolean(opts.noSplit);
  const items: IngestItem[] = [];
  for (const rel of walk(dir, excludes)) {
    const raw = fs.readFileSync(path.join(dir, rel), 'utf8');
    const { meta, body } = parseFrontMatter(raw);
    const type = classify(rel, meta);
    const docTitle = String(meta.title || firstH1(body) || path.basename(rel).replace(/\.mdx?$/i, ''));
    const d = DEFAULTS[type];
    const confidence = num(meta.confidence, d.confidence);
    const importance = num(meta.importance, d.importance);
    const fileUri = `trace://${domain}/gh/${repo}/${rel.split(path.sep).join('/')}`;

    let secs = sections(body, docTitle, noSplit);
    if (secs.length === 0) secs = [{ heading: docTitle, body: body.trim() || docTitle }];
    for (const sec of secs) {
      if (!sec.body && !sec.heading) continue;
      const uri = secs.length > 1 ? `${fileUri}#${slug(sec.heading)}` : fileUri;
      const task = docTitle === sec.heading ? docTitle : `${docTitle} — ${sec.heading}`;
      const content = sec.body || sec.heading;
      const boundContext = [`repo:${repo}`, `path:${rel.split(path.sep).join('/')}`, `type:${type}`];
      const input: TraceInput = { task, content, boundContext, confidence, importance };
      if (type === 'decision') input.decision = { choice: sec.heading || docTitle };
      if (meta.supersedes) input.supersedes = String(meta.supersedes);
      items.push({ uri, trustDomain: domain, type, input });
    }
  }
  return items;
}

// --------------------------------- git -----------------------------------

// %b (body) may contain newlines but never NUL/US, so parsing stays robust.
const US = '\x1f';

export interface Commit {
  sha: string;
  date: string;
  author: string;
  parents: string[];
  subject: string;
  body: string;
}

export function readCommits(dir: string, opts: Omit<GitOptions, 'domain' | 'repo'>): Commit[] {
  const max = opts.max ?? 5000;
  const range = opts.branch ? [opts.branch] : [];
  const args = [
    '-C',
    dir,
    'log',
    '-z',
    `--max-count=${max}`,
    '--date=iso-strict',
    `--format=%H${US}%aI${US}%an${US}%P${US}%s${US}%b`,
    ...range,
  ];
  if (opts.since) args.push(`--since=${opts.since}`);
  if (opts.until) args.push(`--until=${opts.until}`);
  const raw = execFileSync('git', args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  return raw
    .split('\0')
    .map((r) => r.trim())
    .filter(Boolean)
    .map((rec) => {
      const [sha, date, author, parents, subject, ...bodyParts] = rec.split(US);
      return {
        sha,
        date,
        author,
        parents: (parents || '').trim().split(/\s+/).filter(Boolean),
        subject: subject || '',
        body: bodyParts.join(US).trim(),
      };
    });
}

// Turn a repo's git history into dated decision memories (author date preserved
// so recall's recency decay reflects real chronology) plus revert outcomes.
export function extractGitItems(dir: string, opts: GitOptions): { items: IngestItem[]; reverts: RevertOutcome[] } {
  const { domain, repo } = opts;
  const commits = readCommits(dir, opts);
  const shas = new Set(commits.map((c) => c.sha));
  const items: IngestItem[] = commits.map((c) => {
    const isMerge = c.parents.length > 1;
    const uri = `trace://${domain}/gh/${repo}/commit/${c.sha}`;
    const content = [c.subject, c.body].filter(Boolean).join('\n\n');
    const boundContext = [`repo:${repo}`, `commit:${c.sha.slice(0, 12)}`, `author:${c.author}`, ...(isMerge ? ['merge'] : [])];
    const input: TraceInput = {
      task: c.subject,
      content,
      decision: { choice: c.subject },
      boundContext,
      confidence: DEFAULTS.commit.confidence,
      importance: isMerge ? 0.45 : DEFAULTS.commit.importance,
      occurredAt: c.date,
    };
    return { uri, trustDomain: domain, type: 'commit' as const, input };
  });

  // Reverts -> a failure outcome on the commit they undo, but only when that
  // commit is part of this batch (so /outcome can resolve it).
  const reverts: RevertOutcome[] = [];
  for (const c of commits) {
    const m = c.body.match(/This reverts commit ([0-9a-f]{7,40})/i);
    if (!m) continue;
    const target = commits.find((x) => x.sha.startsWith(m[1]) || m[1].startsWith(x.sha));
    if (!target || !shas.has(target.sha)) continue;
    reverts.push({
      decisionUri: `trace://${domain}/gh/${repo}/commit/${target.sha}`,
      status: 'failure',
      score: -0.7,
      evidence: `Reverted by ${c.sha.slice(0, 8)}: ${c.subject}`,
    });
  }
  return { items, reverts };
}
