import assert from 'node:assert/strict';
import test from 'node:test';
import {
  absolutiseLinks,
  frontmatterLines,
  indexMarkdown,
  markdownLogLine,
  notFoundMarkdown,
  postMarkdown,
  supersededBlockquote,
} from '../src/lib/markdown-content.js';
import { etagFor, ifNoneMatchMatches } from '../src/lib/etag.js';

const post = (over = {}) => ({
  title: 'A Post: With a Colon',
  slug: 'a-post',
  description: 'Short description.',
  date: new Date('2026-03-02T00:00:00Z'),
  author: 'Test Author',
  tags: ['one', 'two'],
  content: '\n\nBody text with a ~~wrong~~ right correction.\n',
  ...over,
});

test('frontmatter: fields in documented order, ISO dates, YAML-safe strings', () => {
  const lines = frontmatterLines(post());
  assert.deepEqual(lines, [
    '---',
    'title: "A Post: With a Colon"',
    'date: 2026-03-02',
    'author: "Test Author"',
    'tags: ["one", "two"]',
    'canonical: "https://blog.bitcryptic.com/blog/a-post/"',
    '---',
  ]);
});

test('frontmatter: updated only when set', () => {
  const withUpdated = frontmatterLines(post({ updated: new Date('2026-04-01T00:00:00Z') }));
  assert.ok(withUpdated.includes('updated: 2026-04-01'));
  assert.ok(!frontmatterLines(post()).some(line => line.startsWith('updated:')));
});

test('frontmatter: superseded fields are absolute URLs', () => {
  const lines = frontmatterLines(post({ superseded_by: 'newer-post', superseded_note: 'Things moved.' }));
  assert.ok(lines.includes('superseded_by: "https://blog.bitcryptic.com/blog/newer-post/"'));
  assert.ok(lines.includes('superseded_note: "Things moved."'));
});

test('post markdown: frontmatter, blank line, H1, body — corrections kept', () => {
  const md = postMarkdown(post());
  const expected = [
    '---',
    'title: "A Post: With a Colon"',
    'date: 2026-03-02',
    'author: "Test Author"',
    'tags: ["one", "two"]',
    'canonical: "https://blog.bitcryptic.com/blog/a-post/"',
    '---',
    '',
    '# A Post: With a Colon',
    '',
    'Body text with a ~~wrong~~ right correction.',
    '',
  ].join('\n');
  assert.equal(md, expected);
});

test('post markdown: superseded blockquote sits before the body, above the H1 body', () => {
  const md = postMarkdown(post({
    superseded_by: 'newer-post',
    superseded_note: 'Prices changed.',
    date: new Date('2026-01-05T00:00:00Z'),
  }));
  const banner = md.split('\n').find(line => line.startsWith('>'));
  assert.equal(
    banner,
    '> **Kept for the record.** This post is from January 2026 and has been superseded. ' +
      'Prices changed. See [the current state of MDF](https://blog.bitcryptic.com/blog/newer-post/).'
  );
  assert.ok(md.indexOf('> **Kept for the record.**') < md.indexOf('Body text'));
});

test('supersededBlockquote is null for a live post', () => {
  assert.equal(supersededBlockquote(post()), null);
});

test('relative links become absolute; absolute, fragment and code are untouched', () => {
  const body = [
    'See [the post](/blog/other/).',
    'And [an external](https://example.com/x) and [a fragment](#here).',
    '',
    '```',
    '[inside code](/blog/not-rewritten/)',
    '```',
    '',
    '[ref]: /blog/ref-target/',
  ].join('\n');

  const out = absolutiseLinks(body, 'https://blog.bitcryptic.com/blog/a-post/');
  assert.match(out, /\[the post\]\(https:\/\/blog\.bitcryptic\.com\/blog\/other\/\)/);
  assert.match(out, /\[an external\]\(https:\/\/example\.com\/x\)/);
  assert.match(out, /\[a fragment\]\(#here\)/);
  assert.match(out, /\[inside code\]\(\/blog\/not-rewritten\/\)/);
  assert.match(out, /\[ref\]: https:\/\/blog\.bitcryptic\.com\/blog\/ref-target\//);
});

test('a bare relative path resolves against the post URL', () => {
  assert.equal(
    absolutiseLinks('[x](sibling/)', 'https://blog.bitcryptic.com/blog/a-post/'),
    '[x](https://blog.bitcryptic.com/blog/a-post/sibling/)'
  );
});

test('index markdown: heading, description, newest first, absolute URLs, superseded marker', () => {
  const md = indexMarkdown([
    post({ title: 'Newer', slug: 'newer', date: new Date('2026-05-01T00:00:00Z') }),
    post({ title: 'Older', slug: 'older', date: new Date('2026-01-01T00:00:00Z'), superseded_by: 'newer' }),
  ]);
  const lines = md.trimEnd().split('\n');
  assert.equal(lines[0], '# BitCryptic Blog');
  assert.equal(lines[1], '');
  assert.equal(lines[2], 'Crypto-native AI infrastructure, DePIN compute, and self-hosted systems.');
  assert.equal(lines[4], '- [Newer](https://blog.bitcryptic.com/blog/newer/) — 2026-05-01 — Short description.');
  assert.equal(
    lines[5],
    '- [Older](https://blog.bitcryptic.com/blog/older/) — 2026-01-01 — Short description. (superseded)'
  );
});

test('not-found markdown links to the index', () => {
  const md = notFoundMarkdown();
  assert.match(md, /^# Not found/);
  assert.match(md, /\[the blog index\]\(https:\/\/blog\.bitcryptic\.com\/\)/);
});

test('log line: time, path, status, UA — truncated, never a query string', () => {
  const ua = 'a'.repeat(300);
  const line = markdownLogLine('/blog/x/', 200, ua, new Date('2026-11-18T00:00:00Z'));
  assert.equal(line, `[mdf] 2026-11-18T00:00:00.000Z path=/blog/x/ status=200 ua="${'a'.repeat(200)}"`);
  assert.ok(!line.includes('?'));
});

test('etagFor is stable and depends on the bytes', () => {
  assert.equal(etagFor('a'), etagFor('a'));
  assert.notEqual(etagFor('a'), etagFor('b'));
  assert.match(etagFor('a'), /^"[0-9a-f]{32}"$/);
});

test('ifNoneMatchMatches: exact, list, weak and *', () => {
  const tag = etagFor('body');
  assert.equal(ifNoneMatchMatches(tag, tag), true);
  assert.equal(ifNoneMatchMatches(`"other", ${tag}`, tag), true);
  assert.equal(ifNoneMatchMatches(`W/${tag}`, tag), true);
  assert.equal(ifNoneMatchMatches('*', tag), true);
  assert.equal(ifNoneMatchMatches(etagFor('different'), tag), false);
  assert.equal(ifNoneMatchMatches(null, tag), false);
});
