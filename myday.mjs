/**
 * My day: today's weather from Open-Meteo (free, no key, only the place's coordinates are sent), the next
 * Philippine holiday, and today's events on your personal Google calendar once that account is signed in.
 *
 * Holidays come from Google's public "Holidays in the Philippines" calendar, read through the same calendar source
 * as the work calendar (the bridge or your work Google app). A bridge from before this card can't read that calendar,
 * so then they come from your personal account if it's signed in, or else from the vacation tracker's "PH Holiday"
 * days, which have no names.
 */
import { toEvent } from "./calendar.mjs";
import { addDays, ymd } from "./tasks.mjs";
import { PLACES } from "./public/places.mjs";

export { PLACES };

export const PH_HOLIDAYS = "en.philippines#holiday@group.v.calendar.google.com";
const CAL_API = "https://www.googleapis.com/calendar/v3";
const WEATHER_API = "https://api.open-meteo.com/v1/forecast";
const WEATHER_TRIES = 3;
const WEATHER_TRY_MS = 6000;
const WEATHER_MINUTES = 15;
const HOLIDAY_MINUTES = 12 * 60;
const EVENTS_MINUTES = 5;
const ZONE = "Asia/Manila";


/**
 * The sky in a word or two, from the WMO weather code Open-Meteo gives.
 * @param {number} code
 * @returns {string}
 */
export function skyOf(code) {
  const c = Number(code);
  if (c === 0) return "Clear";
  if (c === 1) return "Mostly clear";
  if (c === 2) return "Partly cloudy";
  if (c === 3) return "Cloudy";
  if (c === 45 || c === 48) return "Foggy";
  if (c >= 51 && c <= 57) return "Drizzle";
  if (c >= 61 && c <= 67) return "Rain";
  if (c >= 71 && c <= 77) return "Snow";
  if (c >= 80 && c <= 82) return "Showers";
  if (c === 85 || c === 86) return "Snow";
  if (c >= 95) return "Thunderstorms";
  return "Unknown";
}

/**
 * Open-Meteo's address for a place: now, the next hours, and today's high and low, in Manila's time.
 * @param {{ lat: number, lon: number }} place
 * @returns {string}
 */
export function weatherUrl(place) {
  const q = new URLSearchParams({
    latitude: String(place.lat), longitude: String(place.lon), timezone: ZONE, forecast_days: "2",
    current: "temperature_2m,apparent_temperature,weather_code,is_day",
    hourly: "temperature_2m,weather_code,precipitation_probability",
    daily: "temperature_2m_max,temperature_2m_min,weather_code,precipitation_probability_max",
  });
  return `${WEATHER_API}?${q}`;
}

/**
 * Reads Open-Meteo's answer into what the card shows: now, today, and the hours after now (to the end of tomorrow).
 * Times stay as Open-Meteo gives them, in Manila's time ("2026-10-30T19:00").
 * @param {any} json
 * @returns {{ now: { time: string, temp: number, feels: number | null, sky: string, code: number, day: boolean },
 *   today: { high: number, low: number, sky: string, rain: number | null }, hours: Array<{ time: string, temp: number, sky: string, code: number, rain: number | null }> }}
 * @throws {Error} When the answer is missing what the card needs.
 */
export function parseWeather(json) {
  const c = json?.current;
  const h = json?.hourly;
  const d = json?.daily;
  if (!c || typeof c.temperature_2m !== "number" || !h?.time || !d?.time?.length) throw new Error("The weather service sent something Felix can't read.");
  const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  const day = String(c.time).slice(0, 10);
  const at = Math.max(0, d.time.indexOf(day));
  // The hours after the current one: "19:45" now means 20:00 is the next.
  const hours = h.time.map((time, i) => ({ time, temp: num(h.temperature_2m[i]), code: h.weather_code[i], rain: num(h.precipitation_probability?.[i]) }))
    .filter((x) => x.time > c.time && x.temp !== null)
    .map((x) => ({ ...x, sky: skyOf(x.code) }));
  return {
    now: { time: c.time, temp: c.temperature_2m, feels: num(c.apparent_temperature), sky: skyOf(c.weather_code), code: c.weather_code, day: c.is_day !== 0 },
    today: { high: d.temperature_2m_max[at], low: d.temperature_2m_min[at], sky: skyOf(d.weather_code[at]), rain: num(d.precipitation_probability_max?.[at]) },
    hours,
  };
}

