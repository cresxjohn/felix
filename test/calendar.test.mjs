import { test } from "node:test";
import assert from "node:assert/strict";
import { createCalendar, joinLink, toEvent } from "../calendar.mjs";

// 9:00 AM on this Mac's clock.
const NOW = new Date(2026, 9, 30, 9, 0, 0).getTime();
const MIN = 60e3;

test("joinLink takes the Meet link, else the video entry point", () => {
  assert.equal(joinLink({ hangoutLink: "https://meet.google.com/abc" }), "https://meet.google.com/abc");
  assert.equal(joinLink({ conferenceData: { entryPoints: [{ entryPointType: "phone", uri: "tel:1" }, { entryPointType: "video", uri: "https://zoom.us/j/1" }] } }), "https://zoom.us/j/1");
  assert.equal(joinLink({ conferenceData: { entryPoints: [{ entryPointType: "video" }] } }), null);
  assert.equal(joinLink({}), null);
});

test("toEvent shapes a timed event with your answer", () => {
  assert.deepEqual(toEvent({
    id: "e1", summary: "Standup", start: { dateTime: "2026-10-30T09:30:00+08:00" }, end: { dateTime: "2026-10-30T09:45:00+08:00" },
    hangoutLink: "https://meet.google.com/abc", htmlLink: "https://calendar.google.com/event?eid=1", location: "Room 1",
    attendees: [{ email: "a@pure.co", responseStatus: "declined" }, { self: true, responseStatus: "tentative" }],
  }), {
    id: "e1", title: "Standup", start: "2026-10-30T09:30:00+08:00", end: "2026-10-30T09:45:00+08:00", allDay: false,
    join: "https://meet.google.com/abc", link: "https://calendar.google.com/event?eid=1", response: "tentative", location: "Room 1",
  });
});

test("toEvent shapes an all-day event and fills in what's missing", () => {
  assert.deepEqual(toEvent({ id: "e2", start: { date: "2026-10-31" }, end: { date: "2026-11-01" } }), {
    id: "e2", title: "(No title)", start: "2026-10-31T00:00:00", end: "2026-11-01T00:00:00", allDay: true,
    join: null, link: "https://calendar.google.com/", response: null, location: "",
  });
  assert.equal(toEvent({ id: "e3" }).start, undefined);
});

test("toEvent leaves out cancelled events and ones you declined", () => {
  assert.equal(toEvent({ id: "x", status: "cancelled" }), null);
  assert.equal(toEvent({ id: "y", start: { dateTime: "t" }, attendees: [{ self: true, responseStatus: "declined" }] }), null);
});

test("events reads today and the next few days from the work calendar", async () => {
  const asked = [];
  const google = {
    get: async (account, url) => {
      asked.push([account, url]);
      return { items: [{ id: "a", summary: "One", start: { dateTime: "s" }, end: { dateTime: "e" } }, { id: "b", status: "cancelled" }] };
    },
  };
  const cal = createCalendar({ google, now: () => NOW });
  const body = await cal.events();
  assert.equal(body.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual(body.events.map((e) => e.id), ["a"]);
  const [account, url] = asked[0];
  assert.equal(account, "work");
  const u = new URL(url);
  assert.equal(`${u.origin}${u.pathname}`, "https://www.googleapis.com/calendar/v3/calendars/primary/events");
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    timeMin: new Date(2026, 9, 30).toISOString(), timeMax: new Date(new Date(2026, 9, 30).getTime() + 4 * 86400e3).toISOString(),
    singleEvents: "true", orderBy: "startTime", maxResults: "100",
  });
});

test("events are cached for 5 minutes, unless fresh or reset", async () => {
  let calls = 0;
  const clock = { t: NOW };
  const cal = createCalendar({ google: { get: async () => { calls += 1; return {}; } }, now: () => clock.t });
  const first = await cal.events();
  assert.deepEqual(first.events, []);
  clock.t += 4 * MIN;
  assert.equal(await cal.events(), first);
  assert.equal(calls, 1);
  await cal.events({ fresh: true });
  assert.equal(calls, 2);
  cal.reset();
  await cal.events();
  assert.equal(calls, 3);
  clock.t += 5 * MIN;
  await cal.events();
  assert.equal(calls, 4);
});

test("events passes the sign-in's errors on", async () => {
  const cal = createCalendar({ google: { get: async () => { throw Object.assign(new Error("no"), { code: "not-connected" }); } } });
  await assert.rejects(cal.events(), { code: "not-connected" });
});

test("events reads more days when the card shows more, and keeps the ones you declined when Settings asks", async () => {
  const asked = [];
  const declined = { id: "d", summary: "Skip", start: { dateTime: "s" }, end: { dateTime: "e" }, attendees: [{ self: true, responseStatus: "declined" }] };
  const google = { get: async (_account, url) => { asked.push(url); return { items: [declined] }; } };
  const clock = { t: NOW };
  const cal = createCalendar({ google, now: () => clock.t });
  assert.deepEqual((await cal.events({ days: 2 })).events, []);
  const timeMax = (url) => new URL(url).searchParams.get("timeMax");
  assert.equal(timeMax(asked[0]), new Date(new Date(2026, 9, 30).getTime() + 4 * 86400e3).toISOString());
  const kept = await cal.events({ days: 7, declined: true });
  assert.deepEqual(kept.events.map((e) => [e.id, e.response]), [["d", "declined"]]);
  assert.equal(timeMax(asked[1]), new Date(new Date(2026, 9, 30).getTime() + 7 * 86400e3).toISOString());
  // Each window keeps its own answer, for as long as Settings says.
  clock.t += 8 * MIN;
  assert.equal(await cal.events({ days: 7, declined: true, cacheMinutes: 10 }), kept);
  assert.equal(asked.length, 2);
  await cal.events({ days: 7, declined: true });
  assert.equal(asked.length, 3);
  assert.equal(toEvent({ id: "x", start: { dateTime: "s" }, attendees: [{ self: true, responseStatus: "declined" }] }, { declined: true }).response, "declined");
});

test("events between two days ask for exactly those days, and a bad or too long range is turned down", async () => {
  let asked = "";
  const calendar = createCalendar({ google: { get: async (_, url) => { asked = url; return { items: [] }; } } });
  const out = await calendar.between({ from: "2026-11-02", to: "2026-11-06" });
  const q = new URL(asked).searchParams;
  assert.equal(new Date(q.get("timeMin")).getTime(), new Date("2026-11-02T00:00:00").getTime());
  assert.equal(new Date(q.get("timeMax")).getTime(), new Date("2026-11-07T00:00:00").getTime());
  assert.deepEqual(out.events, []);
  await assert.rejects(calendar.between({ from: "2026-11-06", to: "2026-11-02" }), /Give from and to/);
  await assert.rejects(calendar.between({ from: "2026-01-01", to: "2026-12-31" }), /At most 92 days/);
});
