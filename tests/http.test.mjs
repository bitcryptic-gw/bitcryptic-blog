/**
 * End-to-end tests for content negotiation, real 404s and the MDF documents.
 *
 * These run against the built server (dist/server/entry.mjs) with the fixture
 * content directory, i.e. the same code path the container runs. If the build
 * is missing it is built first.
 */
import assert from 'node:assert/strict';
import test, { after, before } from 'node:test';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENTRY, ensureBuilt } from './helpers/build.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FIXTURES = path.join(ROOT, 'tests/fixtures/content');
const PORT = 4500 + (process.pid % 400);
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

test('negotiation over HTTP: browser Accept gets HTML, agent Accept gets markdown', async () => {
  const html = await get('/blog/published-post/', { Accept: BROWSER_ACCEPT });
  assert.equal(html.status, 200);
  assert.match(html.headers.get('content-type'), /^text\/html/);
  const htmlBody = await html.text();
  assert.match(htmlBody, /<!DOCTYPE html>/);

  const md = await get('/blog/published-post/', { Accept: AGENT_ACCEPT });
  assert.equal(md.status, 200);
  assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const mdBody = await md.text();
  assert.match(mdBody, /^---\n/);
  assert.match(mdBody, /\n# Published Fixture Post\n/);
});

test('negotiation over HTTP: markdown only, wildcards and a missing header', async () => {
  assert.equal((await get('/blog/published-post/', { Accept: 'text/markdown' })).status, 200);
  assert.match(
    (await get('/blog/published-post/', { Accept: '*/*' })).headers.get('content-type'),
    /^text\/html/
  );
  assert.match(
    (await get('/blog/published-post/', { Accept: 'text/*' })).headers.get('content-type'),
    /^text\/html/
  );
  assert.match(
    (await get('/blog/published-post/')).headers.get('content-type'),
    /^text\/html/
  );
});

test('index markdown: heading, description and one line per published post', async () => {
  const res = await get('/', { Accept: AGENT_ACCEPT });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  const body = await res.text();
  const lines = body.trimEnd().split('\n');

  assert.equal(lines[0], '# BitCryptic Blog');
  assert.match(lines[2], /Crypto-native AI infrastructure/);
  assert.ok(body.includes('[Published Fixture Post](https://blog.bitcryptic.com/blog/published-post/) — 2026-03-02'));
  assert.ok(body.includes('[Superseded Fixture Post](https://blog.bitcryptic.com/blog/superseded-post/) — 2026-01-05'));
  assert.ok(body.includes('(superseded)'));
  assert.ok(!body.includes('Draft Fixture Post'), 'drafts never reach the index');

  // Newest first.
  assert.ok(body.indexOf('Published Fixture Post') < body.indexOf('Superseded Fixture Post'));
});

test('markdown body: frontmatter, H1, superseded blockquote, corrections, absolute links', async () => {
  const live = await (await get('/blog/published-post/', { Accept: AGENT_ACCEPT })).text();
  assert.match(live, /^---\ntitle: "Published Fixture Post"\ndate: 2026-03-02\nauthor: "Test Author"/);
  assert.match(live, /canonical: "https:\/\/blog\.bitcryptic\.com\/blog\/published-post\/"/);
  assert.match(live, /\n# Published Fixture Post\n/);
  // The correction is kept verbatim …
  assert.ok(live.includes('~~wrong~~ right correction'));
  // … the relative link is made absolute …
  assert.ok(live.includes('[relative link](https://blog.bitcryptic.com/blog/superseded-post/)'));
  // … and a code fence is left alone.
  assert.ok(live.includes('[not a link](/blog/never-rewritten/)'));
  assert.ok(!live.includes('> **Kept for the record.**'));

  const superseded = await (await get('/blog/superseded-post/', { Accept: AGENT_ACCEPT })).text();
  assert.ok(superseded.includes('superseded_by: "https://blog.bitcryptic.com/blog/published-post/"'));
  assert.ok(superseded.includes('updated: 2026-02-01'));
  const banner = superseded.split('\n').find(line => line.startsWith('>'));
  assert.equal(
    banner,
    '> **Kept for the record.** This post is from January 2026 and has been superseded. ' +
      'The numbers changed. See [the current state of MDF](https://blog.bitcryptic.com/blog/published-post/).'
  );
  assert.ok(superseded.indexOf('> **Kept for the record.**') < superseded.indexOf('Body of the superseded post'));
});

test('markdown headers: Content-Type, Vary, canonical Link, X-MDF-Version', async () => {
  const res = await get('/blog/published-post/', { Accept: AGENT_ACCEPT });
  assert.equal(res.headers.get('content-type'), 'text/markdown; charset=utf-8');
  assert.equal(res.headers.get('vary'), 'Accept');
  assert.equal(res.headers.get('x-mdf-version'), '1');
  assert.equal(
    res.headers.get('link'),
    '<https://blog.bitcryptic.com/blog/published-post/>; rel="canonical"'
  );
  assert.ok(res.headers.get('etag'));
  await res.text();
});

test('HTML headers on the same routes: Vary and X-MDF-Version', async () => {
  for (const pathname of ['/', '/blog/published-post/']) {
    const res = await get(pathname, { Accept: BROWSER_ACCEPT });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('vary'), 'Accept', pathname);
    assert.equal(res.headers.get('x-mdf-version'), '1', pathname);
    assert.ok(res.headers.get('etag'), pathname);
    await res.text();
  }
});

test('ETags are per representation, and If-None-Match only matches its own', async () => {
  const url = '/blog/published-post/';
  const md = await get(url, { Accept: AGENT_ACCEPT });
  const mdTag = md.headers.get('etag');
  await md.text();
  const html = await get(url, { Accept: BROWSER_ACCEPT });
  const htmlTag = html.headers.get('etag');
  await html.text();

  assert.ok(mdTag && htmlTag);
  assert.notEqual(mdTag, htmlTag);

  // Same representation: 304.
  const mdAgain = await get(url, { Accept: AGENT_ACCEPT, 'If-None-Match': mdTag });
  assert.equal(mdAgain.status, 304);
  await mdAgain.text();
  const htmlAgain = await get(url, { Accept: BROWSER_ACCEPT, 'If-None-Match': htmlTag });
  assert.equal(htmlAgain.status, 304);
  await htmlAgain.text();

  // Cross-representation: the tag of the other representation never 304s.
  const crossMd = await get(url, { Accept: AGENT_ACCEPT, 'If-None-Match': htmlTag });
  assert.equal(crossMd.status, 200);
  assert.equal((await crossMd.text()).startsWith('---'), true);

  const crossHtml = await get(url, { Accept: BROWSER_ACCEPT, 'If-None-Match': mdTag });
  assert.equal(crossHtml.status, 200);
  assert.match(await crossHtml.text(), /<!DOCTYPE html>/);
});

test('HEAD mirrors GET headers on both representations', async () => {
  for (const accept of [AGENT_ACCEPT, BROWSER_ACCEPT]) {
    const getRes = await get('/blog/published-post/', { Accept: accept });
    const getBody = await getRes.text();
    const headRes = await fetch(`${BASE}/blog/published-post/`, {
      method: 'HEAD',
      headers: { Accept: accept },
    });
    assert.equal(headRes.status, 200);
    for (const header of ['content-type', 'etag', 'vary', 'x-mdf-version', 'content-length']) {
      assert.equal(headRes.headers.get(header), getRes.headers.get(header), header);
    }
    assert.equal(headRes.headers.get('content-length'), String(Buffer.byteLength(getBody)));
    assert.equal(await headRes.text(), '');
  }
});

test('a 304 keeps Vary and the ETag but has no body', async () => {
  const res = await get('/blog/published-post/', { Accept: AGENT_ACCEPT });
  const tag = res.headers.get('etag');
  await res.text();

  const notModified = await get('/blog/published-post/', { Accept: AGENT_ACCEPT, 'If-None-Match': tag });
  assert.equal(notModified.status, 304);
  assert.equal(notModified.headers.get('etag'), tag);
  assert.equal(notModified.headers.get('vary'), 'Accept');
  assert.equal(await notModified.text(), '');
});

test('unknown and draft slugs are a real 404, with no redirect, in both representations', async () => {
  for (const slug of ['no-such-post', 'draft-post']) {
    for (const accept of [AGENT_ACCEPT, BROWSER_ACCEPT]) {
      const res = await get(`/blog/${slug}/`, { Accept: accept, redirect: 'manual' });
      assert.equal(res.status, 404, `${slug} ${accept}`);
      assert.equal(res.headers.get('location'), null, `${slug} ${accept} must not redirect`);
      assert.equal(res.headers.get('vary'), 'Accept');
      const body = await res.text();
      if (accept === AGENT_ACCEPT) {
        assert.match(res.headers.get('content-type'), /^text\/markdown/);
        assert.match(body, /^# Not found/);
        assert.match(body, /\[the blog index\]\(https:\/\/blog\.bitcryptic\.com\/\)/);
      } else {
        assert.match(res.headers.get('content-type'), /^text\/html/);
        assert.match(body, /Post not found/);
      }
    }
  }
});

test('any other unknown path is a 404 too, and negotiates', async () => {
  for (const pathname of ['/no-such-page', '/blog/', '/blog/published-post/extra']) {
    const html = await get(pathname, { Accept: BROWSER_ACCEPT });
    assert.equal(html.status, 404, pathname);
    assert.equal(html.headers.get('location'), null, pathname);
    assert.equal(html.headers.get('vary'), 'Accept', pathname);
    assert.match(await html.text(), /Post not found/, pathname);

    const md = await get(pathname, { Accept: AGENT_ACCEPT });
    assert.equal(md.status, 404, pathname);
    assert.match(md.headers.get('content-type'), /^text\/markdown/, pathname);
    assert.match(await md.text(), /^# Not found/, pathname);
  }
});

test('/rss.xml and /sitemap.xml never negotiate', async () => {
  const rss = await get('/rss.xml', { Accept: AGENT_ACCEPT });
  assert.equal(rss.status, 200);
  assert.match(rss.headers.get('content-type'), /xml/);
  assert.equal(rss.headers.get('vary'), null);
  const rssBody = await rss.text();
  assert.match(rssBody, /<rss/);
  assert.ok(rssBody.includes('/blog/published-post/'));

  const sitemap = await get('/sitemap.xml', { Accept: AGENT_ACCEPT });
  assert.equal(sitemap.status, 200);
  assert.equal(sitemap.headers.get('vary'), null);
  const sitemapBody = await sitemap.text();
  assert.ok(sitemapBody.includes('/blog/published-post/'));
  assert.ok(!sitemapBody.includes('/blog/draft-post/'));
});

test('/llms.txt lists the blog and every published post, with absolute URLs', async () => {
  const res = await get('/llms.txt');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/plain/);
  const body = await res.text();

  assert.match(body, /^# BitCryptic Blog/);
  assert.ok(body.includes('[Published Fixture Post](https://blog.bitcryptic.com/blog/published-post/)'));
  assert.ok(body.includes('(https://blog.bitcryptic.com/blog/superseded-post/)'));
  assert.ok(body.includes('/blog/superseded-post/'));
  assert.ok(!body.includes('draft-post'), 'drafts are not listed');
  assert.ok(body.includes('https://blog.bitcryptic.com/mdf.json'));
  // The markdown claim is made, and is tested above.
  assert.ok(body.includes('Accept: text/markdown'));
  // No AEO promises.
  assert.ok(!/cit(e|ation)|visibility|rank/i.test(body));
});

test('/mdf.json declares a free-only MDF 0.3.1 site', async () => {
  const res = await get('/mdf.json');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^application\/json/);
  const doc = await res.json();

  assert.equal(doc.mdf_version, '0.3.1');
  assert.equal(doc.site, 'https://blog.bitcryptic.com');
  assert.deepEqual(doc.pricing, { default: { rails: [] } });
  assert.equal(doc.auth, undefined);
  assert.equal(doc.pricing.sections, undefined);
  assert.equal(doc.llms_txt, 'https://blog.bitcryptic.com/llms.txt');
  assert.equal(doc.formats.frontmatter, true);
  assert.equal(doc.feed.url, 'https://blog.bitcryptic.com/rss.xml');
  // No AEO promises in the capability document either.
  assert.ok(!/cit(e|ation)|visibility|rank/i.test(JSON.stringify(doc)));
});
