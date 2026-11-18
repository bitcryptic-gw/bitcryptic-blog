/**
 * Headers shared by every MDF response the blog serves.
 *
 * `X-MDF-Version` marks the protocol family (always `1`); the spec release the
 * site conforms to is `mdf_version` in `/mdf.json`, not this header.
 */
export const MDF_PROTOCOL_VERSION = '1';

export const SITE_URL = 'https://blog.bitcryptic.com';

export const MDF_HEADERS = {
  Vary: 'Accept',
  'X-MDF-Version': MDF_PROTOCOL_VERSION,
};
