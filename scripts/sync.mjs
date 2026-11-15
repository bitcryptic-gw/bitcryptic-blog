/**
 * Content sync loop for the BitCryptic blog.
 *
 * Runs as its own container from the blog image, with the same content clone
 * mounted as the web container sees it:
 *
 *   node scripts/sync.mjs            # loop, every SYNC_INTERVAL_SECONDS (60)
 *   node scripts/sync.mjs --once     # one cycle, for tests and manual runs
 *
 * Each cycle:
 *   1. git fetch the public HTTPS remote (anonymous — the content repo is public,
 *      so there is no key and no credential anywhere in this process);
 *   2. if origin/main has not moved, do nothing;
 *   3. if it has, check the new commit out into a staging worktree and run the
 *      shared validator there;
 *   4. validation passes  -> git reset --hard <sha> the live clone, log old/new;
 *      validation fails   -> leave live content untouched, alert once per SHA.
 *
 * Control files (all optional, all under CONTENT_DIR by default):
 *   SYNC_STATUS_FILE   JSON status, also served read-only at /api/sync-status
 *   NTFY_URL           full topic URL, e.g. https://ntfy.sh/blog-publish
 *   NTFY_TOKEN_FILE    file containing a bearer token for that topic
 *
 * If NTFY_TOKEN_FILE is configured but missing or empty, the process refuses to
 * start. No secret value is ever logged.
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { validateContent } from './validate-content.mjs';
import { readSecret } from './secrets.mjs';

const CONTENT_DIR = process.env.CONTENT_DIR ?? '/app/src/content/blog';
const STATUS_FILE = process.env.SYNC_STATUS_FILE ?? '/app/data/sync-status.json';
const REMOTE = process.env.SYNC_REMOTE ?? 'origin';
const BRANCH = process.env.SYNC_BRANCH ?? 'main';
const INTERVAL_SECONDS = Number(process.env.SYNC_INTERVAL_SECONDS ?? 60);
const NTFY_URL = process.env.NTFY_URL ?? '';
const NTFY_TOKEN_FILE = process.env.NTFY_TOKEN_FILE ?? '';
const GIT_TIMEOUT_MS = Number(process.env.SYNC_GIT_TIMEOUT_MS ?? 60_000);

const log = (...parts) => console.log(new Date().toISOString(), '[sync]', ...parts);

// Shared with the startup checks; re-exported so existing callers keep working.
export { readSecret };

// Fail fast at startup, before any loop iteration, if a configured secret is absent.
const NTFY_TOKEN = process.env.NTFY_TOKEN_FILE ? readSecret(NTFY_TOKEN_FILE, 'sync') : '';

function git(args, { cwd = CONTENT_DIR } = {}) {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: GIT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }).trim();
}

function revParse(ref, dir = CONTENT_DIR) {
  return git(['rev-parse', ref], { cwd: dir });
}

function isDirty(dir = CONTENT_DIR) {
  return git(['status', '--porcelain'], { cwd: dir }).length > 0;
}

function writeStatus(status, file = STATUS_FILE) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`);
    fs.renameSync(tmp, file);
  } catch (e) {
    log(`could not write status file ${file}: ${e.message}`);
  }
}

export function readStatus(file = STATUS_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

async function alert(title, body, { priority = 'default' } = {}) {
  if (!NTFY_URL) {
    log(`alert (no NTFY_URL configured): ${title} — ${body}`);
    return false;
  }
  try {
    const headers = { Title: title, Priority: priority, Tags: 'warning' };
    if (NTFY_TOKEN) headers.Authorization = `Bearer ${NTFY_TOKEN}`;
    const res = await fetch(NTFY_URL, { method: 'POST', headers, body });
    if (!res.ok) {
      log(`alert delivery failed: HTTP ${res.status}`);
      return false;
    }
    log(`alert delivered: ${title}`);
    return true;
  } catch (e) {
    // Never include the URL or token in the message.
    log(`alert delivery failed: ${e.message}`);
    return false;
  }
}

function validateAt(sha, dir = CONTENT_DIR) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-staging-'));
  try {
    git(['worktree', 'add', '--detach', worktree, sha], { cwd: dir });
    const names = fs.readdirSync(worktree).filter(f => f.endsWith('.md')).sort();
    const files = names.map(name => ({ name, raw: fs.readFileSync(path.join(worktree, name), 'utf-8') }));
    return validateContent({ files });
  } finally {
    try {
      git(['worktree', 'remove', '--force', worktree], { cwd: dir });
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    try {
      git(['worktree', 'prune'], { cwd: dir });
    } catch { /* best effort */ }
  }
}

/**
 * One sync cycle. Never throws: every failure is reported in the returned
 * result and in the status file.
 *
 * @returns {Promise<{action: 'no-change'|'updated'|'rejected'|'error', from?: string, to?: string, message?: string, errors?: object[]}>}
 */
