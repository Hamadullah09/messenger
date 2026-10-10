import type { NextConfig } from 'next';

const apiOrigin = process.env.API_ORIGIN ?? 'http://localhost:4000';
const realtimeUrl = process.env.NEXT_PUBLIC_REALTIME_URL ?? 'http://localhost:4000';
const realtimeWs = realtimeUrl.replace(/^http/, 'ws');
const isDev = process.env.NODE_ENV !== 'production';
// Private object storage that serves short-lived signed URLs for uploads and downloads.
const mediaOrigin = process.env.NEXT_PUBLIC_MEDIA_ORIGIN ?? 'http://127.0.0.1:18333';

/**
 * Content Security Policy: no third-party origins. 'unsafe-eval' is only needed by the
 * development server (React Refresh). Inline styles are required by the virtualised list.
 */
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data: blob: ${mediaOrigin}`,
  `media-src 'self' blob: ${mediaOrigin}`,
  "font-src 'self'",
  `connect-src 'self' ${realtimeUrl} ${realtimeWs} ${mediaOrigin}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const config: NextConfig = {
  reactStrictMode: true,
  // Development-only badge; keep it away from the sidebar's bottom controls.
  devIndicators: { position: 'bottom-right' },
  poweredByHeader: false,
  transpilePackages: ['@storeline/shared'],
  // Same-origin API calls: the refresh cookie stays first-party and SameSite=Strict.
  async rewrites() {
    return [{ source: '/api/:path*', destination: `${apiOrigin}/api/:path*` }];
  },
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'Content-Security-Policy', value: csp },
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'no-referrer' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
        ],
      },
    ];
  },
};

export default config;
