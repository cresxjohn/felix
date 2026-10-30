import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { DATADOG_SERVICE, checkDatadog, incidentCommander, resetDatadogCache } from "../datadog.mjs";

// checkDatadog uses the global fetch, so these tests swap it for a fake and put it back.
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

const reply = (status, body = {}) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test("checkDatadog tries the token with one on-call lookup", async () => {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return reply(200, {
      included: [
        { type: "users", id: "u1", attributes: { name: "Ana" } },
        { type: "shifts", id: "s1", attributes: { start: "2026-10-30T00:00:00Z", end: "2026-10-30T14:00:00Z" }, relationships: { user: { data: { id: "u1" } } } },
        { type: "schedule_oncall_responder", attributes: { position: "current" }, relationships: { shifts: { data: [{ id: "s1" }] } } },
      ],
    });
  };
  assert.deepEqual(await checkDatadog({ token: "dd-token" }), {});
  assert.equal(seen.length, 1);
  const u = new URL(seen[0].url);
  assert.match(u.pathname, /^\/api\/v2\/on-call\/schedules\/[\w-]+\/responders$/);
  assert.equal(u.searchParams.get("filter[position]"), "current,next");
  assert.equal(u.searchParams.get("include"), "responders.shifts.user");
  assert.deepEqual(seen[0].init.headers, { "DD-APPLICATION-KEY": "dd-token", Accept: "application/json" });
});

test("checkDatadog turns refusals into coded errors", async () => {
  for (const [status, code] of [[401, "auth"], [403, "auth"], [500, "http"]]) {
    globalThis.fetch = async () => reply(status);
    await assert.rejects(checkDatadog({ token: "dd-token" }), { code }, String(status));
  }
});

test("checkDatadog is fine with an empty answer, and the cache reset is safe to call", async () => {
  globalThis.fetch = async () => reply(200, {});
  assert.deepEqual(await checkDatadog({ token: "dd-token" }), {});
  resetDatadogCache();
  assert.equal(DATADOG_SERVICE, "cmd-center-datadog-app");
});

// A fake Datadog for one schedule each: shifts back to back, each `hours` long from `first`, every `mineEvery`th one
// mine. It answers "who is on at" with that shift as current.
const ME = "17da12a7-bf09-11f0-9375-4e0d9e19fc45";
/**
 * @param {{ first: number, hours: number, mineEvery?: number, stopAfter?: number }} plan
 */
function fakeOnCall({ first, hours, mineEvery = 0, stopAfter = Infinity }) {
  const asked = [];
  const fetchImpl = async (url) => {
    const at = Date.parse(new URL(url).searchParams.get("filter[at_ts]"));
    asked.push(at);
    const n = Math.max(0, Math.floor((at - first) / (hours * 3600e3)));
    if (n >= stopAfter) return reply(200, {});
    const start = first + n * hours * 3600e3;
    const user = mineEvery && n % mineEvery === mineEvery - 1 ? ME : `u${n}`;
    return reply(200, {
      included: [
        { type: "users", id: user, attributes: user === ME ? { handle: "cres" } : {} },
        { type: "shifts", id: `s${n}`, attributes: { start: new Date(start).toISOString(), end: new Date(start + hours * 3600e3).toISOString() }, relationships: { user: { data: { id: user } } } },
        { type: "schedule_oncall_responder", attributes: { position: at >= start ? "current" : "next" }, relationships: { shifts: { data: [{ id: `s${n}` }] } } },
      ],
    });
  };
  return { fetchImpl, asked };
}

const DAY0 = new Date(2026, 9, 30, 0, 0, 0).getTime();
const token = async (service, account) => (service === DATADOG_SERVICE && account === "datadog" ? "dd-token" : null);

test("incidentCommander reads both schedules for today and tomorrow, and finds my next shift", async () => {
  resetDatadogCache();
  const { fetchImpl } = fakeOnCall({ first: DAY0, hours: 12, mineEvery: 5 });
  const now = () => DAY0 + 9 * 3600e3;
  const body = await incidentCommander({ fetchImpl, readSecret: token, now });
  assert.equal(body.fetchedAt, new Date(now()).toISOString());
  assert.deepEqual(body.schedules.map((s) => s.key), ["ph", "americas"]);
  assert.match(body.schedules[0].url, /\/on-call\/schedules\/[\w-]+$/);
  // Shifts start at 0:00 and 12:00: four cover today and tomorrow, then the walk reads on until a shift starts past
  // midnight after tomorrow.
  assert.equal(body.schedules[1].shifts.length, 6);
  assert.equal(body.schedules[1].shifts[0].user.name, "Someone");
  assert.equal(body.myNext.schedule, "Philippines");
  assert.equal(body.myNext.user.name, "cres");
  assert.deepEqual([body.myLookahead, body.days], [45, 2]);
});

test("incidentCommander reads as many days as Settings says, and gives up on my shift after the lookahead", async () => {
  resetDatadogCache();
  const { fetchImpl } = fakeOnCall({ first: DAY0, hours: 24 });
  const body = await incidentCommander({ days: 5, lookahead: 14, fetchImpl, readSecret: token, now: () => DAY0 + 3600e3 });
  assert.equal(body.days, 5);
  // The Americas walk stops past the five days; the Philippines walk keeps looking for my shift until 14 days.
  assert.equal(body.schedules[1].shifts.length, 7);
  assert.equal(body.schedules[0].shifts.length, 16);
  assert.equal(body.myNext, null);
});

test("incidentCommander stops at an empty schedule, and caches each window per day for as long as Settings says", async () => {
  resetDatadogCache();
  const { fetchImpl, asked } = fakeOnCall({ first: DAY0, hours: 12, stopAfter: 1 });
  const clock = { t: DAY0 + 3600e3 };
  const opts = { fetchImpl, readSecret: token, now: () => clock.t, cacheMinutes: 30 };
  const first = await incidentCommander(opts);
  assert.equal(first.schedules[0].shifts.length, 1);
  const n = asked.length;
  clock.t += 20 * 60e3;
  assert.equal(await incidentCommander(opts), first);
  assert.notEqual(await incidentCommander({ ...opts, days: 3 }), first);
  clock.t += 20 * 60e3;
  assert.notEqual(await incidentCommander(opts), first);
  assert.ok(asked.length > n);
  const again = await incidentCommander(opts);
  assert.notEqual(await incidentCommander({ ...opts, fresh: true }), again);
});

test("incidentCommander says when there's no token", async () => {
  resetDatadogCache();
  await assert.rejects(incidentCommander({ fetchImpl: async () => reply(200, {}), readSecret: async () => null }), { code: "no-token" });
});
