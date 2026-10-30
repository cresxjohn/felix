/**
 * Wais, the money planner, on the Personal Wais card and for Felix's AI: read-only, through Wais's own MCP server on
 * this Mac (felix-mcp-client.mjs). The server is started with Node, the Wais environment from Settings (dev until the
 * owner says prod) and the access token from the Keychain (cmd-center-wais). The token is never logged or returned.
 *
 * Its tools: spaces, accounts, safe_to_spend, tasks and outlook. Money comes as { amount, formatted }, days as
 * YYYY-MM-DD, and each answer has a link into Wais.
 */
import { createMcpClient } from "./felix-mcp-client.mjs";
import { codedError, readKeychain } from "./keychain.mjs";
import { OUTLOOK_PERIODS, SAFE_PERIODS } from "./public/wais-choices.mjs";

export const WAIS_SERVICE = "cmd-center-wais";
export const WAIS_ACCOUNT = "wais";
/** A Wais access token: wais_pat_ and 48 hex characters. */
export const WAIS_TOKEN = /^wais_pat_[0-9a-f]{48}$/;
/** Where Wais's MCP server is built on this Mac, unless Settings says otherwise. */
export const WAIS_PATH = "/Users/cresjohnlazo/dev/wais-app/apps/web/mcp/dist/wais-mcp.mjs";
export { OUTLOOK_PERIODS, SAFE_PERIODS };
const CACHE_MS = 2 * 60e3;

/**
 * How to start Wais's MCP server.
 * @param {{ token: string, env: string, path: string }} o
 * @returns {import("./felix-mcp-client.mjs").ServerSpec}
 */
export const waisSpec = ({ token, env, path }) => ({ command: process.execPath, args: [path || WAIS_PATH], env: { WAIS_ENV: env === "prod" ? "prod" : "dev", WAIS_TOKEN: token } });

/**
 * Whether an error is Wais turning the token down (made wrong, or revoked in Wais).
 * @param {unknown} e
 * @returns {boolean}
 */
export const refusedToken = (e) => /token/i.test(String(e?.message || e)) && /(not valid|revoked|expired|invalid|unauthori[sz]ed)/i.test(String(e?.message || e));

/**
 * A plain reason for a failed Wais call, never with the token in it.
 * @param {unknown} e
 * @returns {string}
 */
