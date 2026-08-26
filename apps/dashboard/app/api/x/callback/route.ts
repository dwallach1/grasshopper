import { NextRequest, NextResponse } from 'next/server';

import { authenticatedIdentity, isManagerIdentity } from '../../../access-identity';
import { loadRootEnvLocal } from '../../../../load-root-env';
import { completeXAuthorization } from '../../../worker-control';

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function callbackPage(title: string, body: string, ok: boolean): NextResponse {
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8"/>
    <meta name="viewport" content="width=device-width, initial-scale=1"/>
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: dark; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0e0e0e; color: #f5f5f5; font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; }
      main { max-width: 28rem; padding: 24px; }
      h1 { margin: 0 0 8px; font-size: 20px; font-weight: 600; }
      p { margin: 0 0 16px; color: #8e8e8e; }
      a { color: ${ok ? '#00c805' : '#ff5000'}; }
    </style>
  </head>
  <body>
    <main>
      <h1>${escapeHtml(title)}</h1>
      <p>${escapeHtml(body)}</p>
      <a href="/">Back to Quantanamo</a>
    </main>
  </body>
</html>`;
  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(request: NextRequest) {
  loadRootEnvLocal();
  const managerId = await authenticatedIdentity(request.headers);
  if (!managerId || !isManagerIdentity(managerId)) {
    return callbackPage('Manager access required', 'Sign in on the local desk before completing X authorization.', false);
  }

  const oauthError = request.nextUrl.searchParams.get('error');
  if (oauthError) {
    const description = request.nextUrl.searchParams.get('error_description') || oauthError;
    return callbackPage('X authorization was denied', description, false);
  }

  const code = request.nextUrl.searchParams.get('code') || '';
  const state = request.nextUrl.searchParams.get('state') || '';
  if (!code || !state) {
    return callbackPage('X authorization is incomplete', 'The callback is missing a code or state.', false);
  }

  try {
    const result = await completeXAuthorization(code, state);
    if (!result.ok || result.body.authorized !== true) {
      return callbackPage(
        'X authorization failed',
        result.body.error || 'The knowledge worker rejected the OAuth callback.',
        false,
      );
    }
    return callbackPage(
      'X is connected',
      'Bookmark access is restored. Return to the desk and press Run to ingest the latest bookmarks.',
      true,
    );
  } catch (error) {
    return callbackPage(
      'X authorization failed',
      error instanceof Error ? error.message : 'The knowledge worker could not complete authorization.',
      false,
    );
  }
}
