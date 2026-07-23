import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      // Generate a separate SW file rather than inlining, so it can be
      // tested and audited independently.
      injectRegister: "auto",
      // Dev mode: also register the SW during `vite dev` so offline tests
      // work without a production build.
      devOptions: {
        enabled: true,
      },
      manifest: {
        name: "AfroPay",
        short_name: "AfroPay",
        description:
          "Trustless cross-border remittances on Stellar — fast, low-cost, unstoppable.",
        theme_color: "#1a1a2e",
        background_color: "#ffffff",
        display: "standalone",
        start_url: "/",
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        // ── Static asset caching (cache-first) ──────────────────────────────
        // JS/CSS/fonts/images are fingerprinted by Vite, so a cache-first
        // strategy is safe and gives instant load on repeat visits.
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],

        // ── Runtime caching ─────────────────────────────────────────────────
        runtimeCaching: [
          // FX rates — stale-while-revalidate: serve from cache instantly,
          // refresh in background.  Stale threshold enforced in RateDisplay.
          {
            urlPattern: /\/api\/v1\/rates/,
            handler: "StaleWhileRevalidate",
            options: {
              cacheName: "fx-rates-cache",
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 300, // 5 minutes
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          // Escrow read endpoints — network-first (live data preferred);
          // fall back to cache if offline.
          {
            urlPattern: /\/api\/v1\/escrow\/[^/]+$/,
            handler: "NetworkFirst",
            options: {
              cacheName: "escrow-read-cache",
              networkTimeoutSeconds: 5,
              expiration: {
                maxEntries: 100,
                maxAgeSeconds: 60,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
          // POST /api/v1/payments — network-only: NEVER cache mutations.
          // Offline requests are handled by the BackgroundSyncQueue in
          // app/sw/outbox.ts, not by Workbox response caching.
          {
            urlPattern: /\/api\/v1\/payments/,
            handler: "NetworkOnly",
          },
        ],
      },
    }),
  ],
  server: {
    port: 5173,
  },
});
