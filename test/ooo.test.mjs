import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { TRACKER, createOoo, parseTitle, personFor, plain, toLeave } from "../ooo.mjs";

const NOW = Date.parse("2026-10-30T01:00:00Z");
const TODAY = "2026-10-30";
const MIN = 60e3;
const leave = (summary, from, endExclusive, extra = {}) => ({ summary, start: { date: from }, end: { date: endExclusive }, ...extra });

/** Runs a test body with a fresh temp folder. */
async function inTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-ooo-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

/** A fake work calendar that answers every read with the same events, and counts the reads. */
function fakeGoogle(items) {
  const asked = [];
  return { asked, get: async (account, url) => { asked.push([account, url]); return { items }; } };
}

test("parseTitle reads the tracker's ways of writing a leave", () => {
  assert.deepEqual(parseTitle("Joy M PTO"), { name: "Joy M", kind: "PTO", note: "" });
  assert.deepEqual(parseTitle("Mervs B - PTO (Birthday)"), { name: "Mervs B", kind: "PTO", note: "Birthday" });
  assert.deepEqual(parseTitle("Mae, VL"), { name: "Mae", kind: "VL", note: "" });
  assert.deepEqual(parseTitle("PTO - Jordan"), { name: "Jordan", kind: "PTO", note: "" });
  assert.deepEqual(parseTitle("Ana (VL)"), { name: "Ana", kind: "VL", note: "" });
  assert.deepEqual(parseTitle("Cres - VL"), { name: "Cres", kind: "VL", note: "" });
  assert.deepEqual(parseTitle("Kim: wfh"), { name: "Kim", kind: "WFH", note: "" });
  assert.deepEqual(parseTitle("  Leo   SL  "), { name: "Leo", kind: "SL", note: "" });
});

test("parseTitle reads other ways of writing time off, and marks a title with none as not a leave", () => {
  const read = (t) => { const p = parseTitle(t); return [p.name, p.kind]; };
  assert.deepEqual(read("Kelly Out"), ["Kelly", "Out"]);
  assert.deepEqual(read("Kevin B - UTO"), ["Kevin B", "UTO"]);
  assert.deepEqual(read("Khalid Out of Office"), ["Khalid", "OOO"]);
  assert.deepEqual(read("RUSHTON: OUT OF OFFICE"), ["Rushton", "OOO"]);
  assert.deepEqual(read("Edel - Afternoon Emergency Leave"), ["Edel", "EL"]);
  assert.deepEqual(read("Ryan Buffa Off - Out of Country"), ["Ryan Buffa", "Off"]);
  assert.deepEqual(read("Rushton Limited Availability"), ["Rushton", "Limited"]);
  assert.deepEqual(read("Sed EL - AM"), ["Sed", "EL"]);
  assert.deepEqual(read("PH Holiday"), ["PH", "Holiday"]);
  assert.deepEqual(read("BIG RENT COLLECTION WEEK"), ["BIG Rent Collection Week", null]);
  assert.deepEqual(read("US Team Offsite"), ["US Team Offsite", null]);
  assert.deepEqual(parseTitle("Rhea Santos"), { name: "Rhea Santos", kind: null, note: "" });
  assert.deepEqual(parseTitle("Bo (family trip)"), { name: "Bo", kind: null, note: "family trip" });
  assert.deepEqual(parseTitle("Bo (VL)"), { name: "Bo", kind: "VL", note: "" });
  assert.deepEqual(parseTitle("PTO"), { name: "PTO", kind: "PTO", note: "" });
  assert.deepEqual(parseTitle(""), { name: "", kind: null, note: "" });
  assert.deepEqual(parseTitle(undefined), { name: "", kind: null, note: "" });
});

test("plain makes names easy to match", () => {
  assert.equal(plain("  Joy  M. "), "joy m");
  assert.equal(plain(null), "");
});

