import type { APIRoute } from 'astro';
import crypto from 'node:crypto';
import { readSecret, syncOnce } from '../../../scripts/sync.mjs';

/**
 * Manual "sync now" hook.
 *
 * Publishing normally happens on its own: scripts/sync.mjs runs as a second
 * container and applies a merged `main` within a minute. This endpoint exists
 * for the case where you want it now.
 *
 * - Auth: `Authorization: Bearer <secret>`, where the secret is read from the
 *   file named by DEPLOY_SECRET_FILE. It is never read from the environment.
 * - Reachability: the endpoint is meant to be tailnet-only. The public host is
 *   proxied by Caddy, which blocks /api/* at the proxy layer — see README.
 * - The work is the same validate-then-reset path the sync loop uses.
 */
const SECRET_FILE = process.env.DEPLOY_SECRET_FILE ?? '';
const MAX_BODY_BYTES = 1024;

// Fail loudly for this route if the mounted secret is configured but unusable.
// scripts/check-secrets.mjs runs the same check at container start, so a broken
// mount keeps the container down rather than silently disabling the hook.
const DEPLOY_SECRET = SECRET_FILE ? readSecret(SECRET_FILE, 'deploy hook') : '';

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const POST: APIRoute = async ({ request }) => {
  if (!DEPLOY_SECRET) {
    return json({ status: 'error', message: 'manual sync hook is not configured (DEPLOY_SECRET_FILE unset)' }, 503);
  }

  const auth = request.headers.get('authorization') ?? '';
  const presented = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
  if (!safeEqual(presented, DEPLOY_SECRET)) {
    return json({ status: 'error', message: 'Unauthorized' }, 401);
  }

  const declared = Number(request.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return json({ status: 'error', message: 'request body too large' }, 413);
  }

  const result = await syncOnce({ alertOnReject: true });
  const status = result.action === 'error' || result.action === 'rejected' ? 500 : 200;
  return json({ status: status === 200 ? 'ok' : 'error', ...result }, status);
};
