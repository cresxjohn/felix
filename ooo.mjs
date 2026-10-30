/**
 * The Team out of office card's data: who is on leave, from the Tech Team Vacation Tracker calendar, read with the
 * work Google sign-in. Leave entries are all-day events titled like "Joy M PTO", "Mervs B - PTO (Birthday)" or
 * "Cres - VL"; each becomes a person, the kind of leave and the dates (Google's end date is the day after).
 * Your team is a list kept on this Mac (data/team.json): who's on it, their display name, and the nicknames the
 * tracker uses for them, so "Joy M" and "Joy" count as one person.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const TRACKER = "c_jieq9t3t5r8c2ino7235kp71vo@group.calendar.google.com";
const API = "https://www.googleapis.com/calendar/v3";
const CACHE_MINUTES = 5;
// The words the tracker uses for time off. A title with none of them (a team offsite, a company notice) isn't a leave.
const KINDS = ["PTO", "VL", "SL", "EL", "UTO", "OOO", "Offset", "Birthday", "Holiday", "WFH", "Leave", "Sick", "Out", "Off", "Traveling", "Limited"];
// Longer ways of saying the same, read as one word first: "Out of Office" is OOO, "Emergency Leave" is EL.
const PHRASES = [
  [/\bout of (?:the )?office\b/gi, "OOO"], [/\bout of (?:the )?country\b/gi, "Out"], [/\bemergency leave\b/gi, "EL"],
  [/\bsick leave\b/gi, "SL"], [/\bvacation(?: leave)?\b/gi, "VL"], [/\blimited availability\b/gi, "Limited"], [/\btravell?ing\b/gi, "Traveling"],
];
// Words about when in the day, dropped from a name: "Edel - Afternoon Emergency Leave" is Edel's.
const PARTS_OF_DAY = new Set(["am", "pm", "morning", "afternoon", "half", "halfday", "half-day", "whole", "day"]);

/**
 * @typedef {{ name: string, kind: string, note: string, from: string, to: string }} Leave `from` and `to` are days
 *   (YYYY-MM-DD), both counted: a one-day leave has from === to.
 * @typedef {{ id: string, name: string, nicknames: string[], onTeam: boolean }} Person
 */

/**
 * A name as people write it: "RUSHTON" reads "Rushton"; mixed case is left alone.
 * @param {string} name
 * @returns {string}
 */
const nameCase = (name) => name.replace(/\p{L}{4,}/gu, (w) => (w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w));

/**
 * Reads a tracker title: the person's name, the kind of leave and a note. A title with no word for time off isn't
 * a leave, and gets kind null.
 * @param {string} title
 * @returns {{ name: string, kind: string | null, note: string }}
 */
export function parseTitle(title) {
  const text = String(title || "").replace(/\s+/g, " ").trim();
  const note = text.match(/\(([^)]*)\)\s*$/)?.[1]?.trim() || "";
  let body = text.replace(/\(([^)]*)\)\s*$/, "").replace(/[\s:–—-]+$/, "").trim();
  for (const [re, word] of PHRASES) body = body.replace(re, word);
  const words = body.split(/\s*[-–—:,]\s*|\s+/).filter(Boolean);
  const kindOf = (w) => KINDS.find((k) => k.toLowerCase() === w.toLowerCase());
  const at = words.findIndex(kindOf);
  if (at < 0) {
    const fromNote = kindOf(note);
    return { name: nameCase(body), kind: fromNote || null, note: fromNote ? "" : note };
  }
  // Usually "<name> <kind>", but some write the kind first: "PTO - Jordan".
  const named = (at > 0 ? words.slice(0, at) : words.slice(1)).filter((w) => !kindOf(w));
  while (named.length > 1 && PARTS_OF_DAY.has(named.at(-1).toLowerCase())) named.pop();
  return { name: nameCase(named.join(" ") || body), kind: kindOf(words[at]), note };
}

/**
 * A name made plain for matching: lower case, single spaces, no dots.
 * @param {string} name
 * @returns {string}
 */
export const plain = (name) => String(name || "").toLowerCase().replace(/[.]/g, "").replace(/\s+/g, " ").trim();

