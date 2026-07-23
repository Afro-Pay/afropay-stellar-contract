/**
 * Offline page entry — rendered by the service worker when navigation fails
 * because the device is offline and no cached page is available.
 *
 * This file acts as the SPA mount point for the offline experience.
 * vite-plugin-pwa points `offlineFallbackPage` at the built output of this
 * entry (or the root index.html, depending on configuration).
 */
export { OfflinePage as default } from "../components/offline/OfflinePage";
