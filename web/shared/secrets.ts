export type SecretBinding = string | SecretsStoreSecret | undefined;

function isSecretsStoreSecret(binding: Exclude<SecretBinding, undefined>): binding is SecretsStoreSecret {
  return Object(binding) === binding;
}

export async function readSecret(binding: SecretBinding, name: string): Promise<string> {
  const value = binding && isSecretsStoreSecret(binding) ? await binding.get() : binding;
  if (!value) throw new Error(`${name} is unavailable`);
  return value;
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
