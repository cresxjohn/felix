/**
 * Felix as an agent, put together: his workbench (his own copy of the app, where his memory lives too), the gate
 * every tool use passes through, and the MCP endpoint Claude Code asks the gate through. Applying the
 * workbench's changes is the one way they reach your Felix: it runs the tests in the workbench first, keeps the
 * change as a patch, copies it over without committing it, and restarts Felix through the restart guard
 * (felix-guard.mjs), which puts the change back when Felix doesn't come back healthy. The last apply can be undone.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { applyFiles } from "./felix-guard.mjs";
import { createGate, fromClaude, fromCursor } from "./felix-gate.mjs";
import { createMcp } from "./felix-mcp.mjs";
import { createMemory } from "./felix-memory.mjs";
import { createWorkbench, gitRunner } from "./felix-workbench.mjs";
import { rulesWith } from "./felix.mjs";

const TEST_MS = 5 * 60_000;
const RESTART_DELAY_MS = 800;
const SECRETS = ["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/Library/Keychains/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"];

/**
 * Claude Code's settings for Felix's AI: sandboxed commands run on their own (writes stay in the workbench, no
 * network), gh runs outside the sandbox so the gate decides it, and secret files can't be read.
 */
export const CLAUDE_SETTINGS = JSON.stringify({
  sandbox: { enabled: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: true, excludedCommands: ["gh"] },
  // Felix's own tools are his to use: looking things up runs at once, and his actions ask you through his gate.
  permissions: { allow: ["mcp__felix"], deny: SECRETS.map((s) => `Read(${s})`) },
});

/**
 * Runs Felix's tests in a folder.
 * @param {string} cwd
 * @param {typeof nodeSpawn} spawnImpl
 * @param {number} ms
 * @returns {Promise<{ ok: boolean, tail: string }>} The last lines it printed, to say what failed.
 */
