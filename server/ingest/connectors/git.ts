// Git connector: clone/fast-forward a repo and turn its markdown (specs,
// decisions, OS docs) and full git history (dated decisions + revert outcomes)
// into memory items. Extraction is shared with the standalone CLIs
// (server/ingest/extract.ts); this module adds the checkout management.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractMarkdownItems, extractGitItems, repoSlug } from '../extract.js';
import type { CollectContext, CollectResult } from './index.js';

function isLocalCheckout(url: string): boolean {
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

// Inject a token for private https clones when tokenEnv is set.
function authUrl(source: any): string {
  const raw = source.url;
  if (source.tokenEnv && /^https:\/\//i.test(raw)) {
    const token = process.env[source.tokenEnv];
    if (token) return raw.replace(/^https:\/\//i, `https://x-access-token:${token}@`);
  }
  return raw;
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

// Ensure a current local checkout and return its directory. Local sources are
// used in place; remote git URLs are cloned once then fast-forwarded on later
// runs. Deterministic per source id.
export function ensureCheckout(source: any, workDir: string, log: (e: string, d?: any) => void = () => {}): string {
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

export async function collectGit(source: any, config: any, ctx: CollectContext): Promise<CollectResult> {
  const trustDomain = ctx.trustDomain;
  const dir = ensureCheckout(source, config.ingestWorkDir, ctx.log);
  const repo = source.repo || repoSlug(dir);
  const items = [];
  const outcomes = [];
  if (source.docs !== false) {
    items.push(...extractMarkdownItems(dir, { domain: trustDomain, repo, exclude: source.exclude }));
  }
  if (source.history !== false && fs.existsSync(path.join(dir, '.git'))) {
    const g = extractGitItems(dir, {
      domain: trustDomain,
      repo,
      branch: source.branch || undefined,
      since: source.since || undefined,
      max: source.maxCommits,
    });
    items.push(...g.items);
    outcomes.push(...g.reverts);
  }
  return { items, outcomes, meta: { repo, checkout: dir } };
}
