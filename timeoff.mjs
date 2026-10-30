/**
 * My time off: your own leave from the Tech Team Vacation Tracker (read through ooo.mjs, the same reader the work
 * Team out of office card uses), and the Philippine holidays the tracker marks, turned into breaks: runs of days
 * off, weekends included. A holiday on a Saturday or Sunday isn't an extra day off, and the card says so.
 *
 * Who "you" are is a person on your team list (data/team.json), picked once on the card and kept in Settings
 * (timeoffMe), so Felix never guesses from a name. Days are YYYY-MM-DD in this Mac's time zone.
 */
import { addDays } from "./tasks.mjs";

/**
 * Whether a day is a Saturday or Sunday.
 * @param {string} day YYYY-MM-DD
 * @returns {boolean}
 */
export const isWeekend = (day) => [0, 6].includes(new Date(`${day}T12:00:00Z`).getUTCDay());

/**
 * Days from one day to another, by the calendar.
 * @param {string} from
 * @param {string} to
 * @returns {number}
 */
export const daysFrom = (from, to) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400e3);

/**
 * Every day from one to another, both counted.
 * @param {string} from
 * @param {string} to
 * @returns {string[]}
 */
export function eachDay(from, to) {
  const out = [];
  for (let d = from; d <= to && out.length < 1000; d = addDays(d, 1)) out.push(d);
  return out;
}

/**
 * @typedef {{ kind: string, note?: string, from: string, to: string }} MyLeave
 * @typedef {{ day: string, name: string }} Holiday
 * @typedef {{ from: string, to: string, days: number, leaveDays: number, kinds: string[], holidays: Holiday[] }} Break
 *   `days` counts every day of the run, weekends too; `leaveDays` the weekdays your leave covers (holidays not
 *   counted); `holidays` the ones on weekdays in it.
 */

/**
 * Your breaks: each run of days off that holds at least one weekday off (a leave day or a holiday), stretched over
 * the weekends and other days off touching it. A Friday off makes a three-day weekend; a holiday on a Sunday adds
 * nothing on its own.
 * @param {{ leaves: MyLeave[], holidays: Holiday[] }} input
 * @returns {Break[]} Soonest first.
 */
export function breaks({ leaves, holidays }) {
  const holidayOn = new Map(holidays.map((h) => [h.day, h]));
  const leaveOn = new Map();
  for (const l of leaves) for (const d of eachDay(l.from, l.to)) if (!leaveOn.has(d)) leaveOn.set(d, l);
  const offWeekday = (d) => !isWeekend(d) && (leaveOn.has(d) || holidayOn.has(d));
  const off = (d) => isWeekend(d) || offWeekday(d);
  const starts = [...new Set([...leaveOn.keys(), ...holidayOn.keys()])].filter(offWeekday).sort();
  const out = [];
  for (const start of starts) {
    if (out.length && start <= out.at(-1).to) continue;
    let from = start;
    let to = start;
    while (off(addDays(from, -1))) from = addDays(from, -1);
    while (off(addDays(to, 1))) to = addDays(to, 1);
    const days = eachDay(from, to);
    const weekdays = days.filter((d) => !isWeekend(d));
    out.push({
      from, to, days: days.length,
      leaveDays: weekdays.filter((d) => leaveOn.has(d) && !holidayOn.has(d)).length,
      kinds: [...new Set(weekdays.filter((d) => leaveOn.has(d)).map((d) => leaveOn.get(d).kind))],
      holidays: weekdays.filter((d) => holidayOn.has(d)).map((d) => holidayOn.get(d)),
    });
  }
  return out;
}

/**
 * The break you're on now, or the next one to come.
 * @param {Break[]} list From `breaks`.
 * @param {string} today
 * @returns {(Break & { now: boolean, inDays: number }) | null}
 */
export function nextBreak(list, today) {
  const b = list.find((x) => x.to >= today);
  return b ? { ...b, now: b.from <= today, inDays: Math.max(0, daysFrom(today, b.from)) } : null;
}

/**
 * The weekdays a leave covers, leaving out holidays: what it takes from your leave.
 * @param {{ from: string, to: string }} l
 * @param {Set<string>} holidayDays
 * @param {{ from?: string, to?: string }} [clip] Count only within these days.
 * @returns {number}
 */
export function workDays(l, holidayDays, { from = l.from, to = l.to } = {}) {
  return eachDay(l.from > from ? l.from : from, l.to < to ? l.to : to).filter((d) => !isWeekend(d) && !holidayDays.has(d)).length;
}

