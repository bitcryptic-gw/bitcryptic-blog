export const prerender = false;
import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { loadPosts } from '../../scripts/validate-content.mjs';

/**
 * Runtime RSS route.
 *
 * The content directory is mounted into the running container at deploy time
 * (and is gitignored), so the build-time content collection is always empty in
 * the image. This reads the directory from disk per request — and, like every
 * other route, skips (and logs) any post that fails validation instead of
 * failing the whole feed.
 */
export async function GET(context: APIContext) {
  const contentDir = process.env.CONTENT_DIR ?? '/app/src/content/blog';

  let posts = [];
  try {
    const loaded = loadPosts(contentDir);
    posts = loaded.posts;
    for (const { file, message } of loaded.skipped) console.warn(`[content] skipping ${file}: ${message}`);
  } catch {
    // content dir not mounted yet — feed will carry no items, like the sitemap
  }

  return rss({
    title: 'BitCryptic Blog',
    description: 'Crypto-native AI infrastructure, DePIN compute, and self-hosted systems.',
    site: context.site!,
    items: posts.map(post => ({
      title: post.title,
      pubDate: post.date,
      description: post.description,
      link: `/blog/${post.slug}/`,
      categories: post.tags,
    })),
    customData: '<language>en-AU</language>',
  });
}
