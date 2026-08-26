/**
 * Shim for local `next dev` (bun run web:app). Production vinext/Workers
 * resolve the real `cloudflare:workers` module instead.
 */
export const env = process.env as Cloudflare.Env & NodeJS.ProcessEnv;
