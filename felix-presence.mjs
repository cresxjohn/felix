/**
 * Felix's sense of when to speak up and when to stay quiet. He can speak up on his own (off by default) when a
 * review or a fix he ran for you is ready, and, if you turn it on, give a gentle nudge after a long stretch without
 * a break. He stays quiet while your screen is locked, while you're away from the Mac, and during a meeting on your
 * calendar; then what he'd have said just shows in the chat. Whether you're there comes from macOS itself (how long
 * since you last touched the keyboard or mouse, and whether the screen is locked), read with `ioreg`.
 */
import { execFile as nodeExecFile } from "node:child_process";

const PRESENCE_MS = 10_000;
const MINUTE = 60_000;
const CARE_MAX = 3;
const CARE_SAID = [
  "You've been at it for {span} without a break. Maybe stand up and stretch for a minute?",
  "{span} straight now. A glass of water and a short walk might feel good.",
  "Quick nudge: it's been {span} since your last break. Your eyes could use a rest.",
];

/**
 * @typedef {{ id: string, text: string, kind: "review" | "fix" | "care" | "watch", at: string }} News Something Felix
 *   has to tell you that you didn't ask for just now.
 * @typedef {{ idleSeconds: number | null, locked: boolean }} Presence
 */

/**
 * A PR's short name from its link: "fm#123".
 * @param {string} url
 * @returns {string}
 */
export function refOf(url) {
  const m = /(frontend|backend)-monorepo\/pull\/(\d+)/.exec(String(url));
  return m ? `${m[1] === "frontend" ? "fm" : "bm"}#${m[2]}` : String(url);
}

/**
 * The reviews and fixes that finished since last time: each session that turned "ready".
 * @param {Record<string, { status?: string, tool?: string }>} before Sessions by key, as last seen.
 * @param {Record<string, { status?: string, tool?: string }>} after Sessions by key, now.
 * @param {number} now
 * @returns {News[]}
 */
export function readyNews(before, after, now) {
  const at = new Date(now).toISOString();
  return Object.entries(after).flatMap(([key, r]) => {
    if (r?.status !== "ready" || before[key]?.status === "ready" || !before[key]) return [];
    const fix = key.startsWith("fix:");
    const ref = refOf(fix ? key.slice(4) : key);
    const who = r.tool === "cursor" ? "Cursor" : "Claude";
    return [{ id: `${key}|${at}`, kind: fix ? "fix" : "review", at, text: fix ? `${who}'s fix of ${ref} is ready to look at.` : `${who}'s review of ${ref} is ready.` }];
  });
}

/**
 * Whether you're at the Mac, from macOS: seconds since you last used the keyboard or mouse, and whether the screen
 * is locked. Read at most every 10 seconds.
 * @param {{ run?: (cmd: string, args: string[]) => Promise<string>, now?: () => number }} [deps]
 * @returns {() => Promise<Presence>}
 */
export function macPresence({ run = ioreg, now = Date.now } = {}) {
  let last = null;
  return async () => {
    if (last && now() - last.at < PRESENCE_MS) return last.value;
    const [hid, root] = await Promise.all([run("ioreg", ["-c", "IOHIDSystem"]).catch(() => ""), run("ioreg", ["-n", "Root", "-d1"]).catch(() => "")]);
    const idle = /"HIDIdleTime" = (\d+)/.exec(hid);
    const value = { idleSeconds: idle ? Math.round(Number(idle[1]) / 1e9) : null, locked: /"CGSSessionScreenIsLocked" = Yes/.test(root) };
    last = { at: now(), value };
    return value;
  };
}

/**
 * Runs `ioreg` and gives back what it printed.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {Promise<string>}
 */
function ioreg(cmd, args) {
  return new Promise((resolve, reject) => {
    nodeExecFile(cmd, args, { timeout: 5000, maxBuffer: 8 << 20 }, (err, out) => (err ? reject(err) : resolve(String(out))));
  });
}

/**
 * Why Felix should stay quiet right now, or null when he may speak: the screen is locked, you've been away longer
 * than Settings allow, or a meeting you haven't declined is on.
 * @param {{ prefs: Record<string, unknown>, presence: Presence, calendar?: { record?: { events?: Array<Record<string, any>> }, error?: string } | null }} state
 * @returns {"locked" | "away" | "meeting" | null}
 */
