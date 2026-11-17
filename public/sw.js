const CACHE = 'relaydeck-shell-v4';
const SHELL = ['/', '/style.css', '/options.css', '/app.js', '/options.js', '/icon.svg', '/manifest.webmanifest', '/vendor/marked.js', '/vendor/purify.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/apple-touch-icon.png'];
self.addEventListener('install', event => { event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', event => { event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key.startsWith('relaydeck-') && key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  // Conversation data, credentials and API responses are never cached.
  if (url.origin !== self.location.origin || event.request.method !== 'GET' || !SHELL.includes(url.pathname)) return;
  event.respondWith(fetch(event.request).then(response => {
    if (response.ok) { const copy = response.clone(); caches.open(CACHE).then(cache => cache.put(event.request, copy)); }
    return response;
  }).catch(async () => (await caches.match(event.request)) || Response.error()));
});
