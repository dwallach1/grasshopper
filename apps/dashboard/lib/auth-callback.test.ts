import { describe, expect, test } from 'bun:test';
import { NextResponse } from 'next/server';

import {
  DESK_CALLBACK_PATH,
  authCookieFromSetAll,
  callbackErrorUrl,
  callbackSuccessUrl,
  deskCallbackUrl,
  deskRequestOrigin,
  newAuthCookieSink,
  nextCookieSameSite,
  recordAuthSetAll,
  redirectWithAuthCookies,
  safeNextPath,
} from './auth-callback';

describe('deskCallbackUrl', () => {
  test('stays on the origin that stored the PKCE verifier', () => {
    expect(deskCallbackUrl('http://localhost:5173')).toBe('http://localhost:5173/auth/callback');
    expect(deskCallbackUrl('http://127.0.0.1:5173')).toBe('http://127.0.0.1:5173/auth/callback');
    expect(deskCallbackUrl('http://localhost:5173/')).toBe('http://localhost:5173/auth/callback');
  });
});

describe('deskRequestOrigin', () => {
  test('prefers Host over Next.js request.url when they disagree', () => {
    const nextUrl = 'http://localhost:5173/auth/callback?code=abc';
    expect(deskRequestOrigin('127.0.0.1:5173', nextUrl)).toBe('http://127.0.0.1:5173');
    expect(deskRequestOrigin('localhost:5173', nextUrl)).toBe('http://localhost:5173');
    expect(deskRequestOrigin(null, nextUrl)).toBe('http://localhost:5173');
    expect(deskRequestOrigin('evil.example/steal', nextUrl)).toBe('http://localhost:5173');
  });
});

describe('safeNextPath', () => {
  test('rejects open redirects and the callback itself', () => {
    expect(safeNextPath(null)).toBe('/');
    expect(safeNextPath('')).toBe('/');
    expect(safeNextPath('https://evil.example')).toBe('/');
    expect(safeNextPath('//evil.example')).toBe('/');
    expect(safeNextPath('/\\evil')).toBe('/');
    expect(safeNextPath(DESK_CALLBACK_PATH)).toBe('/');
    expect(safeNextPath('/auth/callback?code=replay')).toBe('/');
    expect(safeNextPath('/book')).toBe('/');
    expect(safeNextPath('/runs?tab=test')).toBe('/');
    expect(safeNextPath('/catalysts')).toBe('/events');
    expect(safeNextPath('/theses')).toBe('/theses');
  });
});

describe('callback destinations', () => {
  test('success and error redirects keep the request origin', () => {
    const ip = 'http://127.0.0.1:5173';
    const local = 'http://localhost:5173';
    expect(callbackSuccessUrl(ip, '/book').href).toBe('http://127.0.0.1:5173/');
    expect(callbackSuccessUrl(local, 'https://evil.example').href).toBe('http://localhost:5173/');
    const failed = callbackErrorUrl(ip, 'invalid flow state, no valid flow state found');
    expect(failed.origin).toBe(ip);
    expect(failed.pathname).toBe('/');
    expect(failed.searchParams.get('auth_error')).toBe('invalid flow state, no valid flow state found');
    expect(callbackErrorUrl(local, '   ').searchParams.get('auth_error')).toBe('auth_callback_failed');
  });
});

describe('auth cookie redirect', () => {
  test('maps cookie SameSite and copies session cookies onto the redirect', () => {
    expect(nextCookieSameSite('lax')).toBe('lax');
    expect(nextCookieSameSite(true)).toBe('strict');
    expect(nextCookieSameSite(false)).toBeUndefined();

    const mapped = authCookieFromSetAll('sb-xqungxapqicdmboniezz-auth-token', 'session-jwt', {
      path: '/',
      sameSite: 'lax',
      httpOnly: false,
      maxAge: 60,
    });
    expect(mapped.options?.sameSite).toBe('lax');
    expect(mapped.options?.path).toBe('/');

    const sink = newAuthCookieSink();
    recordAuthSetAll(
      sink,
      [
        {
          name: 'sb-xqungxapqicdmboniezz-auth-token',
          value: 'session-jwt',
          options: { path: '/', sameSite: 'lax', maxAge: 400 * 24 * 60 * 60 },
        },
        {
          name: 'sb-xqungxapqicdmboniezz-auth-token-code-verifier',
          value: '',
          options: { path: '/', maxAge: 0 },
        },
      ],
      {
        'Cache-Control': 'private, no-cache, no-store, must-revalidate, max-age=0',
        Expires: '0',
        Pragma: 'no-cache',
      },
    );

    const bare = NextResponse.redirect('http://localhost:5173/');
    expect(bare.cookies.get('sb-xqungxapqicdmboniezz-auth-token')).toBeUndefined();

    const response = redirectWithAuthCookies(new URL('http://localhost:5173/'), sink);
    expect(response.cookies.get('sb-xqungxapqicdmboniezz-auth-token')?.value).toBe('session-jwt');
    expect(response.headers.get('location')).toBe('http://localhost:5173/');
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });
});
