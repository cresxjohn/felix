/**
 * Felix's builder and helpers: the AI runs that do his background jobs (felix-jobs.mjs).
 *
 * The builder writes a tool Felix is missing, in a folder of its own: it reads a brief (what's needed, how a tool
 * looks, every service it can reach), writes the tool and its test, tries it on your real data through Felix's
 * `tool_try`, and leaves it for Felix, who checks it, runs its test and saves it to his toolbox. It always runs Opus
 * 5.5 at high effort: on Claude while your Claude plan has room, else the same model on Cursor. It has full say in
 * its folder and never asks you anything.
 *
 * A helper answers a question or does a task with all of Felix's tools, apart from the conversation, and its
 * answer reaches you on its own. Actions it takes still ask you first through Felix's cards.
 */
import { spawn as nodeSpawn } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { eachLine, parsed } from "./felix-lines.mjs";
import { claudeStep, commandStep } from "./felix-steps.mjs";

const BUILD_MS = 30 * 60_000;
const HELP_MS = 15 * 60_000;
const TEST_MS = 2 * 60_000;
const APPROVE_MS = 20_000;
// What a helper's answer starts with, so the working notes before it never reach you.
const ANSWER_MARK = "ANSWER:";
const LIMIT_TEXT = /usage limit|rate limit|limit reached|out of (usage|credits)|quota/i;
/** The one model that builds Felix's tools, on each AI tool. */
export const BUILDER = Object.freeze({
  claude: Object.freeze({ tool: "claude", model: "claude-opus-5-5", effort: "high", name: "Claude Opus 5.5 High" }),
  cursor: Object.freeze({ tool: "cursor", model: "claude-opus-5-5-high", effort: "high", name: "Claude Opus 5.5 High (Cursor)" }),
});

/**
 * @typedef {{ tool: "claude" | "cursor", model: string, effort?: string, name: string }} Runner Which AI runs a job.
 * @typedef {{ text: string, error: string | null, limit: boolean }} RunOut
 */

/**
 * The builder for now: Claude's Opus 5.5 High while your Claude plan has room, Cursor's once it's used up. Building
 * goes by your Claude limit alone, whichever AI tool the chat uses.
 * @param {{ claudeUsedUp: boolean }} state
 * @returns {Runner}
 */
export const pickBuilder = ({ claudeUsedUp }) => (claudeUsedUp ? BUILDER.cursor : BUILDER.claude);

/**
 * A helper's AI: Opus on Claude while the plan has room, else Opus on Cursor; Cursor's when Settings use Cursor only.
 * @param {{ claudeUsedUp: boolean, tool?: unknown }} state
 * @returns {Runner}
 */
export const pickHelper = ({ claudeUsedUp, tool }) => (claudeUsedUp || tool === "cursor"
  ? { tool: "cursor", model: "claude-opus-5-5-medium", name: "Claude Opus 5.5 (Cursor)" }
  : { tool: "claude", model: "opus", name: "Claude Opus" });

/**
 * The words a Cursor tool call shows as: the CLI names each kind ("shellToolCall", "readToolCall").
 * @param {Record<string, any>} call
 * @returns {string}
 */
export function cursorCliStep(call = {}) {
  const [kind, body] = Object.entries(call)[0] || [];
  if (!kind) return "Working";
  if (/shell/i.test(kind)) return commandStep(String(body?.args?.command || ""));
  if (/mcp/i.test(kind)) return claudeStep(`mcp__felix__${body?.args?.toolName || body?.args?.name || ""}`);
  if (/read|glob|grep|ls/i.test(kind)) return "Looking through your records";
  if (/edit|write|delete/i.test(kind)) return "Making a change";
  return "Working";
}

/**
 * Runs one AI job to its end: Claude Code or Cursor's CLI, in a folder, with Felix's tools, passing on each step.
 * @param {{ who: Runner, prompt: string, cwd: string, bin: string, cursorBin: string, mcpConfig: string,
 *   settings?: string, bypass?: boolean, ms: number, spawnImpl: typeof nodeSpawn, onStep?: (s: string) => void }} o
 * @returns {Promise<RunOut>}
 */
