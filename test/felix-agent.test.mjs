import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CLAUDE_SETTINGS, createAgent, runTests } from "../felix-agent.mjs";

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A pretend `./prs test` that prints and exits with the code given, or never finishes.
 * @param {number | null} code
 * @returns {{ spawnImpl: Function, runs: Array<{ bin: string, cwd: string }> }}
 */
function fakeTests(code) {
  const runs = [];
  const spawnImpl = (bin, _args, options) => {
    runs.push({ bin, cwd: options.cwd });
    const proc = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), kill: () => proc.emit("close", null) });
    setImmediate(() => {
      proc.stdout.write("# pass 3\n");
      proc.stderr.write("# fail 1\n");
      if (code !== null) proc.emit("close", code);
    });
    return proc;
  };
  return { spawnImpl, runs };
}

/**
 * A pretend workbench with some changes.
 * @param {{ changes?: object[], applyFails?: boolean }} [options]
 */
function fakeBench({ changes = [{ path: "a.js", status: "changed" }], applyFails = false } = {}) {
  const calls = [];
  return {
    calls,
    bench: {
      dir: "/tmp/felix-bench",
      memory: "/tmp/felix-bench/memory-missing",
      changes: async () => changes,
      diff: async () => "--- a/a.js\n+++ b/a.js\n",
      apply: async () => {
        calls.push("apply");
        if (applyFails) throw new Error("patch does not apply");
        return changes;
      },
      discard: async () => { calls.push("discard"); },
    },
  };
}

/**
 * An agent over a temp folder.
 * @param {object} options
 */
async function agentWith(options) {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-agent-"));
  const restarts = [];
  const agent = createAgent({ repo: "/tmp/repo", dir, port: 4777, token: "t0k", restart: (why) => restarts.push(why), ...options });
  return { agent, dir, restarts, done: () => rm(dir, { recursive: true, force: true }) };
}

test("Claude's MCP config points at Felix's endpoint, with a token only Felix and Claude have", async () => {
  const { agent, dir, done } = await agentWith({ workbench: fakeBench().bench });
  const config = JSON.parse(await readFile(agent.tools.mcpConfig, "utf8"));
  assert.deepEqual(config.mcpServers.felix, { type: "http", url: "http://127.0.0.1:4777/mcp", headers: { Authorization: "Bearer t0k" } });
  assert.equal((await stat(agent.tools.mcpConfig)).mode & 0o777, 0o600);
  assert.equal(agent.tools.mcpConfig, path.join(dir, "mcp.json"));
  assert.equal(agent.authorized({ authorization: "Bearer t0k" }), true);
  assert.equal(agent.authorized({ authorization: "Bearer nope" }), false);
  assert.equal(agent.authorized({}), false);
  assert.equal(agent.authorized({ authorization: "Bearer t0k", "x-forwarded-for": "100.1.2.3" }), false);
  assert.match(agent.rules(), /Your memory is empty so far\./);
  await done();
});

test("Claude's and Cursor's tool uses both go through the gate", async () => {
  const { agent, done } = await agentWith({ workbench: fakeBench().bench });
  const ls = await agent.mcp({ id: 1, method: "tools/call", params: { name: "allow", arguments: { tool_name: "Bash", input: { command: "ls" } } } });
  assert.equal(JSON.parse(ls.result.content[0].text).behavior, "allow");
  assert.equal(await agent.allow({ kind: "read", title: "Read a.js" }), true);
  assert.equal(await agent.allow({ kind: "execute", title: "`rm -rf x`" }), false);
  await done();
});