/**
 * Reads Google's public holiday calendar events into holidays: one per day, the day's name. Observances that aren't
 * days off (like Valentine's Day) are kept, marked by Google's own description.
 * @param {any[]} items
 * @returns {Array<{ day: string, name: string, kind: string }>}
 */
export function toHolidays(items) {
  const out = [];
  for (const e of items || []) {
    if (e.status === "cancelled" || !e.start?.date) continue;
    const last = e.end?.date ? addDays(e.end.date, -1) : e.start.date;
    for (let d = e.start.date; d <= last; d = addDays(d, 1)) out.push({ day: d, name: String(e.summary || "Holiday"), kind: String(e.description || "") });
  }
  return out.sort((a, b) => a.day.localeCompare(b.day) || a.name.localeCompare(b.name));
}

/**
 * Whether a public-calendar holiday is a day off, by Google's description ("Public holiday", "Special non-working
 * holiday"), rather than an observance.
 * @param {{ kind: string }} h
 * @returns {boolean}
 */
export const isDayOff = (h) => !h.kind || /holiday|non-working/i.test(h.kind);

/**
 * Creates the My day reader.
 * @param {{ fetchImpl?: typeof fetch, calendarSource: { get: (account: string, url: string) => Promise<any> },
 *   google: { status: (id: string) => Promise<any>, get: (id: string, url: string) => Promise<any> },
 *   ooo: { out: Function }, now?: () => number }} options
 */
