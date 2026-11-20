/**
 * Capture the responses the blog contract covers, for the byte-identity gate.
 *
 * Shared by tests/byte-identity.test.mjs (against the fixture content, as a
 * golden snapshot in the repo) and by the release check (against a real content
 * clone, compared with a capture taken from the previous image).
 *
 * Stylesheet references are normalised: Astro's chunk names and content hashes
 * are a build artefact, and both the brief and this gate allow them to move.
 * Nothing else may.
 */
import crypto from 'node:crypto';

export const BROWSER_ACCEPT =
  'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8';
export const AGENT_ACCEPT = 'text/markdown, text/html';

/**
 * The URLs the blog serves that must not change: the index, every post, the
 * not-found page, an unknown path, and each generated document.
 *
 * @param {string[]} postSlugs
 */
export function pathsFor(postSlugs) {
  return [
    '/',
    ...postSlugs.map(slug => `/blog/${slug}/`),
    '/404',
    '/404/',
    '/nope',
    '/nope/deeper/',
    '/blog/nope/',
    '/rss.xml',
    '/sitemap.xml',
    '/robots.txt',
    '/llms.txt',
    '/mdf.json',
  ];
}

const CSS_REF = /\/_astro\/[A-Za-z0-9_.-]+?\.[A-Za-z0-9_-]{8}\.css/g;

/** Strip stylesheet chunk names and hashes from anything served. */
export function normalise(value) {
  return typeof value === 'string' ? value.replace(CSS_REF, '/_astro/STYLESHEET.css') : value;
}

const KEEP = ['content-type', 'vary', 'x-mdf-version', 'link', 'cache-control'];

const sha = text => crypto.createHash('sha256').update(text).digest('hex');

async function one(base, pathname, accept) {
  const res = await fetch(`${base}${pathname}`, { headers: { accept } });
  const body = normalise(await res.text());
  const headers = {};
  for (const name of KEEP) headers[name] = normalise(res.headers.get(name));
  return { status: res.status, headers, sha256: sha(body), bytes: Buffer.byteLength(body) };
}

/**
 * @param {string} base e.g. `http://127.0.0.1:4500`
 * @param {string[]} postSlugs
 * @returns {Promise<Record<string, object>>}
 */
export async function capture(base, postSlugs) {
  const out = {};
  for (const pathname of pathsFor(postSlugs)) {
    out[`GET ${pathname} [html]`] = await one(base, pathname, BROWSER_ACCEPT);
    out[`GET ${pathname} [md]`] = await one(base, pathname, AGENT_ACCEPT);
  }
  return out;
}
