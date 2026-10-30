/**
 * The work day's clock, shared by the server (shift.mjs) and the page (shift.js): which step can follow which,
 * the message each step posts, and the times the top bar shows. Nothing here reads a file or the clock; the
 * caller passes the time in, so the server and every window work the same sums.
 */

/** #attendance-engineering-ph, where Start my day posts. */
export const ATTENDANCE = Object.freeze({ id: "C08HMFEDS5P", name: "#attendance-engineering-ph" });

const HOUR = 3600e3;
const MINUTE = 60e3;

/**
 * @typedef {"off" | "working" | "break" | "ended"} Status
 * @typedef {"start" | "break" | "back" | "end"} Action
 * @typedef {{ start: string, end: string | null }} Break
 * @typedef {{ id: string, action: Action, text: string, at: string, presence: "auto" | "away" | null,
 *   slack: "pending" | "off" | "disabled" | "posted" | "failed" | "skipped" | "expired", error?: string }} Note
 *   What the last step posts (or would post) to Slack, and what became of it.
 * @typedef {{ status: Status, startedAt: string | null, endedAt: string | null, breaks: Break[], remindAt: string | null,
 *   remindedAt: string | null, note: Note | null }} Shift
 * @typedef {{ on: boolean, dayHours: number, breakPauses: boolean, reminder: boolean, snooze: number, slack: boolean,
 *   messages: { morning: string, afternoon: string, evening: string, break: string, back: string, bye: string } }} ShiftPrefs
 */

/** A day that hasn't started. */
export const NO_SHIFT = Object.freeze({ status: "off", startedAt: null, endedAt: null, breaks: [], remindAt: null, remindedAt: null, note: null });

/** Each step, the statuses it can start from, and the one it leads to. */
export const STEPS = Object.freeze({
  start: { from: ["off", "ended"], to: "working" },
  break: { from: ["working"], to: "break" },
  back: { from: ["break"], to: "working" },
  end: { from: ["working", "break"], to: "ended" },
});

/** The Slack presence each step sets: active (Slack's "auto") when the day starts, away when it ends. */
export const PRESENCE = Object.freeze({ start: "auto", end: "away" });

/**
 * The work day's settings, picked out of all of Felix's settings.
 * @param {Record<string, unknown>} s
 * @returns {ShiftPrefs}
 */
export function shiftPrefs(s) {
  // An emptied message box means the message out of the box.
  const said = (key, text) => String(s[key] ?? "").trim() || text;
  return {
    on: s.shiftOn !== false,
    dayHours: Number(s.shiftHours) || 9,
    breakPauses: s.shiftBreakPauses === true,
    reminder: s.shiftReminder !== false,
    snooze: Number(s.shiftSnooze) || 30,
    slack: s.shiftSlack !== false,
    messages: {
      morning: said("shiftMorning", "Good morning"),
      afternoon: said("shiftAfternoon", "Good afternoon"),
      evening: said("shiftEvening", "Good evening"),
      break: said("shiftBreak", "Be right back!"),
      back: said("shiftBack", "I'm back!"),
      bye: said("shiftBye", "Bye for now!"),
    },
  };
}

/**
 * The greeting for the time of day: morning until noon, afternoon until 6 PM, evening after.
 * @param {number} hour 0 to 23, on this Mac's clock.
 * @param {ShiftPrefs["messages"]} messages
 * @returns {string}
 */
export function greetingFor(hour, messages) {
  if (hour < 12) return messages.morning;
  return hour < 18 ? messages.afternoon : messages.evening;
}

/**
 * The message a step posts to Slack.
 * @param {Action} action
 * @param {ShiftPrefs} prefs
 * @param {number} hour The hour it's taken at, for the greeting.
 * @returns {string}
 */
export function messageFor(action, prefs, hour) {
  const m = prefs.messages;
  return { start: greetingFor(hour, m), break: m.break, back: m.back, end: m.bye }[action];
}

/**
 * The status a step leads to, or null when it can't follow the current one (a break before the day starts).
 * @param {Status} status
 * @param {Action} action
 * @returns {Status | null}
 */
export function nextStatus(status, action) {
  const step = Object.hasOwn(STEPS, action) ? STEPS[action] : null;
  return step && step.from.includes(status) ? step.to : null;
}

/**
 * The day's times at a moment: how long since it started, how much of it was breaks, and when its hours are up.
 * With breaks pausing the countdown, the hours run out later by the time spent on breaks.
 * @param {Shift} shift
 * @param {Pick<ShiftPrefs, "dayHours" | "breakPauses">} prefs
 * @param {number} now
 * @returns {{ elapsedMs: number, breakMs: number, workedMs: number, dueAt: number, leftMs: number, onBreakMs: number } | null}
 *   Null before the day starts.
 */
export function shiftTimes(shift, prefs, now) {
  if (!shift?.startedAt) return null;
  const start = Date.parse(shift.startedAt);
  const until = shift.endedAt ? Date.parse(shift.endedAt) : now;
  const lengths = (shift.breaks || []).map((b) => Math.max(0, (b.end ? Date.parse(b.end) : until) - Date.parse(b.start)));
  const breakMs = lengths.reduce((a, b) => a + b, 0);
  const open = shift.status === "break" ? lengths.at(-1) || 0 : 0;
  const dueAt = start + prefs.dayHours * HOUR + (prefs.breakPauses ? breakMs : 0);
  const elapsedMs = Math.max(0, until - start);
  return { elapsedMs, breakMs, workedMs: Math.max(0, elapsedMs - breakMs), dueAt, leftMs: dueAt - until, onBreakMs: open };
}

/**
 * When Felix next reminds you to end your day: when your hours are up, or later when you said "not yet".
 * @param {Shift} shift
 * @param {ShiftPrefs} prefs
 * @param {number} now
 * @returns {number | null} Null when the day isn't running or the reminder is off.
 */
export function reminderAt(shift, prefs, now) {
  if (!prefs.on || !prefs.reminder || (shift.status !== "working" && shift.status !== "break")) return null;
  const times = shiftTimes(shift, prefs, now);
  return Math.max(times.dueAt, shift.remindAt ? Date.parse(shift.remindAt) : 0);
}

/**
 * A length of time as the top bar shows it: "45m", "2h 05m".
 * @param {number} ms
 * @returns {string}
 */
export function clockText(ms) {
  const minutes = Math.floor(Math.max(0, ms) / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

/**
 * The day length as words: "9 hours", "8.5 hours", "1 hour".
 * @param {number} hours
 * @returns {string}
 */
export const hoursText = (hours) => `${hours} hour${hours === 1 ? "" : "s"}`;
