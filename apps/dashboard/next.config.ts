import type { NextConfig } from 'next';

import { isPublicDesk } from './lib/desk-mode';
import { DESK_PATH_REDIRECTS } from './lib/desk-nav';
import { loadRootEnvLocal } from './load-root-env';

loadRootEnvLocal();

const publicExport = isPublicDesk() && process.env.DESK_PUBLIC_EXPORT === '1';

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  transpilePackages: ['three', '@quantanamo/contracts'],
  redirects: async () =>
    publicExport
      ? []
      : DESK_PATH_REDIRECTS.map((row) => ({
          source: row.source,
          destination: row.destination,
          permanent: false,
        })),
};

if (publicExport) {
  nextConfig.output = 'export';
  nextConfig.images = { unoptimized: true };
  nextConfig.trailingSlash = false;
}

export default nextConfig;
