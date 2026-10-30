import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DATE_KINDS, FILL_IN_DAYS, JOURNAL_MAX, MAX_PER_DAY, MIGRATIONS, MOODS, STARTER_LISTS, createPersonal, daysBetween, iconOf, isLeap, nextOccurrence,
  personalRoute, streaks, upcoming, windowDays,
} from "../personal.mjs";
import { JOURNAL_PROMPTS, promptFor } from "../public/journal-prompts.mjs";

// Felix runs on a Mac in Manila (UTC+8, no daylight saving): habit days start at the Mac's midnight, not UTC's.
process.env.TZ = "Asia/Manila";

const HOUR = 3600e3;
// 9:00 AM on Friday 30 October 2026 in Manila (01:00 UTC).
const NOW = Date.parse("2026-10-30T01:00:00Z");

/** A personal store in memory with a clock the test moves. */
async function store(t = NOW) {
  const clock = { t };
  const p = await createPersonal({ file: ":memory:", now: () => clock.t });
  return { p, clock };
}

/** Sends a request through the personal routes. */
const call = (p, method, pathname, { query = "", body } = {}) => personalRoute(p, { method, pathname, query: new URLSearchParams(query), body });

test("the clock reads Manila's days", () => {
  assert.equal(new Date(NOW).getHours(), 9);
  assert.equal(new Date(Date.parse("2026-10-30T16:00:00Z")).getDate(), 31);
});

// ---------- Days and streaks ----------

test("windowDays gives the last 7 days, or this week from Monday or Sunday", () => {
  assert.deepEqual(windowDays("2026-10-30"), ["2026-10-24", "2026-10-25", "2026-10-26", "2026-10-27", "2026-10-28", "2026-10-29", "2026-10-30"]);
  // Friday Oct 30: the week from Monday Oct 26, and from Sunday Oct 25.
  assert.equal(windowDays("2026-10-30", 1)[0], "2026-10-26");
  assert.equal(windowDays("2026-10-30", 1)[6], "2026-11-01");
  assert.equal(windowDays("2026-10-30", 0)[0], "2026-10-25");
  // On the first day of the week, the week starts today.
  assert.equal(windowDays("2026-10-26", 1)[0], "2026-10-26");
  assert.equal(windowDays("2026-10-25", 1)[0], "2026-10-19");
  // Across a month and a year.
  assert.deepEqual(windowDays("2027-01-02", 1).slice(0, 2), ["2026-12-28", "2026-12-29"]);
  assert.equal(windowDays("2026-10-30", 7)[0], "2026-10-24", "a day number it doesn't know means the last 7 days");
});

test("a streak runs back from today, or from yesterday while today isn't done yet", () => {
  assert.deepEqual(streaks([], "2026-10-30"), { streak: 0, best: 0 });
  assert.deepEqual(streaks(["2026-10-30"], "2026-10-30"), { streak: 1, best: 1 });
  assert.deepEqual(streaks(["2026-10-28", "2026-10-29"], "2026-10-30"), { streak: 2, best: 2 }, "today not ticked yet keeps the streak");
  assert.deepEqual(streaks(["2026-10-28", "2026-10-29", "2026-10-30"], "2026-10-30"), { streak: 3, best: 3 });
  assert.deepEqual(streaks(["2026-10-27", "2026-10-28"], "2026-10-30"), { streak: 0, best: 2 }, "a whole day missed breaks it");
  assert.deepEqual(streaks(["2026-10-25", "2026-10-26", "2026-10-27", "2026-10-29", "2026-10-30"], "2026-10-30"), { streak: 2, best: 3 });
});

test("streaks cross months and years, ignore repeats and order, and leave out days to come", () => {
  assert.deepEqual(streaks(["2026-12-31", "2027-01-01", "2026-12-30"], "2027-01-01"), { streak: 3, best: 3 });
  assert.deepEqual(streaks(["2026-02-28", "2026-03-01"], "2026-03-01"), { streak: 2, best: 2 });
  assert.deepEqual(streaks(["2026-10-30", "2026-10-30", "2026-10-29"], "2026-10-30"), { streak: 2, best: 2 });
  assert.deepEqual(streaks(["2026-10-31", "2026-11-01"], "2026-10-30"), { streak: 0, best: 0 });
});

test("iconOf keeps one emoji (with its joined parts) or one letter", () => {
  assert.equal(iconOf(""), "");
  assert.equal(iconOf("  "), "");
  assert.equal(iconOf(null), "");
  assert.equal(iconOf("💧"), "💧");
  assert.equal(iconOf("💧🏃"), "💧");
  assert.equal(iconOf("👨‍👩‍👧"), "👨‍👩‍👧");
  assert.equal(iconOf("🇵🇭"), "🇵🇭");
  assert.equal(iconOf("✍️"), "✍️");
  assert.equal(iconOf("Water"), "W");
});

// ---------- Habits ----------

test("a habit ticked today has a 1-day streak, and a tap again takes it back", async () => {
  const { p } = await store();
  const h = p.addHabit({ name: "  Drink   water ", icon: "💧" });
  assert.equal(h.name, "Drink water");
  assert.equal(h.perDay, 1);
  assert.equal(h.since, "2026-10-30");
  assert.deepEqual([h.today.done, h.streak], [false, 0]);
  const ticked = p.check(h.id);
  assert.deepEqual([ticked.today.count, ticked.today.done, ticked.streak, ticked.best], [1, true, 1, 1]);
  const undone = p.check(h.id);
  assert.deepEqual([undone.today.count, undone.today.done, undone.streak], [0, false, 0]);
});

