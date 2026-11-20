/**
 * End-to-end tests for the pages side of the site image, against a
 * markdownfirst fixture content repo: pages negotiate like posts, drafts are
 * real 404s, the home layout renders the copy from its frontmatter, and the
 * MDF documents are the site's, not the blog's.
 *
 * Runs against the built server (dist/server/entry.mjs), like http.test.mjs.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY, ensureBuilt } from './helpers/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/mdf-content');
const PORT = 4600 + (process.pid % 200);
const BASE = `http://127.0.0.1:${PORT}`;

const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
const AGENT_ACCEPT = 'text/markdown, text/html';

let server;

before(async () => {
  await ensureBuilt();

  server = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: {
      ...process.env,
      CONTENT_DIR: FIXTURES,
      HOST: '127.0.0.1',
      PORT: String(PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', () => {});
  server.stderr.on('data', () => {});

  const deadline = Date.now() + 30_000;
  for (;;) {
    if (Date.now() > deadline) throw new Error('server did not start');
    try {
      const res = await fetch(`${BASE}/`);
      if (res.ok) {
        await res.text();
        return;
      }
    } catch {
      /* not listening yet */
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
});

after(() => {
  server?.kill();
});

const get = (pathname, headers = {}) => fetch(`${BASE}${pathname}`, { headers });

test('the home page is a page, and it negotiates', async () => {
  const html = await get('/', { Accept: BROWSER_ACCEPT });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /^text\/html/);
  assert.equal(html.headers.get('vary'), 'Accept');
  assert.equal(html.headers.get('x-mdf-version'), '1');
  const body = await html.text();
  assert.match(body, /Agents read the web\./);
  assert.match(body, /<title>Fixture Home · FixtureFirst<\/title>/);

  const md = await get('/', { Accept: AGENT_ACCEPT });
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(md.headers.get('link'), '<https://fixture.example/>; rel="canonical"');
  const markdown = await md.text();
  assert.match(markdown, /^---\ntitle: "Fixture Home"/);
  assert.match(markdown, /\n# Fixture Home\n/);
  assert.match(markdown, /This is the markdown body of the fixture home page/);
});