export function waisProblem(e) {
  if (refusedToken(e)) return "Wais refused the token. It may have been revoked.";
  const text = String(e?.message || e || "").replace(/wais_pat_[0-9a-f]+/gi, "(token)");
  if (/not-set-up|isn't set up/i.test(text)) return "Wais isn't connected yet.";
  if (/couldn't start|ENOENT|stopped/i.test(text)) return "Felix couldn't start the Wais connection. Check the server path in Settings → Wais.";
  if (/too long/i.test(text)) return "Wais took too long to answer.";
  return text.replace(/^wais:\s*/i, "") || "Wais couldn't answer.";
}

/**
 * The card's request, checked: a space id, a Safe to spend period, picked accounts and the outlook's period. Anything
 * unknown is left out, so Wais uses its own saved choice.
 * @param {{ space?: unknown, period?: unknown, accounts?: unknown, outlook?: unknown }} q
 * @returns {{ space?: string, period?: string, accounts?: string[], outlook: string }}
 */
export function waisAsk(q = {}) {
  const id = (v) => (typeof v === "string" && /^[\w-]{1,80}$/.test(v) ? v : undefined);
  const accounts = (Array.isArray(q.accounts) ? q.accounts : String(q.accounts || "").split(",")).map((a) => id(String(a).trim())).filter(Boolean).slice(0, 50);
  return {
    ...(id(q.space) ? { space: q.space } : {}),
    ...(SAFE_PERIODS.includes(String(q.period)) ? { period: String(q.period) } : {}),
    ...(accounts.length ? { accounts } : {}),
    outlook: OUTLOOK_PERIODS.includes(String(q.outlook)) ? String(q.outlook) : "30",
  };
}

/**
 * Puts the five answers together for the card. Each part that failed says why on its own; when every part failed
 * because Wais refused the token, the whole card says so.
 * @param {Record<"spaces" | "accounts" | "safe" | "tasks" | "outlook", PromiseSettledResult<any>>} parts
 * @param {string} fetchedAt
 */
export function waisView(parts, fetchedAt) {
  const all = Object.values(parts);
  if (all.every((p) => p.status === "rejected") && all.some((p) => refusedToken(p.reason))) {
    return { connected: true, refused: true, problem: waisProblem(all.find((p) => refusedToken(p.reason)).reason) };
  }
  const out = { connected: true, refused: false, fetchedAt, problems: {} };
  for (const [key, p] of Object.entries(parts)) {
    out[key] = p.status === "fulfilled" ? p.value : null;
    if (p.status === "rejected") out.problems[key] = waisProblem(p.reason);
  }
  return out;
}

/**
 * Creates Felix's Wais connection.
 * @param {{ settings: { get: () => Promise<Record<string, any>> }, readToken?: () => Promise<string | null>,
 *   makeClient?: typeof createMcpClient, now?: () => number }} deps
 */
export function createWais({ settings, readToken = () => readKeychain(WAIS_SERVICE, WAIS_ACCOUNT), makeClient = createMcpClient, now = Date.now }) {
  const cache = new Map();

  /**
   * How to start the server with a token, as Settings say.
   * @param {string} token
   */
  const specWith = async (token) => {
    const s = await settings.get();
    return waisSpec({ token, env: s.waisEnv, path: s.waisPath });
  };
  const client = makeClient({
    name: "Wais",
    spec: async () => {
      const token = await readToken().catch(() => null);
      return token ? specWith(token) : null;
    },
  });

  /**
   * Whether a token is saved, without reading it out.
   * @returns {Promise<boolean>}
   */
  const connected = async () => Boolean(await readToken().catch(() => null));

  /**
   * Tries a token before it's saved: Wais must answer the spaces tool with it. Throws a coded error in plain words.
   * @param {{ token?: string }} fields
   * @returns {Promise<{ name?: string }>} The default space's name.
   */
  async function check({ token = "" }) {
    if (!WAIS_TOKEN.test(token)) throw codedError("input", "That doesn't look like a Wais token. It starts with wais_pat_.");
    const trial = makeClient({ name: "Wais", spec: () => specWith(token), idleMs: 5_000 });
    try {
      const answer = await trial.call("spaces", {});
      const space = (answer?.spaces || []).find((s) => s.id === answer.default) || answer?.spaces?.[0];
      return space ? { name: space.name } : {};
    } catch (e) {
      throw codedError(refusedToken(e) ? "auth" : "error", refusedToken(e) ? "Wais refused that token. Make a new one in Wais → Settings → Security → Access tokens." : waisProblem(e));
    } finally {
      trial.stop();
    }
  }

  /**
   * Calls one of Wais's tools, for Felix's AI.
   * @param {string} tool
   * @param {Record<string, unknown>} [args]
   */
  async function call(tool, args = {}) {
    try {
      return await client.call(tool, args);
    } catch (e) {
      throw new Error(waisProblem(e));
    }
  }

  /**
   * Everything the card shows, asked in parallel and kept for two minutes.
   * @param {{ space?: string, period?: string, accounts?: string[], outlook?: string, fresh?: boolean }} [q]
   */
  async function view(q = {}) {
    if (!(await connected())) return { connected: false };
    const ask = waisAsk(q);
    const key = JSON.stringify(ask);
    const hit = cache.get(key);
    if (!q.fresh && hit && now() - hit.at < CACHE_MS) return hit.value;
    const space = ask.space ? { space: ask.space } : {};
    const names = ["spaces", "accounts", "safe", "tasks", "outlook"];
    const settled = await Promise.allSettled([
      client.call("spaces", {}),
      client.call("accounts", space),
      client.call("safe_to_spend", { ...space, ...(ask.period ? { period: ask.period } : {}), ...(ask.accounts ? { accounts: ask.accounts } : {}) }),
      client.call("tasks", space),
      client.call("outlook", { ...space, period: ask.outlook }),
    ]);
    const value = waisView(Object.fromEntries(names.map((n, i) => [n, settled[i]])), new Date(now()).toISOString());
    if (!value.refused) cache.set(key, { at: now(), value });
    return value;
  }

  /** Forgets what's kept and stops the server, as after a new token or a change in Settings. */
  function reset() {
    cache.clear();
    client.stop();
  }

  return { check, call, view, reset, connected };
}
