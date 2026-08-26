import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';

import { publicPublishableKey, publicSupabaseUrl } from './auth-env';

export async function createServerSupabase() {
  const store = await cookies();
  return createServerClient(publicSupabaseUrl(), publicPublishableKey(), {
    auth: {
      experimental: { passkey: true },
    },
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
          // Server Components cannot persist refreshed cookies; middleware does.
        }
      },
    },
  });
}
