import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { BUILDER, answerOf, buildBrief, createBuilder, cursorCliStep, pickBuilder, pickHelper, runAi } from "../felix-builder.mjs";

/**
 * A fake AI CLI: each run does `script(args, options, proc)`, which may write files, then prints stream-json lines
 * and exits.
 * @param {(args: string[], options: object, n: number) => { lines?: object[], code?: number, stderr?: string, hang?: boolean }} script
 */
function fakeAi(script) {
  const runs = [];
  const approvals = [];
  const spawnImpl = (bin, args, options) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), killed: false, kill: () => { proc.killed = true; proc.emit("close", null); } });
    if (args[0] === "mcp") {
      approvals.push({ bin, args, cwd: options.cwd });
      return realProc(proc, 0);
    }
    runs.push({ bin, args, options });
    // The tool's own test runs for real.
    if (bin === process.execPath) return script.test ? script.test(args, options, proc) : realProc(proc, 0);
    const out = script(args, options, runs.length);
    setImmediate(() => {
      for (const line of out.lines || []) proc.stdout.write(`${JSON.stringify(line)}\n`);
      if (out.stderr) proc.stderr.write(out.stderr);
      if (out.hang) return;
      proc.stdout.end();
      setImmediate(() => proc.emit("close", out.code ?? 0));
    });
    return proc;
  };
  return { spawnImpl, runs, approvals };
}

/** A test run that passes or fails. */
function realProc(proc, code, text = "") {
  setImmediate(() => {
    if (text) proc.stdout.write(text);
    proc.emit("close", code);
  });
  return proc;
}

const result = (text, isError = false) => ({ type: "result", result: text, is_error: isError });

test("the builder is Opus 5.5 High on Claude while its plan has room, else on Cursor, whatever the chat uses", () => {
  assert.equal(pickBuilder({ claudeUsedUp: false }), BUILDER.claude);
  assert.equal(pickBuilder({ claudeUsedUp: false, tool: "cursor" }), BUILDER.claude);
  assert.equal(pickBuilder({ claudeUsedUp: true }), BUILDER.cursor);
  assert.deepEqual([BUILDER.claude.model, BUILDER.claude.effort, BUILDER.cursor.model], ["claude-opus-5-5", "high", "claude-opus-5-5-high"]);
  assert.equal(pickHelper({ claudeUsedUp: false }).tool, "claude");
  assert.equal(pickHelper({ claudeUsedUp: false, tool: "cursor" }).tool, "cursor");
  assert.equal(pickHelper({ claudeUsedUp: true }).model, "claude-opus-5-5-medium");
});

test("Cursor's tool calls show in plain words", () => {
  assert.equal(cursorCliStep({ shellToolCall: { args: { command: "node --test out/x.test.mjs" } } }), "Running the tests");
  assert.equal(cursorCliStep({ mcpToolCall: { args: { toolName: "out_of_office" } } }), "Checking who's out");
  assert.equal(cursorCliStep({ readToolCall: {} }), "Looking through your records");
  assert.equal(cursorCliStep({ editToolCall: {} }), "Making a change");
  assert.equal(cursorCliStep({ todoToolCall: {} }), "Working");
  assert.equal(cursorCliStep({}), "Working");
  assert.equal(cursorCliStep(), "Working");
});

