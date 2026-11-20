/**
 * The `home` layout's data.
 *
 * The designed home page is chrome, illustration and layout from the theme; its
 * words, links and numbers are content. They arrive in the page's frontmatter
 * and are normalised here, so that:
 *
 *   - a missing section is simply not rendered (so a draft home page can be
 *     built up a section at a time), but
 *   - a malformed one is an error the validator reports and the sync loop
 *     blocks, rather than a page that quietly renders a blank panel.
 *
 * Nothing in this module knows about HTML. Home.astro renders this shape; the
 * tests exercise this shape. Both sides of that line are easy to test.
 */

export const HERO = 'hero';
export const SECTIONS = ['unchanged', 'compare', 'steps', 'running', 'faq', 'paths'];

/** The section names a home page may carry, besides `hero`. */
export const SECTION_KEYS = [...SECTIONS];

/** Every top-level frontmatter key the home layout understands. */
export const HOME_KEYS = [HERO, ...SECTIONS];

export const ACTION_STYLES = ['primary', 'secondary'];
export const TONES = ['orange', 'blue', 'plain'];
export const ART = ['robot', 'browser', 'address', 'agent', 'messy', 'tidy'];

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = v => typeof v === 'string' && v.trim() !== '';

/**
 * A list of cards/questions under one heading.
 * @param {unknown} value
 * @param {string} where
 * @param {(item: unknown, where: string, errors: string[]) => object | null} parse
 * @returns {{ heading: string | null, items: object[] } | null}
 */
function section(value, where, errors, parse, { heading = 'required' } = {}) {
  if (value === undefined || value === null) return null;
  if (!isPlainObject(value)) {
    errors.push(`home.${where} must be an object`);
    return null;
  }
  const itemErrors = [];
  for (const key of Object.keys(value)) {
    if (key !== 'heading' && key !== 'lead' && key !== 'items' && key !== 'panels' &&
        key !== 'notes' && key !== 'address' && key !== 'credit') {
      errors.push(`home.${where}: unknown field "${key}"`);
    }
  }
  const result = { heading: null, lead: null, items: [] };

  if (value.heading !== undefined) {
    if (!isNonEmptyString(value.heading)) errors.push(`home.${where}.heading must be a non-empty string`);
    else result.heading = value.heading;
  } else if (heading === 'required') {
    errors.push(`home.${where} needs a heading`);
  }
  if (value.lead !== undefined) {
    if (!isNonEmptyString(value.lead)) errors.push(`home.${where}.lead must be a non-empty string`);
    else result.lead = value.lead;
  }

  const listKey = Array.isArray(value.items) ? 'items' : Array.isArray(value.panels) ? 'panels' : null;
  if (listKey) {
    const list = value[listKey];
    list.forEach((item, index) => {
      const parsed = parse(item, `home.${where}.${listKey}[${index}]`, itemErrors);
      if (parsed) result.items.push(parsed);
    });
  } else if (value.items !== undefined || value.panels !== undefined) {
    errors.push(`home.${where}.${value.items !== undefined ? 'items' : 'panels'} must be an array`);
  }

  if (Array.isArray(value.notes)) {
    value.notes.forEach((note, index) => {
      const parsed = parse(note, `home.${where}.notes[${index}]`, itemErrors);
      if (parsed) result.notes = [...(result.notes ?? []), parsed];
    });
  } else if (value.notes !== undefined) {
    errors.push(`home.${where}.notes must be an array`);
  }

  if (value.address !== undefined) {
    if (!isNonEmptyString(value.address)) errors.push(`home.${where}.address must be a non-empty string`);
    else result.address = value.address;
  }
  if (value.credit !== undefined) {
    if (!isNonEmptyString(value.credit)) errors.push(`home.${where}.credit must be a non-empty string`);
    else result.credit = value.credit;
  }

  errors.push(...itemErrors);
  return result;
}

/** Shared card reader: title/label + body, both optional but typed. */
function card(item, where, errors, { label = 'title', extra = {} } = {}) {
  if (!isPlainObject(item)) {
    errors.push(`${where} must be an object`);
    return null;
  }
  const out = {};
  const str = (key, required = false) => {
    if (item[key] === undefined) {
      if (required) errors.push(`${where}.${key} is required`);
      return null;
    }
    if (!isNonEmptyString(item[key])) {
      errors.push(`${where}.${key} must be a non-empty string`);
      return null;
    }
    return item[key];
  };

  out[label] = str(label, true);
  if (item.body !== undefined) out.body = str('body', true);
  for (const [key, check] of Object.entries(extra)) out[key] = check(item[key], `${where}.${key}`, errors);
  return out;
}

const optionalString = (value, where, errors) => {
  if (value === undefined) return null;
  if (!isNonEmptyString(value)) {
    errors.push(`${where} must be a non-empty string`);
    return null;
  }
  return value;
};

const enumerated = (allowed, fallbackValue) => (value, where, errors) => {
  if (value === undefined) return fallbackValue;
  if (!allowed.includes(value)) {
    errors.push(`${where} must be one of ${allowed.join('|')}, got ${JSON.stringify(value)}`);
    return fallbackValue;
  }
  return value;
};

