/**
 * The blog's byte-identity gate.
 *
 * The site image is shared by more than one site, and the blog must not notice:
 * every page it serves has to stay byte for byte what it was, in HTML and in
 * markdown, with only stylesheet chunk names normalised.
 *
 * Two ways to run it:
 *
 *   1. Always, against the fixture content — a golden snapshot in
 *      tests/fixtures/expected/byte-identity.json. This catches a change to the
 *      blog theme's markup in the ordinary test run.
 *      Regenerate deliberately with: UPDATE_GOLDEN=1 npm test
 *
 *   2. Against a real content clone and a capture taken from the previous
 *      image, by pointing BYTE_BASELINE_DIR at that capture:
 *
 *        node capture.mjs http://127.0.0.1:4399 before     # old image
 *        BYTE_BASELINE_DIR=$PWD/before node --test tests/byte-identity.test.mjs
 *
 *      That is the check the release used; see the release record.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import crypto from 'node:crypto';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ENTRY, ensureBuilt } from './helpers/build.mjs';
import { capture, normalise } from './helpers/snapshot.mjs';
import { DEFAULT_CONFIG } from '../src/lib/site-config.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/content');
const GOLDEN = path.join(ROOT, 'tests/fixtures/expected/byte-identity.json');
const PORT = 4900 + (process.pid % 90);
const BASE = `http://127.0.0.1:${PORT}`;
const SLUGS = ['published-post', 'superseded-post'];

let server;

async function start(dir, port) {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { ...process.env, CONTENT_DIR: dir, HOST: '127.0.0.1', PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', () => {});

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error(`server on ${port} did not start`);
    try {
      if ((await fetch(`http://127.0.0.1:${port}/`)).ok) return child;
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

before(async () => {
  await ensureBuilt();
  server = await start(FIXTURES, PORT);
});

after(() => {
  server?.kill();
});

test('the blog contract is unchanged: golden snapshot', async () => {
  const current = await capture(BASE, SLUGS);

  if (process.env.UPDATE_GOLDEN) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, `${JSON.stringify(current, null, 2)}\n`);
    return;
  }

  const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf-8'));
  const differences = [];
  for (const key of Object.keys(golden)) {
    if (!current[key]) {
      differences.push(`${key}: missing`);
      continue;
    }
    if (current[key].status !== golden[key].status) {
      differences.push(`${key}: status ${golden[key].status} -> ${current[key].status}`);
    }
    for (const header of Object.keys(golden[key].headers)) {
      if (current[key].headers[header] !== golden[key].headers[header]) {
        differences.push(`${key}: ${header} ${golden[key].headers[header]} -> ${current[key].headers[header]}`);
      }
    }
    if (current[key].sha256 !== golden[key].sha256) {
      differences.push(`${key}: body differs (${golden[key].bytes} -> ${current[key].bytes} bytes)`);
    }
  }
  for (const key of Object.keys(current)) {
    if (!golden[key]) differences.push(`${key}: new entry (update the golden deliberately)`);
  }

  assert.deepEqual(differences, [], differences.join('\n'));
});

test('the blog config written out as site.json changes nothing', async () => {
  // The defaults are the blog. Writing them down must be a no-op, which is what
  // lets the blog's content repo adopt a site.json whenever it likes — and is
  // why it does not need one for this release.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-with-config-'));
  for (const name of fs.readdirSync(FIXTURES)) {
    fs.copyFileSync(path.join(FIXTURES, name), path.join(dir, name));
  }
  fs.writeFileSync(path.join(dir, 'site.json'), `${JSON.stringify(DEFAULT_CONFIG, null, 2)}\n`);

  const port = PORT + 1;
  const child = await start(dir, port);
  try {
    const withConfig = await capture(`http://127.0.0.1:${port}`, SLUGS);
    const withoutConfig = await capture(BASE, SLUGS);
    assert.deepEqual(withConfig, withoutConfig);
  } finally {
    child.kill();
  }
});

test('against a real capture from the previous image, when one is provided', async t => {
  const baselineDir = process.env.BYTE_BASELINE_DIR;
  if (!baselineDir) {
    t.skip('set BYTE_BASELINE_DIR to a capture.mjs directory to compare against an image');
    return;
  }
  const baseline = JSON.parse(fs.readFileSync(path.join(baselineDir, 'manifest.json'), 'utf-8'));
  const current = await capture(BASE, SLUGS);
  const differences = [];
  for (const [key, before] of Object.entries(baseline.entries)) {
    const after = current[key];
    if (!after) continue; // the real capture covers more paths than the fixtures do
    if (after.status !== before.status) differences.push(`${key}: status ${before.status} -> ${after.status}`);
    for (const header of Object.keys(before.headers)) {
      const beforeValue = normalise(before.headers[header]);
      const afterValue = normalise(after.headers[header]);
      if (beforeValue !== afterValue && header !== 'etag' && header !== 'content-length') {
        differences.push(`${key}: ${header} ${beforeValue} -> ${afterValue}`);
      }
    }
    // Compare the bodies, with stylesheet chunk names normalised on both sides.
    if (before.body) {
      const raw = fs.readFileSync(path.join(baselineDir, before.body), 'utf-8');
      const digest = crypto.createHash('sha256').update(normalise(raw)).digest('hex');
      if (digest !== after.sha256) {
        differences.push(`${key}: body differs (${before.bytes} -> ${after.bytes} bytes)`);
      }
    }
  }
  assert.deepEqual(differences, [], differences.join('\n'));
});
