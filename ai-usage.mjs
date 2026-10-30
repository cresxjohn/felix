/**
 * AI usage card: how much of each AI tool's plan limits is used, for Claude Code and Cursor.
 * Each tool's own sign-in token is read from the Keychain on every check and never stored.
 */
import { readFileSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codedError, readKeychain } from "./keychain.mjs";

const CLAUDE_KEYCHAIN = "Claude Code-credentials";
const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CURSOR_KEYCHAIN = "cursor-access-token";
const CURSOR_API = process.env.CURSOR_API_ENDPOINT || "https://api2.cursor.sh";
const CACHE_MINUTES = 2;
const FRESH_FLOOR_MS = 15e3;
const TIMEOUT_MS = 15e3;
const WARN_AT = 80;
// While a tool is limiting usage checks, Felix waits before asking again: its Retry-After, else 2, 4, 8… minutes.
const BACKOFF_MIN_MS = 2 * 60e3;
const BACKOFF_MAX_MS = 30 * 60e3;
const SEVERITIES = new Set(["normal", "warning", "critical"]);

const TOOLS = {
  claude: { name: "Claude", url: "https://claude.ai/settings/usage", login: "claude auth login" },
  cursor: { name: "Cursor", url: "https://cursor.com/dashboard?tab=usage", login: "cursor-agent login" },
};

const CLAUDE_LABELS = { session: "Session (5 hours)", weekly_all: "Weekly · all models" };

const CLAUDE_WINDOWS = [
  { field: "five_hour", kind: "session" },
  { field: "seven_day", kind: "weekly_all" },
  { field: "seven_day_opus", kind: "weekly_scoped", model: "Opus" },
  { field: "seven_day_sonnet", kind: "weekly_scoped", model: "Sonnet" },
];

/**
 * @typedef {object} Meter
 * @property {string} id
 * @property {string} label
 * @property {number} percent Share of the limit used, 0 to 100 (or more when over).
 * @property {"normal" | "warning" | "critical"} severity
 * @property {string | null} resetsAt ISO time the limit resets, when it has its own reset.
 */

/**
 * @typedef {object} Money
 * @property {number} amount
 * @property {string} currency
 */

/**
 * Turns a value into a non-negative percent.
 * @param {unknown} value
 * @returns {number}
 */
function toPercent(value) {
  return Math.max(0, Number(value) || 0);
}

/**
 * Picks a meter's severity: the tool's own when it gives a known one, else from the percent.
 * @param {unknown} percent
 * @param {unknown} [given]
 * @returns {"normal" | "warning" | "critical"}
 */
export function severity(percent, given) {
  if (typeof given === "string" && SEVERITIES.has(given)) return /** @type {"normal" | "warning" | "critical"} */ (given);
  const p = toPercent(percent);
  return p >= 100 ? "critical" : p >= WARN_AT ? "warning" : "normal";
}

/**
 * Upper-cases the first letter.
 * @param {string | undefined} s
 * @returns {string}
 */
function capitalize(s) {
  return s ? s[0].toUpperCase() + s.slice(1) : "";
}

/**
 * Parses JSON, or returns null when it isn't valid.
 * @param {string | null} raw
 * @returns {Record<string, unknown> | null}
 */
function parseJson(raw) {
  try {
    return JSON.parse(raw || "null");
  } catch {
    return null;
  }
}

/**
 * Converts a millisecond timestamp (number or string) to an ISO time.
 * @param {unknown} ms
 * @returns {string | null}
 */
