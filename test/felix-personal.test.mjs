import { test } from "node:test";
import assert from "node:assert/strict";
import { createPersonal } from "../personal.mjs";
import {
  createPersonalFelix, findDates, findHabits, findItems, findList, keyWords, nextYearFor, parseDay, plainName, saysNot, splitItems, stem,
} from "../felix-personal.mjs";

process.env.TZ = "Asia/Manila";
// 9:00 AM Friday 30 October 2026 in Manila.
const NOW = Date.parse("2026-10-30T01:00:00Z");

test("words in their plain form, so reading, read and drank match their habits", () => {
  assert.deepEqual(["reading", "reads", "drank", "running", "swimming", "stretches", "exercised", "water", "glass", "berries"].map(stem),
    ["read", "read", "drink", "run", "swim", "stretche", "exercise", "water", "glass", "berry"]);
  assert.deepEqual(keyWords("I just did my reading today"), ["read"]);
  assert.deepEqual(keyWords("Mama's birthday"), ["mama", "birthday"]);
});

test("lists are found by how you'd say them", () => {
  const lists = ["Groceries", "Packing", "Wishlist", "Hardware store"];
  assert.equal(plainName("my grocery list"), "grocery");
  assert.deepEqual(["groceries", "grocery", "my groceries list", "the packing list", "wish list", "wishlist", "hardware store", "Hardware Store list"].map((n) => findList(n, lists)),
    ["Groceries", "Groceries", "Groceries", "Packing", "Wishlist", "Wishlist", "Hardware store", "Hardware store"]);
  assert.deepEqual(["calendar", "shopping", "", "the pr"].map((n) => findList(n, lists)), [null, null, null, null]);
});

test("things to add are split on commas and and, without a leading some", () => {
  assert.deepEqual(splitItems("eggs and milk"), ["eggs", "milk"]);
  assert.deepEqual(splitItems("some eggs, milk, and bread"), ["eggs", "milk", "bread"]);
  assert.deepEqual(splitItems("rice & beans"), ["rice", "beans"]);
  assert.deepEqual(splitItems("sunscreen"), ["sunscreen"]);
});

test("items are found by the same words, then by how they start, on one list or any", () => {
  const items = [{ id: "1", text: "Eggs", list: "Groceries" }, { id: "2", text: "Eggs, a dozen", list: "Packing" }, { id: "3", text: "Milk", list: "Groceries" }];
  assert.deepEqual(findItems("the eggs", items).map((i) => i.id), ["1"]);
  assert.deepEqual(findItems("egg", items).map((i) => i.id), ["1"], "the same word first");
  assert.deepEqual(findItems("eggs, a", items).map((i) => i.id), ["2"]);
  assert.deepEqual(findItems("milk", items, "Packing"), []);
  assert.deepEqual(findItems("bread", items), []);
  assert.deepEqual(findItems("", items), []);
});

test("habits match carefully: every word you said is in the habit, or the habit's last word is in what you said", () => {
  const habits = [{ id: "w", name: "Drink water" }, { id: "r", name: "Read 10 pages" }, { id: "x", name: "Exercise" }, { id: "s", name: "Sleep by 11" }, { id: "n", name: "🧘" }];
  const ids = (said) => findHabits(said, habits).map((h) => h.id);
  assert.deepEqual(ids("drank water"), ["w"]);
  assert.deepEqual(ids("my water"), ["w"]);
  assert.deepEqual(ids("reading"), ["r"]);
  assert.deepEqual(ids("exercised"), ["x"]);
  assert.deepEqual(ids("slept"), ["s"]);
  assert.deepEqual(ids("drank coffee"), [], "the habit's own noun is missing");
  assert.deepEqual(ids("read the news"), []);
  assert.deepEqual(ids("did it"), [], "no meaningful words");
  assert.deepEqual(ids("think so"), []);
});

test("saying it wasn't done never ticks", () => {
  for (const s of ["didn't exercise", "did not read", "skipped water", "forgot my reading", "haven't had water", "no reading today"]) assert.equal(saysNot(s), true, s);
  for (const s of ["drank water", "finished reading", "exercised"]) assert.equal(saysNot(s), false, s);
});

