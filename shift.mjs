/**
 * The work day: Start my day, Take a break, I'm back and End my day. The state lives in data/shift.json, so a
 * restart or a reload keeps it and every open window shows the same day. Each step changes the day here at once;
 * what it posts to Slack waits for your yes (posting leaves the Mac), and until Slack is connected the message is
 * only offered for you to copy. When your hours are up, a Mac notification suggests ending the day, once, and again
 * after each "not yet".
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { codedError } from "./keychain.mjs";
import { ATTENDANCE, NO_SHIFT, PRESENCE, clockText, hoursText, messageFor, nextStatus, reminderAt, shiftPrefs, shiftTimes } from "./public/shift-clock.mjs";

// A post you haven't answered in this long is dropped, so an old "Good morning" never goes out at lunch.
const PENDING_MS = 15 * 60e3;
const TICK_MS = 30e3;
const STATUSES = new Set(["off", "working", "break", "ended"]);

/**
 * @typedef {import("./public/shift-clock.mjs").Shift} Shift
 * @typedef {import("./public/shift-clock.mjs").Note} Note
 * @typedef {import("./public/shift-clock.mjs").ShiftPrefs} ShiftPrefs
 * @typedef {{ shift: Shift, prefs: ShiftPrefs, slack: { connected: boolean }, channel: string, now: string,
 *   times: ReturnType<typeof shiftTimes>, reminder: { at: string, due: boolean } | null }} View What the page draws.
 * @typedef {{ connected: () => Promise<boolean>, post: (channel: string, text: string) => Promise<object>,
 *   presence: (p: "auto" | "away") => Promise<object> }} Slack
 */

/**
 * Shows a Mac notification. The words go in as arguments, never into the script, so nothing in them can run.
 * @param {string} title
 * @param {string} text
 * @param {{ run?: typeof execFile }} [deps]
 */
export function macNotify(title, text, { run = execFile } = {}) {
  const script = ["on run argv", "display notification (item 2 of argv) with title (item 1 of argv)", "end run"];
  run("osascript", [...script.flatMap((line) => ["-e", line]), title, text], () => {});
}

/**
 * A saved day, checked: anything unreadable or odd is a day that hasn't started.
 * @param {unknown} saved
 * @returns {Shift}
 */
export function cleanShift(saved) {
  if (!saved || typeof saved !== "object" || !STATUSES.has(saved.status)) return { ...NO_SHIFT, breaks: [] };
  const time = (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? v : null);
  if (saved.status !== "off" && !time(saved.startedAt)) return { ...NO_SHIFT, breaks: [] };
  const breaks = Array.isArray(saved.breaks) ? saved.breaks.filter((b) => time(b?.start)).map((b) => ({ start: b.start, end: time(b.end) })) : [];
  const note = saved.note && typeof saved.note.text === "string" && typeof saved.note.id === "string" ? saved.note : null;
  return {
    status: saved.status,
    startedAt: time(saved.startedAt),
    endedAt: time(saved.endedAt),
    breaks,
    remindAt: time(saved.remindAt),
    remindedAt: time(saved.remindedAt),
    note,
  };
}

/**
 * A time of day as Felix says it: "9:02 AM".
 * @param {number} at
 * @returns {string}
 */
export const timeOfDay = (at) => new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }).replace(/\s/g, " ");

/**
 * Makes the work day.
 * @param {object} deps
 * @param {string} deps.file Where the day is kept (data/shift.json).
 * @param {{ get: () => Promise<Record<string, unknown>> }} deps.settings
 * @param {Slack} deps.slack
 * @param {(title: string, text: string) => void} [deps.notify]
 * @param {() => number} [deps.now]
 * @param {() => string} [deps.newId]
 * @param {(file: string, encoding: "utf8") => Promise<string>} [deps.read]
 * @param {(file: string, text: string) => Promise<void>} [deps.write]
 */
