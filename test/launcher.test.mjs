import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { launcherCheck } from "../launcher.mjs";

/**
 * A fake file system for launcherCheck: the folders that exist and the ones this user can write in.
 * @param {string[]} there
 * @param {string[]} writable
 * @returns {{ isThere: (p: string) => Promise<boolean>, canWrite: (p: string) => Promise<boolean> }}
 */
const fakeFs = (there, writable) => ({
  isThere: async (p) => there.includes(p),
  canWrite: async (p) => writable.includes(p),
});

const HOME = "/Users/me";
const APPS = `${HOME}/Applications`;
const CHROME_APPS = `${APPS}/Chrome Apps.localized`;

test("launcherCheck is skipped off a Mac", async () => {
  assert.deepEqual(await launcherCheck({ platform: "linux" }), { checked: false, ok: true });
});

test("launcherCheck is fine when the Chrome Apps folder is writable", async () => {
  const check = await launcherCheck({ home: HOME, platform: "darwin", ...fakeFs([CHROME_APPS, APPS], [CHROME_APPS]) });
  assert.deepEqual(check, { checked: true, ok: true, folder: "~/Applications/Chrome Apps.localized" });
});

test("launcherCheck gives the chown fix when another user owns ~/Applications", async () => {
  const check = await launcherCheck({ home: HOME, platform: "darwin", ...fakeFs([APPS], [HOME]) });
  assert.deepEqual(check, { checked: true, ok: false, folder: "~/Applications", fix: `sudo chown "$USER" ~/Applications` });
});

test("launcherCheck escapes spaces in the fix", async () => {
  const check = await launcherCheck({ home: HOME, platform: "darwin", ...fakeFs([CHROME_APPS], []) });
  assert.equal(check.fix, `sudo chown "$USER" ~/Applications/Chrome\\ Apps.localized`);
});

test("launcherCheck falls back to the home folder, where Chrome would make ~/Applications", async () => {
  const check = await launcherCheck({ home: HOME, platform: "darwin", ...fakeFs([], [HOME]) });
  assert.deepEqual(check, { checked: true, ok: true, folder: "~" });
});

test("launcherCheck reads the real file system by default", async () => {
  const home = mkdtempSync(path.join(tmpdir(), "felix-launcher-"));
  try {
    mkdirSync(path.join(home, "Applications"));
    assert.deepEqual(await launcherCheck({ home, platform: "darwin" }), { checked: true, ok: true, folder: "~/Applications" });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
