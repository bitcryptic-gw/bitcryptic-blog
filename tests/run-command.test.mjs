/**
 * Unit tests for scripts/run-command.mjs — the only place this repo spawns a
 * child. The last two tests are the ones that matter: a timed-out child must be
 * gone, and so must its process group.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand, countChildProcesses } from '../scripts/run-command.mjs';
import { listChildren, zombiesOf, waitForExit } from './helpers/children.mjs';

const node = (...args) => [process.execPath, args];

test('a successful command: exit code, stdout, not timed out', async () => {
  const r = await runCommand(...node('-e', 'process.stdout.write("hello")'));
  assert.equal(r.ok, true);
  assert.equal(r.code, 0);
  assert.equal(r.signal, null);
  assert.equal(r.stdout, 'hello');
  assert.equal(r.timedOut, false);
  assert.equal(r.error, null);
  assert.ok(r.durationMs >= 0);
});

test('stderr is captured and a non-zero exit is not an exception', async () => {
  const r = await runCommand(...node('-e', 'console.error("boom"); process.exit(3)'));
  assert.equal(r.ok, false);
  assert.equal(r.code, 3);
  assert.equal(r.stderr.trim(), 'boom');
  assert.equal(r.timedOut, false);
});

test('a missing binary comes back as an error, not a throw', async () => {
  const r = await runCommand('/nonexistent/definitely-not-a-binary', []);
  assert.equal(r.ok, false);
  assert.equal(r.code, null);
  assert.equal(r.error?.code, 'ENOENT');
});

test('captured output is capped and flagged', async () => {
  const r = await runCommand(...node('-e', 'process.stdout.write("x".repeat(5000))'), { maxOutputBytes: 1000 });
  assert.equal(r.ok, true);
  assert.equal(r.stdout.length, 1000);
  assert.equal(r.stdoutTruncated, true);
});

test('a timeout kills the child, waits for it, and leaves no zombie', async () => {
  const started = Date.now();
  const r = await runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 250 });
  const elapsed = Date.now() - started;
  assert.equal(r.ok, false);
  assert.equal(r.timedOut, true);
  assert.equal(r.killed, true);
  assert.ok(elapsed < 10_000, `took ${elapsed}ms`);
  // Always a real exit, never a dropped handle.
  assert.ok(r.code !== null || r.signal !== null, 'the child was reaped');
  assert.deepEqual(zombiesOf(process.pid), [], 'no zombie left behind');
});

test('a timeout SIGKILLs the whole process group if SIGTERM is not enough', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-command-'));
  const script = path.join(dir, 'stubborn.sh');
  const pidFile = path.join(dir, 'grandchild.pid');
  // The leader ignores SIGTERM; the grandchild would outlive it without a
  // process-group kill.
  fs.writeFileSync(script, [
    '#!/bin/sh',
    'trap "" TERM',
    'sleep 30 &',
    'echo $! > "$1"',
    'wait',
    '',
  ].join('\n'));
  fs.chmodSync(script, 0o755);

  const started = Date.now();
  const r = await runCommand(script, [pidFile], { timeoutMs: 1000, killGraceMs: 400 });
  const elapsed = Date.now() - started;

  let grandchild = 0;
  for (let i = 0; i < 100 && !grandchild; i += 1) {
    const raw = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, 'utf-8').trim() : '';
    grandchild = Number(raw) || 0;
    if (!grandchild) await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.ok(grandchild > 1, 'grandchild pid was written');
  assert.equal(r.timedOut, true);
  assert.ok(await waitForExit(grandchild, 10_000), 'grandchild died with the group');
  assert.ok(elapsed < 30_000, `took ${elapsed}ms`);
  assert.deepEqual(zombiesOf(process.pid), [], 'no zombie left behind');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('an abort kills the child and still waits for it', async () => {
  const controller = new AbortController();
  const promise = runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], {
    signal: controller.signal,
  });
  setTimeout(() => controller.abort(), 150);
  const r = await promise;
  assert.equal(r.ok, false);
  assert.equal(r.aborted, true);
  assert.deepEqual(zombiesOf(process.pid), []);
});

test('countChildProcesses reports this process’s children, or null off Linux', () => {
  const count = countChildProcesses();
  assert.ok(count === null || Number.isInteger(count), `unexpected ${count}`);
  if (count !== null) assert.equal(count, listChildren(process.pid).length);
});
