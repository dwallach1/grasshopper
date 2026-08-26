import { z } from 'zod';

export const TokenErrorSchema = z.object({
  error: z.string().optional(),
  error_description: z.string().optional(),
}).passthrough();

export const REAUTH_OAUTH_ERRORS = new Set(['invalid_grant', 'invalid_request', 'unauthorized_client']);

/** Build an operator-facing X OAuth error without echoing tokens. */
export function xOauthFailureMessage(operation: string, status: number, payload: unknown): string {
  const parsed = TokenErrorSchema.safeParse(payload);
  const code = parsed.success ? parsed.data.error : undefined;
  const description = parsed.success ? parsed.data.error_description : undefined;
  const detail = [code, description].filter(Boolean).join(': ');
  const needsReauth = status === 400 && (!code || REAUTH_OAUTH_ERRORS.has(code));
  if (needsReauth) {
    return detail
      ? `${operation} failed with status ${status} (${detail}); reauthorization is required`
      : `${operation} failed with status ${status}; reauthorization is required`;
  }
  return detail
    ? `${operation} failed with status ${status} (${detail})`
    : `${operation} failed with status ${status}`;
}
