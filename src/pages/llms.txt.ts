export const prerender = false;
import type { APIRoute } from 'astro';
import { loadPosts } from '../../scripts/validate-content.mjs';
import { BLOG_DESCRIPTION, postHtmlUrl } from '../lib/markdown-content.js';
import { SITE_URL } from '../lib/mdf.js';

/**
 * Runtime `/llms.txt`: the blog and every published post with its URL.
 *
 * The markdown claim is made only because the same URLs are tested to return
 * markdown under `Accept: text/markdown` (tests/http.test.mjs). Nothing here
 * claims how agents or answer engines use the content — only what the server
 * does.
 */
export const GET: APIRoute = () => {
  const contentDir = process.env.CONTENT_DIR ?? '/app/src/content/blog';

  let posts = [];
  try {
    const loaded = loadPosts(contentDir);
    posts = loaded.posts;
    for (const { file, message } of loaded.skipped) console.warn(`[content] skipping ${file}: ${message}`);
  } catch {
    // content dir not mounted yet — the index still describes the site
  }

  const lines = [
    '# BitCryptic Blog',
    '',
    `> ${BLOG_DESCRIPTION}`,
    '',
    'Every page on this site is also available as markdown at the same URL:',
    'send `Accept: text/markdown` to it and the response is `text/markdown`,',
    'not HTML. Browsers keep getting HTML.',
    '',
    '## Posts',
    '',
  ];

  for (const post of posts) {
    const superseded = post.superseded_by ? ' (superseded)' : '';
    lines.push(`- [${post.title}](${postHtmlUrl(post.slug)}) — ${post.date.toISOString().slice(0, 10)} — ${post.description}${superseded}`);
  }

  lines.push(
    '',
    '## Site',
    '',
    `- [Blog index](${SITE_URL}/) — every published post.`,
    `- [MDF capability document](${SITE_URL}/mdf.json) — every page on this site is free.`,
    `- Feed: ${SITE_URL}/rss.xml`,
    `- Sitemap: ${SITE_URL}/sitemap.xml`,
    '- Raw markdown source: https://github.com/bitcryptic-gw/bitcryptic-blog-content',
    '',
    '## Topics',
    '',
    'DePIN, AI inference, self-hosted infrastructure, Bitcoin/crypto nodes, Docker/Unraid,',
    'home networking, blockchain, x402 agentic payments, local LLMs.',
    ''
  );

  return new Response(lines.join('\n'), {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'X-MDF-Version': '1',
    },
  });
};
