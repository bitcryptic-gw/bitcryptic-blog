/**
 * The root cause of the #65 leak, pinned without needing a container.
 *
 * `git fetch` runs `git maintenance run --auto` when it finishes, and that work
 * is detached into the background (`Zs git`). In the sync container node is
 * PID 1, so the daemon is reparented to it and never reaped; it ends up as a
 * zombie charged to pids.max. Every git call the sync code makes therefore has
 * to carry `-c maintenance.auto=false -c gc.autoDetach=false`.
 *
 * A `git` shim on PATH records each argv, so this asserts what actually ran
 * rather than what the source looks like. It fails on the pre-#65 code.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncOnce } from '../scripts/sync.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();

const post = (slug) =>
  `---\ntitle: "Post ${slug}"\nslug: "${slug}"\ndate: "2026-11-19"\ndescription: "d"\nstatus: "published"\n---\n\nBody.\n`;

test('every git call the sync makes disables background maintenance', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-gitflags-'));
  const logFile = path.join(root, 'argv.log');
  const shimDir = path.join(root, 'bin');
  const remote = path.join(root, 'remote.git');
  const live = path.join(root, 'live');
  const author = path.join(root, 'author');

  const git = (cwd, ...args) =>
    execFileSync(REAL_GIT, args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

  try {
    execFileSync(REAL_GIT, ['init', '--bare', '--initial-branch=main', remote], { env: GIT_ENV });
    git(root, 'clone', remote, 'author');
    git(author, 'checkout', '-B', 'main');
    fs.writeFileSync(path.join(author, 'first-post.md'), post('first-post'));
    git(author, 'add', '-A');
    git(author, 'commit', '-m', 'first post');
    git(author, 'push', 'origin', 'main');
    git(root, 'clone', remote, 'live');

    fs.mkdirSync(shimDir);
    fs.writeFileSync(path.join(shimDir, 'git'), [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$SYNC_GIT_ARGV_LOG"',
      `exec "${REAL_GIT}" "$@"`,
      '',
    ].join('\n'));
    fs.chmodSync(path.join(shimDir, 'git'), 0o755);

    process.env.SYNC_GIT_ARGV_LOG = logFile;
    process.env.PATH = `${shimDir}:${process.env.PATH}`;
    try {
      const result = await syncOnce({ contentDir: live, statusFile: path.join(root, 'status.json') });
      assert.equal(result.action, 'no-change');
    } finally {
      delete process.env.SYNC_GIT_ARGV_LOG;
      process.env.PATH = process.env.PATH.slice(shimDir.length + 1);
    }

    const calls = fs.readFileSync(logFile, 'utf-8').trim().split('\n');
    assert.ok(calls.length >= 3, `expected several git calls, saw: ${JSON.stringify(calls)}`);

    const requirement = '-c maintenance.auto=false -c gc.autoDetach=false';
    for (const call of calls) {
      assert.ok(call.startsWith(requirement), `missing background-off flags: git ${call}`);
    }
    assert.ok(
      calls.some(call => call.includes('fetch --prune origin main')),
      `no fetch ran: ${JSON.stringify(calls)}`
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