test("days follow Manila's midnight, not UTC's: a streak carries over, and breaks only after a whole day missed", async () => {
  // 11:59 PM Thursday Oct 29 in Manila is 15:59 UTC the same day.
  const { p, clock } = await store(Date.parse("2026-10-29T15:59:00Z"));
  const h = p.addHabit({ name: "Read" });
  assert.equal(p.check(h.id).today.day, "2026-10-29");
  // Two minutes later it's 12:01 AM Friday in Manila, though UTC still says Thursday.
  clock.t = Date.parse("2026-10-29T16:01:00Z");
  let board = p.habits();
  assert.equal(board.today, "2026-10-30");
  assert.deepEqual([board.habits[0].today.done, board.habits[0].streak], [false, 1], "yesterday still counts while today is under way");
  assert.equal(board.doneToday, 0);
  assert.equal(p.check(h.id).streak, 2);
  // Saturday passes without it: by 12:30 AM Sunday the streak is gone, but the best stays.
  clock.t = Date.parse("2026-10-31T16:30:00Z");
  board = p.habits();
  assert.equal(board.today, "2026-11-01");
  assert.deepEqual([board.habits[0].streak, board.habits[0].best], [0, 2]);
  // Late on Saturday in Manila (still before midnight) the streak would have held.
  clock.t = Date.parse("2026-10-31T15:30:00Z");
  assert.equal(p.habits().habits[0].streak, 2);
});

test("a habit done several times a day counts a day only when its goal is met, and wraps back to none", async () => {
  const { p } = await store();
  const h = p.addHabit({ name: "Water", perDay: 3 });
  assert.deepEqual([p.check(h.id).today.count, p.check(h.id).today.count], [1, 2]);
  let now = p.habit(h.id);
  assert.deepEqual([now.today.done, now.streak], [false, 0], "2 of 3 isn't done");
  now = p.check(h.id);
  assert.deepEqual([now.today.count, now.today.goal, now.today.done, now.streak], [3, 3, true, 1]);
  assert.equal(p.check(h.id).today.count, 0, "a tap after the goal starts the day over");
  assert.equal(p.check(h.id, { count: 99 }).today.count, 3, "a count is held to the day's goal");
  assert.equal(p.check(h.id, { count: 0 }).today.count, 0);
});

test("a new times-a-day applies from today; past days keep the goal they had", async () => {
  const { p, clock } = await store();
  const h = p.addHabit({ name: "Stretch" });
  p.check(h.id, { day: "2026-10-29" });
  p.check(h.id);
  assert.equal(p.habit(h.id).streak, 2);
  const changed = p.updateHabit(h.id, { perDay: 2 });
  assert.deepEqual([changed.today.count, changed.today.goal, changed.today.done], [1, 2, false], "today now needs 2");
  assert.equal(changed.streak, 1, "yesterday was met at its goal of 1, so it still counts");
  assert.equal(changed.week.find((d) => d.day === "2026-10-29").done, true);
  assert.equal(p.check(h.id).streak, 2);
  // Lowering it holds today's count to the new goal.
  assert.deepEqual([p.updateHabit(h.id, { perDay: 1 }).today.count, p.habit(h.id).today.done], [1, true]);
  // A day not ticked yet uses the goal of today.
  clock.t += 24 * HOUR;
  assert.equal(p.habit(h.id).today.goal, 1);
});

