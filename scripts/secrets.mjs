/**
 * Shared secret reader.
 *
 * Kept in its own module with no side effects so that both the startup checks
 * and the sync loop can import it without triggering the loop's module-level
 * initialisation.
 *
 * A secret that is configured but missing, unreadable or empty is a fatal
 * configuration error — never a silent fallback.
 */
import fs from 'node:fs';

/** Read a secret from a file. Refuses to return an empty value. */
export function readSecret(file, label) {
  if (!file) return '';
  let value;
  try {
    value = fs.readFileSync(file, 'utf-8').trim();
  } catch {
    throw new Error(`${label}: secret file ${file} is missing or unreadable — refusing to start`);
  }
  if (!value) throw new Error(`${label}: secret file ${file} is empty — refusing to start`);
  return value;
}
