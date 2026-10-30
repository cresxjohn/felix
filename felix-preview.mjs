/**
 * Pictures of Felix's workbench changes: instead of a list of files, the chat shows what the change looks like.
 * The workbench copy's pages are served on a second local port, with its own page files and your Felix's data
 * (anything else is passed on to your Felix, read-only), and headless Chrome takes a picture of the page the
 * change touched. Server changes don't show: the data still comes from your Felix as it is now.
 */
import { spawn as nodeSpawn, execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdir, mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const SHOT_MS = 60_000;
const KEEP = 10;
const SIZE = "1440,1000";
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

/**
 * @typedef {import("./felix-workbench.mjs").Change} Change
 */

/**
 * The page that shows a change best: the PR page or Settings when their own file changed, else the home page,
 * which carries the shared bar, cards and chat. Null when no page file changed, so there's nothing to see.
 * @param {Change[]} changes
 * @returns {string | null}
 */
export function pageFor(changes) {
  const files = changes.filter((c) => c.status !== "deleted").map((c) => c.path).filter((p) => p.startsWith("public/"));
  if (!files.length) return null;
  if (files.every((f) => f === "public/index.html")) return "/prs";
  if (files.every((f) => f === "public/settings.html" || f === "public/settings-schema.mjs")) return "/settings";
  return "/";
}

/**
 * Chrome's arguments for one picture of a page.
 * @param {string} url
 * @param {string} file Where the picture goes.
 * @param {string} profile A fresh, throwaway Chrome profile.
 * @param {boolean} dark Whether to draw it in dark mode, like this Mac.
 * @returns {string[]}
 */
export function chromeArgs(url, file, profile, dark) {
  return [
    "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--no-default-browser-check",
    `--user-data-dir=${profile}`, `--window-size=${SIZE}`, "--force-device-scale-factor=1", "--virtual-time-budget=8000",
    ...(dark ? ["--force-dark-mode"] : []), `--screenshot=${file}`, url,
  ];
}

/**
 * Whether this Mac is in dark mode.
 * @returns {Promise<boolean>}
 */
function macIsDark() {
  return new Promise((resolve) => execFile("defaults", ["read", "-g", "AppleInterfaceStyle"], (err, out) => resolve(!err && /dark/i.test(out))));
}

/**
 * Creates the preview.
 * @param {{ dir: string, pages: Record<string, string>, apiPort: number, cacheDir: string, port?: number, chrome?: string,
 *   spawnImpl?: typeof nodeSpawn, shotMs?: number, dark?: () => Promise<boolean> }} options `dir` is the workbench copy;
 *   `pages` maps a route to its file in public/, like your Felix's; `apiPort` is your Felix's port.
 */
export function createPreview({ dir, pages, apiPort, cacheDir, port = apiPort + 1, chrome = CHROME, spawnImpl = nodeSpawn,
  shotMs = SHOT_MS, dark = macIsDark }) {
  const publicDir = path.join(dir, "public");
  /** @type {Promise<void> | null} */
  let listening = null;
  let actualPort = port;
  /** @type {Map<string, Promise<string | null>>} */
  const taking = new Map();

  /**
   * The workbench's own file for a request: a page by its route, or a file in public/. Null when it has none.
   * @param {string} pathname
   * @returns {Promise<string | null>}
   */
  async function ownFile(pathname) {
    if (pages[pathname]) return path.join(publicDir, pages[pathname]);
    if (pathname.startsWith("/api/") || pathname === "/sw.js") return null;
    const file = path.resolve(publicDir, `.${decodeURIComponent(pathname)}`);
    if (!file.startsWith(`${publicDir}${path.sep}`)) return null;
    return (await stat(file).catch(() => null))?.isFile() ? file : null;
  }

  /**
   * Answers one request to the preview: its own files, and everything else read from your Felix.
   * @param {import("node:http").IncomingMessage} req
   * @param {import("node:http").ServerResponse} res
   */
  async function handle(req, res) {
    if (req.method !== "GET") {
      res.writeHead(405);
      return res.end();
    }
    const { pathname } = new URL(req.url || "/", "http://localhost");
    const file = await ownFile(pathname);
    if (file) {
      res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
      return res.end(await readFile(file));
    }
    if (pathname === "/sw.js") {
      res.writeHead(404);
      return res.end();
    }
    const out = httpRequest({ host: "127.0.0.1", port: apiPort, path: req.url, method: "GET", headers: { accept: req.headers.accept || "*/*" } }, (answer) => {
      res.writeHead(answer.statusCode || 502, answer.headers);
      answer.pipe(res);
    });
    out.on("error", () => {
      res.writeHead(502);
      res.end();
    });
    out.end();
  }

  /**
   * Starts the preview's server, once.
   * @returns {Promise<void>}
   */
  function serve() {
    listening ||= new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        handle(req, res).catch(() => {
          if (!res.headersSent) res.writeHead(500);
          res.end();
        });
      });
      server.on("error", (e) => {
        listening = null;
        reject(e);
      });
      server.listen(port, "127.0.0.1", () => {
        actualPort = /** @type {import("node:net").AddressInfo} */ (server.address()).port;
        resolve();
      });
      server.unref();
    });
    return listening;
  }

  /**
   * Takes a picture of one page with headless Chrome.
   * @param {string} route
   * @param {string} file
   * @returns {Promise<boolean>} Whether a picture was made.
   */
  async function capture(route, file) {
    await serve();
    const profile = await mkdtemp(path.join(tmpdir(), "felix-preview-"));
    try {
      const args = chromeArgs(`http://127.0.0.1:${actualPort}${route}`, file, profile, await dark());
      await new Promise((resolve) => {
        const proc = spawnImpl(chrome, args, { stdio: "ignore" });
        const timer = setTimeout(() => proc.kill(), shotMs);
        proc.on("error", () => resolve(undefined));
        proc.on("close", () => {
          clearTimeout(timer);
          resolve(undefined);
        });
      });
      return Boolean((await stat(file).catch(() => null))?.size);
    } finally {
      await rm(profile, { recursive: true, force: true }).catch(() => {});
    }
  }

  /**
   * A picture of a page of the workbench, taken once for each version of its changes.
   * @param {string} route The page, from pageFor().
   * @param {string} key Names this version of the changes, like a hash of their diff.
   * @returns {Promise<string | null>} The picture's file, or null when Chrome couldn't make one.
   */
  function shot(route, key) {
    const file = path.join(cacheDir, `${key}.png`);
    const found = taking.get(file);
    if (found) return found;
    const run = (async () => {
      if ((await stat(file).catch(() => null))?.size) return file;
      await mkdir(cacheDir, { recursive: true });
      const made = await capture(route, file);
      await prune();
      return made ? file : null;
    })().finally(() => taking.delete(file));
    taking.set(file, run);
    return run;
  }

  /**
   * Keeps only the newest pictures.
   * @returns {Promise<void>}
   */
  async function prune() {
    const names = (await readdir(cacheDir).catch(() => [])).filter((n) => n.endsWith(".png"));
    const dated = await Promise.all(names.map(async (n) => ({ n, at: (await stat(path.join(cacheDir, n)).catch(() => null))?.mtimeMs || 0 })));
    const old = dated.sort((a, b) => b.at - a.at).slice(KEEP);
    await Promise.all(old.map(({ n }) => rm(path.join(cacheDir, n), { force: true })));
  }

  return { shot, serve, address: () => actualPort };
}
