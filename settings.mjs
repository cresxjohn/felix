/**
 * Felix's settings, kept in data/settings.json so they travel with the backup. Reads go through a copy in
 * memory; every change is checked against public/settings-schema.mjs and written straight to disk.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { cleanSettings, defaultSettings, patchProblems, SETTINGS } from "./public/settings-schema.mjs";

/**
 * An error the server answers with 400 and its message.
 * @param {string} message
 * @returns {Error & { status: number }}
 */
const invalid = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * Writes a file in one step, so a crash never leaves half a file.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeAtomic(file, text) {
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

/**
 * Builds the settings store.
 * @param {object} deps
 * @param {string} deps.file Where the settings live.
 * @param {(file: string, encoding: "utf8") => Promise<string>} [deps.read]
 * @param {(file: string, text: string) => Promise<void>} [deps.write]
 * @returns {{ get: () => Promise<Record<string, unknown>>, update: (patch: unknown) => Promise<Record<string, unknown>>,
 *   reset: (keys?: unknown) => Promise<Record<string, unknown>>, onChange: (listener: (values: Record<string, unknown>) => void) => () => void }}
 */
export function createSettings({ file, read = readFile, write = writeAtomic }) {
  let current = null;
  let saving = Promise.resolve();
  const listeners = new Set();

  const load = async () => {
    if (!current) current = cleanSettings(await read(file, "utf8").then(JSON.parse).catch(() => null));
    return current;
  };

  const save = async (next) => {
    current = next;
    const text = `${JSON.stringify(next, null, 2)}\n`;
    saving = saving.catch(() => {}).then(() => write(file, text));
    await saving;
    // A listener that throws doesn't stop the save or the other listeners.
    for (const listener of listeners) try { listener({ ...next }); } catch {}
    return { ...next };
  };

  return {
    get: async () => ({ ...(await load()) }),
    async update(patch) {
      const problems = patchProblems(patch);
      if (problems.length) throw invalid(problems.join(" "));
      return save({ ...(await load()), ...patch });
    },
    async reset(keys) {
      const known = new Set(SETTINGS.map((s) => s.key));
      const list = keys === undefined ? [...known] : keys;
      if (!Array.isArray(list) || list.some((k) => !known.has(k))) throw invalid("Name the settings to reset by their keys.");
      const defaults = defaultSettings();
      return save({ ...(await load()), ...Object.fromEntries(list.map((k) => [k, defaults[k]])) });
    },
    /**
     * Calls `listener` with every setting after each saved change, for parts of the server that follow a setting.
     * @param {(values: Record<string, unknown>) => void} listener
     * @returns {() => void} Stops listening.
     */
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
