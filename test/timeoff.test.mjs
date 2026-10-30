import { test } from "node:test";
import assert from "node:assert/strict";
import { breaks, createTimeOff, daysFrom, eachDay, isPhHoliday, isWeekend, nextBreak, timeOffView, workDays } from "../timeoff.mjs";

// Felix runs in Manila; days here are calendar days, so the zone only matters for addDays.
process.env.TZ = "Asia/Manila";

// Friday 30 October 2026.
const TODAY = "2026-10-30";
const ph = (day, name = "") => ({ day, name });

test("weekends, days between and runs of days", () => {
  assert.deepEqual(["2026-10-30", "2026-10-31", "2026-11-01", "2026-11-02"].map(isWeekend), [false, true, true, false]);
  assert.equal(daysFrom("2026-12-31", "2027-01-02"), 2);
  assert.deepEqual(eachDay("2026-02-27", "2026-03-02"), ["2026-02-27", "2026-02-28", "2026-03-01", "2026-03-02"]);
});

test("a holiday on a Saturday or Sunday alone isn't a break", () => {
  assert.deepEqual(breaks({ leaves: [], holidays: [ph("2026-11-01", "All Saints' Day")] }), []);
  assert.deepEqual(breaks({ leaves: [], holidays: [ph("2026-04-04"), ph("2026-04-05")] }), []);
});

test("a Monday holiday makes a long weekend, and a Sunday holiday next to it adds no extra day", () => {
  assert.deepEqual(breaks({ leaves: [], holidays: [ph("2026-11-01", "All Saints' Day"), ph("2026-11-02", "All Souls' Day")] }), [
    { from: "2026-10-31", to: "2026-11-02", days: 3, leaveDays: 0, kinds: [], holidays: [ph("2026-11-02", "All Souls' Day")] },
  ]);
});

test("a leave across a weekend is one break, counting the weekend days off but not as leave", () => {
  // Thursday Nov 12 to Tuesday Nov 17.
  const [b] = breaks({ leaves: [{ kind: "VL", from: "2026-11-12", to: "2026-11-17" }], holidays: [] });
  assert.deepEqual(b, { from: "2026-11-12", to: "2026-11-17", days: 6, leaveDays: 4, kinds: ["VL"], holidays: [] });
  // A Friday off is a three-day weekend.
  assert.deepEqual(breaks({ leaves: [{ kind: "PTO", from: "2026-11-13", to: "2026-11-13" }], holidays: [] })[0], {
    from: "2026-11-13", to: "2026-11-15", days: 3, leaveDays: 1, kinds: ["PTO"], holidays: [],
  });
});

test("holidays next to a leave join it, and leave days don't count the holidays", () => {
  const holidays = [ph("2026-12-24", "Christmas Eve"), ph("2026-12-25", "Christmas Day"), ph("2026-12-30", "Rizal Day"), ph("2027-01-01", "New Year's Day")];
  const [b] = breaks({ leaves: [{ kind: "VL", from: "2026-12-28", to: "2027-01-01" }], holidays });
  assert.equal(b.from, "2026-12-24");
  assert.equal(b.to, "2027-01-03");
  assert.equal(b.days, 11);
  assert.equal(b.leaveDays, 3, "Dec 28, 29 and 31: Rizal Day and New Year's Day are holidays");
  assert.deepEqual(b.holidays.map((h) => h.name), ["Christmas Eve", "Christmas Day", "Rizal Day", "New Year's Day"]);
  assert.equal(workDays({ from: "2026-12-28", to: "2027-01-01" }, new Set(holidays.map((h) => h.day))), 3);
});

test("two leaves with only a weekend between them are one break; a work day between makes two", () => {
  const one = breaks({ leaves: [{ kind: "VL", from: "2026-11-12", to: "2026-11-13" }, { kind: "Offset", from: "2026-11-16", to: "2026-11-16" }], holidays: [] });
  assert.deepEqual(one.map((b) => [b.from, b.to, b.leaveDays, b.kinds.join("+")]), [["2026-11-12", "2026-11-16", 3, "VL+Offset"]]);
  const two = breaks({ leaves: [{ kind: "VL", from: "2026-11-12", to: "2026-11-12" }, { kind: "VL", from: "2026-11-16", to: "2026-11-16" }], holidays: [] });
  assert.equal(two.length, 2);
});

test("the next break is the one you're on, else the soonest to come", () => {
  const list = breaks({ leaves: [{ kind: "VL", from: "2026-10-28", to: "2026-11-03" }, { kind: "PTO", from: "2026-12-21", to: "2026-12-22" }], holidays: [] });
  const now = nextBreak(list, TODAY);
  assert.deepEqual([now.from, now.to, now.now, now.inDays], ["2026-10-28", "2026-11-03", true, 0]);
  const later = nextBreak(list, "2026-11-04");
  assert.deepEqual([later.from, later.now, later.inDays], ["2026-12-19", false, 45]);
  assert.equal(nextBreak(list, "2027-01-01"), null);
});

