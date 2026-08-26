import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { publicPublishableKeyFromEnv, publicSupabaseUrlFromEnv } from './lib/auth-public';

export async function middleware(request: NextRequest) {
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
        setAll(batch) {
          for (const item of batch) {
            request.cookies.set(item.name, item.value);
          }
          response = NextResponse.next({ request });
          for (const item of batch) {
            response.cookies.set(item.name, item.value, item.options);
          }
        },
      },
    });
    await supabase.auth.getUser();
  } catch {
    return response;
  }
  return response;
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)'],
};
