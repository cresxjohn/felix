/**
 * Personal: the Personal mode's own things, saved on this Mac in Node's built-in SQLite (data/personal.db): lists
 * (groceries, packing, a wishlist), habits with their daily check-ins, the journal (one entry a day) and important
 * dates (birthdays, anniversaries and countdowns). Nothing here reaches Work mode or Felix's work tools: the server
 * hands this store only to the /api/personal routes.
 *
 * Days are YYYY-MM-DD in this Mac's time zone (Asia/Manila), so a habit's day starts and ends at the Mac's midnight.
 * Later cards (journal, important dates, bills) add their tables as a new step at the end of MIGRATIONS: a file made
 * by an older Felix catches up on its next opening, and the steps already done are never run again.
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { codedError } from "./keychain.mjs";
import { addDays, ymd } from "./tasks.mjs";

/** The lists made the first time the Lists card opens. Deleting them later doesn't bring them back. */
export const STARTER_LISTS = Object.freeze(["Groceries", "Packing", "Wishlist"]);
/** The most times a day a habit can ask for. */
export const MAX_PER_DAY = 12;
/** How far back a habit's day can be filled in or changed. */
export const FILL_IN_DAYS = 60;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The database's steps, in order. Each runs once, in a transaction, and PRAGMA user_version counts how many have run.
 * Add new tables as a new step at the end; never change a step that has shipped.
 * @type {ReadonlyArray<string>}
 */
export const MIGRATIONS = Object.freeze([
  // 1: lists and their items, habits and their check-ins, and a small key-value table for one-off flags.
  `CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE lists (id TEXT PRIMARY KEY, name TEXT NOT NULL, position REAL NOT NULL DEFAULT 0,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE UNIQUE INDEX lists_name ON lists(name COLLATE NOCASE);
   CREATE TABLE list_items (id TEXT PRIMARY KEY, list_id TEXT NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
     text TEXT NOT NULL, position REAL NOT NULL DEFAULT 0, done_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE INDEX list_items_list ON list_items(list_id, position);
   CREATE TABLE habits (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL DEFAULT '',
     per_day INTEGER NOT NULL DEFAULT 1, position REAL NOT NULL DEFAULT 0, archived_at TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE habit_checks (habit_id TEXT NOT NULL REFERENCES habits(id) ON DELETE CASCADE, day TEXT NOT NULL,
     count INTEGER NOT NULL, goal INTEGER NOT NULL, PRIMARY KEY (habit_id, day));`,
  // 2: the journal, one row a day, and important dates. A date's `source` says where it came from: "me" for one you
  // added; a later source (a calendar, something you told Felix) keeps its own id in `source_id`.
  `CREATE TABLE journal (day TEXT PRIMARY KEY, text TEXT NOT NULL DEFAULT '', mood TEXT, prompt TEXT NOT NULL DEFAULT '',
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE TABLE dates (id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, month INTEGER NOT NULL,
     day INTEGER NOT NULL, year INTEGER, source TEXT NOT NULL DEFAULT 'me', source_id TEXT,
     created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
   CREATE UNIQUE INDEX dates_source ON dates(source, source_id) WHERE source_id IS NOT NULL;`,
]);

/** How a journal day went, from best to worst; none is fine too. */
export const MOODS = Object.freeze(["great", "good", "okay", "low", "rough"]);
/** The longest journal entry, in characters. */
export const JOURNAL_MAX = 10000;
/** Kinds of important date: the first two come back every year, an event happens once. */
export const DATE_KINDS = Object.freeze(["birthday", "anniversary", "event"]);

/**
 * Whether a year has a February 29.
 * @param {number} y
 * @returns {boolean}
 */
export const isLeap = (y) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/**
 * Days from one YYYY-MM-DD day to another, by the calendar.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export const daysBetween = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400e3);

/**
 * A day as YYYY-MM-DD from its numbers.
 * @param {number} y
 * @param {number} m 1-12
 * @param {number} d
 * @returns {string}
 */
const dayText = (y, m, d) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

/**
 * When an important date next comes round, from today on. A yearly date on February 29 falls on February 28 in other
 * years. A one-off event that has passed has no next time.
 * @param {{ kind: string, month: number, day: number, year: number | null }} rec
 * @param {string} today YYYY-MM-DD
 * @returns {{ on: string, inDays: number, years: number | null } | null} `years` is the age or the anniversary's
 *   number when the year is known, else null.
 */
export function nextOccurrence(rec, today) {
  if (rec.kind === "event") {
    const on = dayText(rec.year, rec.month, rec.day);
    return on < today ? null : { on, inDays: daysBetween(today, on), years: null };
  }
  const onIn = (y) => dayText(y, rec.month, rec.month === 2 && rec.day === 29 && !isLeap(y) ? 28 : rec.day);
  let y = Number(today.slice(0, 4));
  if (onIn(y) < today) y += 1;
  const on = onIn(y);
  return { on, inDays: daysBetween(today, on), years: rec.year && y > rec.year ? y - rec.year : null };
}

/**
 * The important dates coming up within `ahead` days, soonest first, at most `limit` of them. Takes records from any
 * source: the ones you added, and later ones from calendars or from what you told Felix.
 * @template {{ kind: string, title: string, month: number, day: number, year: number | null }} T
 * @param {T[]} records
 * @param {string} today
 * @param {{ ahead?: number, limit?: number }} [options]
 * @returns {Array<T & { next: { on: string, inDays: number, years: number | null } }>}
 */
