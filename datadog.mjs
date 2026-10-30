// Incident Commander card: who is on call on the two Kastl Incident Commander schedules in Datadog On-Call.
// Auth is one Personal Access Token (scope on_call_read) from the Keychain, sent as DD-APPLICATION-KEY.
// No API key is needed. See SETUP.md section 10.
import { codedError, readKeychain } from "./keychain.mjs";

const SITE = process.env.DD_SITE || "us5.datadoghq.com";
const KEYCHAIN_SERVICE = "cmd-center-datadog-app";
// My Datadog user. The token can't read /current_user, so "me" is set here.
const ME = process.env.DD_USER_ID || "17da12a7-bf09-11f0-9375-4e0d9e19fc45";
// The two teams take turns: the Philippines covers the day (8 AM to 10 PM Manila), the Americas the night.
// `mine` marks where to look for my next shift.
const SCHEDULES = [
  { key: "ph", name: "Philippines", full: "Kastl Incident Commanders (Philippines)", id: "1a2e4a4e-f27a-424c-999e-1cb8d6062c85", mine: true },
  { key: "americas", name: "Americas", full: "PURE Incident Commanders Schedule", id: "a39cd3b9-f39f-4c6c-8c2f-017fca628d36" },
];
const CACHE_MINUTES = 60;
const MY_SHIFT_DAYS = 45; // how far ahead to look for my next shift, unless Settings says otherwise
const MAX_CALLS = 60;     // per schedule, per refresh

const caches = new Map(); // "days|lookahead" -> { at, day, body }

/**
 * Reads the Datadog access token from the Keychain.
 * @param {typeof readKeychain} [readSecret]
 * @returns {Promise<string>}
 * @throws {Error & { code: "no-token" }} when the token isn't saved yet.
 */
async function readToken(readSecret = readKeychain) {
  const token = await readSecret(KEYCHAIN_SERVICE, "datadog");
  if (!token) throw codedError("no-token", "No Datadog token in the Keychain. Add one as SETUP.md section 10 says.");
  return token;
}

/**
 * One lookup: the shift on at `at` (if any) and the next shift. With someone on, "next" skips to the next
 * *different* person, so callers only trust it when nobody is on.
 * @param {string} token
 * @param {string} scheduleId
 * @param {number} at
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<{ current: object | null, next: object | null }>}
 */
async function responders(token, scheduleId, at, fetchImpl = fetch) {
  const q = new URLSearchParams({
    include: "responders.shifts.user",
    "filter[position]": "current,next",
    "filter[at_ts]": new Date(at).toISOString(),
  });
  const res = await fetchImpl(`https://api.${SITE}/api/v2/on-call/schedules/${scheduleId}/responders?${q}`, {
    headers: { "DD-APPLICATION-KEY": token, Accept: "application/json" },
  });
  if (res.status === 401 || res.status === 403) {
    throw codedError("auth", "Datadog refused the token. It may have expired, or it lacks on_call_read. Make a new one (SETUP.md section 10).");
  }
  if (!res.ok) throw codedError("http", `Datadog answered ${res.status}.`);
  const body = await res.json();
  const inc = body.included || [];
  const users = new Map(inc.filter((x) => x.type === "users").map((u) => [u.id, u.attributes]));
  const shifts = new Map(inc.filter((x) => x.type === "shifts").map((s) => [s.id, s]));
  const pick = (position) => {
    const r = inc.find((x) => x.type === "schedule_oncall_responder" && x.attributes?.position === position);
    const s = r && shifts.get(r.relationships?.shifts?.data?.[0]?.id);
    if (!s) return null;
    const userId = s.relationships?.user?.data?.id;
    const u = users.get(userId) || {};
    return { start: s.attributes.start, end: s.attributes.end, user: { id: userId, name: u.name || u.handle || "Someone" }, mine: userId === ME };
  };
  return { current: pick("current"), next: pick("next") };
}

/**
 * Steps forward shift by shift from `from` until the window is covered (and, for my schedule, my next shift is
 * found or `lookahead` days have passed). Each lookup yields exactly one shift: the one on now, or else the next one.
 * @param {{ token: string, schedule: typeof SCHEDULES[number], from: number, until: number, lookahead: number, fetchImpl: typeof fetch, now: () => number }} options
 * @returns {Promise<object[]>}
 */
