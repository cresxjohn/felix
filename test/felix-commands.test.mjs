import { test } from "node:test";
import assert from "node:assert/strict";
import { matchCommand, normalize, placeFor } from "../felix-commands.mjs";

test("what you said is tidied before matching", () => {
  assert.equal(normalize("Hey Felix, who’s on call?"), "who's on call");
  assert.equal(normalize("Felix  can you please   open settings!"), "open settings");
  assert.equal(normalize("pause the music please"), "pause the music");
  assert.equal(normalize("Thanks, Felix."), "thanks");
  assert.equal(normalize("Ok Kai, play", "kai"), "play");
});

test("common questions match their commands", () => {
  const cases = {
    "Who's on call?": "oncall.now",
    "who is the IC right now": "oncall.now",
    "who's next": "oncall.next",
    "Who takes over tonight?": "oncall.next",
    "who's on call tomorrow": "oncall.next",
    "When's my next shift?": "oncall.mine",
    "when am i on call": "oncall.mine",
    "What PRs need my review?": "prs.review",
    "what's waiting on me": "prs.review",
    "what's failing": "prs.failing",
    "any failing checks on my PRs": "prs.failing",
    "how are my PRs doing": "prs.mine",
    "How much Claude usage is left?": "usage",
    "usage": "usage",
    "what's playing": "music.now",
    "what song is this": "music.now",
    "hi": "greeting",
    "Hey Felix": "greeting",
    "thank you so much": "thanks",
    "what can you do": "help",
    "where did you get that from?": "sources",
  };
  for (const [said, intent] of Object.entries(cases)) assert.equal(matchCommand(said)?.intent, intent, said);
});

test("commands pick out their parts", () => {
  assert.deepEqual(matchCommand("Pause the music"), { intent: "music.control", slots: { action: "pause" } });
  assert.deepEqual(matchCommand("skip").slots, { action: "next" });
  assert.deepEqual(matchCommand("previous track").slots, { action: "previous" });
  assert.deepEqual(matchCommand("go back a song").slots, { action: "previous" });
  assert.deepEqual(matchCommand("resume").slots, { action: "play" });
  assert.deepEqual(matchCommand("turn off auto refresh").slots, { key: "autoRefresh", on: false });
  assert.deepEqual(matchCommand("turn fit to screen on").slots, { key: "fitToScreen", on: true });
  assert.deepEqual(matchCommand("turn autorefresh on").slots, { key: "autoRefresh", on: true });
  assert.deepEqual(matchCommand("switch to personal").slots, { mode: "personal" });
  assert.deepEqual(matchCommand("work mode").slots, { mode: "work" });
  assert.deepEqual(matchCommand("open the workspace").slots, { mode: "work" });
  assert.deepEqual(matchCommand("open workspace").slots, { mode: "work" });
  assert.deepEqual(matchCommand("work space").slots, { mode: "work" });
  assert.deepEqual(matchCommand("merge fm#12247"), { intent: "merge", slots: { repo: "fm", number: "12247" } });
  assert.deepEqual(matchCommand("review bm 88 with cursor").slots, { repo: "bm", number: "88", tool: "cursor" });
  assert.deepEqual(matchCommand("review fm#5").slots.tool, "claude");
  assert.deepEqual(matchCommand("Start my day"), { intent: "shift", slots: { action: "start" } });
  assert.equal(matchCommand("wrap up my day"), null, "it goes to the AI, with every connected source");
  assert.deepEqual(matchCommand("show my PRs with conflicts"), { intent: "navigate", slots: { route: "/prs/mine?status=conflict", name: "your PRs with conflicts" } });
});

test("anything else is left for the AI", () => {
  for (const said of ["work", "open the pod bay doors", "summarize fm#12247", "", "what did anna say on fm#101"]) assert.equal(matchCommand(said), null, said);
});

test("places are found by how you name them", () => {
  const cases = {
    home: "/",
    "the dashboard": "/",
    "my prs": "/prs/mine",
    "open prs": "/prs/mine",
    "failing prs": "/prs/mine?status=failing",
    "prs ready to merge": "/prs/mine?status=ready-merge",
    "prs waiting on me": "/prs/review",
    "my reviews": "/prs/review",
    releases: "/prs/releases",
    settings: "/settings",
    "music settings": "/settings#music",
    "fm#12247": "/prs/mine?pr=fm-12247",
  };
  for (const [name, route] of Object.entries(cases)) assert.equal(placeFor(name)?.route, route, name);
  assert.equal(placeFor("bm 7").name, "bm#7");
  assert.equal(placeFor("narnia"), null);
});

