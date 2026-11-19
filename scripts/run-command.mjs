/**
 * The one way this repo runs a child process.
 *
 * Web Hosting #65 put the sync container at its pids limit (2,047 of 2,048, with
 * only three live processes) in two ways, and this module exists because of the
 * second:
 *
 *   1. `git fetch` daemonised its post-fetch auto-maintenance (`Zs git`). Node
 *      was PID 1 in the container, so the daemon was reparented to it and never
 *      reaped. Fixed at the source — scripts/sync.mjs passes
 *      `-c maintenance.auto=false -c gc.autoDetach=false` to every git call —
 *      because no amount of waiting in this module can reap a process Node did
 *      not spawn. tini as PID 1 (scripts/start.sh) covers the rest: git also
 *      orphans its transport helper when a fetch fails, and the child a
 *      process-group kill leaves behind. The claim that an init "would not fix
 *      this, because these are node's own children" was wrong.
 *   2. `execFileSync` with a `timeout` sends the kill signal and closes the
 *      child handle before the child has exited, leaving the direct child
 *      unreaped (reproducible on Linux: one zombie per timed-out call), and it
 *      gives no way to kill git's transport helper with it.
 *
 * So every child goes through runCommand(), which keeps the handle alive until
 * the child is reaped on every path: success, non-zero exit, spawn error,
 * timeout and abort.
 *
 * On timeout it signals the child's whole process group (SIGTERM, then SIGKILL
 * after `killGraceMs`), because `git fetch` puts the transport in a helper
 * process (`git-remote-https`) that would otherwise survive the kill. That is
 * the only reason `detached: true` is used — the child leads its own group so
 * the group can be signalled. The wait is still this module's job.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** Bytes kept per stream. Anything past this is dropped and flagged. */
export const DEFAULT_MAX_OUTPUT_BYTES = 64 * 1024;

/** How long a killed group gets between SIGTERM and SIGKILL. */
export const DEFAULT_KILL_GRACE_MS = 500;

/** How long to wait for stdio to close after the child has been reaped. */
const CLOSE_GRACE_MS = 250;

const live = new Set();
let exitHookInstalled = false;

function track(child) {
  live.add(child);
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.once('exit', () => {
      for (const c of live) {
        if (!c.pid) continue;
        try {
          process.kill(-c.pid, 'SIGKILL');
        } catch {
          /* already gone */
        }
      }
    });
  }
}

function collector(limit) {
  const chunks = [];
  let bytes = 0;
  let truncated = false;
  return {
    push(chunk) {
      if (bytes >= limit) {
        truncated = true;
        return;
      }
      const room = limit - bytes;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        bytes = limit;
        truncated = true;
      } else {
        chunks.push(chunk);
        bytes += chunk.length;
      }
    },
    text: () => Buffer.concat(chunks).toString('utf-8'),
    get truncated() {
      return truncated;
    },
  };
}

/**
 * Run `command args...` and wait for it to be reaped.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{
 *   cwd?: string,
 *   env?: NodeJS.ProcessEnv,
 *   timeoutMs?: number,
 *   maxOutputBytes?: number,
 *   killGraceMs?: number,
 *   signal?: AbortSignal,
 * }} [options]
 * @returns {Promise<{
 *   ok: boolean,
 *   command: string,
 *   args: string[],
 *   pid: number | null,
 *   code: number | null,
 *   signal: string | null,
 *   stdout: string,
 *   stderr: string,
 *   stdoutTruncated: boolean,
 *   stderrTruncated: boolean,
 *   timedOut: boolean,
 *   aborted: boolean,
 *   killed: boolean,
 *   timeoutMs: number,
 *   error: Error | null,
 *   durationMs: number,
 * }>}
 */
