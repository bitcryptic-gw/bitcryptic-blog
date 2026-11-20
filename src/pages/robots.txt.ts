export const prerender = false;
import type { APIRoute } from 'astro';
import { getSite } from '../lib/site.mjs';

export const GET: APIRoute = () => {
  const { config } = getSite();
  const body = `User-agent: *
Allow: /
Sitemap: ${config.origin}/sitemap.xml
`;
  return new Response(body, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
    },
  });
};
