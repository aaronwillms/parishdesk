import { defineConfig } from 'vite';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    VitePWA({
      registerType: 'autoUpdate',
      manifest: {
        name: 'ParishDesk — Basilica of Saint Mary',
        short_name: 'ParishDesk',
        description: 'Parish management dashboard for the Basilica of Saint Mary, Natchez',
        theme_color: '#1C2B3A',
        background_color: '#1C2B3A',
        display: 'standalone',
        orientation: 'any',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        navigateFallbackDenylist: [/^\/auth\//],
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Take control immediately so a new deploy's chunks are served right
        // away, and drop stale precaches. Paired with the controllerchange
        // reload guard in main.js, this prevents a tab from running a stale
        // bundle after a deploy (the cause of the "save button does nothing"
        // symptom — an inline onclick whose handler the stale JS never defined).
        skipWaiting: true,
        clientsClaim: true,
        cleanupOutdatedCaches: true,
        runtimeCaching: [
          {
            // Supabase API = live, mutable data. NEVER cache it or subject it to a
            // network-timeout fallback. The old NetworkFirst + networkTimeoutSeconds:10
            // raced every Supabase GET against a 10-second timer and, when the network
            // leg stalled (cold connection after a service-worker takeover, or a flaky
            // link), the post-save RELOAD reads that a save awaits hung the FULL 10s
            // before falling back to (often empty) cache — i.e. "saving takes ~10s".
            // (cacheableResponse:[0,200] also cached status-0/opaque failures.) Writes
            // already bypass the SW (routes are GET-only); NetworkOnly sends reads
            // straight to the network with no timeout and no caching.
            urlPattern: /^https:\/\/[a-z0-9]+\.supabase\.co\/.*/i,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /^https:\/\/fonts\.googleapis\.com\/.*/i,
            handler: 'StaleWhileRevalidate',
            options: { cacheName: 'google-fonts-stylesheets' },
          },
          {
            urlPattern: /^https:\/\/fonts\.gstatic\.com\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'google-fonts-webfonts',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 365 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
          {
            urlPattern: /^https:\/\/cdn\.jsdelivr\.net\/.*/i,
            handler: 'CacheFirst',
            options: {
              cacheName: 'jsdelivr-cache',
              expiration: { maxAgeSeconds: 60 * 60 * 24 * 30 },
              cacheableResponse: { statuses: [0, 200] },
            },
          },
        ],
      },
    }),
  ],
});