export function createMyDay({ fetchImpl = fetch, calendarSource, google, ooo, now = Date.now }) {
  const cache = new Map();

  /**
   * A value kept for some minutes, or made afresh.
   * @template T
   * @param {string} key
   * @param {number | ((value: T) => number)} minutes How long to keep it, or how long for the value made.
   * @param {boolean} fresh
   * @param {() => Promise<T>} make
   * @returns {Promise<T>}
   */
  async function kept(key, minutes, fresh, make) {
    const hit = cache.get(key);
    if (!fresh && hit && now() < hit.until) return hit.value;
    const value = await make();
    cache.set(key, { until: now() + (typeof minutes === "function" ? minutes(value) : minutes) * 60e3, value });
    return value;
  }

  /**
   * The weather for a place.
   * @param {string} placeId
   * @param {boolean} [fresh]
   */
  function weather(placeId, fresh = false) {
    const place = PLACES.find((p) => p.id === placeId) || PLACES[0];
    const key = `weather|${place.id}`;
    return kept(key, WEATHER_MINUTES, fresh, async () => {
      let res = null;
      // One of the service's addresses can be out of reach from here, and a try that lands on it waits out its
      // timeout, so each try is short and there are a few.
      for (let i = 0; i < WEATHER_TRIES && !res; i++) {
        try { res = await fetchImpl(weatherUrl(place), { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(WEATHER_TRY_MS) }); } catch { res = null; }
      }
      if (!res) throw new Error("Couldn't reach the weather service.");
      if (!res.ok) throw new Error(`The weather service answered ${res.status}.`);
      return { place: place.name, fetchedAt: new Date(now()).toISOString(), ...parseWeather(await res.json()) };
    }).catch((e) => {
      // The last weather it had beats none: the card shows when it's from.
      const last = cache.get(key);
      if (last) return { ...last.value, stale: true };
      throw e;
    });
  }

  /**
   * Philippine holidays between two days, with where they came from: "google" (names), or "tracker" (days only) when
   * no Google calendar can read the holiday calendar.
   * @param {string} from
   * @param {string} to
   * @param {boolean} [fresh]
   * @returns {Promise<{ source: "google" | "tracker", holidays: Array<{ day: string, name: string, kind: string }>, note: string }>}
   */
  function holidays(from, to, fresh = false) {
    // Names from Google keep for half a day; the tracker's stand-in only half an hour, so an updated bridge shows soon.
    return kept(`holidays|${from}|${to}`, (v) => (v.source === "google" ? HOLIDAY_MINUTES : 30), fresh, async () => {
      const q = new URLSearchParams({ timeMin: `${from}T00:00:00+08:00`, timeMax: `${addDays(to, 1)}T00:00:00+08:00`, singleEvents: "true", orderBy: "startTime", maxResults: "250" });
      const url = `${CAL_API}/calendars/${encodeURIComponent(PH_HOLIDAYS)}/events?${q}`;
      let note = "";
      try {
        return { source: "google", holidays: toHolidays((await calendarSource.get("work", url)).items), note };
      } catch (e) {
        // A bridge from before this card only reads your calendar and the tracker.
        if (e.code === "forbidden") note = "For holiday names, copy the calendar bridge script again from the Calendar setup and deploy a new version.";
      }
      if ((await google.status("personal").catch(() => null))?.connected) {
        try { return { source: "google", holidays: toHolidays((await google.get("personal", url)).items), note: "" }; } catch {}
      }
      const rows = (await ooo.out({ from, to })).out.filter((r) => r.holiday && /^(ph|philippines?)\b/i.test(r.name));
      const days = new Set();
      for (const r of rows) for (let d = r.from; d <= r.to; d = addDays(d, 1)) days.add(d);
      return { source: "tracker", holidays: [...days].sort().map((day) => ({ day, name: "", kind: "" })), note };
    });
  }

  /**
   * Holiday names by day, for My time off. Empty when only the tracker's days are known.
   * @param {string} from
   * @param {string} to
   * @returns {Promise<Map<string, string>>}
   */
  async function holidayNames(from, to) {
    const h = await holidays(from, to);
    return new Map(h.holidays.filter(isDayOff).map((x) => [x.day, x.name]));
  }

  /**
   * Today's events on your personal calendar, or where the sign-in stands.
   * @param {boolean} [fresh]
   * @returns {Promise<{ client: boolean, connected: boolean, events?: any[], error?: string }>}
   */
  async function personalDay(fresh = false) {
    const s = await google.status("personal");
    if (!s.connected) return { client: s.client, connected: false };
    return kept("events", EVENTS_MINUTES, fresh, async () => {
      const from = new Date(now());
      from.setHours(0, 0, 0, 0);
      const q = new URLSearchParams({ timeMin: from.toISOString(), timeMax: new Date(from.getTime() + 86400e3).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: "50" });
      const answer = await google.get("personal", `${CAL_API}/calendars/primary/events?${q}`);
      return { client: true, connected: true, events: (answer.items || []).map((e) => toEvent(e)).filter(Boolean) };
    });
  }

  /**
   * Everything the card shows; each part fails on its own, with a plain reason.
   * @param {{ place: string, fresh?: boolean }} options
   */
  async function view({ place, fresh = false }) {
    const today = ymd(now());
    const [w, h, cal] = await Promise.allSettled([weather(place, fresh), holidays(today, addDays(today, 90), fresh), personalDay(fresh)]);
    const list = h.status === "fulfilled" ? h.value.holidays.filter((x) => x.day >= today) : [];
    return {
      fetchedAt: new Date(now()).toISOString(), today,
      weather: w.status === "fulfilled" ? w.value : null, weatherError: w.status === "rejected" ? w.reason.message : "",
      holidays: { today: list.filter((x) => x.day === today), next: list.find((x) => x.day > today && isDayOff(x)) || null,
        source: h.status === "fulfilled" ? h.value.source : null, note: h.status === "fulfilled" ? h.value.note : "",
        error: h.status === "rejected" ? "Couldn't read the holidays right now." : "" },
      calendar: cal.status === "fulfilled" ? cal.value : { client: true, connected: true, error: cal.reason.message },
    };
  }

  /** Forgets everything kept, as after a sign-in. */
  const reset = () => cache.clear();

  return { view, weather, holidays, holidayNames, personalDay, reset };
}
