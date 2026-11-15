import assert from 'node:assert/strict';
import test from 'node:test';
import { validateContent, loadPosts, formatReport } from '../scripts/validate-content.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const good = (over = {}) => {
  const data = {
    title: 'A Good Post',
    slug: 'a-good-post',
    date: '2026-11-15',
    description: 'Description.',
    status: 'published',
    ...over,
  };
  const lines = Object.entries(data).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `---\n${lines.join('\n')}\n---\n\nBody text.\n`;
};

const run = (files, opts) => validateContent({ files, ...opts });

test('a well-formed post validates', () => {
  const result = run([{ name: 'a-good-post.md', raw: good() }]);
  assert.equal(result.ok, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.posts.length, 1);
});

test('optional fields are accepted', () => {
  const raw = good({ updated: '2026-11-16', author: 'Gary', tags: ['a', 'b'] });
  const result = run([{ name: 'a-good-post.md', raw }]);
  assert.equal(result.ok, true, formatReport(result));
});

test('frontmatter that does not parse is an error', () => {
  const result = run([{ name: 'broken.md', raw: '---\ntitle: "x"\nbad: *nope\n---\n\nbody\n' }]);
  assert.equal(result.ok, false);
  assert.match(result.errors[0].message, /does not parse/);
});

test('missing required fields are errors', () => {
  const raw = '---\ntitle: "Only a title"\n---\n\nbody\n';
  const result = run([{ name: 'only-title.md', raw }]);
  assert.equal(result.ok, false);
  for (const field of ['slug', 'date', 'description', 'status']) {
    assert.ok(
      result.errors.some(e => e.message.includes(`missing required field "${field}"`)),
      `expected an error for ${field}`
    );
  }
});

test('an unparseable date is an error', () => {
  const result = run([{ name: 'a-good-post.md', raw: good({ date: 'not-a-date' }) }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.message.includes('"date" does not parse')));
});

test('a status outside draft|published is an error', () => {
  const result = run([{ name: 'a-good-post.md', raw: good({ status: 'live' }) }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.message.includes('"status" must be one of')));
});

test('a non-URL-safe slug is an error', () => {
  const result = run([{ name: 'a-good-post.md', raw: good({ slug: 'Not A Slug' }) }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.message.includes('"slug" must be lowercase')));
});

test('tags must be an array of strings', () => {
  const result = run([{ name: 'a-good-post.md', raw: good({ tags: 'a,b' }) }]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.message.includes('"tags" must be an array')));
});

test('a duplicate slug is an error', () => {
  const result = run([
    { name: 'a-good-post.md', raw: good() },
    { name: 'another-file.md', raw: good() },
  ]);
  assert.equal(result.ok, false);
  assert.ok(result.errors.some(e => e.message.includes('duplicate slug')));
});

test('superseded_by must name a published slug', () => {
  const missing = run([{ name: 'a-good-post.md', raw: good({ superseded_by: 'nope' }) }]);
  assert.equal(missing.ok, false);
  assert.ok(missing.errors.some(e => e.message.includes('is not a published post')));

  const target = { name: 'the-new-post.md', raw: good({ slug: 'the-new-post', title: 'New' }) };
  const ok = run([{ name: 'a-good-post.md', raw: good({ superseded_by: 'the-new-post' }) }, target]);
  assert.equal(ok.ok, true, formatReport(ok));

  const draftTarget = { name: 'the-new-post.md', raw: good({ slug: 'the-new-post', status: 'draft' }) };
  const bad = run([{ name: 'a-good-post.md', raw: good({ superseded_by: 'the-new-post' }) }, draftTarget]);
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.some(e => e.message.includes('is not a published post')));
});

test('file name vs slug: warning by default, error under --strict-names, legacy stems exempt', () => {
  const mismatched = [{ name: 'some-other-name.md', raw: good() }];
  const lenient = run(mismatched);
  assert.equal(lenient.ok, true);
  assert.ok(lenient.warnings.some(w => w.message.includes('does not match slug')));

  const strict = run(mismatched, { strictNames: true });
  assert.equal(strict.ok, false);
  assert.ok(strict.errors.some(e => e.message.includes('does not match slug')));

  const legacy = run([{ name: 'mdf-blog-post-20260526.md', raw: good({ slug: 'mdf-markdown-first' }) }], { strictNames: true });
  assert.equal(legacy.ok, true, formatReport(legacy));
});

test('a file without frontmatter is ignored, not failed', () => {
  const result = run([{ name: 'README.md', raw: '# Readme\n\nNot a post.\n' }, { name: 'a-good-post.md', raw: good() }]);
  assert.equal(result.ok, true);
  assert.deepEqual(result.ignored, ['README.md']);
});

test('loadPosts skips a bad post, keeps the good ones, and never throws', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-content-'));
  fs.writeFileSync(path.join(dir, 'README.md'), '# Readme\n');
  fs.writeFileSync(path.join(dir, 'a-good-post.md'), good());
  fs.writeFileSync(path.join(dir, 'older.md'), good({ slug: 'older', title: 'Older', date: '2026-01-01' }));
  fs.writeFileSync(path.join(dir, 'a-draft.md'), good({ slug: 'a-draft', status: 'draft' }));
  fs.writeFileSync(path.join(dir, 'broken.md'), '---\ntitle: "x"\nbad: *nope\n---\n');

  const { posts, skipped, ignored } = loadPosts(dir);
  assert.deepEqual(posts.map(p => p.slug), ['a-good-post', 'older'], 'published valid posts, newest first');
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].file, /broken\.md/);
  assert.deepEqual(ignored, ['README.md']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadPosts excludes a post whose superseded_by dangles', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'blog-content-'));
  fs.writeFileSync(path.join(dir, 'a-good-post.md'), good({ superseded_by: 'gone' }));
  const { posts, skipped } = loadPosts(dir);
  assert.equal(posts.length, 0);
  assert.equal(skipped.length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formatReport surfaces failures', () => {
  const result = run([{ name: 'broken.md', raw: '---\ntitle: "x"\nbad: *nope\n---\n' }]);
  const report = formatReport(result);
  assert.match(report, /FAIL/);
  assert.match(report, /FAILED 1 error/);
});