export function quietReason({ prefs, presence, calendar }) {
  if (presence.locked) return "locked";
  const away = Number(prefs.felixAwayMinutes ?? 5) * 60;
  if (away && presence.idleSeconds !== null && presence.idleSeconds >= away) return "away";
  if (prefs.felixQuietMeetings !== false && !calendar?.error) {
    const on = (calendar?.record?.events || []).some((e) => e.onNow && !e.allDay && e.yourAnswer !== "no");
    if (on) return "meeting";
  }
  return null;
}

/**
 * How long a stretch is, the way people say it: "2 hours", "1 hour and 30 minutes", "45 minutes".
 * @param {number} ms
 * @returns {string}
 */
export function spanText(ms) {
  const minutes = Math.round(ms / MINUTE);
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = h ? `${h} hour${h === 1 ? "" : "s"}` : "";
  const mins = m ? `${m} minute${m === 1 ? "" : "s"}` : "";
  return [hours, mins].filter(Boolean).join(" and ") || "a while";
}

/**
 * A gentle nudge to take a break, when it's due: Settings have nudges on, your work day is running and you're not
 * on a break, it's been the set time since you started or last came back, it's been as long since the last nudge,
 * and there have been fewer than three today.
 * @param {{ prefs: Record<string, unknown>, shift: { status?: string, startedAt?: string | null, breaks?: Array<{ start: string, end: string | null }> },
 *   now: number, nudges: number[], pick?: number }} state `nudges` are when today's nudges were given.
 * @returns {string | null}
 */
export function careNudge({ prefs, shift, now, nudges, pick = 0 }) {
  if (prefs.felixCare !== true || shift.status !== "working" || !shift.startedAt) return null;
  const after = Number(prefs.felixCareAfter || 120) * MINUTE;
  const backAt = Math.max(Date.parse(shift.startedAt), ...(shift.breaks || []).map((b) => Date.parse(b.end || "") || 0));
  const today = new Date(now).toDateString();
  const todays = nudges.filter((t) => new Date(t).toDateString() === today);
  const lastNudge = Math.max(0, ...todays);
  if (now - backAt < after || now - lastNudge < after || todays.length >= CARE_MAX) return null;
  return CARE_SAID[pick % CARE_SAID.length].replace("{span}", spanText(now - backAt));
}

/**
 * Felix's news: what came up on its own (a review or fix ready, a nudge), kept until the page asks for it.
 * Reviews and fixes only count with "speak up on my own" on, and nudges with care nudges on.
 * @param {{ now?: () => number }} [deps]
 */
export function createNews({ now = Date.now } = {}) {
  /** @type {News[]} */
  let waiting = [];
  /** @type {Record<string, { status?: string, tool?: string }> | null} */
  let seen = null;
  /** @type {number[]} */
  const nudged = [];

  return {
    /**
     * Notes the review and fix sessions as they are now; any that turned ready since last time become news.
     * @param {Record<string, { status?: string, tool?: string }>} sessions
     * @param {Record<string, unknown>} prefs
     * @returns {News[]} What became news.
     */
    sessions(sessions, prefs) {
      const fresh = seen ? readyNews(seen, sessions, now()) : [];
      seen = Object.fromEntries(Object.entries(sessions).map(([k, r]) => [k, { status: r?.status, tool: r?.tool }]));
      const kept = fresh.filter((n) => prefs.felixSpeakUp === true && (n.kind === "review" ? prefs.felixSpeakReviews !== false : prefs.felixSpeakFixes !== false));
      waiting = [...waiting, ...kept];
      return kept;
    },
    /**
     * Gives a care nudge when one is due.
     * @param {Parameters<typeof careNudge>[0]["shift"]} shift
     * @param {Record<string, unknown>} prefs
     * @returns {News | null}
     */
    care(shift, prefs) {
      const text = careNudge({ prefs, shift, now: now(), nudges: nudged, pick: nudged.length });
      if (!text) return null;
      nudged.push(now());
      const news = { id: `care|${now()}`, kind: /** @type {const} */ ("care"), text, at: new Date(now()).toISOString() };
      waiting.push(news);
      return news;
    },
    /** Adds news from elsewhere, like a watcher that came true. @param {News[]} items */
    add(items) {
      waiting = [...waiting, ...items];
    },
    /** What's waiting, once. @returns {News[]} */
    take() {
      const out = waiting;
      waiting = [];
      return out;
    },
  };
}
