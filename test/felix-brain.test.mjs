import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { claudeArgs, claudeTools, createBrain, cursorAnswer, cursorArgs, hitLimit, stepFor, userLine } from "../felix-brain.mjs";

/**
 * A pretend Claude process. `reply` answers each question line with the events to write back.
 * @param {(question: string, n: number) => object[] | null} reply
 * @returns {{ spawnImpl: Function, procs: Array<EventEmitter & { args: string[], killed: boolean }> }}
 */
function fakeClaude(reply) {
  const procs = [];
  const spawnImpl = (bin, args, options) => {
    const proc = Object.assign(new EventEmitter(), { bin, args, options, killed: false, stdout: new PassThrough(), written: [] });
    let n = 0;
    proc.stdin = new Writable({
      write(chunk, _enc, done) {
        const question = JSON.parse(String(chunk)).message.content[0].text;
        proc.written.push(question);
        const events = reply(question, n++);
        if (events) setImmediate(() => proc.stdout.write(events.map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n") + "\n"));
        done();
      },
    });
    proc.kill = () => {
      proc.killed = true;
      setImmediate(() => proc.emit("exit", 0));
    };
    procs.push(proc);
    return proc;
  };
  return { spawnImpl, procs };
}

const result = (text, extra = {}) => ({ type: "result", result: text, is_error: false, ...extra });
const brainWith = (reply, extra = {}) => {
  const fake = fakeClaude(reply);
  return { ...fake, brain: createBrain({ bin: "claude", cursorBin: "agent", cwd: "/tmp/felix", systemPrompt: "Be Felix.", spawnImpl: fake.spawnImpl, ...extra }) };
};

test("the session runs Claude with no tools, MCP servers or settings", () => {
  const args = claudeArgs("haiku", "Be Felix.");
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "haiku"]);
  for (const flag of ["--tools", "--strict-mcp-config", "--no-session-persistence", "--setting-sources"]) assert.ok(args.includes(flag), flag);
  assert.equal(args[args.indexOf("--tools") + 1], "");
  assert.equal(args.at(-1), "Be Felix.");
  assert.deepEqual(JSON.parse(userLine("hi")), { type: "user", message: { role: "user", content: [{ type: "text", text: "hi" }] } });
});

test("with Felix's gate, Claude is an agent: it edits freely and asks the gate before anything else", () => {
  const args = claudeArgs("opus", "Be Felix.", { mcpConfig: "/tmp/mcp.json", settings: "{\"sandbox\":{}}" });
  assert.equal(args.includes("--tools"), false);
  assert.equal(args[args.indexOf("--permission-mode") + 1], "acceptEdits");
  assert.equal(args[args.indexOf("--permission-prompt-tool") + 1], "mcp__felix__allow");
  assert.equal(args[args.indexOf("--mcp-config") + 1], "/tmp/mcp.json");
  assert.equal(args[args.indexOf("--settings") + 1], "{\"sandbox\":{}}");
  for (const flag of ["--strict-mcp-config", "--setting-sources"]) assert.ok(args.includes(flag), flag);
});

