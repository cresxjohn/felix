import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  ATTENDANCE, NO_SHIFT, clockText, greetingFor, hoursText, messageFor, nextStatus, reminderAt, shiftPrefs, shiftTimes,
} from "../public/shift-clock.mjs";
import { cantText, cleanShift, createShift, dueText, macNotify, serveShift, shiftReply, timeOfDay } from "../shift.mjs";
import { SLACK_ACCOUNT, SLACK_SERVICE, checkSlack, createSlack, slackCall } from "../slack.mjs";
import { createConnections } from "../connections.mjs";
import { matchCommand } from "../felix-commands.mjs";
import { ANSWERS } from "../felix-answers.mjs";
import { defaultSettings } from "../public/settings-schema.mjs";

const HOUR = 3600e3;
const MIN = 60e3;
// 9:00 AM on this Mac's clock, so greetings and times read the same wherever the tests run.
const NINE = new Date(2026, 9, 30, 9, 0, 0).getTime();
const iso = (t) => new Date(t).toISOString();
const PREFS = shiftPrefs(defaultSettings());

/**
 * A work day over an in-memory file, with a clock, Slack and notifications the test controls.
 * @param {{ saved?: string | null, prefs?: Record<string, unknown>, connected?: boolean, post?: Function, presence?: Function }} [options]
 */
function desk({ saved = null, prefs = {}, connected = false, post, presence } = {}) {
  const clock = { t: NINE };
  const writes = [];
  const notes = [];
  const sent = [];
  const values = { ...defaultSettings(), ...prefs };
  const slack = {
    connected: async () => connected,
    post: post || (async (channel, text) => { sent.push(["post", channel, text]); return { ok: true }; }),
    presence: presence || (async (p) => { sent.push(["presence", p]); return { ok: true }; }),
  };
  let ids = 0;
  const shift = createShift({
    file: "shift.json",
    settings: { get: async () => values },
    slack,
    notify: (title, text) => notes.push([title, text]),
    now: () => clock.t,
    newId: () => `n${++ids}`,
    read: async () => { if (saved === null) throw new Error("missing"); return saved; },
    write: async (_file, text) => { writes.push(JSON.parse(text)); },
  });
  return { shift, clock, writes, notes, sent, values };
}

// ---------- The clock (public/shift-clock.mjs) ----------

test("the day's settings come out of Felix's settings, with an emptied message back at its default", () => {
  assert.deepEqual(PREFS, {
    on: true, dayHours: 9, breakPauses: false, reminder: true, snooze: 30, slack: true,
    messages: { morning: "Good morning", afternoon: "Good afternoon", evening: "Good evening", break: "Be right back!", back: "I'm back!", bye: "Bye for now!" },
  });
  const mine = shiftPrefs({ shiftOn: false, shiftHours: 8.5, shiftBreakPauses: true, shiftReminder: false, shiftSnooze: 60, shiftSlack: false, shiftMorning: "  Morning all ", shiftBye: "   " });
  assert.equal(mine.on, false);
  assert.equal(mine.dayHours, 8.5);
  assert.equal(mine.breakPauses, true);
  assert.equal(mine.reminder, false);
  assert.equal(mine.snooze, 60);
  assert.equal(mine.slack, false);
  assert.equal(mine.messages.morning, "Morning all");
  assert.equal(mine.messages.bye, "Bye for now!");
  assert.equal(shiftPrefs({}).dayHours, 9);
});

test("the greeting follows the time of day, and each step has its message", () => {
  const m = PREFS.messages;
  assert.deepEqual([0, 11, 12, 17, 18, 23].map((h) => greetingFor(h, m)), ["Good morning", "Good morning", "Good afternoon", "Good afternoon", "Good evening", "Good evening"]);
  assert.deepEqual(["start", "break", "back", "end"].map((a) => messageFor(a, PREFS, 14)), ["Good afternoon", "Be right back!", "I'm back!", "Bye for now!"]);
});