test("toLeave turns Google's day-after end into the last day off", () => {
  assert.deepEqual(toLeave(leave("Joy M PTO", "2026-10-29", "2026-10-31")), { name: "Joy M", kind: "PTO", note: "", from: "2026-10-29", to: "2026-10-30" });
  assert.deepEqual(toLeave(leave("Ana VL", "2026-11-02", "2026-11-03")), { name: "Ana", kind: "VL", note: "", from: "2026-11-02", to: "2026-11-02" });
  assert.equal(toLeave({ summary: "Bo VL", start: { date: "2026-03-01" } }).to, "2026-03-01");
  assert.equal(toLeave(leave("Leap PTO", "2028-02-28", "2028-03-01")).to, "2028-02-29");
  assert.equal(toLeave(leave("Team offsite", "2026-10-29", "2026-10-30")), null);
});

test("toLeave drops cancelled and timed events", () => {
  assert.equal(toLeave(leave("Joy PTO", "2026-10-29", "2026-10-30", { status: "cancelled" })), null);
  assert.equal(toLeave({ summary: "Joy PTO", start: { dateTime: "2026-10-29T09:00:00Z" } }), null);
  assert.equal(toLeave({ summary: "Nothing" }), null);
});

test("personFor matches a nickname first, then the display name, then the first name", () => {
  const people = [
    { id: "a", name: "Joy Martinez", nicknames: [], onTeam: true },
    { id: "b", name: "Joy Santos", nicknames: ["Joy M"], onTeam: true },
    { id: "c", name: "Mae Cruz", nicknames: ["Mayet"], onTeam: false },
  ];
  assert.equal(personFor("Joy M.", people).id, "b");
  assert.equal(personFor("joy  santos", people).id, "b");
  // Two Joys: a first name alone, or an unknown second name, matches neither.
  assert.equal(personFor("Joy X", people), null);
  assert.equal(personFor("Joy", people), null);
  assert.equal(personFor("mayet", people).id, "c");
  assert.equal(personFor("Mae", people).id, "c");
  assert.equal(personFor("Zed", people), null);
  assert.equal(personFor("Joy", []), null);
  assert.equal(personFor("Ale Cruz", [{ id: "d", name: "Alejandro Cruz", nicknames: [], onTeam: false }]).id, "d");
  assert.equal(personFor("Kev", [{ id: "e", name: "Kevin Lee", nicknames: [], onTeam: false }]), null);
});

test("out lists who is away, matched to your team, with whole-range flags and unknown names", () => inTemp(async (dir) => {
  const google = fakeGoogle([
    leave("Joy M PTO", "2026-10-29", "2026-11-03"),     // whole week
    leave("Mae - VL (Birthday)", "2026-10-30", "2026-10-31"), // one day
    leave("Rico SL", "2026-10-26", "2026-10-28"),       // ended before
    leave("Zed PTO", "2026-11-02", "2026-11-03"),
    leave("Zed PTO", "2026-11-03", "2026-11-04"),
    leave("Cancelled PTO", "2026-10-30", "2026-10-31", { status: "cancelled" }),
  ]);
  const o = createOoo({ google, dir, now: () => NOW });
  await o.saveTeam([
    { id: "b", name: "Joy Santos", nicknames: ["Joy M"], onTeam: true },
    { id: "c", name: "Mae Cruz", nicknames: [], onTeam: false },
    { id: "d", name: "Dan Reyes", nicknames: [], onTeam: true },
  ]);
  const body = await o.out({ from: TODAY, to: "2026-11-03" });
  assert.equal(body.fetchedAt, new Date(NOW).toISOString());
  assert.deepEqual([body.from, body.to, body.teamSize, body.unknown], [TODAY, "2026-11-03", 2, ["Zed"]]);
  assert.deepEqual(body.out.map((r) => [r.name, r.person, r.onTeam, r.whole, r.kind, r.note]), [
    ["Joy Santos", "b", true, false, "PTO", ""],
    ["Mae Cruz", "c", false, false, "VL", "Birthday"],
    ["Zed", null, false, false, "PTO", ""],
    ["Zed", null, false, false, "PTO", ""],
  ]);
  const one = await o.out({ from: TODAY, to: TODAY });
  assert.deepEqual(one.out.map((r) => [r.name, r.whole]), [["Joy Santos", true], ["Mae Cruz", true]]);

  const [account, url] = google.asked[0];
  assert.equal(account, "work");
  const u = new URL(url);
  assert.equal(u.pathname, `/calendar/v3/calendars/${encodeURIComponent(TRACKER)}/events`);
  assert.deepEqual(Object.fromEntries(u.searchParams), {
    timeMin: `${TODAY}T00:00:00Z`, timeMax: "2026-11-05T00:00:00.000Z", singleEvents: "true", orderBy: "startTime", maxResults: "500",
  });
}));