export function runCommand(command, args = [], options = {}) {
  const {
    cwd,
    env,
    timeoutMs = 0,
    maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
    killGraceMs = DEFAULT_KILL_GRACE_MS,
    signal,
  } = options;

  const startedAt = Date.now();
  const out = collector(maxOutputBytes);
  const err = collector(maxOutputBytes);

  const empty = (error) => ({
    ok: false,
    command,
    args,
    pid: null,
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    timedOut: false,
    aborted: false,
    killed: false,
    timeoutMs,
    error: error ?? null,
    durationMs: Date.now() - startedAt,
  });

  let child;
  try {
    child = spawn(command, args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
      windowsHide: true,
    });
  } catch (error) {
    return Promise.resolve(empty(error));
  }

  track(child);
  child.stdout?.on('data', chunk => out.push(chunk));
  child.stderr?.on('data', chunk => err.push(chunk));

  return new Promise((resolve) => {
    let settled = false;
    let exit = null;
    let spawnError = null;
    let timedOut = false;
    let aborted = false;
    let killed = false;
    let timeoutTimer = null;
    let killTimer = null;
    let closeTimer = null;
    let abortListener = null;

    // Signal the child's process group so git's transport helper dies with it.
    const signalGroup = (sig) => {
      if (exit || spawnError || !child.pid) return;
      killed = true;
      try {
        process.kill(-child.pid, sig);
      } catch {
        try {
          child.kill(sig);
        } catch {
          /* already gone */
        }
      }
    };

    const escalate = () => {
      if (killTimer) clearTimeout(killTimer);
      killTimer = setTimeout(() => signalGroup('SIGKILL'), killGraceMs);
    };

    const settle = () => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      if (closeTimer) clearTimeout(closeTimer);
      if (abortListener) signal?.removeEventListener('abort', abortListener);
      live.delete(child);
      resolve({
        ok: !spawnError && !timedOut && !aborted && exit !== null && exit.code === 0,
        command,
        args,
        pid: child.pid ?? null,
        code: exit?.code ?? null,
        signal: exit?.signal ?? null,
        stdout: out.text(),
        stderr: err.text(),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
        timedOut,
        aborted,
        killed,
        timeoutMs,
        error: spawnError,
        durationMs: Date.now() - startedAt,
      });
    };

    // A spawn error (ENOENT and friends) arrives here and never produces 'exit'.
    child.once('error', (error) => {
      spawnError = error;
      settle();
    });

    // 'exit' is the point at which Node has reaped the child. Wait briefly for
    // stdio to drain, but never let a pipe held open by a grandchild keep this
    // promise pending.
    child.once('exit', (code, sig) => {
      exit = { code, signal: sig };
      closeTimer = setTimeout(settle, CLOSE_GRACE_MS);
    });
    child.once('close', settle);

    if (timeoutMs > 0) {
      timeoutTimer = setTimeout(() => {
        timedOut = true;
        signalGroup('SIGTERM');
        escalate();
      }, timeoutMs);
    }

    if (signal) {
      const onAbort = () => {
        aborted = true;
        signalGroup('SIGTERM');
        escalate();
      };
      if (signal.aborted) {
        onAbort();
      } else {
        abortListener = onAbort;
        signal.addEventListener('abort', onAbort, { once: true });
      }
    }
  });
}

/**
 * Count this process's children, live and zombie alike, from
 * /proc/<pid>/task/<tid>/children. Returns null where /proc is unavailable
 * (e.g. macOS), so callers can tell "no children" from "cannot tell".
 *
 * Zombies are the point: they are invisible to `docker top` and to
 * `cgroup.procs`, but they are still charged to pids.max, so a leak only shows
 * up here (or in /sys/fs/cgroup/pids.current) until fork() starts failing.
 */
export function countChildProcesses(pid = process.pid) {
  let total = 0;
  try {
    for (const tid of fs.readdirSync(`/proc/${pid}/task`)) {
      const raw = fs.readFileSync(`/proc/${pid}/task/${tid}/children`, 'utf-8').trim();
      if (raw) total += raw.split(/\s+/).length;
    }
    return total;
  } catch {
    return null;
  }
}
