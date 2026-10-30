/**
 * Felix and your Personal cards: what voice and chat commands (felix-commands.mjs, felix-answers.mjs) and Felix's AI
 * tools (felix-tools.mjs) use to read and change your lists, habits, journal, important dates and time off.
 *
 * The matching helpers here are careful: a command only fires on a list, item, habit or date you actually have, so
 * "groceries were expensive" or "I drank coffee" stay ordinary talk. The facade over the stores counts its changes, so
 * after Felix changes something the open cards load again.
 *
 * Privacy: these work whenever you ask directly, in either mode, because you asked. Nothing here is read into work
 * answers or briefings (felix-facts.mjs never reads it), and personal commands aren't passed to Felix's learning.
 */
import { addDays } from "./tasks.mjs";

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
// Words that carry no meaning when matching a habit: "I did my reading today" is about reading.
const FILLER = new Set(["i", "i'm", "im", "just", "did", "do", "done", "doing", "with", "my", "the", "a", "an", "some", "today", "tonight", "this", "morning",
  "already", "finally", "went", "go", "going", "for", "to", "had", "have", "got", "and", "of", "it", "finished", "completed"]);
// The past tense people say for the habit's own word: "I drank water" ticks "Drink water".
const PAST = { drank: "drink", ran: "run", slept: "sleep", ate: "eat", wrote: "write", read: "read", swam: "swim", rode: "ride", took: "take", meditated: "meditate", flossed: "floss", stretched: "stretch", journaled: "journal", walked: "walk", prayed: "pray", studied: "study", practiced: "practice", practised: "practice", exercised: "exercise", cooked: "cook", cleaned: "clean", jogged: "jog" };

/**
 * A word in its plain form, so "reading", "read" and "reads" are one word, and "drank" is "drink".
 * @param {string} word
 * @returns {string}
 */