export function upcoming(records, today, { ahead = 60, limit = 5 } = {}) {
  return records.map((r) => ({ ...r, next: nextOccurrence(r, today) }))
    .filter((r) => r.next && r.next.inDays <= ahead)
    .sort((a, b) => a.next.inDays - b.next.inDays || a.title.localeCompare(b.title))
    .slice(0, Math.max(0, limit));
}

/**
 * @typedef {{ id: string, name: string, open: number, done: number }} List
 * @typedef {{ id: string, listId: string, text: string, done: boolean, doneAt: string | null, position: number }} Item
 * @typedef {{ day: string, count: number, goal: number, done: boolean, future: boolean, before: boolean }} HabitDay
 * @typedef {{ id: string, name: string, icon: string, perDay: number, since: string, today: HabitDay, streak: number,
 *   best: number, week: HabitDay[] }} Habit
 */

/**
 * The day of the week of a YYYY-MM-DD day: 0 for Sunday to 6 for Saturday.
 * @param {string} day
 * @returns {number}
 */
const weekday = (day) => new Date(`${day}T12:00:00`).getDay();

/**
 * The seven days a habit row shows: the last seven ending today, or this week from the day it starts on.
 * @param {string} today YYYY-MM-DD
 * @param {number | null} [weekStart] 0 (Sunday) to 6 (Saturday) for this week; null for the last seven days.
 * @returns {string[]} Seven days, oldest first.
 */