export function runAi({ who, prompt, cwd, bin, cursorBin, mcpConfig, settings, bypass = false, ms, spawnImpl, onStep = () => {} }) {
  const args = who.tool === "claude"
    ? ["-p", "--model", who.model, ...(who.effort ? ["--effort", who.effort] : []), "--mcp-config", mcpConfig, "--strict-mcp-config",
      "--setting-sources", "", "--no-session-persistence", ...(settings ? ["--settings", settings] : []),
      ...(bypass ? ["--permission-mode", "bypassPermissions"] : ["--permission-prompt-tool", "mcp__felix__allow", "--tools", "", "--allowedTools", "mcp__felix"]),
      "--output-format", "stream-json", "--verbose", prompt]
    : ["-p", "--model", who.model, "--force", "--trust", "--approve-mcps", "--output-format", "stream-json", "--workspace", cwd, prompt];
  return new Promise((resolve) => {
    const proc = spawnImpl(who.tool === "claude" ? bin : cursorBin, args, { cwd, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
    let result = null;
    let rejected = false;
    let problem = "";
    let over = false;
    const end = (out) => {
      if (over) return;
      over = true;
      clearTimeout(timer);
      resolve(out);
    };
    const timer = setTimeout(() => {
      end({ text: "", error: "It took too long, so I stopped it.", limit: false });
      proc.kill();
    }, ms);
    eachLine(proc.stdout, (line) => {
      const e = parsed(line);
      if (!e) return;
      if (e.type === "rate_limit_event" && e.rate_limit_info?.status === "rejected") rejected = true;
      if (e.type === "assistant" && who.tool === "claude") {
        for (const c of e.message?.content || []) if (c.type === "tool_use") onStep(claudeStep(c.name, c.input));
      }
      if (e.type === "tool_call" && e.subtype === "started") onStep(cursorCliStep(e.tool_call));
      if (e.type === "result") result = e;
    });
    proc.stderr?.on("data", (d) => { problem = String(d).trim().slice(-400) || problem; });
    proc.on("error", (err) => end({ text: "", error: `Couldn't start it: ${err.message}`, limit: false }));
    proc.on("close", (code) => {
      if (result && !result.is_error) return end({ text: String(result.result || "").trim(), error: null, limit: false });
      const why = String(result?.result || problem || `it stopped with code ${code}`);
      end({ text: "", error: why, limit: who.tool === "claude" && (rejected || LIMIT_TEXT.test(why)) });
    });
  });
}

/**
 * A helper's answer for you: what follows its last answer mark, or all it said when it wrote none.
 * @param {string} text
 * @returns {string}
 */
export const answerOf = (text) => {
  const at = String(text).lastIndexOf(ANSWER_MARK);
  return (at < 0 ? String(text) : String(text).slice(at + ANSWER_MARK.length)).trim();
};

/**
 * Felix's tool server for a job's folder: Claude reads it from a file, Cursor from .cursor/mcp.json there.
 * @param {string} cwd
 * @param {{ url: string, token: string, bridge: string }} mcp
 * @returns {Promise<string>} The Claude config file.
 */
async function wireMcp(cwd, mcp) {
  await mkdir(path.join(cwd, ".cursor"), { recursive: true });
  const claude = path.join(cwd, ".felix-mcp.json");
  await writeFile(claude, JSON.stringify({ mcpServers: { felix: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } } } }), { mode: 0o600 });
  await writeFile(path.join(cwd, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { felix: { command: process.execPath, args: [mcp.bridge], env: { FELIX_MCP_URL: mcp.url, FELIX_MCP_TOKEN: mcp.token } } } }), { mode: 0o600 });
  return claude;
}

/**
 * Today, for the AI: the date, the weekday and the time zone.
 * @param {number} at
 * @returns {string}
 */
const today = (at) => {
  const d = new Date(at);
  return `${d.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })} (${d.toLocaleDateString("en-CA")}), time zone ${Intl.DateTimeFormat().resolvedOptions().timeZone}`;
};

/**
 * The builder's brief: the need, how a tool looks, what it can reach, and how to finish.
 * @param {{ need: string, question: string, extend: { name: string, source: string } | null, docs: Array<[string, string]>,
 *   mine: Array<{ name: string, description: string }>, builtins: string[], at: number }} o
 * @returns {string}
 */
