/**
 * MDF content negotiation for the blog.
 *
 * `Accept: text/markdown` at `/` and `/blog/<slug>/` returns markdown at the
 * same URL; everything else gets the HTML it always got. The same URLs also
 * carry `Vary: Accept` and a per-representation ETag on the HTML side, so a
 * cache never hands a markdown body to a browser (or the reverse).
 *
 * Unknown paths and unknown/draft slugs are a real 404 at the requested URL —
 * an agent gets a short markdown "Not found", a browser gets the existing
 * not-found page, and neither is redirected.
 */
import { defineMiddleware } from 'astro:middleware';
import { negotiate } from './lib/negotiate.js';
import { MDF_HEADERS, SITE_URL } from './lib/mdf.js';
import {
  indexMarkdown,
  markdownLogLine,
  notFoundMarkdown,
  postHtmlUrl,
  postMarkdown,
  type MarkdownPost,
} from './lib/markdown-content.js';
import { etagFor, ifNoneMatchMatches } from './lib/etag.js';
import { loadPosts } from '../scripts/validate-content.mjs';

const POST_PATH = /^\/blog\/([^/]+)\/?$/;

const MARKDOWN_TYPE = 'text/markdown; charset=utf-8';

function contentDir(): string {
  return process.env.CONTENT_DIR ?? '/app/src/content/blog';
}

function loadMarkdownPosts(): MarkdownPost[] {
  return loadPosts(contentDir()).posts as MarkdownPost[];
}

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

export const onRequest = defineMiddleware(async (context, next) => {
  const pathname = new URL(context.request.url).pathname;
  const method = context.request.method;
  const wantMarkdown =
    (method === 'GET' || method === 'HEAD') &&
    negotiate(context.request.headers.get('accept')) === 'markdown';
  const postMatch = pathname.match(POST_PATH);
  const isContentRoute = pathname === '/' || postMatch !== null;

  if (wantMarkdown) {
    const ifNoneMatch = context.request.headers.get('if-none-match');
    const userAgent = context.request.headers.get('user-agent');

    try {
      if (pathname === '/') {
        const body = indexMarkdown(loadMarkdownPosts());
        console.log(markdownLogLine(pathname, 200, userAgent));
        return markdownResponse(body, 200, `${SITE_URL}/`, ifNoneMatch);
      }

      if (postMatch) {
        const slug = decodeURIComponent(postMatch[1]);
        const post = loadMarkdownPosts().find(p => p.slug === slug);
        if (post) {
          console.log(markdownLogLine(pathname, 200, userAgent));
          return markdownResponse(postMarkdown(post), 200, postHtmlUrl(post.slug), ifNoneMatch);
        }
        console.log(markdownLogLine(pathname, 404, userAgent));
        return markdownResponse(notFoundMarkdown(), 404, null, ifNoneMatch);
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
    return markdownResponse(notFoundMarkdown(), 404, null, context.request.headers.get('if-none-match'));
  }

  if (isContentRoute || response.status === 404) {
    return finaliseHtml(response, context.request);
  }

  return response;
});