test("Felix answers to the name and activation phrase set in Settings", () => {
  assert.equal(normalize("Max, who's on call?", "Max"), "who's on call");
  assert.equal(normalize("Hey Max who's on call", "Max"), "who's on call");
  assert.equal(normalize("Yo buddy, who's on call?", "Max", "Yo buddy!"), "who's on call");
  assert.equal(normalize("who's on call, Max?", "Max", "Yo buddy"), "who's on call");
  assert.equal(normalize("Hey (Felix) usage", "(Felix)"), "usage");
  assert.equal(normalize("felix usage", "  "), "usage");
  assert.deepEqual(matchCommand("Yo buddy, usage", "Max", "Yo buddy"), { intent: "usage", slots: {} });
  assert.equal(matchCommand("Yo buddy, usage", "Max"), null);
});

test("a merge or review that doesn't name the PR asks which one", () => {
  assert.deepEqual(matchCommand("Merge my PR"), { intent: "merge.which", slots: {} });
  assert.deepEqual(matchCommand("review a PR with cursor"), { intent: "review.which", slots: { tool: "cursor" } });
  assert.deepEqual(matchCommand("review my next pull request"), { intent: "review.which", slots: { tool: "claude" } });
  assert.equal(matchCommand("merge it"), null);
});

test("undoing Felix's last change to himself matches a few natural ways of saying it", () => {
  for (const said of ["Undo the last apply", "undo your last change", "revert the last apply", "undo the last change to Felix", "Put Felix back", "undo the change you applied", "rollback the last change"]) {
    assert.equal(matchCommand(said)?.intent, "undo.apply", said);
  }
  for (const said of ["undo the last commit", "rollback the release"]) assert.equal(matchCommand(said), null, said);
  assert.equal(matchCommand("undo that")?.intent, "undo", "a plain undo is the last thing Felix did here");
});

test("memory commands: what Felix knows, off the record, forgetting, and pausing learning", () => {
  const cases = {
    "What do you know about me?": "memory.about", "what do you remember about me": "memory.about", "what have you learned about me": "memory.about",
    "off the record": "memory.offrecord", "let's go off the record": "memory.offrecord", "back on the record": "memory.onrecord",
    "forget that": "memory.forgetlast", "forget what I just said": "memory.forgetlast", "don't remember that": "memory.forgetlast",
    "stop learning": "memory.pause", "pause your memory": "memory.pause", "start remembering again": "memory.resume", "turn on learning": "memory.resume",
  };
  for (const [said, intent] of Object.entries(cases)) assert.equal(matchCommand(said)?.intent, intent, said);
  assert.deepEqual(matchCommand("forget about my interview"), { intent: "memory.forget", slots: { what: "my interview" } });
  assert.deepEqual(matchCommand("forget what I told you about Acme"), { intent: "memory.forget", slots: { what: "acme" } });
});

test("tasks: add in plain words, hear what's due, and tick one off", () => {
  const m = (t) => matchCommand(t);
  assert.deepEqual(m("Add a task: Review fm#12247 tomorrow 3pm !high #review"), { intent: "tasks.add", slots: { scope: "", text: "review fm#12247 tomorrow 3pm !high #review" } });
  assert.deepEqual(m("hey felix, remind me to call Mom on Sat"), { intent: "tasks.add", slots: { scope: "", text: "call mom on sat" } });
  assert.deepEqual(m("add buy milk to my personal list"), { intent: "tasks.add", slots: { scope: "personal", text: "buy milk" } });
  assert.deepEqual(m("new personal task: pay rent Nov 5"), { intent: "tasks.add", slots: { scope: "personal", text: "pay rent nov 5" } });
  assert.equal(m("Add a reminder to renew the token").slots.text, "renew the token");
  for (const [said, when] of [["what tasks are due today?", "today"], ["what is on my list", "today"], ["show my tasks", "today"], ["any overdue tasks", "overdue"],
    ["what do I have to do tomorrow", "tomorrow"], ["show my upcoming tasks", "upcoming"], ["what tasks do I have", "today"], ["what's overdue", "overdue"]]) {
    assert.deepEqual(m(said), { intent: "tasks.list", slots: { when } }, said);
  }
  assert.deepEqual(m("mark prep demo notes as done"), { intent: "tasks.done", slots: { text: "prep demo notes" } });
  assert.deepEqual(m("tick off pay rent"), { intent: "tasks.done", slots: { text: "pay rent" } });
  assert.deepEqual(m("I'm done with the release notes"), { intent: "tasks.done", slots: { text: "the release notes" } });
  assert.equal(m("show my PRs with conflicts").intent, "navigate");
});