function msToIso(ms) {
  if (ms == null || ms === "") return null;
  const d = new Date(Number(ms));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Converts cents to dollars.
 * @param {unknown} cents
 * @returns {number | null}
 */
function dollars(cents) {
  if (cents == null || cents === "") return null;
  const n = Number(cents);
  return Number.isFinite(n) ? n / 100 : null;
}

/**
 * Reads Anthropic's money shape, `{ amount_minor, exponent, currency }`.
 * @param {{ amount_minor?: number, exponent?: number, currency?: string } | null | undefined} m
 * @returns {Money | null}
 */
function money(m) {
  if (!m || !Number.isFinite(m.amount_minor)) return null;
  return { amount: Number(m.amount_minor) / 10 ** (m.exponent ?? 2), currency: m.currency || "USD" };
}

/**
 * Names a Claude limit the way the page shows it.
 * @param {{ kind?: string, scope?: { model?: { display_name?: string | null } } | null }} limit
 * @returns {string}
 */
function claudeLabel(limit) {
  if (limit.kind && CLAUDE_LABELS[limit.kind]) return CLAUDE_LABELS[limit.kind];
  if (limit.kind === "weekly_scoped") return `Weekly · ${limit.scope?.model?.display_name || "one model"}`;
  return capitalize(String(limit.kind || "limit").replace(/_/g, " "));
}

/**
 * Builds Claude's limit list from the older per-window fields, for answers without `limits`.
 * @param {Record<string, { utilization?: number, resets_at?: string } | null>} body
 * @returns {Array<{ kind: string, percent?: number, resets_at?: string, scope: object | null }>}
 */
function claudeWindows(body) {
  return CLAUDE_WINDOWS.filter((w) => body[w.field]).map((w) => ({
    kind: w.kind,
    percent: body[w.field].utilization,
    resets_at: body[w.field].resets_at,
    scope: w.model ? { model: { display_name: w.model } } : null,
  }));
}

/**
 * Reads Claude's plan limits (session, weekly, per-model weekly) from its usage answer.
 * @param {Record<string, unknown> | null} body Answer from Claude's OAuth usage endpoint.
 * @returns {Meter[]}
 */
export function parseClaudeLimits(body) {
  if (!body) return [];
  const list = Array.isArray(body.limits) ? body.limits : claudeWindows(body);
  return list.map((l) => {
    const label = claudeLabel(l);
    return { id: `${l.kind}:${label}`, label, percent: toPercent(l.percent), severity: severity(l.percent, l.severity), resetsAt: l.resets_at || null };
  });
}

/**
 * The first moment of next month, in UTC. Claude counts extra usage month to date and doesn't send
 * when that count resets, so this is the reset the card shows.
 * @param {number} now Milliseconds.
 * @returns {string} ISO time.
 */
export function nextMonthStart(now) {
  const d = new Date(now);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString();
}

/**
 * Reads Claude's extra usage (credits used past the plan limits) and when its monthly count resets.
 * @param {{ spend?: { enabled?: boolean, used?: object, limit?: object }, extra_usage?: { is_enabled?: boolean } } | null} body
 * @param {number} now Milliseconds.
 * @returns {{ enabled: boolean, used: Money | null, limit: Money | null, resetsAt: string } | null}
 */
export function parseClaudeExtra(body, now) {
  const resetsAt = nextMonthStart(now);
  if (body?.spend) return { enabled: Boolean(body.spend.enabled), used: money(body.spend.used), limit: money(body.spend.limit), resetsAt };
  if (body?.extra_usage) return { enabled: Boolean(body.extra_usage.is_enabled), used: null, limit: null, resetsAt };
  return null;
}

/**
 * Names the Claude plan, for example "Team · Max 5x".
 * @param {{ subscriptionType?: string, rateLimitTier?: string }} [oauth]
 * @returns {string | null}
 */
export function claudePlan(oauth = {}) {
  const tier = /max_(\d+)x/.exec(oauth.rateLimitTier || "");
  return [capitalize(oauth.subscriptionType), tier ? `Max ${tier[1]}x` : ""].filter(Boolean).join(" · ") || null;
}

/**
 * Names the Cursor plan, for example "Team · $40/mo".
 * @param {{ planName?: string, price?: string } | null | undefined} planInfo
 * @returns {string | null}
 */
export function cursorPlan(planInfo) {
  return [planInfo?.planName, planInfo?.price].filter(Boolean).join(" · ") || null;
}

/**
 * Reads Cursor's on-demand spend: mine against my own limit, and the team's shared pool.
 * @param {Record<string, unknown> | null | undefined} s `spendLimitUsage` from Cursor.
 * @returns {{ individual: { used: number | null, limit: number | null } | null, pool: { used: number | null, limit: number | null } | null } | null}
 */
function cursorOnDemand(s) {
  if (!s) return null;
  const limit = dollars(s.individualLimit);
  const remaining = dollars(s.individualRemaining);
  const individual = limit != null && remaining != null ? { used: Math.max(0, limit - remaining), limit } : null;
  const pool = s.pooledLimit != null ? { used: dollars(s.pooledUsed) ?? 0, limit: dollars(s.pooledLimit) } : null;
  return individual || pool ? { individual, pool } : null;
}

/**
 * @typedef {object} CursorUsage
 * @property {string} [billingCycleStart] Milliseconds, as a string.
 * @property {string} [billingCycleEnd] Milliseconds, as a string.
 * @property {{ totalPercentUsed?: number, autoPercentUsed?: number, apiPercentUsed?: number }} [planUsage]
 * @property {Record<string, number | string>} [spendLimitUsage] Cents, some as strings.
 */

/**
 * Reads Cursor's included-usage percents, on-demand spend and billing cycle.
 * @param {CursorUsage | null} usage Answer from DashboardService/GetCurrentPeriodUsage.
 * @param {{ planName?: string, price?: string } | null | undefined} planInfo From GetPlanInfo.
 * @returns {{ plan: string | null, limits: Meter[], cycle: { start: string | null, end: string | null }, onDemand: ReturnType<typeof cursorOnDemand> }}
 */
export function parseCursorUsage(usage, planInfo) {
  const plan = usage?.planUsage || {};
  const meters = [
    { id: "total", label: "Included usage", value: plan.totalPercentUsed },
    { id: "auto", label: "Auto and Composer", value: plan.autoPercentUsed },
    { id: "api", label: "Named models (API)", value: plan.apiPercentUsed },
  ];
  return {
    plan: cursorPlan(planInfo),
    limits: meters
      .filter((m) => Number.isFinite(m.value))
      .map((m) => ({ id: m.id, label: m.label, percent: toPercent(m.value), severity: severity(m.value), resetsAt: null })),
    cycle: { start: msToIso(usage?.billingCycleStart), end: msToIso(usage?.billingCycleEnd) },
    onDemand: cursorOnDemand(usage?.spendLimitUsage),
  };
}

/**
 * Calls a tool's API and turns HTTP failures into coded errors the page understands.
 * @param {(url: string, init: RequestInit) => Promise<Response>} request
 * @param {string} url
 * @param {RequestInit} init
 * @param {keyof typeof TOOLS} tool
 * @returns {Promise<Record<string, unknown>>}
 */
async function requestJson(request, url, init, tool) {
  const { name, login } = TOOLS[tool];
  let res;
  try {
    res = await request(url, init);
  } catch {
    throw codedError("network", `Couldn't reach ${name}.`);
  }
  if (res.status === 401 || res.status === 403) throw codedError("auth", `${name} refused its sign-in. Run \`${login}\`.`);
  if (res.status === 429) {
    const after = Number(res.headers?.get?.("retry-after"));
    throw Object.assign(codedError("rate-limited", `${name} is limiting usage checks for now.`), Number.isFinite(after) && after > 0 ? { retryAfterMs: after * 1000 } : {});
  }
  if (!res.ok) throw codedError("http", `${name} answered ${res.status}.`);
  return res.json();
}

/**
 * Reads Claude Code's sign-in from the Keychain.
 * @param {(service: string) => Promise<string | null>} readSecret
 * @param {number} now
 * @returns {Promise<{ accessToken: string, expiresAt?: number, subscriptionType?: string, rateLimitTier?: string }>}
 */
async function claudeSignIn(readSecret, now) {
  const oauth = parseJson(await readSecret(CLAUDE_KEYCHAIN))?.claudeAiOauth;
  if (!oauth?.accessToken) throw codedError("not-connected", `Claude Code isn't signed in on this Mac. Run \`${TOOLS.claude.login}\`.`);
  if (oauth.expiresAt && oauth.expiresAt < now) {
    throw codedError("expired", `Claude's sign-in has expired. It renews the next time Claude Code runs, or run \`${TOOLS.claude.login}\`.`);
  }
  return oauth;
}

/**
 * Loads Claude's plan and limits.
 * @param {UsageDeps} deps
 */
async function loadClaude({ readSecret, request, now }) {
  const at = now();
  const oauth = await claudeSignIn(readSecret, at);
  const body = await requestJson(request, CLAUDE_USAGE_URL, {
    headers: { Authorization: `Bearer ${oauth.accessToken}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
  }, "claude");
  return { plan: claudePlan(oauth), limits: parseClaudeLimits(body), extra: parseClaudeExtra(body, at) };
}

/**
 * Loads Cursor's plan, included usage, on-demand spend and billing cycle.
 * @param {UsageDeps} deps
 */
async function loadCursor({ readSecret, request }) {
  const token = await readSecret(CURSOR_KEYCHAIN);
  if (!token) throw codedError("not-connected", `Cursor isn't signed in on this Mac. Run \`${TOOLS.cursor.login}\`.`);
  const call = (method) => requestJson(request, `${CURSOR_API}/aiserver.v1.DashboardService/${method}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "Connect-Protocol-Version": "1" },
    body: "{}",
  }, "cursor");
  const [usage, plan] = await Promise.all([call("GetCurrentPeriodUsage"), call("GetPlanInfo").catch(() => null)]);
  return parseCursorUsage(usage, plan?.planInfo);
}

const LOADERS = { claude: loadClaude, cursor: loadCursor };

/**
 * @typedef {object} UsageDeps
 * @property {(service: string) => Promise<string | null>} readSecret Reads a Keychain item.
 * @property {(url: string, init: RequestInit) => Promise<Response>} request Makes an HTTP request.
 * @property {() => number} now Current time in milliseconds.
 */

/**
 * Builds the usage reader with its own cache. Each tool is cached for 2 minutes (or `cacheMinutes`); `fresh` asks
 * again, but never more than once every 15 seconds. A failed check keeps showing the last good numbers. `tools` names
 * the tools to read, both unless Settings hides one; a hidden tool isn't asked at all.
 *
 * The last good numbers are also kept on disk (`file`), so a restart still has them. When a tool limits usage checks
 * (HTTP 429), Felix stops asking it until its Retry-After passes (else 2, 4, 8… up to 30 minutes) and keeps showing
 * the last numbers quietly, with their time, rather than an error, so nothing reads Claude's plan as unknown.
 * @param {UsageDeps & { file?: string }} deps
 * @returns {(options?: { fresh?: boolean, tools?: string[], cacheMinutes?: number }) => Promise<{ fetchedAt: string, tools: Array<Record<string, unknown>> }>}
 */
export function createAiUsage(deps) {
  const cache = {};
  const waits = {}; // tool -> { until, tries } while it's limiting checks
  if (deps.file) {
    try {
      for (const [key, data] of Object.entries(JSON.parse(readFileSync(deps.file, "utf8")))) {
        if (TOOLS[key] && data?.fetchedAt) cache[key] = { at: Date.parse(data.fetchedAt) || 0, data };
      }
    } catch {}
  }

  /**
   * Keeps the last good numbers on disk. Writes take turns, and each goes to a spare file first and is then moved
   * into place, so two tools saving at once can't leave a half-written file.
   */
  let writing = Promise.resolve();
  const save = () => {
    if (!deps.file) return writing;
    const spare = `${deps.file}.${process.pid}.tmp`;
    writing = writing.then(async () => {
      const all = Object.fromEntries(Object.entries(cache).map(([key, hit]) => [key, hit.data]));
      await mkdir(path.dirname(deps.file), { recursive: true });
      await writeFile(spare, `${JSON.stringify(all)}\n`);
      await rename(spare, deps.file);
    }).catch(() => {});
    return writing;
  };

  /**
   * Loads one tool, from the cache when it is recent enough.
   * @param {keyof typeof LOADERS} key
   * @param {boolean} fresh
   * @param {number} cacheMinutes
   */
  async function loadTool(key, fresh, cacheMinutes) {
    const { name, url } = TOOLS[key];
    const hit = cache[key];
    if (hit && deps.now() - hit.at < (fresh ? FRESH_FLOOR_MS : cacheMinutes * 60e3)) return hit.data;
    const wait = waits[key];
    if (wait && deps.now() < wait.until && hit) return { ...hit.data, limited: { retryAt: new Date(wait.until).toISOString() } };
    try {
      const data = { tool: key, name, url, ...(await LOADERS[key](deps)), fetchedAt: new Date(deps.now()).toISOString() };
      cache[key] = { at: deps.now(), data };
      delete waits[key];
      save();
      return data;
    } catch (e) {
      const error = { code: e.code || "error", message: e.message };
      if (error.code === "rate-limited") {
        const tries = (wait?.tries || 0) + 1;
        const until = deps.now() + (e.retryAfterMs || Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (tries - 1)));
        waits[key] = { until, tries };
        if (cache[key]) return { ...cache[key].data, limited: { retryAt: new Date(until).toISOString() } };
      }
      if (error.code === "not-connected") {
        delete cache[key];
        save();
      }
      return cache[key] ? { ...cache[key].data, error } : { tool: key, name, url, error };
    }
  }

  return async function aiUsage({ fresh = false, tools: wanted = Object.keys(LOADERS), cacheMinutes = CACHE_MINUTES } = {}) {
    const tools = await Promise.all(Object.keys(LOADERS).filter((key) => wanted.includes(key)).map((key) => loadTool(key, fresh, cacheMinutes)));
    return { fetchedAt: new Date(deps.now()).toISOString(), tools };
  };
}

export const aiUsage = createAiUsage({
  // Felix's home holds his data; a release runs its own copy of the code (see server.mjs).
  file: path.join(process.env.FELIX_HOME || path.dirname(fileURLToPath(import.meta.url)), "data", "ai-usage.json"),
  readSecret: (service) => readKeychain(service),
  request: (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) }),
  now: Date.now,
});
