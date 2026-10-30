/**
 * Felix's toolbox: his built-in tools (felix-tools.mjs) and the ones he builds himself, which live as files in the
 * repo's tools/ folder ("tools/team_leave_year.mjs"), one tool each. A new or changed file is picked up on its own
 * while Felix runs, and each run happens in a worker of its own (felix-tool-worker.mjs), so a deploy never restarts
 * Felix or the app on your iPad, and a broken tool can't take Felix down.
 *
 * Tools are only ever added or extended, never removed: every version is kept in Felix's data folder with a ledger
 * of names, a tool whose file goes missing is put back, a version that won't load falls back to the last good one,
 * and a new version must still take everything the old one took.
 */
import { createHash } from "node:crypto";
import { watch as fsWatch } from "node:fs";
import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Worker as NodeWorker } from "node:worker_threads";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER = path.join(HERE, "felix-tool-worker.mjs");
// How long one run of a tool may take before it's stopped.
const RUN_MS = 90_000;
const DESCRIBE_MS = 10_000;
const WATCH_SETTLE_MS = 300;
export const NAME = /^[a-z][a-z0-9_]{2,47}$/;
// What a tool's file may never do: start programs, reach the Keychain or secret files, or read the environment.
const FORBIDDEN = [
  [/child_process|node:cluster|worker_threads/, "starts programs"],
  [/keychain|Keychains|security\s+find-/i, "reaches the Keychain"],
  [/process\.env|\.ssh\b|\.aws\b|\.gnupg\b|\.env\b/, "reads secrets or the environment"],
  [/process\.exit|process\.kill/, "stops processes"],
];

/**
 * @typedef {{ name: string, description: string, inputSchema: Record<string, any>, step?: string, action?: boolean,
 *   runs?: boolean }} Described What a tool's file says it is.
 * @typedef {Described & { file: string, version: number, mtime: number }} Plugin
 * @typedef {{ createdAt: string, versions: Array<{ version: number, at: string, by: string, job: string | null, sha: string }> }} LedgerEntry
 * @typedef {Record<string, (...args: any[]) => unknown>} Services What a tool's `ctx` reaches, by path ("ooo.out").
 */

/**
 * What a tool's source does that a tool never may, or null. Checked before the file is ever loaded.
 * @param {string} source
 * @returns {string | null}
 */
const forbidden = (source) => {
  const bad = FORBIDDEN.find(([re]) => re.test(source));
  return bad ? `It ${bad[1]}, which Felix's tools never do.` : null;
};

/**
 * Why a tool's file can't be used, or null when it can.
 * @param {string} source
 * @param {Described | null} d
 * @param {string} fileName
 * @returns {string | null}
 */
export function problemWith(source, d, fileName) {
  const bad = forbidden(source);
  if (bad) return bad;
  if (!d) return "It doesn't load.";
  if (!NAME.test(String(d.name))) return "Its name must be lowercase words joined by _, like team_leave_year.";
  if (`${d.name}.mjs` !== fileName) return `Its file must be named ${d.name}.mjs.`;
  if (typeof d.description !== "string" || d.description.trim().length < 20) return "It needs a description that says what it gives back.";
  if (!d.inputSchema || d.inputSchema.type !== "object") return "Its inputSchema must be a JSON schema of type object.";
  if (!d.runs) return "It has no run function.";
  return null;
}

/**
 * Whether a new version still takes everything the old one took: the same inputs, none of them newly required.
 * @param {Record<string, any>} before
 * @param {Record<string, any>} after
 * @returns {string | null} What it drops, or null when it keeps everything.
 */
export function dropsInputs(before, after) {
  const was = Object.keys(before?.properties || {});
  const now = new Set(Object.keys(after?.properties || {}));
  const gone = was.filter((k) => !now.has(k));
  if (gone.length) return `It no longer takes ${gone.join(", ")}.`;
  const required = new Set(before?.required || []);
  const added = (after?.required || []).filter((k) => !required.has(k));
  if (added.length) return `It newly requires ${added.join(", ")}, so the old way of using it would break.`;
  return null;
}

/**
 * Creates the toolbox.
 * @param {{ dir: string, store: string, builtins?: import("./felix-tools.mjs").Tool[], services?: Services,
 *   runMs?: number, now?: () => number, Worker?: typeof NodeWorker }} options `dir` holds the tools' files (in the repo);
 *   `store` keeps their ledger and every version.
 */