test("dates said in words, with an optional year; days that don't exist are turned down", () => {
  assert.deepEqual(parseDay("November 3"), { month: 11, day: 3, year: null });
  assert.deepEqual(parseDay("nov 3rd, 1948"), { month: 11, day: 3, year: 1948 });
  assert.deepEqual(parseDay("the 3rd of november"), { month: 11, day: 3, year: null });
  assert.deepEqual(parseDay("on 20 dec 2026"), { month: 12, day: 20, year: 2026 });
  assert.deepEqual(parseDay("11/3"), { month: 11, day: 3, year: null });
  assert.deepEqual(parseDay("feb 29"), { month: 2, day: 29, year: null }, "a leap day is a real birthday");
  for (const bad of ["feb 30", "13/1", "at 3", "tomorrow", "smarch 4", ""]) assert.equal(parseDay(bad), null, bad);
  assert.equal(nextYearFor({ month: 12, day: 20 }, "2026-10-30"), 2026);
  assert.equal(nextYearFor({ month: 3, day: 1 }, "2026-10-30"), 2027);
});

test("important dates are found by the words in their title", () => {
  const dates = [{ id: "a", title: "Mama's birthday", kind: "birthday" }, { id: "b", title: "Trip to Baguio", kind: "event" }, { id: "c", title: "Papa's birthday", kind: "birthday" }];
  assert.deepEqual(findDates("mama's birthday", dates).map((d) => d.id), ["a"]);
  assert.deepEqual(findDates("baguio", dates).map((d) => d.id), ["b"]);
  assert.deepEqual(findDates("birthday", dates).map((d) => d.id), ["a", "c"]);
  assert.deepEqual(findDates("mom's birthday", dates), []);
  assert.deepEqual(findDates("", dates), []);
});

test("the facade knows your names, counts its changes, appends to the journal and never ticks a done habit twice", async () => {
  const store = await createPersonal({ file: ":memory:", now: () => NOW });
  const settings = { get: async () => ({ timeoffMe: "me", timeoffAhead: 180, oooCache: 5, mydayPlace: "cebu" }) };
  const asked = [];
  const p = createPersonalFelix({
    store, settings,
    timeOff: { view: async (o) => { asked.push(["timeoff", o]); return { ok: true }; } },
    myDay: { view: async (o) => { asked.push(["myday", o]); return { ok: true }; } },
  });
  const groceries = p.listNamed("groceries");
  assert.equal(groceries.name, "Groceries");
  assert.equal(p.version(), 0);
  p.addItems(groceries.id, "Eggs\nMilk");
  const water = store.addHabit({ name: "Drink water" });
  store.addDate({ kind: "birthday", title: "Mama's birthday", month: 11, day: 3 });
  const k = p.known();
  assert.deepEqual(k.lists, ["Groceries", "Packing", "Wishlist"]);
  assert.deepEqual(k.items.map((i) => [i.text, i.list]), [["Eggs", "Groceries"], ["Milk", "Groceries"]]);
  assert.deepEqual(k.habits, [{ id: water.id, name: "Drink water" }]);
  assert.deepEqual(k.dates.map((d) => d.title), ["Mama's birthday"]);
  p.tickItem(k.items[0].id);
  assert.deepEqual(p.known().items.map((i) => [i.text, i.done]), [["Milk", false], ["Eggs", true]], "ticked items stay known, marked done, so they can still be removed");
  assert.equal(p.checkHabit(water.id).today.done, true);
  const v = p.version();
  assert.equal(p.checkHabit(water.id).today.done, true, "already done stays done, not undone");
  assert.equal(p.version(), v, "and nothing changed");
  assert.equal(p.setHabit(water.id, { done: false }).today.done, false);
  p.journalAppend("Long walk after dinner.");
  p.journalAppend("Called Lola.");
  assert.equal(store.journalDay().entry.text, "Long walk after dinner.\nCalled Lola.");
  assert.equal(p.version(), 6);
  await p.timeoff();
  await p.myday();
  assert.deepEqual(asked, [["timeoff", { me: "me", ahead: 180, cacheMinutes: 5 }], ["myday", { place: "cebu" }]]);
  assert.equal(p.today(), "2026-10-30");
});
