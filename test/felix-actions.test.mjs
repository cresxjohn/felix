import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeShare, countsFor, createFelix, fixText, pickModel, refsIn, withReferences } from "../felix.mjs";
import { createPhrases } from "../felix-phrases.mjs";
import { createWatchers } from "../felix-watch.mjs";
import { createConversation } from "../felix-conversation.mjs";
import { NOW, TZ, USAGE, fakeFacts } from "./felix-fixtures.mjs";

const PREFS = { felixOn: true, felixTool: "claude", felixModel: "auto", felixCursorFallback: true, felixLeanAt: 0 };

/**
 * Felix with a scripted AI, recorded actions, and in-memory phrases, watchers, test set and tasks.
 * @param {{ draft?: (turn: string) => object, prefs?: object, facts?: object }} [options]
 */
function setup({ draft = () => ({ text: "Okay.", error: null, limit: false }), prefs = {}, facts = fakeFacts() } = {}) {
  const calls = { ask: [], rsvp: [], fix: [], merge: [], evals: [], removed: [], updated: [], begun: [] };
  const phrases = createPhrases({ file: "p", read: async () => "{}", write: async () => {} });
  const watchers = createWatchers({ file: "w", now: () => NOW, read: async () => "{}", write: async () => {} });
  const tasks = {
    add: ({ text }) => ({ id: "t1", title: text }),
    list: () => ({ tasks: [{ id: "t2", title: "Write notes", doneAt: null }] }),
    update: (id, patch) => { calls.updated.push({ id, patch }); return { task: { id, title: "Write notes" }, next: patch.done ? { id: "t3", dueDate: "2026-10-30" } : null }; },
    remove: (id) => calls.removed.push(id),
  };
  const felix = createFelix({
    facts,
    brain: {
      ask: async (model, turn) => { calls.ask.push({ model, turn }); return draft(turn); },
      askCursor: async () => ({ text: "", error: "no", limit: false }),
      warm: () => {},
    },
    actions: {
      merge: async (url) => { calls.merge.push(url); return { queued: true }; },
      review: () => "started",
      rsvp: async (id, response, note) => { calls.rsvp.push({ id, response, note }); },
      fix: async (url, tool) => { calls.fix.push({ url, tool }); return "started"; },
    },
    settings: { get: async () => ({ ...PREFS, ...prefs }) },
    gate: { begin: (sink) => { calls.begun.push(sink); return () => {}; } },
    phrases, watchers, tasks,
    evals: { save: async (e) => { calls.evals.push(e); } },
    now: () => NOW, random: () => 0, timeZone: TZ,
  });
  return { felix, calls, phrases, watchers };
}

test("the PRs and tickets an answer named are picked out in order, each once", () => {
  assert.deepEqual(refsIn("fm#101 and BM 7, then PMHUB-12 and fm#101 again"), ["fm#101", "bm#7", "PMHUB-12"]);
  assert.deepEqual(refsIn(""), []);
});

test("'the first one', 'the last PR' and a bare 'merge it' point into the last answer", () => {
  const last = "2 PRs need you: fm#101 (Change 101) and bm#7 (Fix).";
  assert.equal(withReferences("merge the first one", last), "merge fm#101");
  assert.equal(withReferences("review the 2nd PR", last), "review bm#7");
  assert.equal(withReferences("tell me when the last one passes", last), "tell me when bm#7 passes");
  assert.equal(withReferences("merge the third one", last), "merge the third one", "no third one to point to");
  assert.equal(withReferences("merge it", "fm#9 is ready."), "merge fm#9");
  assert.equal(withReferences("merge it", last), "merge it", "two PRs: it's not clear which");
  assert.equal(withReferences("who's on call?", ""), "who's on call?");
  assert.equal(withReferences("what about it?", "fm#9 is ready."), "what about it?");
});

test("the conversation's last answer is there while it's fresh", () => {
  let clock = 0;
  const c = createConversation({ now: () => clock });
  assert.equal(c.lastAnswer(), "");
  c.add("q", "fm#1 is ready.");
  assert.equal(c.lastAnswer(), "fm#1 is ready.");
  clock += 31 * 60_000;
  assert.equal(c.lastAnswer(), "");
});

