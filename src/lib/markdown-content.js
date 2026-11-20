/**
 * The markdown representation of a blog page.
 *
 * The body is the post as stored — corrections stay marked up as `~~old~~ new`
 * and nothing is reworded. The only edits are structural: a small frontmatter
 * block for machine readers, the `# Title` heading, the superseded banner as a
 * blockquote (matching the HTML), and site-relative link targets made fully
 * qualified so the document reads correctly outside its URL.
 *
 * @typedef {object} MarkdownPost
 * @property {string} title
 * @property {string} slug
 * @property {string} description
 * @property {Date} date
 * @property {Date} [updated]
 * @property {string} author
 * @property {string[]} tags
 * @property {string} [superseded_by]
 * @property {Date} [superseded_on]
 * @property {string} [superseded_note]
 * @property {string} content
 */
import { SITE_URL } from './mdf.js';

export const BLOG_DESCRIPTION =
  'Crypto-native AI infrastructure, DePIN compute, and self-hosted systems.';

/**
 * The canonical HTML URL of a post — also the `canonical` in its markdown.
 * @param {string} slug
 * @param {string} [origin]
 * @returns {string}
 */
export function postHtmlUrl(slug, origin = SITE_URL) {
  return `${origin}/blog/${slug}/`;
}

/**
 * `2026-11-15` — stable, unambiguous, and valid YAML.
 * @param {Date} date
 * @returns {string}
 */
export function isoDate(date) {
  return date.toISOString().slice(0, 10);
}

/** "November 2026", the phrasing the HTML banner uses. */
function monthYear(date) {
  return date.toLocaleDateString('en-AU', { year: 'numeric', month: 'long' });
}

/** A YAML double-quoted scalar. JSON string escaping is valid YAML. */
function yamlString(value) {
  return JSON.stringify(value);
}

/**
 * The superseded banner, worded identically to the HTML one so an agent and a
 * reader are told the same thing.
 * @param {MarkdownPost} post
 * @returns {string | null}
 */
export function supersededBlockquote(post, origin = SITE_URL) {
  if (!post.superseded_by) return null;
  const note = post.superseded_note ? ` ${post.superseded_note}` : '';
  const link = postHtmlUrl(post.superseded_by, origin);
  return (
    `> **Kept for the record.** This post is from ${monthYear(post.date)} and has been superseded.${note} ` +
    `See [the current state of MDF](${link}).`
  );
}

/**
 * Frontmatter fields, in the documented order.
 * @param {MarkdownPost} post
 * @returns {string[]}
 */
export function frontmatterLines(post, origin = SITE_URL) {
  const lines = [
    '---',
    `title: ${yamlString(post.title)}`,
    `date: ${isoDate(post.date)}`,
  ];
  if (post.updated) lines.push(`updated: ${isoDate(post.updated)}`);
  lines.push(`author: ${yamlString(post.author)}`);
  lines.push(`tags: [${post.tags.map(yamlString).join(', ')}]`);
  lines.push(`canonical: ${yamlString(postHtmlUrl(post.slug, origin))}`);
  if (post.superseded_by) {
    lines.push(`superseded_by: ${yamlString(postHtmlUrl(post.superseded_by, origin))}`);
    if (post.superseded_note) lines.push(`superseded_note: ${yamlString(post.superseded_note)}`);
  }
  lines.push('---');
  return lines;
}

/**
 * Rewrite site-relative link targets to fully qualified URLs, leaving fenced
 * code blocks, HTML spans, fragments and already-qualified URLs untouched.
 *
 * @param {string} body
 * @param {string} baseUrl
 * @returns {string}
 */