test("each tool Claude starts is a step, and each result is text Felix can check against", async () => {
  assert.deepEqual(claudeTools({ type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Bash", input: { command: "gh pr list" } }] } }),
    [{ step: "Checking GitHub", seen: "{\"command\":\"gh pr list\"}" }]);
  assert.deepEqual(claudeTools({ type: "user", message: { content: [{ type: "tool_result", content: "fm#1" }, { type: "tool_result", content: [{ type: "text", text: "a" }, { type: "image" }] }, { type: "tool_result" }] } }),
    [{ seen: "fm#1" }, { seen: "a\n" }, { seen: "" }]);
  assert.deepEqual(claudeTools({ type: "result" }), []);
  // Steps are plain words: no tool names, commands or file paths.
  assert.equal(stepFor("Edit", { file_path: "/Users/me/felix/public/home.html" }), "Making a change");
  assert.equal(stepFor("TodoWrite", {}), "Planning the steps");
  assert.equal(stepFor("Bash", { command: "ls; ls memory/*; cat memory/README.md; rg -n clear public/felix.js | head -30" }), "Looking through your records");
  assert.equal(stepFor("Bash", { command: "cd /tmp/wb && ./prs test" }), "Running the tests");
  assert.equal(stepFor("Task", { description: "Add chat clear function" }), "Working on: Add chat clear function");
  const uses = [];
  const { brain, procs } = brainWith(() => [{ type: "assistant", message: { content: [{ type: "tool_use", name: "Read", input: { file_path: "/a/b.md" } }] } }, result("done")],
    { systemPrompt: () => "Rules with memory.", tools: { mcpConfig: "/tmp/mcp.json", settings: "{}" } });
  assert.equal((await brain.ask("opus", "go", { onTool: (u) => uses.push(u) })).text, "done");
  assert.deepEqual(uses.map((u) => u.step), ["Reading a file"]);
  assert.equal(procs[0].args.at(-1), "Rules with memory.");
  brain.close();
});

test("usage limits are spotted from the result or the rate limit event", () => {
  assert.equal(hitLimit({ is_error: true, result: "Claude AI usage limit reached" }, false), true);
  assert.equal(hitLimit({ is_error: true, result: "Something else" }, false), false);
  assert.equal(hitLimit({ is_error: false, result: "rate limit is a fun phrase" }, false), false);
  assert.equal(hitLimit({ is_error: true }, false), false);
  assert.equal(hitLimit({ is_error: true }, true), true);
  assert.equal(hitLimit({ is_error: false, result: "ok" }, true), false);
});

test("an answer given on extra usage, after the limit was rejected, is still used", async () => {
  const { brain } = brainWith(() => [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", isUsingOverage: true } }, result("ok")]);
  assert.deepEqual(await brain.ask("haiku", "hi"), { text: "ok", error: null, limit: false });
  brain.close();
});

test("questions in one session are answered in order, by one process", async () => {
  const { brain, procs } = brainWith((q) => [{ type: "system" }, "not json", { type: "assistant" }, result(` ${q.toUpperCase()} `)]);
  const [a, b] = await Promise.all([brain.ask("haiku", "one"), brain.ask("haiku", "two")]);
  assert.deepEqual(a, { text: "ONE", error: null, limit: false });
  assert.equal(b.text, "TWO");
  assert.equal(procs.length, 1);
  assert.deepEqual(procs[0].written, ["one", "two"]);
  assert.equal(procs[0].options.cwd, "/tmp/felix");
  await brain.ask("sonnet", "three");
  assert.equal(procs.length, 2);
  brain.close();
  assert.ok(procs.every((p) => p.killed));
});

test("a rejected rate limit or an error result comes back as such", async () => {
  const { brain } = brainWith((q) => (q === "limit"
    ? [{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, result("", { is_error: true })]
    : [{ type: "rate_limit_event", rate_limit_info: { status: "allowed" } }, result("Broken", { is_error: true })]));
  assert.deepEqual(await brain.ask("haiku", "limit"), { text: "", error: "Claude failed", limit: true });
  assert.deepEqual(await brain.ask("haiku", "oops"), { text: "", error: "Broken", limit: false });
  brain.close();
});

test("a stuck turn times out, and a dead process fails what's waiting", async () => {
  const slow = brainWith(() => null, { turnMs: 20 });
  assert.equal((await slow.brain.ask("haiku", "hello")).error, "Claude took too long");
  assert.equal(slow.procs[0].killed, true);

  const dead = brainWith(() => null);
  const waiting = [dead.brain.ask("haiku", "a"), dead.brain.ask("haiku", "b")];
  dead.procs[0].emit("exit", 1);
  assert.deepEqual((await Promise.all(waiting)).map((a) => a.error), ["Claude stopped", "Claude stopped"]);

  const broken = brainWith(() => null);
  const pending = broken.brain.ask("haiku", "a");
  broken.procs[0].emit("error", new Error("ENOENT"));
  assert.equal((await pending).error, "Claude couldn't start: ENOENT");
});

test("a session ends when idle, and restarts after enough turns", async () => {
  const idle = brainWith(() => [result("ok")], { idleMs: 10 });
  await idle.brain.ask("haiku", "a");
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(idle.procs[0].killed, true);
  await idle.brain.ask("haiku", "b");
  assert.equal(idle.procs.length, 2);
  idle.brain.close();

  const busy = brainWith(() => [result("ok")], { maxTurns: 2 });
  await busy.brain.ask("haiku", "a");
  await busy.brain.ask("haiku", "b");
  assert.equal(busy.procs[0].killed, true);
  assert.equal(busy.procs.length, 2);
  await busy.brain.ask("haiku", "c");
  assert.equal(busy.procs.length, 2);
  assert.deepEqual(busy.procs[1].written, ["c"]);
  busy.brain.close();
});

test("warming starts a session once, ahead of a question, and keeps an idle one open longer", async () => {
  const { brain, procs } = brainWith(() => [result("ok")]);
  brain.warm("haiku");
  brain.warm("haiku");
  assert.equal(procs.length, 1);
  assert.equal((await brain.ask("haiku", "hi")).text, "ok");
  assert.equal(brain.systemPrompt, "Be Felix.");
  brain.close();
  brain.close();

  const idle = brainWith(() => [result("ok")], { idleMs: 40 });
  idle.brain.warm("haiku");
  await new Promise((r) => setTimeout(r, 25));
  idle.brain.warm("haiku");
  await new Promise((r) => setTimeout(r, 25));
  assert.equal(idle.procs[0].killed, false);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(idle.procs[0].killed, true);
});

/**
 * A pretend Cursor run: it writes `lines` (JSON or raw), then `stderr`, then exits with `code`, unless told to hang.
 * @param {{ lines?: Array<object | string>, stderr?: string, code?: number, hang?: boolean, fail?: Error }} script
 */
function fakeCursor(script) {
  const runs = [];
  const spawnImpl = (bin, args, options) => {
    const proc = Object.assign(new EventEmitter(), { bin, args, options, killed: false, stdout: new PassThrough(), stderr: new PassThrough() });
    proc.kill = () => { proc.killed = true; };
    runs.push(proc);
    setImmediate(() => {
      if (script.fail) return proc.emit("error", script.fail);
      if (script.hang) return;
      proc.stdout.write((script.lines || []).map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
      if (script.stderr) proc.stderr.write(`${script.stderr}\n`);
      setImmediate(() => proc.emit("close", script.code ?? 0));
    });
    return proc;
  };
  return { spawnImpl, runs };
}

/**
 * A pretend Cursor session that answers with `answer`, null meaning it can't take the question.
 * @param {object | null} answer
 */
function fakeSession(answer) {
  const calls = { ask: [], warm: 0, close: 0 };
  return {
    calls,
    ask: async (text, model, options) => {
      calls.ask.push({ text, model, before: options?.before });
      return answer;
    },
    warm: async () => { calls.warm += 1; },
    close: async () => { calls.close += 1; },
  };
}

const cursorBrain = (script, extra = {}) => {
  const fake = fakeCursor(script);
  return { ...fake, brain: createBrain({ bin: "claude", cursorBin: "agent", cwd: "/tmp/felix", systemPrompt: "x", spawnImpl: fake.spawnImpl, cursorSession: fakeSession(null), ...extra }) };
};

test("Cursor answers in its open session when it can, and a one-off run gets the rules and the turn before", async () => {
  const open = fakeSession({ text: "From the session.", error: null, limit: false });
  const { brain, runs } = cursorBrain({}, { cursorSession: open });
  assert.equal((await brain.askCursor("q", "composer-2.5-fast", { before: "earlier" })).text, "From the session.");
  assert.deepEqual(open.calls.ask, [{ text: "q", model: "composer-2.5-fast", before: "earlier" }]);
  assert.equal(runs.length, 0);
  brain.warmCursor();
  brain.close();
  assert.deepEqual([open.calls.warm, open.calls.close], [1, 1]);

  const once = cursorBrain({ lines: [{ type: "result", result: "Once.", is_error: false }] });
  assert.equal((await once.brain.askCursor("q", "m", { before: "earlier" })).text, "Once.");
  assert.equal(once.runs[0].args.at(-1), "x\n\nearlier\n\nq");
});

test("Cursor answers read-only in a sandbox, streaming each piece as it's written", async () => {
  const piece = (text) => ({ type: "assistant", message: { content: [{ type: "text", text }] }, timestamp_ms: 1 });
  const { brain, runs } = cursorBrain({ lines: ["not json", piece("Hi "), piece("there."), { type: "assistant", message: { content: [{ type: "text", text: "Hi there." }] } }, { type: "result", result: " Hi there. ", is_error: false }] });
  const deltas = [];
  assert.deepEqual(await brain.askCursor("hello", "composer-2.5-fast", { onDelta: (d) => deltas.push(d) }), { text: "Hi there.", error: null, limit: false });
  assert.deepEqual(deltas, ["Hi ", "there."]);
  const { bin, args, options } = runs[0];
  assert.equal(bin, "agent");
  assert.deepEqual(args.slice(0, 3), ["-p", "--model", "composer-2.5-fast"]);
  assert.equal(args[args.indexOf("--output-format") + 1], "stream-json");
  assert.ok(args.includes("--stream-partial-output"));
  assert.equal(args[args.indexOf("--mode") + 1], "ask");
  assert.equal(args[args.indexOf("--sandbox") + 1], "enabled");
  assert.equal(args[args.indexOf("--workspace") + 1], "/tmp/felix");
  assert.equal(options.cwd, "/tmp/felix");
  assert.equal(cursorArgs("/w", "q").includes("--model"), false);
});

test("Cursor's failures come back as errors: a failed result, stderr, no start, or too long", async () => {
  assert.equal((await cursorBrain({ lines: [{ type: "result", result: "Model not found", is_error: true }], code: 1 }).brain.askCursor("q")).error, "Cursor failed: Model not found");
  assert.equal((await cursorBrain({ stderr: "Not logged in", code: 1 }).brain.askCursor("q")).error, "Cursor failed: Not logged in");
  assert.equal((await cursorBrain({ code: 2 }).brain.askCursor("q")).error, "Cursor failed: it exited with code 2");
  assert.equal((await cursorBrain({ fail: new Error("ENOENT") }).brain.askCursor("q")).error, "Cursor failed: ENOENT");
  const slow = cursorBrain({ hang: true }, { cursorMs: 20 });
  assert.equal((await slow.brain.askCursor("q")).error, "Cursor took too long");
  assert.equal(slow.runs[0].killed, true);
  assert.deepEqual(cursorAnswer({ type: "result", result: "ok", is_error: false }, 0, ""), { text: "ok", error: null, limit: false });
});

test("Claude's reply streams as it's written, with thinking turned off", async () => {
  const delta = (text) => ({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text } } });
  const thinking = { type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } };
  const { brain, procs } = brainWith(() => [thinking, delta("Sure, "), delta("done."), result("Sure, done.")]);
  const deltas = [];
  assert.equal((await brain.ask("haiku", "hi", { onDelta: (d) => deltas.push(d) })).text, "Sure, done.");
  assert.deepEqual(deltas, ["Sure, ", "done."]);
  assert.ok(procs[0].args.includes("--include-partial-messages"));
  assert.equal(procs[0].options.env.MAX_THINKING_TOKENS, "0");
  brain.close();
});

test("Felix notes when Claude says its plan is used up, until the limit resets", async () => {
  let clock = 1_000_000;
  const events = [
    [{ type: "rate_limit_event", rate_limit_info: { status: "allowed", isUsingOverage: false } }, result("a")],
    [{ type: "rate_limit_event", rate_limit_info: { status: "rejected", isUsingOverage: true, resetsAt: 2000 } }, result("b")],
    [{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, result("c")],
    [{ type: "rate_limit_event" }, result("d")],
  ];
  const { brain } = brainWith((_q, n) => events[n], { now: () => clock });
  await brain.ask("sonnet", "1");
  assert.equal(brain.pastLimit(), false);
  await brain.ask("sonnet", "2");
  assert.equal(brain.pastLimit(), true);
  clock = 2_000_001;
  assert.equal(brain.pastLimit(), false);
  await brain.ask("sonnet", "3");
  assert.equal(brain.pastLimit(), true);
  clock += 61 * 60_000;
  assert.equal(brain.pastLimit(), false);
  await brain.ask("sonnet", "4");
  assert.equal(brain.pastLimit(), false);
  brain.close();
});

test("a message sent while Claude works joins the answer in progress, as a follow-up once Claude's part ends", async () => {
  const cursorSession = { ask: async () => null, warm: async () => {}, close: async () => {} };
  const { brain, procs } = brainWith((_q, n) => (n === 0 ? null : [result("Dark mode too.")]), { cursorSession });
  assert.equal(await brain.steer("anything"), false);
  const answer = brain.ask("opus", "Build the Jira card");
  await new Promise((r) => setImmediate(r));
  assert.equal(await brain.steer("make it work in dark mode"), true);
  procs[0].stdout.write(`${JSON.stringify(result("Built the card."))}\n`);
  assert.equal((await answer).text, "Built the card.\n\nDark mode too.");
  assert.match(procs[0].written[1], /While you were working, I added: "make it work in dark mode"/);
  brain.close();
});

test("with no Claude question in progress, a message goes to Cursor's", async () => {
  const steered = [];
  const cursorSession = { ask: async () => null, warm: async () => {}, close: async () => {}, steer: async (t) => steered.push(t) > 0 };
  const { brain } = brainWith(() => null, { cursorSession });
  assert.equal(await brain.steer("and the PR tab"), true);
  assert.deepEqual(steered, ["and the PR tab"]);
});

test("a long turn that keeps working isn't cut off; only one that goes quiet is", async () => {
  // Claude sends a tool step every 40 ms for 1.2 s, much longer than the 500 ms quiet limit, then answers.
  const fake = fakeClaude(() => null);
  const { brain } = { brain: createBrain({ bin: "claude", cursorBin: "agent", cwd: "/tmp/felix", systemPrompt: "x", spawnImpl: fake.spawnImpl, turnMs: 500 }) };
  const asked = brain.ask("opus", "build it");
  const step = JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "./prs test" } }] } });
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 40));
    fake.procs[0].stdout.write(`${step}\n`);
  }
  fake.procs[0].stdout.write(`${JSON.stringify(result("Built it."))}\n`);
  assert.deepEqual(await asked, { text: "Built it.", error: null, limit: false });
  brain.close();
});