export function buildBrief({ need, question, extend, docs, mine, builtins, at }) {
  return `# Build a tool for Felix

Felix is the user's buddy app. When the user asked him something, none of his tools could get it, so you are
building the tool he's missing. Today is ${today(at)}.

The user asked: "${question}"
What the tool must do: ${need}
${extend ? `\nExtend Felix's existing tool \`${extend.name}\` (its current file is in \`current/${extend.name}.mjs\`). Keep its name, and keep every
input it takes working exactly as before (no input removed, none newly required); only add.\n` : ""}
## What to write

1. \`out/<name>.mjs\`: one tool, as its default export:

\`\`\`js
export default {
  name: "team_leave_year",            // lowercase words joined by _, the same as the file's name
  description: "…",                    // what it gives back and when to use it, for Felix's AI
  step: "Checking the leave tracker",  // plain words the user sees while it runs: no code, names or paths
  inputSchema: { type: "object", properties: { … }, required: [ … ] },
  async run(args, ctx) {               // ctx reaches the user's services (below); give back plain JSON
    …
  },
};
\`\`\`

2. \`out/<name>.test.mjs\`: tests with node:test and node:assert/strict that import \`./<name>.mjs\` and call
   \`run\` with a fake ctx (plain objects with async functions), covering the main case and an edge case. No network.

3. \`out/result.json\`: \`{ "ok": true, "name": "<name>", "summary": "<one plain sentence of what it does>" }\`, or
   \`{ "ok": false, "why": "<plain words>" }\` when it truly can't be done with what ctx reaches.

## Rules

- Make it general and reusable (any year, any person, any kind), not just for this one question, with sensible defaults.
- Only \`ctx\` reaches the user's data. Never import child_process, worker_threads or keychain code, never read
  process.env, secrets or files outside this folder. A tool only reads, except the user's tasks, which it may change.
- Split big date ranges into pieces when a service has a limit, and handle a service that fails with a clear error.
- Give back compact JSON: what the question needs, not raw dumps. Dates as YYYY-MM-DD.
- Before you finish: run \`node --test out/<name>.test.mjs\`, and try the tool on the user's real data with the
  \`tool_try\` tool (file: the path to \`out/<name>.mjs\`, args), and fix what's wrong. Don't answer the user's question
  yourself; Felix will, with your tool.
- Don't use a name Felix already has: ${[...builtins, ...mine.map((t) => t.name)].join(", ") || "none yet"}.

## What ctx reaches

${docs.map(([p, doc]) => `- \`ctx.${p}${doc}\``).join("\n")}

## Felix's own tools so far