/**
 * Builds the card's view from the tracker's rows for you and the holidays.
 * @param {{ mine: MyLeave[], holidays: Holiday[], today: string, ahead: number }} input
 * @returns {{ next: ReturnType<typeof nextBreak>, booked: Array<MyLeave & { days: number }>, weekendHolidays: Holiday[],
 *   year: { kinds: Array<{ kind: string, days: number }>, total: number } }}
 */
export function timeOffView({ mine, holidays, today, ahead }) {
  const holidayDays = new Set(holidays.map((h) => h.day));
  const until = addDays(today, ahead);
  const next = nextBreak(breaks({ leaves: mine, holidays }), today);
  const booked = mine.filter((l) => l.to >= today && l.from <= until).sort((a, b) => a.from.localeCompare(b.from))
    .map((l) => ({ ...l, days: workDays(l, holidayDays) }));
  // A holiday on a weekend before the next break (or soon, when there's none) is worth a plain word.
  const noteUntil = next ? next.from : addDays(today, 30);
  const weekendHolidays = holidays.filter((h) => isWeekend(h.day) && h.day >= today && h.day <= noteUntil).sort((a, b) => a.day.localeCompare(b.day));
  const yearStart = `${today.slice(0, 4)}-01-01`;
  const byKind = new Map();
  for (const l of mine) {
    if (l.to < yearStart || l.from > today) continue;
    const n = workDays(l, holidayDays, { from: yearStart, to: today });
    if (n) byKind.set(l.kind, (byKind.get(l.kind) || 0) + n);
  }
  const kinds = [...byKind].map(([kind, days]) => ({ kind, days })).sort((a, b) => b.days - a.days || a.kind.localeCompare(b.kind));
  return { next, booked, weekendHolidays, year: { kinds, total: kinds.reduce((s, k) => s + k.days, 0) } };
}

/**
 * Whether a tracker holiday row is a Philippine one ("PH Holiday"), as opposed to the US, Colombia and others.
 * @param {{ name: string }} row
 * @returns {boolean}
 */
export const isPhHoliday = (row) => /^(ph|philippines?)\b/i.test(String(row.name || "").trim());

/**
 * Creates the My time off reader.
 * @param {{ ooo: { out: Function, team: Function }, holidayNames?: (from: string, to: string) => Promise<Map<string, string>>,
 *   today: () => string }} options `holidayNames` gives Philippine holidays' names by day, when it can.
 */
export function createTimeOff({ ooo, holidayNames = async () => new Map(), today }) {
  /**
   * The card's data for the person picked as you, or the team list to pick from when nobody is picked yet (or when
   * `pick` asks for it, to pick again; the tracker isn't read then).
   * @param {{ me: string, ahead?: number, fresh?: boolean, cacheMinutes?: number, pick?: boolean }} options
   */
  async function view({ me, ahead = 180, fresh = false, cacheMinutes, pick = false }) {
    const people = await ooo.team();
    const person = people.find((p) => p.id === me);
    const pickFrom = () => people.map((p) => ({ id: p.id, name: p.name, onTeam: p.onTeam }))
      .sort((a, b) => Number(b.onTeam) - Number(a.onTeam) || a.name.localeCompare(b.name));
    if (!person || pick) return { needsMe: true, gone: Boolean(me) && !person, people: pickFrom() };
    const t = today();
    const yearStart = `${t.slice(0, 4)}-01-01`;
    const until = addDays(t, ahead);
    const [past, coming] = await Promise.all([
      ooo.out({ from: yearStart, to: t, fresh, cacheMinutes }),
      ooo.out({ from: t, to: until, fresh, cacheMinutes }),
    ]);
    const rows = [...past.out, ...coming.out];
    const seen = new Set();
    const mine = rows.filter((r) => r.person === person.id && !r.holiday)
      .filter((r) => !seen.has(`${r.from}|${r.to}|${r.kind}`) && seen.add(`${r.from}|${r.to}|${r.kind}`))
      .map((r) => ({ kind: r.kind, note: r.note, from: r.from, to: r.to }));
    const names = await holidayNames(yearStart, until).catch(() => new Map());
    const holidayDays = new Set();
    for (const r of rows.filter((x) => x.holiday && isPhHoliday(x))) for (const d of eachDay(r.from, r.to)) holidayDays.add(d);
    const holidays = [...holidayDays].sort().map((day) => ({ day, name: names.get(day) || "" }));
    return { fetchedAt: coming.fetchedAt, today: t, me: { id: person.id, name: person.name }, ahead, ...timeOffView({ mine, holidays, today: t, ahead }) };
  }

  return { view };
}