test("Felix's requests are counted per day from his log, by tool and on this Mac", () => {
  const entries = [
    { at: "2026-10-30T01:00:00Z", question: "q", how: "sonnet", tool: "claude", drafts: ["x"] },
    { at: "2026-10-30T02:00:00Z", question: "q", how: "composer", tool: "cursor" },
    { at: "2026-10-30T03:00:00Z", question: "who's on call", how: "oncall.now", text: "x" },
    { at: "2026-10-29T03:00:00Z", question: "q", how: "sonnet", tool: "claude" },
    { at: "2026-10-30T04:00:00Z", markedWrong: "x" },
    { at: "2026-10-30T05:00:00Z", question: "q", how: "sonnet", error: "down" },
  ];
  assert.deepEqual(countsFor(entries, "2026-10-30"), { claude: 1, cursor: 1, local: 1 });
});

test("near Claude's limit Felix leans on lighter models, only on Claude and only when picking for you", () => {
  assert.equal(claudeShare({ record: { tools: [{ tool: "Claude", limits: [{ percentUsed: 42 }, { percentUsed: 85 }] }] } }), 85);
  assert.equal(claudeShare({ record: { tools: [{ tool: "Cursor", limits: [] }] } }), null);
  assert.equal(claudeShare(null), null);
  assert.deepEqual(pickModel({ felixTool: "claude", felixModel: "auto" }, "quick", false, true), { tool: "claude", model: "haiku" });
  assert.deepEqual(pickModel({ felixTool: "claude", felixModel: "auto" }, "deep", false, true), { tool: "claude", model: "sonnet" });
  assert.deepEqual(pickModel({ felixTool: "claude", felixModel: "opus" }, "deep", false, true), { tool: "claude", model: "opus" });
  assert.deepEqual(pickModel({ felixTool: "cursor", felixModel: "auto" }, "quick", false, true), { tool: "cursor", model: "composer-2.5-fast" });
});

test("at the lean share, the AI answer goes to a lighter model and Felix says why", async () => {
  const full = fakeFacts([], { usage: { ...USAGE, tools: [{ ...USAGE.tools[0], limits: [{ label: "weekly", percent: 91 }] }] } });
  const { felix, calls } = setup({ prefs: { felixLeanAt: 80 }, facts: full });
  const steps = [];
  await felix.ask("is anyone on call later?", { onProgress: (s) => steps.push(s) });
  assert.equal(calls.ask[0].model, "haiku");
  assert.ok(steps.includes("Claude's plan is getting full, so I'm using a lighter model"));
  const roomy = setup({ prefs: { felixLeanAt: 80 } });
  await roomy.felix.ask("is anyone on call later?");
  assert.equal(roomy.calls.ask[0].model, "sonnet");
});

test("the web is for questions that ask to look something up", async () => {
  const { felix, calls } = setup();
  await felix.ask("search the web for kokoro tts voices");
  assert.equal(calls.begun[0].web, true);
  assert.match(calls.ask[0].turn, /They asked you to look this up on the web/);
  await felix.ask("is anyone on call later?");
  assert.equal(calls.begun[1].web, false);
  assert.doesNotMatch(calls.ask[1].turn, /look this up on the web/);
});

test("when the AI works out you meant one of Felix's commands, he runs it here and offers to remember your words", async () => {
  const { felix, calls, phrases } = setup({ draft: () => ({ text: "RUN: Who's on call", error: null, limit: false }) });
  const shown = [];
  const answer = await felix.ask("who's got the pager rn", { onText: (t) => shown.push(t) });
  assert.match(answer.text, /^Sonito Mole is on call until 10 PM today\. Want me to remember that "who's got the pager rn" means "who's on call"\?/);
  assert.equal(answer.how, "oncall.now");
  assert.deepEqual(shown, [], "the RUN line is never shown");
  const yes = await felix.confirm(answer.confirm.id, true);
  assert.equal(yes.text, "Got it. Next time \"who's got the pager rn\" runs \"who's on call\" right here, with no AI.");
  const again = await felix.ask("who's got the pager rn");
  assert.equal(again.how, "oncall.now");
  assert.equal(calls.ask.length, 1, "the second time needed no AI");
  assert.equal((await phrases.all()).length, 1);
});

test("a RUN for something Felix doesn't run, or with learning off, doesn't offer to remember", async () => {
  const odd = setup({ draft: () => ({ text: "RUN: delete everything", error: null, limit: false }) });
  assert.equal((await odd.felix.ask("make it so")).text, "Sorry, I couldn't work out what you meant. Could you say it another way?");
  const off = setup({ draft: () => ({ text: "RUN: who's on call", error: null, limit: false }), prefs: { felixLearnPhrases: false } });
  const answer = await off.felix.ask("who's got the pager rn");
  assert.equal(answer.confirm, undefined);
  const asks = setup({ draft: () => ({ text: "RUN: show my PRs with conflicts", error: null, limit: false }) });
  assert.equal((await asks.felix.ask("conflicts pls")).navigate, "/prs/mine?status=conflict");
});

