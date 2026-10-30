import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createLearner, createNotes, dayOf, daysAround, hasSecret, learnPrompt, notesFrom, wordsOf } from "../felix-notes.mjs";

const NOW = Date.parse("2026-10-30T04:00:00Z");
const DAY = 24 * 3600e3;
const TZ = "Asia/Manila";

/**
 * A notes store over an in-memory file.
 * @param {object[]} [start] Notes already saved.
 * @param {{ now?: () => number }} [options]
 */
function store(start = [], { now = () => NOW } = {}) {
  const writes = [];
  const notes = createNotes({
    file: "notes.json", now, timeZone: TZ,
    read: async () => (start === null ? Promise.reject(new Error("missing")) : JSON.stringify({ notes: structuredClone(start) })),
    write: async (_f, text) => { writes.push(JSON.parse(text)); },
  });
  return { notes, writes };
}

/**
 * A note as saved.
 * @param {string} id
 * @param {string} text
 * @param {object} [extra]
 */
const note = (id, text, extra = {}) => ({
  id, text, quote: text.replace(/^You /, "I "), kind: "about", scope: "personal", importance: 2, saidAt: "2026-10-12T02:00:00Z", mentions: 1, ...extra,
});

const said = [{ at: Date.parse("2026-10-29T03:00:00Z"), you: "My job interview with Acme is on Friday, Nov 6. I'm nervous!", felix: "Good luck!" },
  { at: Date.parse("2026-10-29T03:05:00Z"), you: "Also my dog Mochi turns 3 next week", felix: "Happy early birthday to Mochi." }];

test("secrets are spotted: passwords, codes, card and account numbers, keys and tokens", () => {
  for (const t of ["my password is hunter2", "the OTP was 482910", "verification code 1234", "card number 4111 1111 1111 1111", "4111111111111111",
    "account no. 123", "ghp_abcdefghijklmnopqrstuvwxyz0123", "sk-live_abcdefghijklmnop", "xoxb-1234567890-abc", "AKIAABCDEFGHIJKLMNOP",
    "token abc", "use this: Zm9vYmFyYmF6cXV4cXV1eHF1dXhxdXV4cXV1eA"]) assert.equal(hasSecret(t), true, t);
  for (const t of ["I have a dog named Mochi", "my interview is on Nov 6", "call me at 10", "PR fm#12247", ""]) assert.equal(hasSecret(t), false, t);
  assert.equal(hasSecret(undefined), false);
});

test("words that matter drop common ones and endings, so forms of a word find each other", () => {
  assert.deepEqual([...wordsOf("The interviews I'm having")], ["interview", "hav"]);
  assert.deepEqual([...wordsOf("")], []);
  assert.equal(dayOf("2026-10-12T02:00:00Z", TZ), "Oct 12");
});

