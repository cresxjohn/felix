import { test } from "node:test";
import assert from "node:assert/strict";
import {
  claudePlan,
  createAiUsage,
  cursorPlan,
  nextMonthStart,
  parseClaudeExtra,
  parseClaudeLimits,
  parseCursorUsage,
  severity,
} from "../ai-usage.mjs";
import { codedError, readKeychain } from "../keychain.mjs";

const NOW = Date.parse("2026-10-29T07:00:00Z");

const CLAUDE_CREDS = JSON.stringify({
  claudeAiOauth: { accessToken: "claude-token", expiresAt: NOW + 3600e3, subscriptionType: "team", rateLimitTier: "default_claude_max_5x" },
});

const CLAUDE_BODY = {
  limits: [
    { kind: "session", percent: 27, severity: "normal", resets_at: "2026-10-29T09:19:59Z" },
    { kind: "weekly_all", percent: 100, severity: "critical", resets_at: "2026-10-29T15:59:59Z" },
    { kind: "weekly_scoped", percent: 0, severity: "normal", resets_at: "2026-10-29T16:00:00Z", scope: { model: { display_name: "Fable" } } },
  ],
  spend: { enabled: true, used: { amount_minor: 1250, currency: "USD", exponent: 2 }, limit: null },
};

const CURSOR_USAGE = {
  billingCycleStart: "1791467564000",
  billingCycleEnd: "1794145964000",
  planUsage: { totalPercentUsed: 4.64, autoPercentUsed: 4.06, apiPercentUsed: 7.675 },
  spendLimitUsage: { pooledLimit: "200000", pooledUsed: 52528, individualLimit: 35000, individualRemaining: 30000 },
};

const CURSOR_PLAN = { planInfo: { planName: "Team", price: "$40/mo" } };

/**
 * A minimal stand-in for a fetch Response.
 * @param {number} status
 * @param {object} [body]
 * @returns {{ ok: boolean, status: number, json: () => Promise<object> }}
 */
function reply(status, body = {}) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/**
 * Builds fake Keychain, network and clock for createAiUsage.
 * @param {{ secrets?: Record<string, string | null>, routes?: Record<string, () => object>, clock?: { t: number } }} [options]
 */
function fakeDeps({ secrets = {}, routes = {}, clock = { t: NOW } } = {}) {
  const calls = [];
  const store = { "Claude Code-credentials": CLAUDE_CREDS, "cursor-access-token": "cursor-token", ...secrets };
  const table = {
    "oauth/usage": () => reply(200, CLAUDE_BODY),
    GetCurrentPeriodUsage: () => reply(200, CURSOR_USAGE),
    GetPlanInfo: () => reply(200, CURSOR_PLAN),
    ...routes,
  };
  return {
    calls,
    clock,
    deps: {
      readSecret: async (service) => store[service] ?? null,
      request: async (url, init) => {
        calls.push({ url, init });
        const key = Object.keys(table).find((k) => url.endsWith(k));
        return table[key]();
      },
      now: () => clock.t,
    },
  };
}

const byTool = (result, tool) => result.tools.find((t) => t.tool === tool);

test("severity uses the tool's own value when known, else the percent", () => {
  assert.equal(severity(10, "critical"), "critical");
  assert.equal(severity(10, "bogus"), "normal");
  assert.equal(severity(85), "warning");
  assert.equal(severity(100), "critical");
  assert.equal(severity("not a number"), "normal");
});

test("parseClaudeLimits reads the limits list with labels and resets", () => {
  const limits = parseClaudeLimits(CLAUDE_BODY);
  assert.deepEqual(limits.map((l) => l.label), ["Session (5 hours)", "Weekly · all models", "Weekly · Fable"]);
  assert.equal(limits[1].severity, "critical");
  assert.equal(limits[0].resetsAt, "2026-10-29T09:19:59Z");
});

test("parseClaudeLimits falls back to the per-window fields", () => {
  const limits = parseClaudeLimits({
    five_hour: { utilization: 50, resets_at: "a" },
    seven_day: { utilization: 90, resets_at: "b" },
    seven_day_opus: { utilization: 10, resets_at: "c" },
    seven_day_sonnet: null,
  });
  assert.deepEqual(limits.map((l) => [l.label, l.percent, l.severity]), [
    ["Session (5 hours)", 50, "normal"],
    ["Weekly · all models", 90, "warning"],
    ["Weekly · Opus", 10, "normal"],
  ]);
});

