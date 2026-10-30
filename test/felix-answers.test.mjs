import { test } from "node:test";
import assert from "node:assert/strict";
import { ANSWERS, createSay, dueSaid, hourMeant, inOwnWords, listText, plural, shortTitle, spoken } from "../felix-answers.mjs";
import { createTasks } from "../tasks.mjs";
import { createFacts } from "../felix-facts.mjs";
import { CAL, IC, NOW, OOO, PRS, TZ, USAGE, fakeFacts, pr } from "./felix-fixtures.mjs";

/**
 * What the answers get: a reader, a wording picker that always takes the first choice left, and the last facts.
 * @param {{ read: Function }} [facts]
 * @param {object[]} [last]
 * @returns {import("../felix-answers.mjs").AnswerContext}
 */
const ctx = (facts = fakeFacts(), last = []) => ({ read: facts.read, say: createSay(() => 0), lastFacts: () => last, timeZone: TZ });

/**
 * A reader over just the data given.
 * @param {Record<string, object>} data
 * @returns {ReturnType<typeof createFacts>}
 */
const factsWith = (data) => createFacts({ readers: Object.fromEntries(Object.entries(data).map(([k, v]) => [k, async () => v])), now: () => NOW, timeZone: TZ });

const shift = (start, end, name, mine = false) => ({ start, end, user: { name }, mine });

test("wordings take turns and lists read naturally", () => {
  const say = createSay(() => 0);
  assert.deepEqual([say("k", ["a", "b", "c"]), say("k", ["a", "b", "c"]), say("k", ["a", "b", "c"])], ["a", "b", "a"]);
  assert.equal(say("one", ["only"]), "only");
  assert.equal(say("one", ["only"]), "only");
  assert.equal(typeof createSay()("x", ["a", "b"]), "string");
  assert.deepEqual([listText([]), listText(["a"]), listText(["a", "b"]), listText(["a", "b", "c"])], ["", "a", "a and b", "a, b and c"]);
  assert.deepEqual([plural(1, "PR"), plural(3, "PR")], ["1 PR", "3 PRs"]);
  assert.deepEqual([spoken("today at 10 PM"), spoken("tomorrow at 8 AM"), spoken("Mon, Nov 2 at 8 AM")], ["10 PM today", "8 AM tomorrow", "Mon, Nov 2 at 8 AM"]);
});

test("on-call answers say who, until when, and who's next", async () => {
  const now = await ANSWERS["oncall.now"](ctx());
  assert.equal(now.text, "Sonito Mole is on call until 10 PM today.");
  assert.equal(now.facts[0].source, "Datadog");
  assert.equal((await ANSWERS["oncall.next"](ctx())).text, "Anna Reyes takes over at 10 PM today.");
  assert.equal((await ANSWERS["oncall.mine"](ctx())).text, "Your next shift starts Mon, Nov 2 at 8 AM, in 4 days.");
});

test("on-call answers cover you, nobody, two schedules and Datadog being down", async () => {
  const yours = shift("2026-10-29T06:00:00Z", "2026-10-29T14:00:00Z", "Pat Cruz", true);
  const two = factsWith({
    oncall: {
      schedules: [{ name: "Web", shifts: [yours, shift("2026-10-29T14:00:00Z", "2026-10-30T00:00:00Z", "Anna Reyes")] }, { name: "API", shifts: [] }],
      myNext: { ...yours, schedule: "Web" },
    },
  });
  assert.equal((await ANSWERS["oncall.now"](ctx(two))).text, "You're on call on the Web schedule until 10 PM today. Hang in there! Nobody's on call on the API schedule right now.");
  assert.equal((await ANSWERS["oncall.next"](ctx(two))).text, "Anna Reyes takes over on the Web schedule at 10 PM today. Nobody's lined up after the current shift on the API schedule.");
  assert.equal((await ANSWERS["oncall.mine"](ctx(two))).text, "You're on call right now, until 10 PM today.");

  const nextIsYou = factsWith({ oncall: { schedules: [{ name: "Web", shifts: [shift("2026-10-29T14:00:00Z", "2026-10-30T00:00:00Z", "Pat Cruz", true)] }] } });
  assert.equal((await ANSWERS["oncall.next"](ctx(nextIsYou))).text, "You take over at 10 PM today.");
  assert.equal((await ANSWERS["oncall.mine"](ctx(nextIsYou))).text, "I don't see a shift coming up for you in Datadog. Enjoy!");

  const none = factsWith({ oncall: { schedules: [] } });
  assert.equal((await ANSWERS["oncall.now"](ctx(none))).text, "Datadog doesn't show any on-call schedules.");
  assert.equal((await ANSWERS["oncall.next"](ctx(none))).text, "Datadog doesn't show any on-call schedules.");

  const down = ctx(fakeFacts(["oncall"]));
  for (const intent of ["oncall.now", "oncall.next", "oncall.mine"]) {
    assert.match((await ANSWERS[intent](down)).text, /^Hmm, I couldn't reach Datadog just now, so I can't tell you .+\. \(oncall is down\)$/);
  }
});

test("PR answers count reviews, failures and your own PRs", async () => {
  assert.equal((await ANSWERS["prs.review"](ctx())).text, "Yep, 1 PR waiting on your review: bm#201 (Change 201).");
  assert.equal((await ANSWERS["prs.failing"](ctx())).text, "Heads up, fm#102 is failing lint and unit tests.");
  assert.equal((await ANSWERS["prs.mine"](ctx())).text, "You have 4 open PRs. 2 ready to merge, 1 with failing checks and 1 with conflicts.");
});

