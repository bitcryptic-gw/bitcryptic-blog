export const prerender = false;
import type { APIRoute } from 'astro';
import fs from 'node:fs';

/**
 * Read-only sync status, for monitoring.
 *
 * Written by scripts/sync.mjs (the sync container) into the shared status file
 * and read here. Tailnet-only by the same proxy rule as /api/deploy: Caddy
 * blocks /api/* on the public host, so only a request that comes over the
 * tailnet (or the container directly) reaches this.
 *
 * 200 with the status document, or 503 {"status":"unknown"} before the sync
 * loop has written one.
 */
const STATUS_FILE = process.env.SYNC_STATUS_FILE ?? '/app/data/sync-status.json';

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = () => {
  try {
    const raw = fs.readFileSync(STATUS_FILE, 'utf-8');
    return json({ status: 'ok', ...JSON.parse(raw) });
  } catch (e) {
    return json({ status: 'unknown', message: `no sync status yet (${(e as Error).message})` }, 503);
  }
};