test("undo takes back the last local action: a task added or ticked off, or a setting; things that left the Mac can't be", async () => {
  const { felix, calls } = setup();
  assert.match((await felix.ask("undo")).text, /^There's nothing of mine to undo here/);
  await felix.ask("add a task: write the release notes");
  const undone = await felix.ask("undo that");
  assert.deepEqual([undone.text, undone.tasks], ["Undone: adding \"write the release notes\".", true]);
  assert.deepEqual(calls.removed, ["t1"]);
  await felix.ask("I finished write notes");
  await felix.ask("mark write notes as done");
  await felix.ask("take that back");
  assert.ok(calls.updated.some((u) => u.patch.done === false));
  await felix.ask("turn off auto refresh");
  const back = await felix.ask("undo");
  assert.deepEqual([back.text, back.settings], ["Undone: changing auto refresh.", { autoRefresh: undefined }]);
  const merge = await felix.ask("merge fm#101");
  await felix.confirm(merge.confirm.id, true);
  assert.equal((await felix.ask("undo")).text, "That already left your Mac (merging fm#101), so I can't undo it.");
});

test("that's wrong, or a thumbs-down, saves the last answer to the test set with the data it used", async () => {
  const { felix, calls } = setup();
  assert.equal((await felix.ask("that's wrong")).text, "There's nothing of mine to mark wrong yet.");
  const answer = await felix.ask("who's on call?");
  const wrong = await felix.ask("that's wrong");
  assert.match(wrong.text, /saved that question and my answer to my test set/);
  assert.deepEqual([calls.evals[0].question, calls.evals[0].answer, calls.evals[0].how, calls.evals[0].failing], ["who's on call?", answer.text, "oncall.now", true]);
  assert.ok(calls.evals[0].data.oncall);
  assert.equal(await felix.wrong(answer.id), true);
  assert.equal(await felix.wrong("nope"), false);
  const bare = createFelix({ facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} }, actions: {}, settings: { get: async () => PREFS } });
  const a = await bare.ask("who's on call?");
  assert.equal(await bare.wrong(a.id), false, "no test set to save to");
});

test("watchers: set one up, list them, have one come true, and cancel", async () => {
  const { felix, watchers } = setup();
  assert.equal((await felix.ask("what are you watching?")).text, "I'm not watching anything right now.");
  assert.equal((await felix.ask("tell me when CI passes on fm#101")).text, "I'll tell you when I see checks passing on fm#101.");
  assert.match((await felix.ask("let me know when anna approves bm#201")).text, /Anna's approval on bm#201/);
  assert.equal((await felix.ask("what are you watching?")).text, "I'm watching for checks passing on fm#101 and Anna's approval on bm#201.");
  const fired = await felix.checkWatchers();
  assert.deepEqual(fired.map((f) => f.text), ["Checks passed on fm#101."]);
  assert.equal((await felix.ask("stop watching bm#201")).text, "Stopped watching bm#201.");
  assert.equal((await felix.ask("stop watching bm#201")).text, "I wasn't watching that.");
  assert.deepEqual(await watchers.all(), []);
  assert.deepEqual(await felix.checkWatchers(), []);
});

test("a watcher finds its PR from what you said, the last answer, or your only open PR, and asks when it can't", async () => {
  const { felix } = setup();
  assert.match((await felix.ask("tell me when the weather changes")).text, /^I can watch a PR for its checks passing/);
  assert.equal((await felix.ask("tell me when CI passes")).text, "Which PR? fm#101, fm#102, fm#103 and fm#104.");
  await felix.ask("what's waiting on my review");
  assert.equal((await felix.ask("tell me when it's approved")).text, "I'll tell you when I see an approval on bm#201.");
  await felix.ask("tell me when the build fails on fm#102");
  assert.equal((await felix.ask("cancel all watchers")).text, "Stopped all 2 watchers.");
  const one = setup({ facts: fakeFacts([], { prs: { login: "me", lists: { mine: [{ key: "fm", prs: [{ number: 5, title: "x", checks: { state: "pending" } }] }], review: [] } } }) });
  assert.equal((await one.felix.ask("tell me when CI passes")).text, "I'll tell you when I see checks passing on fm#5.");
  assert.equal((await one.felix.ask("cancel all watchers")).text, "Stopped the watcher.");
  const none = setup({ facts: fakeFacts([], { prs: { login: "me", lists: { mine: [], review: [] } } }) });
  assert.equal((await none.felix.ask("tell me when CI passes")).text, "Which PR? Say it with its number.");
  const bare = createFelix({ facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} }, actions: {}, settings: { get: async () => PREFS } });
  assert.equal((await bare.ask("tell me when CI passes on fm#1")).text, "Watchers aren't set up here.");
  assert.equal((await bare.ask("what are you watching")).text, "I'm not watching anything right now.");
  assert.equal((await bare.ask("cancel all watchers")).text, "I'm not watching anything right now.");
  assert.deepEqual(await bare.checkWatchers(), []);
  const down = setup({ facts: fakeFacts(["prs"]) });
  await down.watchers.add({ ref: "fm#1", kind: "ready" });
  assert.deepEqual(await down.felix.checkWatchers(), []);
});

