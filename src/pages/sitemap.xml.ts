export const prerender = false;
import type { APIRoute } from 'astro';
import { loadPosts } from '../../scripts/validate-content.mjs';

/**
 * Sitemap. Built from the same validated post list the pages use, so a post
 * that fails validation is skipped here too (and logged) rather than breaking
 * the document.
 */
export const GET: APIRoute = () => {
  const base = 'https://blog.bitcryptic.com';
  const contentDir = process.env.CONTENT_DIR ?? '/app/src/content/blog';

  let postUrls: string[] = [];

  try {
    const { posts, skipped } = loadPosts(contentDir);
    for (const { file, message } of skipped) console.warn(`[content] skipping ${file}: ${message}`);
    postUrls = posts.map(p =>
      `  <url><loc>${base}/blog/${p.slug}/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`
    );
  } catch {
    // content dir not mounted yet — sitemap will only contain the homepage
  }

  const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>${base}/</loc><changefreq>weekly</changefreq><priority>1.0</priority></url>
${postUrls.join('\n')}
</urlset>`;

  return new Response(body, {
    headers: {
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    },
  });
};
