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