/**
 * @param {object} data a page's frontmatter
 * @returns {{ home: object, errors: string[] }}
 */
export function normaliseHome(data = {}) {
  const errors = [];
  const source = isPlainObject(data) ? data : {};

  for (const key of Object.keys(source)) {
    if (!HOME_KEYS.includes(key) && !['title', 'slug', 'description', 'order', 'nav', 'layout', 'status'].includes(key)) {
      errors.push(`home page: unknown frontmatter field "${key}"`);
    }
  }

  // Hero: the one part of the page that cannot be absent.
  const rawHero = source[HERO];
  const hero = { headline: null, highlight: null, lead: null, actions: [] };
  if (rawHero === undefined) {
    errors.push('home page needs a "hero" section');
  } else if (!isPlainObject(rawHero)) {
    errors.push('home.hero must be an object');
  } else {
    const str = (key, required) => {
      const value = rawHero[key];
      if (value === undefined) {
        if (required) errors.push(`home.hero.${key} is required`);
        return null;
      }
      if (!isNonEmptyString(value)) {
        errors.push(`home.hero.${key} must be a non-empty string`);
        return null;
      }
      return value;
    };
    hero.headline = str('headline', true);
    hero.highlight = str('highlight', false);
    hero.lead = str('lead', false);

    if (rawHero.actions !== undefined) {
      if (!Array.isArray(rawHero.actions)) {
        errors.push('home.hero.actions must be an array');
      } else {
        rawHero.actions.forEach((action, index) => {
          const where = `home.hero.actions[${index}]`;
          if (!isPlainObject(action)) {
            errors.push(`${where} must be an object`);
            return;
          }
          const label = action.label;
          const href = action.href;
          if (!isNonEmptyString(label)) errors.push(`${where}.label must be a non-empty string`);
          if (!isNonEmptyString(href)) errors.push(`${where}.href must be a non-empty string`);
          const style = action.style ?? 'secondary';
          if (!ACTION_STYLES.includes(style)) {
            errors.push(`${where}.style must be one of ${ACTION_STYLES.join('|')}, got ${JSON.stringify(style)}`);
          }
          if (isNonEmptyString(label) && isNonEmptyString(href)) hero.actions.push({ label, href, style });
        });
      }
    }
    if (hero.actions.length === 0) errors.push('home.hero needs at least one action');
    for (const key of Object.keys(rawHero)) {
      if (!['headline', 'highlight', 'lead', 'actions'].includes(key)) {
        errors.push(`home.hero: unknown field "${key}"`);
      }
    }
  }

  const unchanged = section(source.unchanged, 'unchanged', errors, (item, where, itemErrors) => {
    return card(item, where, itemErrors, {
      extra: { art: enumerated(ART, 'browser') },
    });
  });

  const compare = section(source.compare, 'compare', errors, (item, where, itemErrors) => {
    return card(item, where, itemErrors, {
      label: 'label',
      extra: {
        art: enumerated(ART, 'messy'),
        tokens: (value, at, errs) => {
          if (value === undefined) return null;
          if (!isNonEmptyString(value) && typeof value !== 'number') {
            errs.push(`${at} must be a string or a number`);
            return null;
          }
          return String(value);
        },
        tokensNote: optionalString,
        tone: enumerated(TONES, 'orange'),
      },
    });
  });

  const steps = section(source.steps, 'steps', errors, (item, where, itemErrors) => card(item, where, itemErrors));
  const running = section(source.running, 'running', errors, (item, where, itemErrors) => card(item, where, itemErrors, {
    extra: {
      href: optionalString,
      placeholder: (value, at, errs) => {
        if (value === undefined) return false;
        if (typeof value !== 'boolean') {
          errs.push(`${at} must be true or false`);
          return false;
        }
        return value;
      },
    },
  }));
  const faq = section(source.faq, 'faq', errors, (item, where, itemErrors) => {
    if (!isPlainObject(item)) {
      itemErrors.push(`${where} must be an object`);
      return null;
    }
    for (const key of Object.keys(item)) {
      if (key !== 'q' && key !== 'a') itemErrors.push(`${where}: unknown field "${key}" (known: q, a)`);
    }
    if (!isNonEmptyString(item.q)) itemErrors.push(`${where}.q must be a non-empty string`);
    if (!isNonEmptyString(item.a)) itemErrors.push(`${where}.a must be a non-empty string`);
    return isNonEmptyString(item.q) && isNonEmptyString(item.a) ? { q: item.q, a: item.a } : null;
  });
  const paths = section(source.paths, 'paths', errors, (item, where, itemErrors) => card(item, where, itemErrors, {
    extra: {
      linkLabel: optionalString,
      href: optionalString,
      tone: enumerated(TONES, 'plain'),
    },
  }));

  const home = {
    hero,
    sections: { unchanged, compare, steps, running, faq, paths },
  };

  return { home, errors };
}
