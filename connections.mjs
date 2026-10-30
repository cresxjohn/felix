/**
 * Connecting a card's service from the card itself: the card's Set up form sends what the service needs, Felix
 * tries it first, and only a working token or key is saved, straight to the Keychain. Disconnecting removes it.
 * Each service's other choices (like the Jira board) are kept in data/connections.json, never a secret.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { codedError, deleteKeychain, readKeychainAccount, writeKeychain } from "./keychain.mjs";

const EMAIL = /^[^\s@"]+@[^\s@"]+\.[^\s@"]+$/;
const TOKEN = /^[\w.~+/=:-]{8,400}$/;
// A Slack user token, which posts as you: xoxp-, or xoxe.xoxp- when the app rotates its tokens.
const SLACK_TOKEN = /^(xoxe\.)?xoxp-[\w-]{8,400}$/;

/**
 * @typedef {{ check: (fields: Record<string, string>) => Promise<{ name?: string }>, save: (fields: Record<string, string>) => Promise<void>,
 *   remove: () => Promise<void>, reset?: () => void }} Service
 */

/**
 * Creates the connector.
 * @param {{ dir: string, jira: { check: Function, reset: Function, service: string, board?: () => Promise<number>, setBoard?: (board: number) => Promise<unknown> },
 *   datadog: { check: Function, reset?: Function, service: string },
 *   slack?: { check: Function, reset?: Function, service: string, account: string },
 *   keychain?: { write: typeof writeKeychain, remove: typeof deleteKeychain, account: typeof readKeychainAccount } }} options
 *   `dir` is Felix's data folder. `check` tries a service's credentials and throws a coded error when they fail.
 *   Jira's `board` and `setBoard` read and save the board number in Felix's settings; without them it lives in
 *   connections.json.
 */
export function createConnections({ dir, jira, datadog, slack, keychain = { write: writeKeychain, remove: deleteKeychain, account: readKeychainAccount } }) {
  const file = path.join(dir, "connections.json");

  /**
   * Felix's saved choices for each service (no secrets).
   * @returns {Promise<Record<string, Record<string, unknown>>>}
   */
  async function choices() {
    try { return JSON.parse(await readFile(file, "utf8")); } catch { return {}; }
  }

  /**
   * Saves one service's choices.
   * @param {string} id
   * @param {Record<string, unknown>} value
   */
  async function saveChoices(id, value) {
    const all = await choices();
    await mkdir(dir, { recursive: true });
    await writeFile(file, `${JSON.stringify({ ...all, [id]: value }, null, 2)}\n`);
  }

  /** @type {Record<string, Service>} */
  const services = {
    jira: {
      async check({ email, token }) {
        if (!EMAIL.test(email || "")) throw codedError("input", "That doesn't look like an email address.");
        if (!TOKEN.test(token || "")) throw codedError("input", "That doesn't look like a Jira API token.");
        return jira.check({ email, token });
      },
      async save({ email, token, board }) {
        const old = await keychain.account(jira.service);
        if (old && old !== email) await keychain.remove(jira.service, old);
        await keychain.write(jira.service, email, token);
        const number = Number(board) > 0 ? Math.floor(Number(board)) : 181;
        await (jira.setBoard ? jira.setBoard(number) : saveChoices("jira", { board: number }));
        jira.reset();
      },
      async remove() {
        const old = await keychain.account(jira.service);
        if (old) await keychain.remove(jira.service, old);
        jira.reset();
      },
    },
    datadog: {
      async check({ token }) {
        if (!TOKEN.test(token || "")) throw codedError("input", "That doesn't look like a Datadog access token.");
        return datadog.check({ token });
      },
      async save({ token }) {
        await keychain.write(datadog.service, "datadog", token);
        datadog.reset?.();
      },
      async remove() {
        await keychain.remove(datadog.service, "datadog");
        datadog.reset?.();
      },
    },
  };
  // Slack posts as you (Start my day), so only a user token is taken, tried with Slack's auth.test first.
  if (slack) {
    services.slack = {
      async check({ token }) {
        if (!SLACK_TOKEN.test(token || "")) throw codedError("input", "That doesn't look like a Slack user token. It starts with xoxp-.");
        return slack.check({ token });
      },
      async save({ token }) {
        await keychain.write(slack.service, slack.account, token);
        slack.reset?.();
      },
      async remove() {
        await keychain.remove(slack.service, slack.account);
        slack.reset?.();
      },
    };
  }

  /**
   * The service by its id.
   * @param {string} id
   * @returns {Service}
   */
  function service(id) {
    const s = Object.hasOwn(services, id) ? services[id] : null;
    if (!s) throw codedError("input", "Felix doesn't know that service.");
    return s;
  }

  /**
   * Tries the details, and saves them only when they work.
   * @param {string} id
   * @param {Record<string, unknown>} fields
   * @returns {Promise<{ ok: true, name?: string }>}
   */
  async function connect(id, fields) {
    const s = service(id);
    const clean = Object.fromEntries(Object.entries(fields || {}).map(([k, v]) => [k, String(v ?? "").trim()]));
    const who = await s.check(clean);
    await s.save(clean);
    return { ok: true, ...(who?.name ? { name: who.name } : {}) };
  }

  /**
   * Signs a service out: its secret leaves the Keychain.
   * @param {string} id
   * @returns {Promise<{ ok: true }>}
   */
  async function disconnect(id) {
    await service(id).remove();
    return { ok: true };
  }

  /**
   * Which services are connected, for Settings: Jira's email and board, and whether Datadog and Slack have a token.
   * Only names are read from the Keychain, never a secret.
   * @returns {Promise<{ jira: { connected: boolean, who: string | null, board: number | null }, datadog: { connected: boolean },
   *   slack?: { connected: boolean } }>}
   */
  async function status() {
    const [email, dd, sl, saved] = await Promise.all([
      keychain.account(jira.service), keychain.account(datadog.service), slack ? keychain.account(slack.service) : null, choices(),
    ]);
    return {
      jira: { connected: Boolean(email), who: email || null, board: email ? ((jira.board ? await jira.board() : saved.jira?.board) ?? 181) : null },
      datadog: { connected: Boolean(dd) },
      ...(slack ? { slack: { connected: Boolean(sl) } } : {}),
    };
  }

  return { connect, disconnect, choices, status };
}
