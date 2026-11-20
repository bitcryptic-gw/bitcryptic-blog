/**
 * Shared pieces of a page's markdown representation.
 *
 * Posts have their own module (`markdown-content.js`) because their markdown is
 * a post: frontmatter with a date, the superseded banner, corrections kept as
 * stored. Pages are simpler — no date, no banner — but they negotiate on exactly
 * the same terms, so the frontmatter shape and the link absolutising are shared.
 */
import { absolutiseLinks } from './markdown-content.js';

/** A YAML double-quoted scalar. JSON string escaping is valid YAML. */
export function yamlString(value) {
  return JSON.stringify(value);
}

/**
 * The canonical HTML URL of a page.
 * @param {string} origin e.g. `https://markdownfirst.com`
 * @param {string} slug `''` for the home page
 */
export function pageHtmlUrl(origin, slug) {
  return slug === '' ? `${origin}/` : `${origin}/${slug}/`;
}

/**
 * One page as a standalone markdown document: frontmatter, the H1, the body.
 *
 * The body is the page exactly as stored. Nothing is reworded and no section is
 * dropped: for a designed page this is the whole page in plain text, which is
 * why the validator insists a custom-layout page still has one.
 *
 * @param {{ title: string, slug: string, description: string, content: string }} page
 * @param {{ origin: string }} options
 */
export function pageMarkdown(page, { origin }) {
  const url = pageHtmlUrl(origin, page.slug);
  const body = absolutiseLinks(page.content, url).replace(/^\n+/, '').replace(/\s*$/, '\n');

  return [
    '---',
    `title: ${yamlString(page.title)}`,
    `description: ${yamlString(page.description)}`,
    `canonical: ${yamlString(url)}`,
    '---',
    '',
    `# ${page.title}`,
    '',
    body,
  ].join('\n');
}
