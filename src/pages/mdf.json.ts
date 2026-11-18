export const prerender = false;
import type { APIRoute } from 'astro';
import { SITE_URL } from '../lib/mdf.js';

/**
 * `/mdf.json` — the MDF 0.3.1 capability document.
 *
 * The blog's content is free: the default price entry carries an empty `rails`
 * list, which the spec defines as open access. No section is priced, there is
 * no auth endpoint, and no payment rail is offered — a free-only site in the
 * spec's own terms, with nothing invented to satisfy a paid-tier shape.
 */
export const GET: APIRoute = () => {
  const doc = {
    mdf_version: '0.3.1',
    site: SITE_URL,
    name: 'BitCryptic Blog',
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
      url: `${SITE_URL}/rss.xml`,
      format: 'rss2',
    },
    llms_txt: `${SITE_URL}/llms.txt`,
    contact: 'https://bitcryptic.com',
  };

  return new Response(`${JSON.stringify(doc, null, 2)}\n`, {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-MDF-Version': '1',
    },
  });
};
