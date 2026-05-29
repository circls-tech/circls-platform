import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  output: 'standalone',
  // No eslint config in this skeleton; don't block the build on lint.
  eslint: { ignoreDuringBuilds: true },
};

export default nextConfig;
