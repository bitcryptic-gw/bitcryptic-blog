/**
 * Belt-and-braces startup guard.
 *
 * scripts/start.sh already checks the secrets for the selected mode, but the
 * server (or the sync loop) can also be started directly:
 *
 *   node dist/server/entry.mjs
 *
 * so the image sets NODE_OPTIONS=--import=/app/scripts/assert-secrets.mjs, which
 * makes *every* node process in the container run this check before its own
 * code. A configured-but-unusable secret therefore stops the process with a
 * non-zero exit instead of surfacing later as a 500 from one route.
 *
 * Unset variables are fine: with DEPLOY_SECRET_FILE unset the manual hook is
 * simply disabled (it answers 503) and the site serves normally.
 */
import { readSecret } from './secrets.mjs';

const checks = [
  ['DEPLOY_SECRET_FILE', 'deploy hook (DEPLOY_SECRET_FILE)'],
  ['NTFY_TOKEN_FILE', 'ntfy token (NTFY_TOKEN_FILE)'],
];

for (const [envName, label] of checks) {
  const file = process.env[envName];
  if (!file) continue;
  try {
    readSecret(file, label);
  } catch (e) {
    // Message names the variable and path; never the value.
    console.error(`[assert-secrets] FATAL: ${e.message}`);
    process.exit(1);
  }
}
