import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJobs, jobTools } from "../felix-jobs.mjs";

const tick = () => new Promise((r) => setTimeout(r, 5));

/** A job queue in a fresh folder. */
function setup({ runners, limit, before } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "felix-jobs-"));
  const file = path.join(root, "jobs.json");
  if (before) writeFileSync(file, JSON.stringify(before));
  const finished = [];
  const jobs = createJobs({ file, runners, limit, onDone: (j) => finished.push(j), now: () => Date.parse("2026-10-30T10:00:00Z") });
  return { jobs, file, finished, done: () => rmSync(root, { recursive: true, force: true }) };
}

/** A runner that waits until it's let go, then answers. */
function gated() {
  const waiting = [];
  const runner = (job, ctl) => new Promise((resolve, reject) => {
    ctl.step("Checking the leave tracker");
    ctl.by("Claude Opus 5.5 High");
    waiting.push({ job, resolve, reject });
  });
  return { runner, waiting };
}

test("jobs run a few at once, the rest wait their turn, and each gets back on its own", async () => {
  const { runner, waiting } = gated();
  const { jobs, finished, file, done } = setup({ runners: { task: runner }, limit: 2 });
  try {
    const a = await jobs.add({ kind: "task", title: "Who's out in December", input: { task: "a" } });
    await jobs.add({ kind: "task", title: "Sprint risks", input: { task: "b" } });
    await jobs.add({ kind: "task", title: "PRs waiting", input: { task: "c" } });
    await tick();
    assert.equal(waiting.length, 2, "only two at once");
    assert.deepEqual(jobs.list().map((j) => j.status), ["queued", "running", "running"]);
    assert.equal(jobs.get(a.id).step, "Checking the leave tracker");
    assert.equal(jobs.get(a.id).by, "Claude Opus 5.5 High");

    waiting[0].resolve({ answer: "Ana and Ben are out on the 24th.", result: { n: 2 } });
    await tick();
    assert.equal(waiting.length, 3, "the waiting one starts when there's room");
    assert.equal(finished[0].answer, "Ana and Ben are out on the 24th.");
    assert.equal(jobs.get(a.id).status, "done");
    assert.deepEqual(jobs.get(a.id).result, { n: 2 });

    waiting[1].reject(Object.assign(new Error("Slack refused the token"), { said: "I couldn't reach Slack." }));
    waiting[2].resolve({ answer: "" });
    await tick();
    assert.deepEqual(finished.map((j) => j.status), ["done", "failed", "done"]);
    assert.equal(finished[1].answer, "I couldn't reach Slack.");
    assert.equal(finished[1].error, "Slack refused the token");
    assert.equal(finished[2].answer, "Done.");
    assert.deepEqual(jobs.list({ open: true }), []);
    await jobs.settled();
    assert.equal(JSON.parse(readFileSync(file, "utf8")).jobs.length, 3);
    assert.equal(jobs.get("nope"), null);
  } finally {
    done();
  }
});

test("a job that failed on its own gets one more go; an unknown kind stops", async () => {
  let tries = 0;
  const { jobs, finished, done } = setup({ runners: { task: async () => {
    tries += 1;
    if (tries === 1) throw Object.assign(new Error("Claude stopped"), { retry: true });
    return { answer: "Got it the second time." };
  } } });
  try {
    await jobs.add({ kind: "task", title: "x", input: {} });
    await jobs.add({ kind: "build", title: "y", input: {} });
    await tick();
    await tick();
    assert.equal(tries, 2);
    assert.deepEqual(finished.map((j) => [j.kind, j.status]).sort(), [["build", "failed"], ["task", "done"]]);
    assert.match(finished.find((j) => j.kind === "build").error, /can't do build jobs/);
  } finally {
    done();
  }
});

test("after a restart, what was running picks up where it left off", async () => {
  const before = { jobs: [
    { id: "task-1", kind: "task", title: "Leave next year", input: { task: "x" }, status: "running", step: "Building", attempts: 1, createdAt: "2026-10-30T09:00:00Z", startedAt: "2026-10-30T09:00:00Z" },
    { id: "task-0", kind: "task", title: "Old", input: {}, status: "done", step: "Done", answer: "Old answer" },
  ] };
  const seen = [];
  const { jobs, finished, done } = setup({ before, runners: { task: async (job) => { seen.push(job.step); return { answer: "Here it is." }; } } });
  try {
    await jobs.ready;
    await tick();
    assert.deepEqual(seen, ["Picking up where I left off"]);
    assert.equal(finished[0].id, "task-1");
    assert.equal(jobs.get("task-1").attempts, 2);
  } finally {
    done();
  }
});

test("Felix's job tools: build a missing tool once, hand off a task, see how they're going, use a tool built since", async () => {
  const { runner, waiting } = gated();
  const { jobs, done } = setup({ runners: { build: runner, task: runner } });
  const own = { name: "who_is_out", description: "Who's out", inputSchema: { type: "object" }, own: true, run: async (a) => ({ out: ["Ana"], year: a.year }) };
  const acting = { name: "nudge_team", description: "Nudges", inputSchema: { type: "object" }, own: true, card: async () => ({ title: "Nudge?", detail: "" }), run: async () => 1 };
  const toolbox = {
    list: () => [{ name: "calendar_events", description: "x", inputSchema: {}, run: async () => 1 }, own, acting],
    mine: async () => ({ tools: [{ ...own, version: 2, createdAt: "x", step: "s" }], problems: {} }),
  };
  const tools = Object.fromEntries(jobTools({ jobs, toolbox }).map((t) => [t.name, t]));
  try {
    const first = await tools.tool_build.run({ question: "Is anyone on VL next year?", need: "Who is on vacation leave in a year" });
    assert.equal(first.started, true);
    assert.equal(first.say, "I'm sorry, I'm not able to do it right now, let me look into this.");
    await tick();
    const again = await tools.tool_build.run({ question: "Anyone on VL next year?", need: "Who is on vacation leave in a year" });
    assert.equal(again.started, false, "the same need isn't built twice");
    assert.equal(again.already.id, first.job.id);
    assert.equal(waiting[0].job.input.extend, null);
    await tools.tool_build.run({ question: "q", need: "more", extend: "who_is_out" });

    const handed = await tools.delegate.run({ task: "Summarize the sprint risks" });
    assert.equal(handed.kind, "task");
    assert.equal(handed.title, "Summarize the sprint risks");
    await tick();
    assert.equal(waiting.find((w) => w.job.input.need === "more").job.input.extend, "who_is_out");

    const status = await tools.jobs_status.run({ open: true });
    assert.equal(status.jobs.length, 3);
    assert.deepEqual(Object.keys(status.jobs[0]).sort(), ["answer", "endedAt", "id", "kind", "startedAt", "status", "step", "title"]);

    assert.deepEqual(await tools.my_tools.run({}), [{ name: "who_is_out", description: "Who's out", inputSchema: { type: "object" }, version: 2 }]);
    assert.deepEqual(await tools.tool_use.run({ name: "who_is_out", args: { year: 2027 } }), { out: ["Ana"], year: 2027 });
    assert.deepEqual(await tools.tool_use.run({ name: "who_is_out" }), { out: ["Ana"], year: undefined });
    await assert.rejects(tools.tool_use.run({ name: "calendar_events" }), /no tool of mine/);
    await assert.rejects(tools.tool_use.run({ name: "nudge_team" }), /used directly/);
    waiting.forEach((w) => w.resolve({ answer: "ok" }));
  } finally {
    done();
  }
});
