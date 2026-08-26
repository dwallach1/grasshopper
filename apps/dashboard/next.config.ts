import type { NextConfig } from 'next';

import { loadRootEnvLocal } from './load-root-env';

loadRootEnvLocal();

const nextConfig: NextConfig = {
  allowedDevOrigins: ['127.0.0.1', 'localhost'],
};

export default nextConfig;
