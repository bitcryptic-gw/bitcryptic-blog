/**
 * Footer entries and the opt-in markdown footer.
 *
 * The footer's HTML is rendered by the themes; what is testable here is the
 * normalisation and the markdown block, including the property that matters for
 * the blog: no `footer.markdown` means no bytes added to any markdown response.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { footerEntryMarkdown, footerMarkdown, footerSegments } from '../src/lib/footer.js';
import { mergeConfig, DEFAULT_CONFIG } from '../src/lib/site-config.mjs';

test('a string entry is a single text segment', () => {
  assert.deepEqual(footerSegments('Open source'), ['Open source']);
});

test('a segment list keeps strings and links in order', () => {
  const entry = [
    'Content ',
    { text: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
    ' · ',
    { text: 'BitCryptic™', href: 'https://bitcryptic.com' },
    ' and ',
    { text: 'Slepner', href: 'https://slepner.com.au' },
  ];
  assert.deepEqual(footerSegments(entry), entry);

  assert.equal(
    footerEntryMarkdown(entry),
    'Content [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [BitCryptic™](https://bitcryptic.com) and [Slepner](https://slepner.com.au)'
  );
});

test('markdown footer is empty unless the site opts in', () => {
  assert.equal(footerMarkdown(DEFAULT_CONFIG), '');
  assert.equal(footerMarkdown({ footer: { ...DEFAULT_CONFIG.footer, markdown: false } }), '');
  assert.equal(footerMarkdown(null), '');
});

test('markdown footer renders both entries under a rule', () => {
  const config = mergeConfig({
    footer: {
      left: 'Open source · MDF 0.3.1',
      right: [
        'Content ',
        { text: 'CC BY 4.0', href: 'https://creativecommons.org/licenses/by/4.0/' },
        ' · ',
        { text: 'BitCryptic™', href: 'https://bitcryptic.com' },
      ],
      markdown: true,
    },
  });
  assert.equal(
    footerMarkdown(config),
    '\n---\n\nOpen source · MDF 0.3.1\nContent [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) · [BitCryptic™](https://bitcryptic.com)\n'
  );
});
