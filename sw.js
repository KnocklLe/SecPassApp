// SecPass mobile — service worker : l'appli fonctionne hors ligne.
// Change VERSION à chaque mise à jour publiée pour que les téléphones téléchargent les nouveaux fichiers.
const VERSION = "secpass-mobile-1.0.0";
const ASSETS = [
  "./",
  "./index.html",
  "./app.js",
  "./app.css",
  "./crypto.js",
  "./store.js",
  "./style.css",
  "./sync.js",
  "./ui.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./icons/apple-touch-icon.png",
  "./icons/favicon-32.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  // GitHub et tout ce qui n'est pas l'appli : réseau direct, jamais mis en cache
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((hit) => hit || fetch(event.request)),
  );
});
