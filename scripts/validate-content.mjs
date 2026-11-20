/**
 * Shared content validator for the BitCryptic blog.
 *
 * One implementation, three callers:
 *   - scripts/sync.mjs        (blocks a bad merge from reaching the live site)
 *   - src/pages/*             (skip + log a bad post instead of 500ing the site)
 *   - CI on pull requests      (node scripts/validate-content.mjs <dir>)
 *
 * Rules, all derived from bitcryptic-blog-content/README.md:
 *   - a file with frontmatter must be a post: title, slug, date, description and
 *     status are required and typed; tags/author/updated are optional;
 *   - `date` must parse and `status` must be one of draft|published;
 *   - `slug` must be URL-safe and unique across the whole directory;
 *   - `superseded_by`, if set, must name an existing *published* slug;
 *   - the file stem must equal the slug, except for the legacy files listed in
 *     LEGACY_FILE_STEMS (they predate the convention and are live, so they must
 *     keep validating as-is).
 *
 * A file with no frontmatter is not a post (README.md lives in the same
 * directory) and is ignored rather than failed.
 *
 * Errors block publication. Warnings are reported and ignored.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { SLUG_PATTERN, ALLOWED_STATUS, REQUIRED_FIELDS, LEGACY_FILE_STEMS } from '../src/lib/content-rules.mjs';
import { loadSiteConfig } from '../src/lib/site-config.mjs';
import { validatePages, readPagesDir, PAGES_DIR } from '../src/lib/pages.mjs';

export { SLUG_PATTERN, ALLOWED_STATUS, REQUIRED_FIELDS, LEGACY_FILE_STEMS };

const hasFrontmatter = raw => raw.startsWith('---');

/**
 * Parse one post file.
 * @returns {{ data: object, content: string, warnings: string[] }}
 * @throws {Error} when the frontmatter does not parse
 */
export function parsePostFile(raw, name) {
  if (!hasFrontmatter(raw)) {
    const err = new Error(`${name}: no frontmatter — not a post file`);
    err.notAPost = true;
    throw err;
  }
  let parsed;
  try {
    parsed = matter(raw);
  } catch (e) {
    throw new Error(`${name}: frontmatter does not parse — ${e.message.split('\n')[0]}`);
  }
  // gray-matter memoises a failed parse: the first call throws, later calls with
  // the same input return empty data instead. A post that starts with `---` but
  // yields no keys is therefore a failure, not an empty post.
  if (Object.keys(parsed.data ?? {}).length === 0) {
    throw new Error(`${name}: frontmatter is empty or could not be read`);
  }
  return { data: parsed.data ?? {}, content: parsed.content, warnings: [] };
}

const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

/**
 * Field-level validation for one parsed post. Reference checks (unique slug,
 * superseded_by target) are done by validateContent, which sees every file.
 */
function validateFields(data, name) {
  const errors = [];
  const warnings = [];

  for (const field of REQUIRED_FIELDS) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`${name}: missing required field "${field}"`);
    }
  }

  for (const field of ['title', 'slug', 'description']) {
    if (data[field] !== undefined && !isNonEmptyString(data[field])) {
      errors.push(`${name}: "${field}" must be a non-empty string`);
    }
  }

  if (data.status !== undefined && !ALLOWED_STATUS.includes(data.status)) {
    errors.push(`${name}: "status" must be one of ${ALLOWED_STATUS.join('|')}, got ${JSON.stringify(data.status)}`);
  }

  if (data.date !== undefined) {
    const d = new Date(data.date);
    if (Number.isNaN(d.valueOf())) {
      errors.push(`${name}: "date" does not parse as a date (${JSON.stringify(data.date)})`);
    }
  }

  if (data.slug !== undefined && isNonEmptyString(data.slug) && !SLUG_PATTERN.test(data.slug)) {
    errors.push(`${name}: "slug" must be lowercase words separated by single hyphens (got ${JSON.stringify(data.slug)})`);
  }

  if (data.tags !== undefined) {
    if (!Array.isArray(data.tags) || data.tags.some(t => !isNonEmptyString(t))) {
      errors.push(`${name}: "tags" must be an array of strings`);
    }
  }

  for (const field of ['author', 'superseded_note', 'superseded_by']) {
    if (data[field] !== undefined && !isNonEmptyString(data[field])) {
      errors.push(`${name}: "${field}" must be a non-empty string when present`);
    }
  }

  if (data.updated !== undefined && Number.isNaN(new Date(data.updated).valueOf())) {
    errors.push(`${name}: "updated" does not parse as a date`);
  }
  if (data.superseded_on !== undefined && Number.isNaN(new Date(data.superseded_on).valueOf())) {
    errors.push(`${name}: "superseded_on" does not parse as a date`);
  }

  if (data.superseded_note !== undefined && data.superseded_by === undefined) {
    warnings.push(`${name}: "superseded_note" has no "superseded_by" and will not render`);
  }

  return { errors, warnings };
}

