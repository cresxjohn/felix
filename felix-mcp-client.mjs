/**
 * Felix as an MCP client: he starts another app's MCP server on this Mac (like Wais's) and calls its tools, over
 * stdin and stdout, one JSON message a line. The server starts on first use, is shared by every call, stops after a
 * while with nothing to do, and starts again if it stopped or crashed. A secret the server needs (its token) is
 * read from the Keychain at start and passed in its environment, never written anywhere.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { eachLine, parsed } from "./felix-lines.mjs";

const PROTOCOL = "2025-06-18";
const CALL_MS = 30_000;
const IDLE_MS = 10 * 60_000;

/**
 * @typedef {{ command: string, args?: string[], cwd?: string, env?: Record<string, string> }} ServerSpec How to start
 *   the server; `env` adds to a small safe environment, not to Felix's own.
 */

/**
 * Creates a client for one MCP server.
 * @param {{ name: string, spec: () => Promise<ServerSpec | null>, spawnImpl?: typeof nodeSpawn, callMs?: number,
 *   idleMs?: number }} options `spec` is read at each start, so a changed token or path is picked up; null means the
 *   server isn't set up.
 */
export function createMcpClient({ name, spec, spawnImpl = nodeSpawn, callMs = CALL_MS, idleMs = IDLE_MS }) {
  /** @type {{ proc: any, ready: Promise<void>, pending: Map<number, { resolve: Function, reject: Function, timer: any }>, problem: string } | null} */
  let live = null;
  let seq = 0;
  let idle = null;

  /** Stops the server, failing whatever it was still answering. @param {string} why */
  function stop(why) {
    const was = live;
    live = null;
    clearTimeout(idle);
    if (!was) return;
    for (const p of was.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(why));
    }
    try { was.proc.kill(); } catch { /* already gone */ }
  }

  /** Stops the server after a while with nothing to do. */
  function touch() {
    clearTimeout(idle);
    idle = setTimeout(() => stop(`${name} was idle`), idleMs);
    idle.unref?.();
  }

  /**
   * Sends one request and waits for its answer.
   * @param {NonNullable<typeof live>} s
   * @param {string} method
   * @param {object} [params]
   * @returns {Promise<any>}
   */
  function request(s, method, params) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        s.pending.delete(id);
        reject(new Error(`${name} took too long to answer.`));
      }, callMs);
      s.pending.set(id, { resolve, reject, timer });
      s.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) })}\n`);
    });
  }

  /**
   * The running server, started and introduced first when it isn't.
   * @returns {Promise<NonNullable<typeof live>>}
   */
  async function server() {
    if (live) {
      await live.ready;
      return live;
    }
    const how = await spec();
    if (!how) throw Object.assign(new Error(`${name} isn't set up yet.`), { code: "not-set-up" });
    const proc = spawnImpl(how.command, how.args || [], {
      cwd: how.cwd,
      // Only what a server needs to run, plus its own settings: none of Felix's own environment.
      env: { PATH: process.env.PATH || "/usr/bin:/bin", HOME: process.env.HOME || "", ...(how.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const s = { proc, pending: new Map(), problem: "", ready: Promise.resolve() };
    live = s;
    eachLine(proc.stdout, (line) => {
      const msg = parsed(line);
      const p = msg && msg.id !== undefined ? s.pending.get(msg.id) : null;
      if (!p) return;
      s.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new Error(String(msg.error.message || "It failed.")));
      else p.resolve(msg.result);
    });
    proc.stderr?.on("data", (d) => { s.problem = String(d).trim().slice(-300) || s.problem; });
    proc.on("error", (e) => { if (live === s) stop(`${name} couldn't start: ${e.message}`); });
    proc.on("exit", (code) => { if (live === s) stop(`${name} stopped${s.problem ? `: ${s.problem}` : code ? ` (code ${code})` : ""}.`); });
    s.ready = request(s, "initialize", { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: "felix", version: "1" } })
      .then(() => { s.proc.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`); });
    try {
      await s.ready;
    } catch (e) {
      if (live === s) stop(e.message);
      throw e;
    }
    return s;
  }

  return {
    /**
     * The server's tools.
     * @returns {Promise<Array<{ name: string, description?: string, inputSchema?: object }>>}
     */
    async tools() {
      const s = await server();
      touch();
      return (await request(s, "tools/list")).tools || [];
    },
    /**
     * Calls a tool and gives back what it found: its JSON when the answer is JSON text, else the text.
     * @param {string} tool
     * @param {Record<string, unknown>} [args]
     * @returns {Promise<unknown>}
     */
    async call(tool, args = {}) {
      const s = await server();
      touch();
      const out = await request(s, "tools/call", { name: tool, arguments: args });
      const text = (out?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
      if (out?.structuredContent !== undefined && !out.isError) return out.structuredContent;
      if (out?.isError) throw new Error(text || `${tool} failed.`);
      try { return JSON.parse(text); } catch { return text; }
    },
    /** Stops the server now (it starts again on the next call). */
    stop: () => stop(`${name} was stopped`),
    /** Whether the server is running. */
    running: () => Boolean(live),
  };
}
