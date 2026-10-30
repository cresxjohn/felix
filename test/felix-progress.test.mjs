import { test } from "node:test";
import assert from "node:assert/strict";
import { createProgress, lineFor, phraseList, spokenStep } from "../public/felix-progress.mjs";
import { PROGRESS_PHRASES } from "../public/settings-schema.mjs";

/**
 * Timers Felix's progress lines run on, moved forward by hand.
 * @returns {{ timers: import("../public/felix-progress.mjs").Timers, after: (ms: number) => Promise<void> }}
 */
function fakeTimers() {
  let now = 0;
  let next = 1;
  const due = new Map();
  const timers = {
    set: (fn, ms) => {
      const id = next++;
      due.set(id, { fn, at: now + ms });
      return id;
    },
    clear: (id) => due.delete(id),
  };
  const after = async (ms) => {
    const until = now + ms;
    for (;;) {
      const [id, t] = [...due.entries()].filter(([, x]) => x.at <= until).sort((a, b) => a[1].at - b[1].at)[0] || [];
      if (!id) break;
      due.delete(id);
      now = t.at;
      t.fn();
      await new Promise((resolve) => setImmediate(resolve));
    }
    now = until;
  };
  return { timers, after };
}

test("steps are put the way you'd say them, and an unknown one is just 'working on it'", () => {
  assert.equal(spokenStep("Checking GitHub and Datadog"), "checking GitHub and Datadog");
  assert.equal(spokenStep("Looking into it"), "looking into it");
  assert.equal(spokenStep("Double-checking"), "double-checking my answer");
  assert.equal(spokenStep("Getting ready"), "getting ready");
  assert.equal(spokenStep("Claude's out of usage, asking Cursor"), "asking Cursor");
  assert.equal(spokenStep("Claude's plan is used up, so Composer 2.5 Fast (Cursor) is answering"), "asking Cursor");
  assert.equal(spokenStep("On it"), "working on it");
  assert.equal(spokenStep("Read public/felix.js"), "reading through the code");
  assert.equal(spokenStep("grep onProgress"), "reading through the code");
  assert.equal(spokenStep("Edit felix.mjs"), "making the change in my workbench");
  assert.equal(spokenStep("Bash ./prs test"), "running the tests");
  assert.equal(spokenStep("Bash ls -la"), "running a command");
  assert.equal(spokenStep("WebSearch kokoro voices"), "looking it up on the web");
  assert.equal(spokenStep("TodoWrite"), "planning it out");
  assert.equal(spokenStep("Testing and applying"), "testing and applying");
  assert.equal(spokenStep("Felix never runs that one"), "working on it");
  assert.equal(spokenStep(""), "pulling that up");
  assert.equal(spokenStep(undefined), "pulling that up");
});

test("your phrases come one a line, with Felix's own when the box is empty", () => {
  assert.deepEqual(phraseList(" Hang on, {step}. \n\n Still {step}. "), ["Hang on, {step}.", "Still {step}."]);
  assert.deepEqual(phraseList(""), [...PROGRESS_PHRASES]);
  assert.deepEqual(phraseList(null), [...PROGRESS_PHRASES]);
});

test("the first line has no 'still', updates on the same step do, and no line comes twice in a row", () => {
  const phrases = ["Hold on, {step}.", "One moment, {step}.", "Still {step}."];
  const first = lineFor("Checking GitHub", phrases, { update: false, sameStep: false, last: "", random: () => 0 });
  assert.equal(first, "Hold on, checking GitHub.");
  assert.equal(lineFor("Checking GitHub", phrases, { update: false, sameStep: false, last: first, random: () => 0 }), "One moment, checking GitHub.");
  assert.equal(lineFor("Checking GitHub", phrases, { update: true, sameStep: true, last: first, random: () => 0 }), "Still checking GitHub.");
  assert.equal(lineFor("Looking into it", phrases, { update: true, sameStep: false, last: first, random: () => 0 }), "Hold on, looking into it.");
  // With the only "still" line just said, an update falls back to another line rather than repeating it.
  assert.equal(lineFor("Checking GitHub", phrases, { update: true, sameStep: true, last: "Still checking GitHub.", random: () => 0 }), "Hold on, checking GitHub.");
  assert.equal(lineFor("Looking into it", ["{step}"], { update: false, sameStep: false, last: "", random: () => 0.99 }), "Looking into it");
  assert.equal(lineFor("Looking into it", ["{step}"], { update: true, sameStep: true, last: "Looking into it" }), null);
  assert.match(lineFor("Looking into it", phrases, { update: false, sameStep: false, last: "" }), /looking into it\.$/);
});

