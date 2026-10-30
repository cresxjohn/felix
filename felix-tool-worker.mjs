/**
 * Runs one of the tools Felix built himself, in a worker thread of its own, so a tool that's slow, stuck or broken
 * never holds up Felix: he goes on answering, and the worker is stopped when it takes too long. Every run loads the
 * tool's file afresh, so a new version is used the moment it's saved. The tool reaches your services only through
 * `ctx`, whose calls go back to Felix (felix-toolbox.mjs answers them); it never sees a token or a secret.
 *
 * workerData: { file, mode: "describe" | "card" | "run", args }: what the tool is, the card an action shows for these
 * args (null when it isn't an action), or its answer. It posts { type: "call", id, path, args } for each `ctx`
 * call, and ends with { type: "done", value } or { type: "fail", error }.
 */
import { parentPort, workerData } from "node:worker_threads";
import { pathToFileURL } from "node:url";

let seq = 0;
/** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: Error) => void }>} */
const waiting = new Map();
parentPort?.on("message", (msg) => {
  const w = waiting.get(msg?.id);
  if (!w) return;
  waiting.delete(msg.id);
  if (msg.error) w.reject(new Error(msg.error));
  else w.resolve(msg.value);
});

/**
 * One of Felix's services, reached by its path: `ctx.ooo.out(range)` asks Felix to run "ooo.out" with `range`.
 * @param {string[]} path
 * @returns {any}
 */
const reach = (path) => new Proxy(() => {}, {
  get: (_, key) => (typeof key === "string" && key !== "then" ? reach([...path, key]) : undefined),
  apply: (_, __, args) => new Promise((resolve, reject) => {
    const id = ++seq;
    waiting.set(id, { resolve, reject });
    parentPort?.postMessage({ type: "call", id, path: path.join("."), args: JSON.parse(JSON.stringify(args)) });
  }),
});

const { file, mode, args } = workerData || {};
try {
  const mod = await import(`${pathToFileURL(file).href}?at=${Date.now()}`);
  const tool = mod.default;
  if (!tool || typeof tool !== "object") throw new Error("The file has no tool as its default export.");
  if (mode === "describe") {
    parentPort?.postMessage({ type: "done", value: {
      name: tool.name, description: tool.description, inputSchema: tool.inputSchema, step: tool.step,
      runs: typeof tool.run === "function", action: typeof tool.card === "function",
    } });
  } else if (mode === "card") {
    parentPort?.postMessage({ type: "done", value: typeof tool.card === "function" ? tool.card(args || {}) : null });
  } else {
    const value = await tool.run(args || {}, reach([]));
    parentPort?.postMessage({ type: "done", value: JSON.parse(JSON.stringify(value ?? null)) });
  }
} catch (e) {
  parentPort?.postMessage({ type: "fail", error: String(e?.message || e) });
}