export function windowDays(today, weekStart = null) {
  const start = Number.isInteger(weekStart) && weekStart >= 0 && weekStart <= 6
    ? addDays(today, -((weekday(today) - weekStart + 7) % 7))
    : addDays(today, -6);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/**
 * A habit's streaks from the days it was done in full. Today still counts while it's under way: until you tick it,
 * the streak runs to yesterday, so it only breaks once a whole day has passed without it.
 * @param {Iterable<string>} doneDays YYYY-MM-DD days whose goal was met, in any order.
 * @param {string} today YYYY-MM-DD
 * @returns {{ streak: number, best: number }} The days in a row up to now, and the longest run ever.
 */
export function streaks(doneDays, today) {
  const days = [...new Set(doneDays)].filter((d) => d <= today).sort();
  const set = new Set(days);
  let streak = 0;
  for (let d = set.has(today) ? today : addDays(today, -1); set.has(d); d = addDays(d, -1)) streak += 1;
  let best = 0;
  let run = 0;
  let prev = null;
  for (const d of days) {
    run = prev && addDays(prev, 1) === d ? run + 1 : 1;
    best = Math.max(best, run);
    prev = d;
  }
  return { streak, best };
}

/**
 * The first character you'd see of an icon: one emoji (with its skin tone or joined parts) or one letter.
 * @param {unknown} text
 * @returns {string} Empty for no icon.
 */
export function iconOf(text) {
  const t = String(text ?? "").trim();
  if (!t) return "";
  const [first] = new Intl.Segmenter("en", { granularity: "grapheme" }).segment(t);
  const icon = first?.segment || "";
  if (icon.length > 16 || /\p{Cc}/u.test(icon)) throw codedError("input", "An icon is one emoji or one letter.");
  return icon;
}

/**
 * Opens the personal store.
 * @param {{ file: string, now?: () => number, Database?: any }} options `file` is the SQLite file, or ":memory:".
 */
export async function createPersonal({ file, now = Date.now, Database }) {
  if (!Database) ({ DatabaseSync: Database } = await import("node:sqlite"));
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  migrate();

  const iso = () => new Date(now()).toISOString();
  const today = () => ymd(now());
  const newId = (prefix) => `${prefix}${now().toString(36)}${randomBytes(4).toString("hex")}`;

  /** Runs the steps in MIGRATIONS this file hasn't had yet. */
  function migrate() {
    const done = db.prepare("PRAGMA user_version").get().user_version;
    for (let i = done; i < MIGRATIONS.length; i++) {
      db.exec("BEGIN");
      try {
        db.exec(MIGRATIONS[i]);
        db.exec(`PRAGMA user_version = ${i + 1}`);
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    }
  }

  /**
   * A name typed for a list or habit: spaces tidied, at most `max` characters.
   * @param {unknown} text
   * @param {string} what "list" or "habit", for the message when it's empty.
   * @param {number} max
   * @returns {string}
   */
  function nameOf(text, what, max) {
    const n = String(text ?? "").replace(/\s+/g, " ").trim().slice(0, max);
    if (!n) throw codedError("input", `Give the ${what} a name.`);
    return n;
  }

  /**
   * A 404 for something that's gone, in plain words.
   * @param {string} what
   * @returns {Error}
   */
  const gone = (what) => Object.assign(codedError("not-found", `That ${what} isn't there any more.`), { status: 404 });

  /**
   * The next position at an end of a set of rows.
   * @param {string} table
   * @param {string} where SQL condition, with ? for `params`.
   * @param {unknown[]} params
   * @param {"top" | "bottom"} at
   * @returns {number}
   */
  function endPosition(table, where, params, at) {
    const r = db.prepare(`SELECT MIN(position) AS lo, MAX(position) AS hi FROM ${table} WHERE ${where}`).get(...params);
    return at === "top" ? (r.lo ?? 1) - 1 : (r.hi ?? -1) + 1;
  }

  /**
   * Puts rows in the order given (drag to reorder): those named first, in that order, then the rest as they were.
   * Ids that aren't in the set are skipped.
   * @param {string} table
   * @param {string} where SQL condition for the set, with ? for `params`.
   * @param {unknown[]} params
   * @param {unknown} ids
   */
  function reorder(table, where, params, ids) {
    const current = db.prepare(`SELECT id FROM ${table} WHERE ${where} ORDER BY position, created_at`).all(...params).map((r) => r.id);
    const known = new Set(current);
    const first = [...new Set((Array.isArray(ids) ? ids : []).slice(0, 1000).map(String))].filter((id) => known.has(id));
    const picked = new Set(first);
    const stmt = db.prepare(`UPDATE ${table} SET position = ? WHERE id = ?`);
    [...first, ...current.filter((id) => !picked.has(id))].forEach((id, i) => stmt.run(i, id));
  }

  // ---------- Lists ----------

  /** Makes the starter lists the first time lists are asked for, and never again. */
  function seedLists() {
    if (db.prepare("SELECT 1 FROM meta WHERE key = 'listsSeeded'").get()) return;
    const at = iso();
    const add = db.prepare("INSERT OR IGNORE INTO lists (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)");
    STARTER_LISTS.forEach((name, i) => add.run(newId("l"), name, i, at, at));
    db.prepare("INSERT INTO meta (key, value) VALUES ('listsSeeded', ?)").run(at);
  }

  /**
   * One list's row, or a 404.
   * @param {string} id
   * @returns {Record<string, any>}
   */
  function listRow(id) {
    const r = db.prepare("SELECT * FROM lists WHERE id = ?").get(String(id));
    if (!r) throw gone("list");
    return r;
  }

  /**
   * Turns down a name another list already has.
   * @param {string} name
   * @param {string} [except] The list being renamed.
   */
  function uniqueName(name, except = "") {
    if (db.prepare("SELECT 1 FROM lists WHERE name = ? COLLATE NOCASE AND id != ?").get(name, except)) {
      throw codedError("input", `You already have a list called ${name}.`);
    }
  }

  /**
   * Every list, in order, with how many items are left and how many are ticked.
   * @returns {List[]}
   */
  function lists() {
    seedLists();
    return db.prepare(`SELECT l.id, l.name,
        (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.done_at IS NULL) AS open,
        (SELECT COUNT(*) FROM list_items i WHERE i.list_id = l.id AND i.done_at IS NOT NULL) AS done
      FROM lists l ORDER BY l.position, l.created_at`).all().map((r) => ({ id: r.id, name: r.name, open: r.open, done: r.done }));
  }

  /**
   * Adds a list at the end.
   * @param {string} name
   * @returns {List}
   */
  function addList(name) {
    seedLists();
    const n = nameOf(name, "list", 40);
    uniqueName(n);
    const id = newId("l");
    const at = iso();
    db.prepare("INSERT INTO lists (id, name, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
      .run(id, n, endPosition("lists", "1 = 1", [], "bottom"), at, at);
    return { id, name: n, open: 0, done: 0 };
  }

  /**
   * Renames a list.
   * @param {string} id
   * @param {string} name
   * @returns {List}
   */
  function renameList(id, name) {
    const r = listRow(id);
    const n = nameOf(name, "list", 40);
    uniqueName(n, r.id);
    db.prepare("UPDATE lists SET name = ?, updated_at = ? WHERE id = ?").run(n, iso(), r.id);
    return lists().find((l) => l.id === r.id);
  }

  /**
   * Deletes a list and everything on it.
   * @param {string} id
   */
  function removeList(id) {
    db.prepare("DELETE FROM lists WHERE id = ?").run(listRow(id).id);
  }

  /**
   * Puts the lists in the order given; any left out follow, as they were.
   * @param {string[]} ids
   */
  function reorderLists(ids) {
    reorder("lists", "1 = 1", [], ids);
  }

  /**
   * An item as the page sees it.
   * @param {Record<string, any>} r
   * @returns {Item}
   */
  const shapeItem = (r) => ({ id: r.id, listId: r.list_id, text: r.text, done: Boolean(r.done_at), doneAt: r.done_at, position: r.position });

  /**
   * One item's row, or a 404.
   * @param {string} id
   * @returns {Record<string, any>}
   */
  function itemRow(id) {
    const r = db.prepare("SELECT * FROM list_items WHERE id = ?").get(String(id));
    if (!r) throw gone("item");
    return r;
  }

  /**
   * A list's items, in your order. Ticked ones go after the rest unless `tickedLast` is off.
   * @param {string} listId
   * @param {{ tickedLast?: boolean }} [options]
   * @returns {Item[]}
   */
  function items(listId, { tickedLast = true } = {}) {
    const r = listRow(listId);
    const order = tickedLast ? "done_at IS NOT NULL, position, created_at" : "position, created_at";
    return db.prepare(`SELECT * FROM list_items WHERE list_id = ? ORDER BY ${order}`).all(r.id).map(shapeItem);
  }

  /**
   * Adds items to a list: one per line of the text, so a pasted list adds each line.
   * @param {string} listId
   * @param {string} text
   * @param {{ at?: "top" | "bottom" }} [options] Where new items go.
   * @returns {Item[]}
   */
  function addItems(listId, text, { at = "bottom" } = {}) {
    const r = listRow(listId);
    const lines = String(text ?? "").split(/\r?\n/).map((l) => l.replace(/\s+/g, " ").trim().slice(0, 200)).filter(Boolean).slice(0, 100);
    if (!lines.length) throw codedError("input", "Type what to add.");
    const when = iso();
    const ids = [];
    // Top keeps the lines in the order typed, above what's there.
    let pos = endPosition("list_items", "list_id = ?", [r.id], at === "top" ? "top" : "bottom");
    const ordered = at === "top" ? [...lines].reverse() : lines;
    const add = db.prepare("INSERT INTO list_items (id, list_id, text, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
    for (const line of ordered) {
      const id = newId("i");
      add.run(id, r.id, line, pos, when, when);
      ids.push(id);
      pos += at === "top" ? -1 : 1;
    }
    if (at === "top") ids.reverse();
    return ids.map((id) => shapeItem(itemRow(id)));
  }

  /**
   * Changes an item's words, or ticks it off or back on.
   * @param {string} id
   * @param {{ text?: string, done?: boolean }} patch
   * @returns {Item}
   */
  function updateItem(id, patch = {}) {
    const r = itemRow(id);
    const set = {};
    if ("text" in patch) {
      const t = String(patch.text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      if (!t) throw codedError("input", "An item needs some words. To take it off, delete it.");
      set.text = t;
    }
    if ("done" in patch) set.done_at = patch.done ? (r.done_at || iso()) : null;
    set.updated_at = iso();
    const cols = Object.keys(set);
    db.prepare(`UPDATE list_items SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => set[c]), r.id);
    return shapeItem(itemRow(r.id));
  }

  /**
   * Deletes an item.
   * @param {string} id
   */
  function removeItem(id) {
    db.prepare("DELETE FROM list_items WHERE id = ?").run(itemRow(id).id);
  }

  /**
   * Deletes a list's ticked items.
   * @param {string} listId
   * @returns {number} How many went.
   */
  function clearDone(listId) {
    return Number(db.prepare("DELETE FROM list_items WHERE list_id = ? AND done_at IS NOT NULL").run(listRow(listId).id).changes);
  }

  /**
   * Puts a list's items in the order given (drag to reorder). Items on other lists are left alone.
   * @param {string} listId
   * @param {string[]} ids
   */
  function reorderItems(listId, ids) {
    reorder("list_items", "list_id = ?", [listRow(listId).id], ids);
  }

  /**
   * What the Lists card shows: every list, the one picked (or the first when it's gone or none was asked for), and
   * its items.
   * @param {{ list?: string, tickedLast?: boolean }} [options]
   * @returns {{ lists: List[], list: List | null, items: Item[] }}
   */
  function listView({ list = "", tickedLast = true } = {}) {
    const all = lists();
    const pick = all.find((l) => l.id === list) || all[0] || null;
    return { lists: all, list: pick, items: pick ? items(pick.id, { tickedLast }) : [] };
  }

  // ---------- Habits ----------

  /**
   * One habit's row, or a 404.
   * @param {string} id
   * @returns {Record<string, any>}
   */
  function habitRow(id) {
    const r = db.prepare("SELECT * FROM habits WHERE id = ?").get(String(id));
    if (!r) throw gone("habit");
    return r;
  }

  /**
   * How many times a day, checked.
   * @param {unknown} n
   * @returns {number}
   */
  function perDayOf(n) {
    const v = Number(n);
    if (!Number.isInteger(v) || v < 1 || v > MAX_PER_DAY) throw codedError("input", `How many times a day is 1 to ${MAX_PER_DAY}.`);
    return v;
  }

  /**
   * A day you can fill in: YYYY-MM-DD, not after today and at most FILL_IN_DAYS back.
   * @param {unknown} day
   * @returns {string}
   */
  function dayOf(day) {
    const t = today();
    if (day === undefined || day === null || day === "") return t;
    const d = String(day);
    // A day that doesn't exist, like 2026-02-31, comes back from addDays as another day.
    if (!DAY.test(d) || addDays(d, 0) !== d) throw codedError("input", "A day looks like 2026-10-31.");
    if (d > t) throw codedError("input", "You can't tick a day that hasn't come yet.");
    if (d < addDays(t, -FILL_IN_DAYS)) throw codedError("input", `You can fill in the last ${FILL_IN_DAYS} days only.`);
    return d;
  }

  /**
   * A habit as the card shows it: today's count, its streaks, and the seven days in `week`.
   * @param {Record<string, any>} r
   * @param {string[]} week
   * @param {string} t Today.
   * @returns {Habit}
   */
  function shapeHabit(r, week, t) {
    const rows = db.prepare("SELECT day, count, goal FROM habit_checks WHERE habit_id = ? AND day BETWEEN ? AND ?").all(r.id, week[0] < t ? week[0] : t, week[6] > t ? week[6] : t);
    const byDay = new Map(rows.map((c) => [c.day, c]));
    const since = ymd(r.created_at);
    const dayOfWeek = (day) => {
      const c = byDay.get(day);
      // A day not ticked yet counts against today's goal.
      const goal = c?.goal ?? r.per_day;
      const count = c?.count ?? 0;
      return { day, count, goal, done: count >= goal, future: day > t, before: !c && day < since };
    };
    const doneDays = db.prepare("SELECT day FROM habit_checks WHERE habit_id = ? AND count >= goal").all(r.id).map((c) => c.day);
    return {
      id: r.id, name: r.name, icon: r.icon, perDay: r.per_day, since, archived: Boolean(r.archived_at),
      today: dayOfWeek(t), ...streaks(doneDays, t), week: week.map(dayOfWeek),
    };
  }

  /**
   * What the Habits card shows: the habits you keep, in order, each with today, its streaks and seven days; and the
   * ones you archived.
   * @param {{ weekStart?: number | null }} [options] A day number to show this week from it; else the last 7 days.
   * @returns {{ today: string, days: string[], habits: Habit[], doneToday: number, archived: Array<{ id: string, name: string, icon: string, archivedAt: string }> }}
   */
  function habits({ weekStart = null } = {}) {
    const t = today();
    const days = windowDays(t, weekStart);
    const list = db.prepare("SELECT * FROM habits WHERE archived_at IS NULL ORDER BY position, created_at").all().map((r) => shapeHabit(r, days, t));
    const archived = db.prepare("SELECT id, name, icon, archived_at FROM habits WHERE archived_at IS NOT NULL ORDER BY archived_at DESC").all()
      .map((r) => ({ id: r.id, name: r.name, icon: r.icon, archivedAt: r.archived_at }));
    return { today: t, days, habits: list, doneToday: list.filter((h) => h.today.done).length, archived };
  }

  /**
   * One habit with the last seven days.
   * @param {string} id
   * @returns {Habit}
   */
  function habit(id) {
    const t = today();
    return shapeHabit(habitRow(id), windowDays(t), t);
  }

  /**
   * Adds a habit at the end.
   * @param {{ name: string, icon?: string, perDay?: number }} input
   * @returns {Habit}
   */
  function addHabit({ name, icon = "", perDay = 1 } = {}) {
    const n = nameOf(name, "habit", 40);
    const id = newId("h");
    const at = iso();
    db.prepare("INSERT INTO habits (id, name, icon, per_day, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(id, n, iconOf(icon), perDayOf(perDay), endPosition("habits", "1 = 1", [], "bottom"), at, at);
    return habit(id);
  }

  /**
   * Changes a habit, or archives it (or brings it back). A new times-a-day applies from today; days before keep the
   * goal they had, so a change never rewrites your past.
   * @param {string} id
   * @param {{ name?: string, icon?: string, perDay?: number, archived?: boolean }} patch
   * @returns {Habit}
   */
  function updateHabit(id, patch = {}) {
    const r = habitRow(id);
    const set = {};
    if ("name" in patch) set.name = nameOf(patch.name, "habit", 40);
    if ("icon" in patch) set.icon = iconOf(patch.icon);
    if ("perDay" in patch) set.per_day = perDayOf(patch.perDay);
    if ("archived" in patch) {
      set.archived_at = patch.archived ? (r.archived_at || iso()) : null;
      // Brought back, it goes at the end of the habits you keep.
      if (!patch.archived && r.archived_at) set.position = endPosition("habits", "archived_at IS NULL", [], "bottom");
    }
    set.updated_at = iso();
    const cols = Object.keys(set);
    db.prepare(`UPDATE habits SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => set[c]), r.id);
    if ("per_day" in set) {
      db.prepare("UPDATE habit_checks SET goal = ?, count = MIN(count, ?) WHERE habit_id = ? AND day = ?").run(set.per_day, set.per_day, r.id, today());
    }
    return habit(r.id);
  }

  /**
   * Deletes a habit and its check-ins for good.
   * @param {string} id
   */
  function removeHabit(id) {
    db.prepare("DELETE FROM habits WHERE id = ?").run(habitRow(id).id);
  }

  /**
   * Puts the habits you keep in the order given; any left out follow, as they were.
   * @param {string[]} ids
   */
  function reorderHabits(ids) {
    reorder("habits", "archived_at IS NULL", [], ids);
  }

  /**
   * Ticks a habit for a day. With no count it adds one, and after the day's goal it goes back to none, so one button
   * can tick and untick. A count sets it outright, from 0 to the day's goal.
   * @param {string} id
   * @param {{ day?: string, count?: number }} [input] The day is today when left out.
   * @returns {Habit} The habit, with the last seven days.
   */
  function check(id, { day, count } = {}) {
    const r = habitRow(id);
    if (r.archived_at) throw codedError("input", "Bring the habit back first, then tick it.");
    const d = dayOf(day);
    const row = db.prepare("SELECT count, goal FROM habit_checks WHERE habit_id = ? AND day = ?").get(r.id, d);
    // Today follows the habit's goal now; a past day keeps the goal it had then.
    const goal = d === today() ? r.per_day : row?.goal ?? r.per_day;
    let next;
    if (count === undefined || count === null) {
      const was = Math.min(row?.count ?? 0, goal);
      next = was >= goal ? 0 : was + 1;
    } else {
      const c = Number(count);
      if (!Number.isInteger(c) || c < 0) throw codedError("input", "A count is a whole number, 0 or more.");
      next = Math.min(c, goal);
    }
    if (next === 0) db.prepare("DELETE FROM habit_checks WHERE habit_id = ? AND day = ?").run(r.id, d);
    else {
      db.prepare(`INSERT INTO habit_checks (habit_id, day, count, goal) VALUES (?, ?, ?, ?)
        ON CONFLICT (habit_id, day) DO UPDATE SET count = excluded.count, goal = excluded.goal`).run(r.id, d, next, goal);
    }
    return habit(r.id);
  }

  // ---------- Journal ----------

  /**
   * A day that has come: YYYY-MM-DD, real, and not after today.
   * @param {unknown} day
   * @returns {string}
   */
  function pastDay(day) {
    const t = today();
    if (day === undefined || day === null || day === "") return t;
    const d = String(day);
    if (!DAY.test(d) || addDays(d, 0) !== d || d < "1900-01-01") throw codedError("input", "A day looks like 2026-10-31.");
    if (d > t) throw codedError("input", "That day hasn't come yet.");
    return d;
  }

  /**
   * A journal row as the page sees it.
   * @param {Record<string, any> | undefined} r
   * @returns {{ day: string, text: string, mood: string | null, prompt: string, updatedAt: string } | null}
   */
  const shapeEntry = (r) => (r ? { day: r.day, text: r.text, mood: r.mood, prompt: r.prompt, updatedAt: r.updated_at } : null);

  /**
   * A day's journal entry, or null when nothing was written that day.
   * @param {string} [day] Today when left out.
   * @returns {{ day: string, today: string, entry: ReturnType<typeof shapeEntry> }}
   */
  function journalDay(day) {
    const d = pastDay(day);
    return { day: d, today: today(), entry: shapeEntry(db.prepare("SELECT * FROM journal WHERE day = ?").get(d)) };
  }

  /**
   * The days with something written or a mood picked, newest first, each with its first words.
   * @param {{ limit?: number }} [options]
   * @returns {Array<{ day: string, mood: string | null, preview: string }>}
   */
  function journalEntries({ limit = 60 } = {}) {
    return db.prepare("SELECT day, mood, text FROM journal ORDER BY day DESC LIMIT ?").all(Math.max(1, Math.min(500, limit)))
      .map((r) => ({ day: r.day, mood: r.mood, preview: r.text.replace(/\s+/g, " ").trim().slice(0, 120) }));
  }

  /**
   * Writes a day's entry: the fields given change, the others stay. An entry with no words and no mood is removed,
   * so a day is either written or not.
   * @param {string} day
   * @param {{ text?: string, mood?: string | null, prompt?: string }} fields
   * @returns {ReturnType<typeof shapeEntry>}
   */
  function writeJournal(day, fields = {}) {
    const d = pastDay(day);
    const was = db.prepare("SELECT * FROM journal WHERE day = ?").get(d);
    const next = { text: was?.text ?? "", mood: was?.mood ?? null, prompt: was?.prompt ?? "" };
    if ("text" in fields) {
      const t = String(fields.text ?? "").replace(/\r\n?/g, "\n");
      if (t.length > JOURNAL_MAX) throw codedError("input", `A day's entry can be up to ${JOURNAL_MAX.toLocaleString("en-US")} characters.`);
      next.text = t;
    }
    if ("mood" in fields) {
      const m = fields.mood || null;
      if (m !== null && !MOODS.includes(m)) throw codedError("input", `A mood is one of ${MOODS.join(", ")}.`);
      next.mood = m;
    }
    if ("prompt" in fields) next.prompt = String(fields.prompt ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!next.text.trim() && !next.mood) {
      db.prepare("DELETE FROM journal WHERE day = ?").run(d);
      return null;
    }
    const at = iso();
    db.prepare(`INSERT INTO journal (day, text, mood, prompt, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (day) DO UPDATE SET text = excluded.text, mood = excluded.mood, prompt = excluded.prompt, updated_at = excluded.updated_at`)
      .run(d, next.text, next.mood, next.prompt, at, at);
    return shapeEntry(db.prepare("SELECT * FROM journal WHERE day = ?").get(d));
  }

  // ---------- Important dates ----------

  /**
   * An important date's row, or a 404.
   * @param {string} id
   * @returns {Record<string, any>}
   */
  function dateRow(id) {
    const r = db.prepare("SELECT * FROM dates WHERE id = ?").get(String(id));
    if (!r) throw gone("date");
    return r;
  }

  /**
   * A date as the page sees it, with when it next comes round (null for a countdown that has passed).
   * @param {Record<string, any>} r
   * @param {string} t Today.
   */
  function shapeDate(r, t) {
    const rec = { id: r.id, kind: r.kind, title: r.title, month: r.month, day: r.day, year: r.year, source: r.source };
    return { ...rec, next: nextOccurrence(rec, t) };
  }

  /**
   * Checks a date's fields: its kind, a name, and a day that exists. A yearly date may be February 29 and may leave
   * out the year; a countdown needs a whole date.
   * @param {{ kind?: unknown, title?: unknown, month?: unknown, day?: unknown, year?: unknown }} input
   * @returns {{ kind: string, title: string, month: number, day: number, year: number | null }}
   */
  function dateFields({ kind, title, month, day, year }) {
    if (!DATE_KINDS.includes(String(kind))) throw codedError("input", "A date is a birthday, an anniversary or a countdown.");
    const name = nameOf(title, "date", 60);
    const m = Number(month);
    const d = Number(day);
    const thisYear = Number(today().slice(0, 4));
    const y = year === undefined || year === null || year === "" ? null : Number(year);
    if (y !== null && (!Number.isInteger(y) || y < 1900 || y > thisYear + 50)) throw codedError("input", "A year looks like 1990.");
    if (kind === "event" && y === null) throw codedError("input", "A countdown needs its whole date.");
    if (kind !== "event" && y !== null && y > thisYear) throw codedError("input", "That year hasn't come yet.");
    // A yearly date is checked against a leap year, so February 29 counts; a countdown against its own year.
    const check = dayText(kind === "event" ? y : 2000, m, d);
    if (!Number.isInteger(m) || !Number.isInteger(d) || m < 1 || m > 12 || d < 1 || addDays(check, 0) !== check) {
      throw codedError("input", "That day doesn't exist.");
    }
    return { kind: String(kind), title: name, month: m, day: d, year: y };
  }

  /**
   * Adds an important date you entered.
   * @param {{ kind: string, title: string, month: number, day: number, year?: number | null }} input
   */
  function addDate(input = {}) {
    const f = dateFields(input);
    const id = newId("d");
    const at = iso();
    db.prepare("INSERT INTO dates (id, kind, title, month, day, year, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'me', ?, ?)")
      .run(id, f.kind, f.title, f.month, f.day, f.year, at, at);
    return shapeDate(dateRow(id), today());
  }

  /**
   * Changes an important date. The fields left out stay as they were.
   * @param {string} id
   * @param {Partial<{ kind: string, title: string, month: number, day: number, year: number | null }>} patch
   */
  function updateDate(id, patch = {}) {
    const r = dateRow(id);
    const f = dateFields({ kind: r.kind, title: r.title, month: r.month, day: r.day, year: r.year, ...patch });
    db.prepare("UPDATE dates SET kind = ?, title = ?, month = ?, day = ?, year = ?, updated_at = ? WHERE id = ?")
      .run(f.kind, f.title, f.month, f.day, f.year, iso(), r.id);
    return shapeDate(dateRow(r.id), today());
  }

  /**
   * Deletes an important date.
   * @param {string} id
   */
  function removeDate(id) {
    db.prepare("DELETE FROM dates WHERE id = ?").run(dateRow(id).id);
  }

  /**
   * What the Important dates card shows: the ones coming up within `ahead` days (at most `limit`), the next one after
   * that when none are, and every date for the full list (countdowns that have passed last, kept in the store).
   * `more` takes dates from other sources, like a calendar, shaped the same way; nothing passes any yet.
   * @param {{ ahead?: number, limit?: number, more?: Array<{ id: string, kind: string, title: string, month: number, day: number, year: number | null, source: string }> }} [options]
   */
  function datesView({ ahead = 60, limit = 5, more = [] } = {}) {
    const t = today();
    const all = [...db.prepare("SELECT * FROM dates").all().map((r) => shapeDate(r, t)), ...more.map((r) => ({ ...r, next: nextOccurrence(r, t) }))];
    const soon = upcoming(all, t, { ahead, limit });
    const later = soon.length ? null : upcoming(all, t, { ahead: Infinity, limit: 1 })[0] || null;
    const ordered = [...upcoming(all, t, { ahead: Infinity, limit: Infinity }), ...all.filter((r) => !r.next).sort((a, b) => dayText(b.year, b.month, b.day).localeCompare(dayText(a.year, a.month, a.day)))];
    return { today: t, upcoming: soon, later, all: ordered };
  }

  /**
   * Every table, for a backup file.
   * @returns {Record<string, any[]>}
   */
  function dump() {
    const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
    return {
      version: db.prepare("PRAGMA user_version").get().user_version,
      lists: all("SELECT * FROM lists"), listItems: all("SELECT * FROM list_items"),
      habits: all("SELECT * FROM habits"), habitChecks: all("SELECT * FROM habit_checks"),
      journal: all("SELECT * FROM journal"), dates: all("SELECT * FROM dates"),
    };
  }

  /** Closes the database. */
  const close = () => db.close();

  return {
    lists, addList, renameList, removeList, reorderLists, items, addItems, updateItem, removeItem, clearDone, reorderItems, listView,
    habits, habit, addHabit, updateHabit, removeHabit, reorderHabits, check,
    journalDay, journalEntries, writeJournal, addDate, updateDate, removeDate, datesView, dump, close,
  };
}

/**
 * The /api/personal routes, apart from the server so they can be tested on their own. Personal data goes only
 * through here, never to Felix's work tools.
 *
 * GET  /api/personal/lists[?list=<id>][&ticked=bottom|stay] -> { lists, list, items }
 * POST /api/personal/lists                 { name } -> { list } a new list
 * POST /api/personal/lists/reorder         { ids } -> { ok }
 * POST /api/personal/lists/<id>            { name } -> { list } rename
 * POST /api/personal/lists/<id>/delete     -> { ok } the list and its items
 * POST /api/personal/lists/<id>/items      { text, at?: top|bottom } -> { items } one per line
 * POST /api/personal/lists/<id>/reorder    { ids } -> { ok } the items' order after a drag
 * POST /api/personal/lists/<id>/clear      -> { cleared } delete the ticked items
 * POST /api/personal/items/<id>            { patch: { text?, done? } } -> { item }
 * POST /api/personal/items/<id>/delete     -> { ok }
 * GET  /api/personal/habits[?weekStart=0-6] -> { today, days, habits, doneToday, archived }
 * POST /api/personal/habits                { name, icon?, perDay? } -> { habit }
 * POST /api/personal/habits/reorder        { ids } -> { ok }
 * POST /api/personal/habits/<id>           { patch: { name?, icon?, perDay?, archived? } } -> { habit }
 * POST /api/personal/habits/<id>/check     { day?, count? } -> { habit } tick today (or a day this past while)
 * POST /api/personal/habits/<id>/delete    -> { ok } the habit and its check-ins, for good
 * GET  /api/personal/journal[?day=]        -> { today, day, entry, earlier } a day's entry and the days written
 * POST /api/personal/journal/<day>         { text?, mood?, prompt? } -> { entry } (null once it's empty)
 * GET  /api/personal/dates[?ahead=&limit=] -> { today, upcoming, later, all }
 * POST /api/personal/dates                 { kind, title, month, day, year? } -> { date }
 * POST /api/personal/dates/<id>            { patch } -> { date }
 * POST /api/personal/dates/<id>/delete     -> { ok }
 *
 * @param {Awaited<ReturnType<typeof createPersonal>>} store
 * @param {{ method: string, pathname: string, query?: URLSearchParams, body?: any }} req
 * @returns {{ status: number, body: object } | null} Null when the path isn't a personal route.
 */
export function personalRoute(store, { method, pathname, query = new URLSearchParams(), body = {} }) {
  if (!pathname.startsWith("/api/personal/")) return null;
  const ok = (b) => ({ status: 200, body: b });
  const notFound = { status: 404, body: { error: "Not found" } };
  const b = body && typeof body === "object" ? body : {};
  try {
    const [kind, id, action, ...rest] = pathname.slice("/api/personal/".length).split("/").map(decodeURIComponent);
    if (rest.length) return notFound;
    if (kind === "lists") {
      if (method === "GET") return id ? notFound : ok(store.listView({ list: query.get("list") || "", tickedLast: query.get("ticked") !== "stay" }));
      if (method !== "POST") return notFound;
      if (!id) return ok({ list: store.addList(b.name) });
      if (id === "reorder" && !action) { store.reorderLists(b.ids); return ok({ ok: true }); }
      if (!action) return ok({ list: store.renameList(id, b.name) });
      if (action === "delete") { store.removeList(id); return ok({ ok: true }); }
      if (action === "items") return ok({ items: store.addItems(id, b.text, { at: b.at === "top" ? "top" : "bottom" }) });
      if (action === "reorder") { store.reorderItems(id, b.ids); return ok({ ok: true }); }
      if (action === "clear") return ok({ cleared: store.clearDone(id) });
      return notFound;
    }
    if (kind === "items") {
      if (method !== "POST" || !id) return notFound;
      if (!action) return ok({ item: store.updateItem(id, b.patch || {}) });
      if (action === "delete") { store.removeItem(id); return ok({ ok: true }); }
      return notFound;
    }
    if (kind === "habits") {
      if (method === "GET") {
        if (id) return notFound;
        const ws = query.get("weekStart");
        return ok(store.habits({ weekStart: ws !== null && /^[0-6]$/.test(ws) ? Number(ws) : null }));
      }
      if (method !== "POST") return notFound;
      if (!id) return ok({ habit: store.addHabit(b) });
      if (id === "reorder" && !action) { store.reorderHabits(b.ids); return ok({ ok: true }); }
      if (!action) return ok({ habit: store.updateHabit(id, b.patch || {}) });
      if (action === "check") return ok({ habit: store.check(id, { day: b.day, count: b.count }) });
      if (action === "delete") { store.removeHabit(id); return ok({ ok: true }); }
      return notFound;
    }
    if (kind === "journal") {
      if (method === "GET") {
        if (id) return notFound;
        const { day, today, entry } = store.journalDay(query.get("day") || "");
        return ok({ today, day, entry, earlier: store.journalEntries() });
      }
      if (method !== "POST" || !id || action) return notFound;
      const fields = Object.fromEntries(["text", "mood", "prompt"].filter((k) => k in b).map((k) => [k, b[k]]));
      return ok({ entry: store.writeJournal(id, fields) });
    }
    if (kind === "dates") {
      if (method === "GET") {
        if (id) return notFound;
        const num = (k, def, lo, hi) => {
          const n = Number(query.get(k));
          return query.get(k) && Number.isInteger(n) ? Math.min(hi, Math.max(lo, n)) : def;
        };
        return ok(store.datesView({ ahead: num("ahead", 60, 0, 366), limit: num("limit", 5, 1, 20) }));
      }
      if (method !== "POST") return notFound;
      if (!id) return ok({ date: store.addDate(b) });
      if (!action) return ok({ date: store.updateDate(id, b.patch || {}) });
      if (action === "delete") { store.removeDate(id); return ok({ ok: true }); }
      return notFound;
    }
    return notFound;
  } catch (e) {
    if (e instanceof URIError) return { status: 400, body: { error: "That address isn't one Felix can read.", code: "input" } };
    const status = e.code === "input" ? 400 : e.code === "not-found" ? 404 : 500;
    return { status, body: { error: e.message, code: e.code || "error" } };
  }
}