test("music commands: shuffle, repeat, playing something by name and searching Spotify", () => {
  const cases = {
    "shuffle on": ["music.shuffle", { on: true }],
    "turn on shuffle": ["music.shuffle", { on: true }],
    "shuffle the playlist": ["music.shuffle", { on: true }],
    "Felix, turn shuffle off": ["music.shuffle", { on: false }],
    "stop shuffling": ["music.shuffle", { on: false }],
    "don't shuffle": ["music.shuffle", { on: false }],
    "repeat this song": ["music.repeat", { mode: "track" }],
    "put this song on repeat": ["music.repeat", { mode: "track" }],
    "repeat the playlist": ["music.repeat", { mode: "context" }],
    "turn on repeat": ["music.repeat", { mode: "context" }],
    "repeat off": ["music.repeat", { mode: "off" }],
    "stop repeating": ["music.repeat", { mode: "off" }],
    "play my focus playlist": ["music.play", { query: "focus", kind: "playlist" }],
    "play the song blinding lights": ["music.play", { query: "blinding lights", kind: "track" }],
    "play hello by adele": ["music.play", { query: "hello adele", kind: "track" }],
    "Hey Felix, play my liked songs": ["music.play", { query: "my liked songs", kind: "any" }],
    "play lofi beats": ["music.play", { query: "lofi beats", kind: "any" }],
    "play some music": ["music.control", { action: "play" }],
    "search spotify for daft punk": ["music.search", { query: "daft punk" }],
    "search for daft punk on spotify": ["music.search", { query: "daft punk" }],
    "find the song get lucky": ["music.search", { query: "get lucky" }],
  };
  for (const [said, [intent, slots]] of Object.entries(cases)) assert.deepEqual(matchCommand(said), { intent, slots }, said);
  for (const said of ["play it", "repeat that", "search for the login bug", "repeat"]) assert.equal(matchCommand(said), null, said);
  assert.deepEqual(matchCommand("play").slots, { action: "play" });
});

test("the time and the date are answered on the Mac", () => {
  for (const q of ["What time is it?", "what's the time", "time?", "do you have the time"]) assert.deepEqual(matchCommand(q), { intent: "clock", slots: { what: "time" } }, q);
  for (const q of ["what's the date", "what day is it today?", "what's today's date"]) assert.deepEqual(matchCommand(q), { intent: "clock", slots: { what: "date" } }, q);
  assert.equal(matchCommand("what time is my next meeting")?.intent === "clock", false);
});

/** Your Personal cards' names, as felix.mjs passes them when matching. */
const KNOWN = {
  lists: ["Groceries", "Packing", "Wishlist"],
  items: [{ id: "i1", text: "Eggs", list: "Groceries" }, { id: "i2", text: "Milk", list: "Groceries" }, { id: "i3", text: "Sunscreen", list: "Packing" }],
  habits: [{ id: "h1", name: "Drink water" }, { id: "h2", name: "Read 10 pages" }, { id: "h3", name: "Exercise" }],
  dates: [{ id: "d1", title: "Mama's birthday", kind: "birthday" }, { id: "d2", title: "Trip to Baguio", kind: "event" }],
};
const said = (text) => matchCommand(text, "felix", "", KNOWN);

test("Personal: lists by voice: add, tick off, take off and hear a list you have", () => {
  assert.deepEqual(said("Felix, add eggs and milk to groceries"), { intent: "lists.add", slots: { list: "Groceries", items: "eggs and milk" } });
  assert.deepEqual(said("put sunscreen on my packing list"), { intent: "lists.add", slots: { list: "Packing", items: "sunscreen" } });
  assert.deepEqual(said("add a new phone case to the wish list").slots, { list: "Wishlist", items: "a new phone case" });
  assert.deepEqual(said("got the eggs"), { intent: "lists.tick", slots: { items: "the eggs", list: "" } });
  assert.deepEqual(said("I bought eggs and milk"), { intent: "lists.tick", slots: { items: "eggs and milk", list: "" } });
  assert.deepEqual(said("tick off sunscreen on packing"), { intent: "lists.tick", slots: { items: "sunscreen", list: "Packing" } });
  assert.deepEqual(said("remove milk from groceries"), { intent: "lists.remove", slots: { list: "Groceries", items: "milk" } });
  assert.deepEqual(said("what's on my groceries list"), { intent: "lists.show", slots: { list: "Groceries" } });
  assert.deepEqual(said("read me my packing list"), { intent: "lists.show", slots: { list: "Packing" } });
});

