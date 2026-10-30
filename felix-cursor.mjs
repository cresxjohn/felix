/**
 * Felix's Cursor session: Cursor's CLI kept open as an ACP server (the Agent Client Protocol: JSON-RPC over its
 * stdin and stdout), in agent mode inside Cursor's sandbox, in Felix's workbench. A fresh Cursor run takes 8 to
 * 19 seconds to answer; a question in the open session takes 2 to 4. The session remembers the conversation and
 * switches models between questions. Inside the workbench it reads, edits and runs sandboxed commands on its
 * own; anything that reaches outside (the network, other folders) asks permission, and Felix's gate decides:
 * reads go through, and changes wait for your yes. It only ever gets "allow once", never "always".
 */
import { spawn as nodeSpawn } from "node:child_process";
import { eachLine, parsed } from "./felix-lines.mjs";
import { cursorStep } from "./felix-steps.mjs";

const START_MS = 30_000;
const SEEN_CHARS = 20_000;
export const SESSION_ARGS = Object.freeze(["--sandbox", "enabled", "acp"]);
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const EFFORT_KEYS = new Set(["effort", "reasoning_effort", "reasoning"]);
const SWITCHES = new Set(["fast", "thinking"]);

/**
 * @typedef {{ kind?: string, title?: string, locations?: Array<{ path?: string }> }} ToolCall
 * @typedef {{ sessionUpdate?: string, content?: unknown, title?: string, kind?: string, status?: string, rawOutput?: unknown }} Update
 * @typedef {{ id: string, base: string, params: Array<[string, string]> }} SessionModel
 * @typedef {{ id?: number, method?: string, params?: { update?: Update, toolCall?: ToolCall, options?: Array<{ optionId: string, kind: string }> },
 *   result?: Record<string, unknown>, error?: { message?: string, data?: { message?: string } } }} RpcMessage
 * @typedef {{ call: (method: string, params: object) => Promise<RpcMessage>, fail: (reason: string) => void }} Rpc
 * @typedef {import("./felix-brain.mjs").ToolUse} ToolUse
 * @typedef {{ proc: import("node:child_process").ChildProcess, rpc: Rpc, sessionId: string, models: SessionModel[], model: string,
 *   turns: number, fresh: boolean, last: string, dead: boolean, onDelta: ((text: string) => void) | null,
 *   onTool: ((use: ToolUse) => void) | null, steers: string[], next: Promise<RpcMessage> | null, idle?: ReturnType<typeof setTimeout>,
 *   active?: number }} Live
 *   `steers` are your messages waiting to be handed over; `next` is the prompt that took over with them; `active` is
 *   when Cursor last said anything.
 * @typedef {import("./felix-brain.mjs").BrainAnswer} BrainAnswer
 * @typedef {{ onDelta?: (text: string) => void, onTool?: (use: ToolUse) => void, before?: string }} CursorAsk `before` is
 *   the turn this one follows, sent along only when the session didn't see it. `onTool` hears about each tool it uses.
 * @typedef {(call: ToolCall) => Promise<boolean>} Allow Decides a permission request.
 */

/**
 * A model as the session lists it, like "composer-2.5[fast=true]": its name and its options.
 * @param {string} id
 * @returns {SessionModel}
 */
export function modelParts(id) {
  const [base, rest = ""] = id.split("[");
  const params = rest.replace(/\]$/, "").split(",").filter(Boolean).map((p) => /** @type {[string, string]} */ (p.split("=").concat("").slice(0, 2)));
  return { id, base, params };
}

/**
 * One of a session model's options, set from the words after its name in a CLI model id.
 * @param {string} key
 * @param {string} value Its default.
 * @param {string[]} words
 * @returns {string}
 */
function optionFor(key, value, words) {
  if (SWITCHES.has(key)) return String(words.includes(key));
  const effort = words.find((w) => EFFORTS.has(w));
  return effort && EFFORT_KEYS.has(key) ? effort : value;
}

/**
 * The session's name for a model from `cursor-agent models`: "composer-2.5-fast" is "composer-2.5[fast=true]" and
 * "claude-opus-5-5-medium" is Opus 5.5 with medium effort. The model is the longest listed name the id starts
 * with; the words after it set the effort, and "fast" and "thinking" on or off, since the CLI names a model's
 * fast and thinking variants and leaves the words out of the others ("claude-haiku-5-5-low" is no thinking).
 * Null when the session lists no such model.
 * @param {string} id
 * @param {SessionModel[]} models
 * @returns {string | null}
 */
