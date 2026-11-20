export const prerender = false;
import type { APIRoute } from 'astro';
import { getSite } from '../lib/site.mjs';

/**
 * `/mdf.json` — the MDF 0.3.1 capability document.
 *
 * Every site this image serves is free-only: the default price entry carries an
 * empty `rails` list, which the spec defines as open access. No section is
 * priced, there is no auth endpoint, and no payment rail is offered. This is not
 * configurable — `site.json` rejects a `pricing` field — so a content change
 * cannot quietly turn a free site into a paid one.
 *
 * `name`, `contact` and the origin come from the site config; the defaults are
 * the blog's.
 */
export const GET: APIRoute = () => {
  const { config } = getSite();
  const origin = config.origin;

  const doc = {
    mdf_version: '0.3.1',
    site: origin,
    name: config.mdf.name,
    pricing: {
      default: { rails: [] },
    },
    content_signals: {
      ai_train: false,
      ai_input: true,
      search: true,
      human_only: false,
    },
    formats: {
      dialect: 'gfm',
      frontmatter: true,
      math: false,
    },
    feed: {
      url: `${origin}/rss.xml`,
      format: 'rss2',
    },
    llms_txt: `${origin}/llms.txt`,
    contact: config.mdf.contact,
  };

  return new Response(`${JSON.stringify(doc, null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-MDF-Version': '1',
    },
  });
};