test("each step can only follow the steps that make sense", () => {
  assert.equal(nextStatus("off", "start"), "working");
  assert.equal(nextStatus("ended", "start"), "working");
  assert.equal(nextStatus("working", "break"), "break");
  assert.equal(nextStatus("break", "back"), "working");
  assert.equal(nextStatus("break", "end"), "ended");
  assert.equal(nextStatus("working", "end"), "ended");
  for (const [status, action] of [["off", "break"], ["working", "start"], ["working", "back"], ["break", "break"], ["ended", "end"], ["working", "toString"], ["working", "nap"]]) {
    assert.equal(nextStatus(status, action), null, `${status} ${action}`);
  }
});

test("the times count from the start, with breaks inside the day unless they pause it", () => {
  assert.equal(shiftTimes(NO_SHIFT, PREFS, NINE), null);
  const day = { ...NO_SHIFT, status: "working", startedAt: iso(NINE), breaks: [{ start: iso(NINE + HOUR), end: iso(NINE + HOUR + 30 * MIN) }] };
  const t = shiftTimes(day, PREFS, NINE + 2 * HOUR);
  assert.deepEqual(t, { elapsedMs: 2 * HOUR, breakMs: 30 * MIN, workedMs: 90 * MIN, dueAt: NINE + 9 * HOUR, leftMs: 7 * HOUR, onBreakMs: 0 });
  assert.equal(shiftTimes(day, { ...PREFS, breakPauses: true }, NINE + 2 * HOUR).dueAt, NINE + 9.5 * HOUR);
  const resting = { ...day, status: "break", breaks: [...day.breaks, { start: iso(NINE + 3 * HOUR), end: null }] };
  const r = shiftTimes(resting, { ...PREFS, breakPauses: true }, NINE + 3 * HOUR + 10 * MIN);
  assert.equal(r.onBreakMs, 10 * MIN);
  assert.equal(r.breakMs, 40 * MIN);
  assert.equal(r.leftMs, 6 * HOUR + 30 * MIN);
  const ended = { ...day, status: "ended", endedAt: iso(NINE + 8 * HOUR) };
  assert.equal(shiftTimes(ended, PREFS, NINE + 20 * HOUR).elapsedMs, 8 * HOUR);
  assert.equal(shiftTimes({ ...day, breaks: undefined }, PREFS, NINE).breakMs, 0);
});

test("the reminder comes when the hours are up, or later after a not yet, and only while the day runs", () => {
  const day = { ...NO_SHIFT, status: "working", startedAt: iso(NINE) };
  assert.equal(reminderAt(day, PREFS, NINE), NINE + 9 * HOUR);
  assert.equal(reminderAt({ ...day, remindAt: iso(NINE + 10 * HOUR) }, PREFS, NINE), NINE + 10 * HOUR);
  assert.equal(reminderAt({ ...day, remindAt: iso(NINE + HOUR) }, PREFS, NINE), NINE + 9 * HOUR);
  assert.equal(reminderAt({ ...day, status: "break", breaks: [{ start: iso(NINE), end: null }] }, PREFS, NINE), NINE + 9 * HOUR);
  assert.equal(reminderAt({ ...day, status: "ended" }, PREFS, NINE), null);
  assert.equal(reminderAt(NO_SHIFT, PREFS, NINE), null);
  assert.equal(reminderAt(day, { ...PREFS, reminder: false }, NINE), null);
  assert.equal(reminderAt(day, { ...PREFS, on: false }, NINE), null);
});

test("lengths of time read the way the top bar shows them", () => {
  assert.deepEqual([0, 59e3, 45 * MIN, 2 * HOUR + 5 * MIN, -5 * MIN].map(clockText), ["0m", "0m", "45m", "2h 05m", "0m"]);
  assert.deepEqual([1, 8.5, 9].map(hoursText), ["1 hour", "8.5 hours", "9 hours"]);
  assert.deepEqual(ATTENDANCE, { id: "C08HMFEDS5P", name: "#attendance-engineering-ph" });
});

// ---------- The work day (shift.mjs) ----------