test("Stop ends Claude's busy session, a one-off Cursor run and Cursor's session, and says whether anything was working", async () => {
  const idle = brainWith(() => [result("hi")]);
  assert.equal(await idle.brain.stop(), false);
  await idle.brain.ask("haiku", "hello");
  assert.equal(await idle.brain.stop(), false, "a session waiting for the next question isn't stopped");
  assert.equal(idle.procs[0].killed, false);
  idle.brain.close();

  const busy = brainWith(() => null);
  const asked = busy.brain.ask("opus", "build a widget");
  await new Promise((r) => setImmediate(r));
  assert.equal(await busy.brain.stop(), true);
  assert.equal((await asked).error, "Stopped");
  assert.equal(busy.procs[0].killed, true);

  const once = cursorBrain({ hang: true });
  const run = once.brain.askCursor("q");
  await new Promise((r) => setImmediate(r));
  assert.equal(await once.brain.stop(), true);
  assert.equal((await run).error, "Stopped");
  assert.equal(once.runs[0].killed, true);

  let stopped = 0;
  const session = { ...fakeSession(null), stop: async () => ++stopped > 0 };
  const viaSession = cursorBrain({}, { cursorSession: session });
  assert.equal(await viaSession.brain.stop(), true);
  assert.equal(stopped, 1);
});