test("past days can be filled in or cleared, but not days to come or long ago", async () => {
  const { p } = await store();
  const h = p.addHabit({ name: "Walk" });
  p.check(h.id, { day: "2026-10-28", count: 1 });
  p.check(h.id, { day: "2026-10-29", count: 1 });
  assert.equal(p.habit(h.id).streak, 2);
  assert.equal(p.check(h.id, { day: "2026-10-29", count: 0 }).streak, 0);
  assert.throws(() => p.check(h.id, { day: "2026-10-31" }), { code: "input", message: /hasn't come yet/ });
  assert.throws(() => p.check(h.id, { day: "2026-08-30" }), { code: "input", message: new RegExp(`last ${FILL_IN_DAYS} days`) });
  assert.doesNotThrow(() => p.check(h.id, { day: "2026-08-31" }));
  for (const bad of ["2026-02-31", "30/10/2026", "yesterday", "2026-1-5"]) assert.throws(() => p.check(h.id, { day: bad }), { code: "input" }, bad);
  assert.throws(() => p.check(h.id, { count: -1 }), { code: "input" });
  assert.throws(() => p.check(h.id, { count: 1.5 }), { code: "input" });
});

test("the board shows each habit's seven days: done, partly done, missed, before it started, and days to come", async () => {
  const { p, clock } = await store(Date.parse("2026-10-27T01:00:00Z"));
  const h = p.addHabit({ name: "Water", perDay: 2 });
  clock.t = NOW;
  p.check(h.id, { day: "2026-10-28", count: 2 });
  p.check(h.id, { day: "2026-10-29", count: 1 });
  p.check(h.id, { day: "2026-10-25", count: 2 });
  const board = p.habits();
  assert.deepEqual(board.days, windowDays("2026-10-30"));
  const by = Object.fromEntries(board.habits[0].week.map((d) => [d.day, d]));
  assert.equal(by["2026-10-24"].before, true);
  assert.deepEqual([by["2026-10-25"].done, by["2026-10-25"].before], [true, false], "a day filled in before the start shows as done");
  assert.equal(by["2026-10-26"].before, true);
  assert.deepEqual([by["2026-10-27"].done, by["2026-10-27"].before], [false, false], "missed");
  assert.equal(by["2026-10-28"].done, true);
  assert.deepEqual([by["2026-10-29"].count, by["2026-10-29"].done], [1, false]);
  assert.equal(board.habits[0].streak, 0, "yesterday was only partly done");
  // This week from Monday runs to Sunday, with the days to come marked.
  const week = p.habits({ weekStart: 1 });
  assert.deepEqual(week.days, windowDays("2026-10-30", 1));
  assert.deepEqual(week.habits[0].week.map((d) => d.future), [false, false, false, false, false, true, true]);
});

test("names, icons and times a day are checked", async () => {
  const { p } = await store();
  assert.throws(() => p.addHabit({ name: "  " }), { code: "input", message: "Give the habit a name." });
  assert.throws(() => p.addHabit({ name: "Water", perDay: 0 }), { code: "input" });
  assert.throws(() => p.addHabit({ name: "Water", perDay: MAX_PER_DAY + 1 }), { code: "input" });
  assert.throws(() => p.addHabit({ name: "Water", perDay: "two" }), { code: "input" });
  assert.equal(p.addHabit({ name: "x".repeat(60) }).name.length, 40);
  const h = p.addHabit({ name: "Read", icon: "📖📚" });
  assert.equal(h.icon, "📖");
  assert.equal(p.updateHabit(h.id, { icon: "" }).icon, "");
  assert.equal(p.updateHabit(h.id, { name: "Read 10 pages" }).name, "Read 10 pages");
  assert.throws(() => p.updateHabit("nope", { name: "x" }), { code: "not-found" });
});

test("archived habits leave the board, keep their days, can't be ticked, and come back at the end", async () => {
  const { p } = await store();
  const a = p.addHabit({ name: "Water" });
  const b = p.addHabit({ name: "Read" });
  p.check(a.id);
  p.updateHabit(a.id, { archived: true });
  let board = p.habits();
  assert.deepEqual(board.habits.map((h) => h.name), ["Read"]);
  assert.deepEqual(board.archived.map((h) => h.name), ["Water"]);
  assert.throws(() => p.check(a.id), { code: "input", message: /Bring the habit back/ });
  p.updateHabit(a.id, { archived: false });
  board = p.habits();
  assert.deepEqual(board.habits.map((h) => h.name), ["Read", "Water"]);
  assert.equal(board.habits[1].today.done, true, "its days were kept");
  assert.equal(board.doneToday, 1);
  p.reorderHabits([a.id, b.id]);
  assert.deepEqual(p.habits().habits.map((h) => h.name), ["Water", "Read"]);
  p.removeHabit(a.id);
  assert.deepEqual(p.habits().habits.map((h) => h.name), ["Read"]);
  assert.deepEqual(p.dump().habitChecks, [], "deleting a habit deletes its check-ins");
});

// ---------- Lists ----------

test("the starter lists are made once, on first use, and don't come back once deleted", async () => {
  const { p } = await store();
  const first = p.lists();
  assert.deepEqual(first.map((l) => l.name), [...STARTER_LISTS]);
  assert.deepEqual(p.lists().map((l) => l.id), first.map((l) => l.id), "asking again doesn't make more");
  for (const l of first) p.removeList(l.id);
  assert.deepEqual(p.lists(), []);
  assert.deepEqual(p.listView(), { lists: [], list: null, items: [] });
});

test("lists can be added, renamed, reordered and deleted, each name used once", async () => {
  const { p } = await store();
  const gifts = p.addList("  Gifts ");
  assert.deepEqual(gifts, { id: gifts.id, name: "Gifts", open: 0, done: 0 });
  assert.deepEqual(p.lists().map((l) => l.name), [...STARTER_LISTS, "Gifts"]);
  assert.throws(() => p.addList("groceries"), { code: "input", message: "You already have a list called groceries." });
  assert.throws(() => p.addList(""), { code: "input", message: "Give the list a name." });
  assert.equal(p.renameList(gifts.id, "Christmas gifts").name, "Christmas gifts");
  assert.equal(p.renameList(gifts.id, "christmas Gifts").name, "christmas Gifts", "a list can change its own name's case");
  assert.throws(() => p.renameList(gifts.id, "Packing"), { code: "input" });
  p.reorderLists([gifts.id]);
  assert.equal(p.lists()[0].id, gifts.id);
  p.addItems(gifts.id, "Book for Mom");
  p.removeList(gifts.id);
  assert.throws(() => p.items(gifts.id), { code: "not-found" });
  assert.deepEqual(p.dump().listItems, [], "a deleted list's items go too");
});

test("items add at the bottom or top, one per line, and ticked ones sink to the bottom struck off", async () => {
  const { p, clock } = await store();
  const [groceries] = p.lists();
  p.addItems(groceries.id, "Eggs");
  p.addItems(groceries.id, "Rice, 5 kg\n\n  Coffee   beans \r\nDish soap");
  assert.deepEqual(p.items(groceries.id).map((i) => i.text), ["Eggs", "Rice, 5 kg", "Coffee beans", "Dish soap"], "a comma stays in the item");
  p.addItems(groceries.id, "Milk\nBread", { at: "top" });
  const items = p.items(groceries.id);
  assert.deepEqual(items.map((i) => i.text), ["Milk", "Bread", "Eggs", "Rice, 5 kg", "Coffee beans", "Dish soap"]);
  clock.t += 60e3;
  const eggs = p.updateItem(items[2].id, { done: true });
  assert.equal(eggs.done, true);
  assert.equal(eggs.doneAt, new Date(clock.t).toISOString());
  p.updateItem(items[0].id, { done: true });
  assert.deepEqual(p.items(groceries.id).map((i) => i.text), ["Bread", "Rice, 5 kg", "Coffee beans", "Dish soap", "Milk", "Eggs"], "ticked go last, in their own order");
  assert.deepEqual(p.items(groceries.id, { tickedLast: false }).map((i) => i.text), ["Milk", "Bread", "Eggs", "Rice, 5 kg", "Coffee beans", "Dish soap"]);
  clock.t += 60e3;
  assert.equal(p.updateItem(eggs.id, { done: true }).doneAt, eggs.doneAt, "ticking again keeps the first time");
  assert.equal(p.updateItem(eggs.id, { done: false }).doneAt, null);
  assert.deepEqual(p.lists().find((l) => l.id === groceries.id), { id: groceries.id, name: "Groceries", open: 5, done: 1 });
  assert.equal(p.clearDone(groceries.id), 1);
  assert.equal(p.items(groceries.id).length, 5);
});

test("items can be changed, deleted and reordered, and say clearly what's wrong", async () => {
  const { p } = await store();
  const [groceries, packing] = p.lists();
  const [a, b, c] = p.addItems(groceries.id, "Eggs\nMilk\nRice");
  const [other] = p.addItems(packing.id, "Charger");
  assert.equal(p.updateItem(a.id, { text: "  Eggs,   a dozen " }).text, "Eggs, a dozen");
  assert.throws(() => p.updateItem(a.id, { text: " " }), { code: "input" });
  assert.throws(() => p.addItems(groceries.id, " \n "), { code: "input", message: "Type what to add." });
  assert.equal(p.addItems(groceries.id, "y".repeat(300))[0].text.length, 200);
  p.reorderItems(groceries.id, [c.id, a.id, b.id, other.id]);
  assert.deepEqual(p.items(groceries.id).slice(0, 3).map((i) => i.id), [c.id, a.id, b.id]);
  assert.deepEqual(p.items(packing.id).map((i) => i.listId), [packing.id], "another list's item stays put");
  p.removeItem(b.id);
  assert.throws(() => p.removeItem(b.id), { code: "not-found", message: "That item isn't there any more." });
});

test("the card's view picks the list asked for, or the first when it's gone", async () => {
  const { p } = await store();
  const [groceries, packing] = p.lists();
  p.addItems(packing.id, "Passport");
  assert.equal(p.listView().list.id, groceries.id);
  const view = p.listView({ list: packing.id });
  assert.deepEqual([view.list.name, view.items.map((i) => i.text), view.lists.length], ["Packing", ["Passport"], 3]);
  assert.equal(p.listView({ list: "gone" }).list.id, groceries.id);
});

// ---------- The file ----------

test("the store's file is made in its folder, keeps everything between openings, and records its steps", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-personal-"));
  try {
    const file = path.join(dir, "nested", "personal.db");
    const first = await createPersonal({ file, now: () => NOW });
    const [groceries] = first.lists();
    first.addItems(groceries.id, "Eggs");
    const h = first.addHabit({ name: "Water" });
    first.check(h.id);
    assert.equal(first.dump().version, MIGRATIONS.length);
    first.close();
    const again = await createPersonal({ file, now: () => NOW });
    assert.deepEqual(again.listView().items.map((i) => i.text), ["Eggs"]);
    assert.equal(again.lists().length, STARTER_LISTS.length, "opening again doesn't make the starter lists twice");
    assert.equal(again.habits().habits[0].streak, 1);
    assert.equal(again.dump().version, MIGRATIONS.length);
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- Routes ----------

test("the lists routes add, change, tick, clear and reorder, with 400s and 404s in plain words", async () => {
  const { p } = await store();
  const view = call(p, "GET", "/api/personal/lists");
  assert.equal(view.status, 200);
  const groceries = view.body.list;
  assert.equal(groceries.name, "Groceries");
  const added = call(p, "POST", `/api/personal/lists/${groceries.id}/items`, { body: { text: "Eggs\nMilk" } });
  assert.deepEqual(added.body.items.map((i) => i.text), ["Eggs", "Milk"]);
  const top = call(p, "POST", `/api/personal/lists/${groceries.id}/items`, { body: { text: "Rice", at: "top" } });
  assert.equal(top.body.items[0].text, "Rice");
  const [rice, eggs, milk] = call(p, "GET", "/api/personal/lists", { query: `list=${groceries.id}` }).body.items;
  assert.deepEqual([rice.text, eggs.text, milk.text], ["Rice", "Eggs", "Milk"]);
  assert.equal(call(p, "POST", `/api/personal/items/${rice.id}`, { body: { patch: { done: true } } }).body.item.done, true);
  assert.deepEqual(call(p, "GET", "/api/personal/lists").body.items.map((i) => i.text), ["Eggs", "Milk", "Rice"]);
  assert.deepEqual(call(p, "GET", "/api/personal/lists", { query: "ticked=stay" }).body.items.map((i) => i.text), ["Rice", "Eggs", "Milk"]);
  assert.deepEqual(call(p, "POST", `/api/personal/lists/${groceries.id}/reorder`, { body: { ids: [milk.id, eggs.id] } }).body, { ok: true });
  assert.deepEqual(call(p, "GET", "/api/personal/lists").body.items.map((i) => i.text), ["Milk", "Eggs", "Rice"]);
  assert.deepEqual(call(p, "POST", `/api/personal/lists/${groceries.id}/clear`).body, { cleared: 1 });
  assert.deepEqual(call(p, "POST", `/api/personal/items/${milk.id}/delete`).body, { ok: true });

  const made = call(p, "POST", "/api/personal/lists", { body: { name: "Hardware store" } });
  assert.equal(made.body.list.name, "Hardware store");
  assert.equal(call(p, "POST", `/api/personal/lists/${made.body.list.id}`, { body: { name: "Hardware" } }).body.list.name, "Hardware");
  assert.deepEqual(call(p, "POST", "/api/personal/lists", { body: { name: "" } }), { status: 400, body: { error: "Give the list a name.", code: "input" } });
  assert.equal(call(p, "POST", "/api/personal/lists", { body: { name: "hardware" } }).status, 400);
  assert.deepEqual(call(p, "POST", `/api/personal/lists/${made.body.list.id}/delete`).body, { ok: true });
  assert.deepEqual(call(p, "POST", `/api/personal/lists/${made.body.list.id}/delete`), { status: 404, body: { error: "That list isn't there any more.", code: "not-found" } });
  assert.equal(call(p, "POST", "/api/personal/items/nope", { body: { patch: { done: true } } }).status, 404);
  assert.equal(call(p, "POST", "/api/personal/lists", { body: null }).status, 400, "a missing body is a plain 400");
});

test("the habits routes add, tick, change, archive and delete", async () => {
  const { p } = await store();
  const made = call(p, "POST", "/api/personal/habits", { body: { name: "Water", icon: "💧", perDay: 2 } });
  assert.equal(made.status, 200);
  const id = made.body.habit.id;
  assert.equal(call(p, "POST", `/api/personal/habits/${id}/check`, { body: {} }).body.habit.today.count, 1);
  assert.equal(call(p, "POST", `/api/personal/habits/${id}/check`, { body: { day: "2026-10-29", count: 2 } }).body.habit.streak, 1);
  let board = call(p, "GET", "/api/personal/habits").body;
  assert.deepEqual([board.today, board.days.length, board.habits.length, board.doneToday], ["2026-10-30", 7, 1, 0]);
  assert.equal(call(p, "GET", "/api/personal/habits", { query: "weekStart=0" }).body.days[0], "2026-10-25");
  assert.equal(call(p, "GET", "/api/personal/habits", { query: "weekStart=9" }).body.days[0], "2026-10-24", "an unknown week start means the last 7 days");
  assert.equal(call(p, "POST", `/api/personal/habits/${id}`, { body: { patch: { perDay: 1 } } }).body.habit.today.done, true);
  assert.equal(call(p, "POST", `/api/personal/habits/${id}/check`, { body: { day: "2026-11-02" } }).status, 400);
  assert.equal(call(p, "POST", `/api/personal/habits/${id}`, { body: { patch: { archived: true } } }).body.habit.archived, true);
  board = call(p, "GET", "/api/personal/habits").body;
  assert.deepEqual([board.habits.length, board.archived.length], [0, 1]);
  const second = call(p, "POST", "/api/personal/habits", { body: { name: "Read" } }).body.habit.id;
  assert.deepEqual(call(p, "POST", "/api/personal/habits/reorder", { body: { ids: [second] } }).body, { ok: true });
  assert.deepEqual(call(p, "POST", `/api/personal/habits/${id}/delete`).body, { ok: true });
  assert.equal(call(p, "POST", `/api/personal/habits/${id}/check`).status, 404);
  assert.equal(call(p, "POST", "/api/personal/habits", { body: { name: "Walk", perDay: 40 } }).status, 400);
});

test("only /api/personal paths are personal routes, and anything else under it is a 404", async () => {
  const { p } = await store();
  assert.equal(call(p, "GET", "/api/tasks"), null);
  assert.equal(call(p, "GET", "/api/personalx"), null);
  for (const [method, pathname] of [["GET", "/api/personal/bills"], ["GET", "/api/personal/lists/abc"], ["DELETE", "/api/personal/lists"],
    ["POST", "/api/personal/lists/abc/nope"], ["POST", "/api/personal/items"], ["POST", "/api/personal/habits/abc/nope"], ["GET", "/api/personal/habits/abc"],
    ["POST", "/api/personal/lists/a/items/b"]]) {
    assert.equal(call(p, method, pathname).status, 404, `${method} ${pathname}`);
  }
  assert.equal(call(p, "POST", "/api/personal/items/%E0%A4%A").status, 400, "a broken address is a 400, not a crash");
});

test("the server gives the personal store to its routes and to Felix's personal commands and tools, never to his facts, briefings or own tools", async () => {
  const src = await readFile(new URL("../server.mjs", import.meta.url), "utf8");
  const code = src.split("\n").filter((l) => !/^\s*\/\//.test(l)).join("\n");
  // The store is the variable `personal`; a key named personal (like the Google status's) isn't it.
  const uses = [...code.matchAll(/\bpersonal\b(?![-.\/"':])/g)].map((m) => code.slice(Math.max(0, m.index - 30), m.index + 30).replace(/\s+/g, " "));
  assert.equal(uses.length, 4, uses.join("\n"));
  assert.equal([...code.matchAll(/personalRoute\(personal, /g)].length, 2);
  assert.match(code, /const personal = await createPersonal\(\{ file: path\.join\(DATA, "personal\.db"\) \}\);/);
  assert.match(code, /const personalFelix = createPersonalFelix\(\{ store: personal, timeOff, myDay, settings \}\);/);
  // Felix reaches it only as his personal commands (createFelix) and his built-in personal_ tools (createTools).
  assert.equal([...code.matchAll(/personal: personalFelix/g)].length, 2);
  assert.equal([...code.matchAll(/\bpersonalFelix\b/g)].length, 3);
  // Never in what his answers and briefings read, nor in what the tools he builds himself can reach.
  const block = (from, to) => code.slice(code.indexOf(from), code.indexOf(to, code.indexOf(from)));
  for (const part of [block("facts: createFacts({", "\n  brain,"), block("const toolCtx = ctxServices({", "\n});")]) {
    assert.ok(part.length > 50);
    assert.doesNotMatch(part, /personal|timeOff|myDay|wais/i);
  }
});

// ---------- Journal ----------

test("each day has its own prompt, steady all day, and Another steps along the list", () => {
  assert.ok(JOURNAL_PROMPTS.length >= 10);
  assert.equal(promptFor("2026-10-30"), promptFor("2026-10-30"));
  assert.notEqual(promptFor("2026-10-30"), promptFor("2026-10-31"));
  assert.notEqual(promptFor("2026-10-30", 1), promptFor("2026-10-30"));
  assert.equal(promptFor("2026-10-30", JOURNAL_PROMPTS.length), promptFor("2026-10-30"), "it comes back round");
  assert.ok(JOURNAL_PROMPTS.includes(promptFor("1999-01-01", -3)));
  const before = process.env.TZ;
  process.env.TZ = "America/Los_Angeles";
  try { assert.equal(promptFor("2026-10-30"), promptFor("2026-10-30")); } finally { process.env.TZ = before; }
});

test("a day's entry saves as you go: words, a mood and the prompt, each on its own", async () => {
  const { p, clock } = await store();
  assert.deepEqual(p.journalDay(), { day: "2026-10-30", today: "2026-10-30", entry: null });
  let e = p.writeJournal("2026-10-30", { text: "Demo went well.", prompt: "Best part of today?" });
  assert.deepEqual([e.day, e.text, e.mood, e.prompt], ["2026-10-30", "Demo went well.", null, "Best part of today?"]);
  clock.t += 60e3;
  e = p.writeJournal("2026-10-30", { mood: "great" });
  assert.deepEqual([e.text, e.mood, e.prompt, e.updatedAt], ["Demo went well.", "great", "Best part of today?", new Date(clock.t).toISOString()]);
  e = p.writeJournal("2026-10-30", { text: "Demo went well.\r\nDinner with Mama." });
  assert.equal(e.text, "Demo went well.\nDinner with Mama.");
  assert.equal(p.writeJournal("2026-10-30", { mood: null }).mood, null, "a mood can be taken back");
  assert.equal(p.journalDay("2026-10-30").entry.text, "Demo went well.\nDinner with Mama.");
  assert.deepEqual(MOODS, ["great", "good", "okay", "low", "rough"]);
  assert.throws(() => p.writeJournal("2026-10-30", { mood: "meh" }), { code: "input" });
  assert.throws(() => p.writeJournal("2026-10-30", { text: "x".repeat(JOURNAL_MAX + 1) }), { code: "input" });
});

test("an entry with no words and no mood is removed, so a day is written or not", async () => {
  const { p } = await store();
  p.writeJournal("2026-10-29", { mood: "low" });
  assert.equal(p.journalDay("2026-10-29").entry.mood, "low");
  assert.equal(p.writeJournal("2026-10-29", { mood: "" }), null);
  assert.equal(p.journalDay("2026-10-29").entry, null);
  p.writeJournal("2026-10-29", { text: "Rainy." });
  assert.equal(p.writeJournal("2026-10-29", { text: "   " }), null);
  assert.deepEqual(p.journalEntries(), []);
});

test("journal days follow Manila's midnight, past days can be written, and days to come can't", async () => {
  // 12:30 AM Saturday Oct 31 in Manila is still Friday in UTC.
  const { p } = await store(Date.parse("2026-10-30T16:30:00Z"));
  assert.equal(p.journalDay().day, "2026-10-31");
  assert.equal(p.writeJournal("2026-10-31", { text: "Late one." }).day, "2026-10-31");
  assert.equal(p.writeJournal("2025-12-25", { text: "Noche Buena." }).day, "2025-12-25");
  assert.throws(() => p.writeJournal("2026-11-01", { text: "x" }), { code: "input", message: /hasn't come yet/ });
  for (const bad of ["2026-02-30", "31/10/2026", "today"]) assert.throws(() => p.journalDay(bad), { code: "input" }, bad);
});

test("earlier entries list the days written, newest first, with their first words", async () => {
  const { p } = await store();
  p.writeJournal("2026-10-28", { text: "  Long   walk\nin the park. " });
  p.writeJournal("2026-10-30", { text: "y".repeat(300), mood: "good" });
  p.writeJournal("2026-10-29", { mood: "rough" });
  const list = p.journalEntries();
  assert.deepEqual(list.map((e) => e.day), ["2026-10-30", "2026-10-29", "2026-10-28"]);
  assert.equal(list[0].preview.length, 120);
  assert.deepEqual(list[1], { day: "2026-10-29", mood: "rough", preview: "" });
  assert.equal(list[2].preview, "Long walk in the park.");
  assert.equal(p.journalEntries({ limit: 1 }).length, 1);
});

// ---------- Important dates ----------

test("a yearly date comes round today, tomorrow, later this year or next year", () => {
  const bday = { kind: "birthday", month: 11, day: 3, year: 1966 };
  assert.deepEqual(nextOccurrence(bday, "2026-10-30"), { on: "2026-11-03", inDays: 4, years: 60 });
  assert.deepEqual(nextOccurrence(bday, "2026-11-03"), { on: "2026-11-03", inDays: 0, years: 60 });
  assert.deepEqual(nextOccurrence(bday, "2026-11-02"), { on: "2026-11-03", inDays: 1, years: 60 });
  assert.deepEqual(nextOccurrence(bday, "2026-11-04"), { on: "2027-11-03", inDays: 364, years: 61 });
  assert.equal(nextOccurrence({ ...bday, year: null }, "2026-10-30").years, null, "no age without a year");
  assert.equal(nextOccurrence({ kind: "anniversary", month: 1, day: 2, year: 2015 }, "2026-12-30").on, "2027-01-02", "across the new year");
  assert.equal(nextOccurrence({ kind: "anniversary", month: 1, day: 2, year: 2015 }, "2026-12-30").years, 12);
  assert.equal(nextOccurrence({ kind: "birthday", month: 3, day: 1, year: 2026 }, "2026-03-01").years, null, "the day itself isn't a first birthday");
});

test("a February 29 birthday falls on February 28 in other years, and on the 29th in leap years", () => {
  assert.deepEqual([isLeap(2024), isLeap(2027), isLeap(2028), isLeap(1900), isLeap(2000)], [true, false, true, false, true]);
  const leapling = { kind: "birthday", month: 2, day: 29, year: 2000 };
  assert.deepEqual(nextOccurrence(leapling, "2027-01-10"), { on: "2027-02-28", inDays: 49, years: 27 });
  assert.deepEqual(nextOccurrence(leapling, "2027-02-28"), { on: "2027-02-28", inDays: 0, years: 27 });
  assert.deepEqual(nextOccurrence(leapling, "2027-03-01"), { on: "2028-02-29", inDays: 365, years: 28 });
  assert.deepEqual(nextOccurrence(leapling, "2028-02-28"), { on: "2028-02-29", inDays: 1, years: 28 });
  assert.equal(daysBetween("2026-12-31", "2027-01-01"), 1);
});

test("a countdown counts to its day, and has no next time once it has passed", () => {
  const trip = { kind: "event", month: 12, day: 20, year: 2026 };
  assert.deepEqual(nextOccurrence(trip, "2026-10-30"), { on: "2026-12-20", inDays: 51, years: null });
  assert.equal(nextOccurrence(trip, "2026-12-20").inDays, 0);
  assert.equal(nextOccurrence(trip, "2026-12-21"), null);
});

test("upcoming keeps the dates within the window, soonest first, up to the limit, from any source", () => {
  const recs = [
    { kind: "event", title: "Trip to Baguio", month: 12, day: 20, year: 2026 },
    { kind: "birthday", title: "Mama's birthday", month: 11, day: 3, year: null },
    { kind: "anniversary", title: "Anniversary", month: 11, day: 14, year: 2016, source: "calendar" },
    { kind: "event", title: "Concert", month: 10, day: 1, year: 2026 },
    { kind: "birthday", title: "Ana's birthday", month: 11, day: 3, year: null },
  ];
  assert.deepEqual(upcoming(recs, "2026-10-30", { ahead: 30, limit: 5 }).map((r) => r.title), ["Ana's birthday", "Mama's birthday", "Anniversary"]);
  assert.deepEqual(upcoming(recs, "2026-10-30", { ahead: 60, limit: 2 }).map((r) => r.title), ["Ana's birthday", "Mama's birthday"]);
  assert.equal(upcoming(recs, "2026-10-30", { ahead: 60, limit: 9 }).at(-1).next.inDays, 51);
});

test("dates are checked: kind, name, a real day, and a year that makes sense", async () => {
  const { p } = await store();
  assert.deepEqual(DATE_KINDS, ["birthday", "anniversary", "event"]);
  assert.equal(p.addDate({ kind: "birthday", title: "Lola", month: 2, day: 29 }).day, 29, "a yearly February 29 is fine");
  assert.throws(() => p.addDate({ kind: "event", title: "Leap party", month: 2, day: 29, year: 2027 }), { code: "input", message: "That day doesn't exist." });
  assert.equal(p.addDate({ kind: "event", title: "Leap party", month: 2, day: 29, year: 2028 }).next.on, "2028-02-29");
  for (const bad of [
    { kind: "holiday", title: "x", month: 1, day: 1 },
    { kind: "birthday", title: " ", month: 1, day: 1 },
    { kind: "birthday", title: "x", month: 13, day: 1 },
    { kind: "birthday", title: "x", month: 4, day: 31 },
    { kind: "birthday", title: "x", month: 4, day: 1, year: 2030 },
    { kind: "birthday", title: "x", month: 4, day: 1, year: 1850 },
    { kind: "event", title: "x", month: 4, day: 1 },
  ]) assert.throws(() => p.addDate(bad), { code: "input" }, JSON.stringify(bad));
});

test("the dates view shows what's coming, keeps passed countdowns in the store, and says what's next when none are close", async () => {
  const { p, clock } = await store();
  const mama = p.addDate({ kind: "birthday", title: "Mama's birthday", month: 11, day: 3, year: 1966 });
  const trip = p.addDate({ kind: "event", title: "Trip to Baguio", month: 12, day: 20, year: 2026 });
  p.addDate({ kind: "event", title: "Concert", month: 10, day: 1, year: 2026 });
  let view = p.datesView({ ahead: 60, limit: 5 });
  assert.equal(view.today, "2026-10-30");
  assert.deepEqual(view.upcoming.map((r) => [r.title, r.next.inDays, r.next.years]), [["Mama's birthday", 4, 60], ["Trip to Baguio", 51, null]]);
  assert.equal(view.later, null);
  assert.deepEqual(view.all.map((r) => r.title), ["Mama's birthday", "Trip to Baguio", "Concert"], "the passed countdown is kept, last");
  assert.equal(view.all[2].next, null);
  view = p.datesView({ ahead: 2, limit: 5 });
  assert.deepEqual([view.upcoming.length, view.later.title], [0, "Mama's birthday"]);
  // From another source, like a calendar later on: shown the same way, not saved.
  view = p.datesView({ ahead: 60, more: [{ id: "cal1", kind: "event", title: "Wedding", month: 11, day: 1, year: 2026, source: "calendar" }] });
  assert.deepEqual(view.upcoming.map((r) => r.title), ["Wedding", "Mama's birthday", "Trip to Baguio"]);
  assert.equal(p.dump().dates.length, 3);
  // Changing and deleting.
  assert.equal(p.updateDate(trip.id, { title: "Baguio" }).month, 12, "fields left out stay");
  assert.equal(p.updateDate(mama.id, { year: null }).next.years, null);
  assert.throws(() => p.updateDate(mama.id, { day: 31, month: 11 }), { code: "input" });
  p.removeDate(trip.id);
  assert.throws(() => p.removeDate(trip.id), { code: "not-found", message: "That date isn't there any more." });
  // Mama's birthday is today four days on, and the trip would have dropped off after its day.
  clock.t += 4 * 24 * HOUR;
  assert.equal(p.datesView().upcoming[0].next.inDays, 0);
});

// ---------- Upgrading the file ----------

test("a file from before the journal and dates gets their tables on its next opening, keeping what it had", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-personal-up-"));
  try {
    const file = path.join(dir, "personal.db");
    const { DatabaseSync } = await import("node:sqlite");
    const old = new DatabaseSync(file);
    old.exec(MIGRATIONS[0]);
    old.exec("PRAGMA user_version = 1");
    old.prepare("INSERT INTO lists (id, name, position, created_at, updated_at) VALUES ('l1', 'Groceries', 0, 'x', 'x')").run();
    old.prepare("INSERT INTO meta (key, value) VALUES ('listsSeeded', 'x')").run();
    old.close();
    const p = await createPersonal({ file, now: () => NOW });
    assert.equal(p.dump().version, MIGRATIONS.length);
    assert.deepEqual(p.lists().map((l) => l.name), ["Groceries"]);
    assert.equal(p.writeJournal("2026-10-30", { text: "First entry." }).text, "First entry.");
    assert.equal(p.addDate({ kind: "birthday", title: "Mama", month: 11, day: 3 }).next.inDays, 4);
    p.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------- Routes, batch 2 ----------

test("the journal routes read a day with the days written, and save words and moods", async () => {
  const { p } = await store();
  let r = call(p, "GET", "/api/personal/journal");
  assert.deepEqual(r.body, { today: "2026-10-30", day: "2026-10-30", entry: null, earlier: [] });
  r = call(p, "POST", "/api/personal/journal/2026-10-30", { body: { text: "Good day.", prompt: "Best part of today?" } });
  assert.equal(r.body.entry.text, "Good day.");
  r = call(p, "POST", "/api/personal/journal/2026-10-30", { body: { mood: "good" } });
  assert.deepEqual([r.body.entry.text, r.body.entry.mood], ["Good day.", "good"], "a mood alone leaves the words");
  call(p, "POST", "/api/personal/journal/2026-10-29", { body: { text: "Rainy.", extra: "ignored" } });
  r = call(p, "GET", "/api/personal/journal", { query: "day=2026-10-29" });
  assert.deepEqual([r.body.day, r.body.entry.text, r.body.earlier.map((e) => e.day)], ["2026-10-29", "Rainy.", ["2026-10-30", "2026-10-29"]]);
  assert.deepEqual(call(p, "POST", "/api/personal/journal/2026-10-29", { body: { text: "" } }).body, { entry: null });
  assert.equal(call(p, "POST", "/api/personal/journal/2026-11-30", { body: { text: "x" } }).status, 400);
  assert.equal(call(p, "GET", "/api/personal/journal", { query: "day=soon" }).status, 400);
  assert.equal(call(p, "POST", "/api/personal/journal").status, 404);
  assert.equal(call(p, "POST", "/api/personal/journal/2026-10-30/x").status, 404);
});

test("the dates routes add, list, change and delete, holding the window and rows to sensible sizes", async () => {
  const { p } = await store();
  const made = call(p, "POST", "/api/personal/dates", { body: { kind: "birthday", title: "Mama's birthday", month: 11, day: 3, year: 1966 } });
  assert.deepEqual([made.status, made.body.date.next.years], [200, 60]);
  call(p, "POST", "/api/personal/dates", { body: { kind: "event", title: "Trip to Baguio", month: 12, day: 20, year: 2026 } });
  assert.deepEqual(call(p, "GET", "/api/personal/dates", { query: "ahead=30&limit=4" }).body.upcoming.map((r) => r.title), ["Mama's birthday"]);
  assert.equal(call(p, "GET", "/api/personal/dates", { query: "ahead=9999&limit=0" }).body.upcoming.length, 1, "a year at most, and one row at least");
  assert.equal(call(p, "GET", "/api/personal/dates", { query: "ahead=x" }).body.upcoming.length, 2, "60 days when unreadable");
  const id = made.body.date.id;
  assert.equal(call(p, "POST", `/api/personal/dates/${id}`, { body: { patch: { title: "Mama" } } }).body.date.title, "Mama");
  assert.equal(call(p, "POST", "/api/personal/dates", { body: { kind: "event", title: "x", month: 2, day: 30, year: 2027 } }).status, 400);
  assert.deepEqual(call(p, "POST", `/api/personal/dates/${id}/delete`).body, { ok: true });
  assert.equal(call(p, "POST", `/api/personal/dates/${id}`, { body: { patch: { title: "x" } } }).status, 404);
  assert.equal(call(p, "GET", "/api/personal/dates/abc").status, 404);
});