test("applying runs the tests first, copies the changes over, then restarts Felix", async () => {
  const tests = fakeTests(0);
  const { bench, calls } = fakeBench({ changes: [{ path: "a.js", status: "changed" }, { path: "b.js", status: "added" }] });
  const { agent, restarts, done } = await agentWith({ workbench: bench, spawnImpl: tests.spawnImpl });
  assert.deepEqual(await agent.apply(), {
    ok: true, text: "Applied 2 files. Restarting Felix now; if he doesn't come back healthy, I'll put it back on my own.", files: ["a.js", "b.js"],
  });
  assert.deepEqual(tests.runs, [{ bin: "/tmp/felix-bench/prs", cwd: "/tmp/felix-bench" }]);
  assert.deepEqual(calls, ["apply"]);
  await wait(900);
  assert.deepEqual(restarts, ["apply"]);
  assert.deepEqual(await agent.discard(), { ok: true, text: "Dropped those changes. My workbench is back to your Felix." });
  await done();
});

test("nothing is applied with nothing to apply, failing tests, or a patch that doesn't fit", async () => {
  const empty = await agentWith({ workbench: fakeBench({ changes: [] }).bench });
  assert.equal((await empty.agent.apply()).text, "There's nothing new in my workbench to apply.");
  await empty.done();
  const failing = fakeBench();
  const red = await agentWith({ workbench: failing.bench, spawnImpl: fakeTests(1).spawnImpl });
  assert.equal((await red.agent.apply()).text, "I didn't apply it: the tests fail in my workbench.\n# pass 3\n# fail 1");
  assert.deepEqual(failing.calls, []);
  await red.done();
  const one = await agentWith({ workbench: fakeBench({ applyFails: true, changes: [{ path: "a.js", status: "changed" }] }).bench, spawnImpl: fakeTests(0).spawnImpl });
  assert.deepEqual(await one.agent.apply(), { ok: false, text: "I couldn't apply it, so nothing changed: patch does not apply" });
  assert.equal(one.restarts.length, 0);
  await one.done();
});

test("tests that hang are stopped, and tests that can't start fail", async () => {
  assert.equal((await runTests("/tmp", fakeTests(null).spawnImpl, 10)).ok, false);
  const broken = () => {
    const proc = new EventEmitter();
    setImmediate(() => proc.emit("error", new Error("ENOENT")));
    return proc;
  };
  assert.deepEqual(await runTests("/tmp", broken, 10), { ok: false, tail: "" });
});

test("Claude's sandbox keeps secret files out of reach and lets the gate decide gh", () => {
  const settings = JSON.parse(CLAUDE_SETTINGS);
  assert.equal(settings.sandbox.enabled, true);
  assert.deepEqual(settings.sandbox.excludedCommands, ["gh"]);
  assert.ok(settings.permissions.deny.includes("Read(~/.ssh/**)"));
  assert.ok(settings.permissions.deny.includes("Read(~/Library/Keychains/**)"));
});

test("an agent can make its own workbench", async () => {
  const { agent, dir, done } = await agentWith({});
  assert.equal(agent.workbench.dir, path.join(dir, "workbench"));
  await done();
});

/**
 * A pretend git for the real Felix folder: records each call, and fails the ones `fails` names.
 * @param {(args: string[]) => boolean} [fails]
 */
function fakeGit(fails = () => false) {
  const calls = [];
  const git = async (cwd, args, input) => {
    calls.push({ cwd, args, input });
    if (fails(args)) throw new Error("does not apply");
    return "";
  };
  return { git, calls };
}

test("an apply keeps the change as a patch and notes it's restarting, for the guard and for undo", async () => {
  const { agent, dir, done } = await agentWith({ workbench: fakeBench().bench, spawnImpl: fakeTests(0).spawnImpl, now: () => Date.parse("2026-10-30T02:00:00Z") });
  assert.equal(await agent.lastApply(), null);
  await agent.apply();
  assert.equal(await readFile(path.join(dir, "applies", "last.patch"), "utf8"), "--- a/a.js\n+++ b/a.js\n");
  assert.deepEqual(await agent.lastApply(), { state: "restarting", at: "2026-10-30T02:00:00.000Z", files: ["a.js"] });
  await done();
});