test("the learning step is asked for JSON from your words only, with today and the notes it may update", () => {
  const prompt = learnPrompt(said, [note("n1", "You work on the payments team.")], "2026-10-30, Friday");
  assert.match(prompt, /Reply with JSON only/);
  assert.match(prompt, /copied exactly from a Me: line\. Never Felix's words/);
  assert.match(prompt, /Never keep live work data/);
  assert.match(prompt, /Today is 2026-10-30, Friday\./);
  assert.match(prompt, /Known notes:\nn1: You work on the payments team\./);
  assert.match(prompt, /Me: My job interview with Acme is on Friday, Nov 6\. I'm nervous!\nFelix: Good luck!/);
  assert.match(learnPrompt([], [], "x"), /No known notes yet\./);
});

test("only notes from your own words in this talk, with no secret, are kept, dated the day you said them", () => {
  const reply = `Sure! ${JSON.stringify({ notes: [
    { text: "You have a job interview with Acme on Fri, Nov 6.", quote: "My job interview with Acme is on Friday, Nov 6", kind: "event", scope: "personal", importance: 3, date: "2026-11-06", followUp: "How did the Acme interview go?", updates: null },
    { text: "You have a dog named Mochi.", quote: "my dog Mochi", kind: "person", scope: "work", importance: 9, date: "not a date", followUp: "Ignored without a date", updates: "n1" },
    { text: "Felix wished you luck.", quote: "Good luck!" },
    { text: "Your PIN is 4821.", quote: "Also my dog" },
    { text: "", quote: "Also my dog" },
    { text: "You like odd kinds.", quote: "I'm nervous", kind: "weird", importance: 0 },
    null,
  ] })} Done.`;
  const kept = notesFrom(reply, said);
  assert.equal(kept.length, 3);
  assert.deepEqual(kept[0], {
    text: "You have a job interview with Acme on Fri, Nov 6.", quote: "My job interview with Acme is on Friday, Nov 6", kind: "event", scope: "personal",
    importance: 3, saidAt: "2026-10-29T03:00:00.000Z", date: "2026-11-06", followUp: "How did the Acme interview go?", updates: null,
  });
  assert.deepEqual([kept[1].kind, kept[1].scope, kept[1].importance, kept[1].date, kept[1].followUp, kept[1].updates, kept[1].saidAt],
    ["person", "work", 3, null, null, "n1", "2026-10-29T03:05:00.000Z"]);
  assert.deepEqual([kept[2].kind, kept[2].importance], ["about", 1]);
  assert.deepEqual(notesFrom("no json here", said), []);
  assert.deepEqual(notesFrom("{broken", said), []);
  assert.deepEqual(notesFrom('{"notes":"nope"}', said), []);
  assert.deepEqual(notesFrom(undefined, said), []);
});

test("keeping notes adds new ones, counts repeats, and an update keeps the old wording in its history", async () => {
  const { notes, writes } = store([note("n1", "You work on the payments team."), note("n2", "You like tea.")]);
  const saved = await notes.keep([
    { text: "You work on the growth team.", quote: "I moved to growth", kind: "work", scope: "work", importance: 2, saidAt: "2026-10-29T03:00:00.000Z", updates: "n1" },
    { text: "You like tea.", quote: "I like tea", kind: "about", scope: "personal", importance: 1, saidAt: "2026-10-29T03:00:00.000Z", updates: null },
    { text: "You run on Sundays.", quote: "I run on Sundays", kind: "about", scope: "personal", importance: 1, saidAt: "2026-10-29T03:00:00.000Z", updates: "gone" },
  ]);
  assert.deepEqual(saved.map((n) => n.text), ["You work on the growth team.", "You like tea.", "You run on Sundays."]);
  const all = await notes.all();
  const moved = all.find((n) => n.id === "n1");
  assert.deepEqual(moved.history, [{ text: "You work on the payments team.", quote: "I work on the payments team.", saidAt: "2026-10-12T02:00:00Z" }]);
  assert.equal(all.find((n) => n.id === "n2").mentions, 2);
  assert.equal(all.length, 3);
  assert.equal(writes.length, 1);
  assert.deepEqual(await notes.keep([]), []);
  assert.equal(writes.length, 1);
});

test("recall brings the short about-you and only the notes that fit the question, each with its day", async () => {
  const { notes, writes } = store([
    note("a", "You prefer async reviews.", { kind: "preference", importance: 3 }),
    note("b", "You have a job interview with Acme on Fri, Nov 6.", { kind: "event", date: "2026-11-06", saidAt: "2026-10-29T03:00:00Z" }),
    note("c", "You have a dog named Mochi.", { kind: "person" }),
    note("d", "You used to like coffee.", { kind: "about", archived: true }),
  ]);
  const text = await notes.recall("how should I prepare for the interview?");
  assert.match(text, /say when they told you, like "you told me on Oct 12"; if it isn't here or in your memory, say you don't remember/);
  assert.match(text, /About them: You prefer async reviews\./);
  assert.match(text, /- Oct 29: You have a job interview with Acme on Fri, Nov 6\. \(their words: "I have a job interview with Acme on Fri, Nov 6\."\) \[on 2026-11-06\]/);
  assert.doesNotMatch(text, /Mochi|coffee/);
  assert.ok((await notes.all()).find((n) => n.id === "b").lastSeen);
  assert.equal(writes.length, 1);
  assert.match(await notes.recall("what's the weather"), /^What you've learned[\s\S]*About them/);
  assert.equal(writes.length, 1, "nothing to mark seen, nothing written");
  assert.equal(await store([]).notes.recall("anything"), "");
  assert.equal(await store(null).notes.recall("anything"), "");
});

test("the about-you stays short, the notes that matter most first", async () => {
  const many = Array.from({ length: 10 }, (_, i) => note(`n${i}`, `You like thing number ${i} quite a lot, more than most other things in life really.`, { importance: i % 3 + 1 }));
  const about = await store(many).notes.about();
  assert.ok(about.length <= 600);
  assert.match(about, /^You like thing number (2|5|8)/);
});

test("follow-ups come once, after the day of a dated event, and fade a month after", async () => {
  const { notes } = store([
    note("past", "You had an interview.", { date: "2026-10-28", followUp: "How did the interview go?" }),
    note("future", "You have a trip.", { date: "2026-11-20", followUp: "How was the trip?" }),
    note("old", "You had a talk.", { date: "2026-08-01", followUp: "How was the talk?" }),
    note("plain", "You like tea."),
  ]);
  assert.deepEqual((await notes.dueFollowUps()).map((n) => n.id), ["past"]);
  await notes.asked("past");
  await notes.asked("nope");
  assert.deepEqual(await notes.dueFollowUps(), []);
});

test("tidy-up merges notes saying the same thing and archives small old details and long-past events; nothing is deleted", async () => {
  const { notes } = store([
    note("new", "You have a dog named Mochi.", { kind: "person", saidAt: "2026-10-20T00:00:00Z" }),
    note("dup", "You have a dog named Mochi!", { kind: "person", saidAt: "2026-10-01T00:00:00Z", importance: 3, history: [{ text: "x", quote: "x", saidAt: "2026-09-01T00:00:00Z" }] }),
    note("other", "You have a dog named Mochi.", { kind: "about", saidAt: "2026-09-01T00:00:00Z" }),
    note("stale", "You tried a new keyboard.", { importance: 1, saidAt: "2026-01-01T00:00:00Z" }),
    note("seen", "You tried a new mouse.", { importance: 1, saidAt: "2026-01-01T00:00:00Z", lastSeen: "2026-10-25T00:00:00Z" }),
    note("event", "You had a talk.", { date: "2026-08-01" }),
  ]);
  assert.deepEqual(await notes.tidyUp(), { merged: 1, archived: 2 });
  const all = await notes.all();
  assert.equal(all.length, 6);
  const kept = all.find((n) => n.id === "new");
  assert.deepEqual([kept.mentions, kept.importance, kept.history.length], [2, 3, 2]);
  assert.deepEqual(all.filter((n) => n.archived).map((n) => n.id).sort(), ["dup", "event", "stale"]);
  assert.deepEqual(await notes.tidyUp(), { merged: 0, archived: 0 });
});

test("a note's words can be changed (the old ones kept), but never to a secret; notes can be deleted", async () => {
  const { notes } = store([note("a", "You like tea.")]);
  const changed = await notes.edit("a", "  You like green tea.  ");
  assert.equal(changed.text, "You like green tea.");
  assert.equal(changed.history[0].text, "You like tea.");
  assert.equal(await notes.edit("a", "my password is x"), null);
  assert.equal(await notes.edit("a", "  "), null);
  assert.equal(await notes.edit("nope", "x"), null);
  assert.equal(await notes.remove(["nope"]), 0);
  assert.equal(await notes.remove(["a"]), 1);
  assert.deepEqual(await notes.all(), []);
});

test("the store saves to disk in one step and reads it back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-notes-"));
  const file = path.join(dir, "notes.json");
  const notes = createNotes({ file, now: () => NOW });
  await notes.keep([{ text: "You like tea.", quote: "I like tea", kind: "about", scope: "personal", importance: 1, saidAt: "2026-10-29T03:00:00.000Z", updates: null }]);
  const again = createNotes({ file });
  assert.equal((await again.all())[0].text, "You like tea.");
  assert.equal(JSON.parse(await readFile(file, "utf8")).notes.length, 1);
  await rm(dir, { recursive: true, force: true });
});