test("out with no team list leaves everyone unknown, and an empty tracker is fine", () => inTemp(async (dir) => {
  const o = createOoo({ google: fakeGoogle([leave("Joy PTO", TODAY, "2026-10-31")]), dir, now: () => NOW });
  const body = await o.out({ from: TODAY, to: TODAY });
  assert.deepEqual([body.teamSize, body.unknown, body.out[0].person], [0, ["Joy"], null]);
  const empty = createOoo({ google: { get: async () => ({}) }, dir, now: () => NOW });
  assert.deepEqual((await empty.out({ from: TODAY, to: TODAY })).out, []);
}));

test("leaves are cached per range for 5 minutes, unless fresh or reset", () => inTemp(async (dir) => {
  const google = fakeGoogle([]);
  const clock = { t: NOW };
  const o = createOoo({ google, dir, now: () => clock.t });
  await o.out({ from: TODAY, to: TODAY });
  clock.t += 4 * MIN;
  await o.out({ from: TODAY, to: TODAY });
  assert.equal(google.asked.length, 1);
  await o.out({ from: TODAY, to: "2026-10-31" });
  assert.equal(google.asked.length, 2);
  await o.out({ from: TODAY, to: TODAY, fresh: true });
  assert.equal(google.asked.length, 3);
  o.reset();
  await o.out({ from: TODAY, to: TODAY });
  assert.equal(google.asked.length, 4);
  clock.t += 5 * MIN;
  await o.out({ from: TODAY, to: TODAY });
  assert.equal(google.asked.length, 5);
}));

test("saveTeam keeps only well-formed people, cleaned up", () => inTemp(async (dir) => {
  const o = createOoo({ google: fakeGoogle([]), dir: path.join(dir, "new"), now: () => NOW });
  assert.deepEqual(await o.team(), []);
  const saved = await o.saveTeam([
    { id: "a", name: "  Joy Santos ", nicknames: [" Joy M ", "", 7], onTeam: true },
    { name: "Mae", onTeam: "yes" },
    { name: "   " },
    { id: "z", name: 5 },
    null,
    { id: "x".repeat(60), name: "y".repeat(100), nicknames: "Joy" },
  ]);
  assert.deepEqual(saved[0], { id: "a", name: "Joy Santos", nicknames: ["Joy M", "7"], onTeam: true });
  assert.match(saved[1].id, /^p[0-9a-z]+1$/);
  assert.deepEqual([saved[1].name, saved[1].nicknames, saved[1].onTeam], ["Mae", [], false]);
  assert.deepEqual([saved[2].id.length, saved[2].name.length, saved[2].nicknames], [40, 80, []]);
  assert.equal(saved.length, 3);
  assert.deepEqual(await o.team(), saved);
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "new", "team.json"), "utf8")), { people: saved });
  assert.deepEqual(await o.saveTeam("nope"), []);
}));