export function createShift({ file, settings, slack, notify = macNotify, now = Date.now, newId = randomUUID, read = readFile, write = writeAtomic }) {
  let current = null;
  let queue = Promise.resolve();

  /**
   * The day as saved, read from disk once.
   * @returns {Promise<Shift>}
   */
  async function load() {
    current ??= cleanShift(await read(file, "utf8").then(JSON.parse).catch(() => null));
    return current;
  }

  /**
   * Saves the day.
   * @param {Shift} next
   * @returns {Promise<Shift>}
   */
  async function save(next) {
    current = next;
    await write(file, `${JSON.stringify(next, null, 2)}\n`);
    return next;
  }

  /**
   * Runs one change at a time, so two windows clicking at once can't both start the day.
   * @template T
   * @param {() => Promise<T>} job
   * @returns {Promise<T>}
   */
  function one(job) {
    const run = queue.then(job, job);
    queue = run.catch(() => {});
    return run;
  }

  /**
   * The last step's note, marked expired once its post waited too long.
   * @param {Note | null} note
   * @param {number} t
   * @returns {Note | null}
   */
  const fresh = (note, t) => (note?.slack === "pending" && t - Date.parse(note.at) > PENDING_MS ? { ...note, slack: "expired" } : note);

  /**
   * The day as the page draws it.
   * @returns {Promise<View>}
   */
  async function view() {
    const [shift, prefs, connected] = await Promise.all([load(), settings.get().then(shiftPrefs), slack.connected().catch(() => false)]);
    const t = now();
    const at = reminderAt(shift, prefs, t);
    return {
      shift: { ...shift, note: fresh(shift.note, t) },
      prefs,
      slack: { connected },
      channel: ATTENDANCE.name,
      now: new Date(t).toISOString(),
      times: shiftTimes(shift, prefs, t),
      reminder: at === null ? null : { at: new Date(at).toISOString(), due: t >= at },
    };
  }

  /**
   * Takes one step of the day: start, break, back or end. The day changes here at once; its Slack message waits
   * for your yes when Slack is connected, and is only offered to copy when it isn't.
   * @param {string} action
   * @returns {Promise<View>}
   * @throws {Error & { code: string }} "off" when the feature is off in Settings, "state" when the step can't follow.
   */
  function act(action) {
    return one(async () => {
      const prefs = shiftPrefs(await settings.get());
      if (!prefs.on) throw codedError("off", "Start my day is turned off in Settings.");
      const shift = await load();
      const status = nextStatus(shift.status, action);
      if (!status) throw codedError("state", cantText(shift.status, action));
      const t = now();
      const at = new Date(t).toISOString();
      const connected = prefs.slack && (await slack.connected().catch(() => false));
      /** @type {Note} */
      const note = {
        id: newId(), action, text: messageFor(action, prefs, new Date(t).getHours()), at, presence: PRESENCE[action] || null,
        slack: !prefs.slack ? "disabled" : connected ? "pending" : "off",
      };
      const breaks = action === "start" ? [] : shift.breaks.map((b) => (b.end ? b : { ...b, end: at }));
      if (action === "break") breaks.push({ start: at, end: null });
      await save({
        ...shift,
        status,
        startedAt: action === "start" ? at : shift.startedAt,
        endedAt: action === "end" ? at : action === "start" ? null : shift.endedAt,
        breaks,
        remindAt: action === "start" ? null : shift.remindAt,
        remindedAt: action === "start" ? null : shift.remindedAt,
        note,
      });
      return view();
    });
  }

  /**
   * Answers the waiting Slack post: yes posts it (and sets your presence when the step does), no drops it.
   * @param {string} id The note's id, so an old answer can't post a newer message.
   * @param {boolean} yes
   * @returns {Promise<View>}
   * @throws {Error & { code: string }} "gone" when nothing is waiting under that id, or it waited too long.
   */
  function answer(id, yes) {
    return one(async () => {
      const shift = await load();
      const note = fresh(shift.note, now());
      if (!note || note.id !== id || note.slack !== "pending") {
        if (note?.slack === "expired") await save({ ...shift, note });
        throw codedError("gone", note?.slack === "expired" ? "That post waited too long, so it wasn't sent." : "There's no Slack post waiting for an answer.");
      }
      let done = { ...note, slack: "skipped" };
      if (yes) {
        try {
          await slack.post(ATTENDANCE.id, note.text);
          if (note.presence) await slack.presence(note.presence);
          done = { ...note, slack: "posted" };
        } catch (e) {
          done = { ...note, slack: "failed", error: e.message };
        }
      }
      await save({ ...shift, note: done });
      return view();
    });
  }

  /**
   * "Not yet": asks again after the snooze time from Settings.
   * @returns {Promise<View>}
   * @throws {Error & { code: "state" }} When the day isn't running.
   */
  function snooze() {
    return one(async () => {
      const prefs = shiftPrefs(await settings.get());
      const shift = await load();
      if (shift.status !== "working" && shift.status !== "break") throw codedError("state", "Your day isn't running, so there's nothing to remind you about.");
      await save({ ...shift, remindAt: new Date(now() + prefs.snooze * 60e3).toISOString() });
      return view();
    });
  }

  /**
   * Sends the Mac notification once your hours are up, once for each reminder time (so a restart doesn't repeat it).
   * @returns {Promise<boolean>} Whether it notified.
   */
  function tick() {
    return one(async () => {
      const [shift, prefs] = await Promise.all([load(), settings.get().then(shiftPrefs)]);
      const t = now();
      const at = reminderAt(shift, prefs, t);
      if (at === null || t < at || (shift.remindedAt && Date.parse(shift.remindedAt) >= at)) return false;
      notify("Felix", dueText(prefs, shiftTimes(shift, prefs, t)));
      await save({ ...shift, remindedAt: new Date(at).toISOString() });
      return true;
    });
  }

  /**
   * Checks for the reminder every 30 seconds while Felix runs, without keeping Felix alive for it.
   * @returns {() => void} Stops checking.
   */
  function watch() {
    const timer = setInterval(() => tick().catch(() => {}), TICK_MS);
    timer.unref?.();
    tick().catch(() => {});
    return () => clearInterval(timer);
  }

  return { view, act, answer, snooze, tick, watch };
}