/**
 * Validate a whole directory's worth of files.
 *
 * @param {{ files: {name: string, raw: string}[], strictNames?: boolean }} input
 * @returns {{ ok: boolean, posts: object[], errors: {file: string, message: string}[], warnings: {file: string, message: string}[], ignored: string[] }}
 */
export function validateContent({ files, strictNames = false }) {
  const posts = [];
  const errors = [];
  const warnings = [];
  const ignored = [];
  const stems = new Set();

  for (const { name, raw } of files) {
    try {
      const parsed = parsePostFile(raw, name);
      const fieldCheck = validateFields(parsed.data, name);
      for (const message of fieldCheck.errors) errors.push({ file: name, message });
      for (const message of fieldCheck.warnings) warnings.push({ file: name, message });
      posts.push({ name, data: parsed.data, content: parsed.content, valid: fieldCheck.errors.length === 0 });
      stems.add(name.replace(/\.md$/, ''));
    } catch (e) {
      if (e.notAPost) {
        ignored.push(name);
        continue;
      }
      errors.push({ file: name, message: e.message });
    }
  }

  // slug: unique, and the file stem matches it (legacy stems excepted).
  const bySlug = new Map();
  for (const post of posts) {
    const { slug } = post.data;
    if (!isNonEmptyString(slug)) continue; // already reported as a field error
    if (bySlug.has(slug)) {
      errors.push({ file: post.name, message: `${post.name}: duplicate slug "${slug}" (also used by ${bySlug.get(slug).name})` });
    } else {
      bySlug.set(slug, post);
    }
    const stem = post.name.replace(/\.md$/, '');
    if (stem !== slug) {
      const message = `${post.name}: file name does not match slug "${slug}" (expected ${slug}.md)`;
      if (strictNames && !LEGACY_FILE_STEMS.has(stem)) errors.push({ file: post.name, message });
      else if (!LEGACY_FILE_STEMS.has(stem)) warnings.push({ file: post.name, message });
    }
  }

  // superseded_by must point at an existing published slug.
  const publishedSlugs = new Set(
    posts.filter(p => p.data.status === 'published' && isNonEmptyString(p.data.slug)).map(p => p.data.slug)
  );
  for (const post of posts) {
    const target = post.data.superseded_by;
    if (!isNonEmptyString(target)) continue;
    if (!publishedSlugs.has(target)) {
      errors.push({ file: post.name, message: `${post.name}: superseded_by "${target}" is not a published post` });
    }
  }

  const ok = errors.length === 0;
  return { ok, posts, errors, warnings, ignored, stems };
}

/** Read every .md file in a directory into { name, raw } records. */
export function readContentDir(dir) {
  const names = fs.readdirSync(dir).filter(f => f.endsWith('.md')).sort();
  return names.map(name => ({ name, raw: fs.readFileSync(path.join(dir, name), 'utf-8') }));
}

/**
 * The route-facing entry point: every published, valid post, newest first.
 * Invalid posts are skipped and reported in `skipped` so the caller can log
 * them; they never throw.
 *
 * @returns {{ posts: object[], skipped: {file: string, message: string}[], warnings: object[], ignored: string[] }}
 */