test("a saved day is checked, and anything odd is a day that hasn't started", () => {
  for (const bad of [null, "x", { status: "napping" }, { status: "working" }, { status: "working", startedAt: "yesterday-ish" }]) {
    assert.deepEqual(cleanShift(bad), { ...NO_SHIFT, breaks: [] }, JSON.stringify(bad));
  }
  const kept = cleanShift({
    status: "break", startedAt: iso(NINE), endedAt: 5, remindAt: iso(NINE + HOUR), remindedAt: "no",
    breaks: [{ start: iso(NINE), end: "later" }, { end: iso(NINE) }, null], note: { id: "a", text: "Hi", slack: "off" }, extra: 1,
  });
  assert.deepEqual(kept, {
    status: "break", startedAt: iso(NINE), endedAt: null, breaks: [{ start: iso(NINE), end: null }], remindAt: iso(NINE + HOUR), remindedAt: null,
    note: { id: "a", text: "Hi", slack: "off" },
  });
  assert.equal(cleanShift({ status: "off", note: { id: 1 } }).note, null);
  assert.deepEqual(cleanShift({ status: "off", breaks: "none" }).breaks, []);
});

test("before anything happens the day is off, and Slack shows as not connected", async () => {
  const { shift } = desk();
  const v = await shift.view();
  assert.equal(v.shift.status, "off");
  assert.equal(v.times, null);
  assert.equal(v.reminder, null);
  assert.deepEqual(v.slack, { connected: false });
  assert.equal(v.channel, "#attendance-engineering-ph");
  assert.equal(v.now, iso(NINE));
});

test("a Slack that can't say whether it's connected counts as not connected", async () => {
  const { shift } = desk();
  const broken = createShift({ file: "s.json", settings: { get: async () => defaultSettings() }, slack: { connected: async () => { throw new Error("no"); } }, read: async () => "{}", write: async () => {} });
  assert.deepEqual((await broken.view()).slack, { connected: false });
  assert.equal((await broken.act("start")).shift.note.slack, "off");
  assert.equal((await shift.view()).shift.status, "off");
});

test("start, break, back and end move the day along and record the breaks", async () => {
  const { shift, clock, writes } = desk();
  let v = await shift.act("start");
  assert.equal(v.shift.status, "working");
  assert.equal(v.shift.startedAt, iso(NINE));
  assert.deepEqual(v.shift.note, { id: "n1", action: "start", text: "Good morning", at: iso(NINE), presence: "auto", slack: "off" });
  assert.equal(v.reminder.at, iso(NINE + 9 * HOUR));
  assert.equal(v.reminder.due, false);
  clock.t += HOUR;
  v = await shift.act("break");
  assert.equal(v.shift.status, "break");
  assert.deepEqual(v.shift.breaks, [{ start: iso(NINE + HOUR), end: null }]);
  assert.equal(v.shift.note.text, "Be right back!");
  assert.equal(v.shift.note.presence, null);
  clock.t += 15 * MIN;
  v = await shift.act("back");
  assert.deepEqual(v.shift.breaks, [{ start: iso(NINE + HOUR), end: iso(NINE + 75 * MIN) }]);
  assert.equal(v.shift.note.text, "I'm back!");
  clock.t += 7 * HOUR;
  await shift.act("break");
  clock.t += 10 * MIN;
  v = await shift.act("end");
  assert.equal(v.shift.status, "ended");
  assert.equal(v.shift.endedAt, iso(clock.t));
  assert.equal(v.shift.breaks.at(-1).end, iso(clock.t));
  assert.deepEqual(v.shift.note, { id: "n5", action: "end", text: "Bye for now!", at: iso(clock.t), presence: "away", slack: "off" });
  assert.equal(v.reminder, null);
  assert.equal(writes.length, 5);
  clock.t += 14 * HOUR;
  v = await shift.act("start");
  assert.deepEqual([v.shift.breaks, v.shift.endedAt, v.shift.remindAt], [[], null, null]);
});

