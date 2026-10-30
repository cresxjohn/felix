import test from "node:test";
import assert from "node:assert/strict";
import tool from "./team_leave_year.mjs";

const TEAM = [
  { id: "t1mae", name: "Mae", nicknames: ["Mae"], onTeam: true },
  { id: "t2edel", name: "Edel", nicknames: ["Edel", "Dels"], onTeam: true },
  { id: "t3ryan", name: "Ryan L.", nicknames: ["Ryan"], onTeam: false },
];

/**
 * Builds one tracker entry.
 * @param {object} fields
 * @returns {object}
 */
function entry(fields) {
  return { note: "", person: null, onTeam: false, holiday: false, whole: false, ...fields };
}

const ENTRIES = [
  entry({ name: "Mae", kind: "VL", from: "2026-12-28", to: "2027-01-05", person: "t1mae", onTeam: true }),
  entry({ name: "PH", kind: "Holiday", from: "2027-01-01", to: "2027-01-01", holiday: true }),
  entry({ name: "US", kind: "Holiday", from: "2027-01-18", to: "2027-01-18", holiday: true }),
  entry({ name: "Edel", kind: "VL", from: "2027-03-30", to: "2027-04-02", person: "t2edel", onTeam: true }),
  entry({ name: "Edel", kind: "PTO", from: "2027-06-11", to: "2027-06-11", person: "t2edel", onTeam: true, note: "Afternoon" }),
  entry({ name: "Ryan L.", kind: "VL", from: "2027-07-05", to: "2027-07-06", person: "t3ryan" }),
  entry({ name: "Nathacha Valero", kind: "VL", from: "2027-08-02", to: "2027-08-02" }),
  entry({ name: "Mae", kind: "SL", from: "2027-12-30", to: "2028-01-04", person: "t1mae", onTeam: true }),
];

/**
 * Builds a fake ctx whose tracker serves entries overlapping the asked range.
 * @param {object[]} entries
 * @param {{limit?: number, fail?: string}} [options]
 * @returns {{ctx: object, calls: {from: string, to: string}[]}}
 */
function fakeCtx(entries, { limit = Infinity, fail } = {}) {
  const calls = [];
  const ctx = {
    ooo: {
      async out({ from, to }) {
        calls.push({ from, to });
        if (fail) throw new Error(fail);
        const out = entries.filter((item) => item.from <= to && item.to >= from).slice(0, limit);
        return { out, teamSize: 2, unknown: [] };
      },
      async team() {
        return TEAM;
      },
    },
  };
  return { ctx, calls };
}

test("lists the team's VL for a year by person, with working days", async () => {
  const { ctx, calls } = fakeCtx(ENTRIES);
  const result = await tool.run({ year: 2027 }, ctx);
  assert.deepEqual(calls.map((call) => [call.from, call.to]), [
    ["2027-01-01", "2027-03-31"],
    ["2027-04-01", "2027-06-30"],
    ["2027-07-01", "2027-09-30"],
    ["2027-10-01", "2027-12-31"],
  ]);
  assert.deepEqual(result, {
    year: 2027,
    kinds: ["VL"],
    scope: "team",
    count: 2,
    people: [
      { name: "Mae", days: 2, leaves: [{ from: "2026-12-28", to: "2027-01-05", days: 2 }] },
      { name: "Edel", days: 4, leaves: [{ from: "2027-03-30", to: "2027-04-02", days: 4 }] },
    ],
    otherKinds: { PTO: 1, SL: 1 },
    notInYourList: ["Nathacha Valero"],
  });
});

test("gives back no one when nobody on the team has that leave", async () => {
  const { ctx } = fakeCtx([]);
  const result = await tool.run({ year: 2030 }, ctx);
  assert.deepEqual(result, { year: 2030, kinds: ["VL"], scope: "team", count: 0, people: [] });
});

test("covers every kind and everyone, counting half days and clipping to the year", async () => {
  const { ctx } = fakeCtx(ENTRIES);
  const result = await tool.run({ year: 2027, kind: "all", teamOnly: false, holidayRegion: "none" }, ctx);
  assert.equal(result.kinds, "all");
  assert.equal(result.scope, "everyone");
  assert.equal(result.otherKinds, undefined);
  const mae = result.people.find((person) => person.name === "Mae");
  assert.deepEqual(mae, {
    name: "Mae",
    onTeam: true,
    days: 5,
    leaves: [
      { from: "2026-12-28", to: "2027-01-05", days: 3, kind: "VL" },
      { from: "2027-12-30", to: "2028-01-04", days: 2, kind: "SL" },
    ],
  });
  const edel = result.people.find((person) => person.name === "Edel");
  assert.equal(edel.days, 4.5);
  assert.deepEqual(edel.leaves[1], { from: "2027-06-11", to: "2027-06-11", days: 0.5, kind: "PTO", note: "Afternoon" });
  assert.deepEqual(result.people.map((person) => person.name).sort(), ["Edel", "Mae", "Nathacha Valero", "Ryan L."]);
});

