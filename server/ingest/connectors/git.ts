// Git connector: clone/fast-forward a repo and turn its markdown (specs,
// decisions, OS docs) and full git history (dated decisions + revert outcomes)
// into memory items. Extraction is shared with the standalone CLIs
// (server/ingest/extract.ts); this module adds the checkout management.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { extractMarkdownItems, extractGitItems, repoSlug } from '../extract.js';
import type { CollectContext, CollectResult } from './index.js';

// A stalled remote must not hang ingestion (and, since git runs synchronously,
// the request loop) indefinitely.
const GIT_TIMEOUT_MS = 10 * 60 * 1000;

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

// Strip embedded credentials (https://user:token@host) from text that may reach
// logs, audit rows, /api/status or an /ingest response.
export function redactUrlCredentials(text: string): string {
  return String(text).replace(/(:\/\/)[^/\s@]+@/g, '$1***@');
}

// Credentials for private https remotes travel as an http.extraHeader through
// GIT_CONFIG_* environment variables — never on the command line or in the
// remote URL — so they cannot surface in error text, process listings, or the
// checkout's .git/config.
function gitEnv(source: any): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  if (source.tokenEnv && /^https:\/\//i.test(String(source.url))) {
    const token = process.env[source.tokenEnv];
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      env.GIT_CONFIG_COUNT = '1';
      env.GIT_CONFIG_KEY_0 = 'http.extraHeader';
      env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
    }
  }
  return env;
}

function git(dir: string | null, args: string[], env: NodeJS.ProcessEnv): string {
  const argv = dir ? ['-C', dir, ...args] : args;
  try {
    return execFileSync('git', argv, {
      encoding: 'utf8',
      maxBuffer: 512 * 1024 * 1024,
      timeout: GIT_TIMEOUT_MS,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e: any) {
    const detail = (e?.stderr ? String(e.stderr).trim() : '') || e?.message || String(e);
    throw new Error(`git ${args[0]} failed: ${redactUrlCredentials(detail)}`);
  }
}

function defaultBranch(dir: string, env: NodeJS.ProcessEnv): string {
  try {
    const ref = git(dir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD'], env).trim();
    return ref.replace(/^origin\//, '') || 'main';
  } catch {
    try {
      return git(dir, ['rev-parse', '--abbrev-ref', 'HEAD'], env).trim() || 'main';
    } catch {
      return 'main';
    }
  }
}

// Ensure a current local checkout and return its directory. Local sources are
// used in place; remote git URLs are cloned once then fast-forwarded on later
// runs. Deterministic per source id, always inside workDir.
export function ensureCheckout(source: any, workDir: string, log: (e: string, d?: any) => void = () => {}): string {
  if (isLocalCheckout(String(source.url))) {
    const p = path.resolve(localPath(String(source.url)));
    if (!fs.existsSync(p)) throw new Error(`source ${source.id}: local path not found: ${p}`);
    return p;
  }
  const safeId = String(source.id ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!safeId || safeId === '.' || safeId === '..') throw new Error(`source ${source.id}: invalid source id`);
  const root = path.resolve(workDir);
  const dest = path.resolve(root, safeId);
  if (!dest.startsWith(root + path.sep)) throw new Error(`source ${source.id}: checkout would escape INGEST_WORK_DIR`);
  fs.mkdirSync(root, { recursive: true });
  const env = gitEnv(source);
  const url = String(source.url);
  if (fs.existsSync(path.join(dest, '.git'))) {
    log('ingest_checkout_update', { source: source.id });
    git(dest, ['remote', 'set-url', 'origin', url], env);
    git(dest, ['fetch', '--prune', '--tags', 'origin'], env);
    const branch = source.branch || defaultBranch(dest, env);
    git(dest, ['checkout', '-q', branch], env);
    git(dest, ['reset', '--hard', `origin/${branch}`], env);
  } else {
    log('ingest_checkout_clone', { source: source.id });
    fs.rmSync(dest, { recursive: true, force: true });
    const args = ['clone', '--quiet'];
    if (source.branch) args.push('--branch', source.branch);
    args.push(url, dest);
    git(null, args, env);
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
