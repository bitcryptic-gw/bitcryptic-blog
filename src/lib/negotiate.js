/**
 * Content negotiation for MDF (`Accept: text/markdown`).
 *
 * The rule, in one place, because it is the whole protocol between the blog
 * and an agent:
 *
 *   Serve markdown only when the client explicitly lists `text/markdown`
 *   with q > 0, and its q is at least the q that applies to `text/html`.
 *
 * Everything else — a browser's `text/html,application/xhtml+xml,...`,
 * `* / *`, `text/*`, a missing or empty header, markdown at q=0 — gets HTML.
 * Wildcards never opt in to markdown: only the literal type does, so a
 * general-purpose client is never surprised by it.
 *
 * @typedef {'markdown' | 'html'} Representation
 * @typedef {{ type: string, subtype: string, q: number }} MediaRange
 */

/**
 * Parse an Accept header into media ranges. Malformed entries are ignored.
 * @param {string | null | undefined} header
 * @returns {MediaRange[]}
 */
export function parseAccept(header) {
  if (!header) return [];
  const ranges = [];
  for (const raw of header.split(',')) {
    const parts = raw.trim().split(';');
    const mediaType = parts.shift()?.trim().toLowerCase();
    if (!mediaType) continue;
    const slash = mediaType.indexOf('/');
    if (slash <= 0 || slash === mediaType.length - 1) continue;
    const type = mediaType.slice(0, slash).trim();
    const subtype = mediaType.slice(slash + 1).trim();
    if (!type || !subtype) continue;

    let q = 1;
    for (const param of parts) {
      const [name, value] = param.split('=').map(s => s?.trim() ?? '');
      if (name?.toLowerCase() !== 'q') continue;
      const parsed = Number.parseFloat(value);
      // An unparseable q is treated as the default weight, not as a rejection.
      q = Number.isFinite(parsed) ? Math.min(1, Math.max(0, parsed)) : 1;
      break;
    }
    ranges.push({ type, subtype, q });
  }
  return ranges;
}

/**
 * The q that applies to a concrete media type: an exact match if the client
 * named it, otherwise the most specific wildcard, otherwise 0 (not acceptable).
 * @param {MediaRange[]} ranges
 * @param {string} type
 * @param {string} subtype
 * @returns {number}
 */
export function qualityFor(ranges, type, subtype) {
  /** @type {number | null} */ let exact = null;
  /** @type {number | null} */ let typeWildcard = null;
  /** @type {number | null} */ let anyWildcard = null;

  for (const r of ranges) {
    if (r.type === type && r.subtype === subtype) exact = Math.max(exact ?? 0, r.q);
    else if (r.type === type && r.subtype === '*') typeWildcard = Math.max(typeWildcard ?? 0, r.q);
    else if (r.type === '*' && r.subtype === '*') anyWildcard = Math.max(anyWildcard ?? 0, r.q);
  }

  if (exact !== null) return exact;
  if (typeWildcard !== null) return typeWildcard;
  if (anyWildcard !== null) return anyWildcard;
  return 0;
}

/**
 * True when `text/markdown` is named explicitly with a positive weight.
 * @param {MediaRange[]} ranges
 * @returns {boolean}
 */
export function explicitlyAcceptsMarkdown(ranges) {
  return ranges.some(r => r.type === 'text' && r.subtype === 'markdown' && r.q > 0);
}

/**
 * The decision: markdown when explicitly accepted and not outranked by HTML.
 * @param {string | null | undefined} accept
 * @returns {Representation}
 */
export function negotiate(accept) {
  const ranges = parseAccept(accept);
  if (!explicitlyAcceptsMarkdown(ranges)) return 'html';
  const markdownQ = qualityFor(ranges, 'text', 'markdown');
  const htmlQ = qualityFor(ranges, 'text', 'html');
  return markdownQ >= htmlQ ? 'markdown' : 'html';
}
