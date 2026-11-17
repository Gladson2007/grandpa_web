/* =========================================================
   sw.js: lets the site open even when the internet is off.
   - your own files (index.html, app.js): always the newest one
     when online, the saved copy when offline
   - the Supabase library: downloaded once, then kept
   - photos/videos are NOT handled here: they live in the browser's
     own storage (see app.js)
   ========================================================= */
const CACHE = "grandpa-memories-v1";
const SHELL = ["./", "./index.html", "./app.js"];
const CDN = ["https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"];

function clean(url) {
  const u = new URL(url, self.location.href);
  u.search = "";
  u.hash = "";
  return u.href;
}

function timeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); }
    );
  });
}

self.addEventListener("install", event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);

    await Promise.allSettled([
      ...SHELL.map(url => cache.add(new Request(url, { cache: "reload" }))),
      ...CDN.map(url => cache.add(url))
    ]);

    self.skipWaiting();
  })());
});

self.addEventListener("activate", event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(name => name !== CACHE).map(name => caches.delete(name)));
    await self.clients.claim();
  })());
});

async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  const key = clean(request.url);

  try {
    const response = await timeout(fetch(request), 4000);
    if (response.ok) cache.put(key, response.clone());
    return response;
  } catch (error) {
    const hit =
      (await cache.match(key)) ||
      (request.mode === "navigate" &&
        ((await cache.match("./")) || (await cache.match("./index.html"))));

    return hit || Response.error();
  }
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(request.url);
  if (hit) return hit;

  try {
    const response = await fetch(request.url);
    if (response.ok) cache.put(request.url, response.clone());
    return response;
  } catch (error) {
    return Response.error();
  }
}

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.has("range")) return;

  const url = new URL(request.url);
  const local = url.origin === self.location.origin;

  // Supabase (database + storage) always goes straight to the network
  if (!local && !CDN.includes(url.href)) return;

  event.respondWith(local ? networkFirst(request) : cacheFirst(request));
});