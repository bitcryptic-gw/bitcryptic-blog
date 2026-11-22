/**
 * MDF content negotiation for the site.
 *
 * `Accept: text/markdown` at `/`, `/blog/<slug>/` and any page URL returns
 * markdown at the same URL; everything else gets the HTML it always got. The
 * same URLs also carry `Vary: Accept` and a per-representation ETag on the HTML
 * side, so a cache never hands a markdown body to a browser (or the reverse).
 *
 * Unknown paths and unknown/draft slugs are a real 404 at the requested URL —
 * an agent gets a short markdown "Not found", a browser gets the theme's
 * not-found page, and neither is redirected.
 */
import { defineMiddleware } from 'astro:middleware';
import { negotiate } from './lib/negotiate.js';
import { MDF_HEADERS } from './lib/mdf.js';
import {
  indexMarkdown,
  markdownLogLine,
  notFoundMarkdown,
  postHtmlUrl,
  postMarkdown,
} from './lib/markdown-content.js';
import { pageHtmlUrl, pageMarkdown } from './lib/page-markdown.js';
import { footerMarkdown } from './lib/footer.js';
import { pageFileExists, slugFromPath } from './lib/pages.mjs';
import { contentDir, getSite, homePage, pageBySlug } from './lib/site.mjs';
import { etagFor, ifNoneMatchMatches } from './lib/etag.js';

const POST_PATH = /^\/blog\/([^/]+)\/?$/;

const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

/** A markdown response with the headers an MDF agent expects. */
function markdownResponse(
  body: string,
  status: number,
  canonical: string | null,
  ifNoneMatch: string | null
): Response {
  const etag = etagFor(body);
  const headers = new Headers({
    'Content-Type': MARKDOWN_TYPE,
    Vary: MDF_HEADERS.Vary,
    'X-MDF-Version': MDF_HEADERS['X-MDF-Version'],
    ETag: etag,
  });
  if (canonical) headers.set('Link', `<${canonical}>; rel="canonical"`);

  if (ifNoneMatchMatches(ifNoneMatch, etag)) {
    return new Response(null, { status: 304, headers });
  }
  headers.set('Content-Length', String(Buffer.byteLength(body, 'utf-8')));
  return new Response(body, { status, headers });
}

/**
 * Add Vary, X-MDF-Version and an ETag to an HTML response, and answer a
 * matching If-None-Match with 304. The tag is computed from the bytes being
 * served, so it cannot collide with the markdown representation's tag.
 */
async function finaliseHtml(response: Response, request: Request): Promise<Response> {
  if (response.status >= 300 && response.status < 400) return response;

  const body = await response.text();
  const headers = new Headers(response.headers);
  headers.set('Vary', MDF_HEADERS.Vary);
  headers.set('X-MDF-Version', MDF_HEADERS['X-MDF-Version']);

  const etag = etagFor(body);
  headers.set('ETag', etag);

  if (ifNoneMatchMatches(request.headers.get('if-none-match'), etag)) {
    return new Response(null, { status: 304, headers });
  }

  headers.set('Content-Length', String(Buffer.byteLength(body, 'utf-8')));
  return new Response(body, { status: response.status, headers });
}

/** The markdown document for a path that is a page, or null. */
function pageMarkdownFor(site: any, slug: string | null): { body: string, url: string } | null {
  if (slug === null) return null;
  if (slug === '') {
    const home = homePage(site);
    return home ? { body: pageMarkdown(home, site.config), url: pageHtmlUrl(site.config.origin, '') } : null;
  }
  const page = pageBySlug(site, slug);
  return page ? { body: pageMarkdown(page, site.config), url: pageHtmlUrl(site.config.origin, page.slug) } : null;
}

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = new URL(context.request.url).pathname;
  const method = context.request.method;
  const wantMarkdown =
    (method === 'GET' || method === 'HEAD') &&
    negotiate(context.request.headers.get('accept')) === 'markdown';
  const postMatch = pathname.match(POST_PATH);
  const pageSlug = slugFromPath(pathname);

  let site: any = null;
  const getCachedSite = () => {
    if (!site) site = getSite();
    return site;
  };

  if (wantMarkdown) {
    const ifNoneMatch = context.request.headers.get('if-none-match');
    const userAgent = context.request.headers.get('user-agent');

    try {
      if (pathname === '/') {
        const loaded = getCachedSite();
        // A site with a home page serves that page's markdown body, which is
        // the whole designed page in plain text. A site without one is the
        // blog, and its index markdown is what it has always been.
        const pageDoc = pageMarkdownFor(loaded, '');
        if (pageDoc) {
          console.log(markdownLogLine(pathname, 200, userAgent));
          return markdownResponse(pageDoc.body + footerMarkdown(loaded.config), 200, pageDoc.url, ifNoneMatch);
        }
        const body = indexMarkdown(loaded.posts, loaded.config);
        console.log(markdownLogLine(pathname, 200, userAgent));
        return markdownResponse(body + footerMarkdown(loaded.config), 200, `${loaded.config.origin}/`, ifNoneMatch);
      }

      if (postMatch) {
        const slug = decodeURIComponent(postMatch[1]);
        const post = getCachedSite().posts.find(p => p.slug === slug);
        if (post) {
          const loaded = getCachedSite();
          console.log(markdownLogLine(pathname, 200, userAgent));
          return markdownResponse(
            postMarkdown(post, loaded.config.origin) + footerMarkdown(loaded.config),
            200,
            postHtmlUrl(post.slug, loaded.config.origin),
            ifNoneMatch
          );
        }
        console.log(markdownLogLine(pathname, 404, userAgent));
        return markdownResponse(notFoundMarkdown(getCachedSite().config), 404, null, ifNoneMatch);
      }

      const pageDoc = pageMarkdownFor(getCachedSite(), pageSlug);
      if (pageDoc) {
        console.log(markdownLogLine(pathname, 200, userAgent));
        return markdownResponse(pageDoc.body + footerMarkdown(getCachedSite().config), 200, pageDoc.url, ifNoneMatch);
      }
    } catch (error) {
      // Content not readable: fall through to the HTML route, which reports it
      // the same way it always has.
      console.warn(`[mdf] markdown unavailable for ${pathname}: ${(error as Error).message}`);
    }
  }

  const response = await next();

  // Any 404 this app produces negotiates too: the requested URL keeps its
  // status, and the representation matches what the client asked for.
  if (wantMarkdown && response.status === 404) {
    console.log(markdownLogLine(pathname, 404, context.request.headers.get('user-agent')));
    return markdownResponse(
      notFoundMarkdown(getCachedSite().config),
      404,
      null,
      context.request.headers.get('if-none-match')
    );
  }

  const isContentRoute =
    pathname === '/' ||
    postMatch !== null ||
    pageFileExists(contentDir(), pageSlug);

  if (isContentRoute || response.status === 404) {
    return finaliseHtml(response, context.request);
  }

  return response;
});
