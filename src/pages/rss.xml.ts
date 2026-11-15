export const prerender = false;
import rss from '@astrojs/rss';
import fs from 'node:fs';
import path from 'node:path';
import matter from 'gray-matter';
import type { APIContext } from 'astro';

/**
 * Runtime RSS route.
 *
 * The content directory is mounted into the running container at deploy time
 * (see POST /api/deploy), so it is empty when the image is built. This route
 * reads it from disk per request, the same way sitemap.xml.ts does, instead of
 * going through the build-time content collection — which is why the feed used
 * to come out empty.
 */

const contentDir = '/app/src/content/blog';

interface FeedPost {
  title: string;
  description: string;
  date: Date;
  slug: string;
  tags: string[];
}

export async function GET(context: APIContext) {
  let files: string[] = [];
  try {
    files = fs.readdirSync(contentDir).filter(f => f.endsWith('.md'));
  } catch {
    // content dir not mounted yet — feed will carry no items, like the sitemap
  }

  const posts: FeedPost[] = [];

  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(contentDir, file), 'utf-8');
      const { data } = matter(raw);

      if (data.status !== 'published' || !data.slug || !data.title) continue;

      const date = new Date(data.date);
      if (Number.isNaN(date.valueOf())) throw new Error('unparseable date');

      posts.push({
        title: data.title,
        description: data.description ?? '',
        date,
        slug: data.slug,
        tags: Array.isArray(data.tags) ? data.tags : [],
      });
    } catch (err) {
      // One malformed post must not take the whole feed down.
      console.error(`[rss] skipping ${file}: ${(err as Error).message}`);
    }
  }

  posts.sort((a, b) => b.date.valueOf() - a.date.valueOf());

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
