import { test } from "node:test";
import assert from "node:assert/strict";
import { careNudge, createNews, macPresence, quietReason, readyNews, refOf, spanText } from "../felix-presence.mjs";

const NOW = Date.parse("2026-10-30T05:00:00Z");
const URL = "https://github.com/purepm/frontend-monorepo/pull/12247";

test("a PR's short name comes from its link", () => {
  assert.equal(refOf(URL), "fm#12247");
  assert.equal(refOf("https://github.com/purepm/backend-monorepo/pull/7"), "bm#7");
  assert.equal(refOf("odd"), "odd");
});

test("reviews and fixes that just turned ready are news, once; new or already-ready sessions aren't", () => {
  const before = { [URL]: { status: "running" }, [`fix:${URL}`]: { status: "running", tool: "cursor" }, old: { status: "ready" } };
  const after = { [URL]: { status: "ready" }, [`fix:${URL}`]: { status: "ready", tool: "cursor" }, old: { status: "ready" }, brandNew: { status: "ready" } };
  const news = readyNews(before, after, NOW);
  assert.deepEqual(news.map((n) => [n.kind, n.text]), [["review", "Claude's review of fm#12247 is ready."], ["fix", "Cursor's fix of fm#12247 is ready to look at."]]);
  assert.equal(news[0].at, "2026-10-30T05:00:00.000Z");
});

test("whether you're there comes from macOS: idle seconds and a locked screen, read at most every 10 seconds", async () => {
  let calls = 0;
  let clock = 0;
  const run = async (cmd, args) => {
    calls++;
    return args.includes("IOHIDSystem") ? '  | "HIDIdleTime" = 125000000000\n' : '"CGSSessionScreenIsLocked" = Yes';
  };
  const here = macPresence({ run, now: () => clock });
  assert.deepEqual(await here(), { idleSeconds: 125, locked: true });
  await here();
  assert.equal(calls, 2);
  clock += 11_000;
  await here();
  assert.equal(calls, 4);
  const broken = macPresence({ run: async () => { throw new Error("no ioreg"); } });
  assert.deepEqual(await broken(), { idleSeconds: null, locked: false });
  assert.equal(typeof macPresence(), "function");
});

test("Felix keeps quiet when the screen is locked, you're away, or a meeting you haven't declined is on", () => {
  const here = { idleSeconds: 10, locked: false };
  const meeting = { record: { events: [{ onNow: true, allDay: false, yourAnswer: "yes" }] } };
  assert.equal(quietReason({ prefs: {}, presence: { ...here, locked: true } }), "locked");
  assert.equal(quietReason({ prefs: {}, presence: { idleSeconds: 400, locked: false } }), "away");
  assert.equal(quietReason({ prefs: { felixAwayMinutes: 10 }, presence: { idleSeconds: 400, locked: false } }), null);
  assert.equal(quietReason({ prefs: { felixAwayMinutes: 0 }, presence: { idleSeconds: 9999, locked: false } }), null, "0 means only when locked");
  assert.equal(quietReason({ prefs: {}, presence: here, calendar: meeting }), "meeting");
  assert.equal(quietReason({ prefs: { felixQuietMeetings: false }, presence: here, calendar: meeting }), null);
  assert.equal(quietReason({ prefs: {}, presence: here, calendar: { record: { events: [{ onNow: true, allDay: false, yourAnswer: "no" }] } } }), null);
  assert.equal(quietReason({ prefs: {}, presence: here, calendar: { record: { events: [{ onNow: true, allDay: true }] } } }), null);
  assert.equal(quietReason({ prefs: {}, presence: here, calendar: { error: "not connected" } }), null);
  assert.equal(quietReason({ prefs: {}, presence: { idleSeconds: null, locked: false } }), null);
});

test("a stretch of time is said the way people say it", () => {
  assert.deepEqual([spanText(120 * 60_000), spanText(90 * 60_000), spanText(60 * 60_000), spanText(45 * 60_000), spanText(1 * 60_000), spanText(0)],
    ["2 hours", "1 hour and 30 minutes", "1 hour", "45 minutes", "1 minute", "a while"]);
});

test("a break nudge comes after the set stretch since you started or came back, not on a break, three a day at most", () => {
  const prefs = { felixCare: true, felixCareAfter: 120 };
  const shift = { status: "working", startedAt: "2026-10-30T02:00:00Z", breaks: [] };
  assert.equal(careNudge({ prefs, shift, now: NOW, nudges: [] }), "You've been at it for 3 hours without a break. Maybe stand up and stretch for a minute?");
  assert.equal(careNudge({ prefs: { felixCare: false }, shift, now: NOW, nudges: [] }), null);
  assert.equal(careNudge({ prefs, shift: { ...shift, status: "break" }, now: NOW, nudges: [] }), null);
  assert.equal(careNudge({ prefs, shift: { ...shift, startedAt: null }, now: NOW, nudges: [] }), null);
  assert.equal(careNudge({ prefs, shift: { ...shift, breaks: [{ start: "2026-10-30T03:30:00Z", end: "2026-10-30T04:00:00Z" }] }, now: NOW, nudges: [] }), null, "back from a break an hour ago");
  assert.equal(careNudge({ prefs, shift: { ...shift, breaks: [{ start: "2026-10-30T03:30:00Z", end: null }] }, now: NOW, nudges: [] }) !== null, true, "a break with no end doesn't count as coming back");
  assert.equal(careNudge({ prefs, shift, now: NOW, nudges: [NOW - 30 * 60_000] }), null, "nudged half an hour ago");
  assert.equal(careNudge({ prefs, shift, now: NOW, nudges: [NOW - 5, NOW - 4, NOW - 3].map((t) => t - 200 * 60_000) }), null, "three today already");
  assert.match(careNudge({ prefs: { felixCare: true }, shift, now: NOW, nudges: [], pick: 1 }), /^3 hours straight now\./);
});

test("news waits for the page: ready reviews and fixes only with speaking up on, nudges only when due, watchers added", () => {
  let clock = NOW;
  const news = createNews({ now: () => clock });
  const on = { felixSpeakUp: true };
  assert.deepEqual(news.sessions({ [URL]: { status: "running" } }, on), [], "the first look only notes what's there");
  assert.equal(news.sessions({ [URL]: { status: "ready" } }, on).length, 1);
  news.sessions({ [URL]: { status: "running" } }, on);
  assert.deepEqual(news.sessions({ [URL]: { status: "ready" } }, {}), [], "speaking up is off");
  news.sessions({ [URL]: { status: "running" } }, on);
  assert.deepEqual(news.sessions({ [URL]: { status: "ready" } }, { ...on, felixSpeakReviews: false }), []);
  news.sessions({ [`fix:${URL}`]: { status: "running" } }, on);
  assert.deepEqual(news.sessions({ [`fix:${URL}`]: { status: "ready" } }, { ...on, felixSpeakFixes: false }), []);
  const shift = { status: "working", startedAt: "2026-10-30T02:00:00Z", breaks: [] };
  assert.equal(news.care(shift, { felixCare: true }).kind, "care");
  assert.equal(news.care(shift, { felixCare: true }), null, "just nudged");
  news.add([{ id: "w", kind: "watch", text: "Checks passed on fm#1.", at: "" }]);
  assert.deepEqual(news.take().map((n) => n.kind), ["review", "care", "watch"]);
  assert.deepEqual(news.take(), []);
  assert.equal(typeof createNews().take, "function");
});