test("parseClaudeLimits names unknown kinds and handles empty answers", () => {
  assert.deepEqual(parseClaudeLimits(null), []);
  const [odd, scoped] = parseClaudeLimits({ limits: [{ kind: "monthly_cap", percent: -5 }, { kind: "weekly_scoped", percent: 1 }] });
  assert.equal(odd.label, "Monthly cap");
  assert.equal(odd.percent, 0);
  assert.equal(odd.resetsAt, null);
  assert.equal(scoped.label, "Weekly · one model");
  assert.equal(parseClaudeLimits({ limits: [{}] })[0].label, "Limit");
});

test("parseClaudeExtra reads spend, then the older extra_usage field, with next month's reset", () => {
  const resetsAt = "2026-11-01T00:00:00.000Z";
  assert.deepEqual(parseClaudeExtra(CLAUDE_BODY, NOW), { enabled: true, used: { amount: 12.5, currency: "USD" }, limit: null, resetsAt });
  assert.deepEqual(parseClaudeExtra({ spend: { enabled: false, used: { amount_minor: 300, exponent: 2 }, limit: { amount_minor: 5000, currency: "EUR" } } }, NOW), {
    enabled: false, used: { amount: 3, currency: "USD" }, limit: { amount: 50, currency: "EUR" }, resetsAt,
  });
  assert.deepEqual(parseClaudeExtra({ extra_usage: { is_enabled: true } }, NOW), { enabled: true, used: null, limit: null, resetsAt });
  assert.equal(parseClaudeExtra({}, NOW), null);
  assert.equal(parseClaudeExtra(null, NOW), null);
});

test("nextMonthStart rolls over the year in December", () => {
  assert.equal(nextMonthStart(Date.parse("2026-12-31T23:59:59Z")), "2027-01-01T00:00:00.000Z");
  assert.equal(nextMonthStart(Date.parse("2026-02-01T00:00:00Z")), "2026-03-01T00:00:00.000Z");
});

test("claudePlan and cursorPlan name the plans", () => {
  assert.equal(claudePlan({ subscriptionType: "team", rateLimitTier: "default_claude_max_5x" }), "Team · Max 5x");
  assert.equal(claudePlan({ subscriptionType: "pro" }), "Pro");
  assert.equal(claudePlan(), null);
  assert.equal(cursorPlan({ planName: "Team", price: "$40/mo" }), "Team · $40/mo");
  assert.equal(cursorPlan(null), null);
});

test("parseCursorUsage reads percents, on-demand spend and the billing cycle", () => {
  const u = parseCursorUsage(CURSOR_USAGE, CURSOR_PLAN.planInfo);
  assert.equal(u.plan, "Team · $40/mo");
  assert.deepEqual(u.limits.map((l) => [l.id, l.percent]), [["total", 4.64], ["auto", 4.06], ["api", 7.675]]);
  assert.ok(u.limits.every((l) => l.resetsAt === null));
  assert.deepEqual(u.onDemand, { individual: { used: 50, limit: 350 }, pool: { used: 525.28, limit: 2000 } });
  assert.equal(u.cycle.end, new Date(1794145964000).toISOString());
});

test("parseCursorUsage copes with missing parts", () => {
  const u = parseCursorUsage({ billingCycleEnd: "not-a-time", planUsage: { totalPercentUsed: 120 }, spendLimitUsage: { pooledLimit: "1000" } }, null);
  assert.equal(u.plan, null);
  assert.deepEqual(u.limits.map((l) => [l.id, l.severity]), [["total", "critical"]]);
  assert.deepEqual(u.cycle, { start: null, end: null });
  assert.deepEqual(u.onDemand, { individual: null, pool: { used: 0, limit: 10 } });
  assert.equal(parseCursorUsage(null, null).onDemand, null);
  assert.equal(parseCursorUsage({ spendLimitUsage: { individualLimit: "" } }, null).onDemand, null);
});

test("aiUsage loads both tools with their plans and limits", async () => {
  const { deps, calls } = fakeDeps();
  const result = await createAiUsage(deps)();
  const claude = byTool(result, "claude");
  const cursor = byTool(result, "cursor");
  assert.equal(claude.plan, "Team · Max 5x");
  assert.equal(claude.limits.length, 3);
  assert.equal(cursor.plan, "Team · $40/mo");
  assert.equal(cursor.onDemand.pool.limit, 2000);
  assert.equal(calls.find((c) => c.url.endsWith("oauth/usage")).init.headers.Authorization, "Bearer claude-token");
  assert.equal(calls.find((c) => c.url.endsWith("GetPlanInfo")).init.headers.Authorization, "Bearer cursor-token");
});