export async function syncOnce({
  alertOnReject = true,
  contentDir = CONTENT_DIR,
  remote = REMOTE,
  branch = BRANCH,
  statusFile = STATUS_FILE,
} = {}) {
  const checkedAt = new Date().toISOString();
  const previous = readStatus(statusFile);

  const finish = (result, extra = {}) => {
    writeStatus({
      last_checked: checkedAt,
      live_sha: result.to ?? result.from ?? previous?.live_sha ?? null,
      target_sha: extra.target_sha ?? result.to ?? null,
      last_result: result.action,
      message: result.message ?? '',
      errors: (result.errors ?? []).slice(0, 20),
      last_alerted_sha: extra.last_alerted_sha ?? previous?.last_alerted_sha ?? null,
      interval_seconds: INTERVAL_SECONDS,
    }, statusFile);
    return result;
  };

  let live;
  try {
    live = revParse('HEAD', contentDir);
  } catch (e) {
    log(`cannot read live HEAD: ${e.message}`);
    return finish({ action: 'error', message: `cannot read live HEAD: ${e.message}` });
  }

  // A dirty live clone means somebody edited it by hand. Never reset over that.
  try {
    if (isDirty(contentDir)) {
      const message = 'live content clone has uncommitted changes — skipping this cycle, nothing was reset';
      log(message);
      await alert('Blog content sync: live clone is dirty', message);
      return finish({ action: 'error', from: live, message });
    }
  } catch (e) {
    return finish({ action: 'error', from: live, message: `cannot inspect live clone: ${e.message}` });
  }

  try {
    git(['fetch', '--prune', remote, branch], { cwd: contentDir });
  } catch (e) {
    const message = `git fetch failed: ${e.message.split('\n')[0]}`;
    log(message);
    await alert('Blog content sync: fetch failed', message);
    return finish({ action: 'error', from: live, message });
  }

  let target;
  try {
    target = revParse(`${remote}/${branch}`, contentDir);
  } catch (e) {
    const message = `cannot resolve ${remote}/${branch}: ${e.message}`;
    log(message);
    return finish({ action: 'error', from: live, message });
  }

  if (target === live) {
    log(`no change at ${live.slice(0, 12)}`);
    return finish({ action: 'no-change', from: live, to: live });
  }

  // A hard reset is the point, so a rewind is applied — but it is worth saying out loud.
  let rewind = false;
  try {
    git(['merge-base', '--is-ancestor', live, target], { cwd: contentDir });
  } catch {
    rewind = true;
    log(`non-fast-forward: ${live.slice(0, 12)} is not an ancestor of ${target.slice(0, 12)} — syncing anyway (content repo is the source of truth)`);
  }

  log(`change detected: ${live.slice(0, 12)} -> ${target.slice(0, 12)}${rewind ? ' (non-fast-forward)' : ''}`);

  let validation;
  try {
    validation = validateAt(target, contentDir);
  } catch (e) {
    const message = `could not stage ${target.slice(0, 12)} for validation: ${e.message.split('\n')[0]}`;
    log(message);
    await alert('Blog content sync: staging failed', message);
    return finish({ action: 'error', from: live, message });
  }

  if (!validation.ok) {
    const summary = validation.errors.map(e => e.message).join('\n');
    log(`validation failed for ${target.slice(0, 12)}: ${validation.errors.length} error(s); live content left at ${live.slice(0, 12)}`);
    let lastAlerted = previous?.last_alerted_sha ?? null;
    if (alertOnReject && lastAlerted !== target) {
      const delivered = await alert(
        'Blog publish blocked: content did not validate',
        `Commit ${target.slice(0, 12)} on ${BRANCH} was not published. Live stays at ${live.slice(0, 12)}.\n\n${summary}`,
        { priority: 'high' }
      );
      if (delivered) lastAlerted = target;
    }
    return finish(
      { action: 'rejected', from: live, to: live, message: `validation failed for ${target.slice(0, 12)}`, errors: validation.errors },
      { last_alerted_sha: lastAlerted, target_sha: target }
    );
  }

  try {
    git(['reset', '--hard', target], { cwd: contentDir });
  } catch (e) {
    const message = `reset to ${target.slice(0, 12)} failed: ${e.message.split('\n')[0]}`;
    log(message);
    await alert('Blog content sync: reset failed', message);
    return finish({ action: 'error', from: live, message });
  }

  log(`published ${target.slice(0, 12)} (was ${live.slice(0, 12)}), ${validation.posts.length} post file(s) validated`);
  return finish({ action: 'updated', from: live, to: target, message: `published ${target.slice(0, 12)}` });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  log(`starting: content=${CONTENT_DIR} remote=${REMOTE}/${BRANCH} every ${INTERVAL_SECONDS}s status=${STATUS_FILE}`);
  let stopping = false;
  const stop = signal => {
    log(`${signal} received, finishing the current cycle and exiting`);
    stopping = true;
  };
  process.on('SIGTERM', () => stop('SIGTERM'));
  process.on('SIGINT', () => stop('SIGINT'));

  while (!stopping) {
    try {
      await syncOnce();
    } catch (e) {
      // syncOnce is not supposed to throw; if it does, keep the loop alive.
      log(`unexpected error: ${e.message}`);
    }
    if (stopping) break;
    await sleep(INTERVAL_SECONDS * 1000);
  }
  log('stopped');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  if (process.argv.includes('--once')) {
    const result = await syncOnce();
    log(`one-shot result: ${result.action}${result.message ? ` — ${result.message}` : ''}`);
    process.exit(result.action === 'error' || result.action === 'rejected' ? 1 : 0);
  } else {
    await main();
  }
}
