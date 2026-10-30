import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { applyFiles, guard, healthCheck, main, prsRestart, statusWriter } from "../felix-guard.mjs";

/**
 * The guard over pretend parts: `health` answers each check in turn (the last answer repeats).
 * @param {{ why?: "apply" | "undo", health: boolean[], rollbackFails?: boolean }} options
 */
async function run({ why = "apply", health, rollbackFails = false }) {
  const calls = [];
  let check = 0;
  const states = [];
  const state = await guard({
    why,
    restart: async () => { calls.push("restart"); },
    healthy: async () => {
      const ok = health[Math.min(check++, health.length - 1)];
      if (ok === null) throw new Error("connection refused");
      return ok;
    },
    rollback: async () => {
      calls.push("rollback");
      if (rollbackFails) throw new Error("patch does not apply");
    },
    setState: async (s) => { states.push(s); },
    waitMs: 3,
    everyMs: 1,
    sleep: async () => {},
  });
  return { state, calls, states };
}

test("an apply that comes back healthy is left in, and noted as ok", async () => {
  const r = await run({ health: [null, false, true] });
  assert.equal(r.state, "ok");
  assert.deepEqual(r.calls, ["restart"]);
  assert.equal(r.states[0].state, "ok");
  assert.ok(r.states[0].checkedAt);
  assert.equal("why" in r.states[0], false);
});

test("an apply that doesn't come back is put back, and Felix restarted again", async () => {
  const r = await run({ health: [false, false, false, false, true] });
  assert.equal(r.state, "rolled-back");
  assert.deepEqual(r.calls, ["restart", "rollback", "restart"]);
  assert.match(r.states[0].why, /put back/);
});

test("when even the put-back Felix doesn't come back, or it can't be put back, it says it's broken", async () => {
  const never = await run({ health: [false] });
  assert.equal(never.state, "broken");
  assert.match(never.states[0].why, /even with the change put back/);
  const stuck = await run({ health: [false], rollbackFails: true });
  assert.equal(stuck.state, "broken");
  assert.deepEqual(stuck.calls, ["restart", "rollback"]);
  assert.match(stuck.states[0].why, /couldn't be put back: patch does not apply/);
});

test("after an undo there's nothing to put back: it's undone, or broken", async () => {
  assert.equal((await run({ why: "undo", health: [true] })).state, "undone");
  const broken = await run({ why: "undo", health: [false] });
  assert.equal(broken.state, "broken");
  assert.deepEqual(broken.calls, ["restart"]);
});

test("a restart that fails to run is still checked, with the real sleep when none is given", async () => {
  const state = await guard({
    why: "apply", restart: async () => { throw new Error("no prs"); }, healthy: async () => true, rollback: async () => {}, setState: async () => {},
  });
  assert.equal(state, "ok");
  const waited = await guard({
    why: "undo", restart: async () => {}, healthy: async () => false, rollback: async () => {}, setState: async () => {}, waitMs: 2, everyMs: 1,
  });
  assert.equal(waited, "broken");
});

test("Felix is healthy when a new process answers the health check and its home page loads", async () => {
  const fetchWith = (health, home = 200) => async (url) => (url.endsWith("/api/health")
    ? { ok: health !== null, json: async () => health }
    : { ok: home === 200 });
  assert.equal(await healthCheck({ port: 4777, oldPid: 1, fetchImpl: fetchWith({ ok: true, pid: 2 }) })(), true);
  assert.equal(await healthCheck({ port: 4777, oldPid: 1, fetchImpl: fetchWith({ ok: true, pid: 1 }) })(), false, "the old Felix still answering isn't the new one");
  assert.equal(await healthCheck({ port: 4777, oldPid: 1, fetchImpl: fetchWith(null) })(), false);
  assert.equal(await healthCheck({ port: 4777, oldPid: 1, fetchImpl: fetchWith({ ok: false, pid: 2 }) })(), false);
  assert.equal(await healthCheck({ port: 4777, oldPid: 1, fetchImpl: fetchWith({ ok: true, pid: 2 }, 500) })(), false);
  const urls = [];
  await healthCheck({ port: 4999, oldPid: 1, fetchImpl: async (url) => { urls.push(url); return { ok: false }; } })();
  assert.deepEqual(urls, ["http://127.0.0.1:4999/api/health"]);
});

test("the restart runs ./prs restart without opening a page, and finishes even when it can't start", async () => {
  const seen = [];
  const spawnImpl = (bin, args, options) => {
    seen.push({ bin, args, cwd: options.cwd, open: options.env.NO_OPEN });
    const proc = new EventEmitter();
    setImmediate(() => proc.emit(seen.length === 1 ? "close" : "error", 0));
    return proc;
  };
  await prsRestart("/felix", spawnImpl)();
  await prsRestart("/felix", spawnImpl)();
  assert.deepEqual(seen[0], { bin: "/felix/prs", args: ["restart"], cwd: "/felix", open: "1" });
});

test("what happened is merged into the saved apply's status", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-guard-"));
  const files = applyFiles(dir);
  assert.equal(files.patch, path.join(dir, "applies", "last.patch"));
  await mkdir(path.dirname(files.status), { recursive: true });
  await statusWriter(files.status)({ state: "ok" });
  assert.deepEqual(JSON.parse(await readFile(files.status, "utf8")), { state: "ok" });
  await writeFile(files.status, JSON.stringify({ state: "restarting", files: ["a.js"] }));
  await statusWriter(files.status)({ state: "ok", checkedAt: "now" });
  assert.deepEqual(JSON.parse(await readFile(files.status, "utf8")), { state: "ok", files: ["a.js"], checkedAt: "now" });
  await rm(dir, { recursive: true, force: true });
});

test("from the command line it restarts, checks, and puts the saved patch back when Felix doesn't come back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-guard-"));
  const files = applyFiles(dir);
  await mkdir(path.dirname(files.patch), { recursive: true });
  await writeFile(files.patch, "PATCH");
  await writeFile(files.status, JSON.stringify({ state: "restarting" }));
  const spawnImpl = () => {
    const proc = new EventEmitter();
    setImmediate(() => proc.emit("close", 0));
    return proc;
  };
  const gitCalls = [];
  const git = async (cwd, args, input) => { gitCalls.push({ cwd, args, input }); return ""; };
  let checks = 0;
  const fetchImpl = async (url) => (url.endsWith("/api/health") ? { ok: true, json: async () => ({ ok: true, pid: ++checks > 3 ? 9 : 5 }) } : { ok: true });
  const argv = ["--repo", "/felix", "--dir", dir, "--port", "4777", "--pid", "5", "--why", "apply"];
  assert.equal(await main(argv, { spawnImpl, fetchImpl, git, waitMs: 1, everyMs: 1 }), "rolled-back");
  assert.deepEqual(gitCalls, [{ cwd: "/felix", args: ["apply", "-R", "-"], input: "PATCH" }]);
  assert.equal(JSON.parse(await readFile(files.status, "utf8")).state, "rolled-back");
  assert.equal(await main([...argv.slice(0, -1), "undo"], { spawnImpl, fetchImpl, git, waitMs: 1, everyMs: 1 }), "undone");
  await rm(dir, { recursive: true, force: true });
});
