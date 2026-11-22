/**
 * Per-site configuration: `site.json` in the root of the content repo.
 *
 * One site image runs more than one site. Everything that differs between them
 * — name, canonical origin, navigation, theme, which content types are on, the
 * /mdf.json and /llms.txt wording, the analytics id, the footer — lives here,
 * in the content repo, so changing it is a content PR (validated by
 * scripts/validate-content.mjs) and not an app change.
 *
 * Everything that is infrastructure — BLOG_MODE, the secret file mounts,
 * SYNC_STATUS_FILE, the content directory itself — stays in environment
 * variables and file mounts. A content repo can never point the app at another
 * host, a secret or a sync remote.
 *
 * No `site.json` at all means this file's defaults, which are exactly how
 * blog.bitcryptic.com behaves today. That is what keeps the blog a blog while
 * its content repo catches up.
 *
 * Validation is strict: unknown keys are errors, because a typo that is
 * silently ignored is a config change that silently does nothing. A bad config
 * is held back by the sync loop exactly like a bad post.
 */
import fs from 'node:fs';
import path from 'node:path';
import { THEMES, isTheme } from './themes.mjs';

export const CONFIG_FILE = 'site.json';

/**
 * Today's blog, field for field. Every value here is something the blog
 * hard-coded before this file existed; changing one changes the blog.
 */
export const DEFAULT_CONFIG = Object.freeze({
  name: 'BitCryptic Blog',
  shortName: 'BitCryptic',
  titleTemplate: '{title} — BitCryptic',
  origin: 'https://blog.bitcryptic.com',
  theme: 'blog',
  content: Object.freeze({ posts: true, pages: false }),
  nav: Object.freeze([]),
  description: 'Crypto-native AI infrastructure, DePIN compute, and self-hosted systems.',
  umami: Object.freeze({
    websiteId: 'd183ecc5-3e7d-4a80-a70a-32fc1ba800c1',
    scriptUrl: 'https://webstats.bitcryptic.com/script.js',
  }),
  footer: Object.freeze({ left: 'BitCryptic™', right: 'Sydney, NSW · Self-hosted' }),
  mdf: Object.freeze({
    name: 'BitCryptic Blog',
    contact: 'https://bitcryptic.com',
  }),
  llms: Object.freeze({
    description: 'Crypto-native AI infrastructure, DePIN compute, and self-hosted systems.',
    intro: Object.freeze([
      'Every page on this site is also available as markdown at the same URL:',
      'send `Accept: text/markdown` to it and the response is `text/markdown`,',
      'not HTML. Browsers keep getting HTML.',
    ]),
    site: Object.freeze([
      '- [Blog index]({origin}/) — every published post.',
      '- [MDF capability document]({origin}/mdf.json) — every page on this site is free.',
      '- Feed: {origin}/rss.xml',
      '- Sitemap: {origin}/sitemap.xml',
      '- Raw markdown source: https://github.com/bitcryptic-gw/bitcryptic-blog-content',
    ]),
    topics: 'DePIN, AI inference, self-hosted infrastructure, Bitcoin/crypto nodes, Docker/Unraid,\n' +
      'home networking, blockchain, x402 agentic payments, local LLMs.',
  }),
  notFound: Object.freeze({
    heading: 'Not found',
    body: 'There is no page at this address.',
    linkLabel: 'the blog index',
    linkNote: 'for the published posts.',
  }),
});

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

/**
 * A canonical origin: https, a host, no path, query, fragment or trailing slash.
 * @param {string} value
 * @returns {string | null} an error message, or null when it is fine
 */
export function originError(value) {
  if (!isNonEmptyString(value)) return '"origin" must be a non-empty string';
  let url;
  try {
    url = new URL(value);
  } catch {
    return `"origin" is not a URL (${JSON.stringify(value)})`;
  }
  if (url.protocol !== 'https:') return `"origin" must use https (got ${url.protocol})`;
  if (value.endsWith('/')) return '"origin" must not end with a slash';
  if (url.pathname !== '/' || url.search || url.hash) {
    return '"origin" must be a bare origin (no path, query or fragment)';
  }
  return null;
}

