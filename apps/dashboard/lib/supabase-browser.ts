import { createBrowserClient } from '@supabase/ssr';

import { publicPublishableKeyFromEnv, publicSupabaseUrlFromEnv } from './auth-public';

export function createBrowserSupabase() {
  return createBrowserClient(publicSupabaseUrlFromEnv(), publicPublishableKeyFromEnv(), {
    auth: {
      experimental: { passkey: true },
    },
  });
}
