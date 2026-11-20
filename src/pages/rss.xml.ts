export const prerender = false;
import rss from '@astrojs/rss';
import type { APIRoute } from 'astro';
import { getSite } from '../lib/site.mjs';

/**
 * Runtime RSS route.
 *
 * Posts only: pages are not dated and are not feed items. The content directory
 * is mounted into the running container at deploy time (and is gitignored), so
 * the build-time content collection is always empty in the image; this reads the
 * directory from disk per request instead — and skips (and logs) any post that
 * fails validation rather than failing the whole feed.
 *
 * The feed's own URL comes from the site config, not from the request, so the
 * links are canonical for whichever site is being served.
 */
export const GET: APIRoute = () => {
  const { config, posts } = getSite();

  return rss({
    title: config.name,
    description: config.description,
    site: config.origin,
    items: posts.map(post => ({
      title: post.title,
      pubDate: post.date,
      description: post.description,
      link: `/blog/${post.slug}/`,
      categories: post.tags,
    })),
    customData: '<language>en-AU</language>',
  });
};