export function stem(word) {
  const w = word.toLowerCase().replace(/[^a-z0-9']/g, "");
  if (PAST[w]) return PAST[w];
  if (w.length > 5 && w.endsWith("ing")) return w.slice(0, -3).replace(/(.)\1$/, "$1");
  if (w.length > 4 && w.endsWith("ies")) return `${w.slice(0, -3)}y`;
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

/**
 * The meaningful words of a phrase, in plain form.
 * @param {string} text
 * @returns {string[]}
 */
export function keyWords(text) {
  return String(text).toLowerCase().replace(/[’']s\b/g, "").split(/[^a-z0-9']+/).filter((w) => w && !FILLER.has(w)).map(stem).filter(Boolean);
}

/**
 * A name made plain for comparing lists and items: no "my" or "the", no trailing "list", singular, no spaces.
 * @param {string} name
 * @returns {string}
 */
export const plainName = (name) => String(name || "").toLowerCase().replace(/^(my|the|our) /, "").replace(/ list$/, "")
  .replace(/ies$/, "y").replace(/(?<!s)s$/, "").replace(/[^a-z0-9]/g, "");

/**
 * The list a name means: "groceries", "my grocery list", "packing" or "wish list".
 * @param {string} name
 * @param {string[]} lists Your lists' names.
 * @returns {string | null} The list's own name.
 */
export function findList(name, lists) {
  const want = plainName(name);
  // "wish list" and "Wishlist" are one list: compared with their spaces gone too.
  const squash = (x) => String(x || "").toLowerCase().replace(/^(my|the|our) /, "").replace(/[^a-z0-9]/g, "").replace(/(?<!s)s$/, "");
  return want ? lists.find((l) => plainName(l) === want || squash(l) === squash(name)) || null : null;
}

/**
 * The things in "eggs, milk and bread": each one, without a leading "some" or "a".
 * @param {string} text
 * @returns {string[]}
 */
export function splitItems(text) {
  return String(text).split(/\s*,\s*(?:and\s+)?|\s+and\s+|\s*&\s*/).map((s) => s.replace(/^(some|a|an|the|more) /i, "").trim()).filter(Boolean);
}

/**
 * The open items a phrase means, on one list or any: the same words first, then an item that starts with them.
 * @param {string} said "the eggs"
 * @param {Array<{ id: string, text: string, list: string }>} items Open items, with their list's name.
 * @param {string | null} [list] Only this list.
 * @returns {Array<{ id: string, text: string, list: string }>}
 */
export function findItems(said, items, list = null) {
  const want = plainName(String(said).replace(/^(the|my|some|a|an) /, ""));
  if (!want) return [];
  const pool = list ? items.filter((i) => i.list === list) : items;
  const same = pool.filter((i) => plainName(i.text) === want);
  return same.length ? same : pool.filter((i) => plainName(i.text).startsWith(want));
}

/**
 * The habits a phrase is about, carefully: every meaningful word you said must be in the habit's name ("I read" for
 * "Read 10 pages"), or the habit's last word must be in what you said ("drank water" for "Drink water"). "I drank
 * coffee" matches neither, and nothing matches a phrase with no meaningful words.
 * @param {string} said
 * @param {Array<{ id: string, name: string }>} habits
 * @returns {Array<{ id: string, name: string }>}
 */
export function findHabits(said, habits) {
  const words = keyWords(said);
  if (!words.length) return [];
  return habits.filter((h) => {
    const own = keyWords(h.name);
    if (!own.length) return false;
    return words.every((w) => own.includes(w)) || words.includes(own.at(-1));
  });
}

/**
 * The important dates a phrase names: every meaningful word you said is in the date's title ("mama's birthday" for
 * "Mama's birthday", "baguio" for "Trip to Baguio").
 * @param {string} said
 * @param {Array<{ id: string, title: string, kind: string }>} dates
 * @returns {Array<{ id: string, title: string, kind: string }>}
 */
export function findDates(said, dates) {
  const words = keyWords(said);
  return words.length ? dates.filter((d) => words.every((w) => keyWords(d.title).includes(w))) : [];
}

/**
 * Whether a phrase says something wasn't done ("I didn't exercise", "skipped reading"), so it never ticks a habit.
 * @param {string} said
 * @returns {boolean}
 */
export const saysNot = (said) => /\b(not|never|no|skip|skipped|miss|missed|forgot|didn'?t|haven'?t|hasn'?t|won'?t|can'?t|couldn'?t|don'?t|wasn'?t)\b/.test(String(said).toLowerCase());

/**
 * A day said in words: "November 3", "Nov 3rd", "3 November", "the 3rd of November", "11/3", with an optional year.
 * @param {string} text
 * @returns {{ month: number, day: number, year: number | null } | null}
 */
export function parseDay(text) {
  const t = String(text).toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ").trim();
  const monthOf = (w) => MONTHS.findIndex((m) => w.length >= 3 && m.startsWith(w.replace(/\.$/, ""))) + 1;
  let m = /^(?:on )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)?(?: (\d{4}))?$/.exec(t);
  if (m && monthOf(m[1])) return check(monthOf(m[1]), Number(m[2]), m[3]);
  m = /^(?:on )?(?:the )?(\d{1,2})(?:st|nd|rd|th)? (?:of )?([a-z]{3,9})(?: (\d{4}))?$/.exec(t);
  if (m && monthOf(m[2])) return check(monthOf(m[2]), Number(m[1]), m[3]);
  m = /^(?:on )?(\d{1,2})\/(\d{1,2})(?:\/(\d{4}))?$/.exec(t);
  if (m) return check(Number(m[1]), Number(m[2]), m[3]);
  return null;
}

/**
 * A month and day that exist (February 29 counts), with the year when one was said.
 * @param {number} month
 * @param {number} day
 * @param {string | undefined} year
 * @returns {{ month: number, day: number, year: number | null } | null}
 */
function check(month, day, year) {
  const probe = `2000-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  if (month < 1 || month > 12 || day < 1 || addDays(probe, 0) !== probe) return null;
  return { month, day, year: year ? Number(year) : null };
}

/**
 * The year a countdown with no year said lands in: this year, or next when the day has passed.
 * @param {{ month: number, day: number }} d
 * @param {string} today YYYY-MM-DD
 * @returns {number}
 */
export function nextYearFor(d, today) {
  const y = Number(today.slice(0, 4));
  const on = `${y}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
  return on >= today ? y : y + 1;
}

/**
 * The names a command can match on: your lists, their items (ticked ones marked done), your habits and your important dates. Read fresh
 * for each thing you say; it's a few small queries on this Mac.
 * @typedef {{ lists: string[], items: Array<{ id: string, text: string, list: string, done?: boolean }>, habits: Array<{ id: string, name: string }>,
 *   dates: Array<{ id: string, title: string, kind: string }> }} Known
 */

/**
 * Felix's way into your Personal cards, over the personal store (personal.mjs), My time off and My day.
 * @param {{ store: Awaited<ReturnType<typeof import("./personal.mjs").createPersonal>>,
 *   timeOff?: { view: (o: object) => Promise<any> }, myDay?: { view: (o: object) => Promise<any> },
 *   settings: { get: () => Promise<Record<string, any>> } }} deps
 */
export function createPersonalFelix({ store, timeOff, myDay, settings }) {
  let version = 0;
  /** Counts a change, so the open cards know to load again. */
  const changed = (v) => { version += 1; return v; };

  /** @returns {Known} */
  function known() {
    const lists = store.lists();
    return {
      lists: lists.map((l) => l.name),
      // Ticked items too, so "remove the eggs" works after "got the eggs"; ticking only looks at the open ones.
      items: lists.flatMap((l) => store.items(l.id).map((i) => ({ id: i.id, text: i.text, list: l.name, done: Boolean(i.done) }))),
      habits: store.habits().habits.map((h) => ({ id: h.id, name: h.name })),
      dates: store.datesView({ ahead: 366, limit: 100 }).all.map((d) => ({ id: d.id, title: d.title, kind: d.kind })),
    };
  }

  /** The list with this name, or null. @param {string} name */
  const listNamed = (name) => store.lists().find((l) => l.name.toLowerCase() === String(name).toLowerCase()) || null;

  return {
    /** How many changes Felix has made: a different number after an answer means the cards should load again. */
    version: () => version,
    known,
    lists: () => store.lists(),
    listNamed,
    items: (listId) => store.items(listId),
    addItems: (listId, text) => changed(store.addItems(listId, text, { at: "bottom" })),
    tickItem: (id) => changed(store.updateItem(id, { done: true })),
    removeItem: (id) => changed(store.removeItem(id)),
    habits: () => store.habits(),
    /** Marks a habit done for today: one more for a habit done several times a day; nothing changes if it's done. */
    checkHabit: (id) => {
      const h = store.habit(id);
      return h.today.done ? h : changed(store.check(id));
    },
    /** Sets a habit's day to done or not done. @param {string} id @param {{ day?: string, done?: boolean }} o */
    setHabit: (id, { day, done = true } = {}) => {
      const h = store.habit(id);
      return changed(store.check(id, { day, count: done ? h.perDay : 0 }));
    },
    /** Adds a line to today's journal entry, after what's there; never replaces it. @param {string} line */
    journalAppend: (line) => {
      const { day, entry } = store.journalDay();
      const was = entry?.text?.replace(/\s+$/, "") || "";
      return changed(store.writeJournal(day, { text: was ? `${was}\n${line}` : line }));
    },
    datesView: (o) => store.datesView(o),
    addDate: (d) => changed(store.addDate(d)),
    /** Your time off, as the card shows it. */
    timeoff: async () => {
      const s = await settings.get();
      return timeOff.view({ me: s.timeoffMe, ahead: s.timeoffAhead, cacheMinutes: s.oooCache });
    },
    /** My day: the weather and holidays. */
    myday: async () => myDay.view({ place: (await settings.get()).mydayPlace }),
    today: () => store.journalDay().today,
  };
}
