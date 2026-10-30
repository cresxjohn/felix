/**
 * Felix's service worker. Pages and shared files always come from the server first, so edits show on
 * reload; a copy is kept so the app window still opens, with its last data, while the server is down.
 * API calls are never touched: the pages handle those, and keep their own last answers.
 * A window's own page load gets Felix's outer page (X-Felix-Host), the same for every address, so it is kept once
 * under its own key instead of over the page it frames.
 */
const CACHE = "felix-v25";
const OFFLINE = "/offline.html";
const HOST_KEY = "/__felix-host";
const PRECACHE = [
  "/",
  "/prs",
  "/settings",
  OFFLINE,
  "/theme.css",
  "/shell.css",
  "/shell.js",
  "/pr-status.js",
  "/layout.js",
  "/cards.js",
  "/dropdown.js", "/ai-models.js",
  "/music.js", "/music.css",
  "/felix-voice.js", "/felix.js", "/felix-hints.js", "/felix-idle.js", "/pickers.js", "/reorder.js", "/voice-device.js",
  "/music-signed-in",
  "/settings-schema.mjs", "/journal-prompts.mjs", "/places.mjs", "/wais-choices.mjs", "/felix-progress.mjs", "/felix-diff.mjs", "/felix-wake-clips.mjs", "/card-load.mjs",
  "/app.js",
  "/manifest.webmanifest",
  "/icons/icon.svg",
  "/icons/icon-192.png",
  "/icons/icon-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

/**
 * Whether the service worker answers this request: same-origin GETs, except the API and Felix's voice files.
 * @param {Request} request
 * @returns {boolean}
 */
function handles(request) {
  const url = new URL(request.url);
  // Felix's voice files (hundreds of MB) are kept by the page itself, in the caches Kokoro reads; a second copy
  // here would only double the space they take.
  return request.method === "GET" && url.origin === self.location.origin && !url.pathname.startsWith("/api/") && !url.pathname.startsWith("/voice-web/");
}

/**
 * The saved page that can stand in for a page that was never saved itself: every /prs view is one page.
 * @param {string} pathname
 * @returns {string}
 */
function shellFor(pathname) {
  return pathname === "/prs" || pathname.startsWith("/prs/") ? "/prs" : "/";
}

/**
 * The saved answer for a request made while the server is down.
 * @param {Cache} cache
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function fallback(cache, request) {
  if (request.mode !== "navigate") return (await cache.match(request)) || Response.error();
  const page = (await cache.match(request, { ignoreSearch: true })) || (await cache.match(shellFor(new URL(request.url).pathname)));
  return page || (await cache.match(OFFLINE)) || Response.error();
}

/**
 * The request to send on to the server. A page load passed on from here reaches the server as
 * Sec-Fetch-Dest "empty", so it carries its real destination (a window or a frame) in X-Felix-Dest.
 * @param {Request} request
 * @returns {Request}
 */
function forServer(request) {
  return request.mode === "navigate" ? new Request(request, { headers: { "X-Felix-Dest": request.destination } }) : request;
}

/**
 * Asks the server first and saves good answers; falls back to the saved copy when the server is down.
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirst(request) {
  const cache = await caches.open(CACHE);
  try {
    const response = await fetch(forServer(request));
    const key = response.headers.get("X-Felix-Host") ? HOST_KEY : request;
    if (response.ok && !response.redirected) cache.put(key, response.clone());
    return response;
  } catch {
    const outer = request.destination === "document" ? await cache.match(HOST_KEY) : null;
    return outer || fallback(cache, request);
  }
}

self.addEventListener("fetch", (event) => {
  if (handles(event.request)) event.respondWith(networkFirst(event.request));
});