test("Personal: near-misses for lists stay tasks, other commands, or talk", () => {
  assert.equal(said("add a task to buy eggs").intent, "tasks.add");
  assert.equal(said("put eggs on my list").intent, "tasks.add", "\"my list\" is your task list");
  assert.equal(said("what's on my list").intent, "tasks.list");
  assert.equal(said("what's on my calendar").intent, "calendar.day");
  assert.equal(said("tick off the report").intent, "tasks.done", "not an item on any list");
  assert.equal(said("got milk on packing"), null, "milk isn't on Packing");
  for (const t of ["groceries were expensive", "add eggs to my shopping list", "add a comment to the PR", "I got promoted", "got it", "remove the label from the ticket"]) {
    assert.equal(said(t), null, t);
  }
  // With no Personal cards known, nothing personal matches at all.
  assert.equal(matchCommand("add eggs to groceries"), null);
  assert.equal(matchCommand("I drank water"), null);
});

test("Personal: habits tick by name, carefully, and never on \"didn't\"", () => {
  assert.deepEqual(said("I drank water"), { intent: "habits.check", slots: { ids: "h1", said: "drank water" } });
  assert.deepEqual(said("done with reading today"), { intent: "habits.check", slots: { ids: "h2", said: "reading" } });
  assert.deepEqual(said("I exercised this morning").slots.ids, "h3");
  assert.deepEqual(said("mark water as done").slots.ids, "h1");
  assert.deepEqual(said("how are my habits"), { intent: "habits.status", slots: {} });
  assert.deepEqual(said("what's my reading streak"), { intent: "habits.streak", slots: { what: "reading", ids: "h2" } });
  assert.deepEqual(said("what's my yoga streak"), { intent: "habits.streak", slots: { what: "yoga", ids: "" } }, "asks about a habit you don't have: say so");
  for (const t of ["I drank coffee", "I didn't exercise today", "I skipped water", "I think so", "I'm done with the report", "I read the news"]) {
    assert.notEqual(said(t)?.intent, "habits.check", t);
  }
  assert.equal(said("I'm done with the report").intent, "tasks.done");
});

test("Personal: the journal, important dates, time off and My day", () => {
  assert.deepEqual(said("note in my journal: long walk after dinner"), { intent: "journal.add", slots: { text: "long walk after dinner" } });
  assert.deepEqual(said("write in my journal that I called Lola"), { intent: "journal.add", slots: { text: "i called lola" } });
  assert.deepEqual(said("dear diary, the demo went well"), { intent: "journal.add", slots: { text: "the demo went well" } });
  assert.deepEqual(said("what's coming up"), { intent: "dates.upcoming", slots: {} });
  assert.deepEqual(said("any birthdays coming up"), { intent: "dates.upcoming", slots: {} });
  assert.deepEqual(said("when is Mama's birthday"), { intent: "dates.when", slots: { what: "mama's birthday" } });
  assert.deepEqual(said("when's mom's birthday"), { intent: "dates.when", slots: { what: "mom's birthday" } }, "a birthday you don't have: answer that it isn't saved");
  assert.deepEqual(said("how long until the trip to baguio"), { intent: "dates.when", slots: { what: "trip to baguio" } });
  assert.deepEqual(said("remind me Lola's birthday is November 3"), { intent: "dates.add", slots: { title: "lola's birthday", kind: "birthday", date: "november 3" } });
  assert.deepEqual(said("remember our anniversary is June 5, 2016"), { intent: "dates.add", slots: { title: "our anniversary", kind: "anniversary", date: "june 5, 2016" } });
  assert.deepEqual(said("remind me the concert is december 12"), { intent: "dates.add", slots: { title: "the concert", kind: "event", date: "december 12" } });
  assert.deepEqual(said("when's my next break"), { intent: "timeoff.next", slots: {} });
  assert.deepEqual(said("how many leave days have I used"), { intent: "timeoff.used", slots: {} });
  assert.deepEqual(said("how much PTO have I taken this year"), { intent: "timeoff.used", slots: {} });
  assert.deepEqual(said("what's the weather"), { intent: "myday.weather", slots: { when: "today", rain: false } });
  assert.deepEqual(said("will it rain tomorrow"), { intent: "myday.weather", slots: { when: "tomorrow", rain: true } });
  assert.deepEqual(said("is tomorrow a holiday"), { intent: "myday.holiday", slots: { day: "tomorrow" } });
  assert.deepEqual(said("when's the next holiday"), { intent: "myday.holiday", slots: { day: "next" } });
});