/**
 * The day before a date (Google's all-day end dates are the day after the last day).
 * @param {string} day YYYY-MM-DD
 * @returns {string}
 */
const dayBefore = (day) => new Date(Date.parse(`${day}T12:00:00Z`) - 86400e3).toISOString().slice(0, 10);

/**
 * Turns one tracker event into a leave, or null for one that isn't all-day or was cancelled.
 * @param {Record<string, any>} e
 * @returns {Leave | null}
 */
export function toLeave(e) {
  if (e.status === "cancelled" || !e.start?.date) return null;
  const { name, kind, note } = parseTitle(e.summary);
  if (!kind || !name) return null;
  return { name, kind, note, from: e.start.date, to: e.end?.date ? dayBefore(e.end.date) : e.start.date };
}

/**
 * The person a tracker name belongs to: an exact nickname first, then the display name, then a first-name match.
 * @param {string} name
 * @param {Person[]} people
 * @returns {Person | null}
 */
export function personFor(name, people) {
  const n = plain(name);
  return people.find((p) => p.nicknames.some((k) => plain(k) === n))
    || people.find((p) => plain(p.name) === n)
    || people.find((p) => samePerson(plain(p.name), n))
    || firstNameOnly(n, people)
    || null;
}

/**
 * The one person whose first name matches, when the tracker gives only that ("Joy" for "Joy M"). Two people with
 * the same first name match neither, so "Kevin" never lands on the wrong Kevin.
 * @param {string} n Plain name.
 * @param {Person[]} people
 * @returns {Person | null}
 */
function firstNameOnly(n, people) {
  const first = n.split(" ")[0];
  const same = people.filter((p) => plain(p.name).split(" ")[0] === first);
  return same.length === 1 && (n === first || plain(same[0].name) === first) ? same[0] : null;
}

/**
 * Whether two full names are one person written two ways: the same last name, and one first name the start of the
 * other ("Ale Nieto" and "Alejandro Nieto").
 * @param {string} a Plain name.
 * @param {string} b Plain name.
 * @returns {boolean}
 */
export function samePerson(a, b) {
  const [x, y] = [a.split(" "), b.split(" ")];
  if (x.length < 2 || y.length < 2 || x.at(-1) !== y.at(-1) || x.at(-1).length < 2) return false;
  const [short, long] = x[0].length <= y[0].length ? [x[0], y[0]] : [y[0], x[0]];
  return short.length >= 3 && long.startsWith(short);
}

/**
 * Creates the out-of-office reader.
 * @param {{ google: { get: (account: string, url: string) => Promise<any> }, dir: string, now?: () => number }} options
 */
