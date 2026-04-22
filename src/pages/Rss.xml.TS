import rss from '@astrojs/rss';
import { getCollection } from 'astro:content';
import type { APIContext } from 'astro';

export async function GET(context: APIContext) {
  const posts = await getCollection('blog', ({ data }) => data.status === 'published');
  const sorted = posts.sort((a, b) => b.data.date.valueOf() - a.data.date.valueOf());

  return rss({
    title: 'BitCryptic Blog',
    description: 'Crypto-native AI infrastructure, DePIN compute, and self-hosted systems.',
    site: context.site!,
    items: sorted.map(post => ({
      title: post.data.title,
      pubDate: post.data.date,
      description: post.data.description,
      link: `/blog/${post.data.slug}/`,
      categories: post.data.tags,
    })),
    customData: '<language>en-AU</language>',
  });
}
