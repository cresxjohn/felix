/**
 * Felix's restart guard. After Felix applies a change to himself (or undoes one), he can't check his own restart:
 * the process doing the checking is the one being replaced. So he starts this small program on its own, apart
 * from him, which restarts Felix, waits for the new Felix to answer, and when he doesn't come back healthy, puts
 * the change back and restarts him again. What happened is written next to the saved change, for Felix to tell
 * you when the page loads again.
 *
 *   node felix-guard.mjs --repo <felix folder> --dir <data/felix> --port 4777 --pid <old pid> --why apply|undo
 */
import { spawn as nodeSpawn } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gitRunner } from "./felix-workbench.mjs";

const WAIT_MS = 45_000;
const EVERY_MS = 1000;
const CHECK_MS = 3000;

/**
 * Where an apply is kept: the change as a patch, and what happened to it.
 * @param {string} dir Felix's data folder.
 * @returns {{ patch: string, status: string }}
 */
export const applyFiles = (dir) => ({ patch: path.join(dir, "applies", "last.patch"), status: path.join(dir, "applies", "last.json") });

/**
 * @typedef {{ state: string, at?: string, files?: string[], why?: string, checkedAt?: string, undoneAt?: string }} ApplyStatus `state` is
 *   "restarting", "ok" (applied and Felix came back), "undoing", "undone", "rolled-back" (he didn't come back, so
 *   the change was put back) or "broken" (he didn't come back either way).
 */

/**
 * Waits until Felix answers healthy, or the time runs out.
 * @param {() => Promise<boolean>} healthy
 * @param {{ waitMs: number, everyMs: number, sleep: (ms: number) => Promise<void> }} timing
 * @returns {Promise<boolean>}
 */
async function cameBack(healthy, { waitMs, everyMs, sleep }) {
  for (let waited = 0; waited <= waitMs; waited += everyMs) {
    if (await healthy().catch(() => false)) return true;
    await sleep(everyMs);
  }
  return false;
}

/**
 * Restarts Felix and checks he comes back. After an apply that broke him, the change is put back and he's
 * restarted again; after an undo there's nothing to put back, so it just says so.
 * @param {{ why: "apply" | "undo", restart: () => Promise<void>, healthy: () => Promise<boolean>, rollback: () => Promise<void>,
 *   setState: (status: Partial<ApplyStatus>) => Promise<void>, waitMs?: number, everyMs?: number, sleep?: (ms: number) => Promise<void> }} options
 * @returns {Promise<string>} The state it ended in.
 */
export async function guard({ why, restart, healthy, rollback, setState, waitMs = WAIT_MS, everyMs = EVERY_MS,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const timing = { waitMs, everyMs, sleep };
  const finish = async (state, reason) => {
    await setState({ state, checkedAt: new Date().toISOString(), ...(reason ? { why: reason } : {}) });
    return state;
  };
  await restart().catch(() => {});
  if (await cameBack(healthy, timing)) return finish(why === "undo" ? "undone" : "ok");
  if (why !== "apply") return finish("broken", "Felix didn't come back healthy after the undo.");
  try {
    await rollback();
  } catch (e) {
    return finish("broken", `Felix didn't come back healthy, and the change couldn't be put back: ${e.message}`);
  }
  await restart().catch(() => {});
  return (await cameBack(healthy, timing))
    ? finish("rolled-back", "Felix didn't come back healthy after the change, so it was put back.")
    : finish("broken", "Felix didn't come back healthy, even with the change put back.");
}

/**
 * Whether the new Felix answers: his health check says he's up and isn't the old process, and his home page loads.
 * @param {{ port: number, oldPid: number, fetchImpl?: typeof fetch }} options
 * @returns {() => Promise<boolean>}
 */
export function healthCheck({ port, oldPid, fetchImpl = fetch }) {
  const base = `http://127.0.0.1:${port}`;
  return async () => {
    const health = await fetchImpl(`${base}/api/health`, { signal: AbortSignal.timeout(CHECK_MS) });
    if (!health.ok) return false;
    const body = await health.json();
    if (!body.ok || Number(body.pid) === oldPid) return false;
    return (await fetchImpl(`${base}/`, { signal: AbortSignal.timeout(CHECK_MS) })).ok;
  };
}

/**
 * Restarts Felix with ./prs restart, without opening a page, and waits for it to finish.
 * @param {string} repo
 * @param {typeof nodeSpawn} [spawnImpl]
 * @returns {() => Promise<void>}
 */
export function prsRestart(repo, spawnImpl = nodeSpawn) {
  return () => new Promise((resolve) => {
    const proc = spawnImpl(path.join(repo, "prs"), ["restart"], { cwd: repo, stdio: "ignore", env: { ...process.env, NO_OPEN: "1" } });
    proc.on("error", () => resolve());
    proc.on("close", () => resolve());
  });
}

/**
 * Merges what happened into the saved apply's status.
 * @param {string} file
 * @returns {(status: Partial<ApplyStatus>) => Promise<void>}
 */
export function statusWriter(file) {
  return async (status) => {
    const before = await readFile(file, "utf8").then(JSON.parse, () => ({}));
    await writeFile(file, `${JSON.stringify({ ...before, ...status }, null, 2)}\n`);
  };
}

/**
 * Runs the guard from the command line, as Felix starts it.
 * @param {string[]} argv
 * @param {{ spawnImpl?: typeof nodeSpawn, fetchImpl?: typeof fetch, git?: import("./felix-workbench.mjs").Git, waitMs?: number,
 *   everyMs?: number }} [deps]
 * @returns {Promise<string>}
 */
export async function main(argv, { spawnImpl = nodeSpawn, fetchImpl = fetch, git = gitRunner(), waitMs, everyMs } = {}) {
  const { values } = parseArgs({ args: argv, options: { repo: { type: "string" }, dir: { type: "string" }, port: { type: "string" }, pid: { type: "string" }, why: { type: "string" } } });
  const files = applyFiles(String(values.dir));
  return guard({
    why: values.why === "undo" ? "undo" : "apply",
    restart: prsRestart(String(values.repo), spawnImpl),
    healthy: healthCheck({ port: Number(values.port), oldPid: Number(values.pid), fetchImpl }),
    rollback: async () => git(String(values.repo), ["apply", "-R", "-"], await readFile(files.patch, "utf8")),
    setState: statusWriter(files.status),
    waitMs,
    everyMs,
  });
}

// Run from the command line, Felix starts it; imported (by the tests and the agent), nothing runs.
/* node:coverage ignore next 4 */
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((e) => console.error(`Felix's restart guard failed: ${e.message}`));
}
