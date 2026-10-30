/**
 * Checks that Chrome can save the launcher for an installed Felix. On a Mac, Chrome puts every web app's launcher
 * in ~/Applications/Chrome Apps.localized. When it can't write there, the app has no launcher of its own, so opening
 * it brings another app's window forward instead of Felix's.
 */
import { access } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

/**
 * Whether a path exists.
 * @param {string} p
 * @returns {Promise<boolean>}
 */
const exists = (p) => access(p).then(() => true, () => false);

/**
 * Whether this user can write in a folder.
 * @param {string} dir
 * @returns {Promise<boolean>}
 */
const writable = (dir) => access(dir, constants.W_OK).then(() => true, () => false);

/**
 * A path under the home folder as the user would type it, with the home folder as ~.
 * @param {string} p
 * @param {string} home
 * @returns {string}
 */
const tilde = (p, home) => `~${p.slice(home.length)}`;

/**
 * Finds the folder Chrome would write the launcher in: the launchers folder when it exists, else the nearest
 * folder above it, where Chrome would create it.
 * @param {string[]} folders From the deepest to the home folder.
 * @param {(p: string) => Promise<boolean>} isThere
 * @returns {Promise<string>}
 */
async function nearestFolder(folders, isThere) {
  for (const folder of folders.slice(0, -1)) if (await isThere(folder)) return folder;
  return folders.at(-1);
}

/**
 * Checks the launchers folder.
 * @param {object} [deps]
 * @param {string} [deps.home] The user's home folder.
 * @param {string} [deps.platform] Only a Mac ("darwin") is checked.
 * @param {(p: string) => Promise<boolean>} [deps.isThere]
 * @param {(dir: string) => Promise<boolean>} [deps.canWrite]
 * @returns {Promise<{ checked: boolean, ok: boolean, folder?: string, fix?: string }>} When not ok, folder is the
 *   one Chrome can't write in and fix is the Terminal command that gives it back to this user.
 */
export async function launcherCheck({ home = homedir(), platform = process.platform, isThere = exists, canWrite = writable } = {}) {
  if (platform !== "darwin") return { checked: false, ok: true };
  const apps = path.join(home, "Applications");
  const folder = await nearestFolder([path.join(apps, "Chrome Apps.localized"), apps, home], isThere);
  const shown = tilde(folder, home);
  if (await canWrite(folder)) return { checked: true, ok: true, folder: shown };
  return { checked: true, ok: false, folder: shown, fix: `sudo chown "$USER" ${shown.replace(/ /g, "\\ ")}` };
}
