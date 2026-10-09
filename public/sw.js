// Shows the offline page when a page load fails because there is no connection. Only the offline page and what it needs are stored.
const CACHE = "offline-v4";
const REQUIRED = ["/offline.html", "/state.css", "/fonts.js"];
const OPTIONAL = [300, 400, 500, 600, 700].map((w) => `/font/poppins-${w}.woff2`); // a missing font file never blocks the install
const STORED = [...REQUIRED, ...OPTIONAL];

const save = async (cache, url, required) => {
  try {
    const res = await fetch(url, { cache: "reload" });
    if (!res.ok) throw new Error(url);
    await cache.put(url, new Response(res.body, res)); // clean copy: a redirected response cannot answer a page load
  } catch (error) {
    if (required) throw error;
  }
};

const store = async () => {
  const cache = await caches.open(CACHE);
  await Promise.all([...REQUIRED.map((u) => save(cache, u, true)), ...OPTIONAL.map((u) => save(cache, u, false))]);
};

addEventListener("install", (e) => e.waitUntil(store().then(() => skipWaiting())));

addEventListener("activate", (e) => e.waitUntil(
  caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => clients.claim())
));

// The offline page is served only when fetch itself fails (no connection), never for a 404 or a server error.
addEventListener("fetch", (e) => {
  const { request } = e;
  if (request.method !== "GET") return;
  if (request.mode === "navigate") {
    e.respondWith(fetch(request).catch(async () => (await caches.match("/offline.html")) ?? Response.error()));
  } else if (STORED.includes(new URL(request.url).pathname)) {
    e.respondWith(fetch(request).catch(() => caches.match(request, { ignoreSearch: true }).then((r) => r ?? Response.error())));
  }
});
