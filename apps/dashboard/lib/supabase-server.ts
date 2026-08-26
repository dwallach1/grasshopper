import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { NextRequest } from 'next/server';

import { recordAuthSetAll, type AuthCookieSink } from './auth-callback';
import { publicPublishableKey, publicSupabaseUrl } from './auth-env';

const PASSKEY_AUTH = { experimental: { passkey: true } } as const;

export async function createServerSupabase() {
  const store = await cookies();
  return createServerClient(publicSupabaseUrl(), publicPublishableKey(), {
    auth: PASSKEY_AUTH,
    cookies: {
      getAll() {
        return store.getAll();
      },
      setAll(batch) {
        try {
          for (const item of batch) {
            store.set(item.name, item.value, item.options);
          }
        } catch {
          // Server Components cannot persist refreshed cookies; proxy.ts does.
        }
      },
    },
  });
}

/** Route Handler client: session cookies land on the `NextResponse` we return, not `cookies()`. */
export function createRequestSupabase(request: NextRequest, sink: AuthCookieSink) {
  return createServerClient(publicSupabaseUrl(), publicPublishableKey(), {
    auth: PASSKEY_AUTH,
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(batch, headers) {
        recordAuthSetAll(sink, batch, {
          'Cache-Control': headers['Cache-Control'],
          Expires: headers.Expires,
          Pragma: headers.Pragma,
        });
      },
    },
  });
}