test("Personal: near-misses for dates and reminders keep their old meaning", () => {
  assert.equal(said("remind me to call Mom").intent, "tasks.add");
  assert.equal(said("remind me when CI passes on fm#12").intent, "watch.add");
  assert.equal(said("when is my next meeting").intent, "calendar.next");
  assert.equal(said("when's my next shift").intent, "oncall.mine");
  for (const t of ["when is the release", "remind me the meeting is at 3", "remember my password is hunter2", "note that down"]) assert.equal(said(t), null, t);
});

test("a ticked item can still be removed by voice, but isn't ticked twice", async () => {
  const { matchCommand } = await import("../felix-commands.mjs");
  const known = { lists: ["Groceries"], items: [{ id: "i1", text: "Eggs", list: "Groceries", done: true }], habits: [], dates: [] };
  assert.equal(matchCommand("remove eggs from groceries", undefined, undefined, known)?.intent, "lists.remove");
  assert.notEqual(matchCommand("got the eggs", undefined, undefined, known)?.intent, "lists.tick");
});

test("Wais: what's safe to spend and which bills are due, and near-misses that aren't", () => {
  for (const t of ["how much can I spend", "how much can I spend until payday", "what's my safe to spend", "safe to spend"]) assert.equal(said(t)?.intent, "wais.safe", t);
  for (const t of ["what bills are due", "any bills due this week", "which bills do I have to pay", "any late bills"]) assert.equal(said(t)?.intent, "wais.tasks", t);
  for (const t of ["how much can I spend on the team lunch budget", "the bills were high this month", "add a task to pay bills"]) assert.notEqual(said(t)?.intent?.startsWith("wais."), true, t);
  assert.equal(said("add a task to pay bills").intent, "tasks.add");
});

test("Felix moves around the app: PR lists with filters, a PR's tab, cards, outside places and the layout", async () => {
  const { matchCommand, linkFor } = await import("../felix-commands.mjs");
  const go = (said) => matchCommand(said)?.slots;
  assert.deepEqual(go("Show PRs waiting on me with failing checks"), { route: "/prs/review?status=failing", name: "the PRs waiting on your review with failing checks" });
  assert.deepEqual(go("show my PRs with conflicts and failing checks"), { route: "/prs/mine?status=failing,conflict", name: "your PRs with failing checks and with conflicts" });
  assert.equal(go("open my prs that are ready to merge").route, "/prs/mine?status=ready-merge");
  assert.equal(go("show prs waiting on my review that are ready to merge"), undefined, "ready to merge is only on your own PRs");
  assert.deepEqual(go("Open fm#12247's files"), { route: "/prs/mine?pr=fm-12247&panel=files", name: "fm#12247's files" });
  assert.equal(go("open the checks of bm 7001").route, "/prs/mine?pr=bm-7001&panel=checks");
  assert.equal(go("show fm 12247 ai review").route, "/prs/mine?pr=fm-12247&panel=claude");
  assert.equal(go("open fm 12247").route, "/prs/mine?pr=fm-12247");
  assert.equal(go("Go to Tasks").route, "/?card=here-tasks");
  assert.equal(go("go to my work tasks").route, "/?card=tasks");
  assert.equal(go("open my personal tasks").route, "/?card=ptasks");
  assert.equal(go("show my habits").route, "/?card=habits");
  assert.equal(go("go to wais").route, "/?card=bills");
  assert.equal(go("open my calendar").route, "/?card=cal");
  assert.notEqual(matchCommand("show my meetings")?.intent, "navigate", "a question about meetings is answered, not navigated");
  assert.equal(matchCommand("show my tasks").intent, "tasks.list", "the tasks list still answers");
  assert.equal(matchCommand("Edit the layout").intent, "layout");
  assert.equal(matchCommand("rearrange the cards").intent, "layout");
  assert.deepEqual(go("Open #incident-response"), { url: "https://slack.com/app_redirect?team=TRA9H4H8D&channel=incident-response", name: "#incident-response in Slack" });
  assert.equal(go("open the incident response channel").url, "https://slack.com/app_redirect?team=TRA9H4H8D&channel=incident-response");
  assert.match(go("Open the Datadog schedule").url, /on-call\/schedules\/1a2e4a4e-/);
  assert.equal(go("Open the Datadog schedule").name, "the Philippines on-call schedule in Datadog");
  assert.match(go("open the americas on-call schedule").url, /on-call\/schedules\/a39cd3b9-/);
  assert.match(go("open datadog").url, /\/on-call$/);
  assert.equal(linkFor("my schedule"), null, "a plain schedule is your calendar's business, not Datadog's");
  assert.equal(linkFor("the releases"), null);
});
