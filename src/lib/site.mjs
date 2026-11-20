/**
 * The site this request is being served from.
 *
 * One image, several sites: everything a route needs — the config, the pages,
 * the published posts, the nav — is resolved here, from the mounted content
 * directory, on every request. That is the same shape the blog already used for
 * posts (read from disk per request, so a sync is visible immediately), just
 * widened to the config and the pages.
 *
 * Failure policy matches the post loader's: bad content is skipped and logged,
 * and the site stays up. A bad `site.json` falls back to the defaults — the
 * blog's own behaviour — because the sync loop will have refused to publish it
 * in the first place; a running server should never go dark over a file it did
 * not choose to accept.
 */
import { loadSiteConfig, orderedNav } from './site-config.mjs';
import { loadPages } from './pages.mjs';
import { loadPosts } from '../../scripts/validate-content.mjs';

export function contentDir() {
  return process.env.CONTENT_DIR ?? '/app/src/content/blog';
}

/**
 * @param {object} [options]
 * @param {string} [options.dir]
 * @param {boolean} [options.warn] log skipped/bad content (routes do; tests may not)
 */
export function getSite({ dir = contentDir(), warn = true } = {}) {
  const configResult = loadSiteConfig(dir);
  if (warn) {
    for (const message of configResult.errors) console.warn(`[site] ${message} — using the defaults`);
  }

  const { config } = configResult;

  let posts = [];
  let skippedPosts = [];
  if (config.content.posts) {
    try {
      // The content directory is a mount at runtime: it may genuinely be
      // missing or empty on a fresh container, which is not a page error.
      const loaded = loadPosts(dir);
      posts = loaded.posts;
      skippedPosts = loaded.skipped;
      if (warn) {
        for (const { file, message } of loaded.skipped) console.warn(`[content] skipping ${file}: ${message}`);
      }
    } catch (error) {
      if (warn) console.warn(`[content] no posts readable at ${dir}: ${error.message}`);
    }
  }

  let pages = [];
  let pageErrors = [];
  let derivedNav = [];
  if (config.content.pages) {
    try {
      const loaded = loadPages(dir, config.theme);
      pages = loaded.pages;
      pageErrors = loaded.skipped;
      derivedNav = loaded.nav;
      if (warn) {
        for (const { file, message } of loaded.skipped) console.warn(`[content] skipping ${file}: ${message}`);
      }
    } catch (error) {
      if (warn) console.warn(`[content] no pages readable at ${dir}: ${error.message}`);
    }
  }

  // The nav the site shows: whatever `site.json` spells out, in `order`; and,
  // when it spells out nothing, the published pages that carry a `nav` label.
  const nav = orderedNav(config).length > 0 ? orderedNav(config) : derivedNav;

  return {
    dir,
    // The resolved nav is part of the config the themes see, so a theme never
    // has to know where nav came from.
    config: { ...config, nav },
    configFromFile: configResult.fromFile,
    configErrors: configResult.errors,
    posts,
    skippedPosts,
    pages,
    pageErrors,
    nav,
  };
}

/** The home page (slug ""), or null. */
export function homePage(site) {
  return site.pages.find(page => page.slug === '') ?? null;
}

/** A published page by slug, or null. */
export function pageBySlug(site, slug) {
  return site.pages.find(page => page.slug === slug) ?? null;
}