export function createOoo({ google, dir, now = Date.now }) {
  const file = path.join(dir, "team.json");
  const cache = new Map();

  /**
   * Your team list.
   * @returns {Promise<Person[]>}
   */
  async function team() {
    try { return JSON.parse(await readFile(file, "utf8")).people || []; } catch { return []; }
  }

  /**
   * Saves your team list, keeping only well-formed entries.
   * @param {Person[]} people
   * @returns {Promise<Person[]>}
   */
  async function saveTeam(people) {
    const clean = (Array.isArray(people) ? people : []).filter((p) => p && typeof p.name === "string" && p.name.trim()).slice(0, 300).map((p, i) => ({
      id: String(p.id || `p${Date.now().toString(36)}${i}`).slice(0, 40),
      name: p.name.trim().slice(0, 80),
      nicknames: (Array.isArray(p.nicknames) ? p.nicknames : []).map((k) => String(k).trim().slice(0, 80)).filter(Boolean).slice(0, 10),
      onTeam: p.onTeam === true,
    }));
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify({ people: clean }, null, 2)}\n`);
    return clean;
  }

  /**
   * The tracker's leaves overlapping a range of days.
   * @param {string} from YYYY-MM-DD
   * @param {string} to YYYY-MM-DD, counted.
   * @param {boolean} fresh
   * @param {number} [cacheMinutes] How long an answer is kept: 5 minutes unless Settings says otherwise.
   * @returns {Promise<Leave[]>}
   */
  async function leaves(from, to, fresh, cacheMinutes = CACHE_MINUTES) {
    const key = `${from}|${to}`;
    const hit = cache.get(key);
    if (!fresh && hit && now() - hit.at < cacheMinutes * 60e3) return hit.leaves;
    const q = new URLSearchParams({
      timeMin: `${from}T00:00:00Z`, timeMax: new Date(Date.parse(`${to}T00:00:00Z`) + 2 * 86400e3).toISOString(),
      singleEvents: "true", orderBy: "startTime", maxResults: "500",
    });
    const answer = await google.get("work", `${API}/calendars/${encodeURIComponent(TRACKER)}/events?${q}`);
    const list = (answer.items || []).map(toLeave).filter((l) => l && l.from <= to && l.to >= from);
    cache.set(key, { at: now(), leaves: list });
    return list;
  }

  /**
   * Who is out in a range: each leave with the person it belongs to (when they're on your list), whether they're
   * out for the whole range, and the tracker names not on your list yet.
   * @param {{ from: string, to: string, fresh?: boolean, cacheMinutes?: number }} range
   * @returns {Promise<{ fetchedAt: string, from: string, to: string, out: Array<Leave & { person: string | null, onTeam: boolean, holiday: boolean, whole: boolean }>,
   *   teamSize: number, unknown: string[] }>}
   */
  async function out({ from, to, fresh = false, cacheMinutes }) {
    const [list, people] = await Promise.all([leaves(from, to, fresh, cacheMinutes), team()]);
    const rows = list.map((l) => {
      // A holiday belongs to a country or office ("PH Holiday"), not a person.
      if (l.kind === "Holiday") return { ...l, person: null, onTeam: false, holiday: true, whole: l.from <= from && l.to >= to };
      const p = personFor(l.name, people);
      return { ...l, name: p?.name || l.name, person: p?.id || null, onTeam: Boolean(p?.onTeam), holiday: false, whole: l.from <= from && l.to >= to };
    });
    const unknown = [...new Set(list.filter((l) => l.kind !== "Holiday" && !personFor(l.name, people)).map((l) => l.name))];
    return { fetchedAt: new Date(now()).toISOString(), from, to, out: rows, teamSize: people.filter((p) => p.onTeam).length, unknown };
  }

  /**
   * Everyone the tracker has named in the past year, to start your team list from: your list as it is, plus a
   * new entry (not on your team yet) for each tracker name that matches nobody.
   * @param {{ fresh?: boolean, cacheMinutes?: number }} [options]
   * @returns {Promise<Person[]>}
   */
  async function roster({ fresh = false, cacheMinutes } = {}) {
    const today = new Date(now()).toISOString().slice(0, 10);
    const yearAgo = new Date(now() - 365 * 86400e3).toISOString().slice(0, 10);
    const ahead = new Date(now() + 90 * 86400e3).toISOString().slice(0, 10);
    const [past, upcoming, people] = await Promise.all([leaves(yearAgo, today, fresh, cacheMinutes), leaves(today, ahead, fresh, cacheMinutes), team()]);
    const list = people.map((p) => ({ ...p, nicknames: [...p.nicknames] }));
    // Longest names first, so "Alejandro Nieto" is the name and "Ale Nieto" becomes another way of writing it.
    const names = [...new Set([...past, ...upcoming].filter((l) => l.kind !== "Holiday").map((l) => l.name))].sort((a, b) => b.length - a.length);
    for (const name of names) {
      const n = plain(name);
      const p = list.find((x) => x.nicknames.some((k) => plain(k) === n) || plain(x.name) === n || samePerson(plain(x.name), n))
        || (n.includes(" ") ? null : firstNameOnly(n, list));
      if (p) {
        if (!p.nicknames.some((k) => plain(k) === n)) p.nicknames.push(name);
        continue;
      }
      list.push({ id: `t${list.length}${n.replace(/\W/g, "")}`.slice(0, 40), name, nicknames: [name], onTeam: false });
    }
    return list.sort((a, b) => Number(b.onTeam) - Number(a.onTeam) || a.name.localeCompare(b.name));
  }

  /** Forgets cached leaves, as after signing in. */
  const reset = () => cache.clear();

  return { out, roster, team, saveTeam, reset };
}
