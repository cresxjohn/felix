import { test } from "node:test";
import assert from "node:assert/strict";
import {
  PICKS, SYSTEM_PROMPT, answeredBy, chipsFor, claudeUsedUp, createFelix, dataFor, depthOf, mergedText, oldDataNote, onCursor, testsNote, pickModel, retryTurn, reviewText,
  routeQuestion, rulesWith,
} from "../felix.mjs";
import { NOW, TZ, USAGE, fakeFacts } from "./felix-fixtures.mjs";
import { CRISIS_TEXT } from "../felix-friend.mjs";

const PREFS = { felixOn: true, felixTool: "claude", felixModel: "haiku", felixCursorFallback: true };
const AUTO = { felixTool: "auto", felixModel: "auto" };

/**
 * Felix over made-up data, a scripted AI and recorded actions.
 * The AI's replies are written out word by word, as the real ones stream.
 * @param {{ draft?: (turn: string, model: string) => object, cursor?: (text: string) => object, prefs?: object, facts?: object,
 *   merge?: Function, review?: Function, pastLimit?: boolean }} [options]
 */
function setup({ draft = () => ({ text: "Okay.", error: null, limit: false }), cursor = () => ({ text: "Sonito Mole is on call.", error: null, limit: false }),
  prefs = {}, facts = fakeFacts(), merge, review, pastLimit = false, personal } = {}) {
  const calls = { ask: [], cursor: [], warm: [], merge: [], review: [], log: [] };
  let clock = NOW;
  const streamed = (answer, onDelta) => {
    for (const word of String(answer.text || "").match(/\S+\s*/g) || []) onDelta?.(word);
    return answer;
  };
  const brain = {
    ask: async (model, turn, options = {}) => {
      calls.ask.push({ model, turn });
      return streamed(draft(turn, model), options.onDelta);
    },
    askCursor: async (text, model, options = {}) => {
      calls.cursor.push({ text, model, before: options.before });
      return streamed(cursor(text), options.onDelta);
    },
    warm: (model) => calls.warm.push(model),
    pastLimit: () => pastLimit,
  };
  const actions = {
    merge: merge || (async (url) => { calls.merge.push(url); return { queued: true, position: 2 }; }),
    review: review || ((url, tool) => { calls.review.push({ url, tool }); return "started"; }),
  };
  const felix = createFelix({
    facts, brain, actions, settings: { get: async () => ({ ...PREFS, ...prefs }) }, log: (e) => calls.log.push(e),
    now: () => clock, random: () => 0, timeZone: TZ, personal,
  });
  return { felix, calls, later: (ms) => { clock += ms; } };
}

/**
 * Asks and records the progress steps.
 * @param {ReturnType<typeof createFelix>} felix
 * @param {string} text
 */
async function askWithSteps(felix, text) {
  const steps = [];
  const shown = [];
  const answer = await felix.ask(text, { onProgress: (s) => steps.push(s), onText: (t) => shown.push(t) });
  return { answer, steps, shown };
}

test("questions are routed to the sources they need", () => {
  assert.deepEqual(routeQuestion("is anna on call later?"), { sources: ["oncall"], prs: [], notYet: [], followsOn: false });
  assert.deepEqual(routeQuestion("summarize fm#101 and BM 7"), { sources: [], prs: [{ repo: "fm", number: 101 }, { repo: "bm", number: 7 }], notYet: [], followsOn: false });
  assert.deepEqual(routeQuestion("how's the release going").sources, ["releases"]);
  assert.deepEqual(routeQuestion("what's on my calendar today"), { sources: ["calendar"], prs: [], notYet: [], followsOn: false });
  assert.deepEqual(routeQuestion("who's out next week").sources, ["ooo"]);
  assert.deepEqual(routeQuestion("what's the status of PMHUB-123").sources, ["jira"]);
  assert.deepEqual(routeQuestion("anything due today on my list").sources, ["tasks"]);
  assert.equal(routeQuestion("and who approved it?").followsOn, true);
  assert.deepEqual(routeQuestion("any jira tickets or slack messages?"), { sources: ["jira"], prs: [], notYet: ["Slack"], followsOn: false });
  assert.deepEqual(routeQuestion("how's it going").sources, ["oncall", "prs", "releases", "usage"]);
  assert.deepEqual(routeQuestion("brief me on my PRs"), { sources: ["prs", "oncall", "releases", "calendar", "jira", "ooo", "tasks"], prs: [], notYet: ["Slack"], followsOn: false });
  assert.deepEqual(routeQuestion("wrap up my day").sources, ["oncall", "prs", "releases", "calendar", "jira", "ooo", "tasks"]);
  assert.deepEqual(routeQuestion("what's this song").sources, ["music"]);
  assert.deepEqual(routeQuestion("add a weather widget"), { sources: [], prs: [], notYet: [], followsOn: false });
  assert.equal(routeQuestion("fix it").followsOn, true);
  assert.deepEqual(routeQuestion("remember that I like short answers").sources, []);
  // Naming nothing reads the main sources only for work-sounding questions; small talk and general ones read none.
  assert.deepEqual(routeQuestion("tell me a joke").sources, []);
  assert.deepEqual(routeQuestion("what is 15% of 80").sources, []);
  assert.deepEqual(routeQuestion("anything I should know?").sources, ["oncall", "prs", "releases", "usage"]);
});

test("the AI sees each source's record, or why it couldn't be read", async () => {
  const facts = fakeFacts(["prs"]);
  const data = dataFor([await facts.read("oncall"), await facts.read("prs"), await facts.read("pr", { repo: "fm", number: 101 }), { name: "pr", source: "GitHub", error: "gone", link: null }]);
  assert.deepEqual(Object.keys(data), ["oncall", "prs", "pr fm#101", "pr"]);
  assert.equal(data.oncall.source, "Datadog");
  assert.equal(data.oncall.schedules.length, 1);
  assert.deepEqual(data.prs, { source: "GitHub", error: "prs is down" });
  assert.equal(data["pr fm#101"].ref, "fm#101");
});

test("chips name each source once, with when it was read", async () => {
  const facts = fakeFacts(["releases"]);
  const oncall = await facts.read("oncall");
  assert.deepEqual(chipsFor([oncall, oncall, await facts.read("releases")], TZ), [
    { label: "Datadog · 7:58 PM", link: "https://app.datadoghq.com/on-call/schedules/abc" },
    { label: "GitHub releases · couldn't read", link: null },
  ]);
});

test("a local command answers without the AI, and Felix remembers its sources", async () => {
  const { felix, calls } = setup();
  const answer = await felix.ask("Hey Felix, who's on call?");
  assert.equal(answer.text, "Sonito Mole is on call until 10 PM today.");
  assert.equal(answer.how, "oncall.now");
  assert.deepEqual(answer.chips, [{ label: "Datadog · 7:58 PM", link: "https://app.datadoghq.com/on-call/schedules/abc" }]);
  assert.ok(answer.id);
  assert.equal(calls.ask.length, 0);
  assert.equal(calls.log[0].how, "oncall.now");
  const where = await felix.ask("where did you get that?");
  assert.equal(where.text, "That came from Datadog, read at 7:58 PM.");
  // Asked again, the same facts in another wording, so Felix doesn't sound like a recording.
  const again = (await felix.ask("where did you get that")).text;
  assert.notEqual(again, where.text);
  assert.match(again, /Datadog, read at 7:58 PM\.$/);
  assert.equal((await felix.ask("   ")).how, "empty");
});