test("Felix's tests can be run in the workbench on their own, as before an apply", async () => {
  const tests = fakeTests(1);
  const { agent, done } = await agentWith({ workbench: fakeBench().bench, spawnImpl: tests.spawnImpl });
  assert.deepEqual(await agent.test(), { ok: false, tail: "# pass 3\n# fail 1" });
  assert.equal(tests.runs[0].cwd, "/tmp/felix-bench");
  await done();
});

test("undo puts the last apply back when it still fits, then restarts Felix through the guard", async () => {
  const { git, calls } = fakeGit();
  const { agent, dir, restarts, done } = await agentWith({ workbench: fakeBench().bench, git, now: () => Date.parse("2026-10-30T03:00:00Z") });
  assert.deepEqual(await agent.undoApply(), { ok: false, text: "There's no change of mine to undo." });
  await mkdir(path.join(dir, "applies"), { recursive: true });
  await writeFile(path.join(dir, "applies", "last.patch"), "PATCH");
  await writeFile(path.join(dir, "applies", "last.json"), JSON.stringify({ state: "ok", at: "2026-10-30T02:00:00Z", files: ["a.js", "b.js"] }));
  assert.deepEqual(await agent.undoApply(), { ok: true, text: "Put back 2 files the way they were before my last change. Restarting Felix now.", files: ["a.js", "b.js"] });
  assert.deepEqual(calls.map((c) => [c.cwd, c.args.join(" "), c.input]), [["/tmp/repo", "apply -R --check -", "PATCH"], ["/tmp/repo", "apply -R -", "PATCH"]]);
  assert.equal((await agent.lastApply()).state, "undoing");
  assert.equal((await agent.lastApply()).undoneAt, "2026-10-30T03:00:00.000Z");
  await wait(900);
  assert.deepEqual(restarts, ["undo"]);
  assert.deepEqual(await agent.undoApply(), { ok: false, text: "There's no change of mine to undo." }, "an undo isn't undone twice");
  await done();
});

test("undo refuses when the files changed since, or the last apply was already put back", async () => {
  const { git, calls } = fakeGit((args) => args.includes("--check"));
  const { agent, dir, restarts, done } = await agentWith({ workbench: fakeBench().bench, git });
  await mkdir(path.join(dir, "applies"), { recursive: true });
  await writeFile(path.join(dir, "applies", "last.patch"), "PATCH");
  await writeFile(path.join(dir, "applies", "last.json"), JSON.stringify({ state: "ok" }));
  assert.deepEqual(await agent.undoApply(), { ok: false, text: "I can't undo it cleanly: the files it changed have been changed again since." });
  assert.equal(calls.length, 1);
  await writeFile(path.join(dir, "applies", "last.json"), JSON.stringify({ state: "rolled-back" }));
  assert.equal((await agent.undoApply()).ok, false);
  await writeFile(path.join(dir, "applies", "last.json"), JSON.stringify({ state: "ok", files: ["a.js"] }));
  await writeFile(path.join(dir, "applies", "last.patch"), "");
  assert.equal((await agent.undoApply()).text, "There's no change of mine to undo.");
  assert.equal(restarts.length, 0);
  await done();
});

test("one file is said as one file", async () => {
  const { git } = fakeGit();
  const { agent, dir, done } = await agentWith({ workbench: fakeBench().bench, git });
  await mkdir(path.join(dir, "applies"), { recursive: true });
  await writeFile(path.join(dir, "applies", "last.patch"), "PATCH");
  await writeFile(path.join(dir, "applies", "last.json"), JSON.stringify({ state: "broken", files: ["a.js"] }));
  assert.match((await agent.undoApply()).text, /^Put back 1 file the way it was /);
  await writeFile(path.join(dir, "applies", "last.json"), JSON.stringify({ state: "restarting" }));
  assert.match((await agent.undoApply()).text, /^Put back 0 files /);
  await done();
});