export function sessionModel(id, models) {
  if (models.some((m) => m.id === id)) return id;
  const [model] = models.filter((m) => id === m.base || id.startsWith(`${m.base}-`)).sort((a, b) => b.base.length - a.base.length);
  if (!model) return null;
  if (!model.params.length) return model.id;
  const words = id.slice(model.base.length).split("-").filter(Boolean);
  return `${model.base}[${model.params.map(([k, v]) => `${k}=${optionFor(k, v, words)}`).join(",")}]`;
}

/**
 * What a request from Cursor gets back: a permission request gets Felix's decision, as "allow once" or "reject
 * once", and anything else isn't supported.
 * @param {RpcMessage} msg
 * @param {Allow} allow
 * @returns {Promise<object>}
 */
export async function answerRequest(msg, allow) {
  if (msg.method !== "session/request_permission") return { error: { code: -32601, message: "Felix doesn't support that" } };
  const yes = await allow(msg.params?.toolCall || {}).catch(() => false);
  const option = msg.params?.options?.find((o) => o.kind === (yes ? "allow_once" : "reject_once"));
  return { result: { outcome: option ? { outcome: "selected", optionId: option.optionId } : { outcome: "cancelled" } } };
}

/**
 * Every piece of text in a tool's result, for the fact check to learn from, without the labels saying what kind
 * of content each piece is.
 * @param {unknown} value
 * @returns {string}
 */
export function textIn(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textIn).filter(Boolean).join("\n");
  if (value && typeof value === "object") return Object.entries(value).filter(([k]) => k !== "type").map(([, v]) => textIn(v)).filter(Boolean).join("\n");
  return "";
}

/**
 * What a session update says about a tool: a step to show when it starts, what it saw, and whether it's done.
 * @param {Update} update
 * @returns {(ToolUse & { done?: boolean }) | null}
 */
export function toolUse(update) {
  if (update.sessionUpdate === "tool_call") return { step: cursorStep(update), seen: update.title || "" };
  if (update.sessionUpdate !== "tool_call_update") return null;
  const seen = [textIn(update.content), textIn(update.rawOutput)].filter(Boolean).join("\n").slice(0, SEEN_CHARS);
  const done = update.status === "completed" || update.status === "failed";
  if (!seen && !done) return null;
  return { ...(seen ? { seen } : {}), ...(done ? { done } : {}) };
}

/**
 * What Felix tells the AI about messages you sent while it was working.
 * @param {string[]} texts
 * @returns {string}
 */
export const steerText = (texts) => `While you were working, I added: ${texts.map((t) => `"${t}"`).join(" and ")}. `
  + "Carry on with what you were doing, with that in mind; don't start over or repeat what's done.";

/**
 * Why a call failed, in Cursor's words.
 * @param {RpcMessage} msg
 * @returns {string}
 */
const why = (msg) => msg.error?.data?.message || msg.error?.message || "it stopped";

/**
 * JSON-RPC over a process's stdin and stdout.
 * @param {import("node:child_process").ChildProcess} proc
 * @param {(msg: RpcMessage) => void} onNotify Gets each notification, like a piece of the reply.
 * @param {Allow} allow Decides Cursor's permission requests.
 * @returns {Rpc}
 */
function createRpc(proc, onNotify, allow) {
  let next = 0;
  /** @type {Map<number, (msg: RpcMessage) => void>} */
  const pending = new Map();
  const write = (msg) => proc.stdin?.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
  eachLine(proc.stdout, (line) => {
    const msg = /** @type {RpcMessage | null} */ (parsed(line));
    if (!msg) return;
    if (msg.method && msg.id !== undefined) return void answerRequest(msg, allow).then((answer) => write({ id: msg.id, ...answer }));
    if (msg.method) return onNotify(msg);
    pending.get(Number(msg.id))?.(msg);
    pending.delete(Number(msg.id));
  });
  return {
    call: (method, params) => new Promise((resolve) => {
      next += 1;
      pending.set(next, resolve);
      write({ id: next, method, params });
    }),
    fail: (reason) => {
      for (const resolve of pending.values()) resolve({ error: { message: reason } });
      pending.clear();
    },
  };
}

/**
 * A promise's value, or null when it takes longer than `ms`.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T | null>}
 */
function within(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); });
  return Promise.race([promise, late]).finally(() => clearTimeout(timer));
}

