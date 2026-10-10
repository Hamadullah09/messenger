import type { MetadataRoute } from 'next';

/** Installable web app (desktop and phones): opens like an app, with SMA icons. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'SMA — Team messaging',
    short_name: 'SMA',
    description: 'SMA Technology — team messaging for stores and businesses',
    start_url: '/dashboard',
    scope: '/',
    display: 'standalone',
    background_color: '#f4f5f8',
    theme_color: '#c2410c',
    icons: [
      { src: '/brand/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/brand/sma-mark.png', sizes: '512x512', type: 'image/png' },
      {
        src: '/brand/icon-512-maskable.png',
        sizes: '512x512',
        type: 'image/png',
        purpose: 'maskable',
      },
    ],
  };
}
