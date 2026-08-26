import type { NextConfig } from 'next';

const localWeb = process.env.THESISFORGE_LOCAL_WEB === '1';

const nextConfig: NextConfig = {
  ...(localWeb
    ? {
        turbopack: {
          resolveAlias: {
            'cloudflare:workers': './shims/cloudflare-workers.ts',
          },
        },
      }
    : {}),
};

export default nextConfig;