test("team is empty when the file is broken", () => inTemp(async (dir) => {
  await writeFile(path.join(dir, "team.json"), "{ broken");
  assert.deepEqual(await createOoo({ google: fakeGoogle([]), dir }).team(), []);
  await writeFile(path.join(dir, "team.json"), "{}");
  assert.deepEqual(await createOoo({ google: fakeGoogle([]), dir }).team(), []);
}));

test("roster starts from your list and adds each new tracker name once, team first", () => inTemp(async (dir) => {
  const google = fakeGoogle([
    leave("Joy M PTO", "2026-10-30", "2026-10-31"),
    leave("Mae VL", "2026-10-30", "2026-10-31"),
    leave("Mae VL", "2026-10-30", "2026-10-31"),
    leave("PTO - Al.B", "2026-10-30", "2026-10-31"),
    leave("Ale Nieto PTO", "2026-10-30", "2026-10-31"),
    leave("Alejandro Nieto VL", "2026-10-30", "2026-10-31"),
    leave("PH Holiday", "2026-10-30", "2026-10-31"),
    leave("Big rent week", "2026-10-30", "2026-10-31"),
    leave("Ben PTO", "2026-10-30", "2026-10-31"),
  ]);
  const o = createOoo({ google, dir, now: () => NOW });
  await o.saveTeam([{ id: "b", name: "Joy Santos", nicknames: ["Joy M"], onTeam: true }, { id: "c", name: "Ben Uy", nicknames: [], onTeam: false }]);
  const list = await o.roster();
  assert.deepEqual(list, [
    { id: "b", name: "Joy Santos", nicknames: ["Joy M"], onTeam: true },
    { id: "t3alb", name: "Al.B", nicknames: ["Al.B"], onTeam: false },
    { id: "t2alejandronieto", name: "Alejandro Nieto", nicknames: ["Alejandro Nieto", "Ale Nieto"], onTeam: false },
    { id: "c", name: "Ben Uy", nicknames: ["Ben"], onTeam: false },
    { id: "t4mae", name: "Mae", nicknames: ["Mae"], onTeam: false },
  ]);
  // A year back and 90 days ahead, as two reads.
  const ranges = google.asked.map(([, url]) => new URL(url).searchParams.get("timeMin").slice(0, 10));
  assert.deepEqual(ranges, ["2025-10-30", TODAY]);
  await o.roster();
  assert.equal(google.asked.length, 2);
  await o.roster({ fresh: true });
  assert.equal(google.asked.length, 4);
}));

test("a holiday is the country's, not a person's: flagged, never matched or offered as a new name", () => inTemp(async (dir) => {
  const o = createOoo({ google: fakeGoogle([leave("PH Holiday", TODAY, "2026-10-31"), leave("Phil PTO", TODAY, "2026-10-31")]), dir, now: () => NOW });
  await o.saveTeam([{ id: "p", name: "Phil Ramos", nicknames: [], onTeam: true }]);
  const { out, unknown } = await o.out({ from: TODAY, to: TODAY });
  assert.deepEqual(out.map((l) => [l.name, l.holiday, l.onTeam]), [["PH", true, false], ["Phil Ramos", false, true]]);
  assert.deepEqual(unknown, []);
}));

test("leaves are kept as long as Settings says, for who's out and for the roster", () => inTemp(async (dir) => {
  const google = fakeGoogle([]);
  const clock = { t: NOW };
  const o = createOoo({ google, dir, now: () => clock.t });
  await o.out({ from: TODAY, to: TODAY, cacheMinutes: 15 });
  clock.t += 10 * MIN;
  await o.out({ from: TODAY, to: TODAY, cacheMinutes: 15 });
  assert.equal(google.asked.length, 1);
  await o.out({ from: TODAY, to: TODAY });
  assert.equal(google.asked.length, 2);
  await o.roster({ cacheMinutes: 1 });
  const n = google.asked.length;
  clock.t += 2 * MIN;
  await o.roster({ cacheMinutes: 1 });
  assert.equal(google.asked.length, n + 2);
}));