/**
 * Why a step can't happen now, in plain words.
 * @param {string} status
 * @param {string} action
 * @returns {string}
 */
export function cantText(status, action) {
  const running = status === "working" || status === "break";
  if (action === "start") return status === "break" ? "You're on a break. Say \"I'm back\" first." : "Your day has already started.";
  if (!running) return "Your day hasn't started yet. Start your day first.";
  if (action === "break") return "You're already on a break.";
  if (action === "back") return "You're not on a break.";
  return "Felix doesn't know that step.";
}

/**
 * The reminder's words: "Your 9 hours are up. Time to end your day?"
 * @param {ShiftPrefs} prefs
 * @param {ReturnType<typeof shiftTimes>} times
 * @returns {string}
 */
export function dueText(prefs, times) {
  const over = times.leftMs < -60e3 ? ` (${clockText(-times.leftMs)} ago)` : "";
  return `Your ${hoursText(prefs.dayHours)} are up${over}. Time to end your day?`;
}

/**
 * Writes a file in one step, so a crash never leaves half a day.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

let served = null;

/**
 * Lets Felix's local commands ("start my day") reach the work day the server made.
 * @param {ReturnType<typeof createShift> | null} shift
 */
export function serveShift(shift) {
  served = shift;
}

/**
 * What Felix says about the Slack post after a step.
 * @param {Note} note
 * @param {string} channel
 * @returns {string}
 */
function slackLine(note, channel) {
  if (note.slack === "pending") return ` Want me to post "${note.text}" to ${channel}? Say "post it", or use the buttons up top.`;
  if (note.slack === "off") return ` Slack isn't connected yet, so nothing was posted. You can copy "${note.text}" from the top bar.`;
  return "";
}

/**
 * Felix's reply after a step of the day.
 * @param {string} action
 * @param {View} v
 * @returns {string}
 */
function stepText(action, v) {
  const { times, prefs } = v;
  const due = timeOfDay(times.dueAt);
  const said = {
    start: `You're clocked in at ${timeOfDay(Date.parse(v.shift.startedAt))}. I'll nudge you at ${due}, after ${hoursText(prefs.dayHours)}.`,
    break: `Enjoy your break!${prefs.breakPauses ? " The countdown waits till you're back." : ""}`,
    back: `Welcome back! ${times.leftMs > 0 ? `${clockText(times.leftMs)} to go today.` : "Your hours are already up, so maybe wrap up soon."}`,
    end: `Nice work today! That's ${clockText(times.workedMs)} of work. See you next time.`,
  }[action];
  return `${said}${slackLine(v.shift.note, v.channel)}`;
}

/**
 * How the day is going, for "how long have I worked?".
 * @param {View} v
 * @returns {string}
 */
function statusText(v) {
  const { shift, times } = v;
  if (!v.prefs.on) return "Start my day is turned off in Settings.";
  if (shift.status === "off") return "You haven't started your day yet. Say \"start my day\" when you're ready.";
  if (shift.status === "ended") return `Your day ended at ${timeOfDay(Date.parse(shift.endedAt))}, after ${clockText(times.workedMs)} of work.`;
  const left = times.leftMs > 0 ? `${clockText(times.leftMs)} left, until ${timeOfDay(times.dueAt)}` : `your hours were up at ${timeOfDay(times.dueAt)}`;
  const resting = shift.status === "break" ? ` You're on a break, ${clockText(times.onBreakMs)} so far.` : "";
  const ago = times.elapsedMs < 60e3 ? "just now" : `${clockText(times.elapsedMs)} ago`;
  return `You started at ${timeOfDay(Date.parse(shift.startedAt))}, ${ago}; ${left}.${resting}`;
}

/**
 * Answers Felix's work-day commands on this Mac, with no AI: a step, the post's yes or no, or how the day is going.
 * @param {{ action: string }} slots "start", "break", "back", "end", "post", "skip" or "status".
 * @param {ReturnType<typeof createShift> | null} [desk] The work day; the server's when left out.
 * @returns {Promise<{ text: string }>}
 */
export async function shiftReply({ action }, desk = served) {
  if (!desk) return { text: "The work day isn't set up in this Felix." };
  try {
    if (action === "status") return { text: statusText(await desk.view()) };
    if (action === "post" || action === "skip") {
      const note = (await desk.view()).shift.note;
      const v = await desk.answer(note?.id || "", action === "post");
      const done = v.shift.note;
      if (done.slack === "posted") return { text: `Posted "${done.text}" to ${v.channel}.` };
      if (done.slack === "failed") return { text: `I couldn't post it: ${done.error} You can copy the message from the top bar.` };
      return { text: "Okay, I won't post it." };
    }
    return { text: stepText(action, await desk.act(action)) };
  } catch (e) {
    return { text: e.message };
  }
}
