/**
 * The home layout's data handling: copy and links come from the page's
 * frontmatter, so this module is where "a missing section is skipped" and "a
 * malformed one is an error" are decided — before anything is rendered.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import { HOME_KEYS, normaliseHome } from '../src/lib/home-data.mjs';

const hero = { headline: 'Agents read the web.', actions: [{ label: 'Go', href: '#race' }] };

test('the smallest usable home page is a hero with an action', () => {
  const { home, errors } = normaliseHome({ hero });
  assert.deepEqual(errors, []);
  assert.equal(home.hero.headline, 'Agents read the web.');
  assert.deepEqual(home.hero.actions, [{ label: 'Go', href: '#race', style: 'secondary' }]);
  assert.equal(home.sections.compare, null);
});

test('a missing hero is an error', () => {
  const { errors } = normaliseHome({});
  assert.ok(errors.some(message => /needs a "hero"/.test(message)), errors.join('\n'));
});

test('a hero without an action is an error, and styles are checked', () => {
  assert.ok(normaliseHome({ hero: { headline: 'x', actions: [] } }).errors.some(m => /at least one action/.test(m)));
  const bad = normaliseHome({ hero: { headline: 'x', actions: [{ label: 'a', href: '/', style: 'loud' }] } });
  assert.ok(bad.errors.some(m => /style must be one of primary\|secondary/.test(m)), bad.errors.join('\n'));
});

test('sections normalise, defaults filled, unknown tone/art refused', () => {
  const { home, errors } = normaliseHome({
    hero,
    compare: {
      heading: 'Two trips',
      credit: 'Cloudflare measured this.',
      items: [
        { label: 'Without', body: 'All of it.', tokens: 16180 },
        { label: 'With', body: 'Just words.', tone: 'blue', art: 'tidy', tokens: '3,150' },
      ],
    },
    steps: { heading: 'Three steps', items: [{ title: 'One', body: 'Ask.' }] },
  });
  assert.deepEqual(errors, []);
  assert.equal(home.sections.compare.items[0].tone, 'orange');
  assert.equal(home.sections.compare.items[0].art, 'messy');
  assert.equal(home.sections.compare.items[0].tokens, '16180');
  assert.equal(home.sections.compare.credit, 'Cloudflare measured this.');
  assert.equal(home.sections.steps.items.length, 1);

  const bad = normaliseHome({ hero, compare: { heading: 'x', items: [{ label: 'a', tone: 'green', art: 'photo' }] } });
  assert.ok(bad.errors.some(m => /tone must be one of/.test(m)), bad.errors.join('\n'));
  assert.ok(bad.errors.some(m => /art must be one of/.test(m)), bad.errors.join('\n'));
});

test('faq reads q and a, and says so when the answer is missing', () => {
  const ok = normaliseHome({ hero, faq: { heading: 'Fair questions', items: [{ q: 'Why?', a: 'Because.' }] } });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.home.sections.faq.items, [{ q: 'Why?', a: 'Because.' }]);

  const bad = normaliseHome({ hero, faq: { heading: 'Fair questions', items: [{ q: 'Why?' }] } });
  assert.ok(bad.errors.some(m => /\.a must be a non-empty string/.test(m)), bad.errors.join('\n'));
});

test('running-today placeholders are explicit, not typos', () => {
  const { home, errors } = normaliseHome({
    hero,
    running: {
      heading: 'Running today',
      items: [
        { title: 'demo.example', body: 'The demo.', href: 'https://demo.example' },
        { title: '[First adopter]', body: '[Placeholder]', placeholder: true },
      ],
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(home.sections.running.items[0].placeholder, false);
  assert.equal(home.sections.running.items[1].placeholder, true);

  const bad = normaliseHome({ hero, running: { heading: 'x', items: [{ title: 'a', placeholder: 'yes' }] } });
  assert.ok(bad.errors.some(m => /must be true or false/.test(m)), bad.errors.join('\n'));
});

test('unknown fields are errors, not silent drops', () => {
  const { errors } = normaliseHome({ hero, sectons: {} });
  assert.ok(errors.some(m => /unknown frontmatter field "sectons"/.test(m)), errors.join('\n'));

  const inner = normaliseHome({ hero: { ...hero, subtitle: 'x' } });
  assert.ok(inner.errors.some(m => /home\.hero: unknown field "subtitle"/.test(m)), inner.errors.join('\n'));
});

test('every section the layout knows is in HOME_KEYS', () => {
  assert.deepEqual(HOME_KEYS, ['hero', 'unchanged', 'compare', 'steps', 'running', 'faq', 'paths']);
});

test('paths cards carry a link and a tone', () => {
  const { home, errors } = normaliseHome({
    hero,
    paths: {
      heading: 'Where do you come in?',
      items: [
        { title: 'I run a website', body: 'Install it.', linkLabel: 'Get the plugin', href: '/plugin/', tone: 'blue' },
        { title: 'I build agents', body: 'Send a header.' },
      ],
    },
  });
  assert.deepEqual(errors, []);
  assert.equal(home.sections.paths.items[0].tone, 'blue');
  assert.equal(home.sections.paths.items[0].linkLabel, 'Get the plugin');
  assert.equal(home.sections.paths.items[1].tone, 'plain');
  assert.equal(home.sections.paths.items[1].linkLabel, null);
});
