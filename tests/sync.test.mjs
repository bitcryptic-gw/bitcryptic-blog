import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncOnce, readSecret } from '../scripts/sync.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const post = (slug, extra = {}) => {
  const fields = { title: `Post ${slug}`, slug, date: '2026-11-15', description: 'd', status: 'published', ...extra };
  const body = Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n');
  return `---\n${body}\n---\n\nBody for ${slug}.\n`;
};

/**
 * A bare `remote.git` plus a `live` clone of it, which is the shape the sync
 * loop sees in production. Returns handles to commit-and-push from a separate
 * `author` clone, exactly as a merge on GitHub would.
 */
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-sync-'));
  const remote = path.join(root, 'remote.git');
  const live = path.join(root, 'live');
  const author = path.join(root, 'author');
  const statusFile = path.join(root, 'status.json');

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { env: GIT_ENV });
  git(root, 'clone', remote, 'author');
  git(author, 'checkout', '-B', 'main');
  fs.writeFileSync(path.join(author, 'first-post.md'), post('first-post'));
  git(author, 'add', '-A');
  git(author, 'commit', '-m', 'first post');
  git(author, 'push', 'origin', 'main');

  git(root, 'clone', remote, 'live');

  const publish = (files, message) => {
    for (const [name, raw] of Object.entries(files)) fs.writeFileSync(path.join(author, name), raw);
    git(author, 'add', '-A');
    git(author, 'commit', '-m', message);
    git(author, 'push', 'origin', 'main');
    return git(author, 'rev-parse', 'HEAD');
  };

  const run = () => syncOnce({ contentDir: live, statusFile, remote: 'origin', branch: 'main' });
  const status = () => JSON.parse(fs.readFileSync(statusFile, 'utf-8'));

  return { root, remote, live, author, statusFile, publish, run, status, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test('no change on the remote is a no-op', async () => {
  const f = fixture();
  try {
    const result = await f.run();
    assert.equal(result.action, 'no-change');
    assert.equal(f.status().last_result, 'no-change');
    assert.equal(f.status().live_sha, git(f.live, 'rev-parse', 'HEAD'));
  } finally { f.cleanup(); }
});

test('a valid merge publishes: live moves to the new sha', async () => {
  const f = fixture();
  try {
    const sha = f.publish({ 'second-post.md': post('second-post') }, 'second post');
    const result = await f.run();
    assert.equal(result.action, 'updated');
    assert.equal(result.to, sha);
    assert.equal(git(f.live, 'rev-parse', 'HEAD'), sha);
    assert.ok(fs.existsSync(path.join(f.live, 'second-post.md')), 'live clone has the new post');
    const status = f.status();
    assert.equal(status.live_sha, sha);
    assert.equal(status.last_result, 'updated');
    assert.ok(status.last_checked);
  } finally { f.cleanup(); }
});

test('an invalid merge is held back: live does not move and the reason is recorded', async () => {
  const f = fixture();
  try {
    const before = git(f.live, 'rev-parse', 'HEAD');
    f.publish({ 'half-written.md': '---\ntitle: "Half"\nbad: *nope\n---\n' }, 'bad post');
    const result = await f.run();
    assert.equal(result.action, 'rejected');
    assert.equal(git(f.live, 'rev-parse', 'HEAD'), before, 'live clone untouched');
    assert.ok(!fs.existsSync(path.join(f.live, 'half-written.md')), 'bad post never reaches live');
    const status = f.status();
    assert.equal(status.last_result, 'rejected');
    assert.equal(status.live_sha, before);
    assert.ok(status.errors.some(e => /does not parse/.test(e.message)));
  } finally { f.cleanup(); }
});

test('after a rejected merge, a later good merge still publishes', async () => {
  const f = fixture();
  try {
    f.publish({ 'half-written.md': '---\ntitle: "Half"\nbad: *nope\n---\n' }, 'bad post');
    assert.equal((await f.run()).action, 'rejected');

    fs.rmSync(path.join(f.root, 'author', 'half-written.md'));
    const sha = f.publish({ 'third-post.md': post('third-post') }, 'remove bad post, add third');
    const result = await f.run();
    assert.equal(result.action, 'updated');
    assert.equal(git(f.live, 'rev-parse', 'HEAD'), sha);
    assert.ok(!fs.existsSync(path.join(f.live, 'half-written.md')));
  } finally { f.cleanup(); }
});

test('a fetch failure is an error and leaves live untouched', async () => {
  const f = fixture();
  try {
    const before = git(f.live, 'rev-parse', 'HEAD');
    git(f.live, 'remote', 'set-url', 'origin', path.join(f.root, 'does-not-exist.git'));
    const result = await f.run();
    assert.equal(result.action, 'error');
    assert.match(result.message, /fetch failed/);
    assert.equal(git(f.live, 'rev-parse', 'HEAD'), before);
    assert.equal(f.status().last_result, 'error');
  } finally { f.cleanup(); }
});

test('a dirty live clone is never reset', async () => {
  const f = fixture();
  try {
    f.publish({ 'second-post.md': post('second-post') }, 'second post');
    fs.writeFileSync(path.join(f.live, 'first-post.md'), `${post('first-post')}\nhand edit\n`);
    const result = await f.run();
    assert.equal(result.action, 'error');
    assert.match(result.message, /uncommitted changes/);
    assert.ok(fs.readFileSync(path.join(f.live, 'first-post.md'), 'utf-8').includes('hand edit'), 'hand edit preserved');
    assert.ok(!fs.existsSync(path.join(f.live, 'second-post.md')));
    assert.equal(f.status().last_result, 'error');
  } finally { f.cleanup(); }
});

test('a rewind (force-push) is applied and reported as non-fast-forward', async () => {
  const f = fixture();
  try {
    f.publish({ 'second-post.md': post('second-post') }, 'second post');
    await f.run();
    const afterPublish = git(f.live, 'rev-parse', 'HEAD');

    // Rewrite main back to the first commit and force-push.
    const first = git(f.author, 'rev-parse', 'HEAD~1');
    git(f.author, 'reset', '--hard', first);
    git(f.author, 'push', '--force', 'origin', 'main');

    const result = await f.run();
    assert.equal(result.action, 'updated');
    assert.notEqual(git(f.live, 'rev-parse', 'HEAD'), afterPublish);
    assert.equal(git(f.live, 'rev-parse', 'HEAD'), first);
  } finally { f.cleanup(); }
});

test('readSecret refuses a missing secret file', () => {
  assert.throws(() => readSecret('/nonexistent/secret', 'test'), /missing or unreadable/);
});

test('readSecret refuses an empty secret file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-secret-'));
  const file = path.join(dir, 'empty');
  fs.writeFileSync(file, '\n  \n');
  try {
    assert.throws(() => readSecret(file, 'test'), /empty/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readSecret returns the trimmed value', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-secret-'));
  const file = path.join(dir, 'value');
  fs.writeFileSync(file, '  abc123\n');
  try {
    assert.equal(readSecret(file, 'test'), 'abc123');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('readSecret with no file configured is empty, not an error', () => {
  assert.equal(readSecret('', 'test'), '');
});