async function walk({ token, schedule, from, until, lookahead, fetchImpl, now }) {
  const out = [];
  let at = from;
  const limit = from + lookahead * 86400e3;
  // A longer look for my shift may take more lookups.
  const maxCalls = Math.max(MAX_CALLS, lookahead + 15);
  for (let calls = 0; calls < maxCalls; calls++) {
    const { current, next } = await responders(token, schedule.id, at, fetchImpl);
    const shift = current || next;
    if (!shift) break;
    out.push(shift);
    const start = Date.parse(shift.start);
    const needMine = schedule.mine && !out.some((s) => s.mine && Date.parse(s.end) > now());
    if (start > until && !needMine) break;
    if (start > limit) break;
    at = Date.parse(shift.end) + 1000;
  }
  return out;
}

/**
 * Midnight of a time's day, on this Mac's clock.
 * @param {number} t
 * @returns {number}
 */
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/**
 * Reads both schedules for `days` days from today, and my next shift within `lookahead` days.
 * @param {{ days: number, lookahead: number, fetchImpl: typeof fetch, readSecret: typeof readKeychain, now: () => number }} options
 */
async function load({ days, lookahead, fetchImpl, readSecret, now }) {
  const token = await readToken(readSecret);
  const today = startOfDay(now());
  // Midnight after the last day (2 hours past the day count keeps it DST-safe): 2 days is midnight after tomorrow.
  const windowEnd = startOfDay(today + (days * 24 + 2) * 3600e3);
  const schedules = await Promise.all(SCHEDULES.map(async (s) => ({
    key: s.key,
    name: s.name,
    full: s.full,
    url: `https://${SITE}/on-call/schedules/${s.id}`,
    shifts: await walk({ token, schedule: s, from: today, until: windowEnd, lookahead, fetchImpl, now }),
  })));
  const mine = schedules.flatMap((s) => s.shifts.filter((x) => x.mine && Date.parse(x.end) > now()).map((x) => ({ ...x, schedule: s.name })));
  mine.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)); // offsets differ per schedule
  return {
    fetchedAt: new Date(now()).toISOString(),
    schedules,
    myNext: mine[0] || null,
    myLookahead: lookahead,
    days,
  };
}

/**
 * Who is on call, cached for `cacheMinutes` (an hour unless Settings says otherwise) and per calendar day, so "today"
 * is right just after midnight. Each window (days and lookahead) keeps its own copy.
 * @param {{ fresh?: boolean, days?: number, lookahead?: number, cacheMinutes?: number, fetchImpl?: typeof fetch,
 *   readSecret?: typeof readKeychain, now?: () => number }} [options] `days` of shifts to read from today, and how many
 *   days ahead to look for my next shift.
 * @returns {Promise<{ fetchedAt: string, schedules: object[], myNext: object | null, myLookahead: number, days: number }>}
 */
export async function incidentCommander({
  fresh = false, days = 2, lookahead = MY_SHIFT_DAYS, cacheMinutes = CACHE_MINUTES, fetchImpl = fetch, readSecret = readKeychain, now = Date.now,
} = {}) {
  const day = startOfDay(now());
  const key = `${days}|${lookahead}`;
  const hit = caches.get(key);
  if (!fresh && hit && hit.day === day && now() - hit.at < cacheMinutes * 60e3) return hit.body;
  const body = await load({ days, lookahead, fetchImpl, readSecret, now });
  caches.set(key, { at: now(), day, body });
  return body;
}

export const DATADOG_SERVICE = KEYCHAIN_SERVICE;

/**
 * Tries a Datadog token before it's saved: one on-call lookup on the Philippines schedule.
 * @param {{ token: string }} options
 * @returns {Promise<{}>}
 * @throws {Error & { code: string }} When Datadog refuses it or can't be reached.
 */
export async function checkDatadog({ token }) {
  await responders(token, SCHEDULES[0].id, Date.now());
  return {};
}

/** Forgets the cached schedule, as after saving a new token. */
export function resetDatadogCache() {
  caches.clear();
}
