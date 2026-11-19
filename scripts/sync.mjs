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
 * Every git process goes through runCommand() (scripts/run-command.mjs), which
 * always waits for the child to be reaped, and every call disables git's
 * background maintenance (see GIT_NO_BACKGROUND below) — together those close
 * the Web Hosting #65 zombie leak. The container also runs under tini so that a
 * child git orphans is reaped rather than becoming a zombie; see start.sh.
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
import { pathToFileURL } from 'node:url';
import { validateContent } from './validate-content.mjs';
import { readSecret } from './secrets.mjs';
import { runCommand, countChildProcesses } from './run-command.mjs';

const CONTENT_DIR = process.env.CONTENT_DIR ?? '/app/src/content/blog';
const STATUS_FILE = process.env.SYNC_STATUS_FILE ?? '/app/data/sync-status.json';
const REMOTE = process.env.SYNC_REMOTE ?? 'origin';
const BRANCH = process.env.SYNC_BRANCH ?? 'main';
const INTERVAL_SECONDS = Number(process.env.SYNC_INTERVAL_SECONDS ?? 60);
const NTFY_URL = process.env.NTFY_URL ?? '';
const NTFY_TOKEN_FILE = process.env.NTFY_TOKEN_FILE ?? '';
const GIT_TIMEOUT_MS = Number(process.env.SYNC_GIT_TIMEOUT_MS ?? 60_000);

/** Operational failures in a row before the first alert. */
export const FAILURE_ALERT_THRESHOLD = 3;
/** Minimum gap between reminders while the failures continue. */
export const ALERT_REMINDER_MS = 60 * 60 * 1000;
/** git's stderr in an alert, and `last_error` in the status file. */
export const STDERR_MAX_CHARS = 500;

const log = (...parts) => console.log(new Date().toISOString(), '[sync]', ...parts);

// Shared with the startup checks; re-exported so existing callers keep working.
export { readSecret };

// Fail fast at startup, before any loop iteration, if a configured secret is absent.
const NTFY_TOKEN = process.env.NTFY_TOKEN_FILE ? readSecret(NTFY_TOKEN_FILE, 'sync') : '';

/**
 * Drop userinfo from anything URL-like. The content remote is anonymous, so in
 * practice git has no credentials to echo, but a misconfigured remote URL must
 * not be able to put them in an ntfy message or the status file.
 */
export function redactUserinfo(text) {
  return String(text ?? '').replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, '$1');
}

export function truncate(text, max = STDERR_MAX_CHARS) {
  const clean = String(text ?? '').trim();
  return clean.length <= max ? clean : `${clean.slice(0, max)}…`;
}

/**
 * Keep git from daemonising anything.
 *
 * This is the main Web Hosting #65 leak. Since git 2.46, `git fetch` runs
 * `git maintenance run --auto` when it finishes, and that gc work is detached
 * into the background — a new session, `Zs git` in `ps`. Node was PID 1 in the
 * container at the time (start.sh `exec`ed it), so the daemon was reparented to
 * node the moment its own parent exited. Node never reaps a child it did not
 * spawn: the daemon finished, became a zombie, left `cgroup.procs` and
 * `docker top`, and stayed charged to the container's 2,048-pid budget until a
 * restart. Verified in the image: one such zombie per fetch without these
 * flags, zero with them.
 *
 * `--no-auto-maintenance` exists only on `fetch`, so these config overrides do
 * the same job for every command. Nothing here needs background gc: the clone is
 * `reset --hard` on every publish and never accumulates objects for long.
 */
const GIT_NO_BACKGROUND = ['-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false'];

