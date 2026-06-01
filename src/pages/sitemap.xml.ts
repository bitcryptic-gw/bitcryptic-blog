export const prerender = false;
import type { APIRoute } from 'astro';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';

export const GET: APIRoute = () => {
  const base = 'https://blog.bitcryptic.com';
  const contentDir = '/app/src/content/blog';

  let postUrls: string[] = [];

  try {
    const files = fs.readdirSync(contentDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      const raw = fs.readFileSync(path.join(contentDir, file), 'utf-8');
      const { data } = matter(raw);
      if (data.slug && data.status === 'published') {
        postUrls.push(
          `  <url><loc>${base}/blog/${data.slug}/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`
        );
      }
    }
  } catch {
    // content dir not mounted yet — sitemap will only contain homepage
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
