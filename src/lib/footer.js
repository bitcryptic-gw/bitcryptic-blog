/**
 * Site footer entries.
 *
 * A footer entry is either a plain string, or a list of segments where each
 * segment is a string or a `{ text, href }` link. The list form exists because
 * a licence line is several links in one sentence ("Content CC BY 4.0 ·
 * BitCryptic and Slepner"); a single link object cannot express that.
 *
 * The footer is rendered in HTML on every page. It is rendered into markdown
 * only when `site.json` sets `footer.markdown: true`: the blog's markdown is
 * byte-frozen, so the default has to stay out of it.
 */

/** Normalise an entry to `string | { text, href }` segments. */
export function footerSegments(entry) {
  if (typeof entry === 'string') return [entry];
  if (!Array.isArray(entry)) return [];
  return entry.map(segment =>
    typeof segment === 'string' ? segment : { text: segment.text, href: segment.href }
  );
}

/** One footer entry as markdown text, links in link syntax. */
export function footerEntryMarkdown(entry) {
  return footerSegments(entry)
    .map(segment => (typeof segment === 'string' ? segment : `[${segment.text}](${segment.href})`))
    .join('');
}

/**
 * The footer as a markdown block for the end of a document, or '' when the
 * site has not opted in. "---" keeps it visually separate from the body, the
 * same way the designed page draws a rule above its footer.
 */
export function footerMarkdown(config) {
  if (!config || !config.footer || config.footer.markdown !== true) return '';
  const lines = [footerEntryMarkdown(config.footer.left), footerEntryMarkdown(config.footer.right)]
    .map(line => line.trim())
    .filter(line => line !== '');
  if (lines.length === 0) return '';
  return `\n---\n\n${lines.join('\n')}\n`;
}
