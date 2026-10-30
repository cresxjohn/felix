import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { chromeArgs, createPreview, pageFor } from "../felix-preview.mjs";

const PAGES = { "/": "home.html", "/prs": "index.html" };

/**
 * A pretend workbench with two pages and a script, a pretend Felix answering /api, and a preview of them.
 * Chrome is pretend too: it writes a picture to the file it's asked for, or nothing when `fail` is set.
 * @param {{ fail?: boolean }} [options]
 */
async function withPreview({ fail = false } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "felix-preview-test-"));
  const dir = path.join(root, "workbench");
  await mkdir(path.join(dir, "public"), { recursive: true });
  await writeFile(path.join(dir, "public/home.html"), "<p>new home</p>");
  await writeFile(path.join(dir, "public/index.html"), "<p>prs</p>");
  await writeFile(path.join(dir, "public/cards.js"), "export {}");
  await writeFile(path.join(root, "secret.txt"), "no");
  const api = createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ from: "felix", url: req.url }));
  });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const apiPort = /** @type {import("node:net").AddressInfo} */ (api.address()).port;
  const runs = [];
  const spawnImpl = (bin, args) => {
    runs.push({ bin, args });
    const proc = Object.assign(new EventEmitter(), { kill: () => {} });
    const file = args.find((a) => a.startsWith("--screenshot="))?.slice("--screenshot=".length);
    setImmediate(async () => {
      if (!fail && file) await writeFile(file, "png");
      proc.emit("close", 0);
    });
    return proc;
  };
  const cacheDir = path.join(root, "previews");
  const preview = createPreview({ dir, pages: PAGES, apiPort, cacheDir, port: 0, spawnImpl, dark: async () => true });
  return {
    preview, runs, cacheDir, apiPort,
    done: async () => {
      api.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("the page a change shows on: the PR page or Settings for their own file, else home, and none without a page change", () => {
  assert.equal(pageFor([{ path: "public/index.html", status: "changed" }]), "/prs");
  assert.equal(pageFor([{ path: "public/settings.html", status: "changed" }, { path: "public/settings-schema.mjs", status: "added" }]), "/settings");
  assert.equal(pageFor([{ path: "public/index.html", status: "changed" }, { path: "public/shell.css", status: "changed" }]), "/");
  assert.equal(pageFor([{ path: "server.mjs", status: "changed" }, { path: "public/old.js", status: "deleted" }]), null);
  assert.equal(pageFor([]), null);
});

test("Chrome takes one headless picture at desktop size, in dark mode when the Mac is", () => {
  const args = chromeArgs("http://127.0.0.1:4778/", "/tmp/a.png", "/tmp/profile", true);
  assert.ok(args.includes("--headless=new"));
  assert.ok(args.includes("--force-dark-mode"));
  assert.ok(args.includes("--screenshot=/tmp/a.png"));
  assert.ok(args.includes("--user-data-dir=/tmp/profile"));
  assert.equal(args.at(-1), "http://127.0.0.1:4778/");
  assert.equal(chromeArgs("u", "f", "p", false).includes("--force-dark-mode"), false);
});

test("the preview serves the workbench's own pages and files, reads everything else from Felix, and changes nothing", async () => {
  const { preview, done } = await withPreview();
  await preview.serve();
  const port = preview.address();
  const get = async (p, init) => {
    const res = await fetch(`http://127.0.0.1:${port}${p}`, init);
    return { status: res.status, text: await res.text() };
  };
  assert.equal((await get("/")).text, "<p>new home</p>");
  assert.equal((await get("/prs")).text, "<p>prs</p>");
  assert.equal((await get("/cards.js")).text, "export {}");
  assert.deepEqual(JSON.parse((await get("/api/prs?x=1")).text), { from: "felix", url: "/api/prs?x=1" });
  assert.equal((await get("/sw.js")).status, 404);
  assert.equal((await get("/%2e%2e/secret.txt")).text.includes("no"), false);
  assert.equal((await get("/api/merge", { method: "POST", body: "{}" })).status, 405);
  await done();
});

test("a picture is taken once for each version of the changes, and old ones are cleared", async () => {
  const { preview, runs, cacheDir, done } = await withPreview();
  const [a, again] = await Promise.all([preview.shot("/prs", "v1"), preview.shot("/prs", "v1")]);
  assert.equal(a, path.join(cacheDir, "v1.png"));
  assert.equal(again, a);
  assert.equal(await preview.shot("/prs", "v1"), a);
  assert.equal(runs.length, 1);
  assert.match(runs[0].args.at(-1), /\/prs$/);
  for (let i = 2; i <= 12; i += 1) await preview.shot("/", `v${i}`);
  assert.equal((await readdir(cacheDir)).length, 10);
  await done();
});

test("when Chrome makes no picture, there's none to show", async () => {
  const { preview, done } = await withPreview({ fail: true });
  assert.equal(await preview.shot("/", "v1"), null);
  await done();
});
