/// <reference lib="webworker" />
import { CACHE_PREFIX, classifyRequest, isShellCache, SHELL_FALLBACK } from './policy';

declare const self: ServiceWorkerGlobalScope;
// Replaced at build time with the exact list of public shell files and a
// content-derived version. Nothing else is ever written to Cache Storage.
const PRECACHE: string[] = JSON.parse('__FICHAJE_PRECACHE__');
const CACHE = CACHE_PREFIX + '__FICHAJE_VERSION__';
const precached = new Set(PRECACHE);

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE)
    .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(path, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names.filter((name) => isShellCache(name) && name !== CACHE).map((name) => caches.delete(name))))
    .then(() => self.clients.claim()));
});

// Navigation: network first so updates arrive; offline falls back to the
// cached shell, which never contains labour data. Responses are not stored.
self.addEventListener('fetch', (event) => {
  const kind = classifyRequest(event.request, self.location.origin, precached);
  if (kind === 'navigate') {
    event.respondWith(fetch(event.request).catch(async () =>
      (await caches.match(SHELL_FALLBACK, { cacheName: CACHE })) ?? Response.error()));
  } else if (kind === 'asset') {
    event.respondWith(caches.match(event.request, { cacheName: CACHE }).then((hit) => hit ?? fetch(event.request)));
  }
});
