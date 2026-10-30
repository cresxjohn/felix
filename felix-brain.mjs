/**
 * Felix's AI: Claude Code's CLI kept open between questions (a warm session), so an answer doesn't wait for
 * Claude to start. One session per model; one question at a time in each. With Felix's gate it's an agent: it
 * works in Felix's workbench with all of Claude Code's tools, edits there freely, runs sandboxed commands there,
 * and asks the gate (Felix's MCP "allow" tool) before anything else, so a change waits for your yes. None of your
 * own Claude settings or MCP servers load. Without the gate it gets no tools at all.
 *
 * Cursor answers in its own open session (see felix-cursor.mjs), or in a one-off read-only run inside a sandbox
 * when that session can't. Both pass the reply's text on as it's written, and each tool they use, so Felix can
 * show what's happening. A session that's had enough questions is replaced right away, so the next one doesn't wait.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { createCursorSession, steerText } from "./felix-cursor.mjs";
import { eachLine, parsed } from "./felix-lines.mjs";
import { ALLOW_TOOL } from "./felix-mcp.mjs";
import { claudeStep } from "./felix-steps.mjs";

// A question ends only when the AI says nothing for this long: real work (a long build, a slow test run) keeps
// sending events, so it's never cut off for taking long. Longer than the gate's wait for your yes on a card.
const TURN_MS = 15 * 60_000;
const IDLE_MS = 30 * 60_000;
const MAX_TURNS = 20;
const CURSOR_MS = 20 * 60_000;
const OVER_MS = 60 * 60_000;
const ONCE_MS = 2 * 60_000;
const SEEN_CHARS = 20_000;
const LIMIT_TEXT = /usage limit|rate limit|limit reached|out of (usage|credits)|quota/i;

/**
 * @typedef {{ mcpConfig: string, settings: string }} ClaudeTools Felix's MCP config file (with the gate's "allow"
 *   tool) and the Claude settings for its sandbox, as JSON.
 * @typedef {{ step?: string, seen?: string }} ToolUse A tool the AI used: a step to show, and the text it saw.
 */

/**
 * The arguments for a warm Claude session: an agent behind Felix's gate, or with no tools when there's no gate.
 * @param {string} model
 * @param {string} systemPrompt
 * @param {ClaudeTools} [tools]
 * @returns {string[]}
 */
export const claudeArgs = (model, systemPrompt, tools) => [
  "-p", "--model", model, "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
  ...(tools
    ? ["--permission-mode", "acceptEdits", "--permission-prompt-tool", `mcp__felix__${ALLOW_TOOL}`, "--mcp-config", tools.mcpConfig, "--settings", tools.settings]
    : ["--tools", ""]),
  "--strict-mcp-config", "--no-session-persistence", "--setting-sources", "", "--system-prompt", systemPrompt,
];

/**
 * The arguments for a one-off Claude question with no tools, no session and none of your own settings: a small
 * job like learning from a conversation, answered as one JSON result.
 * @param {string} model
 * @param {string} text
 * @returns {string[]}
 */
export const claudeOnceArgs = (model, text) => [
  "-p", "--model", model, "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence",
  "--output-format", "json", text,
];

/**
 * What a Claude event says about its tools: a step for each tool it starts, and the text of each result.
 * @param {StreamEvent} event
 * @returns {ToolUse[]}
 */
export function claudeTools(event) {
  const content = event.message?.content || [];
  if (event.type === "assistant") {
    return content.filter((c) => c.type === "tool_use").map((c) => ({ step: stepFor(String(c.name), c.input || {}), seen: JSON.stringify(c.input || {}) }));
  }
  if (event.type !== "user") return [];
  return content.filter((c) => c.type === "tool_result").map((c) => ({ seen: textOf(c.content).slice(0, SEEN_CHARS) }));
}

/**
 * The text in a tool result's content.
 * @param {unknown} content
 * @returns {string}
 */
const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "");

