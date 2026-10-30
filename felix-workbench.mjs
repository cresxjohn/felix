/**
 * Felix's workbench: his own copy of the Felix app, where his AI works. It can change anything in the copy
 * without asking, since nothing real changes there; your Felix only changes when you click Apply, which copies
 * the changes over without committing them. The copy is a git repo of its own, so its changes are a plain diff
 * against Felix as it was when the copy last caught up. Felix's memory lives in it too, out of that diff.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { copyFile, mkdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import path from "node:path";

export const KEPT_OUT = Object.freeze(["memory/", "data/", "node_modules/"]);
const BASE_MESSAGE = "Felix as it is now";

/**
 * @typedef {{ path: string, status: string }} Change One changed file and how: "added", "changed" or "deleted".
 * @typedef {(cwd: string, args: string[], input?: string) => Promise<string>} Git
 */

/**
 * Runs git and returns what it printed; it fails with git's own words.
 * @param {typeof nodeSpawn} spawnImpl
 * @returns {Git}
 */
export function gitRunner(spawnImpl = nodeSpawn) {
  return (cwd, args, input) => new Promise((resolve, reject) => {
    const proc = spawnImpl("git", args, { cwd, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    proc.stdout?.on("data", (d) => { out += d; });
    proc.stderr?.on("data", (d) => { err += d; });
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(err.trim() || `git ${args[0]} failed`))));
    proc.stdin?.end(input ?? "");
  });
}

/**
 * A file's status in `git status --porcelain` words.
 * @param {string} code
 * @returns {string}
 */
const statusOf = (code) => (code.includes("D") ? "deleted" : code.includes("?") || code.includes("A") ? "added" : "changed");

/**
 * The changed files in `git status --porcelain -z` output.
 * @param {string} out
 * @returns {Change[]}
 */
export function parseStatus(out) {
  const parts = out.split("\0").filter(Boolean);
  /** @type {Change[]} */
  const changes = [];
  for (let i = 0; i < parts.length; i += 1) {
    const code = parts[i].slice(0, 2);
    changes.push({ path: parts[i].slice(3), status: statusOf(code) });
    if (code.startsWith("R")) i += 1;
  }
  return changes;
}

/**
 * Whether a copy of the file at `from` is out of date at `to`.
 * @param {string} from
 * @param {string} to
 * @returns {Promise<boolean>}
 */
async function stale(from, to) {
  const [a, b] = await Promise.all([stat(from), stat(to).catch(() => null)]);
  return !b || a.size !== b.size || Math.trunc(a.mtimeMs) !== Math.trunc(b.mtimeMs);
}

/**
 * Creates Felix's workbench.
 * @param {{ repo: string, dir: string, skip?: string[], git?: Git }} options `skip` lists top folders of the repo
 *   that aren't part of Felix, like an editor's own folder.
 */
export function createWorkbench({ repo, dir, skip = [], git = gitRunner() }) {
  const memory = path.join(dir, "memory");
  const skipped = (file) => skip.some((s) => file === s || file.startsWith(`${s}/`));

  /**
   * The files that make up Felix: tracked and new ones, not the ignored ones.
   * @param {string} cwd
   * @param {string[]} [args]
   * @returns {Promise<string[]>}
   */
  async function filesIn(cwd, args = ["-co", "--exclude-standard"]) {
    return (await git(cwd, ["ls-files", "-z", ...args])).split("\0").filter((f) => f && !skipped(f));
  }

  /**
   * The copy's changed files, against Felix as it was when the copy last caught up.
   * @returns {Promise<Change[]>}
   */
  async function changes() {
    return parseStatus(await git(dir, ["status", "--porcelain", "-z", "--untracked-files=all"]));
  }

  /**
   * Starts the copy: a git repo of its own, with Felix's memory kept out of its changes.
   * @returns {Promise<void>}
   */
  async function create() {
    await mkdir(memory, { recursive: true });
    await git(dir, ["init", "-q"]);
    await writeFile(path.join(dir, ".git", "info", "exclude"), `${KEPT_OUT.join("\n")}\n`);
    await git(dir, ["config", "user.name", "Felix"]);
    await git(dir, ["config", "user.email", "felix@localhost"]);
  }

  /**
   * Brings the copy up to date with Felix and makes that the starting point of its changes. Only a copy with no
   * changes of its own catches up, so nothing it's working on is lost.
   * @returns {Promise<boolean>} Whether it caught up.
   */
  async function sync() {
    const fresh = await stat(path.join(dir, ".git")).then(() => false, () => true);
    if (fresh) await create();
    if (!fresh && (await changes()).length) return false;
    const [wanted, had] = await Promise.all([filesIn(repo), fresh ? [] : filesIn(dir, [])]);
    const keep = new Set(wanted);
    await Promise.all(had.filter((f) => !keep.has(f)).map((f) => rm(path.join(dir, f), { force: true })));
    for (const file of wanted) await copyOver(path.join(repo, file), path.join(dir, file));
    await git(dir, ["add", "-A"]);
    if ((await changes()).length) await git(dir, ["commit", "-q", "--no-verify", "-m", BASE_MESSAGE]);
    return true;
  }

  /**
   * Copies one file into the copy when it's out of date there, keeping its time so the next check is cheap.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<void>}
   */
  async function copyOver(from, to) {
    if (!(await stale(from, to).catch(() => false))) return;
    await mkdir(path.dirname(to), { recursive: true });
    await copyFile(from, to);
    const { atime, mtime } = await stat(from);
    await utimes(to, atime, mtime);
  }

  /**
   * The copy's changes as a patch your Felix can take.
   * @returns {Promise<string>}
   */
  async function diff() {
    await git(dir, ["add", "-A"]);
    return git(dir, ["diff", "--cached", "--binary", "HEAD"]);
  }

  /**
   * Copies the copy's changes into your Felix, without committing them, then makes them the copy's new start.
   * Nothing changes when the patch doesn't fit Felix as it is now.
   * @returns {Promise<Change[]>} The files it changed.
   */
  async function apply() {
    const changed = await changes();
    if (!changed.length) return [];
    const patch = await diff();
    await git(repo, ["apply", "--check", "-"], patch);
    await git(repo, ["apply", "-"], patch);
    await git(dir, ["commit", "-q", "--no-verify", "-m", "Applied to Felix"]);
    return changed;
  }

  /**
   * Drops the copy's changes. Felix's memory stays.
   * @returns {Promise<void>}
   */
  async function discard() {
    await git(dir, ["reset", "-q", "--hard", "HEAD"]);
    await git(dir, ["clean", "-q", "-fd"]);
  }

  return { dir, memory, sync, changes, diff, apply, discard };
}
