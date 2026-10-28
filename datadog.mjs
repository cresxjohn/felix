// Incident Commander card: who is on call on the two Kastl Incident Commander schedules in Datadog On-Call.
// Auth is one Personal Access Token (scope on_call_read) from the Keychain, sent as DD-APPLICATION-KEY.
// No API key is needed. See SETUP.md section 10.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

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
const CACHE_MS = 60 * 60e3;
const MY_SHIFT_DAYS = 45; // how far ahead to look for my next shift
const MAX_CALLS = 60;     // per schedule, per refresh

let cache = null; // { at, day, body }

function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function readToken() {
  try {
    const { stdout } = await run("security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", "datadog", "-w"]);
    return stdout.trim();
  } catch {
    throw codedError("no-token", "No Datadog token in the Keychain. Add one as SETUP.md section 10 says.");
  }
}

// One lookup returns the shift on at `at` (if any) and the next shift. With someone on, "next" skips
// to the next *different* person, so callers only trust it when nobody is on.
async function responders(token, scheduleId, at) {
  const q = new URLSearchParams({
    include: "responders.shifts.user",
    "filter[position]": "current,next",
    "filter[at_ts]": new Date(at).toISOString(),
  });
  const res = await fetch(`https://api.${SITE}/api/v2/on-call/schedules/${scheduleId}/responders?${q}`, {
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

// Steps forward shift by shift from `from` until the window is covered (and, for my schedule, my next
// shift is found). Each lookup yields exactly one shift: the one on now, or else the next one.
async function walk(token, schedule, from, until) {
  const out = [];
  let at = from;
  const limit = from + MY_SHIFT_DAYS * 86400e3;
  for (let calls = 0; calls < MAX_CALLS; calls++) {
    const { current, next } = await responders(token, schedule.id, at);
    const shift = current || next;
    if (!shift) break;
    out.push(shift);
    const start = Date.parse(shift.start);
    const needMine = schedule.mine && !out.some((s) => s.mine && Date.parse(s.end) > Date.now());
    if (start > until && !needMine) break;
    if (start > limit) break;
    at = Date.parse(shift.end) + 1000;
  }
  return out;
}

function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

async function load() {
  const token = await readToken();
  const today = startOfDay(Date.now());
  const windowEnd = startOfDay(today + 50 * 3600e3); // midnight after tomorrow (DST-safe)
  const schedules = await Promise.all(SCHEDULES.map(async (s) => ({
    key: s.key,
    name: s.name,
    full: s.full,
    url: `https://${SITE}/on-call/schedules/${s.id}`,
    shifts: await walk(token, s, today, windowEnd),
  })));
  const mine = schedules.flatMap((s) => s.shifts.filter((x) => x.mine && Date.parse(x.end) > Date.now()).map((x) => ({ ...x, schedule: s.name })));
  mine.sort((a, b) => Date.parse(a.start) - Date.parse(b.start)); // offsets differ per schedule
  return {
    fetchedAt: new Date().toISOString(),
    schedules,
    myNext: mine[0] || null,
    myLookahead: MY_SHIFT_DAYS,
  };
}

// Cached for an hour and per calendar day, so "today" is right just after midnight.
export async function incidentCommander({ fresh = false } = {}) {
  const day = startOfDay(Date.now());
  if (!fresh && cache && cache.day === day && Date.now() - cache.at < CACHE_MS) return cache.body;
  const body = await load();
  cache = { at: Date.now(), day, body };
  return body;
}
