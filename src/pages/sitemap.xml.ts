export const prerender = false;
import type { APIRoute } from 'astro';
import { getSite } from '../lib/site.mjs';

/**
 * Sitemap: the home page, every published page and every published post.
 *
 * Built from the same validated lists the pages use, so a page or post that
 * fails validation is skipped here too (and logged) rather than breaking the
 * document.
 */
export const GET: APIRoute = () => {
  const { config, pages, posts } = getSite();
  const base = config.origin;

  const pageUrls = pages
    // The homepage is already the first entry, with its own priority.
    .filter(page => page.slug !== '')
    .map(page => `  <url><loc>${base}/${page.slug}/</loc><changefreq>monthly</changefreq><priority>0.7</priority></url>`);

  const postUrls = posts.map(p =>
    `  <url><loc>${base}/blog/${p.slug}/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`
  );

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
${pageUrls.join('\n')}${pageUrls.length && postUrls.length ? '\n' : ''}${postUrls.join('\n')}
</urlset>`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
