import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const manifest = JSON.parse(readFileSync(path.join(PUBLIC, "manifest.webmanifest"), "utf8"));

/**
 * Reads a PNG's width and height from its IHDR chunk.
 * @param {string} file Path under public/.
 * @returns {string} Size as "WxH".
 */
function pngSize(file) {
  const png = readFileSync(path.join(PUBLIC, file));
  return `${png.readUInt32BE(16)}x${png.readUInt32BE(20)}`;
}

test("the manifest opens Felix as a standalone app at the home page", () => {
  assert.equal(manifest.name, "Felix");
  assert.equal(manifest.display, "standalone");
  assert.equal(manifest.start_url, "/");
  assert.equal(manifest.scope, "/");
  assert.match(manifest.theme_color, /^#[0-9A-F]{6}$/i);
});

test("the manifest has 192 and 512 icons for both plain and maskable use", () => {
  for (const purpose of ["any", "maskable"]) {
    const sizes = manifest.icons.filter((i) => i.purpose === purpose).map((i) => i.sizes);
    assert.deepEqual(sizes.sort(), ["192x192", "512x512"], purpose);
  }
});

test("every icon the manifest names exists at its stated size", () => {
  const icons = [...manifest.icons, ...manifest.shortcuts.flatMap((s) => s.icons)];
  for (const icon of icons) {
    assert.ok(existsSync(path.join(PUBLIC, icon.src)), icon.src);
    assert.equal(pngSize(icon.src), icon.sizes, icon.src);
  }
  assert.equal(pngSize("/icons/apple-touch-icon.png"), "180x180");
});

test("a wide screenshot exists at its stated size, so Chrome shows the detailed install dialog", () => {
  const wide = manifest.screenshots.filter((s) => s.form_factor === "wide");
  assert.ok(wide.length > 0);
  for (const shot of wide) assert.equal(pngSize(shot.src), shot.sizes, shot.src);
});

test("shortcuts stay inside the app", () => {
  for (const s of manifest.shortcuts) assert.ok(s.url.startsWith(manifest.scope), s.url);
});
