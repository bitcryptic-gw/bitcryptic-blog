/**
 * Leak probe: many real sync cycles, then "are any children still here?".
 *
 * It runs as its own process on purpose. A leak shows up as children of *this*
 * pid, and the thing being measured (a zombie) cannot be cleaned up afterwards,
 * so the probe's lifetime is the measurement window.
 *
 * Mix per cycle: no-change, a valid publish, a rejecting publish, a fetch that
 * fails (remote answers 404) and a fetch killed by the timeout
 * (`tests/helpers/fake-git` hangs while the marker file exists).
 *
 * Prints one JSON line on stdout and exits 1 if anything was left behind.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncOnce } from '../../scripts/sync.mjs';
import { startFixture, REAL_GIT, post } from './fixture.mjs';
import { listChildren, zombiesWithParent } from './children.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CYCLES = Number(process.env.PROBE_CYCLES ?? 200);
// `--clean` runs only cycles that can succeed. Nothing should be left anywhere
// after that, not even at PID 1, which is the steady-state production shape.
const CLEAN = process.argv.includes('--clean');
// Long enough that a normal git call never times out on a slow (emulated)
// machine, short enough that the forced ones do not stall the suite.
const GIT_TIMEOUT_MS = Number(process.env.PROBE_GIT_TIMEOUT_MS ?? 750);

const f = await startFixture('blog-leak-probe-');
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-fake-git-'));

try {
  // From here on `git` resolves to the shim, which delegates to the real one.
  fs.copyFileSync(path.join(HERE, 'fake-git'), path.join(shimDir, 'git'));
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);
  process.env.PATH = `${shimDir}:${process.env.PATH}`;
  process.env.REAL_GIT = REAL_GIT;
  process.env.FAKE_GIT_SLEEP_MARKER = f.sleepMarker;

  const outcomes = { 'no-change': 0, updated: 0, rejected: 0, error: 0 };
  let timedOut = 0;
  let fetchFailures = 0;
  let maxChildren = 0;
  const leftoverSamples = [];

  // Also watch PID 1: a process that daemonises (git's post-fetch maintenance
  // does) is reparented to the container's init, so it becomes a zombie there
  // instead of here. This is what catches the leak when the probe is not PID 1.
  const orphansAtStart = zombiesWithParent(1)?.length ?? 0;

  let slugSeq = 0;
  for (let i = 0; i < CYCLES; i += 1) {
    fs.rmSync(f.sleepMarker, { force: true });
    f.setRemote(f.origin);

    const kind = CLEAN ? (i % 3 === 1 ? 1 : 0) : i % 8;
    if (kind === 1 || kind === 6) {
      // A valid publish also clears any invalid post from an earlier cycle.
      slugSeq += 1;
      f.publish({ 'half-written.md': null, [`post-${slugSeq}.md`]: post(`post-${slugSeq}`) }, `publish ${slugSeq}`);
    } else if (kind === 3) {
      f.publish({ 'half-written.md': '---\ntitle: "Half"\nbad: *nope\n---\n' }, 'bad post');
    } else if (kind === 4) {
      f.setRemote(f.missingOrigin);
      fetchFailures += 1;
    } else if (kind === 5) {
      fs.writeFileSync(f.sleepMarker, 'x');
      timedOut += 1;
    }

    const result = await syncOnce({ contentDir: f.live, statusFile: f.statusFile, gitTimeoutMs: GIT_TIMEOUT_MS });
    outcomes[result.action] += 1;

    const children = listChildren(process.pid).filter(child => child.pid !== f.serverPid);
    maxChildren = Math.max(maxChildren, children.length);
    if (children.length) leftoverSamples.push({ cycle: i, kind: result.action, children });
  }

  const ownChildren = () => listChildren(process.pid).filter(child => child.pid !== f.serverPid);
  const zombies = ownChildren().filter(child => child.state.startsWith('Z'));
  const children = ownChildren();
  const orphansAtEnd = zombiesWithParent(1)?.length ?? 0;
  const zombiesByComm = children.reduce((acc, child) => {
    acc[child.comm] = (acc[child.comm] ?? 0) + 1;
    return acc;
  }, {});
  const report = {
    probe: 'sync',
    cycles: CYCLES,
    mode: CLEAN ? 'clean' : 'mixed',
    outcomes,
    forcedTimeouts: timedOut,
    forcedFetchFailures: fetchFailures,
    childrenAtEnd: children.length,
    zombiesAtEnd: zombies.length,
    zombiesByComm,
    maxChildrenSeen: maxChildren,
    leftoverSamples: leftoverSamples.slice(0, 3),
    orphanZombiesDelta: orphansAtEnd - orphansAtStart,
  };
  console.log(JSON.stringify(report));
  f.close();
  fs.rmSync(shimDir, { recursive: true, force: true });
  // Only this process's own children are fatal: an orphan left by git lands on
  // the container's PID 1, so whether it is still visible depends on whether an
  // init is reaping. `orphanZombiesDelta` is reported for that shape.
  process.exit(children.length === 0 ? 0 : 1);
} catch (e) {
  f.close();
  fs.rmSync(shimDir, { recursive: true, force: true });
  console.log(JSON.stringify({ probe: 'sync', error: e.message, stack: (e.stack ?? '').split('\n').slice(0, 4) }));
  process.exit(2);
}
