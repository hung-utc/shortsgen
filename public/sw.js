/* shortsgenerated service worker — app-shell offline cache.
 * Update strategy (v3 — fixes stale-bundle pinning):
 * - Navigations/documents: NETWORK-FIRST. Fetch from network, cache the fresh
 *   copy, fall back to cache only when offline. A published fix reaches the
 *   browser on the next visit — the SW can never pin an old bundle.
 * - Hashed /assets/* files: CACHE-FIRST (content-addressed, immutable — a new
 *   build gets new filenames, so old entries can never shadow new code).
 * - Other same-origin GET (icons, manifest): network-first, cache fallback.
 * NEVER caches Google API calls, blob:/data: media, or /api/. Versioned cache
 * name purges old shells on activate. skipWaiting + clients.claim so the
 * newest published shell takes over immediately. */
const RR_SW_VERSION = "shortsgenerated-shell-v3";

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(RR_SW_VERSION);
      // Cache the shell entry; the hashed JS/CSS chunks get cached on visit.
      try {
        await cache.add("/");
      } catch {
        /* offline on first visit — nothing to cache yet */
      }
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== RR_SW_VERSION).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isDocument(req) {
  return req.destination === "document" || req.mode === "navigate";
}

function isHashedAsset(pathname) {
  return pathname.startsWith("/assets/");
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  // Only same-origin app-shell files. Never Google APIs, never blobs/data.
  if (url.origin !== self.location.origin) return;
  if (url.protocol === "blob:" || url.protocol === "data:") return;
  if (url.pathname.startsWith("/api/")) return;

  // Hashed /assets/* are content-addressed and immutable: cache-first forever.
  if (isHashedAsset(url.pathname)) {
    event.respondWith(
      (async () => {
        const cache = await caches.open(RR_SW_VERSION);
        const hit = await cache.match(req);
        if (hit) return hit;
        try {
          const res = await fetch(req);
          if (res && res.ok) cache.put(req, res.clone());
          return res;
        } catch {
          return new Response("Offline — shortsgenerated needs a connection for this.", {
            status: 503,
            headers: { "Content-Type": "text/plain" },
          });
        }
      })(),
    );
    return;
  }

  // Everything else (documents, icons, manifest): network-first.
  // Fresh copy wins on every visit; cache is the offline fallback only.
  event.respondWith(
    (async () => {
      const cache = await caches.open(RR_SW_VERSION);
      try {
        const res = await fetch(req);
        if (res && res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        const cached =
          (await cache.match(req, { ignoreSearch: isDocument(req) })) ||
          (isDocument(req) ? await cache.match("/") : null);
        if (cached) return cached;
        return new Response("Offline — shortsgenerated needs a connection for this.", {
          status: 503,
          headers: { "Content-Type": "text/plain" },
        });
      }
    })(),
  );
});
