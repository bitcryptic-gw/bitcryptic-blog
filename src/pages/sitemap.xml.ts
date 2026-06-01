import type { APIRoute } from 'astro';

// Glob all .md/.mdx files under src/pages/blog/
const posts = import.meta.glob('./blog/**/*.{md,mdx}', { eager: true });

export const GET: APIRoute = () => {
  const base = 'https://blog.bitcryptic.com';

  const postUrls = Object.keys(posts).map((path) => {
    // ./blog/my-post.md -> /blog/my-post
    const slug = path
      .replace(/^\.\/blog\//, '')
      .replace(/\.(md|mdx)$/, '');
    return `  <url><loc>${base}/blog/${slug}/</loc><changefreq>monthly</changefreq><priority>0.8</priority></url>`;
  });

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
