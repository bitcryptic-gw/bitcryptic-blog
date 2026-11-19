/**
 * The HTTP tests and the deploy leak probe both need `dist/server/entry.mjs`.
 * Build it when it is missing or older than the sources, once — the two test
 * files run in separate processes and would otherwise build over each other.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const ENTRY = path.join(ROOT, 'dist/server/entry.mjs');

const WATCHED = ['src', 'scripts', 'public', 'astro.config.mjs', 'package.json', 'tailwind.config.mjs'];
// The content clone is a mount at runtime (and is not in the build context), so
// its file times say nothing about whether dist matches the code.
const SKIP = new Set([path.join(ROOT, 'src', 'content')]);

function newestMtime(target, newest = 0) {
  let stat;
  try {
    stat = fs.statSync(target);
  } catch {
    return newest;
  }
  if (stat.isDirectory()) {
    if (SKIP.has(target)) return newest;
    for (const entry of fs.readdirSync(target)) newest = newestMtime(path.join(target, entry), newest);
    return newest;
  }
  return Math.max(newest, stat.mtimeMs);
}

export function isFresh() {
  if (!fs.existsSync(ENTRY)) return false;
  let newest = 0;
  for (const rel of WATCHED) newest = newestMtime(path.join(ROOT, rel), newest);
  return fs.statSync(ENTRY).mtimeMs >= newest;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function ensureBuilt({ timeoutMs = 120_000 } = {}) {
  if (isFresh()) return;
  const lockDir = path.join(ROOT, '.astro', 'build-lock');
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      fs.mkdirSync(lockDir);
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      await sleep(100);
    }
  }
  try {
    // Another process may have finished the build while we waited.
    if (isFresh()) return;
    execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });
  } finally {
    fs.rmSync(lockDir, { recursive: true, force: true });
  }
}
