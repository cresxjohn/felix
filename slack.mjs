// Slack, as you: Start my day posts to #attendance-engineering-ph and sets your presence, and the Slack card shows
// your mentions, what you saved for later and the channels you watch. Slack Web API with a user token (xoxp-) from
// a Slack app made from SLACK_MANIFEST, kept in the Keychain as service "cmd-center-slack", account "slack". Until
// a token is saved, every caller hears that Slack isn't connected.
import { codedError, readKeychain } from "./keychain.mjs";

export const SLACK_SERVICE = "cmd-center-slack";
export const SLACK_ACCOUNT = "slack";
const API = "https://slack.com/api/";
// Reading the Keychain starts a process, and every open window asks for the day's state every few seconds.
const TOKEN_CACHE_MS = 30e3;
const AUTH_ERRORS = new Set(["invalid_auth", "not_authed", "token_revoked", "token_expired", "account_inactive"]);
const NAMES_MS = 60 * 60e3;
const CHANNELS_MS = 60 * 60e3;
const ROWS = 20;

/** The Slack app to make once, in the PURE PM workspace: everything Felix does, as you, and nothing more. */
export const SLACK_MANIFEST = `display_information:
  name: Felix
  description: Felix on your Mac, as you. Reads your mentions, saved items and the channels you watch, and posts Start my day.
oauth_config:
  scopes:
    user:
      - search:read
      - stars:read
      - users:read
      - channels:read
      - groups:read
      - im:read
      - mpim:read
      - channels:history
      - groups:history
      - im:history
      - mpim:history
      - chat:write
      - users:write
settings:
  org_deploy_enabled: false
  socket_mode_enabled: false
  token_rotation_enabled: false
`;

/**
 * Slack's message markup made plain: people and channels by name, links by their text, and its escapes undone.
 * @param {string} text
 * @param {(id: string) => string} [nameOf] A person's name by their Slack id.
 * @returns {string}
 */
export function plainText(text, nameOf = (id) => id) {
  return String(text || "")
    .replace(/<@([UW][A-Z0-9]+)(?:\|([^>]+))?>/g, (_, id, label) => `@${label || nameOf(id)}`)
    .replace(/<#[CG][A-Z0-9]+\|([^>]*)>/g, (_, name) => `#${name}`)
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, "@$1")
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, "$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, (_, url) => url.replace(/^https?:\/\/(www\.)?/, ""))
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
    .replace(/\s+/g, " ").trim();
}

/**
 * A watch list as names: one channel per line or comma, with or without #.
 * @param {string} text
 * @returns {string[]}
 */