export function loadPosts(dir) {
  const files = readContentDir(dir);
  const result = validateContent({ files });
  const failedFiles = new Set(result.errors.map(e => e.file));

  const posts = result.posts
    .filter(p => p.data.status === 'published' && p.valid && !failedFiles.has(p.name))
    .map(p => ({
      file: p.name,
      title: p.data.title,
      slug: p.data.slug,
      description: p.data.description,
      date: new Date(p.data.date),
      updated: p.data.updated ? new Date(p.data.updated) : undefined,
      author: p.data.author ?? 'BitCryptic',
      tags: Array.isArray(p.data.tags) ? p.data.tags : [],
      superseded_by: p.data.superseded_by,
      superseded_on: p.data.superseded_on ? new Date(p.data.superseded_on) : undefined,
      superseded_note: p.data.superseded_note,
      content: p.content,
    }))
    .sort((a, b) => b.date.valueOf() - a.date.valueOf());

  return { posts, skipped: result.errors, warnings: result.warnings, ignored: result.ignored };
}

/** Human-readable report, used by the CLI and the sync loop's alert body. */
export function formatReport(result) {
  const lines = [];
  for (const { file, message } of result.errors) lines.push(`FAIL  ${message}`);
  for (const { file, message } of result.warnings) lines.push(`warn  ${message}`);
  for (const file of result.ignored ?? []) lines.push(`skip  ${file}: no frontmatter (not a content file)`);
  const pages = result.pages?.length ? `, ${result.pages.length} page(s)` : '';
  lines.push(result.ok ? `OK    ${result.posts.length} post file(s) validated${pages}` : `FAILED ${result.errors.length} error(s)`);
  return lines.join('\n');
}

/**
 * Validate a whole checkout of a content repo: `site.json`, the posts at the
 * root, and the pages in `pages/`.
 *
 * This is the check that gates publishing. A bad config is held back exactly
 * like a bad post: the sync loop leaves the live content where it was and
 * alerts once for the commit.
 *
 * @param {string} dir
 * @param {{ strictNames?: boolean }} [options]
 */
export function validateCheckout(dir, { strictNames = false } = {}) {
  const site = loadSiteConfig(dir);
  const errors = [];
  const warnings = [];

  for (const message of site.errors) errors.push({ file: 'site.json', message });
  for (const message of site.warnings) warnings.push({ file: 'site.json', message });

  const { config } = site;

  let postsResult = { posts: [], errors: [], warnings: [], ignored: [] };
  try {
    postsResult = validateContent({ files: readContentDir(dir), strictNames });
    for (const error of postsResult.errors) errors.push(error);
    for (const warning of postsResult.warnings) warnings.push(warning);
  } catch (error) {
    errors.push({ file: dir, message: `cannot read posts: ${error.message}` });
  }

  // A site that does not serve posts but has them, or vice versa, is a content
  // repo drifting away from its own config. Worth saying, not worth blocking.
  if (!config.content.posts && postsResult.posts.length > 0) {
    warnings.push({
      file: 'site.json',
      message: `"content.posts" is false but this repo has ${postsResult.posts.length} post file(s); they will not be served`,
    });
  }

  let pagesResult = { pages: [], errors: [], warnings: [], ignored: [] };
  try {
    const files = readPagesDir(dir);
    if (files.length > 0 && !config.content.pages) {
      warnings.push({
        file: PAGES_DIR,
        message: `"content.pages" is false but ${PAGES_DIR}/ has ${files.length} file(s); they will not be served`,
      });
    }
    if (config.content.pages) {
      pagesResult = validatePages({ files, theme: config.theme });
      for (const error of pagesResult.errors) errors.push(error);
      for (const warning of pagesResult.warnings) warnings.push(warning);
    }
  } catch (error) {
    errors.push({ file: PAGES_DIR, message: `cannot read pages: ${error.message}` });
  }

  return {
    ok: errors.length === 0,
    config,
    configErrorCount: site.errors.length,
    posts: postsResult.posts,
    pages: pagesResult.pages,
    errors,
    warnings,
    ignored: [...(postsResult.ignored ?? []), ...(pagesResult.ignored ?? [])],
  };
}

// CLI: node scripts/validate-content.mjs [dir] [--strict-names]
if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  const strictNames = args.includes('--strict-names');
  const dir = args.find(a => !a.startsWith('--')) ?? process.env.CONTENT_DIR ?? '/app/src/content/blog';
  try {
    const result = validateCheckout(dir, { strictNames });
    console.log(formatReport(result));
    process.exit(result.ok ? 0 : 1);
  } catch (e) {
    console.error(`cannot validate ${dir}: ${e.message}`);
    process.exit(2);
  }
}
