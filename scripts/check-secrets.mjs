/**
 * Per-mode startup check, run by scripts/start.sh before anything starts.
 *
 *   node scripts/check-secrets.mjs web    deploy-hook secret
 *   node scripts/check-secrets.mjs sync   ntfy token (if configured)
 *   node scripts/check-secrets.mjs        both (the default, for manual runs)
 *
 * A secret that is configured but missing, unreadable or empty is fatal: exit 1.
 * An unset secret variable is fine — that feature is simply off.
 *
 * Only the variable name and the file path are ever printed, never a value.
 */
import { readSecret } from './secrets.mjs';

const ALL = {
  web: [['DEPLOY_SECRET_FILE', 'deploy hook (DEPLOY_SECRET_FILE)']],
  sync: [['NTFY_TOKEN_FILE', 'ntfy token (NTFY_TOKEN_FILE)']],
};

const mode = process.argv[2] ?? '';
const checks = mode && ALL[mode] ? ALL[mode] : [...ALL.web, ...ALL.sync];

let failed = false;
for (const [envName, label] of checks) {
  const file = process.env[envName];
  if (!file) continue;
  try {
    readSecret(file, label);
    console.log(`[check-secrets] ok: ${label} loaded from ${file}`);
  } catch (e) {
    console.error(`[check-secrets] FATAL: ${e.message}`);
    failed = true;
  }
}

if (failed) {
  console.error('[check-secrets] refusing to start');
  process.exit(1);
}
console.log(`[check-secrets] secret configuration is valid${mode ? ` (mode=${mode})` : ''}`);