export const watchList = (text) => [...new Set(String(text || "").split(/[\n,]+/).map((c) => c.trim().replace(/^#/, "").toLowerCase()).filter(Boolean))].slice(0, 20);

/**
 * Calls one Slack Web API method with a token, and turns Slack's refusals into coded errors.
 * Form-encoded, since every method takes that (some don't take JSON).
 * @param {string} method Like "chat.postMessage".
 * @param {string} token
 * @param {Record<string, string>} [fields]
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<Record<string, any>>} Slack's answer.
 * @throws {Error & { code: string }} "auth", "scope", "rate", "network" or "slack".
 */
export async function slackCall(method, token, fields = {}, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${API}${method}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
    });
  } catch {
    throw codedError("network", "Couldn't reach Slack.");
  }
  const answer = await res.json().catch(() => ({}));
  if (answer.ok) return answer;
  const error = answer.error || `http_${res.status}`;
  if (AUTH_ERRORS.has(error)) throw codedError("auth", "Slack refused the token. It may have expired or been revoked; connect Slack again.");
  if (error === "missing_scope") throw codedError("scope", `The Slack app needs the ${answer.needed || "right"} scope. Add it, then connect Slack again.`);
  if (error === "ratelimited" || res.status === 429) throw codedError("rate", "Slack asked Felix to slow down. Try again in a minute.");
  throw codedError("slack", `Slack said "${error}".`);
}

/** Slack methods that only read: lists, infos, histories, replies, searches, lookups. */
const READ_METHOD = /^[a-z]+(\.[a-z]+)*\.(list|info|history|replies|lookupByEmail|members|messages|all|get[A-Za-z]*|profile\.get)$/;

/**
 * Tries a token before it's saved, so only a working user token reaches the Keychain.
 * @param {{ token: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ name: string }>} Who Slack says you are, and in which workspace.
 * @throws {Error & { code: string }} When Slack refuses it, or it's a bot's token rather than yours.
 */
export async function checkSlack({ token, fetchImpl = fetch }) {
  const me = await slackCall("auth.test", token, {}, fetchImpl);
  if (me.bot_id) throw codedError("input", "That's a bot token. Felix posts as you, so it needs your user token (xoxp-).");
  return { name: me.team ? `${me.user} on ${me.team}` : me.user || "you" };
}

/**
 * Makes the Slack client the work day and the Slack card use.
 * @param {{ readSecret?: typeof readKeychain, fetchImpl?: typeof fetch, now?: () => number }} [deps]
 * @returns {{ card: Function, connected: () => Promise<boolean>, post: (channel: string, text: string) => Promise<object>,
 *   presence: (presence: "auto" | "away") => Promise<object>, reset: () => void }}
 */
export function createSlack({ readSecret = readKeychain, fetchImpl = fetch, now = Date.now } = {}) {
  let cached = null;
  let cardCache = null;
  let channelsCache = null;
  const names = new Map(); // user id -> { at, name }
  const places = new Map(); // conversation id -> { at, name }

  /**
   * The saved token, read again at most every 30 seconds.
   * @returns {Promise<string | null>}
   */
  async function token() {
    if (!cached || now() - cached.at > TOKEN_CACHE_MS) cached = { at: now(), value: await readSecret(SLACK_SERVICE, SLACK_ACCOUNT) };
    return cached.value;
  }

  /**
   * The token, or a coded error saying Slack isn't connected.
   * @returns {Promise<string>}
   */
  async function needToken() {
    const value = await token();
    if (!value) throw codedError("no-token", "Slack isn't connected yet.");
    return value;
  }

  /**
   * A person's name, asked of Slack once an hour.
   * @param {string} tok
   * @param {string} id
   * @returns {Promise<string>}
   */
  async function nameOf(tok, id) {
    if (!id) return "";
    const hit = names.get(id);
    if (hit && now() - hit.at < NAMES_MS) return hit.name;
    let name = id;
    try {
      const { user } = await slackCall("users.info", tok, { user: id }, fetchImpl);
      name = user?.profile?.display_name || user?.profile?.real_name || user?.real_name || user?.name || id;
    } catch {}
    names.set(id, { at: now(), name });
    return name;
  }

  /**
   * Where a conversation is, said plainly: "#releases", or "a direct message".
   * @param {string} tok
   * @param {{ id?: string, name?: string, is_im?: boolean, is_mpim?: boolean } | string} channel
   * @returns {Promise<string>}
   */
  async function placeOf(tok, channel) {
    const c = typeof channel === "string" ? { id: channel } : channel || {};
    if (c.is_im) return "a direct message";
    if (c.is_mpim) return "a group message";
    if (c.name && !/^[CDG][A-Z0-9]{8,}$/.test(c.name)) return `#${c.name}`;
    const hit = places.get(c.id);
    if (hit && now() - hit.at < CHANNELS_MS) return hit.name;
    let name = "a conversation";
    try {
      const { channel: info } = await slackCall("conversations.info", tok, { channel: c.id }, fetchImpl);
      name = info?.is_im ? "a direct message" : info?.is_mpim ? "a group message" : info?.name ? `#${info.name}` : name;
    } catch {}
    places.set(c.id, { at: now(), name });
    return name;
  }

  /**
   * Every channel you're in, by name, asked of Slack once an hour.
   * @param {string} tok
   * @returns {Promise<Map<string, string>>} name -> id
   */
  async function channelIds(tok) {
    if (channelsCache && now() - channelsCache.at < CHANNELS_MS) return channelsCache.map;
    const map = new Map();
    let cursor = "";
    for (let page = 0; page < 10; page += 1) {
      const answer = await slackCall("users.conversations", tok, { types: "public_channel,private_channel", exclude_archived: "true", limit: "999", ...(cursor ? { cursor } : {}) }, fetchImpl);
      for (const c of answer.channels || []) if (c.name) map.set(c.name.toLowerCase(), c.id);
      cursor = answer.response_metadata?.next_cursor || "";
      if (!cursor) break;
    }
    channelsCache = { at: now(), map };
    return map;
  }

  /**
   * How many messages wait in a channel since you last read it (up to 100, said as "100+").
   * @param {string} tok
   * @param {string} id
   * @returns {Promise<number>}
   */
  async function unreadIn(tok, id) {
    const { channel } = await slackCall("conversations.info", tok, { channel: id }, fetchImpl);
    if (Number.isFinite(channel?.unread_count_display)) return channel.unread_count_display;
    const { messages = [] } = await slackCall("conversations.history", tok, { channel: id, oldest: channel?.last_read || "0", limit: "100" }, fetchImpl);
    return messages.filter((m) => !m.subtype || m.subtype === "thread_broadcast" || m.subtype === "bot_message").length;
  }

  /**
   * The Slack card: your mentions from the last few days (newest first, not your own), what you saved for later,
   * and the unread count of each channel you watch. Kept for `cacheMinutes` unless `fresh`.
   * @param {{ fresh?: boolean, days?: number, watch?: string[], saved?: boolean, cacheMinutes?: number }} [options]
   * @returns {Promise<{ fetchedAt: string, me: { name: string, team: string, url: string }, mentions: object[], saved: object[] | null,
   *   unread: object[], missing: string[], problems: Record<string, string> }>}
   */
  async function card({ fresh = false, days = 3, watch = [], saved = true, cacheMinutes = 2 } = {}) {
    const key = JSON.stringify({ days, watch, saved });
    if (!fresh && cardCache?.key === key && now() - cardCache.at < cacheMinutes * 60e3) return cardCache.body;
    const tok = await needToken();
    const me = await slackCall("auth.test", tok, {}, fetchImpl);
    const since = new Date(now() - (days + 1) * 86400e3).toISOString().slice(0, 10);
    const found = await slackCall("search.messages", tok, { query: `<@${me.user_id}> after:${since}`, sort: "timestamp", sort_dir: "desc", count: String(ROWS) }, fetchImpl);
    const matches = (found.messages?.matches || []).filter((m) => m.user !== me.user_id && Number(m.ts) * 1000 >= now() - days * 86400e3);
    const mentions = [];
    for (const m of matches) {
      const ids = [...String(m.text || "").matchAll(/<@([UW][A-Z0-9]+)>/g)].map((x) => x[1]);
      await Promise.all(ids.map((id) => nameOf(tok, id)));
      mentions.push({
        who: m.user ? await nameOf(tok, m.user) : m.username || "Someone",
        where: await placeOf(tok, m.channel),
        text: plainText(m.text, (id) => names.get(id)?.name || id),
        at: new Date(Number(m.ts) * 1000).toISOString(),
        link: m.permalink || "",
      });
    }
    const problems = {};
    let savedItems = null;
    if (saved) {
      try {
        const { items = [] } = await slackCall("stars.list", tok, { count: String(ROWS), limit: String(ROWS) }, fetchImpl);
        savedItems = [];
        for (const item of items.filter((i) => i.type === "message" && i.message)) {
          savedItems.push({
            who: item.message.user ? await nameOf(tok, item.message.user) : item.message.username || "",
            where: await placeOf(tok, item.channel),
            text: plainText(item.message.text, (id) => names.get(id)?.name || id),
            at: new Date(Number(item.message.ts) * 1000).toISOString(),
            link: item.message.permalink || "",
          });
        }
      } catch (e) {
        if (e.code === "auth") throw e;
        problems.saved = e.message;
      }
    }
    const unread = [];
    const missing = [];
    if (watch.length) {
      try {
        const ids = await channelIds(tok);
        for (const name of watch) {
          const id = ids.get(name);
          if (!id) { missing.push(name); continue; }
          unread.push({ channel: name, count: await unreadIn(tok, id), link: `${String(me.url || "https://app.slack.com/").replace(/\/?$/, "/")}archives/${id}` });
        }
      } catch (e) {
        if (e.code === "auth") throw e;
        problems.unread = e.message;
      }
    }
    const body = { fetchedAt: new Date(now()).toISOString(), me: { name: me.user || "", team: me.team || "", url: me.url || "" }, mentions, saved: savedItems, unread, missing, problems };
    cardCache = { at: now(), key, body };
    return body;
  }

  /**
   * Searches your Slack messages the way Slack's search box does ("from:@anna release", "in:#incidents after:2026-10-01"),
   * for Felix's AI: who said it, where, what, when, and a link. At most 30, newest first.
   * @param {string} query
   * @param {number} [count]
   * @returns {Promise<{ total: number, messages: Array<{ who: string, where: string, text: string, at: string, link: string }> }>}
   */
  async function search(query, count = 15) {
    const tok = await needToken();
    const found = await slackCall("search.messages", tok, { query: String(query), sort: "timestamp", sort_dir: "desc", count: String(Math.max(1, Math.min(30, Number(count) || 15))) }, fetchImpl);
    const messages = [];
    for (const m of found.messages?.matches || []) {
      const ids = [...String(m.text || "").matchAll(/<@([UW][A-Z0-9]+)>/g)].map((x) => x[1]);
      await Promise.all(ids.map((id) => nameOf(tok, id)));
      messages.push({
        who: m.user ? await nameOf(tok, m.user) : m.username || "Someone",
        where: await placeOf(tok, m.channel),
        text: plainText(m.text, (id) => names.get(id)?.name || id),
        at: new Date(Number(m.ts) * 1000).toISOString(),
        link: m.permalink || "",
      });
    }
    return { total: found.messages?.total ?? messages.length, messages };
  }

  return {
    card,
    search,
    connected: async () => Boolean(await token()),
    post: async (channel, text) => slackCall("chat.postMessage", await needToken(), { channel, text }, fetchImpl),
    presence: async (presence) => slackCall("users.setPresence", await needToken(), { presence }, fetchImpl),
    /**
     * Calls a Slack method that only reads ("conversations.history", "users.list"), for the tools Felix builds himself.
     * @param {string} method
     * @param {Record<string, string>} [fields]
     */
    read: async (method, fields = {}) => {
      if (!READ_METHOD.test(String(method))) throw codedError("slack", `Felix's own tools only read from Slack; ${method} isn't a read.`);
      return slackCall(String(method), await needToken(), Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, String(v)])), fetchImpl);
    },
    reset: () => { cached = null; cardCache = null; channelsCache = null; },
  };
}
