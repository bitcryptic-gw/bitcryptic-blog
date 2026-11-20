export const prerender = false;
import type { APIRoute } from 'astro';
import { getSite } from '../lib/site.mjs';
import { pageHtmlUrl } from '../lib/page-markdown.js';
import { postHtmlUrl } from '../lib/markdown-content.js';
import { isoDate } from '../lib/markdown-content.js';

/**
 * Runtime `/llms.txt`: the site, its pages and every published post with its
 * URL. The wording is per site — `llms` in `site.json` — and the defaults are
 * the blog's own.
 *
 * The markdown claim is made only because the same URLs are tested to return
 * markdown under `Accept: text/markdown` (tests/http.test.mjs). Nothing here
 * claims how agents or answer engines use the content — only what the server
 * does.
 */
export const GET: APIRoute = () => {
  const { config, pages, posts } = getSite();
  const origin = config.origin;

  const lines = [
    `# ${config.name}`,
    '',
    `> ${config.llms.description}`,
    '',
    ...config.llms.intro,
    '',
  ];

  if (pages.length > 0) {
    lines.push('## Pages', '');
    for (const page of pages) {
      lines.push(`- [${page.title}](${pageHtmlUrl(origin, page.slug)}) — ${page.description}`);
    }
    lines.push('');
  }

  if (config.content.posts) {
    lines.push('## Posts', '');
    for (const post of posts) {
      const superseded = post.superseded_by ? ' (superseded)' : '';
      lines.push(`- [${post.title}](${postHtmlUrl(post.slug, origin)}) — ${isoDate(post.date)} — ${post.description}${superseded}`);
    }
    lines.push('');
  }

  lines.push(
    '## Site',
    '',
    ...config.llms.site.map(line => line.replace(/\{origin\}/g, origin)),
    '',
    '## Topics',
    '',
    config.llms.topics,
    ''
  );

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-MDF-Version': '1',
    },
  });
};
