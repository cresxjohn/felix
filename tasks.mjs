/**
 * Tasks: a full task manager saved on this Mac, in Node's built-in SQLite (data/tasks.db). Work and personal tasks
 * share the database and are kept apart by `scope`. Quick add reads plain words: "Review fm#12247 tomorrow 3pm !high
 * #review" sets the due day and time, the priority and a label, and links the PR. Repeating tasks make their next
 * one when done, and a task with a time gets a Mac notification at that time (the server calls `dueReminders`).
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { codedError } from "./keychain.mjs";

export const SCOPES = ["work", "personal"];
export const VIEWS = ["today", "upcoming", "overdue", "someday", "done", "all"];
const PR_LINKS = { fm: "https://github.com/purepm/frontend-monorepo/pull/", bm: "https://github.com/purepm/backend-monorepo/pull/" };
const JIRA = "https://purepm.atlassian.net/browse/";
const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const PRIORITY = { high: 3, h: 3, 1: 3, med: 2, medium: 2, m: 2, 2: 2, low: 1, l: 1, 3: 1 };

/**
 * @typedef {{ title: string, dueDate: string | null, dueTime: string | null, priority: number, tags: string[],
 *   project: string | null, repeat: string | null, someday: boolean, links: Array<{ kind: string, url: string, label: string }> }} Parsed
 * @typedef {{ id: string, scope: string, title: string, notes: string, priority: number, dueDate: string | null,
 *   dueTime: string | null, someday: boolean, repeat: string | null, project: string | null, tags: string[],
 *   links: Array<{ kind: string, url: string, label: string }>, doneAt: string | null, parentId: string | null,
 *   position: number, createdAt: string, subtasks: Task[] }} Task
 */

/**
 * A day as YYYY-MM-DD in this Mac's time zone.
 * @param {Date | number} t
 * @returns {string}
 */
export function ymd(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/**
 * A day some days after another.
 * @param {string} day YYYY-MM-DD
 * @param {number} n
 * @returns {string}
 */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00`);
  d.setDate(d.getDate() + n);
  return ymd(d);
}

/** @param {string} day */
const weekday = (day) => new Date(`${day}T12:00:00`).getDay();

/**
 * The next time a task repeats, after the day it was due (or today, when that's later or it had no day).
 * Rules read like "every day", "every weekday", "every week", "every 2 weeks", "every month", "every monday",
 * "every sprint" (two weeks).
 * @param {string} rule
 * @param {string | null} from YYYY-MM-DD
 * @param {string} today YYYY-MM-DD
 * @returns {string | null} Null for a rule it doesn't know.
 */
export function nextDue(rule, from, today) {
  const r = String(rule || "").toLowerCase().replace(/^every\s+/, "").trim();
  const base = from && from > today ? from : (from || today);
  let next;
  if (r === "day" || r === "daily") next = addDays(base, 1);
  else if (r === "weekday") {
    next = addDays(base, 1);
    while ([0, 6].includes(weekday(next))) next = addDays(next, 1);
  } else if (r === "week" || r === "weekly") next = addDays(base, 7);
  else if (r === "sprint") next = addDays(base, 14);
  else if (r === "month" || r === "monthly") {
    const d = new Date(`${base}T12:00:00`);
    const day = d.getDate();
    d.setDate(1);
    d.setMonth(d.getMonth() + 1);
    d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
    next = ymd(d);
  } else if (WEEKDAYS.some((w) => w.startsWith(r) && r.length >= 3)) {
    const want = WEEKDAYS.findIndex((w) => w.startsWith(r));
    next = addDays(base, 1);
    while (weekday(next) !== want) next = addDays(next, 1);
  } else {
    const m = r.match(/^(\d{1,3})\s+(day|week)s?$/);
    if (!m) return null;
    next = addDays(base, Number(m[1]) * (m[2] === "week" ? 7 : 1));
  }
  // A late repeat catches up to today or later, so it doesn't come back already overdue.
  while (next < today) next = nextDue(rule, next, next) || today;
  return next;
}

/**
 * A link as a task keeps it, from what you'd write: a web address, fm#123 or bm#45 (the PR), or PMHUB-123 (the Jira
 * ticket). Null for anything else.
 * @param {string} text
 * @returns {{ kind: string, url: string, label: string } | null}
 */
export function linkOf(text) {
  const t = String(text || "").trim();
  if (/^https?:\/\/\S+$/i.test(t)) return { kind: "url", url: t, label: t.replace(/^https?:\/\//i, "").slice(0, 80) };
  const pr = /^(fm|bm)\s*#?\s*(\d{1,7})$/i.exec(t);
  if (pr) return { kind: "pr", url: `${PR_LINKS[pr[1].toLowerCase()]}${pr[2]}`, label: `${pr[1].toLowerCase()}#${pr[2]}` };
  const ticket = /^([A-Za-z][A-Za-z0-9]{1,9}-\d{1,7})$/.exec(t);
  return ticket ? { kind: "jira", url: `${JIRA}${ticket[1].toUpperCase()}`, label: ticket[1].toUpperCase() } : null;
}

