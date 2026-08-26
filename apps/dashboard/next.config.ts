import type { NextConfig } from 'next';

import { loadRootEnvLocal } from './load-root-env';

loadRootEnvLocal();

const nextConfig: NextConfig = {};

export default nextConfig;
