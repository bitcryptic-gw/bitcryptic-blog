/**
 * Assertions against the real content repository, when a clone is available.
 *
 * The fixture tests pin the behaviour; these pin it against the posts that are
 * actually published — specifically that both superseded MDF posts carry the
 * banner and that inline corrections survive unchanged. They are skipped, not
 * failed, where no content clone is mounted (for example a bare CI checkout);
 * the container always has one at /app/src/content/blog.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPosts } from '../scripts/validate-content.mjs';
import { postMarkdown } from '../src/lib/markdown-content.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CANDIDATES = [
  process.env.CONTENT_DIR,
  path.join(ROOT, 'src/content/blog'),
  path.join(ROOT, '..', 'content'),
].filter(Boolean);

const contentDir = CANDIDATES.find(dir => {
  try {
    return fs.readdirSync(dir).some(file => file.endsWith('.md'));
  } catch {
    return false;
  }
});

const skip = contentDir ? false : 'no content clone available';

test('real content: both superseded MDF posts carry the blockquote and the correct link', { skip }, () => {
  const { posts } = loadPosts(contentDir);
  const mdfPosts = posts.filter(p => p.superseded_by);
  assert.ok(mdfPosts.length >= 2, 'expected at least two superseded posts');

  for (const post of mdfPosts) {
    const md = postMarkdown(post);
    assert.ok(md.includes('> **Kept for the record.**'), post.slug);
    assert.ok(md.includes(`See [the current state of MDF](https://blog.bitcryptic.com/blog/${post.superseded_by}/).`), post.slug);
    assert.ok(md.includes(`superseded_by: "https://blog.bitcryptic.com/blog/${post.superseded_by}/"`), post.slug);
    // Corrections stay exactly as stored.
    const corrections = post.content.match(/~~[^~]+~~/g) ?? [];
    assert.ok(corrections.length > 0, `${post.slug} should still hold its inline corrections`);
    for (const correction of corrections) assert.ok(md.includes(correction), post.slug);
  }
});

test('real content: every published post renders markdown with frontmatter and an H1', { skip }, () => {
  const { posts } = loadPosts(contentDir);
  assert.ok(posts.length > 0);
  for (const post of posts) {
    const md = postMarkdown(post);
    assert.match(md, /^---\n/, post.slug);
    assert.ok(md.includes(`\n# ${post.title}\n`), post.slug);
    assert.ok(md.includes(`canonical: "https://blog.bitcryptic.com/blog/${post.slug}/"`), post.slug);
    assert.ok(!md.includes('](/blog/'), `${post.slug}: no site-relative link targets left`);
  }
});
