import type { NextConfig } from 'next';

import { DESK_PATH_REDIRECTS } from './lib/desk-nav';
import { loadRootEnvLocal } from './load-root-env';

loadRootEnvLocal();

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
  transpilePackages: ['three'],
  redirects: async () =>
    DESK_PATH_REDIRECTS.map((row) => ({
      source: row.source,
      destination: row.destination,
      permanent: false,
    })),
};

export default nextConfig;
