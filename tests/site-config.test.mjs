/**
 * Site config: the file that makes one image serve more than one site.
 *
 * The important property here is the first test: no `site.json` at all means
 * exactly the blog, field for field. Everything else is validation — a bad
 * config is held back like a bad post, so a typo must be an error rather than a
 * silent no-op.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_CONFIG,
  loadSiteConfig,
  mergeConfig,
  orderedNav,
  originError,
  pageTitle,
  validateSiteConfig,
} from '../src/lib/site-config.mjs';
import { THEMES } from '../src/lib/themes.mjs';

const writeConfig = raw => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-'));
  fs.writeFileSync(path.join(dir, 'site.json'), typeof raw === 'string' ? raw : JSON.stringify(raw));
  return dir;
};

test('no site.json means the blog, exactly', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'site-config-'));
  const loaded = loadSiteConfig(dir);
  assert.equal(loaded.fromFile, false);
  assert.deepEqual(loaded.errors, []);
  assert.equal(loaded.config, DEFAULT_CONFIG);
  assert.equal(loaded.config.name, 'BitCryptic Blog');
  assert.equal(loaded.config.origin, 'https://blog.bitcryptic.com');
  assert.equal(loaded.config.theme, 'blog');
  assert.deepEqual(loaded.config.content, { posts: true, pages: false });
  assert.equal(loaded.config.mdf.name, 'BitCryptic Blog');
  assert.equal(loaded.config.umami.websiteId, 'd183ecc5-3e7d-4a80-a70a-32fc1ba800c1');
  assert.equal(pageTitle(loaded.config, 'Blog'), 'Blog — BitCryptic');
});

test('a full config merges over the defaults and keeps unknown fields out', () => {
  const raw = {
    name: 'markdownfirst',
    shortName: 'markdownfirst',
    titleTemplate: 'markdownfirst.com · {title}',
    origin: 'https://markdownfirst.com',
    theme: 'markdownfirst',
    content: { posts: false, pages: true },
    nav: [{ label: 'Spec', path: '/spec/', order: 2 }],
    umami: null,
    footer: { left: 'a', right: 'b' },
    mdf: { name: 'md', contact: 'https://example.com/contact' },
    llms: { description: 'd', topics: 't' },
  };
  const { errors, config } = validateSiteConfig(raw);
  assert.deepEqual(errors, []);
  assert.equal(config.theme, 'markdownfirst');
  assert.deepEqual(config.content, { posts: false, pages: true });
  assert.equal(config.umami, null);
  assert.equal(config.nav.length, 1);
  assert.equal(config.nav[0].order, 2);
  assert.equal(pageTitle(config, 'Home'), 'markdownfirst.com · Home');
  // Unset groups keep their defaults.
  assert.equal(config.notFound.heading, DEFAULT_CONFIG.notFound.heading);
});

test('an unknown key is an error, not a shrug', () => {
  const { errors } = validateSiteConfig({ name: 'x', hero: {} });
  assert.ok(errors.some(message => /unknown field "hero"/.test(message)), errors.join('\n'));
});

test('pricing cannot be configured into a free-only site', () => {
  const { errors } = validateSiteConfig({ mdf: { pricing: { default: { rails: ['lightning'] } } } });
  assert.ok(errors.some(message => /mdf\.pricing/.test(message) && /free-only/.test(message)), errors.join('\n'));
});

test('origin must be a bare https origin', () => {
  assert.equal(originError('https://blog.bitcryptic.com'), null);
  assert.match(originError('https://blog.bitcryptic.com/'), /must not end with a slash/);
  assert.match(originError('http://example.com'), /https/);
  assert.match(originError('https://example.com/path'), /bare origin/);
  assert.match(originError('not a url'), /not a URL/);
  assert.match(originError(''), /non-empty/);
});

test('theme must be one of the bundled themes', () => {
  const { errors } = validateSiteConfig({ theme: 'wordpress' });
  assert.ok(errors.some(message => /must be one of/.test(message)), errors.join('\n'));
  for (const name of Object.keys(THEMES)) {
    assert.deepEqual(validateSiteConfig({ theme: name }).errors, [], name);
  }
});

test('content must enable at least one of posts or pages', () => {
  const { errors } = validateSiteConfig({ content: { posts: false, pages: false } });
  assert.ok(errors.some(message => /at least one/.test(message)), errors.join('\n'));
  assert.ok(validateSiteConfig({ content: { posts: 'yes' } }).errors.length > 0);
  assert.ok(validateSiteConfig({ content: { pages: true, podcsts: true } }).errors.length > 0);
});

test('nav: label, path, order and the button style are checked', () => {
  assert.deepEqual(validateSiteConfig({ nav: [{ label: 'Spec', path: '/spec/' }] }).errors, []);
  assert.deepEqual(validateSiteConfig({ nav: [{ label: 'Demo', path: 'https://demo.example' }] }).errors, []);
  assert.deepEqual(validateSiteConfig({ nav: [{ label: 'In page', path: '#race' }] }).errors, []);
  assert.deepEqual(validateSiteConfig({ nav: [{ label: 'Demo', path: '/', style: 'button' }] }).errors, []);

  const bad = validateSiteConfig({ nav: [{ label: '', path: 'spec', order: 'first' }] }).errors.join('\n');
  assert.match(bad, /"label" must be a non-empty string/);
  assert.match(bad, /"path" must start with/);
  assert.match(bad, /"order" must be a number/);
  assert.match(validateSiteConfig({ nav: [{ label: 'x', path: '/', style: 'loud' }] }).errors.join('\n'), /plain or button/);
});

test('nav order is honoured and stable for equal orders', () => {
  const config = mergeConfig({
    nav: [
      { label: 'b', path: '/b/', order: 20 },
      { label: 'a', path: '/a/', order: 10 },
      { label: 'c', path: '/c/', order: 10 },
    ],
  });
  assert.deepEqual(orderedNav(config).map(item => item.label), ['a', 'c', 'b']);
});

test('a bad file is reported and the defaults are used', () => {
  const broken = loadSiteConfig(writeConfig('{ not json'));
  assert.ok(broken.errors.some(message => /not valid JSON/.test(message)), broken.errors.join('\n'));
  assert.equal(broken.config, DEFAULT_CONFIG);

  const unknown = loadSiteConfig(writeConfig({ name: 'x', themes: 'markdownfirst' }));
  assert.ok(unknown.errors.some(message => /unknown field "themes"/.test(message)));
});

test('titleTemplate must contain {title}, umami may be switched off', () => {
  assert.match(validateSiteConfig({ titleTemplate: 'static' }).errors.join('\n'), /must contain \{title\}/);
  assert.deepEqual(validateSiteConfig({ umami: null }).errors, []);
  assert.match(validateSiteConfig({ umami: {} }).errors.join('\n'), /websiteId/);
});
