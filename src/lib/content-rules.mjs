/**
 * Rules shared by the post validator and the page loader.
 *
 * These live apart from `scripts/validate-content.mjs` so that `src/lib/pages.mjs`
 * can use them without a circular import: the validator imports the page loader
 * to check a whole commit, and the page loader needs the same slug rule.
 */

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const ALLOWED_STATUS = ['draft', 'published'];

export const REQUIRED_FIELDS = ['title', 'slug', 'date', 'description', 'status'];

/** File stems that predate the stem == slug convention and are already live. */
export const LEGACY_FILE_STEMS = new Set(['mdf-blog-post-20260526']);
