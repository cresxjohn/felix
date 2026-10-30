/**
 * Felix's gate. Every tool Felix's AI asks to use passes through it, from Claude or Cursor alike. Reads go
 * straight through, and so do edits inside Felix's own workbench, where nothing real changes. Everything else
 * is a change: it shows up in the chat as a card with exactly what will run, and waits for you to click Allow
 * or type yes. A spoken yes isn't enough for a change. With "Allow everything" in Settings (like Claude Code's
 * bypass), changes go through without a card. A few things, like your login and the Keychain, are never run at all.
 */
import { randomUUID } from "node:crypto";
import path from "node:path";
import { shellKind } from "./felix-readonly.mjs";

const WAIT_MS = 10 * 60_000;
const DETAIL_CHARS = 600;
const CLAUDE_READS = new Set(["Read", "Glob", "Grep", "LS", "TodoWrite", "NotebookRead", "Task", "BashOutput"]);
// Searching or reading the web: only on a question where you asked Felix to look something up.
const CLAUDE_WEB = new Set(["WebFetch", "WebSearch"]);
const CLAUDE_EDITS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const CURSOR_READS = new Set(["read", "search", "think"]);
const CURSOR_EDITS = new Set(["edit", "delete", "move"]);
export const SAY_IT = "For changes I need a click on Allow, or a typed yes.";

/**
 * @typedef {{ tool: "shell" | "edit" | "read" | "web" | "action" | "other", command?: string, file?: string, title?: string,
 *   detail?: string }} Request One tool use the AI asked for: a shell command, an edit to a file, a read, a web search or
 *   fetch, an action on one of your services (an RSVP, a Slack message: `title` and `detail` are its card), or anything else.
 * @typedef {{ id: string, title: string, detail: string }} Card What the chat shows for a change.
 * @typedef {{ onAsk: (card: Card) => void, onStep?: (step: string) => void, web?: boolean, allowAll?: boolean }} Sink Where a
 *   question's cards go; `web` when you asked Felix to look something up on the web, the only time web tools go
 *   through; `allowAll` when Settings allow every change without asking.
 * @typedef {{ resolve: (yes: boolean) => void, timer: ReturnType<typeof setTimeout> }} Waiting
 */

/**
 * A tool use Claude asked permission for, as the gate sees it.
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @returns {Request}
 */
export function fromClaude(name, input = {}) {
  if (name === "Bash") return { tool: "shell", command: String(input.command || "") };
  if (CLAUDE_EDITS.has(name)) return { tool: "edit", file: String(input.file_path || input.notebook_path || "") };
  if (CLAUDE_READS.has(name)) return { tool: "read", detail: name };
  if (CLAUDE_WEB.has(name)) return { tool: "web", detail: String(input.query || input.url || name) };
  return { tool: "other", detail: `${name} ${JSON.stringify(input)}` };
}

/**
 * A tool use Cursor asked permission for, as the gate sees it. Cursor names a command in backticks.
 * @param {{ kind?: string, title?: string, locations?: Array<{ path?: string }> }} call
 * @returns {Request}
 */
export function fromCursor(call = {}) {
  const title = String(call.title || "");
  if (call.kind === "execute") return { tool: "shell", command: title.replace(/^`|`$/g, "") };
  if (CURSOR_EDITS.has(String(call.kind))) return { tool: "edit", file: call.locations?.[0]?.path || title };
  if (CURSOR_READS.has(String(call.kind))) return { tool: "read", detail: title };
  if (call.kind === "fetch") return { tool: "web", detail: title };
  return { tool: "other", detail: title || "a tool" };
}

/**
 * Whether a file is inside one of the folders.
 * @param {string} file
 * @param {string[]} folders
 * @returns {boolean}
 */
const insideAny = (file, folders) => Boolean(file) && folders.some((f) => {
  const rel = path.relative(f, path.resolve(f, file));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
});

/**
 * The card a change shows in the chat.
 * @param {Request} req
 * @returns {Omit<Card, "id">}
 */
export function cardFor(req) {
  const clip = (text) => String(text).slice(0, DETAIL_CHARS);
  if (req.tool === "shell") return { title: "Run this command?", detail: clip(req.command) };
  if (req.tool === "edit") return { title: "Change this file?", detail: clip(req.file) };
  if (req.tool === "action") return { title: req.title || "Do this?", detail: clip(req.detail || "") };
  return { title: "Use this tool?", detail: clip(req.detail) };
}

/**
 * Creates the gate.
 * @param {{ inside: string[], waitMs?: number, newId?: () => string }} options `inside` lists the folders where
 *   edits are free: Felix's workbench.
 */
export function createGate({ inside, waitMs = WAIT_MS, newId = randomUUID }) {
  /** @type {Map<string, Waiting>} */
  const waiting = new Map();
  /** @type {Sink | null} */
  let sink = null;

  /**
   * What a tool use is: a read, a change, or something Felix never runs.
   * @param {Request} req
   * @returns {import("./felix-readonly.mjs").Kind}
   */
  function kindOf(req) {
    if (req.tool === "read") return "read";
    if (req.tool === "shell") return shellKind(req.command || "");
    if (req.tool === "edit") return insideAny(req.file || "", inside) ? "read" : "change";
    return "change";
  }

  /**
   * Settles a card that's waiting.
   * @param {string} id
   * @param {boolean} yes
   */
  function settle(id, yes) {
    const w = waiting.get(id);
    if (!w) return;
    waiting.delete(id);
    clearTimeout(w.timer);
    w.resolve(yes);
  }

  /**
   * Decides a tool use: reads go through, changes wait for your answer on a card, the rest are turned down.
   * With no question in progress, nobody can answer, so a change is turned down.
   * @param {Request} req
   * @returns {Promise<boolean>}
   */
  function request(req) {
    if (req.tool === "web") {
      if (sink?.web) return Promise.resolve(true);
      sink?.onStep?.("Felix searches the web only when you ask");
      return Promise.resolve(false);
    }
    const kind = kindOf(req);
    if (kind === "read") return Promise.resolve(true);
    if (kind === "never" || !sink) {
      if (kind === "never") sink?.onStep?.("Felix never runs that one");
      return Promise.resolve(false);
    }
    if (sink.allowAll) return Promise.resolve(true);
    const id = newId();
    const show = sink.onAsk;
    return new Promise((resolve) => {
      waiting.set(id, { resolve, timer: setTimeout(() => settle(id, false), waitMs) });
      show({ id, ...cardFor(req) });
    });
  }

  /**
   * Your answer to a card. A spoken yes doesn't count; the card keeps waiting for a click or a typed yes.
   * @param {string} id
   * @param {boolean} yes
   * @param {{ spoken?: boolean }} [how]
   * @returns {{ ok: boolean, text: string }}
   */
  function answer(id, yes, { spoken = false } = {}) {
    if (!waiting.has(id)) return { ok: false, text: "That one isn't waiting anymore." };
    if (yes && spoken) return { ok: false, text: SAY_IT };
    settle(id, yes);
    return { ok: true, text: yes ? "Allowed." : "Okay, not doing that." };
  }

  /**
   * Starts a question: its cards go to the sink until it ends, and any still waiting then are turned down.
   * @param {Sink} next
   * @returns {() => void} Ends the question.
   */
  function begin(next) {
    sink = next;
    return () => {
      if (sink === next) sink = null;
      [...waiting.keys()].forEach((id) => settle(id, false));
    };
  }

  return { request, answer, begin, kindOf };
}
