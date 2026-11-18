/**
 * Per-representation ETags.
 *
 * The tag is a hash of the bytes actually served, so the HTML and markdown
 * renderings of the same URL always carry different tags: an `If-None-Match`
 * carrying one representation's tag can never produce a 304 for the other.
 */
import { createHash } from 'node:crypto';

/**
 * A strong ETag derived from the response body.
 * @param {string | Uint8Array} body
 * @returns {string}
 */
export function etagFor(body) {
  const hash = createHash('sha256').update(body).digest('hex').slice(0, 32);
  return `"${hash}"`;
}

/**
 * RFC 9110 weak comparison of an `If-None-Match` header against one ETag.
 * Handles `*`, a comma-separated list, and weak (`W/`) prefixes.
 * @param {string | null | undefined} header
 * @param {string} etag
 * @returns {boolean}
 */
export function ifNoneMatchMatches(header, etag) {
  if (!header) return false;
  const normalise = v => v.trim().replace(/^W\//, '');
  const target = normalise(etag);
  for (const candidate of header.split(',')) {
    const value = candidate.trim();
    if (value === '') continue;
    if (value === '*') return true;
    if (normalise(value) === target) return true;
  }
  return false;
}