test("aiUsage says when a tool isn't signed in", async () => {
  const { deps } = fakeDeps({ secrets: { "Claude Code-credentials": null, "cursor-access-token": null } });
  const result = await createAiUsage(deps)();
  assert.equal(byTool(result, "claude").error.code, "not-connected");
  assert.match(byTool(result, "cursor").error.message, /cursor-agent login/);
  assert.equal(byTool(result, "cursor").limits, undefined);
});

test("aiUsage treats unreadable Claude credentials as not signed in", async () => {
  const { deps } = fakeDeps({ secrets: { "Claude Code-credentials": "{not json" } });
  assert.equal(byTool(await createAiUsage(deps)(), "claude").error.code, "not-connected");
});

test("aiUsage reports an expired Claude sign-in without calling Claude", async () => {
  const expired = JSON.stringify({ claudeAiOauth: { accessToken: "x", expiresAt: NOW - 1 } });
  const { deps, calls } = fakeDeps({ secrets: { "Claude Code-credentials": expired } });
  const result = await createAiUsage(deps)();
  assert.equal(byTool(result, "claude").error.code, "expired");
  assert.ok(!calls.some((c) => c.url.endsWith("oauth/usage")));
});

test("aiUsage maps HTTP failures to coded errors", async () => {
  const cases = [
    [() => reply(401), "auth"],
    [() => reply(429), "rate-limited"],
    [() => reply(500), "http"],
    [() => { throw new Error("offline"); }, "network"],
  ];
  for (const [route, code] of cases) {
    const { deps } = fakeDeps({ routes: { "oauth/usage": route } });
    assert.equal(byTool(await createAiUsage(deps)(), "claude").error.code, code);
  }
});

test("aiUsage still shows Cursor usage when its plan name can't be read", async () => {
  const { deps } = fakeDeps({ routes: { GetPlanInfo: () => reply(502) } });
  const cursor = byTool(await createAiUsage(deps)(), "cursor");
  assert.equal(cursor.plan, null);
  assert.equal(cursor.limits.length, 3);
  assert.equal(cursor.error, undefined);
});

test("aiUsage caches for 2 minutes and limits fresh checks to one per 15 seconds", async () => {
  const { deps, calls, clock } = fakeDeps();
  const aiUsage = createAiUsage(deps);
  const claudeCalls = () => calls.filter((c) => c.url.endsWith("oauth/usage")).length;
  await aiUsage();
  await aiUsage({ fresh: true });
  assert.equal(claudeCalls(), 1);
  clock.t += 20e3;
  await aiUsage();
  assert.equal(claudeCalls(), 1);
  await aiUsage({ fresh: true });
  assert.equal(claudeCalls(), 2);
  clock.t += 3 * 60e3;
  await aiUsage();
  assert.equal(claudeCalls(), 3);
});

test("aiUsage keeps the last numbers when a check fails, but not after signing out", async () => {
  const state = { claude: () => reply(200, CLAUDE_BODY) };
  const secrets = { "Claude Code-credentials": CLAUDE_CREDS };
  const { deps, clock } = fakeDeps({ routes: { "oauth/usage": () => state.claude() } });
  const readSecret = deps.readSecret;
  deps.readSecret = async (service) => (service in secrets ? secrets[service] : readSecret(service));
  const aiUsage = createAiUsage(deps);
  await aiUsage();
  state.claude = () => reply(500);
  clock.t += 3 * 60e3;
  const stale = byTool(await aiUsage(), "claude");
  assert.equal(stale.error.code, "http");
  assert.equal(stale.limits.length, 3);
  secrets["Claude Code-credentials"] = null;
  const signedOut = byTool(await aiUsage(), "claude");
  assert.equal(signedOut.error.code, "not-connected");
  assert.equal(signedOut.limits, undefined);
});

test("keychain helpers build coded errors and return null for missing items", async () => {
  const e = codedError("auth", "nope");
  assert.equal(e.code, "auth");
  assert.equal(e.message, "nope");
  assert.equal(await readKeychain("felix-test-item-that-does-not-exist", "nobody"), null);
  assert.equal(await readKeychain("felix-test-item-that-does-not-exist"), null);
});