test("PR answers handle none, many and long titles", async () => {
  const many = Array.from({ length: 5 }, (_, i) => pr(400 + i, { requested: true, checks: { state: "failing", failing: [] }, title: i ? `Change ${i}` : "x".repeat(80) }));
  const busy = factsWith({ prs: { login: "me", lists: { mine: [{ key: "fm", prs: many }], review: [{ key: "fm", prs: many }] } } });
  const review = (await ANSWERS["prs.review"](ctx(busy))).text;
  assert.match(review, /^Yep, 5 PRs waiting on your review: fm#400 \(x{59}…\), fm#401 \(Change 1\), fm#402 \(Change 2\), and 2 more\.$/);
  assert.equal((await ANSWERS["prs.failing"](ctx(busy))).text, "Heads up, fm#400 is failing a check. fm#401 is failing a check. fm#402 is failing a check. 2 more PRs too.");
  assert.equal((await ANSWERS["prs.mine"](ctx(busy))).text, "You have 5 open PRs. 5 with failing checks.");

  const quiet = factsWith({ prs: { login: "me", lists: { mine: [{ key: "fm", prs: [pr(1)] }], review: [] } } });
  assert.match((await ANSWERS["prs.review"](ctx(quiet))).text, /review/);
  assert.match((await ANSWERS["prs.failing"](ctx(quiet))).text, /PRs|fine|failing/);
  assert.equal((await ANSWERS["prs.mine"](ctx(quiet))).text, "You have 1 open PR.");
  const empty = factsWith({ prs: { login: "me", lists: { mine: [], review: [] } } });
  assert.equal((await ANSWERS["prs.mine"](ctx(empty))).text, "You don't have any open PRs right now.");

  const down = ctx(fakeFacts(["prs"]));
  for (const intent of ["prs.review", "prs.failing", "prs.mine"]) assert.match((await ANSWERS[intent](down)).text, /^Hmm, I couldn't reach GitHub/);
});

test("usage and music answers read their cards", async () => {
  assert.equal((await ANSWERS.usage(ctx())).text, "Claude has used 42% of the 5-hour limit (resets 10 PM today) and 18% of the weekly limit. I couldn't read Cursor's usage.");
  const bare = factsWith({ usage: { tools: [{ name: "Cursor", limits: [] }] } });
  assert.equal((await ANSWERS.usage(ctx(bare))).text, "Cursor doesn't show any limits.");
  assert.equal((await ANSWERS.usage(ctx(factsWith({ usage: { tools: [] } })))).text, "I don't have any AI tools to check.");
  assert.match((await ANSWERS.usage(ctx(fakeFacts(["usage"])))).text, /^Hmm, I couldn't reach AI usage/);

  assert.equal((await ANSWERS["music.now"](ctx())).text, "Blue Song by The Band.");
  assert.equal((await ANSWERS["music.now"](ctx(factsWith({ music: { playing: true, track: { title: "Hum" } } })))).text, "Hum.");
  assert.match((await ANSWERS["music.now"](ctx(factsWith({ music: { playing: false } })))).text, /^Nothing's playing right now\./);
  assert.match((await ANSWERS["music.now"](ctx(fakeFacts(["music"])))).text, /^Hmm, I couldn't reach Spotify/);
  assert.equal(USAGE.tools.length, 2);
});

test("merging checks the PR is yours and ready, then asks first", async () => {
  const ready = await ANSWERS.merge(ctx(), { repo: "fm", number: "101" });
  assert.equal(ready.text, "Merge fm#101 (Change 101)?");
  assert.deepEqual(ready.confirm, { action: "merge", url: PRS.lists.mine[0].prs[0].url, ref: "fm#101", label: "Merge" });
  assert.equal((await ANSWERS.merge(ctx(), { repo: "fm", number: "104" })).text, "fm#104 is already in the merge queue.");
  assert.match((await ANSWERS.merge(ctx(), { repo: "fm", number: "102" })).text, /^fm#102 isn't ready to merge yet/);
  assert.match((await ANSWERS.merge(ctx(), { repo: "bm", number: "201" })).text, /^I can only merge your own open PRs/);
  assert.match((await ANSWERS.merge(ctx(fakeFacts(["prs"])), { repo: "fm", number: "101" })).text, /whether fm#101 can merge/);
});

test("reviews ask first, with the PR's link and the tool", () => {
  const claude = ANSWERS.review(ctx(), { repo: "bm", number: "88", tool: "claude" });
  assert.match(claude.text, /^Start a Claude review of bm#88\?/);
  assert.deepEqual(claude.confirm, { action: "review", url: "https://github.com/purepm/backend-monorepo/pull/88", ref: "bm#88", tool: "claude", label: "Start review" });
  assert.match(ANSWERS.review(ctx(), { repo: "fm", number: "1", tool: "cursor" }).text, /Cursor review/);
});

test("sources name where the last answer came from", async () => {
  assert.equal(ANSWERS.sources(ctx()).text, "That one didn't need anything looked up.");
  const facts = fakeFacts(["prs"]);
  const last = [await facts.read("oncall"), await facts.read("prs")];
  const out = ANSWERS.sources(ctx(facts, last));
  assert.equal(out.text, "That came from Datadog, read at 7:58 PM and GitHub, which didn't answer.");
  assert.equal(out.facts, last);
  assert.equal(IC.fetchedAt, "2026-10-29T11:58:00Z");
});

test("the simple commands answer and say what to do", async () => {
  const c = ctx();
  for (const intent of ["greeting", "thanks", "help"]) assert.ok((await ANSWERS[intent](c)).text.length > 3, intent);
  assert.deepEqual(ANSWERS["music.control"](c, { action: "pause" }), { text: "Paused.", music: "pause" });
  assert.deepEqual(ANSWERS["music.shuffle"](c, { on: false }), { text: "Shuffle's off.", music: { action: "shuffle", on: false } });
  assert.deepEqual(ANSWERS["music.shuffle"](c, {}).music, { action: "shuffle", on: true });
  assert.deepEqual(ANSWERS["music.repeat"](c, { mode: "track" }), { text: "Repeating this song.", music: { action: "repeat", mode: "track" } });
  assert.deepEqual(ANSWERS["music.repeat"](c, {}).music, { action: "repeat", mode: "context" });
  assert.deepEqual(ANSWERS["music.play"](c, { query: "focus", kind: "playlist" }), { text: "Finding focus.", music: { action: "find", query: "focus", kind: "playlist" } });
  assert.deepEqual(ANSWERS["music.play"](c, {}), { text: "Finding that.", music: { action: "find", query: "", kind: "any" } });
  assert.deepEqual(ANSWERS["music.search"](c, { query: "daft punk" }), { text: "Here's what Spotify has for daft punk.", music: { action: "search", query: "daft punk" } });
  assert.equal(ANSWERS["music.search"](c, {}).music.query, "");
  assert.deepEqual(ANSWERS["settings.toggle"](c, { key: "autoRefresh", on: false }), { text: "Auto refresh is off.", settings: { autoRefresh: false } });
  assert.deepEqual(ANSWERS["settings.toggle"](c, { key: "fitToScreen", on: true }), { text: "Fit to screen is on.", settings: { fitToScreen: true } });
  assert.deepEqual(ANSWERS.mode(c, { mode: "personal" }), { text: "Switched to Personal mode.", settings: { mode: "personal" } });
  assert.equal(ANSWERS.mode(c, { mode: "work" }).text, "Switched to Work mode.");
  assert.deepEqual(ANSWERS.navigate(c, { route: "/settings", name: "Settings" }), { text: "Opening Settings.", navigate: "/settings" });
  assert.match(ANSWERS.notyet(c, { what: "wrap up my day" }).text, /^"Wrap up my day" isn't built yet/);
});

test("long PR titles are cut at a word, the way a person would shorten them", () => {
  assert.equal(shortTitle("Short one"), "Short one");
  assert.equal(shortTitle("Add the bulk portal invite flow with retries, a run lock and claim-per-recipient", 40), "Add the bulk portal invite flow with…");
  assert.equal(shortTitle("x".repeat(70), 10), `${"x".repeat(9)}…`);
  assert.equal(shortTitle(undefined), "");
});

test("the common answers have at least three wordings, used in turn", async () => {
  const facts = fakeFacts();
  for (const intent of ["oncall.now", "oncall.next", "oncall.mine", "prs.review", "prs.failing", "prs.mine", "music.now", "greeting", "thanks"]) {
    const c = ctx(facts);
    const seen = new Set();
    for (let i = 0; i < 9; i++) seen.add((await ANSWERS[intent](c)).text);
    assert.ok(seen.size >= 2, intent);
  }
  const random = [0, 0.5, 0.99];
  const c = { ...ctx(), say: createSay(() => random.shift() ?? 0) };
  const said = new Set();
  for (let i = 0; i < 3; i++) said.add((await ANSWERS["oncall.now"](c)).text);
  assert.equal(said.size, 3);
});

test("a source that's down is said in more than one way, always with the reason", async () => {
  const c = ctx(fakeFacts(["oncall"]));
  const first = (await ANSWERS["oncall.now"](c)).text;
  const second = (await ANSWERS["oncall.now"](c)).text;
  assert.notEqual(first, second);
  for (const text of [first, second]) assert.match(text, /Datadog.*\(oncall is down\)$/);
});

test("merge my PR asks which one, unless only one could be meant", async () => {
  // fm#101 is the only one ready (fm#104 is already queued), so it's the one meant, and Felix asks before merging.
  const ready = await ANSWERS["merge.which"](ctx());
  assert.equal(ready.text, "Merge fm#101 (Change 101)?");
  assert.equal(ready.confirm.ref, "fm#101");
  const open = factsWith({ prs: { login: "me", lists: { mine: [{ key: "fm", prs: [1, 2, 3, 4, 5].map((n) => pr(n)) }], review: [] } } });
  const which = await ANSWERS["merge.which"](ctx(open));
  assert.equal(which.text, "Which one? fm#1 (Change 1), fm#2 (Change 2) or fm#3 (Change 3), or one of 2 more.");
  assert.equal(which.confirm, undefined);
  const two = factsWith({ prs: { login: "me", lists: { mine: [{ key: "fm", prs: [pr(7, { mergeState: "CLEAN" }), pr(8, { mergeState: "CLEAN" })] }], review: [] } } });
  assert.equal((await ANSWERS["merge.which"](ctx(two))).text, "Which one? fm#7 (Change 7) or fm#8 (Change 8).");
  const none = factsWith({ prs: { login: "me", lists: { mine: [{ key: "fm", prs: [pr(9, { isDraft: true })] }], review: [] } } });
  assert.equal((await ANSWERS["merge.which"](ctx(none))).text, "You don't have an open PR to merge right now.");
  assert.match((await ANSWERS["merge.which"](ctx(fakeFacts(["prs"])))).text, /GitHub/);
});

test("review a PR asks which one of those waiting on you, or asks before reviewing the only one", async () => {
  const only = await ANSWERS["review.which"](ctx(), { tool: "cursor" });
  assert.match(only.text, /^Start a Cursor review of bm#201\?/);
  assert.equal(only.confirm.ref, "bm#201");
  assert.equal(only.facts[0].source, "GitHub");
  const two = factsWith({ prs: { login: "me", lists: { mine: [], review: [{ key: "bm", prs: [pr(5, { requested: true }), pr(6, { requested: true })] }] } } });
  assert.equal((await ANSWERS["review.which"](ctx(two), { tool: "claude" })).text, "Which one? bm#5 (Change 5) or bm#6 (Change 6).");
  const none = factsWith({ prs: { login: "me", lists: { mine: [], review: [] } } });
  assert.match((await ANSWERS["review.which"](ctx(none), { tool: "claude" })).text, /^Nothing's waiting on your review\. Which PR did you mean\?/);
  assert.match((await ANSWERS["review.which"](ctx(fakeFacts(["prs"])), { tool: "claude" })).text, /GitHub/);
});

test("mode and setting changes say what they did in a few ways", () => {
  const c = ctx();
  const modes = new Set([0, 1, 2].map(() => ANSWERS.mode(c, { mode: "personal" }).text));
  assert.ok(modes.has("Switched to Personal mode."));
  assert.ok(modes.size >= 2);
  assert.equal(ANSWERS["settings.toggle"](c, { key: "fitToScreen", on: false }).text, "Fit to screen is off.");
});

test("tasks: added in your own words to the list for your mode, listed by when, ticked off by name", async () => {
  const at = new Date(2026, 9, 30, 9, 0).getTime();
  const tasks = await createTasks({ file: ":memory:", now: () => at });
  const c = (said, mode = "work") => ({ ...ctx(), tasks, said, mode, now: () => at });
  let r = ANSWERS["tasks.add"](c("Add a task: Review fm#12247 tomorrow 3pm !high #review"), { scope: "", text: "review fm#12247 tomorrow 3pm !high #review" });
  assert.equal(r.text, 'Added "Review fm#12247", for tomorrow at 3 PM, high priority.');
  assert.equal(r.tasks, true);
  r = ANSWERS["tasks.add"](c("remind me to call Mom", "work"), { scope: "personal", text: "call mom" });
  assert.equal(r.text, 'Added "call Mom", on your personal list.');
  assert.equal(tasks.list({ scope: "personal", view: "today" }).tasks[0].title, "call Mom");
  assert.match(ANSWERS["tasks.add"](c("add a task: !high"), { scope: "", text: "!high" }).text, /name/);
  ANSWERS["tasks.add"](c("add a task: Prep demo notes today 4pm"), { scope: "", text: "prep demo notes today 4pm" });
  ANSWERS["tasks.add"](c("add a task: Ship the release every week"), { scope: "", text: "ship the release every week" });

  assert.equal(ANSWERS["tasks.list"](c(""), { when: "today" }).text, "2 tasks for today: Ship the release and Prep demo notes (4 PM).");
  assert.equal(ANSWERS["tasks.list"](c(""), { when: "tomorrow" }).text, "1 task due tomorrow: Review fm#12247.");
  assert.equal(ANSWERS["tasks.list"](c(""), { when: "overdue" }).text, "Nothing's overdue. Nice!");
  assert.equal(ANSWERS["tasks.list"](c("", "personal"), { when: "upcoming" }).text, "Nothing coming up.");

  assert.equal(ANSWERS["tasks.done"](c(""), { text: "prep demo" }).text, 'Ticked off "Prep demo notes".');
  assert.equal(ANSWERS["tasks.done"](c(""), { text: "ship the release" }).text, 'Ticked off "Ship the release". The next one is Friday, Nov 6.'.replace("Friday, Nov 6", dueSaid(tasks.list({ view: "upcoming" }).tasks.find((t) => t.title === "Ship the release"), "2026-10-30")));
  assert.equal(ANSWERS["tasks.done"](c(""), { text: "nothing like this" }).text, 'I couldn\'t find an open task like "nothing like this".');
  ANSWERS["tasks.add"](c("add a task: Review fm#1"), { scope: "", text: "review fm#1" });
  assert.match(ANSWERS["tasks.done"](c(""), { text: "review" }).text, /^Which one\?/);
  assert.equal(ANSWERS["tasks.add"]({ ...c(""), tasks: undefined }, { scope: "", text: "x" }).text, "Tasks aren't set up on this Mac yet.");
  tasks.close();
});

test("task words keep your capitals, and due days read naturally", () => {
  assert.equal(inOwnWords("Hey Felix, add a task:  Review PMHUB-123", "review pmhub-123"), "Review PMHUB-123");
  assert.equal(inOwnWords("", "x"), "x");
  const today = "2026-10-30";
  assert.equal(dueSaid({ dueDate: null, dueTime: null }, today), "");
  assert.equal(dueSaid({ dueDate: "2026-10-29", dueTime: null }, today), "overdue since Oct 29");
  assert.equal(dueSaid({ dueDate: today, dueTime: "15:30" }, today), "today at 3:30 PM");
  assert.equal(dueSaid({ dueDate: "2026-11-02", dueTime: null }, today), "Monday");
  assert.equal(dueSaid({ dueDate: "2026-11-20", dueTime: "09:00" }, today), "Nov 20 at 9 AM");
});

/** What the calendar, Jira and out-of-office answers get, at the fixtures' moment. */
const at = (facts = fakeFacts()) => ({ ...ctx(facts), now: () => NOW });

test("'at 3' means the afternoon and 'at 9' the morning, unless you say AM or PM", () => {
  assert.deepEqual([hourMeant("3", ""), hourMeant("9", ""), hourMeant("12", ""), hourMeant("7", ""), hourMeant("3", "am"), hourMeant("11", "pm"), hourMeant("12", "am")],
    [15, 9, 12, 19, 3, 23, 0]);
});

test("the next meeting, with the one you're in now", async () => {
  assert.equal((await ANSWERS["calendar.next"](at())).text, "You're in Design sync until 8:15 PM. Your next meeting is Release review, 9 PM today, in 1 hour.");
  const none = factsWith({ calendar: { events: [] } });
  assert.equal((await ANSWERS["calendar.next"]({ ...at(none) })).text, "Nothing else on your calendar for the next few days.");
  const onlyNow = factsWith({ calendar: { events: [CAL.events[0]] } });
  assert.match((await ANSWERS["calendar.next"](at(onlyNow))).text, /until 8:15 PM\. Nothing after that\.$/);
  assert.match((await ANSWERS["calendar.next"](at(fakeFacts(["calendar"])))).text, /Google Calendar/);
});

test("am I free: what's on at that time, or yes; all-day events don't count", async () => {
  assert.equal((await ANSWERS["calendar.free"](at(), { day: "today", hour: "9", minute: "15", half: "pm" })).text, "No, you've got Release review then, 9 PM today until 9:30 PM.");
  assert.equal((await ANSWERS["calendar.free"](at(), { day: "today", hour: "11", minute: "00", half: "pm" })).text, "Yes, you're free at 11 PM today.");
  assert.equal((await ANSWERS["calendar.free"](at(), { day: "tomorrow", hour: "9", minute: "05", half: "" })).text, "No, you've got Standup then, 9 AM tomorrow until 9:15 AM.");
  assert.match((await ANSWERS["calendar.free"](at(), { day: "tomorrow", hour: "2", minute: "00", half: "" })).text, /free at 2 PM tomorrow/);
  assert.match((await ANSWERS["calendar.free"](at(fakeFacts(["calendar"])), { day: "today", hour: "3", minute: "00", half: "" })).text, /whether you're free/);
});

test("what's on today or tomorrow", async () => {
  assert.equal((await ANSWERS["calendar.day"](at(), { day: "today" })).text, "3 meetings today: Design sync at 7:30 PM, Release review at 9 PM and Planning at 10 PM.");
  assert.equal((await ANSWERS["calendar.day"](at(), { day: "tomorrow" })).text, "Just one tomorrow: Standup at 9 AM.");
  const busy = factsWith({ calendar: { events: [1, 2, 3, 4, 5].map((n) => ({ id: `b${n}`, title: `M${n}`, start: `2026-10-29T12:${n}0:00Z`, end: `2026-10-29T12:${n}5:00Z` })) } });
  assert.match((await ANSWERS["calendar.day"](at(busy), { day: "today" })).text, /^5 meetings today: M1 at 8:10 PM, M2 at 8:20 PM, M3 at 8:30 PM, and 2 more\.$/);
  assert.equal((await ANSWERS["calendar.day"](at(factsWith({ calendar: { events: [] } })), { day: "today" })).text, "Nothing on your calendar today.");
  assert.match((await ANSWERS["calendar.day"](at(fakeFacts(["calendar"])), { day: "today" })).text, /couldn't|isn't answering|didn't come through/);
});

test("answering an invite asks first: the next one, one at a time you name, or one by its title", async () => {
  const next = await ANSWERS["calendar.rsvp"](at(), { response: "declined", what: "next meeting", note: "I'm on call" });
  assert.equal(next.text, "Decline Release review, 9 PM today, with the note \"I'm on call\"?");
  assert.deepEqual(next.confirm, { action: "rsvp", eventId: "e1", response: "declined", note: "I'm on call", ref: "Release review", label: "Decline" });
  const timed = await ANSWERS["calendar.rsvp"](at(), { response: "accepted", what: "10 pm meeting", note: "" });
  assert.equal(timed.confirm.eventId, "e2");
  assert.equal(timed.confirm.label, "Accept");
  const named = await ANSWERS["calendar.rsvp"](at(), { response: "tentative", what: "standup", note: "" });
  assert.deepEqual([named.confirm.eventId, named.confirm.label, named.text], ["e3", "Maybe", "Say maybe to Standup, 9 AM tomorrow?"]);
  assert.equal((await ANSWERS["calendar.rsvp"](at(), { response: "accepted", what: "offsite", note: "" })).text, "I couldn't find \"offsite\" on your calendar.");
  const noReply = factsWith({ calendar: { ...CAL, canReply: false } });
  assert.match((await ANSWERS["calendar.rsvp"](at(noReply), { response: "accepted", what: "next meeting", note: "" })).text, /can't answer invites yet/);
  assert.match((await ANSWERS["calendar.rsvp"](at(fakeFacts(["calendar"])), { response: "accepted", what: "next meeting", note: "" })).text, /which meeting/);
});

test("what's on your plate in Jira", async () => {
  assert.equal((await ANSWERS["jira.mine"](at())).text, "You've got 2 open tickets: PMHUB-1 (Bulk invite retries), in progress; PMHUB-2 (Contact info search), to do.");
  const many = factsWith({ jira: { active: [1, 2, 3, 4].map((n) => ({ key: `X-${n}`, summary: `T${n}`, column: "To Do" })) } });
  assert.match((await ANSWERS["jira.mine"](at(many))).text, /X-3 \(T3\), to do, and 1 more\.$/);
  assert.equal((await ANSWERS["jira.mine"](at(factsWith({ jira: { active: [] } })))).text, "You don't have any open tickets in the sprint.");
  assert.match((await ANSWERS["jira.mine"](at(fakeFacts(["jira"])))).text, /Jira/);
});

test("who's out: your team on the day or week asked, with holidays", async () => {
  assert.equal((await ANSWERS["ooo.who"](at(), { when: "today" })).text, "Ana Cruz (VL) is out today. 1 person outside your team is out too.");
  assert.equal((await ANSWERS["ooo.who"](at(), { when: "tomorrow" })).text, "Ana Cruz (VL, today to tomorrow) and Ben Ramos (SL) are out tomorrow.");
  assert.equal((await ANSWERS["ooo.who"](at(), { when: "next week" })).text, "Cara Lim (PTO, Wed, Nov 4 to Thu, Nov 5) is out next week. There's a holiday then: All Saints' Day (PH Holiday).");
  assert.match((await ANSWERS["ooo.who"](at(), { when: "this week" })).text, /^Ana Cruz .* and Ben Ramos \(SL\) are out this week\. 1 person outside your team is out too\.$/);
  const empty = factsWith({ ooo: { ...OOO, out: [] } });
  assert.equal((await ANSWERS["ooo.who"](at(empty), { when: "someday" })).text, "Nobody on your team is out someday.");
  const others = factsWith({ ooo: { ...OOO, out: [OOO.out[2], { ...OOO.out[2], name: "Two" }] } });
  assert.equal((await ANSWERS["ooo.who"](at(others), { when: "today" })).text, "Nobody on your team is out today. 2 people outside your team are out too.");
  const noTeamEmpty = factsWith({ ooo: { out: [], teamSize: 0 } });
  assert.equal((await ANSWERS["ooo.who"](at(noTeamEmpty), { when: "today" })).text, "Everyone's in today.");
  const noTeam = factsWith({ ooo: { ...OOO, teamSize: 0 } });
  assert.match((await ANSWERS["ooo.who"](at(noTeam), { when: "today" })).text, /Someone Else/);
  const twoHolidays = factsWith({ ooo: { out: [{ ...OOO.out[3] }, { ...OOO.out[3], note: "Day after" }] } });
  assert.match((await ANSWERS["ooo.who"](at(twoHolidays), { when: "next week" })).text, /There are holidays then: .+ and .+\.$/);
  assert.match((await ANSWERS["ooo.who"](at(fakeFacts(["ooo"])), { when: "today" })).text, /Team out of office/);
});

test("the clock answers in your time zone", () => {
  const at = Date.parse("2026-10-30T05:05:00Z");
  assert.deepEqual(ANSWERS.clock({ now: () => at, timeZone: "Asia/Manila" }, { what: "time" }), { text: "It's 1:05 PM on Friday." });
  assert.deepEqual(ANSWERS.clock({ now: () => at, timeZone: "Asia/Manila" }, { what: "date" }), { text: "It's Friday, October 30." });
});

// ---------- Personal cards ----------

/**
 * A Personal context: a real store in memory (9 AM Friday Oct 30, 2026, Manila), Felix's facade over it, and fixed
 * time off and My day answers.
 * @param {{ timeoff?: Function, myday?: Function }} [o]
 */
async function personalCtx(o = {}) {
  process.env.TZ = "Asia/Manila";
  const { createPersonal } = await import("../personal.mjs");
  const { createPersonalFelix } = await import("../felix-personal.mjs");
  const store = await createPersonal({ file: ":memory:", now: () => Date.parse("2026-10-30T01:00:00Z") });
  const personal = createPersonalFelix({
    store, settings: { get: async () => ({}) },
    timeOff: { view: o.timeoff || (async () => ({ needsMe: true, people: [] })) },
    myDay: { view: o.myday || (async () => { throw new Error("offline"); }) },
  });
  const base = ctx();
  return { store, personal, at: (said) => ({ ...base, personal, said }) };
}

test("lists: adding keeps your words, ticking and taking off find the item, and a list reads out what's left", async () => {
  const { store, personal, at } = await personalCtx();
  const groceries = personal.listNamed("Groceries");
  const added = ANSWERS["lists.add"](at("Add eggs and Calamansi to groceries"), { list: "Groceries", items: "eggs and calamansi" });
  assert.deepEqual(added, { text: "Added eggs and calamansi to Groceries.", personal: true });
  assert.deepEqual(store.items(groceries.id).map((i) => i.text), ["Eggs", "Calamansi"], "a capital first letter, your own capitals kept");
  assert.equal(ANSWERS["lists.add"](at("add x to y"), { list: "Shopping", items: "x" }).text, "You don't have a Shopping list.");
  assert.equal(ANSWERS["lists.show"](at(""), { list: "Groceries" }).text, "Groceries has 2 things left: eggs and calamansi.");
  assert.deepEqual(ANSWERS["lists.tick"](at("got the eggs"), { items: "the eggs", list: "" }), { text: "Ticked off eggs.", personal: true });
  assert.equal(ANSWERS["lists.tick"](at("got bread"), { items: "bread", list: "" }).text, "I couldn't find bread on your lists.");
  assert.deepEqual(ANSWERS["lists.remove"](at("remove calamansi from groceries"), { items: "calamansi", list: "Groceries" }), { text: "Took calamansi off Groceries.", personal: true });
  assert.equal(ANSWERS["lists.show"](at(""), { list: "Groceries" }).text, "Everything on Groceries is ticked off.");
  assert.equal(ANSWERS["lists.show"](at(""), { list: "Packing" }).text, "Nothing on Packing yet.");
  // The same item on two lists: ask which.
  personal.addItems(groceries.id, "Water");
  personal.addItems(personal.listNamed("Packing").id, "Water");
  assert.equal(ANSWERS["lists.tick"](at("got water"), { items: "water", list: "" }).text, "Which water? Water on Groceries or Water on Packing.");
});

test("habits: a tick says the streak, a done habit isn't undone, several-times-a-day counts up, and status reads the day", async () => {
  const { store, at } = await personalCtx();
  const water = store.addHabit({ name: "Drink water" });
  const read = store.addHabit({ name: "Read", perDay: 2 });
  store.check(water.id, { day: "2026-10-29" });
  assert.deepEqual(ANSWERS["habits.check"](at("I drank water"), { ids: water.id }), { text: "Nice! Drink water is done for today, a 2-day streak.", personal: true });
  assert.deepEqual(ANSWERS["habits.check"](at("I drank water"), { ids: water.id }), { text: "Drink water is already done today, a 2-day streak." });
  assert.deepEqual(ANSWERS["habits.check"](at("did my reading"), { ids: read.id }), { text: "Read: 1 of 2 today.", personal: true });
  assert.equal(ANSWERS["habits.check"](at(""), { ids: `${water.id},${read.id}` }).text, "Which one? Drink water or Read.");
  assert.equal(ANSWERS["habits.status"](at("")).text, "1 of 2 done today: drink water. Still to go: read.");
  assert.equal(ANSWERS["habits.streak"](at(""), { what: "water", ids: water.id }).text, "Your drink water streak is 2 days.");
  assert.equal(ANSWERS["habits.streak"](at(""), { what: "reading", ids: read.id }).text, "No read streak yet. Tick it today to start one.");
  assert.equal(ANSWERS["habits.streak"](at(""), { what: "yoga", ids: "" }).text, "I don't see a habit like yoga.");
});

test("the journal gets your line added after what's there, and the reply doesn't repeat it", async () => {
  const { store, at } = await personalCtx();
  store.writeJournal("2026-10-30", { text: "Rainy morning." });
  const reply = ANSWERS["journal.add"](at("note in my journal: Long walk with Mama"), { text: "long walk with mama" });
  assert.deepEqual(reply, { text: "Added to today's journal.", personal: true });
  assert.equal(store.journalDay().entry.text, "Rainy morning.\nLong walk with Mama");
});

test("important dates: what's coming up, when one is with the age, and adding one with a plain confirmation", async () => {
  const { store, at } = await personalCtx();
  assert.match(ANSWERS["dates.upcoming"](at("")).text, /^You don't have any important dates yet/);
  store.addDate({ kind: "birthday", title: "Mama's birthday", month: 11, day: 3, year: 1966 });
  store.addDate({ kind: "event", title: "Trip to Baguio", month: 12, day: 20, year: 2026 });
  assert.equal(ANSWERS["dates.upcoming"](at("")).text, "Coming up: Mama's birthday in 4 days and Trip to Baguio in 51 days.");
  assert.equal(ANSWERS["dates.when"](at(""), { what: "mama's birthday" }).text, "Mama's birthday is on Tuesday, Nov 3, in 4 days. Turns 60.");
  assert.match(ANSWERS["dates.when"](at(""), { what: "mom's birthday" }).text, /^I don't have mom's birthday saved/);
  const added = ANSWERS["dates.add"](at("remind me Lola's birthday is November 3"), { title: "lola's birthday", kind: "birthday", date: "november 3" });
  assert.deepEqual(added, { text: "Got it: Lola's birthday, November 3. That's in 4 days.", personal: true });
  assert.match(ANSWERS["dates.add"](at("remind me Lola's birthday is November 3"), { title: "lola's birthday", kind: "birthday", date: "november 3" }).text, /^You already have Lola's birthday/);
  const trip = ANSWERS["dates.add"](at("remind me the concert is March 1"), { title: "the concert", kind: "event", date: "march 1" });
  assert.equal(trip.text, "Got it: Concert, March 1. That's in 122 days.", "a countdown with no year is the next March 1");
  assert.equal(store.datesView().all.find((d) => d.title === "Concert").year, 2027);
  assert.equal(ANSWERS["dates.add"](at(""), { title: "x", kind: "birthday", date: "feb 30" }).text, "I didn't catch the day. Try \"November 3\".");
});

test("time off: your next break, the days you've used, and plain words when it can't tell", async () => {
  const view = { needsMe: false, ahead: 180, next: { from: "2026-10-31", to: "2026-11-02", days: 3, inDays: 1, now: false, holidays: [{ day: "2026-11-02", name: "All Souls' Day" }], kinds: [] },
    year: { total: 7, kinds: [{ kind: "PTO", days: 5 }, { kind: "VL", days: 2 }] } };
  const { at } = await personalCtx({ timeoff: async () => view });
  assert.equal((await ANSWERS["timeoff.next"](at(""))).text, "Your next break is October 31 to November 2, tomorrow: 3 days off. It's for All Souls' Day.");
  assert.equal((await ANSWERS["timeoff.used"](at(""))).text, "You've taken 7 days off this year: 5 PTO and 2 VL.");
  view.next = { ...view.next, now: true, from: "2026-10-28" };
  assert.equal((await ANSWERS["timeoff.next"](at(""))).text, "You're on a break now. You're back on Tuesday, Nov 3.");
  view.next = null;
  view.year = { total: 0, kinds: [] };
  assert.equal((await ANSWERS["timeoff.next"](at(""))).text, "No break in the next 6 months.");
  assert.equal((await ANSWERS["timeoff.used"](at(""))).text, "You haven't taken any leave this year yet.");
  const pick = await personalCtx();
  assert.match((await ANSWERS["timeoff.next"](pick.at(""))).text, /^Pick yourself on the My time off card/);
  const down = await personalCtx({ timeoff: async () => { throw new Error("tracker down"); } });
  assert.equal((await ANSWERS["timeoff.used"](down.at(""))).text, "I can't reach the vacation tracker right now.");
});

test("My day: the weather today and tomorrow, rain in plain words, and holidays", async () => {
  const hours = [
    { time: "2026-10-30T20:00", temp: 27, sky: "Rain", rain: 70 },
    { time: "2026-10-31T09:00", temp: 25.2, sky: "Partly cloudy", rain: 10 },
    { time: "2026-10-31T13:00", temp: 31.4, sky: "Partly cloudy", rain: 30 },
    { time: "2026-10-31T18:00", temp: 28, sky: "Rain", rain: 40 },
  ];
  const weather = { place: "Manila", now: { time: "2026-10-30T19:45", temp: 28.4, sky: "Cloudy" }, today: { high: 31.2, low: 25.1, rain: 60 }, hours };
  const day = { today: "2026-10-30", weather, holidays: { today: [], next: { day: "2026-10-31", name: "All Saints' Day Eve" }, error: "" } };
  const { at } = await personalCtx({ myday: async () => day });
  assert.equal((await ANSWERS["myday.weather"](at(""), { when: "today", rain: false })).text, "It's 28° and cloudy in Manila. Today's high is 31°, low 25°, with a 60% chance of rain.");
  assert.equal((await ANSWERS["myday.weather"](at(""), { when: "today", rain: true })).text, "Likely: a 60% chance of rain today.");
  assert.equal((await ANSWERS["myday.weather"](at(""), { when: "tomorrow", rain: false })).text, "Tomorrow in Manila: 25° to 31°, mostly partly cloudy, up to a 40% chance of rain.");
  assert.equal((await ANSWERS["myday.weather"](at(""), { when: "tomorrow", rain: true })).text, "Maybe: up to a 40% chance of rain tomorrow.");
  assert.equal((await ANSWERS["myday.holiday"](at(""), { day: "tomorrow" })).text, "Yes, tomorrow is All Saints' Day Eve.");
  assert.equal((await ANSWERS["myday.holiday"](at(""), { day: "today" })).text, "No, today isn't a holiday. The next one is All Saints' Day Eve, Saturday, Oct 31.");
  assert.equal((await ANSWERS["myday.holiday"](at(""), { day: "next" })).text, "The next holiday is All Saints' Day Eve, Saturday, Oct 31, tomorrow.");
  weather.stale = true;
  assert.match((await ANSWERS["myday.weather"](at(""), { when: "today", rain: false })).text, /That's from a little while ago\.$/);
  const off = await personalCtx();
  assert.equal((await ANSWERS["myday.weather"](off.at(""), { when: "today", rain: false })).text, "I can't get the weather right now.");
  assert.equal((await ANSWERS["myday.holiday"](off.at(""), { day: "today" })).text, "I can't check the holidays right now.");
});

test("Personal answers say so plainly when the cards aren't here", async () => {
  for (const intent of ["lists.add", "lists.tick", "lists.remove", "lists.show", "habits.check", "habits.status", "habits.streak", "journal.add", "dates.upcoming", "dates.when", "dates.add", "timeoff.next", "timeoff.used", "myday.weather", "myday.holiday"]) {
    assert.equal((await ANSWERS[intent](ctx(), {})).text, "Your Personal cards aren't set up here.", intent);
  }
});

test("Wais: what's safe to spend says the period and a short day, and bills name the ones on Wais's card", async () => {
  const m = (amount) => ({ amount, formatted: `₱${amount.toLocaleString("en-US")}` });
  const answers = {
    safe_to_spend: { period: { id: "payday", label: "Until payday" }, payday: "2026-10-31", safeToSpend: m(18450), runsShortOn: "2026-11-14" },
    tasks: { count: 4, items: [
      { title: "Meralco", state: "today", days: 0, formatted: "-\u2060₱3,280", onCard: true },
      { title: "Globe Fiber", state: "late", days: -2, formatted: "₱1,699", onCard: true },
      { title: "Car insurance", state: "review", days: 5, formatted: "₱12,400", onCard: true },
      { title: "Netflix", state: "today", days: 0, formatted: "₱549", onCard: false },
    ] },
  };
  const wais = { call: async (tool) => answers[tool] };
  const at = { ...ctx(), wais };
  assert.equal((await ANSWERS["wais.safe"](at)).text, "You can safely spend ₱18,450 until payday on Saturday, Oct 31. Heads up: money runs short on Saturday, Nov 14.");
  answers.safe_to_spend = { period: { id: "30", label: "Next 30 days" }, safeToSpend: m(25000), runsShortOn: null };
  assert.equal((await ANSWERS["wais.safe"](at)).text, "You can safely spend ₱25,000 over the next 30 days.");
  assert.equal((await ANSWERS["wais.tasks"](at)).text, "4 bills to see to: Meralco, ₱3,280, today; Globe Fiber, ₱1,699, 2 days late; Car insurance, ₱12,400, in 5 days. And 1 more.");
  answers.tasks = { count: 0, items: [] };
  assert.equal((await ANSWERS["wais.tasks"](at)).text, "No bills to pay right now.");
  const down = { ...ctx(), wais: { call: async () => { throw new Error("Wais refused the token. It may have been revoked."); } } };
  assert.equal((await ANSWERS["wais.safe"](down)).text, "I couldn't reach Wais: Wais refused the token. It may have been revoked.");
  assert.equal((await ANSWERS["wais.tasks"](ctx())).text, "Wais isn't connected here.");
});

test("an outside place is opened with a chip to tap, and the layout says plainly what isn't built", async () => {
  const say = (_, lines) => lines[0];
  const link = await ANSWERS.link({ say }, { url: "https://slack.com/app_redirect?team=T&channel=incident-response", name: "#incident-response in Slack" });
  assert.deepEqual(link, { text: "Opening #incident-response in Slack.", link: { url: "https://slack.com/app_redirect?team=T&channel=incident-response", name: "#incident-response in Slack" } });
  const layout = await ANSWERS.layout({ say });
  assert.equal(layout.navigate, "/settings#home");
  assert.match(layout.text, /isn't built yet/);
});
