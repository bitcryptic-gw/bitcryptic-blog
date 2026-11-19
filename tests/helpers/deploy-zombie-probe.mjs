/**
 * Leak probe for the manual deploy path: `POST /api/deploy` shares the sync
 * logic (and therefore the same git spawns), but runs inside the web container's
 * node process, so it gets its own probe.
 *
 * Every request is a full cycle. Between requests this checks the *server's*
 * children — the leak would belong to it, not to us. A server that accumulated
 * zombies shows up here exactly the way the sync container did in production.
 *
 * Prints one JSON line and exits 1 if the server was left with any children.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startFixture, REAL_GIT, post } from './fixture.mjs';
import { listChildren, zombiesOf, zombiesWithParent } from './children.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const ENTRY = path.join(ROOT, 'dist/server/entry.mjs');
const CYCLES = Number(process.env.PROBE_CYCLES ?? 200);
const CLEAN = process.argv.includes('--clean');
const GIT_TIMEOUT_MS = Number(process.env.PROBE_GIT_TIMEOUT_MS ?? 750);
const PORT = 6100 + (process.pid % 300);
const BASE = `http://127.0.0.1:${PORT}`;
const SECRET = 'probe-secret-not-a-real-one';

if (!fs.existsSync(ENTRY)) {
  console.error(`deploy probe: ${ENTRY} is missing — build first`);
  process.exit(2);
}

const f = await startFixture('blog-deploy-probe-');
const shimDir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-deploy-shim-'));
const secretFile = path.join(f.root, 'deploy-secret');
let server = null;

const cleanup = () => {
  try {
    server?.kill();
  } catch { /* already gone */ }
  try {
    f.close();
  } catch { /* already gone */ }
  fs.rmSync(shimDir, { recursive: true, force: true });
};

try {
  fs.copyFileSync(path.join(HERE, 'fake-git'), path.join(shimDir, 'git'));
  fs.chmodSync(path.join(shimDir, 'git'), 0o755);
  fs.writeFileSync(secretFile, `${SECRET}\n`);

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      PATH: `${shimDir}:${process.env.PATH}`,
      REAL_GIT,
      FAKE_GIT_SLEEP_MARKER: f.sleepMarker,
      CONTENT_DIR: f.live,
      SYNC_STATUS_FILE: f.statusFile,
      SYNC_GIT_TIMEOUT_MS: String(GIT_TIMEOUT_MS),
      DEPLOY_SECRET_FILE: secretFile,
      HOST: '127.0.0.1',
      PORT: String(PORT),
      NODE_OPTIONS: '',
      NTFY_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not start');
    try {
      const res = await fetch(`${BASE}/api/sync-status`);
      await res.text();
      if (res.status === 200 || res.status === 503) break;
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }

  const outcomes = { ok: 0, error: 0 };
  let timedOut = 0;
  let fetchFailures = 0;
  let maxChildren = 0;
  const leftoverSamples = [];
  const orphansAtStart = zombiesWithParent(1)?.length ?? 0;

  let slugSeq = 0;
  for (let i = 0; i < CYCLES; i += 1) {
    fs.rmSync(f.sleepMarker, { force: true });
    f.setRemote(f.origin);

    const kind = CLEAN ? (i % 3 === 1 ? 1 : 0) : i % 8;
    if (kind === 1 || kind === 6) {
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

    const res = await fetch(`${BASE}/api/deploy`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SECRET}` },
    });
    const body = await res.text();
    if (res.status === 200 || res.status === 500) outcomes[res.status === 200 ? 'ok' : 'error'] += 1;
    else throw new Error(`unexpected deploy status ${res.status}: ${body.slice(0, 200)}`);

    const children = listChildren(server.pid);
    maxChildren = Math.max(maxChildren, children.length);
    if (children.length) leftoverSamples.push({ cycle: i, children });
  }

  const zombies = zombiesOf(server.pid);
  const children = listChildren(server.pid);
  const orphansAtEnd = zombiesWithParent(1)?.length ?? 0;
  const statusRes = await fetch(`${BASE}/api/sync-status`);
  const status = await statusRes.json().catch(() => null);
  console.log(JSON.stringify({
    probe: 'deploy',
    cycles: CYCLES,
    mode: CLEAN ? 'clean' : 'mixed',
    outcomes,
    forcedTimeouts: timedOut,
    forcedFetchFailures: fetchFailures,
    childrenAtEnd: children.length,
    zombiesAtEnd: zombies.length,
    maxChildrenSeen: maxChildren,
    leftoverSamples: leftoverSamples.slice(0, 3),
    orphanZombiesDelta: orphansAtEnd - orphansAtStart,
    status: status && {
      keys: Object.keys(status).sort(),
      consecutive_failures: status.consecutive_failures,
      child_processes: status.child_processes,
      has_failing_since: 'failing_since' in status,
      has_last_error: 'last_error' in status,
    },
  }));
  cleanup();
  process.exit(children.length === 0 ? 0 : 1);
} catch (e) {
  cleanup();
  console.log(JSON.stringify({ probe: 'deploy', error: e.message }));
  process.exit(2);
}
