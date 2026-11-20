/**
 * The themes bundled in this image.
 *
 * Plain data, with no Astro imports, so the content validator, the tests and
 * the CLI can all ask what a theme offers without building anything.
 *
 * A theme supplies (as .astro files in src/themes/<name>/):
 *   Base       the document shell: <html>, head, header, footer
 *   Index      the post index, for a site with posts but no home page
 *   Post       one post
 *   NotFound   the 404 body
 *   Page       the `page` layout (prose, heading, readable at phone width)
 *   Home       the `home` layout (the designed home page), optional
 *
 * `pageLayouts` is what a page's `layout:` frontmatter may name. The default
 * layout is `page`, so a theme without one cannot host pages at all.
 */
export const THEMES = Object.freeze({
  blog: Object.freeze({
    name: 'blog',
    label: 'BitCryptic blog — the original look',
    pageLayouts: Object.freeze([]),
    postLayout: true,
  }),
  markdownfirst: Object.freeze({
    name: 'markdownfirst',
    label: 'markdownfirst.com — direction E (graph paper, hand-drawn)',
    pageLayouts: Object.freeze(['page', 'home']),
    postLayout: true,
  }),
});

export const THEME_NAMES = Object.freeze(Object.keys(THEMES));

/** @param {unknown} name */
export function isTheme(name) {
  return typeof name === 'string' && Object.hasOwn(THEMES, name);
}

/** @param {string} name */
export function themeInfo(name) {
  return THEMES[name] ?? THEMES.blog;
}

/** The layout a page gets when its frontmatter does not name one. */
export function defaultPageLayout(theme) {
  return themeInfo(theme).pageLayouts.includes('page') ? 'page' : null;
}