${mine.length ? mine.map((t) => `- ${t.name}: ${t.description}`).join("\n") : "None yet."}
`;
}

/**
 * Creates the builder and helper runners for Felix's jobs.
 * @param {{ toolbox: ReturnType<typeof import("./felix-toolbox.mjs").createToolbox>, dir: string, repo: string, bin: string,
 *   cursorBin: string, mcp: { url: string, token: string, bridge: string }, docs: Array<[string, string]>,
 *   state: () => Promise<{ claudeUsedUp: boolean, tool?: unknown }>, spawnImpl?: typeof nodeSpawn, now?: () => number,
 *   buildMs?: number, helpMs?: number, testMs?: number, rules?: string }} o `dir` holds each job's folder; `state` says
 *   whether Claude's plan is used up right now.
 */
export function createBuilder({ toolbox, dir, repo, bin, cursorBin, mcp, docs, state, spawnImpl = nodeSpawn, now = Date.now,
  buildMs = BUILD_MS, helpMs = HELP_MS, testMs = TEST_MS, rules = "" }) {
  // Felix's own code stays as it is: the builder only writes in its folder, and Felix saves the tool himself.
  const settings = JSON.stringify({
    permissions: {
      deny: [
        ...["~/.ssh/**", "~/.aws/**", "~/.gnupg/**", "~/.config/gh/**", "~/Library/Keychains/**", "**/.env", "**/.env.*", "**/*.pem", "**/*.key"].map((s) => `Read(${s})`),
        ...["*.mjs", "public/**", "tools/**", "test/**", "prs", "docs/**", "voice/**"].map((s) => `Edit(/${path.join(repo, s)})`),
      ],
    },
  });

  /**
   * Runs the AI, on Cursor's same model when Claude turns out to be out of usage.
   * @param {Runner} who
   * @param {Omit<Parameters<typeof runAi>[0], "who" | "bin" | "cursorBin" | "spawnImpl">} o
   * @param {(who: Runner) => void} onWho
   * @returns {Promise<RunOut & { who: Runner }>}
   */
  async function run(who, o, onWho) {
    const go = async (w) => {
      onWho(w);
      if (w.tool === "cursor") await approveCursor(o.cwd);
      return { ...(await runAi({ ...o, who: w, bin, cursorBin, spawnImpl })), who: w };
    };
    const out = await go(who);
    return out.limit ? go(who.effort ? BUILDER.cursor : pickHelper({ claudeUsedUp: true })) : out;
  }

  /**
   * Approves Felix's tool server for Cursor in a job's folder: Cursor won't load a folder's tool server it hasn't
   * approved, even when told to approve them all.
   * @param {string} cwd
   * @returns {Promise<void>}
   */
  function approveCursor(cwd) {
    return new Promise((resolve) => {
      const proc = spawnImpl(cursorBin, ["mcp", "enable", "felix"], { cwd, stdio: "ignore" });
      const timer = setTimeout(() => { proc.kill(); resolve(); }, APPROVE_MS);
      const done = () => { clearTimeout(timer); resolve(); };
      proc.on("error", done);
      proc.on("close", done);
    });
  }

  /**
   * Runs a tool's test.
   * @param {string} file
   * @param {string} cwd
   * @returns {Promise<{ ok: boolean, tail: string }>}
   */
  function test(file, cwd) {
    return new Promise((resolve) => {
      const proc = spawnImpl(process.execPath, ["--test", "--test-force-exit", file], { cwd, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      const keep = (d) => { out = (out + d).slice(-3000); };
      proc.stdout?.on("data", keep);
      proc.stderr?.on("data", keep);
      const timer = setTimeout(() => proc.kill(), testMs);
      proc.on("error", () => { clearTimeout(timer); resolve({ ok: false, tail: "The test didn't start." }); });
      proc.on("close", (code) => { clearTimeout(timer); resolve({ ok: code === 0, tail: out.trim().split("\n").slice(-12).join("\n") }); });
    });
  }

  /**
   * Answers a question or does a task with Felix's tools, apart from the conversation.
   * @param {string} task
   * @param {import("./felix-jobs.mjs").Job} job
   * @param {{ step: (s: string) => void, by: (who: string) => void }} ctl
   * @returns {Promise<string>}
   */
  async function help(task, job, ctl) {
    const cwd = path.join(dir, job.id, "helper");
    await mkdir(cwd, { recursive: true });
    const mcpConfig = await wireMcp(cwd, mcp);
    const prompt = `${rules ? `${rules}\n\n` : ""}Today is ${today(now())}.

You're one of Felix's helpers, working in the background while Felix keeps talking with the user. Do this, using
Felix's tools (they reach the user's calendar, team leave, Jira, Slack, tasks, PRs and the tools Felix built), then
give your answer as Felix would say it to the user: short, plain, friendly words for chat and voice, with no code,
ids, tool names or file paths. Work quietly, then write "${ANSWER_MARK}" on its own line, followed by only the
answer for the user.

