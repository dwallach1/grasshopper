/** Query/host helpers for the operator sign-in gate (no browser APIs). */

export function firstSearchParam(value: string | string[] | undefined): string | null {
  if (value === undefined) return null;
  const text = Array.isArray(value) ? value[0] : value;
  if (!text) return null;
  const trimmed = text.trim();
  return trimmed === '' ? null : trimmed;
}

export function deskAuthErrorMessage(denied: boolean, authError: string | null): string | null {
  if (denied) return 'This account is not on the operator allowlist.';
  return authError;
}

/** WebAuthn rejects IP hosts; passkeys need `localhost`, not `127.0.0.1`. */
export function isLoopbackIpHost(host: string): boolean {
  return host === '127.0.0.1' || host.startsWith('127.0.0.1:');
}
