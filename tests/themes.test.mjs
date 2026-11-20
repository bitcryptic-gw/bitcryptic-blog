/**
 * Themes: what is bundled, what each one promises, and the two accessibility
 * properties the design has to hold — text contrast and motion.
 *
 * The contrast numbers are computed here rather than eyeballed, so a future
 * palette change that drops navy-on-orange below 4.5:1 fails a test instead of
 * shipping.
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { THEMES, THEME_NAMES, defaultPageLayout, isTheme, themeInfo } from '../src/lib/themes.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('the bundled themes are the blog and markdownfirst', () => {
  assert.deepEqual(THEME_NAMES, ['blog', 'markdownfirst']);
  assert.equal(isTheme('blog'), true);
  assert.equal(isTheme('markdownfirst'), true);
  assert.equal(isTheme('wordpress'), false);
  assert.equal(themeInfo('nope').name, 'blog');
});

test('the blog theme is the default and has no page layouts', () => {
  assert.deepEqual(themeInfo('blog').pageLayouts, []);
  assert.equal(defaultPageLayout('blog'), null);
});

test('markdownfirst provides the plain page layout and the home layout', () => {
  assert.deepEqual(themeInfo('markdownfirst').pageLayouts, ['page', 'home']);
  assert.equal(defaultPageLayout('markdownfirst'), 'page');
});

test('each theme ships the components it claims', () => {
  for (const name of THEME_NAMES) {
    const dir = path.join(ROOT, 'src/themes', name);
    assert.ok(fs.existsSync(path.join(dir, 'Base.astro')), `${name}: Base.astro`);
    assert.ok(fs.existsSync(path.join(dir, 'Post.astro')), `${name}: Post.astro`);
    assert.ok(fs.existsSync(path.join(dir, 'NotFound.astro')), `${name}: NotFound.astro`);
    if (name === 'blog') {
      assert.ok(fs.existsSync(path.join(dir, 'Index.astro')), 'blog: Index.astro');
    }
    for (const layout of THEMES[name].pageLayouts) {
      const file = layout === 'page' ? 'Page.astro' : 'Home.astro';
      assert.ok(fs.existsSync(path.join(dir, file)), `${name}: ${file} for the ${layout} layout`);
    }
  }
});

test('markdownfirst loads no font or stylesheet from a third-party CDN', () => {
  const dir = path.join(ROOT, 'src/themes/markdownfirst');
  const css = fs.readFileSync(path.join(dir, 'theme.css'), 'utf-8');
  assert.ok(!/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(css), 'no Google Fonts in the theme stylesheet');
  assert.ok(!/@import\s+url\(['"]?https?:/.test(css), 'no remote stylesheet import');

  // The faces are files in the image, with their licences next to them.
  const fonts = fs.readdirSync(path.join(dir, 'fonts'));
  for (const file of ['gaegu-latin-400-normal.woff2', 'gaegu-latin-700-normal.woff2',
    'nunito-latin-400-normal.woff2', 'nunito-latin-600-normal.woff2', 'nunito-latin-800-normal.woff2',
    'OFL-Gaegu.txt', 'OFL-Nunito.txt']) {
    assert.ok(fonts.includes(file), `fonts/${file}`);
  }
  for (const match of css.matchAll(/url\('(\.\/fonts\/[^']+)'\)/g)) {
    assert.ok(fs.existsSync(path.join(dir, match[1])), `${match[1]} exists`);
  }
  assert.equal((css.match(/@font-face/g) ?? []).length, 5, 'five faces: two Gaegu weights, three Nunito');

  const base = fs.readFileSync(path.join(dir, 'Base.astro'), 'utf-8');
  assert.ok(!/https?:\/\/fonts\./.test(base), 'no font CDN in the shell');
});

test('prefers-reduced-motion turns the bob and drift off', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/themes/markdownfirst/theme.css'), 'utf-8');
  const block = css.match(/@media \(prefers-reduced-motion: reduce\) \{([\s\S]*?)\n\}/);
  assert.ok(block, 'a prefers-reduced-motion block exists');
  assert.match(block[1], /\.mdf-bob/);
  assert.match(block[1], /\.mdf-drift/);
  assert.match(block[1], /animation: none/);

  const art = fs.readFileSync(path.join(ROOT, 'src/themes/markdownfirst/art/Robot.astro'), 'utf-8');
  assert.match(art, /class="mdf-bob"/);
  assert.match(art, /class="mdf-drift"/);
});

// --- contrast -------------------------------------------------------------

const channel = value => {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = hex => {
  const clean = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map(i => parseInt(clean.slice(i, i + 2), 16));
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};

const contrast = (a, b) => {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
};

test('every text pair in the markdownfirst palette passes 4.5:1', () => {
  const palette = {
    bg: '#fbfbf6',
    ink: '#10162f',
    blue: '#2d3bd6',
    orange: '#ff6a2b',
    softblue: '#7f8bff',
    chip: '#fff3b0',
    dim: '#2f3557',
    white: '#ffffff',
    yellow: '#ffe14d',
  };
  // Every ink/panel pair the design actually puts text on.
  const pairs = [
    ['ink', 'orange'],
    ['ink', 'softblue'],
    ['ink', 'bg'],
    ['ink', 'white'],
    ['ink', 'chip'],
    ['dim', 'bg'],
    ['dim', 'white'],
    ['white', 'blue'],
    ['yellow', 'ink'],
    ['blue', 'white'],
    ['blue', 'bg'],
  ];
  const failures = pairs
    .map(([fg, bg]) => ({ pair: `${fg} on ${bg}`, ratio: contrast(palette[fg], palette[bg]) }))
    .filter(({ ratio }) => ratio < 4.5);
  assert.deepEqual(failures, [], failures.map(f => `${f.pair}: ${f.ratio.toFixed(2)}`).join('\n'));
});

test('interactive targets are at least 44px tall', () => {
  const css = fs.readFileSync(path.join(ROOT, 'src/themes/markdownfirst/theme.css'), 'utf-8');
  // The rules that produce buttons and nav links, plus the design's own values.
  const rules = [
    /\.mdf-button \{[^}]*min-height: 48px/,
    /\.mdf-nav-links a \{[^}]*min-height: 44px/,
    /\.mdf-brand \{[^}]*min-height: 44px/,
  ];
  for (const rule of rules) assert.match(css, rule);
});