/**
 * A learner over a store and a pretend AI, with timers moved by hand.
 * @param {{ reply?: string | Error, learning?: boolean, start?: object[] }} [options]
 */
function learnerWith({ reply = '{"notes":[]}', learning = true, start = [] } = {}) {
  const { notes } = store(start);
  const prompts = [];
  const log = [];
  const timers = [];
  let clock = NOW;
  const learner = createLearner({
    notes,
    now: () => clock,
    log: (e) => log.push(e),
    learning: async () => learning,
    idleMs: async () => 600_000,
    extract: async (p) => {
      prompts.push(p);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimer: () => {},
  });
  return { learner, notes, prompts, log, timers, later: (ms) => { clock += ms; } };
}

test("after a quiet spell, what you said is learned in one AI step and saved", async () => {
  const reply = JSON.stringify({ notes: [{ text: "You have a dog named Mochi.", quote: "my dog is Mochi", kind: "person" }] });
  const { learner, notes, prompts, log, timers } = learnerWith({ reply });
  await learner.heard("my dog is Mochi", "Cute name!");
  await learner.heard("who's on call?", "Sonito is.");
  assert.equal(timers.at(-1).ms, 600_000);
  timers.at(-1).fn();
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.equal(prompts.length, 1);
  assert.match(prompts[0], /Me: my dog is Mochi\nFelix: Cute name!\nMe: who's on call\?/);
  assert.equal((await notes.all())[0].text, "You have a dog named Mochi.");
  assert.equal(log[0].learned.length, 1);
  assert.deepEqual(await learner.learn(), [], "nothing new to learn from");
  assert.equal(prompts.length, 1);
});

test("nothing is learned with learning paused, and a failed AI step is logged, not thrown", async () => {
  const paused = learnerWith({ learning: false });
  await paused.learner.heard("my dog is Mochi", "Cute!");
  assert.deepEqual(await paused.learner.learn(), []);
  assert.equal(paused.prompts.length, 0);
  const failing = learnerWith({ reply: new Error("Claude took too long") });
  await failing.learner.heard("my dog is Mochi", "Cute!");
  assert.deepEqual(await failing.learner.learn(), []);
  assert.equal(failing.log[0].learnFailed, "Claude took too long");
  // The talk isn't lost: the next try still has it.
  await failing.learner.learn();
  assert.match(failing.prompts.at(-1), /Mochi/, "the failed talk is tried again");
});

test("off the record keeps the rest of the talk out, until back on the record or the talk ends", async () => {
  const { learner, prompts } = learnerWith();
  await learner.heard("I like tea", "Nice.");
  learner.offRecord(true);
  assert.equal(learner.isOffRecord(), true);
  await learner.heard("I'm thinking of quitting", "I hear you.");
  learner.offRecord(false);
  await learner.heard("I like jazz", "Cool.");
  await learner.learn();
  assert.doesNotMatch(prompts[0], /quitting/);
  assert.match(prompts[0], /tea[\s\S]*jazz/);
  learner.offRecord(true);
  await learner.learn();
  assert.equal(learner.isOffRecord(), false, "a new talk starts on the record");
});

test("forget that drops the last thing you said, or the notes just learned from it", async () => {
  const reply = JSON.stringify({ notes: [{ text: "You have a dog named Mochi.", quote: "my dog is Mochi" }] });
  const { learner, notes, prompts } = learnerWith({ reply });
  await learner.heard("I like tea", "Nice.");
  await learner.heard("my dog is Mochi", "Cute!");
  assert.deepEqual(await learner.forgetLast(), { dropped: true, removed: [] });
  await learner.heard("my dog is Mochi", "Cute!");
  await learner.learn();
  assert.doesNotMatch(prompts[0], /I like tea[\s\S]*my dog is Mochi[\s\S]*my dog is Mochi/);
  const { removed } = await learner.forgetLast();
  assert.equal(removed[0].text, "You have a dog named Mochi.");
  assert.deepEqual(await notes.all(), []);
  assert.deepEqual(await learner.forgetLast(), { dropped: false, removed: [] });
});

test("learning uses the real timers when none are given", async () => {
  const { notes } = store([]);
  const learner = createLearner({ notes, extract: async () => '{"notes":[]}', learning: async () => true, idleMs: async () => 5 });
  await learner.heard("hi", "hey");
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await learner.forgetLast(), { dropped: false, removed: [] }, "the talk was learned and cleared");
});

test("the store starts empty when there's no file, and keeps working days later", async () => {
  let clock = NOW;
  const { notes } = store(null, { now: () => clock });
  assert.deepEqual(await notes.all(), []);
  clock += 400 * DAY;
  assert.deepEqual(await notes.tidyUp(), { merged: 0, archived: 0 });
});

test("the learning step gets the days around today to look dates up in, instead of working them out", () => {
  const days = daysAround(NOW, TZ);
  assert.equal(days.length, 29);
  assert.equal(days[7], "Fri, Oct 30 = 2026-10-30");
  assert.ok(days.includes("Thu, Nov 5 = 2026-11-05"));
  assert.equal(days[0], "Fri, Oct 23 = 2026-10-23");
  const prompt = learnPrompt(said, [], "2026-10-30, Friday", days);
  assert.match(prompt, /The days around today \(use these, don't work dates out\):\nFri, Oct 23 = 2026-10-23/);
  assert.match(prompt, /never "next week"/);
  assert.equal(daysAround(NOW).length, 29);
});

test("work and personal notes stay apart: each kind of talk brings only its own", async () => {
  const { notes } = store([
    note("p", "You have a sister named Bea.", { kind: "about", scope: "personal" }),
    note("w", "You lead the Bea migration.", { kind: "work", scope: "work" }),
  ]);
  assert.match(await notes.recall("tell me about Bea", "personal"), /sister[\s\S]*$/);
  assert.doesNotMatch(await notes.recall("tell me about Bea", "personal"), /migration/);
  assert.doesNotMatch(await notes.recall("tell me about Bea", "work"), /sister/);
  assert.match(await notes.recall("tell me about Bea"), /sister[\s\S]*migration|migration[\s\S]*sister/);
});
