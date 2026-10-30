/**
 * The Calendar card's data: today's events and the next few days on your work calendar, from the Google Calendar
 * API through the work Google sign-in (google.mjs). Repeating events come expanded (singleEvents), so no iCal
 * parsing is needed. Asked at most every 5 minutes, unless Settings says otherwise.
 */

const API = "https://www.googleapis.com/calendar/v3";
const CACHE_MINUTES = 5;
const DAYS = 4; // read at least this many days, whatever the card shows
// The longest stretch one lookup of your events covers.
const RANGE_MAX_DAYS = 92;

/**
 * @typedef {{ id: string, title: string, start: string, end: string, allDay: boolean, join: string | null, link: string,
 *   response: "accepted" | "declined" | "tentative" | "needsAction" | null, location: string }} CalEvent
 */

/**
 * The meeting link of an event: Google Meet's, else the video entry point (Zoom and the like put theirs there).
 * @param {{ hangoutLink?: string, conferenceData?: { entryPoints?: Array<{ entryPointType?: string, uri?: string }> } }} e
 * @returns {string | null}
 */
export function joinLink(e) {
  if (e.hangoutLink) return e.hangoutLink;
  return e.conferenceData?.entryPoints?.find((p) => p.entryPointType === "video")?.uri || null;
}

/**
 * Turns one of Google's events into what the card shows. Cancelled ones are left out, and so are the ones you
 * declined unless `declined` keeps them.
 * @param {Record<string, any>} e
 * @param {{ declined?: boolean }} [options]
 * @returns {CalEvent | null}
 */
export function toEvent(e, { declined = false } = {}) {
  if (e.status === "cancelled") return null;
  const me = (e.attendees || []).find((a) => a.self);
  if (me?.responseStatus === "declined" && !declined) return null;
  const allDay = Boolean(e.start?.date);
  return {
    id: e.id,
    title: e.summary || "(No title)",
    start: allDay ? `${e.start.date}T00:00:00` : e.start?.dateTime,
    end: allDay ? `${e.end?.date}T00:00:00` : e.end?.dateTime,
    allDay,
    join: joinLink(e),
    link: e.htmlLink || "https://calendar.google.com/",
    response: me?.responseStatus || null,
    location: e.location || "",
  };
}

/**
 * Creates the calendar reader.
 * @param {{ google: { get: (account: string, url: string) => Promise<any> }, now?: () => number }} options
 */
export function createCalendar({ google, now = Date.now }) {
  const caches = new Map(); // "days|declined" -> { at, body }

  /**
   * Your events from the start of today through the next few days (at least 4, more when the card shows more).
   * @param {{ fresh?: boolean, days?: number, declined?: boolean, cacheMinutes?: number }} [options]
   * @returns {Promise<{ fetchedAt: string, events: CalEvent[] }>}
   */
  async function events({ fresh = false, days = DAYS, declined = false, cacheMinutes = CACHE_MINUTES } = {}) {
    const span = Math.max(DAYS, days);
    const key = `${span}|${declined}`;
    const cache = caches.get(key);
    if (!fresh && cache && now() - cache.at < cacheMinutes * 60e3) return cache.body;
    const from = new Date(now());
    from.setHours(0, 0, 0, 0);
    const to = new Date(from.getTime() + span * 86400e3);
    const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "100" });
    const answer = await google.get("work", `${API}/calendars/primary/events?${q}`);
    const body = { fetchedAt: new Date(now()).toISOString(), events: (answer.items || []).map((e) => toEvent(e, { declined })).filter(Boolean) };
    caches.set(key, { at: now(), body });
    return body;
  }

  /**
   * Your events between two days, both included, for Felix's AI to look up any stretch ("next week", "in March").
   * Not cached: each question asks fresh. At most 92 days.
   * @param {{ from: string, to: string, declined?: boolean }} range Days as YYYY-MM-DD, in your time zone.
   * @returns {Promise<{ fetchedAt: string, from: string, to: string, events: CalEvent[] }>}
   */
  async function between({ from, to, declined = false }) {
    const start = new Date(`${from}T00:00:00`);
    const end = new Date(`${to}T00:00:00`);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime()) || end < start) throw Object.assign(new Error("Give from and to as days like 2026-11-02."), { status: 400 });
    if ((end - start) / 86400e3 > RANGE_MAX_DAYS) throw Object.assign(new Error(`At most ${RANGE_MAX_DAYS} days at once.`), { status: 400 });
    end.setDate(end.getDate() + 1);
    const q = new URLSearchParams({ timeMin: start.toISOString(), timeMax: end.toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "250" });
    const answer = await google.get("work", `${API}/calendars/primary/events?${q}`);
    return { fetchedAt: new Date(now()).toISOString(), from, to, events: (answer.items || []).map((e) => toEvent(e, { declined })).filter(Boolean) };
  }

  /** Forgets the cached events, as after signing in. */
  const reset = () => { caches.clear(); };

  return { events, between, reset };
}
