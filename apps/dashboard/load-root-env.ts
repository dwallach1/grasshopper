import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Load repo-root `.env.local` into `process.env` (does not override existing vars). */
export function loadRootEnvLocal(): void {
  const envPath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../.env.local');
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (!(key in process.env)) process.env[key] = value;
  }
}
