import path from 'node:path';
import type { NextConfig } from 'next';

/**
 * Static export: the UI is plain files served by the API server (single origin → no CORS, and
 * WebSocket voice connects to the same host). For split hosting set NEXT_PUBLIC_API_BASE_URL.
 */
const config: NextConfig = {
  output: 'export',
  reactStrictMode: true,
  transpilePackages: ['@acme/contracts'],
  images: { unoptimized: true },
  turbopack: { root: path.join(__dirname, '../..') },
};

export default config;