test("progress lines start after the delay, update every few seconds, and stop when told", async () => {
  const said = [];
  const { timers, after } = fakeTimers();
  const progress = createProgress({ delayMs: 1500, everyMs: 6000, phrases: ["Hold on, {step}.", "Still {step}."], say: (l) => said.push(l), random: () => 0, timers });
  progress.step("Checking GitHub");
  await after(1400);
  assert.deepEqual(said, []);
  await after(100);
  assert.deepEqual(said, ["Hold on, checking GitHub."]);
  await after(6000);
  assert.deepEqual(said, ["Hold on, checking GitHub.", "Still checking GitHub."]);
  progress.step("Running the tests");
  await after(6000);
  assert.equal(said.at(-1), "Hold on, running the tests.");
  progress.stop();
  await after(60_000);
  assert.equal(said.length, 3);
  assert.deepEqual(progress.said(), said);
});

test("an update due while a line is still being said is skipped, and a failed line doesn't stop the next", async () => {
  const said = [];
  let finish = () => {};
  const { timers, after } = fakeTimers();
  const say = (line) => {
    said.push(line);
    if (said.length === 1) return new Promise((resolve) => { finish = resolve; });
    if (said.length === 2) throw new Error("no voice");
    return undefined;
  };
  const progress = createProgress({ delayMs: 1000, everyMs: 2000, phrases: ["A {step}.", "B {step}.", "Still {step}."], say, random: () => 0, timers });
  progress.step("Checking Jira");
  await after(1000);
  await after(2000);
  assert.equal(said.length, 1);
  finish();
  await new Promise((resolve) => setImmediate(resolve));
  await after(2000);
  assert.equal(said.length, 2);
  await after(2000);
  assert.equal(said.length, 3);
  assert.notEqual(said[1], said[2]);
  progress.stop();
});

test("progress lines use the real timers when none are given, called the way a browser allows", async () => {
  // A browser throws "Illegal invocation" when setTimeout runs with another object as `this`; this stands in for it.
  const real = globalThis.setTimeout;
  globalThis.setTimeout = function strict(fn, ms) {
    if (this !== undefined && this !== globalThis) throw new TypeError("Illegal invocation");
    return real(fn, ms);
  };
  const said = [];
  const progress = createProgress({ delayMs: 5, everyMs: 1000, phrases: ["Hold on, {step}."], say: (l) => said.push(l) });
  progress.step("Checking Slack");
  try {
    await new Promise((resolve) => real(resolve, 30));
  } finally {
    globalThis.setTimeout = real;
  }
  progress.stop();
  assert.deepEqual(said, ["Hold on, checking Slack."]);
});

test("while Felix is only thinking he says nothing, and speaks up once there's a real step", async () => {
  const said = [];
  const { timers, after } = fakeTimers();
  const progress = createProgress({ delayMs: 1500, everyMs: 0, phrases: ["Hold on, {step}."], say: (l) => said.push(l), random: () => 0, timers });
  for (const step of ["", "Getting ready", "Looking into it", "Double-checking"]) {
    progress.step(step);
    await after(2000);
  }
  assert.deepEqual(said, [], "no filler line for thinking");
  progress.step("Checking your calendar");
  await after(500);
  assert.deepEqual(said, ["Hold on, checking your calendar."]);
  progress.step("Looking into it");
  await after(10_000);
  assert.equal(said.length, 1, "and still only the one line");
  progress.stop();
  const quick = [];
  const q = createProgress({ delayMs: 1500, everyMs: 0, phrases: ["Hold on, {step}."], say: (l) => quick.push(l), timers });
  q.step("Looking into it");
  await after(3000);
  q.stop();
  await after(10_000);
  assert.deepEqual(quick, [], "an answer that comes while he's thinking gets no line at all");
});

test("with updates off, Felix says one line when he starts and no more", async () => {
  const said = [];
  const pending = [];
  const timers = { set: (fn, ms) => { pending.push({ fn, ms }); return pending.length; }, clear: () => {} };
  createProgress({ delayMs: 1500, everyMs: 0, phrases: ["Hold on, {step}."], say: (l) => said.push(l), timers }).step("Checking your calendar");
  pending.shift().fn();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(said.length, 1);
  assert.equal(pending.length, 0, "no update is scheduled");
});
