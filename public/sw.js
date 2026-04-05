// ─── Service Worker for VMS ───────────────────────────────────────────────────
// Strategy: Cache-first for static assets, Network-first for API calls.

const CACHE_NAME = "vms-v1";

// Static assets to cache immediately on install
// These are the files that make up the "app shell" —
// enough to render the UI even with no internet
const PRECACHE_URLS = [
  "/",
  "/gate",
  "/index.html",
  "/manifest.json",
];

// ── Install event ─────────────────────────────────────────────────────────────
// Fires once when the service worker is first installed.
// We pre-cache the app shell here.
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(PRECACHE_URLS);
    })
  );
  // Take control immediately rather than waiting for old SW to expire
  self.skipWaiting();
});

// ── Activate event ────────────────────────────────────────────────────────────
// Fires after install. We clean up old caches here.
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) =>
      Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      )
    )
  );
  // Take control of all open tabs immediately
  self.clients.claim();
});

// ── Fetch event ───────────────────────────────────────────────────────────────
// Fires on every network request the app makes.
// We intercept here and decide: serve from cache or go to network.
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Let Firebase and Google API calls go straight to network —
  // Firestore handles its own caching via IndexedDB persistence.
  // We don't want to interfere with those requests.
  if (
    url.hostname.includes("firestore.googleapis.com") ||
    url.hostname.includes("firebase.googleapis.com") ||
    url.hostname.includes("identitytoolkit.googleapis.com") ||
    url.hostname.includes("securetoken.googleapis.com")
  ) {
    return; // don't intercept — fall through to normal network fetch
  }

  // For everything else (JS, CSS, HTML, images):
  // Try network first, fall back to cache.
  // This means users always get the latest version when online,
  // but the app still loads when offline.
  event.respondWith(
    fetch(event.request)
      .then((networkResponse) => {
        // If we got a good response, clone it into the cache for next time
        if (networkResponse && networkResponse.status === 200) {
          const responseClone = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseClone);
          });
        }
        return networkResponse;
      })
      .catch(() => {
        // Network failed — serve from cache
        return caches.match(event.request).then((cached) => {
          if (cached) return cached;
          // If not in cache either, return a minimal offline fallback
          // for navigation requests (so the app shell still renders)
          if (event.request.mode === "navigate") {
            return caches.match("/index.html");
          }
        });
      })
  );
});