test("the view: next break, booked leave, a plain note for weekend holidays, and this year's days by kind", () => {
  const holidays = [ph("2026-01-01", "New Year's Day"), ph("2026-11-01", "All Saints' Day"), ph("2026-11-02", "All Souls' Day"), ph("2026-11-30", "Bonifacio Day")];
  const mine = [
    { kind: "PTO", from: "2025-12-29", to: "2026-01-02" }, // only Jan 2 is this year's work day (Jan 1 is a holiday)
    { kind: "PTO", from: "2026-06-15", to: "2026-06-19" },
    { kind: "VL", from: "2026-10-20", to: "2026-10-21" },
    { kind: "VL", from: "2026-12-21", to: "2026-12-23" },
  ];
  const v = timeOffView({ mine, holidays, today: TODAY, ahead: 180 });
  assert.deepEqual([v.next.from, v.next.to, v.next.days, v.next.inDays], ["2026-10-31", "2026-11-02", 3, 1]);
  assert.deepEqual(v.weekendHolidays, [], "Nov 1 is inside the next break, so there's nothing to point out");
  assert.deepEqual(v.booked.map((l) => [l.from, l.kind, l.days]), [["2026-12-21", "VL", 3]]);
  assert.deepEqual(v.year, { kinds: [{ kind: "PTO", days: 6 }, { kind: "VL", days: 2 }], total: 8 });
  // With only a Sunday holiday ahead, the card says it isn't a day off.
  const sundayOnly = timeOffView({ mine: [], holidays: [ph("2026-11-01", "All Saints' Day")], today: TODAY, ahead: 180 });
  assert.equal(sundayOnly.next, null);
  assert.deepEqual(sundayOnly.weekendHolidays, [ph("2026-11-01", "All Saints' Day")]);
});

test("only Philippine holiday rows count", () => {
  assert.deepEqual(["PH Holiday", "Philippines Holiday", "US Pure Holiday", "Colombia Holiday", "Alvin Local Holiday"].map((name) => isPhHoliday({ name })), [true, true, false, false, false]);
});

/** A tracker that answers from fixed rows, counting its reads. */
function fakeOoo(rows, people) {
  const calls = [];
  return {
    calls,
    team: async () => people,
    out: async ({ from, to }) => {
      calls.push([from, to]);
      return { fetchedAt: "2026-10-30T01:00:00.000Z", out: rows.filter((r) => r.from <= to && r.to >= from) };
    },
  };
}
const PEOPLE = [{ id: "t62cres", name: "Cres", nicknames: ["Cres"], onTeam: true }, { id: "p1", name: "Joy M", nicknames: [], onTeam: true }, { id: "p2", name: "Ana", nicknames: [], onTeam: false }];
const ROWS = [
  { name: "Cres", kind: "PTO", note: "", from: "2026-10-20", to: "2026-10-21", person: "t62cres", holiday: false },
  { name: "Cres", kind: "VL", note: "", from: "2026-12-21", to: "2026-12-23", person: "t62cres", holiday: false },
  { name: "Joy M", kind: "VL", note: "", from: "2026-11-03", to: "2026-11-03", person: "p1", holiday: false },
  { name: "PH Holiday", kind: "Holiday", note: "", from: "2026-11-02", to: "2026-11-02", person: null, holiday: true },
  { name: "US Pure Holiday", kind: "Holiday", note: "", from: "2026-11-26", to: "2026-11-27", person: null, holiday: true },
];

test("until you pick yourself, the card gets your team list to pick from, your team first", async () => {
  const t = createTimeOff({ ooo: fakeOoo(ROWS, PEOPLE), today: () => TODAY });
  const v = await t.view({ me: "" });
  assert.deepEqual([v.needsMe, v.gone, v.people.map((p) => p.name)], [true, false, ["Cres", "Joy M", "Ana"]]);
  assert.equal((await t.view({ me: "someone-gone" })).gone, true);
  const again = await t.view({ me: "t62cres", pick: true });
  assert.deepEqual([again.needsMe, again.gone], [true, false]);
});

test("the view reads this year and the months ahead, keeps only your leave and PH holidays, and names holidays when it can", async () => {
  const ooo = fakeOoo(ROWS, PEOPLE);
  const t = createTimeOff({ ooo, today: () => TODAY, holidayNames: async () => new Map([["2026-11-02", "All Souls' Day"]]) });
  const v = await t.view({ me: "t62cres", ahead: 90 });
  assert.deepEqual(ooo.calls, [["2026-01-01", TODAY], [TODAY, "2027-01-28"]]);
  assert.deepEqual(v.me, { id: "t62cres", name: "Cres" });
  assert.deepEqual([v.next.from, v.next.to, v.next.holidays], ["2026-10-31", "2026-11-02", [ph("2026-11-02", "All Souls' Day")]]);
  assert.deepEqual(v.booked.map((l) => l.kind), ["VL"], "Joy's leave isn't yours; the PTO has passed");
  assert.deepEqual(v.year.kinds, [{ kind: "PTO", days: 2 }]);
  // Holiday names are a nice-to-have: without them, the days still count.
  const plain = await createTimeOff({ ooo: fakeOoo(ROWS, PEOPLE), today: () => TODAY, holidayNames: async () => { throw new Error("no"); } }).view({ me: "t62cres" });
  assert.deepEqual(plain.next.holidays, [ph("2026-11-02", "")]);
});

test("a leave running through today, read in both ranges, counts once and makes you on a break now", async () => {
  const rows = [...ROWS, { name: "Cres", kind: "SL", note: "", from: "2026-10-29", to: "2026-10-30", person: "t62cres", holiday: false }];
  const v = await createTimeOff({ ooo: fakeOoo(rows, PEOPLE), today: () => TODAY }).view({ me: "t62cres" });
  assert.deepEqual(v.year.kinds, [{ kind: "PTO", days: 2 }, { kind: "SL", days: 2 }]);
  assert.deepEqual([v.next.from, v.next.to, v.next.now, v.next.leaveDays], ["2026-10-29", "2026-11-02", true, 2]);
  assert.equal(v.booked.filter((l) => l.kind === "SL").length, 1);
});
