/**
 * Pages: undated markdown files in `<content repo>/pages/`.
 *
 * Posts live at the content repo root and are dated. Pages live in `pages/`,
 * are not dated, never appear in the feed, and take their URL from their slug:
 *
 *   pages/index.md        slug ""          -> /
 *   pages/how-it-works.md slug how-it-works -> /how-it-works/
 *
 * The same rules as posts apply to what may be served: a page that fails
 * validation is skipped and logged by the routes, and the sync loop refuses to
 * publish a commit containing one.
 *
 * Two rules are page-specific and matter:
 *   - `layout` names one of the site theme's layouts (see lib/themes.mjs). An
 *     unknown layout is an error, never a silent fallback to the plain one,
 *     because a layout typo would otherwise publish the wrong page quietly.
 *   - a page on a custom layout must still carry a real markdown body. That
 *     body is what an agent gets when it asks for markdown, so a designed page
 *     whose body is empty or a placeholder is a bad page: the designed version
 *     would exist and the negotiated one would not.
 */
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import { SLUG_PATTERN } from './content-rules.mjs';
import { defaultPageLayout, themeInfo } from './themes.mjs';
import { HOME_KEYS, normaliseHome } from './home-data.mjs';

export const PAGES_DIR = 'pages';
export const ALLOWED_PAGE_STATUS = ['draft', 'published'];

/** A page body must be at least this long to count as "says something". */
export const MIN_BODY_CHARS = 300;
export const MIN_BODY_LINES = 3;

/**
 * Slugs that would collide with a route or a static asset path. A page is
 * single-segment, so these are the only collisions a slug can cause.
 */
export const RESERVED_SLUGS = Object.freeze([
  '', 'blog', 'api', '404', '_astro', 'favicon.ico',
]);

/**
 * The URL path a page answers on.
 * @param {string} slug
 * @returns {string}
 */
export function pagePath(slug) {
  return slug === '' ? '/' : `/${slug}/`;
}

/**
 * The slug a request path refers to, or null when the path cannot be a page.
 * Single segment only: `/how-it-works/` -> `how-it-works`, `/` -> ``.
 * @param {string} pathname
 * @returns {string | null}
 */