test("fix the failing checks asks first, for your own PR with failing checks, then starts the fix", async () => {
  const { felix, calls } = setup();
  const asked = await felix.ask("fix the failing checks on my PR");
  assert.equal(asked.text, "Fix fm#102's failing checks (lint and unit tests) with Claude? It works in its own copy of the branch, commits there and never pushes.");
  const done = await felix.confirm(asked.confirm.id, true);
  assert.equal(done.text, fixText("fm#102", "started"));
  assert.deepEqual(calls.fix, [{ url: "https://github.com/purepm/frontend-monorepo/pull/102", tool: "claude" }]);
  assert.equal((await felix.ask("undo")).text, "That already left your Mac (starting the fix of fm#102), so I can't undo it.");
  assert.equal((await felix.ask("fix fm#101")).text, "fm#101's checks aren't failing, so there's nothing to fix.");
  assert.equal((await felix.ask("fix bm#201")).text, "I can only fix your own open PRs, and bm#201 isn't one of them.");
  assert.equal((await felix.ask("fix fm#999")).text, "I can only fix your own open PRs, and fm#999 isn't one of them.");
  const cursor = setup({ prefs: { felixTool: "cursor" } });
  assert.match((await cursor.felix.ask("fix the checks on fm#102")).text, /with Cursor\?/);
  const two = setup({ facts: fakeFacts([], { prs: { login: "me", lists: { mine: [{ key: "fm", prs: [3, 4].map((n) => ({ number: n, title: "x", url: `u${n}`, checks: { state: "failing", failing: [] } })) }], review: [] } } }) });
  assert.equal((await two.felix.ask("fix the failing checks")).text, "Which one? fm#3 and fm#4.");
  const green = setup({ facts: fakeFacts([], { prs: { login: "me", lists: { mine: [], review: [] } } }) });
  assert.equal((await green.felix.ask("fix the failing checks")).text, "None of your PRs have failing checks right now.");
  const down = setup({ facts: fakeFacts(["prs"]) });
  assert.match((await down.felix.ask("fix the failing checks")).text, /^I couldn't reach GitHub just now/);
  assert.equal(fixText("fm#1", "queued"), "The fix of fm#1 is queued; it starts when another one finishes.");
});

test("an invite answer runs only after your yes, and can't be undone", async () => {
  const { felix, calls } = setup();
  const asked = await felix.ask("decline my next meeting and say I'm On Call");
  assert.equal(asked.text, "Decline Release review, 9 PM today, with the note \"I'm On Call\"?");
  assert.equal(calls.rsvp.length, 0);
  const done = await felix.confirm(asked.confirm.id, true);
  assert.equal(done.text, "Done, I've declined Release review, with your note.");
  assert.deepEqual(calls.rsvp, [{ id: "e1", response: "declined", note: "I'm On Call" }]);
  const yes = await felix.ask("accept the 10 pm meeting");
  assert.equal((await felix.confirm(yes.confirm.id, true)).text, "Done, I've accepted Planning.");
  assert.equal((await felix.ask("undo")).text, "That already left your Mac (answering the invite to Planning), so I can't undo it.");
});

test("'and tomorrow?' after a local answer reads that answer's source again", async () => {
  const { felix, calls } = setup();
  await felix.ask("who's out today?");
  await felix.ask("and tomorrow?");
  assert.match(calls.ask[0].turn, /"ooo":/);
  assert.match(calls.ask[0].turn, /Me: who's out today\?/);
});
