/**
 * Startup guard for the web container.
 *
 * The manual sync hook's secret must come from a mounted file, never from the
 * environment (an env var is visible in `docker inspect`). If the file is
 * configured but missing, unreadable or empty, this exits non-zero so the
 * container fails to start rather than running with a disabled or guessable
 * hook.
 *
 * Run it ahead of the server in the container command:
 *   node scripts/check-secrets.mjs && node ./dist/server/entry.mjs
 */
import { readSecret } from './sync.mjs';

const checks = [
  ['DEPLOY_SECRET_FILE', 'deploy hook (DEPLOY_SECRET_FILE)'],
  ['NTFY_TOKEN_FILE', 'ntfy token (NTFY_TOKEN_FILE)'],
];

let failed = false;
for (const [envName, label] of checks) {
  const file = process.env[envName];
  if (!file) continue;
  try {
    readSecret(file, label);
    // Never echo the value — only the fact that it loaded.
    console.log(`[check-secrets] ok: ${label} loaded from ${file}`);
  } catch (e) {
    console.error(`[check-secrets] FATAL: ${e.message}`);
    failed = true;
  }
}

if (failed) process.exit(1);
console.log('[check-secrets] secret configuration is valid');