${task}`;
    const out = await run(pickHelper(await state()), { prompt, cwd, mcpConfig, ms: helpMs, onStep: ctl.step }, (w) => ctl.by(w.name));
    if (out.error) throw Object.assign(new Error(out.error), { retry: !out.limit });
    return answerOf(out.text);
  }

  /**
   * Builds the tool a job needs, saves it to Felix's toolbox, then answers the user's question with it.
   * @type {import("./felix-jobs.mjs").Runner}
   */
  async function build(job, ctl) {
    const { need, question, extend } = job.input;
    const cwd = path.join(dir, job.id);
    await mkdir(path.join(cwd, "out"), { recursive: true });
    const own = toolbox.list().filter((t) => t.own);
    const ext = extend ? own.find((t) => t.name === extend) : null;
    if (ext) {
      await mkdir(path.join(cwd, "current"), { recursive: true });
      const source = await readFile(path.join(repo, "tools", `${ext.name}.mjs`), "utf8");
      await writeFile(path.join(cwd, "current", `${ext.name}.mjs`), source);
    }
    await writeFile(path.join(cwd, "BRIEF.md"), buildBrief({
      need, question, extend: ext ? { name: ext.name, source: "" } : null, docs, at: now(),
      mine: own.map((t) => ({ name: t.name, description: t.description })), builtins: toolbox.list().filter((t) => !t.own).map((t) => t.name),
    }));
    const mcpConfig = await wireMcp(cwd, mcp);
    let prompt = "Read BRIEF.md in this folder and build the tool it asks for. Work on your own: nobody will answer questions.";
    let made = null;
    for (let round = 1; round <= 2 && !made; round++) {
      ctl.step(round === 1 ? "Building a new tool" : "Fixing the new tool");
      const out = await run(pickBuilder(await state()), { prompt, cwd, mcpConfig, settings, bypass: true, ms: buildMs, onStep: (s) => ctl.step(`Building: ${s}`) }, (w) => ctl.by(w.name));
      if (out.error) throw Object.assign(new Error(out.error), { retry: !out.limit, said: "I couldn't finish building a way to check that this time. I'll need another go at it." });
      const result = await readFile(path.join(cwd, "out", "result.json"), "utf8").then(JSON.parse, () => null);
      if (result && result.ok === false) {
        throw Object.assign(new Error(String(result.why)), { said: `I looked into it, but I can't build a way to check that yet: ${result.why}` });
      }
      const name = result?.name || (await readdir(path.join(cwd, "out")).catch(() => [])).find((f) => f.endsWith(".mjs") && !f.endsWith(".test.mjs"))?.slice(0, -4);
      const file = name ? path.join(cwd, "out", `${name}.mjs`) : null;
      const testFile = name ? path.join(cwd, "out", `${name}.test.mjs`) : null;
      if (!file) {
        prompt = "There's no tool in out/ yet. Read BRIEF.md and finish the tool, its test and out/result.json.";
        continue;
      }
      ctl.step("Checking the new tool");
      const checked = await toolbox.check(file);
      const tested = checked.problem ? null : await test(testFile, cwd);
      if (checked.problem || !tested?.ok) {
        prompt = `Felix checked out/${name}.mjs and it isn't ready: ${checked.problem || `its test fails:\n${tested?.tail}`}\nFix it (BRIEF.md has the rules), run the test again and update out/result.json.`;
        continue;
      }
      ctl.step("Saving the new tool");
      const saved = await toolbox.deploy({ file, testFile, by: job.by || "Felix", job: job.id });
      if (!saved.ok) {
        prompt = `Felix couldn't save out/${name}.mjs: ${saved.problem}\nFix it (BRIEF.md has the rules), run the test again and update out/result.json.`;
        continue;
      }
      made = { ...saved, summary: result?.summary || "" };
    }
    if (!made) throw Object.assign(new Error("The tool still wasn't right after two tries."), { said: "I tried twice but couldn't get a way to check that working yet." });
    ctl.step("Using the new tool");
    const answer = await help(`The user asked: "${question}". You now have a tool for it: ${made.name}${made.summary ? ` (${made.summary})` : ""}. Use it, and answer the question.`, job, ctl);
    return { answer, result: { tool: made.name, version: made.version, extended: made.extended } };
  }

  return {
    build,
    /** @type {import("./felix-jobs.mjs").Runner} */
    task: async (job, ctl) => ({ answer: await help(String(job.input.task), job, ctl) }),
    /** Whether a file is inside a job's folder, for tool_try. @param {string} file */
    inside: (file) => {
      const full = path.resolve(String(file));
      return full.startsWith(`${path.resolve(dir)}${path.sep}`) && full.endsWith(".mjs");
    },
  };
}