test("finds one person by nickname, on or off the team", async () => {
  const { ctx } = fakeCtx(ENTRIES);
  const edel = await tool.run({ year: 2027, person: "dels", kind: ["vacation", "pto"] }, ctx);
  assert.equal(edel.scope, "everyone");
  assert.equal(edel.personFound, true);
  assert.deepEqual(edel.people.map((person) => [person.name, person.days, person.onTeam]), [["Edel", 4.5, true]]);
  const ryan = await tool.run({ year: 2027, person: "Ryan" }, ctx);
  assert.deepEqual(ryan.people, [{ name: "Ryan L.", onTeam: false, days: 2, leaves: [{ from: "2027-07-05", to: "2027-07-06", days: 2 }] }]);
  const nobody = await tool.run({ year: 2027, person: "Zed" }, ctx);
  assert.equal(nobody.personFound, false);
  assert.equal(nobody.count, 0);
});

test("counts holidays of every region when asked", async () => {
  const { ctx } = fakeCtx([
    ...ENTRIES,
    entry({ name: "Mae", kind: "VL", from: "2027-01-18", to: "2027-01-19", person: "t1mae", onTeam: true }),
  ]);
  const ph = await tool.run({ year: 2027 }, ctx);
  const all = await tool.run({ year: 2027, holidayRegion: "all" }, ctx);
  assert.equal(ph.people[0].leaves[1].days, 2);
  assert.equal(all.people[0].leaves[1].days, 1);
});

test("splits a range in halves when the tracker hits its entry limit, without repeats", async () => {
  const many = Array.from({ length: 4 }, (_, index) =>
    entry({ name: "Mae", kind: "VL", from: `2027-02-0${index + 1}`, to: `2027-02-0${index + 1}`, person: "t1mae", onTeam: true }),
  );
  const { ctx, calls } = fakeCtx(many, { limit: 500 });
  const realLimit = await tool.run({ year: 2027 }, ctx);
  assert.equal(realLimit.people[0].leaves.length, 4);
  assert.equal(calls.length, 4);

  const crowded = Array.from({ length: 600 }, (_, index) =>
    entry({ name: `P${index}`, kind: "PTO", from: "2027-01-10", to: "2027-01-10", person: `p${index}`, onTeam: false }),
  );
  const split = fakeCtx([...crowded, ...ENTRIES], { limit: 500 });
  const result = await tool.run({ year: 2027 }, split.ctx);
  assert.ok(split.calls.length > 4);
  assert.ok(split.calls.some((call) => call.from === "2027-01-10" && call.to === "2027-01-10"));
  assert.deepEqual(result.people.map((person) => person.name), ["Mae", "Edel"]);
});

test("defaults to this year in Manila", async () => {
  const { ctx, calls } = fakeCtx([]);
  const result = await tool.run(undefined, ctx);
  const year = Number(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Manila", year: "numeric" }).format(new Date()));
  assert.equal(result.year, year);
  assert.equal(calls[0].from, `${year}-01-01`);
});

test("treats a blank kind as VL and copes with a tracker that gives back nothing", async () => {
  const ctx = { ooo: { out: async () => null, team: async () => { throw new Error("down"); } } };
  const result = await tool.run({ year: "2027", kind: [" "], person: "Mae" }, ctx);
  assert.deepEqual(result.kinds, ["VL"]);
  assert.equal(result.personFound, false);
});

test("explains bad input and a failing tracker plainly", async () => {
  const { ctx } = fakeCtx(ENTRIES);
  await assert.rejects(tool.run({ year: 27.5 }, ctx), /isn't a year/);
  await assert.rejects(tool.run({ year: 2027, kind: "beach" }, ctx), /isn't a kind of leave/);
  const broken = fakeCtx(ENTRIES, { fail: "timeout" });
  await assert.rejects(tool.run({ year: 2027 }, broken.ctx), /vacation tracker couldn't be read for 2027-01-01 to 2027-03-31: timeout/);
});

test("describes itself for Felix", () => {
  assert.equal(tool.name, "team_leave_year");
  assert.equal(tool.inputSchema.type, "object");
  assert.deepEqual(tool.inputSchema.required, []);
  assert.ok(tool.description.length > 0 && tool.step.length > 0);
});