test("aiUsage asks only the tools Settings shows, and keeps answers as long as Settings says", async () => {
  const { deps, calls, clock } = fakeDeps();
  const aiUsage = createAiUsage(deps);
  const onlyClaude = await aiUsage({ tools: ["claude"] });
  assert.deepEqual(onlyClaude.tools.map((t) => t.tool), ["claude"]);
  assert.ok(!calls.some((c) => c.url.includes("DashboardService")));
  assert.deepEqual((await aiUsage({ tools: [] })).tools, []);
  const n = calls.length;
  clock.t += 4 * 60e3;
  await aiUsage({ tools: ["claude"], cacheMinutes: 5 });
  assert.equal(calls.length, n);
  await aiUsage({ tools: ["claude"] });
  assert.equal(calls.length, n + 1);
});

test("while Claude limits checks, Felix waits before asking again and quietly keeps the last numbers", async () => {
  let limited = false;
  let retryAfter = null;
  const { deps, calls, clock } = fakeDeps({
    routes: { "oauth/usage": () => (limited ? { ok: false, status: 429, json: async () => ({}), headers: { get: (h) => (h === "retry-after" ? retryAfter : null) } } : reply(200, CLAUDE_BODY)) },
  });
  const usage = createAiUsage(deps);
  const claudeCalls = () => calls.filter((c) => c.url.endsWith("oauth/usage")).length;
  const first = byTool(await usage({ tools: ["claude"] }), "claude");
  assert.ok(first.limits.length && !first.error);
  limited = true;
  clock.t += 3 * 60e3;
  const quiet = byTool(await usage({ tools: ["claude"] }), "claude");
  assert.deepEqual([quiet.error, quiet.fetchedAt, Boolean(quiet.limited)], [undefined, first.fetchedAt, true]);
  assert.equal(claudeCalls(), 2);
  // Within the wait, even a fresh check doesn't ask.
  clock.t += 60e3;
  await usage({ tools: ["claude"], fresh: true });
  assert.equal(claudeCalls(), 2);
  // After 2 minutes it asks again; still limited, the wait doubles to 4 minutes.
  clock.t += 60e3 + 1;
  await usage({ tools: ["claude"] });
  assert.equal(claudeCalls(), 3);
  clock.t += 3 * 60e3;
  await usage({ tools: ["claude"] });
  assert.equal(claudeCalls(), 3);
  // Retry-After wins when Claude sends it, and a good answer clears the wait.
  clock.t += 60e3 + 1;
  retryAfter = "600";
  await usage({ tools: ["claude"] });
  assert.equal(claudeCalls(), 4);
  clock.t += 9 * 60e3;
  await usage({ tools: ["claude"] });
  assert.equal(claudeCalls(), 4);
  limited = false;
  clock.t += 60e3 + 1;
  const back = byTool(await usage({ tools: ["claude"] }), "claude");
  assert.deepEqual([back.limited, back.error], [undefined, undefined]);
  assert.equal(claudeCalls(), 5);
});

test("with nothing saved yet, a limited check says so", async () => {
  const { deps } = fakeDeps({ routes: { "oauth/usage": () => ({ ok: false, status: 429, json: async () => ({}) }) } });
  assert.equal(byTool(await createAiUsage(deps)({ tools: ["claude"] }), "claude").error.code, "rate-limited");
});

test("the last good numbers are kept on disk, so a restart still has them", async () => {
  const { mkdtemp, rm, readFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = await import("node:path");
  const dir = await mkdtemp(pathMod.join(tmpdir(), "felix-usage-"));
  try {
    const file = pathMod.join(dir, "data", "ai-usage.json");
    const { deps } = fakeDeps();
    const saved = byTool(await createAiUsage({ ...deps, file })(), "claude");
    await new Promise((r) => setTimeout(r, 50));
    assert.ok(JSON.parse(await readFile(file, "utf8")).claude.limits.length);
    const limitedDeps = fakeDeps({ routes: { "oauth/usage": () => ({ ok: false, status: 429, json: async () => ({}) }) }, clock: { t: NOW + 10 * 60e3 } }).deps;
    const after = byTool(await createAiUsage({ ...limitedDeps, file })({ tools: ["claude"] }), "claude");
    assert.deepEqual([after.fetchedAt, Boolean(after.limited), after.error], [saved.fetchedAt, true, undefined]);
    // A broken file is just ignored.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(file, "{not json");
    assert.ok(byTool(await createAiUsage({ ...fakeDeps().deps, file })({ tools: ["claude"] }), "claude").limits.length);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