/**
 * Creates Felix's Cursor session. It starts on the first question or warm-up, restarts in the background after
 * enough questions, and closes when idle.
 * @param {{ bin: string, cwd: string, systemPrompt: string | (() => string | Promise<string>), spawnImpl?: typeof nodeSpawn, turnMs: number,
 *   idleMs: number, maxTurns: number, startMs?: number, mode?: string, allow?: Allow, mcpServers?: object[] }} options
 *   `systemPrompt` is read again for each new session. `mode` is Cursor's: "agent" by default. `allow` decides
 *   permission requests; without it, each one is turned down. `mcpServers` are the tool servers Cursor starts with
 *   the session (Felix's, through its bridge).
 */
export function createCursorSession({ bin, cwd, systemPrompt, spawnImpl = nodeSpawn, turnMs, idleMs, maxTurns, startMs = START_MS,
  mode = "agent", allow = async () => false, mcpServers = [] }) {
  /** @type {Promise<Live | null> | null} */
  let starting = null;
  /** @type {Promise<unknown>} */
  let queue = Promise.resolve();

  /**
   * Stops a session's process.
   * @param {Live} live
   */
  function kill(live) {
    clearTimeout(live.idle);
    live.dead = true;
    live.proc.kill();
  }

  /**
   * Sets up a started process: the protocol, a new session, and Felix's mode, which it must accept.
   * @param {Live} live
   * @returns {Promise<boolean>}
   */
  async function setUp(live) {
    if ((await live.rpc.call("initialize", { protocolVersion: 1, clientCapabilities: {} })).error) return false;
    const made = await live.rpc.call("session/new", { cwd, mcpServers });
    const session = /** @type {{ sessionId?: string, models?: { currentModelId?: string, availableModels?: Array<{ modelId: string }> } }} */ (made.result || {});
    if (made.error || !session.sessionId) return false;
    Object.assign(live, {
      sessionId: session.sessionId,
      models: (session.models?.availableModels || []).map((m) => modelParts(m.modelId)),
      model: session.models?.currentModelId || "",
    });
    return !(await live.rpc.call("session/set_mode", { sessionId: live.sessionId, modeId: mode })).error;
  }

  /**
   * Starts Cursor's ACP server and a session in it.
   * @returns {Promise<Live | null>} Null when it couldn't start.
   */
  async function start() {
    const proc = spawnImpl(bin, [...SESSION_ARGS], { cwd, stdio: ["pipe", "pipe", "ignore"] });
    /** @type {Live} */
    const live = { proc, rpc: createRpc(proc, (msg) => onNotify(live, msg), allow), sessionId: "", models: [], model: "", turns: 0, fresh: true,
      last: "", dead: false, onDelta: null, onTool: null, steers: [], next: null };
    const stop = (reason) => {
      live.dead = true;
      live.rpc.fail(reason);
    };
    proc.on("error", (err) => stop(`Cursor couldn't start: ${err.message}`));
    proc.on("exit", () => stop("Cursor stopped"));
    if (await within(setUp(live), startMs)) return live;
    kill(live);
    return null;
  }

  /**
   * Passes a piece of the reply on as it's written, and each tool it uses.
   * @param {Live} live
   * @param {RpcMessage} msg
   */
  function onNotify(live, msg) {
    const update = msg.params?.update;
    if (!update) return;
    live.active = Date.now();
    const content = /** @type {{ type?: string, text?: string }} */ (update.content || {});
    if (update.sessionUpdate === "agent_message_chunk" && content.type === "text") return void live.onDelta?.(String(content.text || ""));
    const use = toolUse(update);
    if (!use) return;
    const { done, ...shown } = use;
    if (shown.step || shown.seen) live.onTool?.(shown);
    if (done) handOver(live);
  }

  /**
   * Hands your waiting messages to the session between two steps of its work: a new prompt that carries on
   * from where it is. Cursor ends the turn in progress for it, which is now finished with its last tool.
   * @param {Live} live
   */
  function handOver(live) {
    if (!live.steers.length || !live.onDelta || live.next) return;
    live.onDelta("\n\n"); // what it says next starts a new paragraph, as with Claude
    live.next = live.rpc.call("session/prompt", { sessionId: live.sessionId, prompt: [{ type: "text", text: steerText(live.steers.splice(0)) }] });
  }

  /**
   * The open session, started when there's none.
   * @returns {Promise<Live | null>}
   */
  async function ready() {
    const live = starting && (await starting);
    if (live && !live.dead) return live;
    starting = start();
    return starting;
  }

  /**
   * Switches the session to a model, when it lists one by that name.
   * @param {Live} live
   * @param {string | undefined} model A CLI model id; Cursor's current one when left out.
   * @returns {Promise<boolean>}
   */
  async function useModel(live, model) {
    if (!model) return true;
    const id = sessionModel(model, live.models);
    if (!id) return false;
    if (id === live.model) return true;
    if ((await live.rpc.call("session/set_model", { sessionId: live.sessionId, modelId: id })).error) return false;
    live.model = id;
    return true;
  }

  /**
   * Counts a finished question: a session that's had enough is replaced in the background, else it waits idle.
   * @param {Live} live
   */
  function afterTurn(live) {
    live.turns += 1;
    if (live.turns < maxTurns) {
      live.idle = setTimeout(() => kill(live), idleMs);
      return;
    }
    kill(live);
    starting = start();
  }

  /**
   * Asks one question in the session.
   * @param {string} text
   * @param {string | undefined} model
   * @param {CursorAsk} options
   * @returns {Promise<BrainAnswer | null>}
   */
  async function prompt(text, model, { onDelta, onTool, before = "" }) {
    const live = await ready();
    if (!live || !(await useModel(live, model))) return null;
    clearTimeout(live.idle);
    const rules = live.fresh ? await (typeof systemPrompt === "function" ? systemPrompt() : systemPrompt) : "";
    const turn = [rules, before && before !== live.last ? before : "", text].filter(Boolean).join("\n\n");
    let reply = "";
    live.onDelta = (piece) => {
      reply += piece;
      onDelta?.(piece);
    };
    live.onTool = onTool || null;
    const done = await untilSettled(live, live.rpc.call("session/prompt", { sessionId: live.sessionId, prompt: [{ type: "text", text: turn }] }));
    live.onDelta = null;
    live.onTool = null;
    live.steers = [];
    if (!done) {
      kill(live);
      return { text: "", error: "Cursor took too long", limit: false };
    }
    if (done.error) return { text: "", error: `Cursor failed: ${why(done)}`, limit: false };
    Object.assign(live, { fresh: false, last: text });
    afterTurn(live);
    return { text: reply.trim(), error: null, limit: false };
  }

  /**
   * Waits for a question's work to finish, through each hand-over of your messages: when one took over, its
   * result is the one that counts, and messages still waiting when the work ends go in as a follow-up. Work is
   * only given up on when Cursor says nothing for `turnMs`, so a long build isn't cut off.
   * @param {Live} live
   * @param {Promise<RpcMessage>} call
   * @returns {Promise<RpcMessage | null>} Null when it went quiet for too long.
   */
  async function untilSettled(live, call) {
    let current = call;
    live.active = Date.now();
    for (;;) {
      const done = await within(current, turnMs);
      if (!done && Date.now() - live.active < turnMs) continue;
      if (!done || done.error) return done;
      if (!live.next && live.steers.length) handOver(live);
      if (!live.next) return done;
      current = live.next;
      live.next = null;
    }
  }

  /**
   * Adds a message to the question in progress, without stopping it: it's handed over when the current step
   * finishes, or as a follow-up when the work ends first.
   * @param {string} text
   * @returns {Promise<boolean>} Whether a question was in progress to take it.
   */
  async function steer(text) {
    const live = starting && (await starting);
    if (!live || live.dead || !live.onDelta) return false;
    live.steers.push(text);
    return true;
  }

  /**
   * Asks a question in the session, one at a time, in order.
   * @param {string} text
   * @param {string} [model]
   * @param {CursorAsk} [options]
   * @returns {Promise<BrainAnswer | null>} Null when the session can't take it (it couldn't start, or doesn't
   *   list the model) and nothing was asked, so a one-off run can answer instead.
   */
  function ask(text, model, options = {}) {
    const run = queue.then(() => prompt(text, model, options));
    queue = run;
    return run;
  }

  /**
   * Starts the session ahead of a question, or keeps an idle one open longer.
   * @returns {Promise<void>}
   */
  async function warm() {
    const live = await ready();
    if (!live || live.onDelta) return;
    clearTimeout(live.idle);
    live.idle = setTimeout(() => kill(live), idleMs);
  }

  /**
   * Stops the question in progress, as when you click Stop: the session ends, and the next question starts a new one.
   * @returns {Promise<boolean>} Whether a question was in progress.
   */
  async function stop() {
    const live = starting && (await starting);
    if (!live || live.dead || !live.onDelta) return false;
    live.rpc.fail("Stopped");
    kill(live);
    return true;
  }

  /** Ends the session. */
  async function close() {
    const live = starting && (await starting);
    starting = null;
    if (live) kill(live);
  }

  return { ask, warm, close, steer, stop };
}