/**
 * The step the chat shows for a tool Claude starts, in plain words (no commands or file paths).
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export const stepFor = (name, input) => claudeStep(name, input || {});

/**
 * The arguments for one read-only Cursor run, streaming its text as it's written.
 * @param {string} cwd
 * @param {string} text
 * @param {string} [model]
 * @returns {string[]}
 */
export const cursorArgs = (cwd, text, model) => [
  "-p", ...(model ? ["--model", model] : []), "--output-format", "stream-json", "--stream-partial-output",
  "--mode", "ask", "--sandbox", "enabled", "--trust", "--workspace", cwd, text,
];

/**
 * Claude's environment: thinking off, which Haiku honors (its first words come about 2 seconds sooner) and the
 * models that always think ignore.
 */
const CLAUDE_ENV = { ...process.env, MAX_THINKING_TOKENS: "0" };

/**
 * @typedef {{ type?: string, event?: { delta?: { type?: string, text?: string } },
 *   message?: { content?: Array<{ type: string, text?: string, name?: string, input?: Record<string, unknown>, content?: unknown }> },
 *   timestamp_ms?: number, result?: string, is_error?: boolean, rate_limit_info?: { status?: string, isUsingOverage?: boolean, resetsAt?: number } }} StreamEvent
 */

/**
 * The new text in a streamed Claude event, if it carries any.
 * @param {StreamEvent} event
 * @returns {string}
 */
const claudeDelta = (event) => (event.type === "stream_event" && event.event?.delta?.type === "text_delta" ? String(event.event.delta.text || "") : "");

/**
 * The new text in a streamed Cursor event. Cursor sends each piece with a timestamp, then the whole reply again
 * without one, which is skipped.
 * @param {StreamEvent} event
 * @returns {string}
 */
const cursorDelta = (event) => (event.type === "assistant" && event.timestamp_ms
  ? (event.message?.content || []).filter((c) => c.type === "text").map((c) => c.text).join("")
  : "");

/**
 * One question as Claude's stream-json input line.
 * @param {string} text
 * @returns {string}
 */