/**
 * Reads quick-add text: the due day and time, priority, labels, project, repeat and links; what's left is the title.
 * @param {string} text
 * @param {number} [now]
 * @param {{ pmUpTo?: number }} [options] A bare "at 3" is the afternoon for hours up to `pmUpTo` (7 unless Settings
 *   says otherwise), the morning after it; 0 makes every bare hour the morning.
 * @returns {Parsed}
 */
export function parseQuick(text, now = Date.now(), { pmUpTo = TASK_PREFS.pmUpTo } = {}) {
  let s = ` ${String(text || "").replace(/\s+/g, " ").trim()} `;
  const today = ymd(now);
  const out = { dueDate: null, dueTime: null, priority: 0, tags: [], project: null, repeat: null, someday: false, links: [] };
  /**
   * Removes the first match that `ok` accepts from the text, and gives its groups. Matches it turns down stay where
   * they are, so words that only look like a date ("chapter 12") keep their place in the title.
   */
  const take = (re, ok = () => true) => {
    const m = [...s.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`))].find(ok);
    if (m) s = `${s.slice(0, m.index)} ${s.slice(m.index + m[0].length)}`;
    return m || null;
  };
  /** A link's host, or null when it can't be read (then it stays in the title). */
  const host = (url) => { try { return new URL(url).hostname.replace(/^www\./, ""); } catch { return null; } };

  for (let m; (m = take(/\s(https?:\/\/[^\s]+)(?=\s)/i, (x) => host(x[1])));) out.links.push({ kind: "url", url: m[1], label: host(m[1]) });
  for (const m of s.matchAll(/(?:^|\s)(fm|bm)#(\d{1,7})\b/gi)) out.links.push({ kind: "pr", url: `${PR_LINKS[m[1].toLowerCase()]}${m[2]}`, label: `${m[1].toLowerCase()}#${m[2]}` });
  for (const m of s.matchAll(/(?:^|\s)([A-Z][A-Z0-9]{1,9}-\d{1,7})\b/g)) out.links.push({ kind: "jira", url: `${JIRA}${m[1]}`, label: m[1] });

  let m = take(/\s!(high|medium|med|low|h|m|l|[123])(?=\s)/i) || take(/\s(!{1,3})(?=\s)/);
  if (m) out.priority = m[1].startsWith("!") ? m[1].length : PRIORITY[m[1].toLowerCase()];
  for (let t; (t = take(/\s#([a-z][\w-]{0,39})(?=\s)/i));) if (!out.tags.includes(t[1].toLowerCase())) out.tags.push(t[1].toLowerCase());
  if ((m = take(/\s@([a-z][\w-]{0,39})(?=\s)/i))) out.project = m[1];

  if ((m = take(/\s(?:every\s+(\d{1,3}\s+(?:day|week)s?|day|weekday|week|month|sprint|mon(?:day)?|tue(?:sday)?|wed(?:nesday)?|thu(?:rsday)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)|(daily|weekly|monthly))(?=\s)/i))) {
    const word = (m[1] || m[2]).toLowerCase();
    const day = WEEKDAYS.find((w) => w.startsWith(word.slice(0, 3)) && !/^\d/.test(word) && word !== "day" && word !== "weekday" && word !== "week" && word !== "month" && word !== "sprint" && !["daily", "weekly", "monthly"].includes(word));
    out.repeat = `every ${day || { daily: "day", weekly: "week", monthly: "month" }[word] || word}`;
    if (day) {
      let d = today;
      while (weekday(d) !== WEEKDAYS.indexOf(day)) d = addDays(d, 1);
      out.dueDate = d;
    } else out.dueDate = today;
  }

  if (take(/\s(someday|some day|later)(?=\s)/i)) out.someday = true;
  if (take(/\s(today|tod)(?=\s)/i)) out.dueDate = today;
  else if (take(/\s(tonight)(?=\s)/i)) { out.dueDate = today; out.dueTime = "20:00"; }
  else if (take(/\s(tomorrow|tmrw|tmr)(?=\s)/i)) out.dueDate = addDays(today, 1);
  else if (take(/\s(next week)(?=\s)/i)) {
    let d = addDays(today, 1);
    while (weekday(d) !== 1) d = addDays(d, 1);
    out.dueDate = d;
  } else if ((m = take(/\s(?:in\s+(\d{1,3}|a|an|one)\s+(day|week|month)s?)(?=\s)/i))) {
    const n = /^\d/.test(m[1]) ? Number(m[1]) : 1;
    out.dueDate = m[2].toLowerCase() === "month" ? nextDue("every month", today, today) : addDays(today, n * (m[2].toLowerCase() === "week" ? 7 : 1));
    if (m[2].toLowerCase() === "month" && n > 1) for (let i = 1; i < n; i++) out.dueDate = nextDue("every month", out.dueDate, out.dueDate);
  } else if ((m = take(/\s(?:(on|by)\s+)?(next\s+)?(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)(day|sday|nesday|rsday|urday)?(?=\s)/i,
    // A short name ("mon") counts only after on, by or next, or as the last word, so "Fix the mon bug" stays a title.
    (x) => x[1] || x[2] || x[4] || !s.slice(x.index + x[0].length).trim()))) {
    const want = WEEKDAYS.findIndex((w) => w.startsWith(m[3].toLowerCase().slice(0, 3)));
    let d = addDays(today, 1);
    while (weekday(d) !== want) d = addDays(d, 1);
    out.dueDate = m[2] ? addDays(d, 7) : d;
  } else if ((m = take(/\s(\d{4})-(\d{2})-(\d{2})(?=\s)/))) out.dueDate = `${m[1]}-${m[2]}-${m[3]}`;
  else if ((m = take(/\s(?:on\s+)?([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?=\s)/i, (x) => monthOf(x[1]) >= 0 && Number(x[2]) >= 1 && Number(x[2]) <= 31))) {
    out.dueDate = dayOfYear(monthOf(m[1]), Number(m[2]), today);
  } else if ((m = take(/\s(?:on\s+)?(\d{1,2})(?:st|nd|rd|th)?\s+([a-z]{3,9})(?=\s)/i, (x) => monthOf(x[2]) >= 0 && Number(x[1]) >= 1 && Number(x[1]) <= 31))) {
    out.dueDate = dayOfYear(monthOf(m[2]), Number(m[1]), today);
  } else if ((m = take(/\s(\d{1,2})\/(\d{1,2})(?=\s)/, (x) => x[1] >= 1 && x[1] <= 12 && x[2] >= 1 && x[2] <= 31))) out.dueDate = dayOfYear(Number(m[1]) - 1, Number(m[2]), today);

  if (take(/\s(?:at\s+)?noon(?=\s)/i)) out.dueTime = "12:00";
  else if ((m = take(/\s(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?=\s)/i, (x) => x[1] >= 1 && x[1] <= 12 && Number(x[2] || 0) < 60))) {
    const h = Number(m[1]) % 12 + (m[3].toLowerCase() === "pm" ? 12 : 0);
    out.dueTime = `${String(h).padStart(2, "0")}:${m[2] || "00"}`;
  } else if ((m = take(/\s(?:at\s+)?([01]?\d|2[0-3]):([0-5]\d)(?=\s)/))) out.dueTime = `${m[1].padStart(2, "0")}:${m[2]}`;
  else if ((m = take(/\sat\s+(\d{1,2})(?=\s)/i, (x) => x[1] >= 1 && x[1] <= 12))) {
    // "at 3" means the afternoon; "at 9" the morning (with the hours up to 7 in the afternoon, as it starts).
    const h = Number(m[1]);
    out.dueTime = `${String(h <= pmUpTo ? h + 12 : h).padStart(2, "0")}:00`;
  }
  if (out.dueTime && !out.dueDate) {
    const at = new Date(`${today}T${out.dueTime}:00`).getTime();
    out.dueDate = at > now ? today : addDays(today, 1);
  }
  if (out.someday) { out.dueDate = null; out.dueTime = null; }
  // A word left hanging once its day was taken out ("Book lunch for Friday") goes too.
  const said = s.replace(/\s+/g, " ").trim();
  const title = out.dueDate || out.dueTime || out.someday ? said.replace(/\s+(?:for|on|by|due|at|this)$/i, "") : said;
  return { title, ...out };
}

/** @param {string} word */
function monthOf(word) {
  const w = word.toLowerCase();
  return MONTHS.findIndex((name) => w.length >= 3 && name.startsWith(w.replace(/\.$/, "")));
}

/**
 * A month and day, this year or next when it has passed.
 * @param {number} month 0-11
 * @param {number} day
 * @param {string} today
 * @returns {string | null}
 */
function dayOfYear(month, day, today) {
  if (month < 0 || month > 11 || day < 1 || day > 31) return null;
  const year = Number(today.slice(0, 4));
  const at = (y) => `${y}-${String(month + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return at(year) >= today ? at(year) : at(year + 1);
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, scope TEXT NOT NULL, UNIQUE(name, scope));
  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, title TEXT NOT NULL, notes TEXT NOT NULL DEFAULT '',
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL, priority INTEGER NOT NULL DEFAULT 0,
    due_date TEXT, due_time TEXT, someday INTEGER NOT NULL DEFAULT 0, repeat TEXT,
    parent_id TEXT REFERENCES tasks(id) ON DELETE CASCADE, position REAL NOT NULL DEFAULT 0,
    done_at TEXT, remind_at TEXT, reminded_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
  CREATE INDEX IF NOT EXISTS tasks_open ON tasks(scope, done_at, due_date);
  CREATE TABLE IF NOT EXISTS tags (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
  CREATE TABLE IF NOT EXISTS task_tags (task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE, PRIMARY KEY (task_id, tag_id));
  CREATE TABLE IF NOT EXISTS links (id INTEGER PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, url TEXT NOT NULL, label TEXT NOT NULL);
`;

/**
 * How the store adds and lists tasks, as it starts: new tasks on top with no priority, a bare "at 1" to "at 7" in the
 * afternoon, and tasks done today kept in Today.
 * @typedef {{ newAt: "top" | "bottom", priority: number, pmUpTo: number, doneToday: boolean }} TaskPrefs
 */
export const TASK_PREFS = Object.freeze({ newAt: "top", priority: 0, pmUpTo: 7, doneToday: true });

/**
 * The store's preferences from Felix's settings (the Tasks group).
 * @param {Record<string, unknown>} s Settings.
 * @returns {TaskPrefs}
 */
export const taskPrefs = (s) => ({ newAt: s.tasksNewAt, priority: s.tasksPriority, pmUpTo: s.tasksAtPm, doneToday: s.tasksDoneToday });

/**
 * Opens the task store.
 * @param {{ file: string, now?: () => number, Database?: any }} options `file` is the SQLite file, or ":memory:".
 */
export async function createTasks({ file, now = Date.now, Database }) {
  /** @type {TaskPrefs} */
  let prefs = { ...TASK_PREFS };
  if (!Database) ({ DatabaseSync: Database } = await import("node:sqlite"));
  if (file !== ":memory:") mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);

  const iso = () => new Date(now()).toISOString();
  const newId = () => `t${now().toString(36)}${randomBytes(4).toString("hex")}`;
  const scopeOf = (scope) => {
    if (!SCOPES.includes(scope)) throw codedError("input", `Tasks are "work" or "personal", not "${scope}".`);
    return scope;
  };
  /** When a task's reminder is due: its day and time, in this Mac's time zone. */
  const remindAt = (dueDate, dueTime) => (dueDate && dueTime ? new Date(`${dueDate}T${dueTime}:00`).toISOString() : null);

  /**
   * Finds or makes a project by name.
   * @param {string | null} name
   * @param {string} scope
   * @returns {string | null}
   */
  function projectId(name, scope) {
    const n = String(name || "").trim().slice(0, 60);
    if (!n) return null;
    const row = db.prepare("SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND scope = ?").get(n, scope);
    if (row) return row.id;
    const id = `p${newId().slice(1)}`;
    db.prepare("INSERT INTO projects (id, name, scope) VALUES (?, ?, ?)").run(id, n, scope);
    return id;
  }

  /**
   * Replaces a task's labels.
   * @param {string} id
   * @param {string[]} names
   */
  function setTags(id, names) {
    db.prepare("DELETE FROM task_tags WHERE task_id = ?").run(id);
    for (const raw of [...new Set(names.map((n) => String(n).trim().replace(/^#/, "").toLowerCase()).filter((n) => /^[a-z][\w-]{0,39}$/.test(n)))].slice(0, 10)) {
      db.prepare("INSERT OR IGNORE INTO tags (name) VALUES (?)").run(raw);
      const tag = db.prepare("SELECT id FROM tags WHERE name = ?").get(raw);
      db.prepare("INSERT OR IGNORE INTO task_tags (task_id, tag_id) VALUES (?, ?)").run(id, tag.id);
    }
  }

  /**
   * Replaces a task's links. Only web links are kept.
   * @param {string} id
   * @param {Array<{ kind?: string, url: string, label?: string }>} links
   */
  function setLinks(id, links) {
    db.prepare("DELETE FROM links WHERE task_id = ?").run(id);
    for (const l of links.slice(0, 10)) {
      const url = String(l?.url || "");
      if (!/^https?:\/\/[^\s]+$/i.test(url)) continue;
      db.prepare("INSERT INTO links (task_id, kind, url, label) VALUES (?, ?, ?, ?)").run(id, String(l.kind || "url").slice(0, 10), url.slice(0, 500), String(l.label || url).slice(0, 80));
    }
  }

  /**
   * A row as the page sees it, with its labels, links and subtasks.
   * @param {Record<string, any>} r
   * @returns {Task}
   */
  function shape(r) {
    const tags = db.prepare("SELECT t.name FROM tags t JOIN task_tags tt ON tt.tag_id = t.id WHERE tt.task_id = ? ORDER BY t.name").all(r.id).map((t) => t.name);
    const links = db.prepare("SELECT kind, url, label FROM links WHERE task_id = ? ORDER BY id").all(r.id).map((l) => ({ ...l }));
    const subtasks = r.parent_id ? [] : db.prepare("SELECT * FROM tasks WHERE parent_id = ? ORDER BY position, created_at").all(r.id).map(shape);
    const project = r.project_id ? db.prepare("SELECT name FROM projects WHERE id = ?").get(r.project_id)?.name || null : null;
    return {
      id: r.id, scope: r.scope, title: r.title, notes: r.notes, priority: r.priority, dueDate: r.due_date, dueTime: r.due_time,
      someday: Boolean(r.someday), repeat: r.repeat, project, tags, links, doneAt: r.done_at, parentId: r.parent_id,
      position: r.position, createdAt: r.created_at, subtasks,
    };
  }

  /**
   * One task, or a 404.
   * @param {string} id
   * @returns {Record<string, any>}
   */
  function row(id) {
    const r = db.prepare("SELECT * FROM tasks WHERE id = ?").get(String(id));
    if (!r) throw Object.assign(codedError("not-found", "That task isn't there any more."), { status: 404 });
    return r;
  }

  /**
   * Adds a task from quick-add text.
   * @param {{ text: string, scope?: string, parentId?: string | null }} input
   * @returns {Task}
   */
  function add({ text, scope = "work", parentId = null }) {
    const parent = parentId ? row(parentId) : null;
    const sc = parent ? parent.scope : scopeOf(scope);
    const p = parseQuick(String(text || "").slice(0, 500), now(), { pmUpTo: prefs.pmUpTo });
    if (!p.title) throw codedError("input", "Give the task a name.");
    if (!p.priority) p.priority = prefs.priority;
    const id = newId();
    const at = iso();
    // A new task goes on top of its list, or at the bottom when Settings says so; a subtask always goes last.
    const ends = db.prepare("SELECT MIN(position) AS lo, MAX(position) AS hi FROM tasks WHERE scope = ? AND parent_id IS ?").get(sc, parent?.id ?? null);
    const position = parent ? (db.prepare("SELECT MAX(position) AS p FROM tasks WHERE parent_id = ?").get(parent.id).p ?? 0) + 1
      : prefs.newAt === "bottom" ? (ends.hi ?? -1) + 1 : (ends.lo ?? 1) - 1;
    db.prepare(`INSERT INTO tasks (id, scope, title, project_id, priority, due_date, due_time, someday, repeat, parent_id, position, remind_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, sc, p.title, projectId(p.project, sc), p.priority, p.dueDate, p.dueTime,
      p.someday ? 1 : 0, p.repeat, parent?.id ?? null, position, remindAt(p.dueDate, p.dueTime), at, at);
    setTags(id, p.tags);
    setLinks(id, p.links);
    return shape(row(id));
  }

  /**
   * Changes a task. Marking a repeating task done makes its next one.
   * @param {string} id
   * @param {Partial<{ title: string, notes: string, priority: number, dueDate: string | null, dueTime: string | null,
   *   someday: boolean, repeat: string | null, project: string | null, tags: string[], links: Array<{ url: string, label?: string, kind?: string }>, done: boolean }>} patch
   * @returns {{ task: Task, next: Task | null }}
   */
  function update(id, patch = {}) {
    const r = row(id);
    const set = {};
    if ("title" in patch) {
      const t = String(patch.title || "").replace(/\s+/g, " ").trim().slice(0, 500);
      if (!t) throw codedError("input", "Give the task a name.");
      set.title = t;
    }
    if ("notes" in patch) set.notes = String(patch.notes || "").slice(0, 20000);
    if ("priority" in patch) set.priority = [0, 1, 2, 3].includes(Number(patch.priority)) ? Number(patch.priority) : 0;
    if ("dueDate" in patch) {
      if (patch.dueDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(patch.dueDate))) throw codedError("input", "A due day looks like 2026-10-31.");
      set.due_date = patch.dueDate;
      if (patch.dueDate) set.someday = 0;
    }
    if ("dueTime" in patch) {
      if (patch.dueTime !== null && !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(patch.dueTime))) throw codedError("input", "A due time looks like 15:00.");
      set.due_time = patch.dueTime;
    }
    if ("someday" in patch) {
      set.someday = patch.someday ? 1 : 0;
      if (patch.someday) { set.due_date = null; set.due_time = null; }
    }
    if ("repeat" in patch) {
      if (patch.repeat && !nextDue(patch.repeat, ymd(now()), ymd(now()))) throw codedError("input", "Felix doesn't know that repeat. Try every day, every weekday, every week, every monday, every sprint or every month.");
      set.repeat = patch.repeat || null;
    }
    if ("project" in patch) set.project_id = projectId(patch.project, r.scope);
    if ("done" in patch) set.done_at = patch.done ? (r.done_at || iso()) : null;
    const dueDate = "due_date" in set ? set.due_date : r.due_date;
    const dueTime = "due_time" in set ? set.due_time : r.due_time;
    if ("due_date" in set || "due_time" in set) { set.remind_at = remindAt(dueDate, dueTime); set.reminded_at = null; }
    set.updated_at = iso();
    const cols = Object.keys(set);
    db.prepare(`UPDATE tasks SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE id = ?`).run(...cols.map((c) => set[c]), r.id);
    if (Array.isArray(patch.tags)) setTags(r.id, patch.tags);
    if (Array.isArray(patch.links)) setLinks(r.id, patch.links);

    let next = null;
    const repeat = "repeat" in set ? set.repeat : r.repeat;
    if (patch.done && !r.done_at && repeat && !r.parent_id) next = repeatAfter(r.id, repeat);
    return { task: shape(row(r.id)), next };
  }

  /**
   * Makes the next one of a repeating task: same name, notes, priority, labels, links and subtasks (not done).
   * @param {string} id
   * @param {string} repeat
   * @returns {Task | null}
   */
  function repeatAfter(id, repeat) {
    const done = shape(row(id));
    const due = nextDue(repeat, done.dueDate, ymd(now()));
    if (!due) return null;
    const nid = newId();
    const at = iso();
    const r = row(id);
    db.prepare(`INSERT INTO tasks (id, scope, title, notes, project_id, priority, due_date, due_time, repeat, position, remind_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(nid, r.scope, r.title, r.notes, r.project_id, r.priority, due, r.due_time, repeat, r.position, remindAt(due, r.due_time), at, at);
    setTags(nid, done.tags);
    setLinks(nid, done.links);
    for (const s of done.subtasks) {
      db.prepare(`INSERT INTO tasks (id, scope, title, notes, priority, parent_id, position, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(newId(), r.scope, s.title, s.notes, s.priority, nid, s.position, at, at);
    }
    db.prepare("UPDATE tasks SET repeat = NULL WHERE id = ?").run(id);
    return shape(row(nid));
  }

  /**
   * Deletes a task with its subtasks.
   * @param {string} id
   */
  function remove(id) {
    db.prepare("DELETE FROM tasks WHERE id = ?").run(row(id).id);
  }

  /**
   * Puts tasks in the order given (drag to reorder).
   * @param {string[]} ids
   */
  function reorder(ids) {
    const list = (Array.isArray(ids) ? ids : []).map(String).slice(0, 1000);
    const stmt = db.prepare("UPDATE tasks SET position = ? WHERE id = ?");
    list.forEach((id, i) => stmt.run(i, id));
  }

  /**
   * The SQL condition for a view.
   * @param {string} view
   * @param {string} today
   * @returns {string}
   */
  function where(view, today) {
    // Done times are saved in UTC, so "done today" compares against the start of today in this Mac's time zone.
    // Done today stays in Today (at the bottom) so a ticked task doesn't jump away, unless Settings turns it off.
    const open = `done_at IS NULL AND someday = 0 AND (due_date IS NULL OR due_date <= '${today}')`;
    if (view === "today") return prefs.doneToday ? `((${open}) OR done_at >= '${new Date(`${today}T00:00:00`).toISOString()}')` : open;
    if (view === "upcoming") return `done_at IS NULL AND due_date > '${today}'`;
    if (view === "overdue") return `done_at IS NULL AND due_date < '${today}'`;
    if (view === "someday") return "done_at IS NULL AND someday = 1";
    if (view === "done") return "done_at IS NOT NULL";
    return "1 = 1";
  }

  /**
   * A view of the tasks, with how many each view holds and the labels in use.
   * @param {{ scope?: string, view?: string, q?: string, tag?: string, project?: string }} [options]
   * @returns {{ view: string, tasks: Task[], counts: Record<string, number>, tags: string[], projects: string[] }}
   */
  function list({ scope = "work", view = "today", q = "", tag = "", project = "" } = {}) {
    const sc = scopeOf(scope);
    if (!VIEWS.includes(view)) throw codedError("input", `There's no "${view}" view.`);
    const today = ymd(now());
    const params = [sc];
    let filter = "";
    const search = String(q || "").trim().slice(0, 100);
    if (search) {
      filter += " AND (title LIKE ? ESCAPE '\\' OR notes LIKE ? ESCAPE '\\')";
      const like = `%${search.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      params.push(like, like);
    }
    if (tag) {
      filter += " AND id IN (SELECT tt.task_id FROM task_tags tt JOIN tags t ON t.id = tt.tag_id WHERE t.name = ?)";
      params.push(String(tag).toLowerCase());
    }
    if (project) {
      filter += " AND project_id IN (SELECT id FROM projects WHERE name = ? COLLATE NOCASE AND scope = ?)";
      params.push(String(project).slice(0, 60), sc);
    }
    const order = view === "done" ? "done_at DESC" : view === "upcoming" ? "due_date, due_time IS NULL, due_time, position"
      : "done_at IS NOT NULL, done_at, position, due_date IS NULL, due_date, due_time";
    // Done today stays in Today (at the bottom) so a ticked task doesn't jump away.
    const rows = db.prepare(`SELECT * FROM tasks WHERE scope = ? AND parent_id IS NULL AND ${where(view, today)}${filter} ORDER BY ${order} LIMIT 300`).all(...params);
    const counts = {};
    for (const v of ["today", "upcoming", "overdue", "someday"]) {
      const w = v === "today" ? `done_at IS NULL AND someday = 0 AND (due_date IS NULL OR due_date <= '${today}')` : where(v, today);
      counts[v] = db.prepare(`SELECT COUNT(*) AS n FROM tasks WHERE scope = ? AND parent_id IS NULL AND ${w}`).get(sc).n;
    }
    const tags = db.prepare(`SELECT DISTINCT t.name FROM tags t JOIN task_tags tt ON tt.tag_id = t.id JOIN tasks k ON k.id = tt.task_id
      WHERE k.scope = ? AND k.done_at IS NULL ORDER BY t.name`).all(sc).map((t) => t.name);
    const projects = db.prepare("SELECT name FROM projects WHERE scope = ? ORDER BY name").all(sc).map((p) => p.name);
    return { view, today, tasks: rows.map(shape), counts, tags, projects };
  }

  /**
   * Reminders that are due and not sent yet; each is marked sent as it's returned.
   * @returns {Array<{ id: string, title: string, dueTime: string }>}
   */
  function dueReminders() {
    const rows = db.prepare("SELECT id, title, due_time FROM tasks WHERE done_at IS NULL AND remind_at IS NOT NULL AND remind_at <= ? AND reminded_at IS NULL").all(iso());
    const mark = db.prepare("UPDATE tasks SET reminded_at = ? WHERE id = ?");
    for (const r of rows) mark.run(iso(), r.id);
    return rows.map((r) => ({ id: r.id, title: r.title, dueTime: r.due_time }));
  }

  /**
   * Every task, project, label and link, for the backup file.
   * @returns {{ projects: any[], tasks: any[], tags: any[], taskTags: any[], links: any[] }}
   */
  function dump() {
    const all = (sql) => db.prepare(sql).all().map((r) => ({ ...r }));
    return { projects: all("SELECT * FROM projects"), tasks: all("SELECT * FROM tasks"), tags: all("SELECT * FROM tags"), taskTags: all("SELECT * FROM task_tags"), links: all("SELECT * FROM links") };
  }

  /** Closes the database. */
  const close = () => db.close();

  /**
   * Changes how tasks are added and listed, as Settings says.
   * @param {Partial<TaskPrefs>} next Values left out or undefined stay as they are.
   */
  function configure(next) {
    prefs = { ...prefs, ...Object.fromEntries(Object.entries(next || {}).filter(([k, v]) => k in TASK_PREFS && v !== undefined)) };
  }

  return { add, update, remove, reorder, list, get: (id) => shape(row(id)), dueReminders, dump, close, configure };
}