export function absolutiseLinks(body, baseUrl) {
  const base = new URL(baseUrl);
  /** @type {string | null} */ let fence = null;

  const rewriteTarget = target => {
    if (target === '') return target;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(target)) return target; // scheme, incl. mailto:
    if (target.startsWith('//')) return `https:${target}`;
    if (target.startsWith('#')) return target;
    try {
      return new URL(target, base).toString();
    } catch {
      return target;
    }
  };

  return body
    .split('\n')
    .map(line => {
      const fenceMatch = line.match(/^\s*(`{3,}|~{3,})/);
      if (fenceMatch) {
        const marker = fenceMatch[1][0];
        if (fence === null) fence = marker;
        else if (fence === marker) fence = null;
        return line;
      }
      if (fence !== null) return line;

      // Inline links and images: `](target "optional title")`.
      const withLinks = line.replace(/\]\(\s*([^)\s]+)([^)]*)\)/g, (match, target, rest) => {
        return `](${rewriteTarget(target)}${rest})`;
      });

      // Reference definitions: `[id]: /path "optional title"`.
      return withLinks.replace(/^(\s{0,3}\[[^\]]+\]:\s*)(\S+)(.*)$/, (match, head, target, tail) => {
        return `${head}${rewriteTarget(target)}${tail}`;
      });
    })
    .join('\n');
}

/**
 * One published post as a standalone markdown document.
 * @param {MarkdownPost} post
 * @param {string} [origin]
 * @returns {string}
 */
export function postMarkdown(post, origin = SITE_URL) {
  const htmlUrl = postHtmlUrl(post.slug, origin);
  const banner = supersededBlockquote(post, origin);
  const body = absolutiseLinks(post.content, htmlUrl).replace(/^\n+/, '').replace(/\s*$/, '\n');

  const parts = [
    frontmatterLines(post, origin).join('\n'),
    '',
    `# ${post.title}`,
    '',
  ];
  if (banner) parts.push(banner, '');
  parts.push(body);
  return parts.join('\n');
}

/**
 * The index as markdown: one line per published post, newest first.
 *
 * `site` is the resolved site config; its defaults are the blog's own wording,
 * so calling this with just the posts keeps the blog's output byte-identical.
 *
 * @param {MarkdownPost[]} posts
 * @param {{ origin?: string, description?: string, name?: string }} [site]
 * @returns {string}
 */
export function indexMarkdown(posts, site = {}) {
  const origin = site.origin ?? SITE_URL;
  const lines = [
    `# ${site.name ?? 'BitCryptic Blog'}`,
    '',
    site.description ?? BLOG_DESCRIPTION,
    '',
  ];
  for (const post of posts) {
    const superseded = post.superseded_by ? ' (superseded)' : '';
    lines.push(`- [${post.title}](${postHtmlUrl(post.slug, origin)}) — ${isoDate(post.date)} — ${post.description}${superseded}`);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The markdown half of a real 404. Same text a reader gets, said in markdown.
 * @param {{ origin?: string, notFound?: { heading: string, body: string, linkLabel: string, linkNote: string } }} [site]
 * @returns {string}
 */
export function notFoundMarkdown(site = {}) {
  const origin = site.origin ?? SITE_URL;
  const copy = site.notFound ?? DEFAULT_NOT_FOUND;
  return [
    `# ${copy.heading}`,
    '',
    copy.body,
    '',
    `See [${copy.linkLabel}](${origin}/) ${copy.linkNote}`,
    '',
  ].join('\n');
}

const DEFAULT_NOT_FOUND = {
  heading: 'Not found',
  body: 'There is no page at this address.',
  linkLabel: 'the blog index',
  linkNote: 'for the published posts.',
};

/**
 * One line per markdown response, on stdout. Deliberately narrow: time, path,
 * status and a truncated User-Agent. No IP addresses and no query strings.
 *
 * @param {string} pathname
 * @param {number} status
 * @param {string | null} userAgent
 * @param {Date} [now]
 * @returns {string}
 */
export function markdownLogLine(pathname, status, userAgent, now = new Date()) {
  const ua = (userAgent ?? '').slice(0, 200);
  return `[mdf] ${now.toISOString()} path=${pathname} status=${status} ua=${JSON.stringify(ua)}`;
}