/** The one analytics host this image will talk to. */
export const ANALYTICS_HOST = 'webstats.bitcryptic.com';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An analytics script URL is deliberately narrower than a site origin: it is a
 * script we hand to every visitor's browser, so it must be HTTPS, must be the
 * self-hosted Umami host, and must carry no credentials or query string.
 */
export function analyticsScriptUrlError(value) {
  if (!isNonEmptyString(value)) return 'must be a non-empty string';
  let url;
  try {
    url = new URL(value);
  } catch {
    return `is not a URL (${JSON.stringify(value)})`;
  }
  if (url.protocol !== 'https:') return `must use https (got ${url.protocol})`;
  if (url.hostname !== ANALYTICS_HOST) {
    return `must point at ${ANALYTICS_HOST} (got ${url.hostname})`;
  }
  if (url.username || url.password) return 'must not carry credentials';
  if (url.search) return 'must not carry a query string';
  return null;
}

/** A footer link is an absolute HTTPS URL or a site-relative path. */
function footerHrefError(href) {
  if (!isNonEmptyString(href)) return 'must be a non-empty string';
  if (href.startsWith('//')) return 'must not be protocol-relative';
  if (href.startsWith('/')) return null;
  let url;
  try {
    url = new URL(href);
  } catch {
    return `is not a URL (${JSON.stringify(href)})`;
  }
  if (url.protocol !== 'https:') return `must use https (got ${url.protocol})`;
  return null;
}

const CHECKED_KEYS = new Set([
  'name', 'shortName', 'titleTemplate', 'origin', 'theme', 'content', 'nav',
  'description', 'umami', 'footer', 'mdf', 'llms', 'notFound',
]);

/**
 * Validate a parsed `site.json`.
 *
 * @param {unknown} raw
 * @returns {{ errors: string[], warnings: string[], config: object }}
 *   `config` is the defaults deep-merged with whatever validated; callers use
 *   it only when `errors` is empty.
 */
