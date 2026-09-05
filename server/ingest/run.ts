// Native ingestion engine: CARMA pulls a source into its own memory, in-process.
// This is the counterpart to `dream` — where dreaming is offline *maintenance*
// of memory, ingestion is offline *acquisition* of it. It clones/updates a git
// checkout, runs the shared extractors, and persists via storeTrace/recordOutcome
// directly (no HTTP, no capability token — it is trusted server-internal code,
// exactly like the consolidation pass). Triggered by POST /ingest or the internal
// scheduler.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractMarkdownItems, extractGitItems, repoSlug } from './extract.js';
import { storeTrace, recordOutcome } from '../ingest.js';
import type { Source } from './sources.js';

export interface RunOptions {
  dryRun?: boolean;
  subject?: string;
  log?: (event: string, detail?: any) => void;
}

function isLocalCheckout(url: string): boolean {
  // A path we can read directly (no clone): absolute/relative dir or file://.
  if (url.startsWith('file://')) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return false; // http(s), git, ssh scheme
  if (/^git@/.test(url)) return false; // scp-like ssh
  try {
    return fs.existsSync(url);
  } catch {
    return false;
  }
}

function localPath(url: string): string {
  return url.startsWith('file://') ? url.slice('file://'.length) : url;
}

function git(dir: string, args: string[]) {
  return execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
}

// Build a clone URL, injecting a token for private https when tokenEnv is set.
function authUrl(source: Source): string {
  const raw = source.url;
  if (source.tokenEnv && /^https:\/\//i.test(raw)) {
    const token = process.env[source.tokenEnv];
    if (token) return raw.replace(/^https:\/\//i, `https://x-access-token:${token}@`);
  }
  return raw;
}

// Ensure a current local checkout for `source` and return its directory. Local
// sources are used in place; remote git URLs are cloned once then fast-forwarded
// (reset --hard to the remote head) on subsequent runs. Deterministic per id.
export function ensureCheckout(source: Source, workDir: string, log: RunOptions['log'] = () => {}): string {
  if (isLocalCheckout(source.url)) {
    const p = path.resolve(localPath(source.url));
    if (!fs.existsSync(p)) throw new Error(`source ${source.id}: local path not found: ${p}`);
    return p;
  }
  fs.mkdirSync(workDir, { recursive: true });
  const dest = path.join(workDir, source.id.replace(/[^A-Za-z0-9._-]/g, '_'));
  const url = authUrl(source);
  if (fs.existsSync(path.join(dest, '.git'))) {
    log('ingest_checkout_update', { source: source.id });
    git(dest, ['remote', 'set-url', 'origin', url]);
    git(dest, ['fetch', '--prune', '--tags', 'origin']);
    const branch = source.branch || defaultBranch(dest);
    git(dest, ['checkout', '-q', branch]);
    git(dest, ['reset', '--hard', `origin/${branch}`]);
  } else {
    log('ingest_checkout_clone', { source: source.id });
    fs.rmSync(dest, { recursive: true, force: true });
    const args = ['clone', '--quiet'];
    if (source.branch) args.push('--branch', source.branch);
    args.push(url, dest);
    execFileSync('git', args, { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return dest;
}

function defaultBranch(dir: string): string {
  try {
    const ref = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']).trim();
    return ref.replace(/^origin\//, '') || 'main';
  } catch {
    try {
      return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() || 'main';
    } catch {
      return 'main';
    }
  }
}

// Pull one source into memory. Returns a report; `dryRun` computes counts (after
// checking out, so remote sources still need network) without writing.
export async function runSource(adapter: any, config: any, source: Source, opts: RunOptions = {}) {
  const dryRun = Boolean(opts.dryRun);
  const log = opts.log || (() => {});
  const subject = opts.subject || 'carma-ingest';
  const startedAt = new Date().toISOString();

  const trustDomain = source.trustDomain || config.trustDomain;
  if (!trustDomain) throw new Error(`source ${source.id}: no trustDomain (set source.trustDomain or TRUST_DOMAIN)`);
  if (source.type !== 'git') throw new Error(`source ${source.id}: unsupported type "${source.type}"`);
  if (!dryRun && !config.privateKeyPem) throw new Error('Server missing PRIVATE_KEY for signing ingested memory');

  const dir = ensureCheckout(source, config.ingestWorkDir, log);
  const repo = source.repo || repoSlug(dir);
  const report: any = {
    sourceId: source.id,
    type: source.type,
    trustDomain,
    repo,
    dryRun,
    startedAt,
    docs: { count: 0, failed: 0 },
    commits: { count: 0, failed: 0 },
    outcomes: { count: 0 },
  };

  // Bulk acquisition skips per-write near-duplicate review (that would flood the
  // queue); dreaming does dedup in batch afterwards. Tiering still applies, so
  // curated docs/specs enter 'consolidated' and commits enter 'working'.
  const policy = {
    consolidate: false,
    tierMinConfidence: config.tierConsolidateMinConfidence,
    tierMinImportance: config.tierConsolidateMinImportance,
  };
  const ctxBase = { trustDomain, subject, privateKeyPem: config.privateKeyPem };

  if (source.docs) {
    const items = extractMarkdownItems(dir, { domain: trustDomain, repo, exclude: source.exclude });
    for (const it of items) {
      if (dryRun) {
        report.docs.count++;
        continue;
      }
      try {
        await storeTrace(adapter, { uri: it.uri, ...ctxBase }, it.input, policy);
        report.docs.count++;
      } catch (e: any) {
        report.docs.failed++;
        log('ingest_doc_failed', { source: source.id, uri: it.uri, error: e.message });
      }
    }
  }

  if (source.history && fs.existsSync(path.join(dir, '.git'))) {
    const { items, reverts } = extractGitItems(dir, {
      domain: trustDomain,
      repo,
      branch: source.branch || undefined,
      since: source.since || undefined,
      max: source.maxCommits,
    });
    const stored = new Set<string>();
    for (const it of items) {
      if (dryRun) {
        report.commits.count++;
        stored.add(it.uri);
        continue;
      }
      try {
        await storeTrace(adapter, { uri: it.uri, ...ctxBase }, it.input, policy);
        report.commits.count++;
        stored.add(it.uri);
      } catch (e: any) {
        report.commits.failed++;
        log('ingest_commit_failed', { source: source.id, uri: it.uri, error: e.message });
      }
    }
    if (!dryRun) {
      for (const rv of reverts) {
        if (!stored.has(rv.decisionUri)) continue;
        try {
          await recordOutcome(adapter, ctxBase, {
            decisionUri: rv.decisionUri,
            status: rv.status,
            score: rv.score,
            evidence: rv.evidence,
          });
          report.outcomes.count++;
        } catch (e: any) {
          log('ingest_outcome_failed', { source: source.id, uri: rv.decisionUri, error: e.message });
        }
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}
