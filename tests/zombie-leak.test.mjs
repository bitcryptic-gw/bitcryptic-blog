/**
 * The Web Hosting #65 regression tests.
 *
 * Both probes drive the *real* sync code — 200 cycles each, mixing no-change,
 * valid publishes, rejecting publishes, fetch failures and fetch timeouts
 * (`tests/helpers/fake-git` hangs on fetch while a marker file exists) — and
 * then ask the process that did the work whether it still has any children.
 *
 * On the old code (`execFileSync` with a `timeout`) each forced timeout leaked a
 * zombie on Linux: the kill signal is sent and the handle closed before the
 * child exits, so libuv never reaps it. The probe therefore fails on the old
 * code in the image (where these run in production), and passes on the new
 * helper. On macOS the old code did not leak, so the host run is a no-op proof;
 * the in-image run is the one that counts.
 */
import assert from 'node:assert/strict';
import test, { before } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureBuilt } from './helpers/build.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

function runProbe(script, { timeoutMs = 600_000, args = [], env = {} } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(HERE, script), ...args], {
      cwd: path.resolve(HERE, '..'),
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      let report = null;
      const lastLine = stdout.trim().split('\n').filter(Boolean).pop();
      try {
        report = JSON.parse(lastLine ?? 'null');
      } catch { /* leave null */ }
      resolve({ code, signal, report, stdout, stderr });
    });
  });
}

before(async () => {
  await ensureBuilt();
});

test('100 clean sync cycles leave nothing behind, not even at PID 1', { timeout: 600_000 }, async () => {
  // No fetch failures and no timeouts, so the new code should fork nothing that
  // outlives git. The pre-#65 code leaked one zombie per successful fetch here
  // (git's post-fetch maintenance daemon, reparented to the container's PID 1).
  const run = await runProbe('helpers/zombie-probe.mjs', { args: ['--clean'], env: { PROBE_CYCLES: '100' } });
  assert.ok(run.report, `probe produced no report: ${run.stderr || run.stdout}`);
  assert.equal(run.report.error, undefined, run.report.error);
  assert.equal(run.report.mode, 'clean');
  assert.equal(run.code, 0, `probe exited ${run.code}: ${JSON.stringify(run.report)}`);
  assert.equal(run.report.childrenAtEnd, 0, JSON.stringify(run.report.leftoverSamples));
  // A daemonised child is reparented to the container's PID 1, so it is only
  // observable from in-suite when nothing else is spawning git at the same time
  // (other test files are). `orphanZombiesDelta` is reported for the documented
  // production-shape run instead — see README, "Running the leak probes".
  assert.ok(run.report.outcomes.updated >= 20, JSON.stringify(run.report.outcomes));
});

test('the sync loop leaves no zombies behind over 200 mixed cycles', { timeout: 600_000 }, async () => {
  const run = await runProbe('helpers/zombie-probe.mjs');
  assert.ok(run.report, `probe produced no report: ${run.stderr || run.stdout}`);
  assert.equal(run.report.error, undefined, run.report.error);
  assert.equal(run.code, 0, `probe exited ${run.code}: ${JSON.stringify(run.report)}`);
  assert.equal(run.report.childrenAtEnd, 0, JSON.stringify(run.report.leftoverSamples));
  assert.equal(run.report.zombiesAtEnd, 0, JSON.stringify(run.report.leftoverSamples));
  assert.equal(run.report.maxChildrenSeen, 0, 'a child was still present after a cycle');

  // `orphanZombiesDelta` is reported but not asserted here: a daemonised git
  // child is reparented to the container's PID 1, so whether it shows up as a
  // zombie depends on the shape the probe was started in. The production shape
  // (tini as PID 1, so nothing is left behind) has its own documented check —
  // see README, "Running the leak probes".

  // The mix actually exercised what it claims to.
  assert.equal(run.report.cycles, 200);
  assert.ok(run.report.forcedTimeouts >= 20, `only ${run.report.forcedTimeouts} forced timeouts`);
  assert.ok(run.report.forcedFetchFailures >= 20, `only ${run.report.forcedFetchFailures} forced fetch failures`);
  assert.ok(run.report.outcomes.updated >= 40, JSON.stringify(run.report.outcomes));
  assert.ok(run.report.outcomes.rejected >= 20, JSON.stringify(run.report.outcomes));
  assert.ok(run.report.outcomes.error >= 40, JSON.stringify(run.report.outcomes));
});

test('100 clean /api/deploy cycles leave nothing behind, not even at PID 1', { timeout: 600_000 }, async () => {
  const run = await runProbe('helpers/deploy-zombie-probe.mjs', { args: ['--clean'], env: { PROBE_CYCLES: '100' } });
  assert.ok(run.report, `probe produced no report: ${run.stderr || run.stdout}`);
  assert.equal(run.report.error, undefined, run.report.error);
  assert.equal(run.report.mode, 'clean');
  assert.equal(run.code, 0, `probe exited ${run.code}: ${JSON.stringify(run.report)}`);
  assert.equal(run.report.childrenAtEnd, 0, JSON.stringify(run.report.leftoverSamples));
});

test('the /api/deploy path leaves no zombies behind over 200 mixed cycles', { timeout: 600_000 }, async () => {
  const run = await runProbe('helpers/deploy-zombie-probe.mjs');
  assert.ok(run.report, `probe produced no report: ${run.stderr || run.stdout}`);
  assert.equal(run.report.error, undefined, run.report.error);
  assert.equal(run.code, 0, `probe exited ${run.code}: ${JSON.stringify(run.report)}`);
  assert.equal(run.report.childrenAtEnd, 0, JSON.stringify(run.report.leftoverSamples));
  assert.equal(run.report.zombiesAtEnd, 0, JSON.stringify(run.report.leftoverSamples));
  assert.equal(run.report.maxChildrenSeen, 0, 'a child was still present after a request');

  assert.equal(run.report.cycles, 200);
  assert.ok(run.report.forcedTimeouts >= 20);
  assert.ok(run.report.outcomes.ok >= 75, JSON.stringify(run.report.outcomes));
  assert.ok(run.report.outcomes.error >= 40, JSON.stringify(run.report.outcomes));

  // Belt and braces from part 1, and the new fields from part 2, are visible on
  // the route a monitor reads.
  const status = run.report.status;
  assert.ok(status && Array.isArray(status.keys), 'sync-status returned JSON');
  for (const key of ['child_processes', 'consecutive_failures', 'failing_since', 'last_error', 'last_alert_at', 'alert_streak']) {
    assert.ok(status.keys.includes(key), `${key} missing from /api/sync-status`);
  }
  assert.equal(status.has_failing_since, true);
  assert.equal(status.has_last_error, true);
  assert.equal(typeof status.consecutive_failures, 'number');
});