export function validateSiteConfig(raw) {
  const errors = [];
  const warnings = [];

  if (!isPlainObject(raw)) {
    return { errors: [`${CONFIG_FILE}: must be a JSON object`], warnings, config: DEFAULT_CONFIG };
  }

  for (const key of Object.keys(raw)) {
    if (!CHECKED_KEYS.has(key)) {
      errors.push(`${CONFIG_FILE}: unknown field "${key}" (known: ${[...CHECKED_KEYS].sort().join(', ')})`);
    }
  }

  if (raw.name !== undefined && !isNonEmptyString(raw.name)) {
    errors.push(`${CONFIG_FILE}: "name" must be a non-empty string`);
  }
  if (raw.shortName !== undefined && !isNonEmptyString(raw.shortName)) {
    errors.push(`${CONFIG_FILE}: "shortName" must be a non-empty string`);
  }
  if (raw.titleTemplate !== undefined) {
    if (!isNonEmptyString(raw.titleTemplate)) {
      errors.push(`${CONFIG_FILE}: "titleTemplate" must be a non-empty string`);
    } else if (!raw.titleTemplate.includes('{title}')) {
      errors.push(`${CONFIG_FILE}: "titleTemplate" must contain {title}`);
    }
  }
  if (raw.description !== undefined && !isNonEmptyString(raw.description)) {
    errors.push(`${CONFIG_FILE}: "description" must be a non-empty string`);
  }

  if (raw.origin !== undefined) {
    const message = originError(raw.origin);
    if (message) errors.push(`${CONFIG_FILE}: ${message}`);
  }

  if (raw.theme !== undefined && !isTheme(raw.theme)) {
    errors.push(`${CONFIG_FILE}: "theme" must be one of ${Object.keys(THEMES).join('|')}, got ${JSON.stringify(raw.theme)}`);
  }

  // Which content types this site serves. At least one, or the site is empty by
  // configuration and every route is a 404.
  if (raw.content !== undefined) {
    if (!isPlainObject(raw.content)) {
      errors.push(`${CONFIG_FILE}: "content" must be an object`);
    } else {
      for (const key of Object.keys(raw.content)) {
        if (key !== 'posts' && key !== 'pages') {
          errors.push(`${CONFIG_FILE}: unknown field "content.${key}" (known: posts, pages)`);
        } else if (typeof raw.content[key] !== 'boolean') {
          errors.push(`${CONFIG_FILE}: "content.${key}" must be true or false`);
        }
      }
      if (raw.content.posts === false && raw.content.pages === false) {
        errors.push(`${CONFIG_FILE}: "content" must enable at least one of posts or pages`);
      }
    }
  }

  if (raw.nav !== undefined) {
    if (!Array.isArray(raw.nav)) {
      errors.push(`${CONFIG_FILE}: "nav" must be an array`);
    } else {
      raw.nav.forEach((item, index) => {
        const where = `${CONFIG_FILE}: nav[${index}]`;
        if (!isPlainObject(item)) {
          errors.push(`${where} must be an object with label, path and order`);
          return;
        }
        for (const key of Object.keys(item)) {
          if (!['label', 'path', 'order', 'style'].includes(key)) {
            errors.push(`${where}: unknown field "${key}" (known: label, path, order, style)`);
          }
        }
        if (!isNonEmptyString(item.label)) errors.push(`${where}: "label" must be a non-empty string`);
        if (!isNonEmptyString(item.path)) {
          errors.push(`${where}: "path" must be a non-empty string`);
        } else if (!/^(\/|#|https:\/\/)/.test(item.path)) {
          errors.push(`${where}: "path" must start with "/", "#" or "https://" (got ${JSON.stringify(item.path)})`);
        }
        if (item.order !== undefined && !Number.isFinite(item.order)) {
          errors.push(`${where}: "order" must be a number`);
        }
        if (item.style !== undefined && !['plain', 'button'].includes(item.style)) {
          errors.push(`${where}: "style" must be plain or button, got ${JSON.stringify(item.style)}`);
        }
      });
    }
  }

  if (raw.umami !== undefined && raw.umami !== null) {
    if (!isPlainObject(raw.umami)) {
      errors.push(`${CONFIG_FILE}: "umami" must be an object or null (null turns analytics off)`);
    } else {
      for (const key of Object.keys(raw.umami)) {
        if (key !== 'websiteId' && key !== 'scriptUrl') {
          errors.push(`${CONFIG_FILE}: unknown field "umami.${key}" (known: websiteId, scriptUrl)`);
        }
      }
      if (!isNonEmptyString(raw.umami.websiteId)) {
        errors.push(`${CONFIG_FILE}: "umami.websiteId" must be a non-empty string (or set "umami": null)`);
      } else if (!UUID_PATTERN.test(raw.umami.websiteId)) {
        errors.push(`${CONFIG_FILE}: "umami.websiteId" must be a UUID (got ${JSON.stringify(raw.umami.websiteId)})`);
      }
      if (raw.umami.scriptUrl !== undefined) {
        const message = analyticsScriptUrlError(raw.umami.scriptUrl);
        if (message) errors.push(`${CONFIG_FILE}: "umami.scriptUrl" ${message}`);
      }
    }
  }

  if (raw.footer !== undefined) {
    if (!isPlainObject(raw.footer)) {
      errors.push(`${CONFIG_FILE}: "footer" must be an object with left and right`);
    } else {
      for (const key of Object.keys(raw.footer)) {
        if (key !== 'left' && key !== 'right' && key !== 'markdown') {
          errors.push(`${CONFIG_FILE}: unknown field "footer.${key}" (known: left, right, markdown)`);
        }
      }
      for (const key of ['left', 'right']) {
        if (raw.footer[key] === undefined) continue;
        const label = `${CONFIG_FILE}: "footer.${key}"`;
        const entry = raw.footer[key];
        if (typeof entry === 'string') {
          if (!isNonEmptyString(entry)) errors.push(`${label} must be a non-empty string`);
          continue;
        }
        if (!Array.isArray(entry)) {
          errors.push(`${label} must be a string or a list of segments`);
          continue;
        }
        if (entry.length === 0) {
          errors.push(`${label} must not be an empty list`);
          continue;
        }
        entry.forEach((segment, index) => {
          const at = `${label}[${index}]`;
          if (typeof segment === 'string') {
            if (!isNonEmptyString(segment)) errors.push(`${at} must be a non-empty string`);
            return;
          }
          if (!isPlainObject(segment)) {
            errors.push(`${at} must be a string or {text, href}`);
            return;
          }
          for (const field of Object.keys(segment)) {
            if (field !== 'text' && field !== 'href') {
              errors.push(`${at}: unknown field "${field}" (known: text, href)`);
            }
          }
          if (!isNonEmptyString(segment.text)) errors.push(`${at}.text must be a non-empty string`);
          const hrefMessage = footerHrefError(segment.href);
          if (hrefMessage) errors.push(`${at}.href ${hrefMessage}`);
        });
      }
      if (raw.footer.markdown !== undefined && typeof raw.footer.markdown !== 'boolean') {
        errors.push(`${CONFIG_FILE}: "footer.markdown" must be true or false`);
      }
    }
  }

  if (raw.mdf !== undefined) {
    if (!isPlainObject(raw.mdf)) {
      errors.push(`${CONFIG_FILE}: "mdf" must be an object`);
    } else {
      for (const key of Object.keys(raw.mdf)) {
        if (key !== 'name' && key !== 'contact') {
          // In particular `pricing`: this image serves free-only MDF 0.3.1 by
          // design, so a price cannot be configured into it.
          errors.push(`${CONFIG_FILE}: unknown field "mdf.${key}" (known: name, contact — pricing is fixed at free-only)`);
        }
      }
      if (raw.mdf.name !== undefined && !isNonEmptyString(raw.mdf.name)) {
        errors.push(`${CONFIG_FILE}: "mdf.name" must be a non-empty string`);
      }
      if (raw.mdf.contact !== undefined && !isNonEmptyString(raw.mdf.contact)) {
        errors.push(`${CONFIG_FILE}: "mdf.contact" must be a non-empty string`);
      }
    }
  }

  if (raw.llms !== undefined) {
    if (!isPlainObject(raw.llms)) {
      errors.push(`${CONFIG_FILE}: "llms" must be an object`);
    } else {
      const known = ['description', 'intro', 'site', 'topics'];
      for (const key of Object.keys(raw.llms)) {
        if (!known.includes(key)) {
          errors.push(`${CONFIG_FILE}: unknown field "llms.${key}" (known: ${known.join(', ')})`);
        }
      }
      if (raw.llms.description !== undefined && !isNonEmptyString(raw.llms.description)) {
        errors.push(`${CONFIG_FILE}: "llms.description" must be a non-empty string`);
      }
      if (raw.llms.topics !== undefined && !isNonEmptyString(raw.llms.topics)) {
        errors.push(`${CONFIG_FILE}: "llms.topics" must be a non-empty string`);
      }
      for (const key of ['intro', 'site']) {
        const value = raw.llms[key];
        if (value === undefined) continue;
        if (!Array.isArray(value) || value.some(line => typeof line !== 'string')) {
          errors.push(`${CONFIG_FILE}: "llms.${key}" must be an array of strings`);
        }
      }
    }
  }

  if (raw.notFound !== undefined) {
    if (!isPlainObject(raw.notFound)) {
      errors.push(`${CONFIG_FILE}: "notFound" must be an object`);
    } else {
      const known = ['heading', 'body', 'linkLabel', 'linkNote'];
      for (const key of Object.keys(raw.notFound)) {
        if (!known.includes(key)) {
          errors.push(`${CONFIG_FILE}: unknown field "notFound.${key}" (known: ${known.join(', ')})`);
        } else if (!isNonEmptyString(raw.notFound[key])) {
          errors.push(`${CONFIG_FILE}: "notFound.${key}" must be a non-empty string`);
        }
      }
    }
  }

  return { errors, warnings, config: errors.length ? DEFAULT_CONFIG : mergeConfig(raw) };
}

/** Deep merge the validated file over the defaults. Only checked keys arrive. */
export function mergeConfig(raw) {
  const merged = {
    ...DEFAULT_CONFIG,
    content: { ...DEFAULT_CONFIG.content },
    umami: DEFAULT_CONFIG.umami && { ...DEFAULT_CONFIG.umami },
    footer: { ...DEFAULT_CONFIG.footer },
    mdf: { ...DEFAULT_CONFIG.mdf },
    llms: { ...DEFAULT_CONFIG.llms },
    notFound: { ...DEFAULT_CONFIG.notFound },
    nav: [],
  };

  for (const key of ['name', 'shortName', 'titleTemplate', 'origin', 'theme', 'description']) {
    if (raw[key] !== undefined) merged[key] = raw[key];
  }
  if (raw.content !== undefined) merged.content = { ...merged.content, ...raw.content };
  if (raw.umami !== undefined) merged.umami = raw.umami === null ? null : { ...merged.umami, ...raw.umami };
  if (raw.footer !== undefined) merged.footer = { ...merged.footer, ...raw.footer };
  if (raw.mdf !== undefined) merged.mdf = { ...merged.mdf, ...raw.mdf };
  if (raw.llms !== undefined) merged.llms = { ...merged.llms, ...raw.llms };
  if (raw.notFound !== undefined) merged.notFound = { ...merged.notFound, ...raw.notFound };
  if (raw.nav !== undefined) merged.nav = raw.nav.map(item => ({ order: 100, ...item }));

  return merged;
}

/** Nav in display order, whatever order it was written in. */
export function orderedNav(config) {
  return [...config.nav]
    .map((item, index) => ({ item, index }))
    .sort((a, b) => (a.item.order - b.item.order) || (a.index - b.index))
    .map(({ item }) => item);
}

/**
 * Read and validate the content repo's `site.json`.
 *
 * A missing file is not an error: that is the blog before its content repo has
 * one, and the defaults are exactly what it already serves. An unreadable or
 * invalid file is reported to the caller, which decides: the sync loop refuses
 * to publish it, and a running server falls back to the defaults and says so
 * rather than going dark.
 *
 * @param {string} dir content directory
 * @returns {{ config: object, fromFile: boolean, errors: string[], warnings: string[] }}
 */
export function loadSiteConfig(dir) {
  if (!dir) return { config: DEFAULT_CONFIG, fromFile: false, errors: [], warnings: [] };
  const file = path.join(dir, CONFIG_FILE);
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (error) {
    if (error.code === 'ENOENT') {
      return { config: DEFAULT_CONFIG, fromFile: false, errors: [], warnings: [] };
    }
    return {
      config: DEFAULT_CONFIG,
      fromFile: false,
      errors: [`${CONFIG_FILE}: cannot be read (${error.message})`],
      warnings: [],
    };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      config: DEFAULT_CONFIG,
      fromFile: false,
      errors: [`${CONFIG_FILE}: is not valid JSON (${error.message.split('\n')[0]})`],
      warnings: [],
    };
  }

  const result = validateSiteConfig(parsed);
  return { config: result.config, fromFile: true, errors: result.errors, warnings: result.warnings };
}

/** The document title: the site's template applied to a page's own title. */
export function pageTitle(config, titleText) {
  return config.titleTemplate
    .replace(/\{title\}/g, titleText ?? '')
    .replace(/\{name\}/g, config.name);
}
