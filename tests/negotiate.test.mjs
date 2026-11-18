import assert from 'node:assert/strict';
import test from 'node:test';
import { negotiate, parseAccept, qualityFor } from '../src/lib/negotiate.js';

/**
 * The whole negotiation rule in one table.
 *
 * The two anchors are the Cloudflare/agent case (markdown, and the shape Claude
 * Code and OpenCode send) and an ordinary browser Accept header (HTML).
 */
const CASES = [
  {
    name: 'Cloudflare agent example: markdown and html listed together',
    accept: 'text/markdown, text/html',
    expected: 'markdown',
  },
  {
    name: 'agent with markdown preferred by weight',
    accept: 'text/markdown, text/html;q=0.9',
    expected: 'markdown',
  },
  {
    name: 'text/markdown only',
    accept: 'text/markdown',
    expected: 'markdown',
  },
  {
    name: 'normal browser Accept header',
    accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    expected: 'html',
  },
  {
    name: 'wildcard only',
    accept: '*/*',
    expected: 'html',
  },
  {
    name: 'type wildcard only',
    accept: 'text/*',
    expected: 'html',
  },
  {
    name: 'missing header',
    accept: undefined,
    expected: 'html',
  },
  {
    name: 'empty header',
    accept: '',
    expected: 'html',
  },
  {
    name: 'q-value tie between markdown and html',
    accept: 'text/markdown;q=0.5, text/html;q=0.5',
    expected: 'markdown',
  },
  {
    name: 'q-value inversion: html preferred',
    accept: 'text/markdown;q=0.4, text/html;q=0.9',
    expected: 'html',
  },
  {
    name: 'q-value inversion: markdown preferred',
    accept: 'text/markdown;q=0.9, text/html;q=0.4',
    expected: 'markdown',
  },
  {
    name: 'markdown explicitly refused',
    accept: 'text/markdown;q=0, text/html',
    expected: 'html',
  },
  {
    name: 'markdown refused even with html refused too',
    accept: 'text/markdown;q=0',
    expected: 'html',
  },
  {
    name: 'html refused, markdown accepted',
    accept: 'text/markdown, text/html;q=0',
    expected: 'markdown',
  },
  {
    name: 'markdown listed alongside a wildcard',
    accept: 'text/markdown, */*',
    expected: 'markdown',
  },
  {
    name: 'wildcard outranks an explicit markdown',
    accept: 'text/markdown;q=0.3, */*;q=0.9',
    expected: 'html',
  },
  {
    name: 'type wildcard gives html a higher weight',
    accept: 'text/markdown;q=0.7, text/*;q=0.8',
    expected: 'html',
  },
  {
    name: 'media type is case-insensitive',
    accept: 'TEXT/Markdown, text/html;q=0.9',
    expected: 'markdown',
  },
  {
    name: 'markdown named via a parameterised range',
    accept: 'text/markdown; charset=utf-8, text/html;q=0.8',
    expected: 'markdown',
  },
  {
    name: 'unparseable q falls back to the default weight',
    accept: 'text/markdown;q=abc, text/html;q=0.9',
    expected: 'markdown',
  },
  {
    name: 'junk entries are ignored',
    accept: 'garbage, text/markdown;q=0.5',
    expected: 'markdown',
  },
];

for (const { name, accept, expected } of CASES) {
  test(`negotiate: ${name}`, () => {
    assert.equal(negotiate(accept), expected);
  });
}

test('parseAccept keeps order, lowercases types and reads q', () => {
  assert.deepEqual(parseAccept('Text/Markdown;q=0.4, */*;q=0.1'), [
    { type: 'text', subtype: 'markdown', q: 0.4 },
    { type: '*', subtype: '*', q: 0.1 },
  ]);
});

test('parseAccept drops entries with no usable type', () => {
  assert.deepEqual(parseAccept('/html, text, text/, ,,text/html'), [
    { type: 'text', subtype: 'html', q: 1 },
  ]);
});

test('qualityFor prefers an exact match over a wildcard', () => {
  const ranges = parseAccept('text/html;q=0.2, text/*;q=0.9, */*;q=1');
  assert.equal(qualityFor(ranges, 'text', 'html'), 0.2);
  assert.equal(qualityFor(ranges, 'text', 'markdown'), 0.9);
  assert.equal(qualityFor(ranges, 'application', 'json'), 1);
});

test('qualityFor is 0 when nothing matches', () => {
  assert.equal(qualityFor(parseAccept('text/html'), 'text', 'markdown'), 0);
});