export function runTests(cwd, spawnImpl, ms = TEST_MS) {
  return new Promise((resolve) => {
    const proc = spawnImpl(path.join(cwd, "prs"), ["test"], { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    const keep = (d) => { out = (out + d).slice(-4000); };
    proc.stdout?.on("data", keep);
    proc.stderr?.on("data", keep);
    const timer = setTimeout(() => proc.kill(), ms);
    const done = (ok) => {
      clearTimeout(timer);
      resolve({ ok, tail: out.trim().split("\n").slice(-6).join("\n") });
    };
    proc.on("error", () => done(false));
    proc.on("close", (code) => done(code === 0));
  });
}

/**
 * Whether two tokens match, in constant time.
 * @param {string} a
 * @param {string} b
 * @returns {boolean}
 */
const same = (a, b) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * A count of files: "1 file", "3 files".
 * @param {number} n
 * @returns {string}
 */
const filesText = (n) => (n === 1 ? "1 file" : `${n} files`);

/**
 * Creates Felix's agent parts.
 * @param {{ repo: string, dir: string, port: number, skip?: string[], spawnImpl?: typeof nodeSpawn, token?: string,
 *   restart?: (why: "apply" | "undo") => void, workbench?: ReturnType<typeof createWorkbench>, testMs?: number,
 *   git?: import("./felix-workbench.mjs").Git, now?: () => number,
 *   tools?: import("./felix-tools.mjs").Tool[] | (() => import("./felix-tools.mjs").Tool[]) }} options `dir` is Felix's own data folder; `restart`
 *   restarts Felix after an apply or an undo, through the restart guard.
 */
export function createAgent({ repo, dir, port, skip = [], spawnImpl = nodeSpawn, token = randomBytes(24).toString("hex"),
  restart = () => {}, workbench: given, testMs = TEST_MS, git = gitRunner(), now = Date.now, tools = [] }) {
  const kept = applyFiles(dir);
  const workbench = given || createWorkbench({ repo, dir: path.join(dir, "workbench"), skip });
  const memory = createMemory({ dir: workbench.memory });
  const gate = createGate({ inside: [workbench.dir] });
  const mcpConfig = path.join(dir, "mcp.json");
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { felix: { type: "http", url: `http://127.0.0.1:${port}/mcp`, headers: { Authorization: `Bearer ${token}` } } } }), { mode: 0o600 });
  chmodSync(mcpConfig, 0o600);
  const mcp = createMcp({
    decide: (name, input) => gate.request(fromClaude(name, input)),
    tools,
    act: (card) => gate.request({ tool: "action", ...card }),
  });
  // Cursor starts its tool servers itself: it reaches Felix's through a small bridge that carries the same token.
  const cursorMcp = [{
    name: "felix",
    command: process.execPath,
    args: [path.join(repo, "felix-mcp-bridge.mjs")],
    env: [{ name: "FELIX_MCP_URL", value: `http://127.0.0.1:${port}/mcp` }, { name: "FELIX_MCP_TOKEN", value: token }],
  }];

  /**
   * The last change applied to Felix and what became of it, or null when there's none.
   * @returns {Promise<import("./felix-guard.mjs").ApplyStatus | null>}
   */
  const lastApply = () => readFile(kept.status, "utf8").then(JSON.parse, () => null);

  /**
   * Saves what happened to the last apply.
   * @param {import("./felix-guard.mjs").ApplyStatus} status
   * @returns {Promise<void>}
   */
  const saveStatus = (status) => writeFile(kept.status, `${JSON.stringify(status, null, 2)}\n`);

  /**
   * Runs Felix's tests in the workbench, as they'd run before an apply.
   * @returns {Promise<{ ok: boolean, tail: string }>}
   */
  const test = () => runTests(workbench.dir, spawnImpl, testMs);

  /**
   * Copies the workbench's changes into your Felix once its tests pass, keeping the change as a patch to undo
   * it, then restarts Felix through the guard, which puts it back if Felix doesn't come back healthy.
   * @returns {Promise<{ ok: boolean, text: string, files?: string[] }>}
   */
  async function apply() {
    const changes = await workbench.changes();
    if (!changes.length) return { ok: false, text: "There's nothing new in my workbench to apply." };
    const tests = await test();
    if (!tests.ok) return { ok: false, text: `I didn't apply it: the tests fail in my workbench.\n${tests.tail}` };
    try {
      await mkdir(path.dirname(kept.patch), { recursive: true });
      await writeFile(kept.patch, await workbench.diff());
      const files = (await workbench.apply()).map((c) => c.path);
      await saveStatus({ state: "restarting", at: new Date(now()).toISOString(), files });
      setTimeout(() => restart("apply"), RESTART_DELAY_MS);
      return { ok: true, text: `Applied ${filesText(files.length)}. Restarting Felix now; if he doesn't come back healthy, I'll put it back on my own.`, files };
    } catch (e) {
      return { ok: false, text: `I couldn't apply it, so nothing changed: ${e.message}` };
    }
  }

  /**
   * Puts back the last change applied to Felix, when the files it touched haven't changed since, then restarts him.
   * @returns {Promise<{ ok: boolean, text: string, files?: string[] }>}
   */
  async function undoApply() {
    const last = await lastApply();
    const patch = await readFile(kept.patch, "utf8").catch(() => "");
    if (!last || !patch || !["ok", "restarting", "broken"].includes(last.state)) return { ok: false, text: "There's no change of mine to undo." };
    try {
      await git(repo, ["apply", "-R", "--check", "-"], patch);
    } catch {
      return { ok: false, text: "I can't undo it cleanly: the files it changed have been changed again since." };
    }
    await git(repo, ["apply", "-R", "-"], patch);
    const files = last.files || [];
    await saveStatus({ ...last, state: "undoing", undoneAt: new Date(now()).toISOString() });
    setTimeout(() => restart("undo"), RESTART_DELAY_MS);
    return { ok: true, text: `Put back ${filesText(files.length)} the way ${files.length === 1 ? "it was" : "they were"} before my last change. Restarting Felix now.`, files };
  }

  /**
   * Drops the workbench's changes.
   * @returns {Promise<{ ok: boolean, text: string }>}
   */
  async function discard() {
    await workbench.discard();
    return { ok: true, text: "Dropped those changes. My workbench is back to your Felix." };
  }

  return {
    workbench,
    memory,
    gate,
    apply,
    undoApply,
    lastApply,
    test,
    discard,
    tools: { mcpConfig, settings: CLAUDE_SETTINGS },
    /** Felix's tool server, the way Cursor starts it. */
    cursorMcp,
    /** How Felix's background jobs reach his tool server: its address, token and Cursor's bridge. */
    access: { url: `http://127.0.0.1:${port}/mcp`, token, bridge: path.join(repo, "felix-mcp-bridge.mjs") },
    /** Felix's rules for a new session, with its memory's index as it is now. @returns {string} */
    rules: () => rulesWith(memory.index()),
    /** The gate's answer to Cursor's permission request. @param {import("./felix-cursor.mjs").ToolCall} call */
    allow: (call) => gate.request(fromCursor(call)),
    /**
     * Whether an MCP request is Claude's: it carries the token, and it came straight to Felix on this Mac, not
     * through the tailnet.
     * @param {import("node:http").IncomingHttpHeaders} headers
     * @returns {boolean}
     */
    authorized: (headers) => !headers["x-forwarded-for"] && same(String(headers.authorization || ""), `Bearer ${token}`),
    /** Answers one of Claude's MCP messages. @param {import("./felix-mcp.mjs").McpRequest} msg */
    mcp: (msg) => mcp(msg),
  };
}
