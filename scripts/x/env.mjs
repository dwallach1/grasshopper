import { readFileSync, writeFileSync, existsSync } from 'node:fs';

export const envPath = new URL('../../.env.local', import.meta.url);

export function loadEnv() {
  if (!existsSync(envPath)) {
    throw new Error(`Missing ${envPath.pathname}. Copy .env.example to .env.local first.`);
  }

  const text = readFileSync(envPath, 'utf8');
  const env = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const index = line.indexOf('=');
    if (index === -1) continue;

    const key = line.slice(0, index).trim();
    let value = line.slice(index + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }

  return env;
}

export function updateEnv(updates) {
  const original = readFileSync(envPath, 'utf8');
  const seen = new Set();
  const lines = original.split(/\r?\n/).map((rawLine) => {
    const index = rawLine.indexOf('=');
    if (index === -1 || rawLine.trim().startsWith('#')) return rawLine;

    const key = rawLine.slice(0, index).trim();
    if (!(key in updates)) return rawLine;

    seen.add(key);
    return `${key}=${updates[key]}`;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) lines.push(`${key}=${value}`);
  }

  writeFileSync(envPath, lines.join('\n').replace(/\n*$/, '\n'));
}

export function requireEnv(env, keys) {
  const missing = keys.filter((key) => !env[key]);
  if (missing.length) {
    throw new Error(`Missing required env value(s): ${missing.join(', ')}`);
  }
}