test("a one-off question runs a fresh Claude with no tools and reads its JSON result, or a read-only Cursor run", async () => {
  const runs = [];
  const answers = [JSON.stringify({ type: "result", result: '{"notes":[]}', is_error: false }), JSON.stringify({ type: "result", result: "Claude AI usage limit reached", is_error: true }), "not json", null];
  const spawnImpl = (bin, args, options) => {
    const proc = Object.assign(new EventEmitter(), { args, options, stdout: new PassThrough(), kill: () => { proc.killed = true; } });
    runs.push(proc);
    const out = answers.shift();
    setImmediate(() => {
      if (out === null) return proc.emit("error", new Error("ENOENT"));
      proc.stdout.end(out);
      setImmediate(() => proc.emit("close", 0));
    });
    return proc;
  };
  const brain = createBrain({ bin: "claude", cursorBin: "agent", cwd: "/tmp/felix", systemPrompt: "x", spawnImpl, cursorSession: fakeSession(null) });
  assert.deepEqual(await brain.once("learn this", { tool: "claude", model: "haiku" }), { text: '{"notes":[]}', error: null, limit: false });
  assert.deepEqual(runs[0].args, ["-p", "--model", "haiku", "--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--output-format", "json", "learn this"]);
  assert.equal(runs[0].options.cwd, "/tmp/felix");
  assert.deepEqual(await brain.once("q", { tool: "claude", model: "haiku" }), { text: "", error: "Claude AI usage limit reached", limit: true });
  assert.deepEqual(await brain.once("q", { tool: "claude", model: "haiku" }), { text: "", error: "Claude failed", limit: false });
  assert.equal((await brain.once("q", { tool: "claude", model: "haiku" })).error, "Claude couldn't start: ENOENT");
  const cursor = cursorBrain({ lines: [{ type: "result", result: "{}", is_error: false }] });
  assert.equal((await cursor.brain.once("q", { tool: "cursor", model: "composer-2.5-fast" })).text, "{}");
  assert.ok(cursor.runs[0].args.includes("composer-2.5-fast"));
});

test("a one-off question that hangs is stopped", async () => {
  const { spawnImpl, runs } = fakeCursor({ hang: true });
  const brain = createBrain({ bin: "claude", cursorBin: "agent", cwd: "/tmp/felix", systemPrompt: "x", spawnImpl, cursorSession: fakeSession(null), onceMs: 10 });
  assert.equal((await brain.once("q", { tool: "claude", model: "haiku" })).error, "Claude took too long");
  assert.equal(runs[0].killed, true);
});