test('a published page answers HTML and markdown at its own URL', async () => {
  const html = await get('/about/', { Accept: BROWSER_ACCEPT });
  assert.equal(html.status, 200);
  const body = await html.text();
  assert.match(body, /<h1 class="mdf-page-title">About the fixture<\/h1>/);

  const md = await get('/about/', { Accept: AGENT_ACCEPT });
  assert.equal(md.status, 200);
  const markdown = await md.text();
  assert.match(markdown, /canonical: "https:\/\/fixture.example\/about\/"/);
  assert.match(markdown, /\n# About the fixture\n/);
});

test('a draft page is a real 404 in both representations', async () => {
  const html = await get('/secret/', { Accept: BROWSER_ACCEPT });
  assert.equal(html.status, 404);
  assert.match(await html.text(), /No such page/);

  const md = await get('/secret/', { Accept: AGENT_ACCEPT });
  assert.equal(md.status, 404);
  assert.match(await md.text(), /^# No such page/);
});

test('an unknown single-segment path is a 404 that keeps its own URL', async () => {
  const html = await get('/nope', { Accept: BROWSER_ACCEPT });
  assert.equal(html.status, 404);
  const body = await html.text();
  assert.match(body, /<link rel="canonical" href="https:\/\/fixture.example\/nope">/);

  const md = await get('/nope', { Accept: AGENT_ACCEPT });
  assert.equal(md.status, 404);
  assert.match(await md.text(), /See \[the home page\]\(https:\/\/fixture.example\/\) for the fixture\./);
});

test('the home layout renders every section from the frontmatter', async () => {
  const html = await get('/', { Accept: BROWSER_ACCEPT });
  const body = await html.text();
  for (const text of [
    'Nothing changes for your visitors.',
    'Same question. Two different trips.',
    'How it works',
    'Where do you come in?',
    'Running today',
    'Fair questions',
    'example.com/recipes',
    '16,180',
    '3,150',
    'Token counts: Cloudflare',
    'Will my visitors notice anything?',
  ]) {
    assert.ok(body.includes(text), `home page missing: ${text}`);
  }
  // The adopter card names ProofLines, with Vasili's wording and its link.
  assert.match(body, /prooflines\.org/);
  assert.match(body, /ProofLines: off-node Monad network intelligence/);
  assert.match(body, /href="https:\/\/prooflines\.org\/monad\/"/);
});

test('the nav comes from site.json, including the button style', async () => {
  const body = await (await get('/', { Accept: BROWSER_ACCEPT })).text();
  assert.match(body, /<a href="\/about\/">About<\/a>/);
  assert.match(body, /<a href="https:\/\/mdf-demo\.example" class="mdf-nav-button">Try the demo<\/a>/);
  assert.ok(!body.includes('style="'), 'the button style comes from the config, not an inline style');
});

test('the nav drops entries that point at a draft or a missing page', async () => {
  const body = await (await get('/', { Accept: BROWSER_ACCEPT })).text();
  // The fixture's nav lists both: /secret/ is a draft page, /not-a-page/ exists
  // nowhere. Neither may appear in the menu — a menu is a promise.
  assert.ok(!body.includes('>Secret<'), 'a draft page is not in the menu');
  assert.ok(!body.includes('>Missing<'), 'a missing page is not in the menu');
  assert.match(body, />About</, 'a published page is still there');
  assert.match(body, />Try the demo</, 'an external entry is untouched');
});

test('the nav keeps static, reserved and in-page entries', async () => {
  const { navPathIsServed } = await import('../src/lib/pages.mjs');
  const published = [{ slug: '' }, { slug: 'about' }];
  for (const path of ['https://example.com/x', '#race', '/', '/blog/', '/api/sync-status', '/404', '/rss.xml', '/about/', '/about']) {
    assert.equal(navPathIsServed(path, published), true, path);
  }
  for (const path of ['/secret/', '/not-a-page/', '/missing']) {
    assert.equal(navPathIsServed(path, published), false, path);
  }
});

test('ETags are per representation on a page too', async () => {
  const html = await get('/about/', { Accept: BROWSER_ACCEPT });
  const htmlTag = html.headers.get('etag');
  await html.text();
  const md = await get('/about/', { Accept: AGENT_ACCEPT });
  const mdTag = md.headers.get('etag');
  await md.text();
  assert.ok(htmlTag && mdTag && htmlTag !== mdTag);

  const revalidated = await get('/about/', { Accept: BROWSER_ACCEPT, 'If-None-Match': htmlTag });
  assert.equal(revalidated.status, 304);
  assert.equal(await revalidated.text(), '');

  const wrong = await get('/about/', { Accept: BROWSER_ACCEPT, 'If-None-Match': mdTag });
  assert.equal(wrong.status, 200);
});

test('/mdf.json is the site\'s own document and is free-only', async () => {
  const res = await get('/mdf.json', { Accept: BROWSER_ACCEPT });
  const doc = await res.json();
  assert.equal(doc.mdf_version, '0.3.1');
  assert.equal(doc.site, 'https://fixture.example');
  assert.equal(doc.name, 'Fixture First');
  assert.deepEqual(doc.pricing, { default: { rails: [] } });
  assert.equal(doc.contact, 'https://fixture.example/contact');
  assert.equal(doc.llms_txt, 'https://fixture.example/llms.txt');
});

test('/llms.txt lists the pages, and not a posts section', async () => {
  const body = await (await get('/llms.txt', { Accept: BROWSER_ACCEPT })).text();
  assert.match(body, /^# Fixture First/);
  assert.match(body, /## Pages/);
  assert.match(body, /\[About the fixture\]\(https:\/\/fixture\.example\/about\/\)/);
  assert.ok(!body.includes('## Posts'), 'a pages-only site has no posts section');
  assert.ok(!body.includes('secret'), 'a draft page is not listed');
});

test('/sitemap.xml lists the home page and the published page, not the draft', async () => {
  const body = await (await get('/sitemap.xml', { Accept: BROWSER_ACCEPT })).text();
  assert.match(body, /<loc>https:\/\/fixture\.example\/<\/loc>/);
  assert.match(body, /<loc>https:\/\/fixture\.example\/about\/<\/loc>/);
  assert.ok(!body.includes('/secret/'));
});

test('/rss.xml exists, is the site\'s own, and carries no pages', async () => {
  const body = await (await get('/rss.xml', { Accept: BROWSER_ACCEPT })).text();
  assert.match(body, /<title>Fixture First<\/title>/);
  assert.ok(!body.includes('<item>'), 'pages are not feed items');
});

test('/robots.txt points at this site\'s sitemap', async () => {
  const body = await (await get('/robots.txt', { Accept: BROWSER_ACCEPT })).text();
  assert.match(body, /Sitemap: https:\/\/fixture\.example\/sitemap\.xml/);
});

test('Page and Home carry no third-party font or script requests', async () => {
  const body = await (await get('/', { Accept: BROWSER_ACCEPT })).text();
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(body));
  assert.ok(!/webstats\./.test(body), 'umami is off for this fixture');
});