/** Short, human-readable reason for a failed runCommand() result. */
function describeGitFailure(args, result) {
  const what = `git ${args.join(' ')}`;
  if (result.timedOut) return `${what} timed out after ${result.timeoutMs}ms`;
  const lines = (result.stderr || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  const fatal = lines.filter(line => /^(fatal|error):/i.test(line)).pop();
  if (fatal) return fatal;
  if (lines.length) return lines[lines.length - 1];
  if (result.error) return `${what}: ${result.error.message}`;
  if (result.signal) return `${what} was killed by ${result.signal}`;
  return `${what} exited ${result.code ?? 'without a status'}`;
}

/**
 * Run git and wait for it. Throws on anything that is not a clean exit 0, and
 * always after the child has been reaped.
 */
async function git(args, { cwd = CONTENT_DIR, timeoutMs = GIT_TIMEOUT_MS } = {}) {
  const result = await runCommand('git', [...GIT_NO_BACKGROUND, ...args], {
    cwd,
    timeoutMs,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (!result.ok) {
    const error = new Error(describeGitFailure(args, result));
    error.result = result;
    error.stderr = result.stderr;
    throw error;
  }
  return result.stdout.trim();
}

async function revParse(ref, dir = CONTENT_DIR, timeoutMs = GIT_TIMEOUT_MS) {
  return git(['rev-parse', ref], { cwd: dir, timeoutMs });
}

async function isDirty(dir = CONTENT_DIR, timeoutMs = GIT_TIMEOUT_MS) {
  return (await git(['status', '--porcelain'], { cwd: dir, timeoutMs })).length > 0;
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

/** Deliver to ntfy. The default notifier; tests pass their own. */
async function sendNtfy(title, body, { priority = 'default', tags = 'warning' } = {}) {
  if (!NTFY_URL) {
    log(`alert (no NTFY_URL configured): ${title} — ${body}`);
    return false;
  }
  try {
    const headers = { Title: title, Priority: priority, Tags: tags };
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

async function validateAt(sha, dir = CONTENT_DIR, timeoutMs = GIT_TIMEOUT_MS) {
  const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-staging-'));
  try {
    await git(['worktree', 'add', '--detach', worktree, sha], { cwd: dir, timeoutMs });
    const names = fs.readdirSync(worktree).filter(f => f.endsWith('.md')).sort();
    const files = names.map(name => ({ name, raw: fs.readFileSync(path.join(worktree, name), 'utf-8') }));
    return validateContent({ files });
  } finally {
    try {
      await git(['worktree', 'remove', '--force', worktree], { cwd: dir, timeoutMs });
    } catch {
      fs.rmSync(worktree, { recursive: true, force: true });
    }
    try {
      await git(['worktree', 'prune'], { cwd: dir, timeoutMs });
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
  gitTimeoutMs = GIT_TIMEOUT_MS,
  notify = sendNtfy,
} = {}) {
  const checkedAt = new Date().toISOString();
  const previous = readStatus(statusFile);

  const runGit = (args, options = {}) => git(args, { cwd: contentDir, timeoutMs: gitTimeoutMs, ...options });

  // Alerting state lives in the status file, so a restart neither re-alerts for
  // a streak it already reported nor forgets one it is in the middle of.
  const streak = {
    consecutive_failures: Number(previous?.consecutive_failures ?? 0) || 0,
    failing_since: previous?.failing_since ?? null,
    last_error: previous?.last_error ?? null,
    last_alert_at: previous?.last_alert_at ?? null,
    alert_streak: previous?.alert_streak === true,
  };

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
      consecutive_failures: streak.consecutive_failures,
      failing_since: streak.failing_since,
      last_error: streak.last_error,
      last_alert_at: streak.last_alert_at,
      alert_streak: streak.alert_streak,
      child_processes: countChildProcesses(),
    }, statusFile);
    return result;
  };

  /**
   * Record an operational failure (fetch, staging, reset, dirty clone, …) and
   * alert only once the streak is real: 3 in a row, then at most hourly.
   */
  const failure = async (message, { stderr = '', from = null } = {}) => {
    streak.consecutive_failures += 1;
    if (!streak.failing_since) streak.failing_since = checkedAt;
    const detail = truncate(redactUserinfo([message, stderr.trim()].filter(Boolean).join('\n')));
    streak.last_error = detail;

    const lastAlertMs = Date.parse(streak.last_alert_at ?? '') || 0;
    const due = streak.consecutive_failures >= FAILURE_ALERT_THRESHOLD
      && (!streak.alert_streak || Date.now() - lastAlertMs >= ALERT_REMINDER_MS);

    if (due) {
      const title = streak.alert_streak
        ? `Blog content sync: still failing (${streak.consecutive_failures} in a row)`
        : `Blog content sync: failing (${streak.consecutive_failures} in a row)`;
      const body = [
        `Live content is unchanged${from ? ` at ${from.slice(0, 12)}` : ''}.`,
        `${streak.consecutive_failures} consecutive failure(s) since ${streak.failing_since}.`,
        stderr.trim() ? `\ngit output:\n${truncate(redactUserinfo(stderr.trim()))}` : '',
      ].filter(Boolean).join('\n');
      const delivered = await notify(title, body, { priority: 'default', tags: 'warning' });
      if (delivered) {
        streak.alert_streak = true;
        streak.last_alert_at = new Date().toISOString();
      }
    }
  };

  /**
   * The fetch worked: end the streak. If it had been alerted, say so once.
   * (A rejected commit still counts as a working fetch — the publish block has
   * its own one-alert-per-SHA rule.)
   */
  const recover = async (sha = null) => {
    const wasAlerting = streak.alert_streak === true;
    const failures = streak.consecutive_failures;
    const since = streak.failing_since;
    streak.consecutive_failures = 0;
    streak.failing_since = null;
    streak.last_error = null;
    streak.last_alert_at = null;
    streak.alert_streak = false;
    if (wasAlerting) {
      await notify(
        'Blog content sync: recovered',
        `Sync is working again${sha ? ` at ${sha.slice(0, 12)}` : ''} after ${failures} consecutive failure(s) since ${since}.`,
        { priority: 'default', tags: 'white_check_mark' }
      );
    }
  };

  let live;
  try {
    live = await revParse('HEAD', contentDir, gitTimeoutMs);
  } catch (e) {
    log(`cannot read live HEAD: ${e.message}`);
    await failure(`cannot read live HEAD: ${e.message}`, { stderr: e.stderr ?? '' });
    return finish({ action: 'error', message: `cannot read live HEAD: ${e.message}` });
  }

  // A dirty live clone means somebody edited it by hand. Never reset over that.
  try {
    if (await isDirty(contentDir, gitTimeoutMs)) {
      const message = 'live content clone has uncommitted changes — skipping this cycle, nothing was reset';
      log(message);
      await failure(message, { from: live });
      return finish({ action: 'error', from: live, message });
    }
  } catch (e) {
    await failure(`cannot inspect live clone: ${e.message}`, { stderr: e.stderr ?? '', from: live });
    return finish({ action: 'error', from: live, message: `cannot inspect live clone: ${e.message}` });
  }

  try {
    await runGit(['fetch', '--prune', remote, branch]);
  } catch (e) {
    const message = `git fetch failed: ${e.message}`;
    log(message);
    await failure(message, { stderr: e.stderr ?? '', from: live });
    return finish({ action: 'error', from: live, message });
  }

  let target;
  try {
    target = await revParse(`${remote}/${branch}`, contentDir, gitTimeoutMs);
  } catch (e) {
    const message = `cannot resolve ${remote}/${branch}: ${e.message}`;
    log(message);
    await failure(message, { stderr: e.stderr ?? '', from: live });
    return finish({ action: 'error', from: live, message });
  }

  if (target === live) {
    log(`no change at ${live.slice(0, 12)}`);
    await recover(live);
    return finish({ action: 'no-change', from: live, to: live });
  }

  // A hard reset is the point, so a rewind is applied — but it is worth saying out loud.
  let rewind = false;
  try {
    await runGit(['merge-base', '--is-ancestor', live, target]);
  } catch {
    rewind = true;
    log(`non-fast-forward: ${live.slice(0, 12)} is not an ancestor of ${target.slice(0, 12)} — syncing anyway (content repo is the source of truth)`);
  }

  log(`change detected: ${live.slice(0, 12)} -> ${target.slice(0, 12)}${rewind ? ' (non-fast-forward)' : ''}`);

  let validation;
  try {
    validation = await validateAt(target, contentDir, gitTimeoutMs);
  } catch (e) {
    const message = `could not stage ${target.slice(0, 12)} for validation: ${e.message}`;
    log(message);
    await failure(message, { stderr: e.stderr ?? '', from: live });
    return finish({ action: 'error', from: live, message });
  }

  if (!validation.ok) {
    // The fetch worked, so this ends any operational streak; the block itself
    // keeps its own rule of exactly one alert per bad SHA.
    await recover(live);
    const summary = validation.errors.map(e => e.message).join('\n');
    log(`validation failed for ${target.slice(0, 12)}: ${validation.errors.length} error(s); live content left at ${live.slice(0, 12)}`);
    let lastAlerted = previous?.last_alerted_sha ?? null;
    if (alertOnReject && lastAlerted !== target) {
      const delivered = await notify(
        'Blog publish blocked: content did not validate',
        `Commit ${target.slice(0, 12)} on ${branch} was not published. Live stays at ${live.slice(0, 12)}.\n\n${summary}`,
        { priority: 'high', tags: 'warning' }
      );
      if (delivered) lastAlerted = target;
    }
    return finish(
      { action: 'rejected', from: live, to: live, message: `validation failed for ${target.slice(0, 12)}`, errors: validation.errors },
      { last_alerted_sha: lastAlerted, target_sha: target }
    );
  }

  try {
    await runGit(['reset', '--hard', target]);
  } catch (e) {
    const message = `reset to ${target.slice(0, 12)} failed: ${e.message}`;
    log(message);
    await failure(message, { stderr: e.stderr ?? '', from: live });
    return finish({ action: 'error', from: live, message });
  }

  await recover(target);
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
