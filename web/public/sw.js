/*
 * Android Chrome only offers "Add to Home screen" when a service worker handles fetch, so this file
 * exists to unlock that prompt. It caches nothing on purpose: nginx owns delivery, a new build is
 * live on the next request, and nothing here can pin an old bundle to a bank officer's phone.
 */
self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', () => {
  // Intentionally empty: passthrough, no offline copy of loan data on a shared device.
});
