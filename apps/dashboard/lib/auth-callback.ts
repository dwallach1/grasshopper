import { NextResponse } from 'next/server';
import type { CookieOptions } from '@supabase/ssr';

/** Path GoTrue must allow-list for both localhost and 127.0.0.1. */
export const DESK_CALLBACK_PATH = '/auth/callback';

export type NextCookieSameSite = 'lax' | 'strict' | 'none';

export type AuthCookieOptions = {
  domain?: string;
  expires?: Date;
  httpOnly?: boolean;
  maxAge?: number;
  path?: string;
  sameSite?: NextCookieSameSite;
  secure?: boolean;
};

export type AuthCookie = {
  name: string;
  value: string;
  options?: AuthCookieOptions;
};

/** Cookies and cache headers collected from `@supabase/ssr` `setAll` during a Route Handler. */
export type AuthCookieSink = {
  cookies: AuthCookie[];
  cacheControl: string | null;
  expires: string | null;
  pragma: string | null;
};

export function newAuthCookieSink(): AuthCookieSink {
  return { cookies: [], cacheControl: null, expires: null, pragma: null };
}

/**
 * Next.js `request.url` / `nextUrl.origin` can report `localhost` even when the
 * browser hit `127.0.0.1` (`metadataBase`, forwarded host). PKCE cookies are host-only,
 * so the redirect must follow the request Host header.
 */
export function deskRequestOrigin(hostHeader: string | null, requestUrl: string): string {
  const fromUrl = new URL(requestUrl);
  if (hostHeader === null) return fromUrl.origin;
  const host = hostHeader.trim();
  if (host === '' || host.includes('/') || host.includes('\\') || /\s/.test(host)) {
    return fromUrl.origin;
  }
  return `${fromUrl.protocol}//${host}`;
}

/** Magic-link / OAuth `redirectTo` must stay on the origin that stored the PKCE verifier. */
export function deskCallbackUrl(origin: string): string {
  return `${origin.replace(/\/$/, '')}${DESK_CALLBACK_PATH}`;
}

/**
 * Only same-origin relative paths. `new URL('https://evil.com', origin)` would otherwise
 * ignore the desk origin and send the session to an attacker.
 */
export function safeNextPath(next: string | null): string {
  if (next === null) return '/';
  const trimmed = next.trim();
  if (trimmed === '') return '/';
  if (!trimmed.startsWith('/')) return '/';
  if (trimmed.startsWith('//')) return '/';
  if (trimmed.includes('\\')) return '/';
  if (trimmed === DESK_CALLBACK_PATH || trimmed.startsWith(`${DESK_CALLBACK_PATH}?`)) return '/';
  return trimmed;
}

export function callbackSuccessUrl(origin: string, next: string | null): URL {
  return new URL(safeNextPath(next), origin);
}

export function callbackErrorUrl(origin: string, message: string): URL {
  const text = message.trim() === '' ? 'auth_callback_failed' : message.trim();
  return new URL(`/?auth_error=${encodeURIComponent(text)}`, origin);
}

export function nextCookieSameSite(value: CookieOptions['sameSite']): NextCookieSameSite | undefined {
  if (value === 'lax' || value === 'strict' || value === 'none') return value;
  if (value === true) return 'strict';
  return undefined;
}

export function authCookieFromSetAll(name: string, value: string, options: CookieOptions): AuthCookie {
  return {
    name,
    value,
    options: {
      domain: options.domain,
      expires: options.expires,
      httpOnly: options.httpOnly,
      maxAge: options.maxAge,
      path: options.path,
      sameSite: nextCookieSameSite(options.sameSite),
      secure: options.secure,
    },
  };
}

export function recordAuthSetAll(
  sink: AuthCookieSink,
  batch: { name: string; value: string; options: CookieOptions }[],
  headers: { 'Cache-Control'?: string; Expires?: string; Pragma?: string },
): void {
  for (const item of batch) {
    sink.cookies.push(authCookieFromSetAll(item.name, item.value, item.options));
  }
  sink.cacheControl = headers['Cache-Control'] ?? sink.cacheControl;
  sink.expires = headers.Expires ?? sink.expires;
  sink.pragma = headers.Pragma ?? sink.pragma;
}

/**
 * `cookies().set()` in a Route Handler is not copied onto a later `NextResponse.redirect()`.
 * Session cookies from `exchangeCodeForSession` must be applied to the redirect we return.
 */
export function redirectWithAuthCookies(location: URL, sink: AuthCookieSink): NextResponse {
  const response = NextResponse.redirect(location);
  for (const item of sink.cookies) {
    response.cookies.set(item.name, item.value, item.options);
  }
  if (sink.cacheControl) response.headers.set('Cache-Control', sink.cacheControl);
  if (sink.expires) response.headers.set('Expires', sink.expires);
  if (sink.pragma) response.headers.set('Pragma', sink.pragma);
  return response;
}