export const userLine = (text) => `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

/**
 * Whether a finished turn failed on Claude's usage limit. A limit Claude reports as rejected while extra usage
 * carries on still answers, so only a failed turn counts.
 * @param {{ is_error?: boolean, result?: string }} result
 * @param {boolean} rejected Whether Claude reported its rate limit as rejected during the turn.
 * @returns {boolean}
 */
export const hitLimit = (result, rejected) => Boolean(result.is_error) && (rejected || LIMIT_TEXT.test(String(result.result || "")));

/**
 * What a finished Cursor run answered.
 * @param {StreamEvent | null} result Its result event, if it wrote one.
 * @param {number | null} code Its exit code.
 * @param {string} problem The last thing it wrote to stderr.
 * @returns {BrainAnswer}
 */
export function cursorAnswer(result, code, problem) {
  if (result && !result.is_error) return { text: String(result.result || "").trim(), error: null, limit: false };
  const why = (result && String(result.result || "")) || problem || `it exited with code ${code}`;
  return { text: "", error: `Cursor failed: ${why}`, limit: false };
}

/**
 * @typedef {{ text: string, error: string | null, limit: boolean }} BrainAnswer
 * @typedef {{ onDelta?: (text: string) => void, onTool?: (use: ToolUse) => void, before?: string }} AskOptions `onDelta` gets
 *   each new piece of the reply as it's written, and `onTool` each tool the AI uses. `before` is the turn a Cursor
 *   question follows, for when Cursor didn't see it.
 * @typedef {{ ask: (text: string, model?: string, options?: AskOptions) => Promise<BrainAnswer | null>, warm: () => Promise<void>,
 *   close: () => Promise<void>, steer?: (text: string) => Promise<boolean>, stop?: () => Promise<boolean> }} CursorSession
 * @typedef {{ text: string, resolve: (a: BrainAnswer) => void, onDelta?: (text: string) => void, onTool?: (use: ToolUse) => void,
 *   timer?: ReturnType<typeof setTimeout>, rejected?: boolean, steers?: string[], before?: string }} Turn `steers` are
 *   your messages waiting for Claude's part to end; `before` is what it answered ahead of them.
 * @typedef {{ proc: import("node:child_process").ChildProcess, queue: Turn[], current: Turn | null, turns: number, idle?: ReturnType<typeof setTimeout> }} Session
 */

/**
 * Creates Felix's AI.
 * @param {{ bin: string, cursorBin: string, cwd: string, systemPrompt: string | (() => string), spawnImpl?: typeof nodeSpawn,
 *   turnMs?: number, idleMs?: number, maxTurns?: number, cursorMs?: number, now?: () => number, cursorSession?: CursorSession,
 *   tools?: ClaudeTools, allow?: import("./felix-cursor.mjs").Allow, onceMs?: number }} options `systemPrompt` is read again
 *   for each new session. `tools` makes Claude an agent behind Felix's gate; `allow` is the gate's answer for Cursor;
 *   `onceMs` is how long a one-off question may take.
 */
export function createBrain({ bin, cursorBin, cwd, systemPrompt, spawnImpl = nodeSpawn, turnMs = TURN_MS, idleMs = IDLE_MS,
  maxTurns = MAX_TURNS, cursorMs = CURSOR_MS, now = Date.now, cursorSession, tools, allow, onceMs = ONCE_MS, mcpServers = [] }) {
  /** @type {Map<string, Session>} */
  const sessions = new Map();
  const rules = () => (typeof systemPrompt === "function" ? systemPrompt() : systemPrompt);
  const cursor = cursorSession || createCursorSession({ bin: cursorBin, cwd, systemPrompt: rules, spawnImpl, turnMs: cursorMs, idleMs, maxTurns, allow, mcpServers });
  /** @type {Set<() => void>} How to stop each one-off Cursor run in progress. */
  const onceRuns = new Set();
  let paidUntil = 0;

  /**
   * Notes what Claude said about its limits: past one (billed as extra usage, or refused), until it resets.
   * @param {{ status?: string, isUsingOverage?: boolean, resetsAt?: number }} [info]
   */
  function noteLimit(info) {
    if (!info) return;
    const over = info.isUsingOverage === true || info.status === "rejected";
    paidUntil = over ? (info.resetsAt ? info.resetsAt * 1000 : now() + OVER_MS) : 0;
  }

  /**
   * Ends a session; any question still waiting gets the reason.
   * @param {string} model
   * @param {string} reason
   */
  function end(model, reason) {
    const s = sessions.get(model);
    if (!s) return;
    sessions.delete(model);
    clearTimeout(s.idle);
    for (const turn of [s.current, ...s.queue]) if (turn) finish(turn, { text: "", error: reason, limit: false });
    s.current = null;
    s.queue = [];
    s.proc.kill();
  }

  /**
   * Answers a question once.
   * @param {Turn} turn
   * @param {BrainAnswer} answer
   */
  function finish(turn, answer) {
    clearTimeout(turn.timer);
    turn.resolve(answer);
  }

  /**
   * Reads one line Claude wrote.
   * @param {string} model
   * @param {Session} s
   * @param {string} line
   */
  function onLine(model, s, line) {
    const event = parsed(line);
    const turn = s.current;
    if (!event || !turn) return;
    quiet(model, turn);
    const delta = claudeDelta(event);
    if (delta) turn.onDelta?.(delta);
    claudeTools(event).forEach((use) => turn.onTool?.(use));
    if (event.type === "rate_limit_event") noteLimit(event.rate_limit_info);
    if (event.type === "rate_limit_event" && event.rate_limit_info?.status === "rejected") turn.rejected = true;
    if (event.type !== "result") return;
    if (!event.is_error && turn.steers?.length) return void carryOn(s, turn, String(event.result || ""));
    s.current = null;
    s.turns += 1;
    const limit = hitLimit(event, Boolean(turn.rejected));
    const text = `${turn.before || ""}${event.is_error ? "" : String(event.result || "")}`.trim();
    finish(turn, { text: event.is_error ? "" : text, error: event.is_error ? String(event.result || "Claude failed") : null, limit });
    if (s.turns >= maxTurns) {
      end(model, "Claude restarted");
      return void open(model);
    }
    touch(model, s);
    next(model, s);
  }

  /**
   * Keeps a question going with the messages you sent while Claude worked on it: Claude finished its part, so
   * they go in as a follow-up in the same session, and the answer is both parts together.
   * @param {Session} s
   * @param {Turn} turn
   * @param {string} part What Claude answered so far.
   */
  function carryOn(s, turn, part) {
    turn.before = `${turn.before || ""}${part.trim()}\n\n`;
    turn.onDelta?.("\n\n");
    s.proc.stdin?.write(userLine(steerText(turn.steers?.splice(0) || [])));
  }

  /**
   * Adds a message to the question in progress, without stopping it: Claude gets it when its current part ends;
   * Cursor, when its current step does.
   * @param {string} text
   * @returns {Promise<boolean>} Whether a question was in progress to take it.
   */
  async function steer(text) {
    const turn = [...sessions.values()].map((s) => s.current).find(Boolean);
    if (!turn) return cursor.steer ? cursor.steer(text) : false;
    turn.steers = [...(turn.steers || []), text];
    return true;
  }

  /**
   * Gives an idle session a fresh idle time before it closes.
   * @param {string} model
   * @param {Session} s
   */
  function touch(model, s) {
    clearTimeout(s.idle);
    if (!s.current) s.idle = setTimeout(() => end(model, "Claude was idle"), idleMs);
  }

  /**
   * Starts a session for a model, or returns the open one.
   * @param {string} model
   * @returns {Session}
   */
  function open(model) {
    const found = sessions.get(model);
    if (found) return found;
    const proc = spawnImpl(bin, claudeArgs(model, rules(), tools), { cwd, env: CLAUDE_ENV, stdio: ["pipe", "pipe", "ignore"] });
    /** @type {Session} */
    const s = { proc, queue: [], current: null, turns: 0 };
    sessions.set(model, s);
    eachLine(proc.stdout, (line) => onLine(model, s, line));
    proc.on("error", (err) => sessions.get(model) === s && end(model, `Claude couldn't start: ${err.message}`));
    proc.on("exit", () => sessions.get(model) === s && end(model, "Claude stopped"));
    return s;
  }

  /**
   * Gives a question in progress a fresh stretch of quiet before it's given up on: it ends only when Claude has
   * said nothing at all for that long.
   * @param {string} model
   * @param {Turn} turn
   */
  function quiet(model, turn) {
    clearTimeout(turn.timer);
    turn.timer = setTimeout(() => end(model, "Claude took too long"), turnMs);
  }

  /**
   * Sends the next waiting question, when none is in progress.
   * @param {string} model
   * @param {Session} s
   */
  function next(model, s) {
    if (s.current || !s.queue.length) return;
    clearTimeout(s.idle);
    const turn = s.queue.shift();
    if (!turn) return;
    s.current = turn;
    quiet(model, turn);
    s.proc.stdin?.write(userLine(turn.text));
  }

  /**
   * Asks Claude a question in the model's warm session.
   * @param {string} model
   * @param {string} text
   * @param {AskOptions} [options]
   * @returns {Promise<BrainAnswer>}
   */
  function ask(model, text, { onDelta, onTool } = {}) {
    const s = open(model);
    return new Promise((resolve) => {
      s.queue.push({ text, resolve, onDelta, onTool });
      next(model, s);
    });
  }

  /**
   * Asks Cursor, read-only: in its open session, or in a one-off run when the session can't take the question.
   * @param {string} text
   * @param {string} [model] A Cursor model, like "composer-2.5-fast"; Cursor's own default when left out.
   * @param {AskOptions} [options]
   * @returns {Promise<BrainAnswer>}
   */
  async function askCursor(text, model, options = {}) {
    return (await cursor.ask(text, model, options)) || askCursorOnce([rules(), options.before, text].filter(Boolean).join("\n\n"), model, options);
  }

  /**
   * Asks Cursor's CLI once, in a fresh read-only run.
   * @param {string} text The rules and the question together, since the run starts fresh.
   * @param {string} [model]
   * @param {AskOptions} [options]
   * @returns {Promise<BrainAnswer>}
   */
  function askCursorOnce(text, model, { onDelta } = {}) {
    return new Promise((resolve) => {
      const proc = spawnImpl(cursorBin, cursorArgs(cwd, text, model), { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let result = null;
      let problem = "";
      const stopIt = () => {
        proc.kill();
        done({ text: "", error: "Stopped", limit: false });
      };
      onceRuns.add(stopIt);
      const done = (answer) => {
        clearTimeout(timer);
        onceRuns.delete(stopIt);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        proc.kill();
        done({ text: "", error: "Cursor took too long", limit: false });
      }, cursorMs);
      eachLine(proc.stdout, (line) => {
        const event = parsed(line);
        if (!event) return;
        const delta = cursorDelta(event);
        if (delta) onDelta?.(delta);
        if (event.type === "result") result = event;
      });
      eachLine(proc.stderr, (line) => { problem = line.trim(); });
      proc.on("error", (err) => done({ text: "", error: `Cursor failed: ${err.message}`, limit: false }));
      proc.on("close", (code) => done(cursorAnswer(result, code, problem)));
    });
  }

  /**
   * Asks a one-off question for a small job, apart from the conversation's sessions: a Claude model in a fresh run
   * with no tools, or a read-only Cursor run.
   * @param {string} text
   * @param {{ tool: "claude" | "cursor", model: string }} pick
   * @returns {Promise<BrainAnswer>}
   */
  function once(text, { tool, model }) {
    if (tool === "cursor") return askCursorOnce(text, model);
    return new Promise((resolve) => {
      const proc = spawnImpl(bin, claudeOnceArgs(model, text), { cwd, env: CLAUDE_ENV, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const done = (answer) => {
        clearTimeout(timer);
        resolve(answer);
      };
      const timer = setTimeout(() => {
        proc.kill();
        done({ text: "", error: "Claude took too long", limit: false });
      }, onceMs);
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (d) => { out += d; });
      proc.on("error", (err) => done({ text: "", error: `Claude couldn't start: ${err.message}`, limit: false }));
      proc.on("close", () => {
        const result = parsed(out.trim());
        if (!result || result.is_error) return done({ text: "", error: String(result?.result || "Claude failed"), limit: hitLimit(result || {}, false) });
        done({ text: String(result.result || ""), error: null, limit: false });
      });
    });
  }

  return {
    ask,
    askCursor,
    once,
    systemPrompt,
    /**
     * Whether Claude last said its plan's limit is used up, so a question now would be billed as extra usage.
     * @returns {boolean}
     */
    pastLimit: () => now() < paidUntil,
    /** Starts a model's session ahead of a question, or keeps an idle one open longer. @param {string} model */
    warm: (model) => touch(model, open(model)),
    /** Starts Cursor's session ahead of a question, or keeps it open longer. */
    warmCursor: () => void cursor.warm(),
    steer,
    /**
     * Stops the work in progress, as when you click Stop: a Claude session busy with a question ends (the next
     * question starts a fresh one), and so does Cursor's busy session or one-off run.
     * @returns {Promise<boolean>} Whether anything was working.
     */
    stop: async () => {
      const busy = [...sessions.entries()].filter(([, s]) => s.current).map(([m]) => m);
      busy.forEach((m) => end(m, "Stopped"));
      const runs = [...onceRuns];
      runs.forEach((fn) => fn());
      const cursorBusy = Boolean(await cursor.stop?.());
      return busy.length > 0 || runs.length > 0 || cursorBusy;
    },
    /** Ends every session. */
    close: () => {
      [...sessions.keys()].forEach((m) => end(m, "Felix closed"));
      void cursor.close();
    },
  };
}
