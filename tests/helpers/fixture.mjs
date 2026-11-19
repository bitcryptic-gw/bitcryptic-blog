/**
 * The shape both leak probes measure: an "author" repo whose commits stand in
 * for merges on GitHub, and a live clone that fetches them over HTTP, which is
 * the transport production uses.
 *
 * HTTP rather than a local path on purpose: git's local-path transport
 * occasionally leaves its `git-upload-pack` child orphaned, which is an artifact
 * of the test setup, not of the code under test (an HTTP fetch of the same
 * commits leaks nothing).
 *
 * The server is a separate process (`fixture-http.mjs`) so the probe works with
 * a synchronous fetch too — that is what lets the same probe run against the
 * pre-#65 code and fail.
 *
 * Every fixture git call also disables background maintenance, or the probe
 * would be measuring its own setup rather than the sync code.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

export const NO_BACKGROUND = ['-c', 'maintenance.auto=false', '-c', 'gc.autoDetach=false'];

export const REAL_GIT = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf-8' }).trim();

export const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Probe',
  GIT_AUTHOR_EMAIL: 'probe@example.com',
  GIT_COMMITTER_NAME: 'Probe',
  GIT_COMMITTER_EMAIL: 'probe@example.com',
  GIT_TERMINAL_PROMPT: '0',
};

export function git(cwd, ...args) {
  return execFileSync(REAL_GIT, [...NO_BACKGROUND, ...args], {
    cwd,
    encoding: 'utf-8',
    env: gitEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

/**
 * git, but asynchronous. Anything that talks to the fixture's HTTP server has to
 * be — a synchronous clone would block the event loop that serves it.
 */
export function runGit(cwd, ...args) {
  return new Promise((resolve, reject) => {
    const child = spawn(REAL_GIT, [...NO_BACKGROUND, ...args], {
      cwd,
      env: gitEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.stdout.on('data', () => {});
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git ${args.join(' ')} exited ${code}: ${stderr.trim()}`));
    });
  });
}

export const post = (slug) =>
  `---\ntitle: "Post ${slug}"\nslug: "${slug}"\ndate: "2026-11-19"\ndescription: "d"\nstatus: "published"\n---\n\nBody for ${slug}.\n`;

export async function startFixture(prefix = 'blog-probe-') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const author = path.join(root, 'author');
  const live = path.join(root, 'live');
  const statusFile = path.join(root, 'status.json');
  const sleepMarker = path.join(root, 'sleep-marker');
  const portFile = path.join(root, 'http.port');

  execFileSync(REAL_GIT, [...NO_BACKGROUND, 'init', '--initial-branch=main', author], { env: gitEnv });
  fs.writeFileSync(path.join(author, 'first-post.md'), post('first-post'));
  git(author, 'add', '-A');
  git(author, 'commit', '-m', 'first post');
  git(author, 'update-server-info');

  // Dumb HTTP, served straight off disk: git writes .git/info/refs with
  // update-server-info after each commit, and the client fetches loose objects.
  const server = spawn(process.execPath, [path.join(HERE, 'fixture-http.mjs'), root, portFile], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const deadline = Date.now() + 20_000;
  while (!fs.existsSync(portFile)) {
    if (Date.now() > deadline) throw new Error('fixture HTTP server did not start');
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const port = Number(fs.readFileSync(portFile, 'utf-8').trim());

  const origin = `http://127.0.0.1:${port}/author/.git`;
  await runGit(root, 'clone', origin, 'live');

  return {
    root,
    author,
    live,
    statusFile,
    sleepMarker,
    origin,
    /** This process's child; probes should not count it as a leak. */
    serverPid: server.pid,
    /** A remote that answers 404, for a real fetch failure over the same transport. */
    missingOrigin: `http://127.0.0.1:${port}/does-not-exist/.git`,
    setRemote: (url) => git(live, 'remote', 'set-url', 'origin', url),
    /** A commit in the author repo is the shape of a merge on GitHub. */
    publish(files = {}, message = 'commit') {
      for (const [name, raw] of Object.entries(files)) {
        if (raw === null) fs.rmSync(path.join(author, name), { force: true });
        else fs.writeFileSync(path.join(author, name), raw);
      }
      git(author, 'add', '-A');
      git(author, 'commit', '-m', message);
      git(author, 'update-server-info');
    },
    close() {
      try {
        server.kill();
      } catch { /* already gone */ }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