test("a step that can't follow, or with the feature off, is refused in plain words", async () => {
  const { shift } = desk();
  await assert.rejects(shift.act("break"), (e) => e.code === "state" && /hasn't started/.test(e.message));
  await shift.act("start");
  await assert.rejects(shift.act("start"), (e) => e.code === "state" && /already started/.test(e.message));
  await assert.rejects(shift.act("back"), (e) => e.code === "state" && /not on a break/.test(e.message));
  await shift.act("break");
  await assert.rejects(shift.act("break"), /already on a break/);
  await assert.rejects(shift.act("start"), /I'm back/);
  await assert.rejects(shift.act("nap"), /doesn't know that step/);
  const off = desk({ prefs: { shiftOn: false } });
  await assert.rejects(off.shift.act("start"), (e) => e.code === "off" && /turned off in Settings/.test(e.message));
  assert.equal(cantText("ended", "end"), "Your day hasn't started yet. Start your day first.");
});

test("two windows starting the day at once start it once", async () => {
  const { shift, writes } = desk();
  const results = await Promise.allSettled([shift.act("start"), shift.act("start")]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected"]);
  assert.equal(writes.length, 1);
});

test("with Slack connected, a step's message waits for a yes, and yes posts it as you with the presence", async () => {
  const { shift, sent } = desk({ connected: true });
  let v = await shift.act("start");
  assert.equal(v.shift.note.slack, "pending");
  assert.deepEqual(sent, []);
  v = await shift.answer("n1", true);
  assert.equal(v.shift.note.slack, "posted");
  assert.deepEqual(sent, [["post", "C08HMFEDS5P", "Good morning"], ["presence", "auto"]]);
  await assert.rejects(shift.answer("n1", true), (e) => e.code === "gone" && /no Slack post waiting/.test(e.message));
  await shift.act("break");
  v = await shift.answer("n2", true);
  assert.deepEqual(sent.at(-1), ["post", "C08HMFEDS5P", "Be right back!"]);
  await shift.act("back");
  v = await shift.answer("n3", false);
  assert.equal(v.shift.note.slack, "skipped");
  assert.equal(sent.length, 3);
  await shift.act("end");
  await assert.rejects(shift.answer("n3", true), (e) => e.code === "gone");
  await shift.answer("n4", true);
  assert.deepEqual(sent.slice(-2), [["post", "C08HMFEDS5P", "Bye for now!"], ["presence", "away"]]);
});

test("a post that waits too long is dropped, and a failed post says why", async () => {
  const { shift, clock, sent, writes } = desk({ connected: true });
  await shift.act("start");
  clock.t += 16 * MIN;
  assert.equal((await shift.view()).shift.note.slack, "expired");
  await assert.rejects(shift.answer("n1", true), (e) => e.code === "gone" && /waited too long/.test(e.message));
  assert.equal(writes.at(-1).note.slack, "expired");
  assert.deepEqual(sent, []);
  const failing = desk({ connected: true, post: async () => { throw new Error("Slack refused the token."); } });
  await failing.shift.act("start");
  const v = await failing.shift.answer("n1", true);
  assert.equal(v.shift.note.slack, "failed");
  assert.equal(v.shift.note.error, "Slack refused the token.");
});

test("with Slack posting off in Settings, nothing waits to be posted", async () => {
  const { shift } = desk({ connected: true, prefs: { shiftSlack: false } });
  assert.equal((await shift.act("start")).shift.note.slack, "disabled");
});

test("not yet asks again after the snooze time, and only while the day runs", async () => {
  const { shift, clock } = desk({ prefs: { shiftSnooze: 15 } });
  await assert.rejects(shift.snooze(), (e) => e.code === "state");
  await shift.act("start");
  clock.t += 9 * HOUR;
  assert.equal((await shift.view()).reminder.due, true);
  const v = await shift.snooze();
  assert.equal(v.shift.remindAt, iso(clock.t + 15 * MIN));
  assert.deepEqual(v.reminder, { at: iso(clock.t + 15 * MIN), due: false });
});

test("the Mac notification comes once when the hours are up, and again after each not yet", async () => {
  const { shift, clock, notes } = desk();
  assert.equal(await shift.tick(), false);
  await shift.act("start");
  clock.t += 8 * HOUR;
  assert.equal(await shift.tick(), false);
  clock.t += HOUR;
  assert.equal(await shift.tick(), true);
  assert.deepEqual(notes, [["Felix", "Your 9 hours are up. Time to end your day?"]]);
  clock.t += 5 * MIN;
  assert.equal(await shift.tick(), false);
  await shift.snooze();
  clock.t += 30 * MIN;
  assert.equal(await shift.tick(), true);
  assert.match(notes[1][1], /^Your 9 hours are up \(35m ago\)/);
  const quiet = desk({ prefs: { shiftReminder: false } });
  await quiet.shift.act("start");
  quiet.clock.t += 10 * HOUR;
  assert.equal(await quiet.shift.tick(), false);
});

test("a restart doesn't notify again for the same reminder", async () => {
  const day = { ...NO_SHIFT, status: "working", startedAt: iso(NINE - 9 * HOUR), remindedAt: iso(NINE) };
  const { shift, notes } = desk({ saved: JSON.stringify(day) });
  assert.equal(await shift.tick(), false);
  assert.deepEqual(notes, []);
});

test("watching checks right away and can be stopped", async () => {
  const { shift, clock, notes } = desk({ saved: JSON.stringify({ ...NO_SHIFT, status: "working", startedAt: iso(NINE - 10 * HOUR) }) });
  clock.t = NINE;
  const stop = shift.watch();
  await new Promise((r) => setTimeout(r, 10));
  stop();
  assert.equal(notes.length, 1);
});

test("the day is kept on disk, so a reload or a restart picks it up as it was", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-shift-"));
  try {
    const file = path.join(dir, "data", "shift.json");
    const settings = { get: async () => defaultSettings() };
    const slack = { connected: async () => false };
    const first = createShift({ file, settings, slack, now: () => NINE });
    await first.act("start");
    await first.act("break");
    assert.equal(JSON.parse(await readFile(file, "utf8")).status, "break");
    const again = createShift({ file, settings, slack, now: () => NINE + HOUR });
    const v = await again.view();
    assert.equal(v.shift.status, "break");
    assert.equal(v.times.onBreakMs, HOUR);
    assert.equal(typeof v.shift.note.id, "string");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the Mac notification passes its words as arguments, never inside the script", () => {
  const calls = [];
  macNotify("Felix", 'Say "hi" & bye', { run: (cmd, args, done) => { calls.push([cmd, args]); done(); } });
  assert.equal(calls[0][0], "osascript");
  assert.deepEqual(calls[0][1].slice(-2), ["Felix", 'Say "hi" & bye']);
  assert.ok(calls[0][1].slice(0, 6).every((a) => !a.includes("bye")));
});

test("the reminder and times read naturally", () => {
  assert.equal(dueText({ dayHours: 8 }, { leftMs: 0 }), "Your 8 hours are up. Time to end your day?");
  assert.equal(dueText(PREFS, { leftMs: -90 * MIN }), "Your 9 hours are up (1h 30m ago). Time to end your day?");
  assert.equal(timeOfDay(NINE + 2 * MIN), "9:02 AM");
});

// ---------- Felix's commands for the day ----------

test("Felix hears the day's steps in the ways you might say them", () => {
  const cases = {
    start: ["start my day", "Hey Felix, start the work day", "begin my shift", "start working", "clock in", "I'm clocking in", "let's start the day"],
    break: ["take a break", "Taking a quick break", "I'm going on lunch break", "going on a coffee break", "break time", "brb", "be right back", "I'm on break"],
    back: ["I'm back", "i'm back!", "I am back", "back from my break", "I'm back from lunch break", "resume shift", "resume my day", "end my break", "break's over", "back to work"],
    end: ["end my day", "finish the day", "end my shift", "clock out", "I'm done for the day", "heading out", "I'm signing off for today", "log off", "call it a day", "let's call it a day"],
    post: ["post it", "yes, post it", "go ahead and post", "post it to Slack", "send it"],
    skip: ["don't post it", "no, don't post", "do not send that", "skip the post"],
    status: ["how long have I been working", "how long have I worked today", "how much time is left", "when does my day end", "when is my shift over", "when can I log off"],
  };
  for (const [action, sayings] of Object.entries(cases)) {
    for (const said of sayings) assert.deepEqual(matchCommand(said), { intent: "shift", slots: { action } }, said);
  }
  // A bare "back" is still the music's, and on-call questions about your shift stay on-call ones.
  assert.equal(matchCommand("back").intent, "music.control");
  assert.equal(matchCommand("when is my shift").intent, "oncall.mine");
});

test("Felix answers the day's commands on this Mac, and asks before posting", async () => {
  assert.deepEqual(await shiftReply({ action: "start" }, null), { text: "The work day isn't set up in this Felix." });
  const { shift, clock, sent } = desk({ connected: true });
  assert.match((await shiftReply({ action: "status" }, shift)).text, /haven't started your day/);
  await shift.act("start");
  assert.match((await shiftReply({ action: "status" }, shift)).text, /^You started at 9:00 AM, just now;/);
  await shift.act("end");
  await shift.answer("n2", false);
  clock.t = NINE;
  assert.match((await shiftReply({ action: "break" }, shift)).text, /hasn't started yet/);
  const started = (await shiftReply({ action: "start" }, shift)).text;
  assert.equal(started, `You're clocked in at 9:00 AM. I'll nudge you at 6:00 PM, after 9 hours. Want me to post "Good morning" to #attendance-engineering-ph? Say "post it", or use the buttons up top.`);
  assert.deepEqual(sent, []);
  assert.deepEqual(await shiftReply({ action: "post" }, shift), { text: `Posted "Good morning" to #attendance-engineering-ph.` });
  assert.equal(sent.length, 2);
  assert.match((await shiftReply({ action: "post" }, shift)).text, /no Slack post waiting/);
  clock.t += 2 * HOUR;
  assert.match((await shiftReply({ action: "status" }, shift)).text, /^You started at 9:00 AM, 2h 00m ago; 7h 00m left, until 6:00 PM\.$/);
  assert.match((await shiftReply({ action: "break" }, shift)).text, /^Enjoy your break! Want me to post "Be right back!"/);
  assert.deepEqual(await shiftReply({ action: "skip" }, shift), { text: "Okay, I won't post it." });
  clock.t += 20 * MIN;
  assert.match((await shiftReply({ action: "status" }, shift)).text, /You're on a break, 20m so far\.$/);
  assert.match((await shiftReply({ action: "back" }, shift)).text, /^Welcome back! 6h 40m to go today\./);
  clock.t += 8 * HOUR;
  assert.match((await shiftReply({ action: "status" }, shift)).text, /your hours were up at 6:00 PM/);
  assert.match((await shiftReply({ action: "end" }, shift)).text, /^Nice work today! That's 10h 00m of work\./);
  assert.match((await shiftReply({ action: "status" }, shift)).text, /^Your day ended at 7:20 PM, after 10h 00m of work\.$/);
});

test("without Slack connected, Felix says so and offers the message to copy; a failed post says why", async () => {
  const off = desk({ prefs: { shiftBreakPauses: true } });
  assert.match((await shiftReply({ action: "start" }, off.shift)).text, /Slack isn't connected yet, so nothing was posted\. You can copy "Good morning" from the top bar\.$/);
  assert.match((await shiftReply({ action: "break" }, off.shift)).text, /^Enjoy your break! The countdown waits till you're back\./);
  off.clock.t += 10 * HOUR;
  assert.match((await shiftReply({ action: "back" }, off.shift)).text, /^Welcome back! 9h 00m to go today\./);
  const late = desk();
  await shiftReply({ action: "start" }, late.shift);
  late.clock.t += 10 * HOUR;
  await shiftReply({ action: "break" }, late.shift);
  assert.match((await shiftReply({ action: "back" }, late.shift)).text, /^Welcome back! Your hours are already up/);
  const failing = desk({ connected: true, post: async () => { throw new Error("Slack said no."); } });
  await shiftReply({ action: "start" }, failing.shift);
  assert.match((await shiftReply({ action: "post" }, failing.shift)).text, /^I couldn't post it: Slack said no\./);
  const disabled = desk({ prefs: { shiftOn: false } });
  assert.equal((await shiftReply({ action: "status" }, disabled.shift)).text, "Start my day is turned off in Settings.");
  const quiet = desk({ prefs: { shiftSlack: false } });
  assert.doesNotMatch((await shiftReply({ action: "start" }, quiet.shift)).text, /Slack|post/);
});

test("Felix's local answers reach the server's work day", async () => {
  const { shift } = desk();
  serveShift(shift);
  try {
    assert.match((await ANSWERS.shift({}, { action: "start" })).text, /^You're clocked in/);
  } finally {
    serveShift(null);
  }
  assert.match((await ANSWERS.shift({}, { action: "start" })).text, /isn't set up/);
});

// ---------- Slack (slack.mjs) ----------

/**
 * A fetch that answers with the given status and body, and remembers what it was asked.
 * @param {object | null} body Null for an answer that isn't JSON.
 * @param {number} [status]
 */
function fakeFetch(body, status = 200) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    return { status, json: async () => { if (body === null) throw new Error("not json"); return body; } };
  };
  return { impl, calls };
}

test("Slack calls are form posts with your token, and Slack's refusals come back as coded errors", async () => {
  const ok = fakeFetch({ ok: true, ts: "1" });
  assert.deepEqual(await slackCall("chat.postMessage", "xoxp-1", { channel: "C1", text: "Hi & bye" }, ok.impl), { ok: true, ts: "1" });
  assert.equal(ok.calls[0].url, "https://slack.com/api/chat.postMessage");
  assert.equal(ok.calls[0].init.headers.Authorization, "Bearer xoxp-1");
  assert.equal(ok.calls[0].init.body, "channel=C1&text=Hi+%26+bye");
  const refused = async (body, status) => slackCall("auth.test", "t", undefined, fakeFetch(body, status).impl).catch((e) => [e.code, e.message]);
  assert.equal((await refused({ ok: false, error: "invalid_auth" }))[0], "auth");
  assert.deepEqual(await refused({ ok: false, error: "missing_scope", needed: "users:write" }), ["scope", "The Slack app needs the users:write scope. Add it, then connect Slack again."]);
  assert.match((await refused({ ok: false, error: "missing_scope" }))[1], /needs the right scope/);
  assert.equal((await refused({ ok: false, error: "ratelimited" }))[0], "rate");
  assert.equal((await refused(null, 429))[0], "rate");
  assert.deepEqual(await refused({ ok: false, error: "channel_not_found" }), ["slack", `Slack said "channel_not_found".`]);
  assert.deepEqual(await refused(null, 500), ["slack", `Slack said "http_500".`]);
  const down = await slackCall("auth.test", "t", {}, async () => { throw new Error("offline"); }).catch((e) => [e.code, e.message]);
  assert.deepEqual(down, ["network", "Couldn't reach Slack."]);
});

test("a token is tried with auth.test, and a bot's token is turned away", async () => {
  assert.deepEqual(await checkSlack({ token: "xoxp-1", fetchImpl: fakeFetch({ ok: true, user: "cres", team: "PURE PM" }).impl }), { name: "cres on PURE PM" });
  assert.deepEqual(await checkSlack({ token: "xoxp-1", fetchImpl: fakeFetch({ ok: true, user: "cres" }).impl }), { name: "cres" });
  assert.deepEqual(await checkSlack({ token: "xoxp-1", fetchImpl: fakeFetch({ ok: true }).impl }), { name: "you" });
  await assert.rejects(checkSlack({ token: "xoxb-1", fetchImpl: fakeFetch({ ok: true, user: "bot", bot_id: "B1" }).impl }), (e) => e.code === "input" && /user token/.test(e.message));
});

test("the Slack client reads the token from the Keychain at most every 30 seconds, and says when it isn't there", async () => {
  let token = null;
  let reads = 0;
  let t = 0;
  const f = fakeFetch({ ok: true });
  const slack = createSlack({ readSecret: async (service, account) => { reads++; assert.deepEqual([service, account], [SLACK_SERVICE, SLACK_ACCOUNT]); return token; }, fetchImpl: f.impl, now: () => t });
  assert.equal(await slack.connected(), false);
  await assert.rejects(slack.post("C1", "Hi"), (e) => e.code === "no-token" && e.message === "Slack isn't connected yet.");
  token = "xoxp-9";
  assert.equal(await slack.connected(), false);
  slack.reset();
  assert.equal(await slack.connected(), true);
  t += 31e3;
  await slack.post("C1", "Hi");
  await slack.presence("away");
  assert.equal(reads, 3);
  assert.deepEqual(f.calls.map((c) => [c.url.split("/").pop(), c.init.body]), [["chat.postMessage", "channel=C1&text=Hi"], ["users.setPresence", "presence=away"]]);
});

// ---------- Connecting services (connections.mjs) ----------

/**
 * Connections over a temporary folder and a Keychain in memory.
 * @param {string} dir
 * @param {{ slack?: boolean }} [options]
 */
function connector(dir, { slack = true } = {}) {
  const keychain = new Map();
  const resets = [];
  const service = (name) => ({ service: `cmd-center-${name}`, check: async (fields) => ({ name: `${name}:${fields.email || fields.token}` }), reset: () => resets.push(name) });
  const c = createConnections({
    dir,
    jira: service("jira"),
    datadog: service("datadog"),
    ...(slack ? { slack: { ...service("slack"), account: "slack" } } : {}),
    keychain: {
      write: async (s, a, secret) => { keychain.set(s, { a, secret }); },
      remove: async (s, a) => { if (keychain.get(s)?.a === a) keychain.delete(s); },
      account: async (s) => keychain.get(s)?.a || null,
    },
  });
  return { c, keychain, resets };
}

test("a Slack user token is tried, then saved to the Keychain; anything else is refused before Slack sees it", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-connect-"));
  try {
    const { c, keychain, resets } = connector(dir);
    await assert.rejects(c.connect("slack", { token: "xoxb-12345678" }), (e) => e.code === "input" && /starts with xoxp-/.test(e.message));
    await assert.rejects(c.connect("slack", {}), (e) => e.code === "input");
    assert.deepEqual(await c.connect("slack", { token: " xoxp-1234-5678-abcd " }), { ok: true, name: "slack:xoxp-1234-5678-abcd" });
    assert.deepEqual(keychain.get("cmd-center-slack"), { a: "slack", secret: "xoxp-1234-5678-abcd" });
    assert.deepEqual(await c.connect("slack", { token: "xoxe.xoxp-1-abcdefgh" }), { ok: true, name: "slack:xoxe.xoxp-1-abcdefgh" });
    assert.deepEqual(await c.disconnect("slack"), { ok: true });
    assert.equal(keychain.has("cmd-center-slack"), false);
    assert.deepEqual(resets, ["slack", "slack", "slack"]);
    const without = connector(dir, { slack: false });
    await assert.rejects(without.c.connect("slack", { token: "xoxp-1234-5678" }), /doesn't know that service/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("Jira and Datadog connect the same way, and Jira keeps its board choice", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-connect-"));
  try {
    const { c, keychain } = connector(dir);
    assert.deepEqual(await c.choices(), {});
    await assert.rejects(c.connect("jira", { email: "nope", token: "abcdefgh12" }), /email address/);
    await assert.rejects(c.connect("jira", { email: "me@pure.co", token: "short" }), /Jira API token/);
    assert.deepEqual(await c.connect("jira", { email: "me@pure.co", token: "abcdefgh12" }), { ok: true, name: "jira:me@pure.co" });
    assert.deepEqual(await c.choices(), { jira: { board: 181 } });
    await c.connect("jira", { email: "you@pure.co", token: "abcdefgh12", board: "42.7" });
    assert.deepEqual(keychain.get("cmd-center-jira"), { a: "you@pure.co", secret: "abcdefgh12" });
    assert.deepEqual(await c.choices(), { jira: { board: 42 } });
    await c.disconnect("jira");
    await c.disconnect("jira");
    assert.equal(keychain.has("cmd-center-jira"), false);
    await assert.rejects(c.connect("datadog", { token: "x" }), /Datadog access token/);
    assert.deepEqual(await c.connect("datadog", { token: "dd-token-123" }), { ok: true, name: "datadog:dd-token-123" });
    await c.disconnect("datadog");
    assert.equal(keychain.has("cmd-center-datadog"), false);
    await assert.rejects(c.connect("toString", {}), /doesn't know that service/);
    await assert.rejects(c.disconnect("nope"), (e) => e.code === "input");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a check that names nobody connects without a name", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-connect-"));
  try {
    const c = createConnections({
      dir, jira: {}, datadog: { service: "dd", check: async () => null },
      keychain: { write: async () => {}, remove: async () => {}, account: async () => null },
    });
    assert.deepEqual(await c.connect("datadog", { token: "dd-token-123", extra: null }), { ok: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