test("the brief says what's needed, how a tool looks, what it can reach, and what names are taken", () => {
  const brief = buildBrief({
    need: "Who is on VL in a year", question: "Anyone on VL next year?", extend: null, at: Date.parse("2026-10-30T10:00:00Z"),
    docs: [["ooo.out", "({ from, to }) → leaves"]], mine: [{ name: "who_is_out", description: "Who's out" }], builtins: ["calendar_events"],
  });
  assert.match(brief, /The user asked: "Anyone on VL next year\?"/);
  assert.match(brief, /What the tool must do: Who is on VL in a year/);
  assert.match(brief, /2026-10-30/);
  assert.match(brief, /`ctx\.ooo\.out\(\{ from, to \}\) → leaves`/);
  assert.match(brief, /calendar_events, who_is_out/);
  assert.match(brief, /- who_is_out: Who's out/);
  assert.doesNotMatch(brief, /Extend Felix's existing tool/);
  const ext = buildBrief({ need: "n", question: "q", extend: { name: "who_is_out", source: "" }, at: 0, docs: [], mine: [], builtins: [] });
  assert.match(ext, /Extend Felix's existing tool `who_is_out`/);
  assert.match(ext, /none yet/);
  assert.match(ext, /None yet\./);
});

test("an AI run goes to the right CLI with the right flags, passes its steps on and reads its answer", async () => {
  const steps = [];
  const { spawnImpl, runs } = fakeAi(() => ({ lines: [
    { type: "assistant", message: { content: [{ type: "tool_use", name: "mcp__felix__out_of_office", input: {} }, { type: "text", text: "x" }] } },
    { type: "tool_call", subtype: "started", tool_call: { readToolCall: {} } },
    "not json",
    result("Ana is on VL in March."),
  ] }));
  const base = { prompt: "Build it", cwd: "/w", bin: "claude", cursorBin: "cursor-agent", mcpConfig: "/w/.felix-mcp.json", ms: 5000, spawnImpl, onStep: (s) => steps.push(s) };
  const built = await runAi({ ...base, who: BUILDER.claude, settings: "{}", bypass: true });
  assert.deepEqual(built, { text: "Ana is on VL in March.", error: null, limit: false });
  assert.deepEqual(steps, ["Checking who's out", "Looking through your records"]);
  assert.equal(runs[0].bin, "claude");
  const a = runs[0].args;
  assert.deepEqual(a.slice(a.indexOf("--model"), a.indexOf("--model") + 4), ["--model", "claude-opus-5-5", "--effort", "high"]);
  assert.ok(a.includes("bypassPermissions") && a.includes("--strict-mcp-config") && a.includes("--settings"));
  assert.ok(!a.includes("--permission-prompt-tool"));

  await runAi({ ...base, who: pickHelper({ claudeUsedUp: false }) });
  assert.ok(runs[1].args.includes("--permission-prompt-tool") && runs[1].args.includes("mcp__felix"), "a helper's actions go through Felix's gate");

  await runAi({ ...base, who: BUILDER.cursor });
  assert.equal(runs[2].bin, "cursor-agent");
  assert.deepEqual(runs[2].args.slice(0, 3), ["-p", "--model", "claude-opus-5-5-high"]);
  assert.ok(runs[2].args.includes("--force") && runs[2].args.includes("--approve-mcps"));
});

test("an AI run that fails says why, notices Claude's limit, and is stopped when it takes too long", async () => {
  const runAiWith = (out, who = BUILDER.claude, ms = 5000) => runAi({ who, prompt: "p", cwd: "/w", bin: "c", cursorBin: "k", mcpConfig: "m", ms, spawnImpl: fakeAi(() => out).spawnImpl });
  assert.deepEqual(await runAiWith({ lines: [result("You've hit your usage limit", true)] }), { text: "", error: "You've hit your usage limit", limit: true });
  assert.equal((await runAiWith({ lines: [{ type: "rate_limit_event", rate_limit_info: { status: "rejected" } }, result("x", true)] })).limit, true);
  assert.deepEqual(await runAiWith({ stderr: "not logged in", code: 1 }, BUILDER.cursor), { text: "", error: "not logged in", limit: false });
  assert.match((await runAiWith({ code: 2 })).error, /code 2/);
  assert.match((await runAiWith({ hang: true }, BUILDER.claude, 20)).error, /took too long/);
  const broken = await runAi({ who: BUILDER.claude, prompt: "p", cwd: "/w", bin: "c", cursorBin: "k", mcpConfig: "m", ms: 5000, spawnImpl: () => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough() });
    setImmediate(() => proc.emit("error", new Error("ENOENT")));
    return proc;
  } });
  assert.match(broken.error, /Couldn't start it: ENOENT/);
});

/** A builder over a fake toolbox, in a fresh folder. */
function setup(script, { usedUp = false, check, deploy } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "felix-builder-"));
  mkdirSync(path.join(root, "tools"));
  writeFileSync(path.join(root, "tools", "who_is_out.mjs"), "// the current version");
  const deployed = [];
  const toolbox = {
    list: () => [{ name: "calendar_events", description: "x" }, { name: "who_is_out", description: "Who's out", own: true }],
    check: check || (async () => ({ tool: {}, problem: null })),
    deploy: deploy || (async (b) => { deployed.push(b); return { ok: true, name: "team_leave_year", version: 1, extended: false }; }),
  };
  const ai = fakeAi(script);
  const builder = createBuilder({
    toolbox, dir: path.join(root, "jobs"), repo: root, bin: "claude", cursorBin: "cursor-agent", docs: [["ooo.out", "(r)"]],
    mcp: { url: "http://127.0.0.1:4777/mcp", token: "t0k", bridge: "/b.mjs" }, state: async () => ({ claudeUsedUp: usedUp }),
    spawnImpl: ai.spawnImpl, now: () => Date.parse("2026-10-30T10:00:00Z"), testMs: 1000,
  });
  const steps = [];
  const by = [];
  const ctl = { step: (s) => steps.push(s), by: (w) => by.push(w) };
  return { root, builder, ai, deployed, steps, by, ctl, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** Writes the tool, its test and the result the way the builder AI would. */
const writeTool = (cwd, result = { ok: true, name: "team_leave_year", summary: "Who's on leave in a year" }) => {
  writeFileSync(path.join(cwd, "out", "team_leave_year.mjs"), "export default {}");
  writeFileSync(path.join(cwd, "out", "team_leave_year.test.mjs"), "");
  if (result) writeFileSync(path.join(cwd, "out", "result.json"), JSON.stringify(result));
};

const job = (input) => ({ id: "build-1", kind: "build", title: "t", input, by: null });

test("a build: the AI writes the tool in its folder, Felix checks and saves it, then a helper answers with it", async () => {
  const { builder, ai, deployed, steps, by, ctl, root, done } = setup((args, options, n) => {
    if (n === 1) writeTool(options.cwd);
    return { lines: [result(n === 1 ? "Built team_leave_year." : "Yes: Ana is on VL in March next year.")] };
  });
  try {
    const out = await builder.build(job({ need: "Who is on VL in a year", question: "Anyone on VL next year?", extend: null }), ctl);
    assert.equal(out.answer, "Yes: Ana is on VL in March next year.");
    assert.deepEqual(out.result, { tool: "team_leave_year", version: 1, extended: false });
    const cwd = path.join(root, "jobs", "build-1");
    assert.match(readFileSync(path.join(cwd, "BRIEF.md"), "utf8"), /Anyone on VL next year/);
    assert.match(readFileSync(path.join(cwd, ".felix-mcp.json"), "utf8"), /Bearer t0k/);
    assert.match(readFileSync(path.join(cwd, ".cursor", "mcp.json"), "utf8"), /FELIX_MCP_TOKEN/);
    assert.equal(deployed[0].file, path.join(cwd, "out", "team_leave_year.mjs"));
    assert.equal(deployed[0].job, "build-1");
    assert.deepEqual(by, ["Claude Opus 5.5 High", "Claude Opus"]);
    assert.ok(steps.includes("Building a new tool") && steps.includes("Checking the new tool") && steps.includes("Saving the new tool") && steps.includes("Using the new tool"));
    const settings = JSON.parse(ai.runs[0].args[ai.runs[0].args.indexOf("--settings") + 1]);
    assert.ok(settings.permissions.deny.includes(`Edit(/${path.join(root, "tools/**")})`), "the builder can't edit Felix's own code");
    assert.match(ai.runs.at(-1).args.at(-1), /You now have a tool for it: team_leave_year \(Who's on leave in a year\)/);
    assert.ok(builder.inside(path.join(cwd, "out", "team_leave_year.mjs")));
    assert.equal(builder.inside(path.join(root, "tools", "who_is_out.mjs")), false);
    assert.equal(builder.inside(path.join(cwd, "out", "notes.txt")), false);
  } finally {
    done();
  }
});

test("a build gets one more round to fix what Felix found, and copies the tool it extends", async () => {
  let tests = 0;
  const script = (args, options, n) => {
    if (n === 1) writeTool(options.cwd, null);
    return { lines: [result("ok")] };
  };
  script.test = (args, options, proc) => realProc(proc, tests++ === 0 ? 1 : 0, "not ok 1 - counts leave\n");
  const { builder, ai, root, ctl, done } = setup(script);
  try {
    const out = await builder.build(job({ need: "n", question: "q", extend: "who_is_out" }), ctl);
    assert.equal(out.answer, "ok");
    const cwd = path.join(root, "jobs", "build-1");
    assert.equal(readFileSync(path.join(cwd, "current", "who_is_out.mjs"), "utf8"), "// the current version");
    assert.equal(ai.runs.length, 5, "build, its test, build again, the test again, then the helper");
    assert.match(ai.runs[1].args.join(" "), /--test/);
    assert.match(ai.runs[2].args.at(-1), /its test fails:\nnot ok 1 - counts leave/);
  } finally {
    done();
  }

  const empty = setup((args, options, n) => {
    if (n === 2) writeTool(options.cwd);
    return { lines: [result("ok")] };
  });
  try {
    await empty.builder.build(job({ need: "n", question: "q" }), empty.ctl);
    assert.match(empty.ai.runs[1].args.at(-1), /There's no tool in out\/ yet/);
  } finally {
    empty.done();
  }
});

test("a build that can't be done, keeps failing or fails its run says so plainly", async () => {
  const cant = setup((args, options) => {
    writeFileSync(path.join(options.cwd, "out", "result.json"), JSON.stringify({ ok: false, why: "the tracker has no leave types" }));
    return { lines: [result("no")] };
  });
  try {
    await assert.rejects(cant.builder.build(job({ need: "n", question: "q" }), cant.ctl), (e) => /can't build a way to check that yet: the tracker has no leave types/.test(e.said));
  } finally {
    cant.done();
  }

  const bad = setup((args, options) => { writeTool(options.cwd); return { lines: [result("ok")] }; }, { check: async () => ({ tool: null, problem: "It starts programs." }) });
  try {
    await assert.rejects(bad.builder.build(job({ need: "n", question: "q" }), bad.ctl), (e) => /tried twice/.test(e.said));
    assert.match(bad.ai.runs[1].args.at(-1), /isn't ready: It starts programs\./);
  } finally {
    bad.done();
  }

  const refused = setup((args, options) => { writeTool(options.cwd); return { lines: [result("ok")] }; }, { deploy: async () => ({ ok: false, problem: "It no longer takes to." }) });
  try {
    await assert.rejects(refused.builder.build(job({ need: "n", question: "q" }), refused.ctl), /two tries/);
    assert.match(refused.ai.runs[2].args.at(-1), /couldn't save .*It no longer takes to/);
  } finally {
    refused.done();
  }

  const broke = setup(() => ({ stderr: "boom", code: 1 }));
  try {
    await assert.rejects(broke.builder.build(job({ need: "n", question: "q" }), broke.ctl), (e) => e.retry === true && /couldn't finish building/.test(e.said));
  } finally {
    broke.done();
  }
});

test("Claude out of usage mid-build moves the build to Cursor; a task is answered by a helper", async () => {
  const { builder, ai, by, ctl, done } = setup((args, options, n) => {
    if (n === 1) return { lines: [result("You've hit your usage limit", true)] };
    if (n === 2) writeTool(options.cwd);
    return { lines: [result(n === 2 ? "built" : "Here's the answer.")] };
  });
  try {
    await builder.build(job({ need: "n", question: "q" }), ctl);
    assert.deepEqual(by.slice(0, 2), ["Claude Opus 5.5 High", "Claude Opus 5.5 High (Cursor)"]);
    assert.equal(ai.runs[1].bin, "cursor-agent");
    assert.deepEqual(ai.approvals[0], { bin: "cursor-agent", args: ["mcp", "enable", "felix"], cwd: ai.runs[1].options.cwd }, "Cursor gets Felix's tools approved in the job's folder first");
    const answered = await builder.task({ id: "task-1", input: { task: "Who's on call?" } }, ctl);
    assert.equal(answered.answer, "Here's the answer.");
    assert.ok(existsSync(path.join(path.dirname(path.dirname(ai.runs.at(-1).options.cwd)), "task-1")));
  } finally {
    done();
  }
});

test("a helper that hits Claude's limit carries on with Cursor; one that fails says so", async () => {
  const limited = setup((args, options, n) => ({ lines: [n === 1 ? result("usage limit reached", true) : result("Done on Cursor.")] }));
  try {
    assert.equal((await limited.builder.task({ id: "task-2", input: { task: "x" } }, limited.ctl)).answer, "Done on Cursor.");
    assert.deepEqual(limited.by, ["Claude Opus", "Claude Opus 5.5 (Cursor)"]);
  } finally {
    limited.done();
  }
  const failing = setup(() => ({ stderr: "crashed", code: 1 }), { usedUp: true });
  try {
    await assert.rejects(failing.builder.task({ id: "task-3", input: { task: "x" } }, failing.ctl), /crashed/);
  } finally {
    failing.done();
  }
});

test("a helper's answer is only what follows its answer mark", () => {
  assert.equal(answerOf("The tools aren't loaded, so I'll call the server directly.\nANSWER:\nNo one is on VL next year yet."), "No one is on VL next year yet.");
  assert.equal(answerOf("Draft ANSWER: a\nANSWER: the real one"), "the real one");
  assert.equal(answerOf("  Just the answer.  "), "Just the answer.");
});

test("an approval that hangs or can't start never holds up the run", async () => {
  const hanging = (bin, args, options) => {
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => proc.emit("close", null) });
    if (args[0] === "mcp") {
      setImmediate(() => proc.emit("error", new Error("ENOENT")));
      return proc;
    }
    setImmediate(() => {
      proc.stdout.write(`${JSON.stringify(result("ANSWER: Ana is out Monday."))}\n`);
      proc.stdout.end();
      setImmediate(() => proc.emit("close", 0));
    });
    return proc;
  };
  const root = mkdtempSync(path.join(tmpdir(), "felix-builder-"));
  try {
    const builder = createBuilder({ toolbox: { list: () => [] }, dir: root, repo: root, bin: "claude", cursorBin: "cursor-agent", docs: [],
      mcp: { url: "u", token: "t", bridge: "b" }, state: async () => ({ claudeUsedUp: true }), spawnImpl: hanging });
    const out = await builder.task({ id: "task-9", input: { task: "Who's out Monday?" } }, { step: () => {}, by: () => {} });
    assert.equal(out.answer, "Ana is out Monday.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