test("commands hand the page what to do", async () => {
  const { felix } = setup();
  assert.equal((await felix.ask("show my PRs with conflicts")).navigate, "/prs/mine?status=conflict");
  assert.deepEqual((await felix.ask("turn off auto refresh")).settings, { autoRefresh: false });
  assert.equal((await felix.ask("next song")).music, "next");
  const plain = await felix.ask("thanks");
  assert.equal("navigate" in plain || "settings" in plain || "music" in plain || "confirm" in plain, false);
});

test("a merge waits for yes, and each yes is used once", async () => {
  const { felix, calls, later } = setup();
  const asked = await felix.ask("merge fm#101");
  assert.deepEqual(asked.confirm.label, "Merge");
  const done = await felix.confirm(asked.confirm.id, true);
  assert.equal(done.text, "fm#101 is in the merge queue, at number 2.");
  assert.deepEqual(calls.merge, ["https://github.com/purepm/frontend-monorepo/pull/101"]);
  assert.match((await felix.confirm(asked.confirm.id, true)).text, /timed out/);

  const no = await felix.ask("merge fm#101");
  assert.equal((await felix.confirm(no.confirm.id, false)).text, "Okay, I won't.");
  const old = await felix.ask("merge fm#101");
  later(3 * 60_000);
  assert.match((await felix.confirm(old.confirm.id, true)).text, /timed out/);
  assert.equal(calls.merge.length, 1);
});

test("a review starts on yes, and a failed action says why", async () => {
  const { felix, calls } = setup();
  const asked = await felix.ask("review bm#88 with cursor");
  assert.equal((await felix.confirm(asked.confirm.id, true)).text, "Started the review of bm#88. It'll show up in the PR's details.");
  assert.deepEqual(calls.review, [{ url: "https://github.com/purepm/backend-monorepo/pull/88", tool: "cursor" }]);
  assert.equal(calls.log.at(-1).action, "review");

  const failing = setup({ merge: async () => { throw new Error("Not ready to merge."); } });
  const m = await failing.felix.ask("merge fm#101");
  assert.equal((await failing.felix.confirm(m.confirm.id, true)).text, "That didn't work: Not ready to merge.");
});