export function slugFromPath(pathname) {
  if (pathname === '/') return '';
  const match = pathname.match(/^\/([^/]+)\/?$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

/** Strip markdown furniture enough to judge whether a body says anything. */
export function bodyText(body) {
  return body
    .replace(/```[\s\S]*?```/g, '')
    .replace(/[#>*_`-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Non-empty source lines, the crude but honest measure of "a real body". */
export function bodyLines(body) {
  return body.split('\n').filter(line => line.trim() !== '').length;
}

/**
 * Field validation for one page's frontmatter, given its file name.
 *
 * @param {object} data  parsed frontmatter
 * @param {string} name  file name, e.g. `index.md`
 * @param {string} theme the site's theme name
 * @returns {{ errors: string[], warnings: string[], page: object | null }}
 */
export function validatePageFields(data, name, theme) {
  const errors = [];
  const warnings = [];
  const info = themeInfo(theme);

  const required = ['title', 'slug', 'description', 'status'];
  for (const field of required) {
    if (data[field] === undefined || data[field] === null) {
      errors.push(`${name}: missing required field "${field}"`);
    }
  }

  for (const field of ['title', 'description']) {
    if (data[field] !== undefined && !isNonEmptyString(data[field])) {
      errors.push(`${name}: "${field}" must be a non-empty string`);
    }
  }

  if (data.status !== undefined && !ALLOWED_PAGE_STATUS.includes(data.status)) {
    errors.push(`${name}: "status" must be one of ${ALLOWED_PAGE_STATUS.join('|')}, got ${JSON.stringify(data.status)}`);
  }

  // The stem is the page's identity: index.md is the home page (slug ""),
  // every other file is named after its slug.
  const stem = name.replace(/\.md$/, '');
  const expected = stem === 'index' ? '' : stem;
  if (data.slug !== undefined) {
    if (typeof data.slug !== 'string') {
      errors.push(`${name}: "slug" must be a string ("" for the home page)`);
    } else if (data.slug !== expected) {
      errors.push(`${name}: file name does not match slug (expected slug ${JSON.stringify(expected)})`);
    } else if (data.slug !== '' && !SLUG_PATTERN.test(data.slug)) {
      errors.push(`${name}: "slug" must be lowercase words separated by single hyphens (got ${JSON.stringify(data.slug)})`);
    } else if (RESERVED_SLUGS.includes(data.slug) && data.slug !== '') {
      errors.push(`${name}: "slug" ${JSON.stringify(data.slug)} is reserved for a route`);
    } else if (data.slug === 'index') {
      errors.push(`${name}: the home page is pages/index.md with slug "" — not a page called "index"`);
    }
  }

  if (data.order !== undefined && (typeof data.order !== 'number' || !Number.isFinite(data.order))) {
    errors.push(`${name}: "order" must be a number`);
  }

  if (data.nav !== undefined && !isNonEmptyString(data.nav)) {
    errors.push(`${name}: "nav" must be a non-empty string when present`);
  }

  const fallback = defaultPageLayout(theme);
  let layout = fallback;
  if (data.layout !== undefined) {
    if (!isNonEmptyString(data.layout)) {
      errors.push(`${name}: "layout" must be a non-empty string when present`);
    } else if (!info.pageLayouts.includes(data.layout)) {
      errors.push(
        `${name}: layout ${JSON.stringify(data.layout)} is not provided by theme "${theme}" ` +
        `(available: ${info.pageLayouts.length ? info.pageLayouts.join(', ') : 'none — this theme has no page layouts'})`
      );
    } else {
      layout = data.layout;
    }
  } else if (fallback === null) {
    errors.push(`${name}: theme "${theme}" has no page layouts, so this content repo cannot hold pages`);
  }

  for (const key of Object.keys(data)) {
    const base = ['title', 'slug', 'description', 'order', 'nav', 'layout', 'status'];
    if (base.includes(key)) continue;
    if (layout === 'home' && HOME_KEYS.includes(key)) continue;
    warnings.push(`${name}: unknown frontmatter field "${key}" is ignored`);
  }

  const page = errors.length ? null : {
    file: name,
    title: data.title,
    slug: data.slug,
    description: data.description,
    order: data.order ?? 100,
    nav: data.nav,
    layout,
    status: data.status,
    data,
  };
  return { errors, warnings, page };
}

/**
 * Validate a whole pages directory.
 *
 * @param {{ files: {name: string, raw: string}[], theme?: string }} input
 * @returns {{ ok: boolean, pages: object[], errors: {file: string, message: string}[], warnings: {file: string, message: string}[], ignored: string[] }}
 */
export function validatePages({ files, theme = 'blog' }) {
  const pages = [];
  const errors = [];
  const warnings = [];
  const ignored = [];

  for (const { name, raw } of files) {
    if (!raw.startsWith('---')) {
      // Same rule as posts: a file without frontmatter is not content.
      ignored.push(name);
      continue;
    }
    let parsed;
    try {
      parsed = matter(raw);
    } catch (error) {
      errors.push({ file: name, message: `${name}: frontmatter does not parse — ${error.message.split('\n')[0]}` });
      continue;
    }
    const data = parsed.data ?? {};
    if (Object.keys(data).length === 0) {
      errors.push({ file: name, message: `${name}: frontmatter is empty or could not be read` });
      continue;
    }

    const checked = validatePageFields(data, name, theme);
    for (const message of checked.errors) errors.push({ file: name, message });
    for (const message of checked.warnings) warnings.push({ file: name, message });
    if (!checked.page) continue;

    // A home page's sections are content too: check them here, where a bad one
    // can still block the publish, rather than letting the layout render blanks.
    if (checked.page.layout === 'home') {
      const { errors: homeErrors } = normaliseHome(data);
      if (homeErrors.length) {
        for (const message of homeErrors) errors.push({ file: name, message: `${name}: ${message}` });
        continue;
      }
    }

    const body = parsed.content ?? '';
    // A designed page must still say everything in plain text for agents.
    if (checked.page.layout !== 'page') {
      const chars = bodyText(body).length;
      const lines = bodyLines(body);
      if (chars < MIN_BODY_CHARS || lines < MIN_BODY_LINES) {
        errors.push({
          file: name,
          message: `${name}: layout "${checked.page.layout}" needs a real markdown body — ` +
            `every page is served as markdown too (found ${chars} characters on ${lines} line(s), ` +
            `need ${MIN_BODY_CHARS} on ${MIN_BODY_LINES})`,
        });
        continue;
      }
    }

    pages.push({ ...checked.page, content: body });
  }

  // Home page: at most one, and it must be index.md (enforced by the slug rule).
  const homes = pages.filter(page => page.slug === '');
  if (homes.length > 1) {
    errors.push({ file: homes[1].file, message: `${homes[1].file}: more than one home page` });
  }

  // The order field decides the order of the default nav.
  const seenOrders = new Map();
  for (const page of pages) {
    if (seenOrders.has(page.order)) {
      warnings.push({ file: page.file, message: `${page.file}: shares order ${page.order} with ${seenOrders.get(page.order)}` });
    } else {
      seenOrders.set(page.order, page.file);
    }
  }

  return { ok: errors.length === 0, pages, errors, warnings, ignored };
}

/**
 * Does this path have a page file at all? Cheap enough for every HTML request
 * (one stat), and deliberately status-blind: a draft page still answers 404,
 * which is finalised by the same path as any other 404.
 *
 * @param {string} dir content directory
 * @param {string | null} slug
 */
export function pageFileExists(dir, slug) {
  if (!slug || !SLUG_PATTERN.test(slug)) return false;
  return fs.existsSync(path.join(dir, PAGES_DIR, `${slug}.md`));
}

/** Read every `.md` file in `dir/pages`, or an empty list when it does not exist. */
export function readPagesDir(dir) {
  const pagesDir = path.join(dir, PAGES_DIR);
  let names;
  try {
    names = fs.readdirSync(pagesDir).filter(name => name.endsWith('.md')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  return names.map(name => ({ name, raw: fs.readFileSync(path.join(pagesDir, name), 'utf-8') }));
}

/**
 * The route-facing entry point: every published, valid page, in `order`.
 * Invalid pages are skipped and reported in `skipped`; this never throws for
 * bad content, and a missing pages directory is simply no pages.
 *
 * @returns {{ pages: object[], skipped: {file: string, message: string}[], warnings: object[], ignored: string[] }}
 */
export function loadPages(dir, theme = 'blog') {
  const result = validatePages({ files: readPagesDir(dir), theme });
  const failed = new Set(result.errors.map(e => e.file));
  const pages = result.pages
    .filter(page => page.status === 'published' && !failed.has(page.file))
    .sort((a, b) => (a.order - b.order) || a.title.localeCompare(b.title));

  const nav = buildNav(pages);
  return { pages, nav, skipped: result.errors, warnings: result.warnings, ignored: result.ignored };
}

/**
 * The nav a site shows when its config does not spell one out: the published
 * pages that carry a `nav` label, in `order`.
 */
export function buildNav(pages) {
  return pages
    .filter(page => typeof page.nav === 'string' && page.nav.trim() !== '')
    .map(page => ({ label: page.nav, path: pagePath(page.slug), order: page.order }))
    .sort((a, b) => a.order - b.order);
}
