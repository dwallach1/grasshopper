export type SecretBinding = string | SecretsStoreSecret | undefined;

function isSecretsStoreSecret(binding: Exclude<SecretBinding, undefined>): binding is SecretsStoreSecret {
  return Object(binding) === binding;
}

/**
 * Resolve a Worker secret. Prefer Secrets Store (or a string binding), then an
 * optional `.dev.vars` plain-string fallback used for local Miniflare / Vite.
 */
export async function readSecret(
  binding: SecretBinding,
  name: string,
  fallback?: string,
): Promise<string> {
  if (binding) {
    try {
      const value = isSecretsStoreSecret(binding) ? await binding.get() : binding;
      if (value) return value;
    } catch {
      // Secrets Store is often unavailable in fully-local Miniflare.
    }
  }
  if (fallback) return fallback;
  throw new Error(`${name} is unavailable`);
}

export async function secretsEqual(left: string, right: string): Promise<boolean> {
  const encoder = new TextEncoder();
  const [leftHash, rightHash] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(left)),
    crypto.subtle.digest('SHA-256', encoder.encode(right)),
  ]);
  // SAFETY: Cloudflare Workers extends SubtleCrypto with timingSafeEqual at runtime.
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual(first: ArrayBuffer, second: ArrayBuffer): boolean;
  };
  return subtle.timingSafeEqual(leftHash, rightHash);
}