export function createToolbox({ dir, store, builtins = [], services = {}, runMs = RUN_MS, now = Date.now, Worker = NodeWorker }) {
  const ledgerFile = path.join(store, "ledger.json");
  const archive = path.join(store, "archive");
  /** @type {Map<string, Plugin>} */
  let plugins = new Map();
  /** @type {Record<string, string>} */
  let problems = {};
  let extra = [];
  let loading = null;
  let watcher = null;

  /** @returns {Promise<{ tools: Record<string, LedgerEntry> }>} */
  const readLedger = () => readFile(ledgerFile, "utf8").then(JSON.parse).catch(() => ({ tools: {} }));
  const builtinNames = () => new Set([...builtins, ...extra].map((t) => t.name));

  /**
   * Runs a tool's file in a worker of its own.
   * @param {string} file
   * @param {"describe" | "card" | "run"} mode
   * @param {Record<string, any>} [args]
   * @param {number} [ms]
   * @returns {Promise<any>}
   */
  function inWorker(file, mode, args = {}, ms = mode === "run" ? runMs : DESCRIBE_MS) {
    return new Promise((resolve, reject) => {
      const w = new Worker(WORKER, { workerData: { file, mode, args }, env: {}, execArgv: [], resourceLimits: { maxOldGenerationSizeMb: 256 } });
      let over = false;
      const end = (fn) => {
        if (over) return;
        over = true;
        clearTimeout(timer);
        w.terminate();
        fn();
      };
      const timer = setTimeout(() => end(() => reject(new Error(mode === "run" ? "It took too long, so I stopped it." : "It took too long to load."))), ms);
      w.on("message", async (msg) => {
        if (msg?.type === "done") return end(() => resolve(msg.value));
        if (msg?.type === "fail") return end(() => reject(new Error(msg.error)));
        if (msg?.type !== "call") return;
        const fn = Object.hasOwn(services, msg.path) ? services[msg.path] : null;
        try {
          if (!fn) throw new Error(`ctx.${msg.path} isn't one of the services a tool can reach.`);
          const value = await fn(...(msg.args || []));
          if (!over) w.postMessage({ id: msg.id, value: JSON.parse(JSON.stringify(value ?? null)) });
        } catch (e) {
          if (!over) w.postMessage({ id: msg.id, error: String(e?.message || e) });
        }
      });
      w.on("error", (e) => end(() => reject(e)));
      w.on("exit", () => end(() => reject(new Error("It stopped without an answer."))));
    });
  }

  /**
   * What a file says it is, and why it can't be used if it can't.
   * @param {string} file
   * @returns {Promise<{ tool: Described | null, problem: string | null }>}
   */
  async function check(file) {
    const source = await readFile(file, "utf8").catch(() => "");
    if (!source) return { tool: null, problem: "The file is empty or missing." };
    if (forbidden(source)) return { tool: null, problem: forbidden(source) };
    const tool = await inWorker(file, "describe").catch(() => null);
    return { tool, problem: problemWith(source, tool, path.basename(file)) || (tool && builtinNames().has(tool.name) ? `${tool.name} is one of Felix's built-in tools.` : null) };
  }

  /**
   * The newest kept version of a tool, or null.
   * @param {string} name
   * @param {LedgerEntry} [entry]
   * @returns {string | null}
   */
  const keptFile = (name, entry) => (entry?.versions?.length ? path.join(archive, name, `v${entry.versions.at(-1).version}.mjs`) : null);

  /**
   * Writes a file in one step, so the watcher never loads half of it.
   * @param {string} from
   * @param {string} to
   */
  async function place(from, to) {
    const tmp = path.join(path.dirname(to), `.${path.basename(to)}.${process.pid}.tmp`);
    await copyFile(from, tmp);
    await rename(tmp, to);
  }

  /**
   * Loads every tool in the folder. A tool in the ledger whose file is missing, or whose file doesn't load, is put
   * back from its last kept version.
   * @returns {Promise<void>}
   */
  async function load() {
    await mkdir(dir, { recursive: true });
    const ledger = await readLedger();
    const files = new Set((await readdir(dir).catch(() => [])).filter((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs") && !f.startsWith(".")));
    /** @type {Map<string, Plugin>} */
    const next = new Map();
    const found = {};
    for (const [name, entry] of Object.entries(ledger.tools)) {
      if (files.has(`${name}.mjs`)) continue;
      const kept = keptFile(name, entry);
      if (kept && await stat(kept).catch(() => null)) {
        await place(kept, path.join(dir, `${name}.mjs`));
        files.add(`${name}.mjs`);
      }
    }
    for (const f of files) {
      const file = path.join(dir, f);
      let { tool, problem } = await check(file);
      const name = f.slice(0, -4);
      const entry = ledger.tools[name];
      if (problem && entry) {
        found[name] = `The newest file didn't load (${problem}), so the last good version is back.`;
        const kept = keptFile(name, entry);
        if (kept) {
          await place(kept, file);
          ({ tool, problem } = await check(file));
        }
      } else if (problem) found[name] = problem;
      if (problem || !tool) continue;
      const mtime = (await stat(file)).mtimeMs;
      next.set(tool.name, { ...tool, file, version: entry?.versions?.at(-1)?.version || 0, mtime });
    }
    plugins = next;
    problems = found;
  }

  /** Loads the folder again, one load at a time. @returns {Promise<void>} */
  function reload() {
    if (!loading) loading = load().finally(() => { loading = null; });
    else loading = loading.then(() => load());
    return loading;
  }

  /**
   * A tool Felix built, as his AI sees it.
   * @param {Plugin} p
   * @returns {import("./felix-tools.mjs").Tool}
   */
  const asTool = (p) => ({
    name: p.name,
    description: p.description,
    inputSchema: p.inputSchema,
    step: p.step,
    own: true,
    run: (args) => inWorker(p.file, "run", args),
    ...(p.action ? { card: async (args) => (await inWorker(p.file, "card", args)) || { title: `Use ${p.name}?`, detail: JSON.stringify(args) } } : {}),
  });

  /**
   * Every tool: the built-in ones, then Felix's own.
   * @returns {import("./felix-tools.mjs").Tool[]}
   */
  const list = () => [...builtins, ...extra, ...[...plugins.values()].map(asTool)];

  /**
   * Saves a tool Felix built: checks it, puts it in the folder (a new tool, or a new version that still takes
   * everything the old one did), keeps the version, and loads it. Felix keeps answering throughout.
   * @param {{ file: string, testFile?: string | null, by?: string, job?: string | null }} build
   * @returns {Promise<{ ok: boolean, name?: string, version?: number, extended?: boolean, problem?: string }>}
   */
  async function deploy({ file, testFile = null, by = "Felix", job = null }) {
    const { tool, problem } = await check(file);
    if (problem || !tool) return { ok: false, problem: problem || "It doesn't load." };
    const ledger = await readLedger();
    const entry = ledger.tools[tool.name];
    const before = plugins.get(tool.name);
    if (entry && before) {
      const drops = dropsInputs(before.inputSchema, tool.inputSchema);
      if (drops) return { ok: false, problem: `${drops} Tools are only ever extended.` };
    }
    const source = await readFile(file);
    const sha = createHash("sha256").update(source).digest("hex").slice(0, 16);
    const version = (entry?.versions?.at(-1)?.version || 0) + 1;
    await mkdir(path.join(archive, tool.name), { recursive: true });
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(archive, tool.name, `v${version}.mjs`), source);
    if (testFile && await stat(testFile).catch(() => null)) {
      await copyFile(testFile, path.join(archive, tool.name, `v${version}.test.mjs`));
      await place(testFile, path.join(dir, `${tool.name}.test.mjs`));
    }
    ledger.tools[tool.name] = { createdAt: entry?.createdAt || new Date(now()).toISOString(), versions: [...(entry?.versions || []), { version, at: new Date(now()).toISOString(), by, job, sha }] };
    await mkdir(store, { recursive: true });
    await writeFile(ledgerFile, `${JSON.stringify(ledger, null, 2)}\n`);
    await place(file, path.join(dir, `${tool.name}.mjs`));
    await reload();
    return { ok: true, name: tool.name, version, extended: Boolean(entry) };
  }

  return {
    list,
    reload,
    deploy,
    check,
    /** Adds tools made later (Felix's tools for building and handing off work). @param {import("./felix-tools.mjs").Tool[]} tools */
    add(tools) {
      extra = [...extra, ...tools];
    },
    /**
     * Runs a tool file that isn't saved yet with your real services, for the builder to try it.
     * @param {string} file
     * @param {Record<string, any>} args
     */
    tryFile: (file, args) => inWorker(file, "run", args),
    /**
     * The tools Felix built, with their versions, and any file that couldn't be used.
     * @returns {Promise<{ tools: Array<{ name: string, description: string, version: number, createdAt: string | null, step?: string }>, problems: Record<string, string> }>}
     */
    async mine() {
      const ledger = await readLedger();
      return {
        tools: [...plugins.values()].map((p) => ({ name: p.name, description: p.description, inputSchema: p.inputSchema, version: p.version, createdAt: ledger.tools[p.name]?.createdAt || null, step: p.step })),
        problems,
      };
    },
    /** The plain words a tool of Felix's own shows while it runs. @param {string} name */
    stepOf: (name) => plugins.get(name)?.step || null,
    /** Picks up new and changed files while Felix runs. */
    watch() {
      if (watcher) return;
      let timer = null;
      try {
        watcher = fsWatch(dir, (_, f) => {
          if (!f || String(f).startsWith(".")) return;
          clearTimeout(timer);
          timer = setTimeout(() => { reload().catch(() => {}); }, WATCH_SETTLE_MS);
        });
        watcher.unref?.();
      } catch {
        watcher = null;
      }
    },
    close() {
      watcher?.close();
      watcher = null;
    },
  };
}
