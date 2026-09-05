import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { refreshAuthCookies } from './lib/auth-session';
import { publicPublishableKeyFromEnv, publicSupabaseUrlFromEnv } from './lib/auth-public';
import { isPublicDesk } from './lib/desk-mode';

export async function proxy(request: NextRequest) {
  if (isPublicDesk()) return NextResponse.next({ request });
  let response = NextResponse.next({ request });
  try {
    const supabase = createServerClient(publicSupabaseUrlFromEnv(), publicPublishableKeyFromEnv(), {
      auth: {
        experimental: { passkey: true },
      },
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(batch, headers) {
          for (const item of batch) {
            request.cookies.set(item.name, item.value);
          }
          response = NextResponse.next({ request });
          for (const item of batch) {
            response.cookies.set(item.name, item.value, item.options);
          }
          if (headers['Cache-Control']) response.headers.set('Cache-Control', headers['Cache-Control']);
          if (headers.Expires) response.headers.set('Expires', headers.Expires);
          if (headers.Pragma) response.headers.set('Pragma', headers.Pragma);
        },
      },
    });
    await refreshAuthCookies(supabase);
  } catch {
    return response;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
