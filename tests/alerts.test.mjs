/**
 * Alerting rules for operational failures (Web Hosting #65, part 2):
 *
 *   - nothing until 3 consecutive failures;
 *   - then at most one reminder an hour while it keeps failing;
 *   - one recovery notice when the fetch works again;
 *   - the whole state lives in the status file, so a restart neither re-alerts
 *     nor forgets the streak;
 *   - a validation rejection keeps its own rule (one alert per bad SHA).
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { syncOnce, readStatus, redactUserinfo, truncate } from '../scripts/sync.mjs';

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, encoding: 'utf-8', env: GIT_ENV, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

const post = (slug, extra = {}) => {
  const fields = { title: `Post ${slug}`, slug, date: '2026-11-19', description: 'd', status: 'published', ...extra };
  const body = Object.entries(fields).map(([k, v]) => `${k}: "${v}"`).join('\n');
  return `---\n${body}\n---\n\nBody for ${slug}.\n`;
};

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-alerts-'));
  const remote = path.join(root, 'remote.git');
  const live = path.join(root, 'live');
  const author = path.join(root, 'author');
  const statusFile = path.join(root, 'status.json');
  const alerts = [];

  execFileSync('git', ['init', '--bare', '--initial-branch=main', remote], { env: GIT_ENV });
  git(root, 'clone', remote, 'author');
  git(author, 'checkout', '-B', 'main');
  fs.writeFileSync(path.join(author, 'first-post.md'), post('first-post'));
  git(author, 'add', '-A');
  git(author, 'commit', '-m', 'first post');
  git(author, 'push', 'origin', 'main');
  git(root, 'clone', remote, 'live');

  const publish = (files, message) => {
    for (const [name, raw] of Object.entries(files)) {
      if (raw === null) fs.rmSync(path.join(author, name), { force: true });
      else fs.writeFileSync(path.join(author, name), raw);
    }
    git(author, 'add', '-A');
    git(author, 'commit', '-m', message);
    git(author, 'push', 'origin', 'main');
    return git(author, 'rev-parse', 'HEAD');
  };

  const notify = async (title, body, options) => {
    alerts.push({ title, body, options });
    return true;
  };

  const run = (overrides = {}) =>
    syncOnce({ contentDir: live, statusFile, gitTimeoutMs: 20_000, notify, ...overrides });

  const status = (file = statusFile) => JSON.parse(fs.readFileSync(file, 'utf-8'));

  return { root, remote, live, author, statusFile, alerts, publish, run, status, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const breakRemote = (f) => git(f.live, 'remote', 'set-url', 'origin', path.join(f.root, 'does-not-exist.git'));
const fixRemote = (f) => git(f.live, 'remote', 'set-url', 'origin', f.remote);

test('two consecutive failures are a blip: no alert, but the streak is recorded', async () => {
  const f = fixture();
  try {
    breakRemote(f);
    assert.equal((await f.run()).action, 'error');
    assert.equal((await f.run()).action, 'error');

    assert.equal(f.alerts.length, 0);
    const status = f.status();
    assert.equal(status.consecutive_failures, 2);
    assert.ok(status.failing_since, 'failing_since is set on the first failure');
    assert.equal(status.alert_streak, false);
    assert.equal(status.last_alert_at, null);
    assert.match(status.last_error, /(fatal|error):/i);
    assert.ok('child_processes' in status);
  } finally { f.cleanup(); }
});

test('the third consecutive failure alerts once, carrying git’s stderr — and not again within the hour', async () => {
  const f = fixture();
  try {
    breakRemote(f);
    await f.run();
    await f.run();
    assert.equal(f.alerts.length, 0);

    const result = await f.run();
    assert.equal(result.action, 'error');
    assert.equal(f.alerts.length, 1);
    const [first] = f.alerts;
    assert.match(first.title, /failing \(3 in a row\)/);
    assert.match(first.body, /3 consecutive failure\(s\) since/);
    assert.match(first.body, /git output:/);
    assert.match(first.body, /does-not-exist\.git/);
    assert.match(first.body, /(fatal|error):/i);

    const status = f.status();
    assert.equal(status.alert_streak, true);
    assert.ok(Date.parse(status.last_alert_at) > 0);

    // Fourth failure, moments later: no second alert.
    await f.run();
    assert.equal(f.alerts.length, 1);
    assert.equal(f.status().consecutive_failures, 4);
  } finally { f.cleanup(); }
});

test('one reminder an hour while it keeps failing, and no more often than that', async () => {
  const f = fixture();
  try {
    breakRemote(f);
    for (let i = 0; i < 3; i += 1) await f.run();
    assert.equal(f.alerts.length, 1);

    // Pretend the alert was sent two hours ago.
    const aged = f.status();
    aged.last_alert_at = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    fs.writeFileSync(f.statusFile, `${JSON.stringify(aged)}\n`);

    await f.run();
    assert.equal(f.alerts.length, 2, 'a reminder fired after the hour');
    assert.match(f.alerts[1].title, /still failing \(4 in a row\)/);

    // 59 minutes later: still inside the hour, so nothing.
    const recent = f.status();
    recent.last_alert_at = new Date(Date.now() - 59 * 60 * 1000).toISOString();
    fs.writeFileSync(f.statusFile, `${JSON.stringify(recent)}\n`);
    await f.run();
    assert.equal(f.alerts.length, 2, 'no reminder inside the hour');
  } finally { f.cleanup(); }
});

test('a recovery notice once, when the fetch works again after an alerted streak', async () => {
  const f = fixture();
  try {
    breakRemote(f);
    for (let i = 0; i < 3; i += 1) await f.run();
    assert.equal(f.alerts.length, 1);

    fixRemote(f);
    const result = await f.run();
    assert.equal(result.action, 'no-change');
    assert.equal(f.alerts.length, 2);
    assert.match(f.alerts[1].title, /recovered/);
    assert.match(f.alerts[1].body, /after 3 consecutive failure\(s\)/);

    const status = f.status();
    assert.equal(status.consecutive_failures, 0);
    assert.equal(status.failing_since, null);
    assert.equal(status.last_error, null);
    assert.equal(status.alert_streak, false);
    assert.equal(status.last_alert_at, null);

    // Nothing more while it stays healthy.
    await f.run();
    assert.equal(f.alerts.length, 2);
  } finally { f.cleanup(); }
});

test('the streak survives a restart: a fresh read of the status file does not re-alert', async () => {
  const f = fixture();
  try {
    breakRemote(f);
    for (let i = 0; i < 3; i += 1) await f.run();
    assert.equal(f.alerts.length, 1);

    // What a restarted container sees: nothing in memory, only the file.
    const restartedFile = path.join(f.root, 'status-after-restart.json');
    fs.copyFileSync(f.statusFile, restartedFile);
    const before = JSON.parse(fs.readFileSync(restartedFile, 'utf-8'));
    assert.equal(before.consecutive_failures, 3);
    assert.equal(before.alert_streak, true);

    await f.run({ statusFile: restartedFile });
    assert.equal(f.alerts.length, 1, 'no duplicate alert after a restart');
    assert.equal(readStatus(restartedFile).consecutive_failures, 4);
  } finally { f.cleanup(); }
});

test('a validation rejection keeps one alert per SHA and ends the operational streak', async () => {
  const f = fixture();
  try {
    breakRemote(f);
    for (let i = 0; i < 3; i += 1) await f.run();
    assert.equal(f.alerts.length, 1);

    fixRemote(f);
    const badSha = f.publish({ 'half-written.md': '---\ntitle: "Half"\nbad: *nope\n---\n' }, 'bad post');
    const result = await f.run();
    assert.equal(result.action, 'rejected');

    // Recovery first (the fetch worked), then the rejection.
    assert.equal(f.alerts.length, 3);
    assert.match(f.alerts[1].title, /recovered/);
    assert.match(f.alerts[2].title, /publish blocked/);
    assert.match(f.alerts[2].body, /half-written\.md/);

    const status = f.status();
    assert.equal(status.consecutive_failures, 0);
    assert.equal(status.alert_streak, false);
    assert.equal(status.last_alerted_sha, badSha);

    // Same bad SHA again: the rejection is not re-announced.
    await f.run();
    assert.equal(f.alerts.length, 3);
  } finally { f.cleanup(); }
});

test('userinfo is stripped from anything URL-like', () => {
  assert.equal(redactUserinfo('https://user:pass@example.com/repo.git'), 'https://example.com/repo.git');
  assert.equal(redactUserinfo('fatal: unable to access \'https://token@github.com/x.git/'), 'fatal: unable to access \'https://github.com/x.git/');
  assert.equal(redactUserinfo('ssh://git@host/x'), 'ssh://host/x');
  assert.equal(redactUserinfo('nothing to redact here'), 'nothing to redact here');
  // A bare `git@host:path` scp-style remote has no scheme and no password, so it stays.
  assert.equal(redactUserinfo('git@github.com:org/repo.git'), 'git@github.com:org/repo.git');
});

test('a failure whose stderr carries a credential URL is reported without it', async () => {
  const f = fixture();
  try {
    git(f.live, 'remote', 'set-url', 'origin', 'https://user:sekret@127.0.0.1:1/repo.git');
    const result = await f.run();
    assert.equal(result.action, 'error');
    const status = f.status();
    assert.ok(!`${result.message}${status.last_error}`.includes('sekret'), 'no credential in the report');
    assert.ok(status.last_error.length <= 501);
  } finally { f.cleanup(); }
});

test('last_error is truncated to 500 characters', () => {
  const long = 'x'.repeat(5000);
  const cut = truncate(long);
  assert.equal(cut.length, 501);
  assert.ok(cut.endsWith('…'));
  assert.equal(truncate('short'), 'short');
});