test("the AI answers from fresh data, with progress along the way", async () => {
  const { felix, calls } = setup({ draft: () => ({ text: "Yes, Anna Reyes takes over at 10 PM today.", error: null, limit: false }) });
  const { answer, steps } = await askWithSteps(felix, "Is Anna on call later?");
  assert.equal(answer.text, "Yes, Anna Reyes takes over at 10 PM today.");
  assert.equal(answer.how, "haiku");
  assert.deepEqual(steps, ["Checking Datadog", "Looking into it"]);
  const { turn, model } = calls.ask[0];
  assert.equal(model, "haiku");
  assert.match(turn, /^It's Thursday, Oct 29 at 8 PM\./);
  assert.match(turn, /"Anna Reyes"/);
  assert.match(turn, /My question: Is Anna on call later\?$/);
  assert.equal(calls.log[0].ok, true);
  assert.equal((await felix.ask("where did you get that")).text, "That came from Datadog, read at 7:58 PM.");
});

test("on Auto, summaries and PR questions use the deep model", async () => {
  const { felix, calls } = setup({ prefs: AUTO, draft: () => ({ text: "fm#101 adds and fixes things; anna approved it.", error: null, limit: false }) });
  const { answer, steps } = await askWithSteps(felix, "summarize fm#101");
  assert.equal(calls.ask[0].model, PICKS.claude.deep);
  assert.deepEqual(steps, ["Checking GitHub", "Looking into it"]);
  assert.match(calls.ask[0].turn, /"pr fm#101"/);
  assert.equal(answer.chips[0].link, "https://github.com/purepm/frontend-monorepo/pull/101");
  await felix.ask("give me an overview of releases");
  assert.equal(calls.ask[1].model, PICKS.claude.deep);
});

test("eval: made-up facts are blocked, true ones pass", async () => {
  const cases = [
    { q: "is anyone on call later?", draft: "Anna Reyes takes over at 10 PM today.", ok: true },
    { q: "is anyone on call later?", draft: "Anna Reyes takes over at 9 PM.", ok: false },
    { q: "is anyone on call later?", draft: "Marco takes over at 10 PM today.", ok: false },
    { q: "how many of my PRs have conflicts?", draft: "Just 1, fm#103.", ok: true },
    { q: "how many of my PRs have conflicts?", draft: "Two of them: fm#103 and fm#105.", ok: false },
    { q: "when does my claude limit reset?", draft: "Your 5-hour limit resets today at 10 PM. You've used 42%.", ok: true },
    { q: "when does my claude limit reset?", draft: "It resets at midnight, and you've used 60%.", ok: false },
    { q: "who approved fm#101?", draft: "Anna approved it.", ok: true },
  ];
  for (const c of cases) {
    const { felix, calls } = setup({ draft: () => ({ text: c.draft, error: null, limit: false }) });
    const answer = await felix.ask(c.q);
    assert.equal(answer.text === c.draft, c.ok, `${c.q} -> ${c.draft}`);
    assert.equal(calls.log[0].ok, c.ok);
    if (!c.ok) assert.ok(calls.log[0].unmatched.length > 0);
  }
});

test("an answer the check catches gets one more try, told what didn't match", async () => {
  const drafts = ["Marco takes over at 10 PM today.", "Anna Reyes takes over at 10 PM today."];
  const { felix, calls } = setup({ draft: () => ({ text: drafts.shift(), error: null, limit: false }) });
  const { answer, steps } = await askWithSteps(felix, "is anyone on call later?");
  assert.equal(answer.text, "Anna Reyes takes over at 10 PM today.");
  assert.deepEqual(steps, ["Checking Datadog", "Looking into it", "Double-checking"]);
  assert.match(calls.ask[1].turn, /couldn't find these in the data: marco\. .*My question: is anyone on call later\?$/s);
  assert.equal(calls.log[0].drafts.length, 2);
  assert.equal(calls.log[0].ok, true);

  const retryFails = ["Marco takes over.", null];
  const broken = setup({ draft: () => { const text = retryFails.shift(); return text ? { text, error: null, limit: false } : { text: "", error: "Claude stopped", limit: false }; } });
  const blocked = await broken.felix.ask("is anyone on call later?");
  assert.match(blocked.text, /^Hmm, I couldn't double-check that/);
  assert.deepEqual(broken.calls.log[0].drafts, ["Marco takes over."]);
  assert.match(retryTurn("q?", "draft", ["a", "b"]), /^You were about to say: "draft"\n\nI couldn't find these in the data: a, b\. /);
});

test("Felix is told to sound like a friendly teammate, not a report", () => {
  assert.match(SYSTEM_PROMPT, /friendly buddy/);
  assert.match(SYSTEM_PROMPT, /Never sound like a report/);
  assert.match(SYSTEM_PROMPT, /made up; never use them/);
});

test("when Claude runs out, Cursor's same Claude model answers, unless that's turned off", async () => {
  const limited = () => ({ text: "", error: "limit", limit: true });
  const on = setup({ draft: limited });
  const { answer, steps } = await askWithSteps(on.felix, "is anyone on call later?");
  assert.deepEqual({ how: answer.how, by: answer.by }, { how: "claude-haiku-5-5-low", by: "claude-haiku-5-5-low (Cursor)" });
  assert.equal(answer.text, "Sonito Mole is on call.");
  assert.ok(steps.includes("Claude's out of usage, asking Cursor"));
  assert.equal(on.calls.cursor[0].text, on.calls.ask[0].turn);
  assert.equal(on.calls.cursor[0].model, "claude-haiku-5-5-low");

  const off = setup({ draft: limited, prefs: { felixCursorFallback: false } });
  const blocked = await off.felix.ask("is anyone on call later?");
  assert.match(blocked.text, /^Sorry, I couldn't get an answer just now\. Your Claude usage limit is reached/);
  assert.equal(off.calls.cursor.length, 0);

  const auto = setup({ draft: limited, prefs: { ...AUTO, felixCursorFallback: false } });
  assert.equal((await auto.felix.ask("summarize fm#101")).how, PICKS.cursor.deep);
});

test("an AI failure, or a question about something not connected, gets an honest answer", async () => {
  const broken = setup({ draft: () => ({ text: "", error: "Claude stopped", limit: false }) });
  assert.equal((await broken.felix.ask("is anyone on call later?")).text, "Sorry, I couldn't get an answer just now. Claude stopped");
  const silent = setup({ draft: () => ({ text: "", error: null, limit: false }) });
  assert.equal((await silent.felix.ask("is anyone on call later?")).text, "Sorry, I couldn't get an answer just now. The AI didn't reply.");

  const { felix, calls } = setup({ draft: () => ({ text: "I can't see Slack yet.", error: null, limit: false }) });
  const { answer, steps } = await askWithSteps(felix, "any new slack mentions?");
  assert.equal(answer.text, "I can't see Slack yet.");
  assert.equal(steps[0], "Getting ready");
  assert.match(calls.ask[0].turn, /No work data was read for this one/);
  assert.match(calls.ask[0].turn, /Not connected yet, so you can't see: Slack\./);
});

test("as an agent, the AI's tools show as steps, what they read backs up the answer, and its changes wait on cards", async () => {
  const cards = [];
  const steps = [];
  const ended = [];
  const gate = {
    begin: (sink) => {
      sink.onAsk({ id: "c1", title: "Run this command?", detail: "gh pr merge 1" });
      return () => ended.push(true);
    },
  };
  const workbench = { sync: async () => true, changes: async () => [{ path: "public/home.html", status: "changed" }] };
  const memory = {
    around: async (q) => (q.includes("Zorblat") ? "From your memory:\n# Zorblat\nOwns the payments service." : ""),
    snapshot: async () => new Map(),
    changedSince: async () => ["zorblat"],
  };
  const { felix } = setup({ prefs: {}, facts: fakeFacts() });
  const agent = createFelix({
    facts: fakeFacts(),
    brain: {
      ask: async (_model, turn, { onDelta, onTool }) => {
        assert.match(turn, /From your memory:\n# Zorblat/);
        onTool({ step: "Bash gh pr view 1" });
        onTool({ seen: "Quixotl approved it" });
        onDelta("Zorblat asked Quixotl, who approved it. ");
        return { text: "Zorblat asked Quixotl, who approved it.", error: null, limit: false };
      },
      askCursor: async () => ({ text: "", error: null, limit: false }),
      warm: () => {},
    },
    actions: {},
    settings: { get: async () => PREFS },
    gate,
    workbench,
    memory,
    timeZone: TZ,
    now: () => NOW,
    random: () => 0,
  });
  const answer = await agent.ask("did Zorblat get a review?", { onProgress: (s) => steps.push(s), onText: () => {}, onAsk: (c) => cards.push(c) });
  assert.equal(answer.text, "Zorblat asked Quixotl, who approved it.");
  assert.deepEqual(cards, [{ id: "c1", title: "Run this command?", detail: "gh pr merge 1" }]);
  assert.ok(steps.includes("Bash gh pr view 1"));
  assert.deepEqual(ended, [true]);
  assert.deepEqual(answer.changes, [{ path: "public/home.html", status: "changed" }]);
  assert.ok(answer.chips.some((c) => c.label === "Memory updated · zorblat"));
  assert.equal((await felix.ask("did Zorblat get a review?")).changes, undefined);
});

test("building or changing something is a deep question", () => {
  const route = { prs: [] };
  assert.equal(depthOf("add a weather widget to my home page", route), "deep");
  assert.equal(depthOf("make the music bar smaller", route), "deep");
  assert.equal(depthOf("who's on call", route), "quick");
});

test("Felix's rules for a new session carry its memory rules and index", () => {
  assert.match(rulesWith(""), /Your memory is empty so far\./);
  assert.match(rulesWith("[[anna]]: reviews fm"), /Your memory's index right now:\n\[\[anna\]\]: reviews fm/);
  assert.match(rulesWith(""), /never live work data/);
  assert.match(SYSTEM_PROMPT, /needs their yes/);
});

test("warming starts the Claude models Felix may pick, only when Felix is on and Claude is in use", async () => {
  const warmed = async (prefs, pastLimit) => {
    const { felix, calls } = setup({ prefs, pastLimit });
    await felix.warm();
    return calls.warm;
  };
  assert.deepEqual(await warmed({}), ["haiku"]);
  assert.deepEqual(await warmed(AUTO), [PICKS.claude.quick, PICKS.claude.deep]);
  assert.deepEqual(await warmed(AUTO, true), []);
  assert.deepEqual(await warmed({ felixOn: false }), []);
  assert.deepEqual(await warmed({ felixTool: "cursor", felixModel: "composer-2.5-fast" }), []);
});

test("a Cursor model picked in Settings answers through Cursor, never Claude", async () => {
  const { felix, calls } = setup({ prefs: { felixTool: "cursor", felixModel: "composer-2.5" } });
  const answer = await felix.ask("is anyone on call later?");
  assert.deepEqual({ how: answer.how, text: answer.text }, { how: "composer-2.5", text: "Sonito Mole is on call." });
  assert.equal(calls.ask.length, 0);
  assert.equal(calls.cursor[0].model, "composer-2.5");
  assert.match(calls.cursor[0].text, /^It's [\s\S]*Data read just now[\s\S]*My question: is anyone on call later\?$/);
});

test("Cursor's second try names the first turn, for when Cursor didn't see it", async () => {
  const drafts = ["Marco takes over at 10 PM today.", "Anna Reyes takes over at 10 PM today."];
  const { felix, calls } = setup({ prefs: { felixTool: "cursor", felixModel: "composer-2.5-fast" }, cursor: () => ({ text: drafts.shift(), error: null, limit: false }) });
  assert.equal((await felix.ask("is anyone on call later?")).text, "Anna Reyes takes over at 10 PM today.");
  assert.equal(calls.cursor[0].before, "");
  assert.equal(calls.cursor[1].before, calls.cursor[0].text);
  assert.match(calls.cursor[1].text, /^You were about to say: "Marco/);
});

test("Felix remembers the conversation: each question carries a recap, and a follow-up reads the PR it's about", async () => {
  const { felix, calls } = setup({ draft: () => ({ text: "fm#101 adds and fixes things; anna approved it.", error: null, limit: false }) });
  await felix.ask("who's on call?");
  await felix.ask("summarize fm#101");
  assert.match(calls.ask[0].turn, /What we just talked about[\s\S]*Me: who's on call\?\nYou: [\s\S]*Data read just now/);
  await felix.ask("and who approved it?");
  const followUp = calls.ask.at(-1).turn;
  assert.match(followUp, /Me: summarize fm#101\nYou: fm#101 adds and fixes things; anna approved it\./);
  assert.match(followUp, /"pr fm#101"/);
});

test("warming opens Cursor's session only when Cursor would answer", async () => {
  const warmed = async (prefs, pastLimit = false) => {
    let cursor = 0;
    const brain = { warm: () => {}, warmCursor: () => { cursor += 1; }, pastLimit: () => pastLimit };
    await createFelix({ facts: fakeFacts(), brain, actions: {}, settings: { get: async () => ({ ...PREFS, ...prefs }) }, timeZone: TZ }).warm();
    return cursor;
  };
  assert.equal(await warmed({ felixTool: "cursor", felixModel: "auto" }), 1);
  assert.equal(await warmed(AUTO, true), 1);
  assert.equal(await warmed(AUTO), 0);
  assert.equal(await warmed({}), 0);
});

test("each answer names who answered: the model, or this Mac for a local command", async () => {
  const { felix } = setup({ prefs: { felixModel: "sonnet" } });
  assert.equal((await felix.ask("is anyone on call later?")).by, "sonnet");
  assert.equal((await felix.ask("who's on call?")).by, "On this Mac");
  assert.deepEqual([["opus", "claude"], ["composer-2.5", "cursor"], ["notyet", undefined]].map(([how, tool]) => answeredBy(how, tool)), ["opus", "composer-2.5 (Cursor)", "On this Mac"]);
  assert.equal(answeredBy("opus", "claude", (tool, model) => `${tool}:${model}`), "claude:opus");

  const named = createFelix({
    facts: fakeFacts(), brain: { ask: async () => ({ text: "Okay.", error: null, limit: false }) }, actions: {},
    settings: { get: async () => PREFS }, now: () => NOW, random: () => 0, timeZone: TZ, modelName: (tool, model) => `${model.toUpperCase()} via ${tool}`,
  });
  assert.equal((await named.ask("is anyone on call later?")).by, "HAIKU via claude");
});

test("questions that need thought are deep; the rest are quick", () => {
  const depth = (text) => depthOf(text, routeQuestion(text));
  assert.deepEqual(["summarize fm#101", "why is the release late?", "what does bm#7 change?", "should I merge first?", "compare fm#1 and fm#2"].map(depth), Array(5).fill("deep"));
  assert.deepEqual(["is anyone on call later?", "what's fm#101's status?", "any PRs waiting on me?"].map(depth), Array(3).fill("quick"));
});

test("Felix picks the tool and model: Claude while the plan has room, Cursor past it, and the depth's model on Auto", () => {
  assert.deepEqual(pickModel(AUTO, "quick", false), { tool: "claude", model: PICKS.claude.quick });
  assert.deepEqual(pickModel(AUTO, "deep", false), { tool: "claude", model: PICKS.claude.deep });
  assert.deepEqual(pickModel(AUTO, "quick", true), { tool: "cursor", model: PICKS.cursor.quick });
  assert.deepEqual(pickModel({ ...AUTO, felixModel: "haiku" }, "deep", true), { tool: "cursor", model: PICKS.cursor.deep });
  assert.deepEqual(pickModel({ felixTool: "claude", felixModel: "auto" }, "deep", true), { tool: "claude", model: PICKS.claude.deep });
  assert.deepEqual(pickModel({ felixTool: "claude", felixModel: "fable" }, "quick", false), { tool: "claude", model: "fable" });
  assert.deepEqual(pickModel({ felixTool: "cursor", felixModel: "gpt-5.6-sol-medium" }, "deep", false), { tool: "cursor", model: "gpt-5.6-sol-medium" });
  assert.deepEqual(["haiku", "sonnet", "opus"].map((m) => onCursor(m, "quick")), ["claude-haiku-5-5-low", "claude-sonnet-5-5-medium", "claude-opus-5-5-medium"]);
  assert.equal(onCursor("fable", "deep"), PICKS.cursor.deep);
});

test("Auto answers quick questions with Claude's quick model and summaries with its deep one", async () => {
  const { felix, calls } = setup({ prefs: AUTO, draft: () => ({ text: "Anna Reyes is on call next.", error: null, limit: false }) });
  const quick = await felix.ask("is anyone on call later?");
  assert.deepEqual({ how: quick.how, by: quick.by }, { how: PICKS.claude.quick, by: PICKS.claude.quick });
  await felix.ask("summarize fm#101");
  assert.deepEqual([...new Set(calls.ask.map((c) => c.model))], [PICKS.claude.quick, PICKS.claude.deep]);
  assert.equal(calls.cursor.length, 0);
});

test("Auto switches to Cursor once a Claude limit is used up, so nothing is billed as extra usage", async () => {
  const full = structuredClone(USAGE);
  full.tools[0].limits[1].percent = 100;
  for (const opts of [{ facts: fakeFacts([], { usage: full }) }, { pastLimit: true }]) {
    const { felix, calls } = setup({ prefs: AUTO, ...opts });
    const { answer, steps } = await askWithSteps(felix, "is anyone on call later?");
    const how = PICKS.cursor.quick;
    assert.deepEqual({ how: answer.how, by: answer.by, text: answer.text }, { how, by: `${how} (Cursor)`, text: "Sonito Mole is on call." });
    assert.equal(calls.ask.length, 0);
    assert.ok(steps.includes(`Claude's plan is used up, so ${how} (Cursor) is answering`));
  }
  const picked = setup({ prefs: { felixTool: "claude", felixModel: "sonnet" }, pastLimit: true });
  assert.equal((await picked.felix.ask("is anyone on call later?")).how, "sonnet");
});

test("whether Claude's plan is used up, from the AI usage card", () => {
  const fact = (limits) => ({ record: { tools: [{ tool: "Claude", limits }] } });
  assert.equal(claudeUsedUp(fact([{ percentUsed: 42 }, { percentUsed: 100 }])), true);
  assert.equal(claudeUsedUp(fact([{ percentUsed: 99 }])), false);
  assert.equal(claudeUsedUp({ error: "down" }), false);
  assert.equal(claudeUsedUp(null), false);
});

test("the reply is shown a checked sentence at a time as it's written", async () => {
  const { felix } = setup({ draft: () => ({ text: "Sonito Mole has it until 10 PM today. Then Anna Reyes takes over.", error: null, limit: false }) });
  const { answer, shown } = await askWithSteps(felix, "is anyone on call later?");
  assert.deepEqual(shown, ["Sonito Mole has it until 10 PM today. "]);
  assert.ok(answer.text.startsWith(shown.join("")));
});

test("a sentence the check catches isn't shown, and the second try carries on after what was shown", async () => {
  const drafts = ["Sonito Mole has it now. Marco takes over later. Bye.", " Anna Reyes takes over later. "];
  const turns = [];
  const { felix } = setup({ draft: (turn) => (turns.push(turn), { text: drafts.shift(), error: null, limit: false }) });
  const { answer, shown, steps } = await askWithSteps(felix, "is anyone on call later?");
  assert.deepEqual(shown, ["Sonito Mole has it now. ", "Anna Reyes takes over later. "]);
  assert.equal(answer.text, "Sonito Mole has it now. Anna Reyes takes over later.");
  assert.ok(steps.includes("Double-checking"));
  assert.match(turns.at(-1), /I've already shown this much: "Sonito Mole has it now\."/);
});

test("when the second try fails too, Felix keeps the sentences it already checked and showed", async () => {
  const drafts = ["Sonito Mole has it now. Marco takes over later.", "Marco again."];
  const { felix } = setup({ draft: () => ({ text: drafts.shift(), error: null, limit: false }) });
  assert.equal((await felix.ask("is anyone on call later?")).text, "Sonito Mole has it now.");
  const failing = [{ text: "Sonito Mole has it now. Marco takes over later.", error: null }, { text: "", error: "down" }];
  const quiet = setup({ draft: () => ({ ...failing.shift(), limit: false }) });
  assert.equal((await quiet.felix.ask("is anyone on call later?")).text, "Sonito Mole has it now.");
});

test("the second try picks up from what was shown, or starts over when nothing was", () => {
  assert.match(retryTurn("q?", "A. B.", ["b"], "A. "), /already shown this much: "A\."\n\nI couldn't find these in the data: b\. Carry on from where that ends/);
  assert.doesNotMatch(retryTurn("q?", "B.", ["b"]), /already shown/);
});

test("merge and review results read naturally", () => {
  assert.equal(mergedText("fm#1", { queued: true, position: 3, already: true }), "fm#1 was already in the merge queue.");
  assert.equal(mergedText("fm#1", { queued: true, position: null }), "fm#1 is in the merge queue.");
  assert.equal(mergedText("fm#1", { merged: true }), "Merged fm#1.");
  assert.match(reviewText("fm#1", "queued"), /^The review of fm#1 is queued/);
});

test("a message sent while Felix answers goes to his AI, and is logged when it's taken", async () => {
  const log = [];
  const steered = [];
  const make = (brain) => createFelix({ facts: fakeFacts(), brain, actions: {}, settings: { get: async () => PREFS }, log: (e) => log.push(e), timeZone: TZ });
  const felix = make({ steer: async (t) => steered.push(t) > 0 });
  assert.equal(await felix.steer("  and dark mode  "), true);
  assert.deepEqual(steered, ["and dark mode"]);
  assert.equal(log[0].steer, "and dark mode");
  assert.equal(await felix.steer("   "), false);
  assert.equal(await make({}).steer("hi"), false);
});

test("old data is called out in the chips, in what the AI sees, and in local answers", async () => {
  const facts = fakeFacts();
  const releases = await facts.read("releases");
  const oncall = await facts.read("oncall");
  assert.deepEqual(chipsFor([releases], TZ), [{ label: "GitHub releases · as of 10 minutes ago", link: "/prs/releases" }]);
  assert.equal(dataFor([releases]).releases.asOf, "10 minutes ago");
  assert.equal("asOf" in dataFor([oncall]).oncall, false);
  assert.equal(oldDataNote("Shipped.", [releases]), " That's as of 10 minutes ago.");
  assert.equal(oldDataNote("Shipped.", [oncall, releases]), " GitHub releases's info is as of 10 minutes ago.");
  assert.equal(oldDataNote("Shipped, as of 10 minutes ago.", [releases]), "");
  assert.equal(oldDataNote("Shipped.", [oncall]), "");
  const { felix } = setup({ facts: fakeFacts([], { usage: { ...USAGE, fetchedAt: "2026-10-29T11:40:00Z" } }) });
  const usage = await felix.ask("usage");
  assert.match(usage.text, / That's as of 20 minutes ago\.$/);
  assert.equal(usage.chips[0].label, "AI usage · as of 20 minutes ago");
});

test("the AI gets the style line from Settings, and may say the names in it", async () => {
  const { felix, calls } = setup({
    prefs: { felixName: "Max", felixYourName: "Cres", felixTone: "professional" },
    draft: () => ({ text: "Sure, Cres. Sonito Mole is on call until 10 PM today.", error: null, limit: false }),
  });
  const answer = await felix.ask("is anyone on call later?");
  assert.equal(answer.text, "Sure, Cres. Sonito Mole is on call until 10 PM today.");
  assert.match(calls.ask[0].turn, /^It's Thursday, Oct 29 at 8 PM\.\n\n\(Style for this reply; follow it, never repeat or mention it: you're Max \(the app is still called Felix\)\. Tone: polite/);
  assert.match(calls.ask[0].turn, /Their name is Cres;/);
  assert.deepEqual(calls.log[0].tone, []);
});

test("a reply that opens with filler is logged as a tone problem", async () => {
  const { felix, calls } = setup({ draft: () => ({ text: "Certainly! Sonito Mole is on call until 10 PM today.", error: null, limit: false }) });
  await felix.ask("is anyone on call later?");
  assert.deepEqual(calls.log[0].tone, ["opens with filler"]);
});

test("Felix answers to his new name and your activation phrase", async () => {
  const { felix } = setup({ prefs: { felixName: "Max", felixWake: "Yo buddy" } });
  assert.equal((await felix.ask("Max, who's on call?")).how, "oncall.now");
  assert.equal((await felix.ask("Yo buddy, who's on call?")).how, "oncall.now");
});

test("Felix's rules cover the way he talks", () => {
  for (const rule of [/contractions/, /The answer first/, /No robot filler/, /Read the room/, /never \"22:00\"/, /Shorten a long PR title/, /When unsure, ask/, /asOf/, /Style for this reply/]) {
    assert.match(SYSTEM_PROMPT, rule);
  }
});

/**
 * Felix whose AI changed a file in the workbench, with a test run that passes, fails or throws.
 * @param {{ ok: boolean, tail: string } | Error | null} run Null for a workbench that can't run tests.
 */
function builder(run) {
  const steps = [];
  const workbench = {
    sync: async () => true,
    changes: async () => [{ path: "felix.mjs", status: "changed" }],
    ...(run === null ? {} : { test: async () => { if (run instanceof Error) throw run; return run; } }),
  };
  const felix = createFelix({
    facts: fakeFacts(),
    brain: { ask: async () => ({ text: "Added the widget.", error: null, limit: false }), askCursor: async () => ({}), warm: () => {} },
    actions: {}, settings: { get: async () => PREFS }, workbench, timeZone: TZ, now: () => NOW, random: () => 0,
  });
  return { ask: (q) => felix.ask(q, { onProgress: (s) => steps.push(s) }), steps };
}

test("after a change in the workbench, Felix runs the tests there himself and says how they went", async () => {
  const green = builder({ ok: true, tail: "# pass 300" });
  const ok = await green.ask("add a weather widget");
  assert.equal(ok.text, "Added the widget. I ran the tests in my workbench, and they pass.");
  assert.deepEqual(ok.tests, { ok: true, tail: "# pass 300" });
  assert.equal(green.steps.at(-1), "Running the tests in my workbench");
  const red = await builder({ ok: false, tail: "# fail 2" }).ask("add a weather widget");
  assert.match(red.text, /they fail, so it isn't ready to apply yet\.$/);
  assert.equal(red.tests.ok, false);
  const broken = await builder(new Error("spawn ENOENT")).ask("add a weather widget");
  assert.deepEqual(broken.tests, { ok: false, tail: "The tests didn't run: spawn ENOENT" });
  const none = await builder(null).ask("add a weather widget");
  assert.equal(none.text, "Added the widget.");
  assert.equal(none.tests, undefined);
  assert.deepEqual([testsNote(undefined), testsNote({ ok: true })], ["", " I ran the tests in my workbench, and they pass."]);
});

test("Stop stops the AI's work, and is logged when something was working", async () => {
  const log = [];
  const make = (stop) => createFelix({
    facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {}, ...(stop ? { stop } : {}) },
    actions: {}, settings: { get: async () => PREFS }, log: (e) => log.push(e), now: () => NOW,
  });
  assert.equal(await make(async () => true).stop(), true);
  assert.equal(log[0].stopped, true);
  assert.equal(await make(async () => false).stop(), false);
  assert.equal(await make(null).stop(), false);
  assert.equal(log.length, 1);
});

test("undo the last apply asks first, then puts it back and says Felix is restarting", async () => {
  const undone = [];
  const make = (lastApply, undo = { ok: true, text: "Put back 1 file." }) => createFelix({
    facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} },
    actions: { lastApply, undoApply: async () => { undone.push(1); return undo; } },
    settings: { get: async () => PREFS }, now: () => Date.parse("2026-10-30T03:00:00Z"),
  });
  const felix = make(async () => ({ state: "ok", at: "2026-10-30T02:50:00Z", files: ["public/home.html"] }));
  const asked = await felix.ask("undo the last apply");
  assert.equal(asked.how, "undo.apply");
  assert.equal(asked.text, "Undo my change to public/home.html, from 10 minutes ago? Felix restarts after.");
  assert.equal(asked.confirm.label, "Undo it");
  const done = await felix.confirm(asked.confirm.id, true);
  assert.deepEqual([done.text, done.restarting], ["Put back 1 file.", true]);
  assert.equal(undone.length, 1);
  const refused = make(async () => ({ state: "ok", files: ["a", "b"] }), { ok: false, text: "I can't undo it cleanly." });
  const second = await refused.ask("put Felix back");
  assert.equal(second.text, "Undo my last change (2 files)? Felix restarts after.");
  const no = await refused.confirm(second.confirm.id, true);
  assert.deepEqual([no.text, no.restarting], ["I can't undo it cleanly.", undefined]);
  assert.equal((await make(async () => null).ask("undo your last change")).text, "There's no change of mine to undo.");
  assert.match((await make(async () => ({ state: "rolled-back" })).ask("revert the last apply")).text, /already put back/);
  const bare = createFelix({ facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} }, actions: {}, settings: { get: async () => PREFS } });
  assert.equal((await bare.ask("undo the last apply")).text, "There's no change of mine to undo.");
});

test("Felix's rules carry a short map of his own code and its conventions", () => {
  for (const rule of [/felix-guard\.mjs/, /settings-schema\.mjs/, /no npm packages/, /JSDoc/, /never colored left accent borders/, /\.\/prs test/, /99%/]) {
    assert.match(SYSTEM_PROMPT, rule);
  }
});

test("an AI that reads the style line back has it dropped from the stream and the answer", async () => {
  const echoed = "(Style for this reply; follow it, never repeat or mention it: you're Felix. Tone: casual.)\n\nSonito Mole is on call until 10 PM today.";
  const { felix } = setup({ draft: () => ({ text: echoed, error: null, limit: false }) });
  const shown = [];
  const answer = await felix.ask("is anyone on call later?", { onText: (t) => shown.push(t) });
  assert.equal(answer.text, "Sonito Mole is on call until 10 PM today.");
  assert.doesNotMatch(shown.join(""), /Style for this reply/);
});

test("the second try never talks about the first, which you never saw", async () => {
  assert.match(retryTurn("q?", "draft", ["a"]), /They never saw that draft, so don't mention it/);
  assert.match(retryTurn("q?", "A. B.", ["b"], "A. "), /don't apologize; just answer\. My question: q\?$/);
  let n = 0;
  const { felix } = setup({
    draft: () => (n++ === 0
      ? { text: "Zorblat Quixotl is on call.", error: null, limit: false }
      : { text: "My earlier answer was wrong. Sorry about that. Sonito Mole is on call until 10 PM today.", error: null, limit: false }),
  });
  const shown = [];
  const answer = await felix.ask("is anyone on call later?", { onText: (t) => shown.push(t) });
  assert.equal(answer.text, "Sonito Mole is on call until 10 PM today.");
  assert.doesNotMatch(shown.filter(Boolean).join(""), /earlier|Sorry/);
});

/**
 * Felix with a notes store over memory, an AI for answers and for learning, and the quiet-spell timer by hand.
 * @param {{ start?: object[], prefs?: object, learned?: string, pastLimit?: boolean }} [options]
 */
async function remembering({ start = [], prefs = {}, learned = '{"notes":[]}', pastLimit = false } = {}) {
  const { createNotes } = await import("../felix-notes.mjs");
  const notes = createNotes({ file: "n.json", now: () => NOW, timeZone: TZ, read: async () => JSON.stringify({ notes: start }), write: async () => {} });
  const turns = [];
  const once = [];
  const timers = [];
  const felix = createFelix({
    facts: fakeFacts(),
    brain: {
      ask: async (_m, turn) => { turns.push(turn); return { text: "Okay.", error: null, limit: false }; },
      askCursor: async () => ({ text: "Okay.", error: null, limit: false }),
      once: async (text, pick) => { once.push({ text, pick }); return { text: learned, error: null, limit: false }; },
      warm: () => {},
      pastLimit: () => pastLimit,
    },
    actions: {}, settings: { get: async () => ({ ...PREFS, ...prefs }) }, notes, timeZone: TZ, now: () => NOW, random: () => 0,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
  });
  return { felix, notes, turns, once, timers };
}

const MOCHI = { id: "m1", text: "You have a dog named Mochi.", quote: "my dog Mochi", kind: "person", scope: "personal", importance: 2, saidAt: "2026-10-12T02:00:00Z" };

test("each question carries the notes that fit it, dated, and the AI is told to be honest about memory", async () => {
  const { felix, turns } = await remembering({ start: [MOCHI] });
  await felix.ask("what should I get Mochi for her birthday?");
  assert.match(turns[0], /- Oct 12: You have a dog named Mochi\. \(their words: "my dog Mochi"\)/);
  assert.match(rulesWith(""), /you told me on Oct 12/);
  assert.match(rulesWith(""), /say you don't remember them telling you/);
});

test("Felix learns after a quiet spell, with the cheap model of the AI tool in use", async () => {
  const learned = JSON.stringify({ notes: [{ text: "You love hiking.", quote: "I love hiking", kind: "about" }] });
  const { felix, notes, once, timers } = await remembering({ learned, prefs: { felixMemoryAfter: 5 } });
  await felix.ask("I love hiking, any trail ideas?");
  await felix.ask("who's on call?");
  await new Promise((r) => setImmediate(r));
  assert.equal(timers.at(-1).ms, 300_000);
  assert.equal(await felix.learnNow(), 1);
  assert.deepEqual(once[0].pick, { tool: "claude", model: "haiku" });
  assert.match(once[0].text, /Me: I love hiking, any trail ideas\?/);
  assert.equal((await notes.live())[0].text, "You love hiking.");
  const cursor = await remembering({ prefs: { felixTool: "cursor" } });
  await cursor.felix.ask("I love hiking");
  await cursor.felix.learnNow();
  assert.deepEqual(cursor.once[0].pick, { tool: "cursor", model: "composer-2.5-fast" });
});

test("a failed learning step or learning switched off saves nothing", async () => {
  const off = await remembering({ prefs: { felixMemoryLearn: false } });
  await off.felix.ask("I love hiking");
  assert.equal(await off.felix.learnNow(), 0);
  assert.equal(off.once.length, 0);
  const { createNotes } = await import("../felix-notes.mjs");
  const failing = createFelix({
    facts: fakeFacts(), actions: {}, settings: { get: async () => PREFS }, now: () => NOW,
    notes: createNotes({ file: "x", read: async () => "{}", write: async () => {} }),
    brain: { ask: async () => ({ text: "Ok.", error: null }), askCursor: async () => ({}), once: async () => ({ text: "", error: "down" }), warm: () => {} },
    setTimer: () => 0, clearTimer: () => {},
  });
  await failing.ask("I love hiking");
  assert.equal(await failing.learnNow(), 0);
  assert.equal(await make().learnNow(), 0);
  assert.deepEqual(await make().tidyMemory(), { merged: 0, archived: 0 });
  /** Felix with no notes store. */
  function make() {
    return createFelix({ facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} }, actions: {}, settings: { get: async () => PREFS } });
  }
});

test("off the record, forget that, and what Felix knows about you", async () => {
  const { felix, notes, once } = await remembering({ start: [MOCHI] });
  const off = await felix.ask("Off the record, I'm thinking of quitting.");
  assert.equal(off.how, "haiku");
  assert.equal((await felix.ask("off the record")).how, "memory.offrecord");
  await felix.ask("I hate my commute");
  assert.equal((await felix.ask("back on the record")).how, "memory.onrecord");
  await felix.ask("I love hiking");
  assert.equal((await felix.ask("forget that")).text, "Okay, I won't remember that.");
  await felix.learnNow();
  assert.equal(once.length, 0, "everything said was off the record or forgotten, so there was nothing to learn");
  const about = await felix.ask("what do you know about me?");
  assert.equal(about.text, "Here's what I remember: you have a dog named Mochi (Oct 12). You can see, change or delete them under Memory in Settings.");
  const forget = await felix.ask("forget about Mochi");
  assert.equal(forget.text, "Forget this: You have a dog named Mochi?");
  assert.equal((await felix.confirm(forget.confirm.id, true)).text, "Forgotten.");
  assert.deepEqual(await notes.all(), []);
  assert.equal((await felix.ask("forget about Mochi")).text, "I don't have anything saved about \"Mochi\".");
  assert.match((await felix.ask("what do you remember about me")).text, /^I don't have anything saved about you yet/);
  const paused = await felix.ask("stop learning");
  assert.deepEqual(paused.settings, { felixMemoryLearn: false });
  assert.deepEqual((await felix.ask("start remembering again")).settings, { felixMemoryLearn: true });
  assert.equal(await felix.tidyMemory().then((r) => r.merged), 0);
});

test("forgetting several notes, and a greeting that asks about a dated thing once it's passed", async () => {
  const start = [
    { ...MOCHI, id: "a", text: "You have an interview with Acme.", quote: "interview with Acme", kind: "event", date: "2026-10-28", followUp: "How did the Acme interview go?" },
    { ...MOCHI, id: "b", text: "You prep for the Acme interview daily.", quote: "Acme prep" },
  ];
  const { felix } = await remembering({ start });
  const hello = await felix.ask("hi");
  assert.equal(hello.text, "Hey! How did the Acme interview go?");
  assert.equal((await felix.ask("hi")).text, "Hi! Ask me anything about your day.");
  const forget = await felix.ask("forget about the acme interview");
  assert.match(forget.text, /^Forget these 2: /);
  assert.equal((await felix.confirm(forget.confirm.id, true)).text, "Forgot all 2.");
  const bare = createFelix({ facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} }, actions: {}, settings: { get: async () => PREFS } });
  const nothing = await bare.ask("forget about tea");
  assert.match(nothing.text, /I don't have anything saved/);
  assert.equal((await bare.ask("forget that")).text, "There's nothing I've just noted to forget. Say what it's about, like \"forget my interview\".");
  assert.equal((await bare.ask("off the record")).how, "memory.offrecord");
  assert.equal((await bare.ask("on the record")).how, "memory.onrecord");
});

test("a command's words keep the casing you wrote them in", async () => {
  const { asWritten } = await import("../felix.mjs");
  assert.deepEqual(asWritten({ what: "mochi" }, "Forget about Mochi"), { what: "Mochi" });
  assert.deepEqual(asWritten({ what: "x y" }, "nothing like it"), { what: "x y" });
  assert.deepEqual(asWritten({ on: true }, "stop"), { on: true });
});

/**
 * Felix whose AI answers personal talk, recording the turns and models it was asked with.
 * @param {{ prefs?: object, reply?: object, notes?: object }} [options]
 */
function friendly({ prefs = {}, reply = { text: "That sounds like a lot. Want to talk about it?", error: null, limit: false }, notes } = {}) {
  const asked = [];
  const log = [];
  const reads = [];
  const facts = fakeFacts();
  const felix = createFelix({
    facts: { read: (n, a) => { reads.push(n); return facts.read(n, a); } },
    brain: { ask: async (model, turn, { onDelta } = {}) => { asked.push({ model, turn }); onDelta?.(reply.text); return reply; }, askCursor: async () => ({}), warm: () => {} },
    actions: {}, settings: { get: async () => ({ ...PREFS, felixModel: "auto", ...prefs }) }, log: (e) => log.push(e), now: () => NOW, timeZone: TZ, notes,
    setTimer: () => 0, clearTimer: () => {},
  });
  return { felix, asked, log, reads };
}

test("personal talk reads no work data, goes to the friend model, and carries the friend rules", async () => {
  const { felix, asked, reads, log } = friendly();
  const answer = await felix.ask("I had a rough day and I'm so tired");
  assert.equal(answer.text, "That sounds like a lot. Want to talk about it?");
  assert.deepEqual(reads, [], "no work card was read");
  assert.equal(asked[0].model, "sonnet");
  assert.match(asked[0].turn, /This is personal talk, not a work question/);
  assert.doesNotMatch(asked[0].turn, /Data read just now/);
  assert.equal(log[0].personal, true);
  const off = friendly({ prefs: { felixFriendOn: false, felixModel: "haiku" } });
  await off.felix.ask("I had a rough day and I'm so tired");
  // With friend mode off it isn't personal talk, and it doesn't sound like work either, so it reads nothing.
  assert.doesNotMatch(off.asked[0].turn, /This is personal talk/, "with friend mode off it isn't personal talk");
  assert.deepEqual(off.reads, [], "small talk reads no work card");
  assert.equal(off.asked[0].model, "haiku");
  const picked = friendly({ prefs: { felixFriendModel: "opus" } });
  await picked.felix.ask("my mom is in the hospital");
  assert.equal(picked.asked[0].model, "opus");
});

test("crisis wording shows the help message first, never goes in the log, and isn't learned", async () => {
  const { createNotes } = await import("../felix-notes.mjs");
  const notes = createNotes({ file: "n", read: async () => "{}", write: async () => {} });
  const once = [];
  const shown = [];
  const log = [];
  const felix = createFelix({
    facts: fakeFacts(),
    brain: {
      ask: async (_m, turn, { onDelta } = {}) => { assert.match(turn, /already showed them the crisis hotline message/); onDelta?.("I'm right here with you. "); return { text: "I'm right here with you.", error: null, limit: false }; },
      askCursor: async () => ({}), once: async (t) => { once.push(t); return { text: '{"notes":[]}', error: null }; }, warm: () => {},
    },
    actions: {}, settings: { get: async () => PREFS }, log: (e) => log.push(e), now: () => NOW, timeZone: TZ, notes, setTimer: () => 0, clearTimer: () => {},
  });
  const answer = await felix.ask("I don't want to be alive anymore", { onText: (t) => shown.push(t) });
  assert.equal(shown[0], `${CRISIS_TEXT}\n\n`);
  assert.equal(answer.text, `${CRISIS_TEXT}\n\nI'm right here with you.`);
  assert.equal(JSON.stringify(log).includes("alive"), false);
  assert.equal(log[0].question, "(kept private)");
  await felix.learnNow();
  assert.equal(once.length, 0);
  const failing = friendly({ reply: { text: "", error: "down", limit: false } });
  assert.equal((await failing.felix.ask("I want to die")).text, CRISIS_TEXT);
  assert.equal(failing.log[0].question, "(kept private)");
});

test("personal talk is learned unless Settings keep Felix to work only, and brings only personal notes", async () => {
  const { createNotes } = await import("../felix-notes.mjs");
  const start = [
    { id: "p", text: "You have a sister named Bea.", quote: "my sister Bea", kind: "person", scope: "personal", importance: 2, saidAt: "2026-10-12T02:00:00Z" },
    { id: "w", text: "You lead the Bea migration.", quote: "Bea migration", kind: "work", scope: "work", importance: 1, saidAt: "2026-10-12T02:00:00Z" },
  ];
  const make = (prefs) => {
    const notes = createNotes({ file: "n", read: async () => JSON.stringify({ notes: start }), write: async () => {} });
    const once = [];
    const turns = [];
    const felix = createFelix({
      facts: fakeFacts(),
      brain: { ask: async (_m, turn) => { turns.push(turn); return { text: "Aw.", error: null, limit: false }; }, askCursor: async () => ({}), once: async (t) => { once.push(t); return { text: '{"notes":[]}', error: null }; }, warm: () => {} },
      actions: {}, settings: { get: async () => ({ ...PREFS, ...prefs }) }, now: () => NOW, timeZone: TZ, notes, setTimer: () => 0, clearTimer: () => {},
    });
    return { felix, once, turns };
  };
  const all = make({});
  await all.felix.ask("I miss my sister Bea so much");
  assert.match(all.turns[0], /sister named Bea/);
  assert.doesNotMatch(all.turns[0], /Bea migration/);
  await all.felix.learnNow();
  assert.equal(all.once.length, 1);
  const workOnly = make({ felixFriendRemember: "work" });
  await workOnly.felix.ask("I miss my sister Bea so much");
  await workOnly.felix.learnNow();
  assert.equal(workOnly.once.length, 0);
});

test("in quiet hours, or with friend mode off, a greeting doesn't bring up a follow-up", async () => {
  const { createNotes } = await import("../felix-notes.mjs");
  const due = [{ id: "a", text: "You had an interview.", quote: "interview", kind: "event", scope: "personal", importance: 2, saidAt: "2026-10-20T02:00:00Z", date: "2026-10-28", followUp: "How did the interview go?" }];
  const make = (prefs, at) => createFelix({
    facts: fakeFacts(), brain: { ask: async () => ({}), askCursor: async () => ({}), warm: () => {} }, actions: {},
    settings: { get: async () => ({ ...PREFS, ...prefs }) }, now: () => at, timeZone: TZ, random: () => 0,
    notes: createNotes({ file: "n", now: () => at, read: async () => JSON.stringify({ notes: due }), write: async () => {} }),
  });
  const night = Date.parse("2026-10-30T15:00:00Z");
  assert.equal((await make({}, night).ask("hi")).text, "Hey! What can I do for you?");
  assert.equal((await make({ felixFriendOn: false }, NOW).ask("hi")).text, "Hey! What can I do for you?");
  assert.equal((await make({}, NOW).ask("hi")).text, "Hey! How did the interview go?");
});

test("naming a work source or a PR makes a message a work question", async () => {
  const { namesWork } = await import("../felix.mjs");
  assert.equal(namesWork("I'm stressed about the release", routeQuestion("I'm stressed about the release")), true);
  assert.equal(namesWork("I'm stressed about fm#12", routeQuestion("I'm stressed about fm#12")), true);
  assert.equal(namesWork("I'm stressed", routeQuestion("I'm stressed")), false);
});

/** Felix's facade over a real Personal store in memory. */
async function personalFacade() {
  const { createPersonal } = await import("../personal.mjs");
  const { createPersonalFelix } = await import("../felix-personal.mjs");
  const store = await createPersonal({ file: ":memory:" });
  return { store, personal: createPersonalFelix({ store, settings: { get: async () => ({}) } }) };
}

test("Personal commands answer here in either mode, flag the cards to load again, and keep a journal line out of the log", async () => {
  const { store, personal } = await personalFacade();
  const { felix, calls } = setup({ personal, prefs: { mode: "work" } });
  const added = await felix.ask("Felix, add eggs and milk to groceries");
  assert.deepEqual([added.how, added.text, added.personal], ["lists.add", "Added eggs and milk to Groceries.", true]);
  assert.deepEqual(store.items(store.lists()[0].id).map((i) => i.text), ["Eggs", "Milk"]);
  assert.equal(calls.ask.length, 0, "no AI");
  const noted = await felix.ask("note in my journal: Told Mama about the new job");
  assert.equal(noted.how, "journal.add");
  assert.equal(calls.log.at(-1).question, "(a journal line, kept private)");
  assert.ok(!JSON.stringify(calls.log).includes("new job"), "the line is only in the journal");
  // Without any lists of that name, the same words go to the AI as before.
  assert.notEqual((await felix.ask("add a comment to the PR")).how, "lists.add");
});

test("when the AI changes a Personal card with its tools, the answer says so, so the cards load again", async () => {
  const { store, personal } = await personalFacade();
  const { felix } = setup({
    personal,
    draft: () => { personal.addItems(store.lists()[1].id, "Sunscreen"); return { text: "Okay.", error: null, limit: false }; },
  });
  const answer = await felix.ask("pack something for the beach trip, you pick");
  assert.equal(answer.personal, true);
  const { felix: quiet } = setup({ personal });
  assert.equal((await quiet.ask("how's the release going")).personal, undefined);
});
