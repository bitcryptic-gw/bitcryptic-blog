/**
 * Pages: undated markdown in `pages/`, served at /<slug>/ and negotiated like
 * posts. The rules that matter are the two page-specific ones — the layout must
 * name something the theme has, and a designed page must still carry a real
 * markdown body — plus the ordinary shape checks.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  MIN_BODY_CHARS,
  bodyText,
  buildNav,
  loadPages,
  pageFileExists,
  pagePath,
  readPagesDir,
  navPathIsServed,
  slugFromPath,
  validatePageFields,
  validatePages,
} from '../src/lib/pages.mjs';

const page = over => `---
title: "A Page"
slug: "a-page"
description: "Short."
order: 10
status: published
${over ?? ''}---

Body.
`;

const body = 'x'.repeat(MIN_BODY_CHARS + 10) + '\n\nsecond line\n\nthird line\n';

const run = (files, theme = 'markdownfirst') => validatePages({ files, theme });

test('a minimal page validates and defaults to the plain page layout', () => {
  const result = run([{ name: 'a-page.md', raw: page() }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pages.length, 1);
  assert.equal(result.pages[0].layout, 'page');
  assert.equal(result.pages[0].order, 10);
});

test('index.md is the home page, with slug ""', () => {
  const result = run([{ name: 'index.md', raw: page().replace('slug: "a-page"', 'slug: ""').replace('layout:', 'x-layout:') }]);
  assert.deepEqual(result.errors, []);
  assert.equal(result.pages[0].slug, '');
  assert.equal(pagePath(''), '/');
  assert.equal(pagePath('about'), '/about/');
});

test('the file name is the page identity', () => {
  const mismatch = run([{ name: 'about.md', raw: page() }]);
  assert.match(mismatch.errors[0].message, /does not match slug/);

  const indexWithoutEmptySlug = run([{ name: 'index.md', raw: page() }]);
  assert.match(indexWithoutEmptySlug.errors[0].message, /does not match slug/);
});

test('reserved slugs are refused', () => {
  for (const slug of ['blog', 'api', '404']) {
    const result = run([{ name: `${slug}.md`, raw: page().replace('slug: "a-page"', `slug: "${slug}"`) }]);
    assert.ok(result.errors.some(e => /reserved/.test(e.message)), slug);
  }
});

test('required fields, status and order are checked', () => {
  const result = run([{
    name: 'a-page.md',
    raw: '---\ntitle: ""\nslug: "a-page"\nstatus: live\norder: "first"\n---\n\nBody.\n',
  }]);
  const messages = result.errors.map(e => e.message).join('\n');
  assert.match(messages, /missing required field "description"/);
  assert.match(messages, /"title" must be a non-empty string/);
  assert.match(messages, /"status" must be one of draft\|published/);
  assert.match(messages, /"order" must be a number/);
});

test('an unknown layout is an error, never a silent fallback', () => {
  const result = run([{ name: 'a-page.md', raw: page().replace('status: published', 'status: published\nlayout: wide') }]);
  assert.ok(result.errors.some(e => /layout "wide" is not provided by theme "markdownfirst"/.test(e.message)));
});

test('the blog theme has no page layouts, so it cannot host pages', () => {
  const result = run([{ name: 'a-page.md', raw: page() }], 'blog');
  assert.ok(result.errors.some(e => /has no page layouts/.test(e.message)), JSON.stringify(result.errors));
});

const HERO = `
hero:
  headline: "Agents read the web."
  actions:
    - label: "Go"
      href: "/"
`;

test('a custom-layout page must still carry a real markdown body', () => {
  const thin = run([{
    name: 'a-page.md',
    raw: page().replace('status: published', `status: published\nlayout: home\n${HERO}`),
  }]);
  assert.ok(thin.errors.some(e => /needs a real markdown body/.test(e.message)), JSON.stringify(thin.errors));

  const real = run([{
    name: 'a-page.md',
    raw: page().replace('status: published', `status: published\nlayout: home\n${HERO}`).replace('Body.\n', body),
  }]);
  assert.deepEqual(real.errors, [], JSON.stringify(real.errors));
});

test('home frontmatter is validated as part of the page', () => {
  const missingHero = run([{
    name: 'a-page.md',
    raw: page().replace('status: published', 'status: published\nlayout: home') .replace('Body.\n', body),
  }]);
  assert.ok(missingHero.errors.some(e => /needs a "hero"/.test(e.message)), JSON.stringify(missingHero.errors));
});

test('a file with no frontmatter is ignored, not failed', () => {
  const result = run([{ name: 'README.md', raw: '# just a readme\n' }]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.ignored, ['README.md']);
});

test('published pages load in order; drafts do not', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages/about.md'), page().replace('slug: "a-page"', 'slug: "about"').replace('order: 10', 'order: 30'));
  fs.writeFileSync(path.join(dir, 'pages/contact.md'), page().replace('slug: "a-page"', 'slug: "contact"').replace('order: 10', 'order: 20').replace('title: "A Page"', 'title: "Contact"'));
  fs.writeFileSync(path.join(dir, 'pages/secret.md'), page().replace('slug: "a-page"', 'slug: "secret"').replace('status: published', 'status: draft'));

  const loaded = loadPages(dir, 'markdownfirst');
  assert.deepEqual(loaded.pages.map(p => p.slug), ['contact', 'about']);
  assert.equal(readPagesDir(dir).length, 3);
});

test('a missing pages directory is simply no pages', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  assert.deepEqual(readPagesDir(dir), []);
  const loaded = loadPages(dir, 'markdownfirst');
  assert.deepEqual(loaded.pages, []);
});

test('nav is derived from published pages that carry a label', () => {
  const nav = buildNav([
    { slug: '', nav: undefined, order: 0 },
    { slug: 'about', nav: 'About', order: 10 },
    { slug: 'spec', nav: 'Spec', order: 5 },
  ]);
  assert.deepEqual(nav.map(item => item.label), ['Spec', 'About']);
  assert.deepEqual(nav.map(item => item.path), ['/spec/', '/about/']);
});

test('a menu entry must point at something the site actually serves', () => {
  const published = [{ slug: '' }, { slug: 'about' }];
  // Served: external, in-page, home, reserved routes, static files, real pages.
  for (const path of ['https://example.com/x', '#race', '/', '/blog/', '/api/x', '/404', '/rss.xml', '/about/', '/about', '/a/b/']) {
    assert.equal(navPathIsServed(path, published), true, path);
  }
  // Not served: a draft page, a page that does not exist, an empty path.
  for (const path of ['/secret/', '/missing', '', null]) {
    assert.equal(navPathIsServed(path, published), false, String(path));
  }
});

test('path helpers: only single-segment paths can be pages', () => {
  assert.equal(slugFromPath('/'), '');
  assert.equal(slugFromPath('/about/'), 'about');
  assert.equal(slugFromPath('/about'), 'about');
  assert.equal(slugFromPath('/blog/welcome/'), null);
  assert.equal(slugFromPath('/a/b/'), null);
  assert.equal(slugFromPath('/%E2%9C%93/'), '✓');
});

test('pageFileExists is cheap and refuses anything that is not a slug', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pages-'));
  fs.mkdirSync(path.join(dir, 'pages'));
  fs.writeFileSync(path.join(dir, 'pages/about.md'), page());
  assert.equal(pageFileExists(dir, 'about'), true);
  assert.equal(pageFileExists(dir, 'nope'), false);
  assert.equal(pageFileExists(dir, '../about'), false);
  assert.equal(pageFileExists(dir, null), false);
});

test('bodyText ignores code fences and markdown furniture', () => {
  assert.equal(bodyText('```\ncode\n```\n# Hi'), 'Hi');
  assert.equal(bodyText('- a\n- b'), 'a b');
});

test('validatePageFields returns the parsed page so a route can use it', () => {
  const { page: parsed } = validatePageFields(
    { title: 'T', slug: 'a-page', description: 'D', status: 'published' },
    'a-page.md',
    'markdownfirst'
  );
  assert.equal(parsed.title, 'T');
  assert.equal(parsed.layout, 'page');
});
