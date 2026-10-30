/**
 * The Google Calendar bridge: a small Apps Script web app you deploy from your own Google account
 * (google-bridge/Code.gs), for when a Google Cloud project isn't allowed. Felix makes a random key, puts it in the
 * script you copy, and keeps it with the web app's address in the Keychain (service "cmd-center-google-bridge",
 * account = the address). The bridge reads your calendar and the vacation tracker, and sends your reply to an invite;
 * nothing else. It answers the same event shapes as Google's Calendar API, so the Calendar and Team out of office
 * cards read it through `get`, just as they read the API.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { codedError, deleteKeychain, readKeychain, readKeychainAccount, writeKeychain } from "./keychain.mjs";

export const BRIDGE_SERVICE = "cmd-center-google-bridge";
const HERE = path.dirname(fileURLToPath(import.meta.url));
const PENDING_MS = 60 * 60e3;
// A web app's address: script.google.com/macros/s/<id>/exec, or /a/macros/<domain>/s/<id>/exec for a Workspace account.
const WEB_APP = /^https:\/\/script\.google\.com\/(?:a\/macros\/[\w.-]+|macros)\/s\/[\w-]{20,200}\/exec$/;
export const REPLIES = ["accepted", "tentative", "declined"];

/**
 * An error the server answers with its status.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string, status: number }}
 */
const failure = (status, code, message) => Object.assign(codedError(code, message), { status });

/**
 * Reads a Calendar API events address into the bridge's terms: which calendar, and the query.
 * @param {string} url Like https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=…
 * @returns {{ calendar: string, params: Record<string, string> }}
 */
export function eventsQuery(url) {
  const u = new URL(url);
  const m = u.pathname.match(/\/calendars\/([^/]+)\/events$/);
  if (!m) throw failure(400, "input", "The calendar bridge only lists events.");
  return { calendar: decodeURIComponent(m[1]), params: Object.fromEntries(u.searchParams) };
}

/**
 * Creates the bridge.
 * @param {{ fetchImpl?: typeof fetch, now?: () => number, random?: typeof randomBytes, dir?: string,
 *   secrets?: { read: typeof readKeychain, account: typeof readKeychainAccount, write: typeof writeKeychain, remove: typeof deleteKeychain } }} [options]
 *   `dir` holds the script's files (google-bridge/).
 */
export function createBridge({ fetchImpl = fetch, now = Date.now, random = randomBytes, dir = path.join(HERE, "google-bridge"),
  secrets = { read: readKeychain, account: readKeychainAccount, write: writeKeychain, remove: deleteKeychain } } = {}) {
  let pending = null; // { key, at } made for the script you're copying, until you connect

  /**
   * The saved bridge, or null.
   * @returns {Promise<{ url: string, key: string } | null>}
   */
  async function saved() {
    const url = await secrets.account(BRIDGE_SERVICE);
    const key = url ? await secrets.read(BRIDGE_SERVICE, url) : null;
    return url && key ? { url, key } : null;
  }

  /** Whether the bridge is set up. */
  const ready = async () => Boolean(await saved());

  /**
   * Calls the bridge with an action.
   * @param {{ url: string, key: string }} bridge
   * @param {Record<string, unknown>} body
   * @returns {Promise<any>}
   */
  async function call({ url, key }, body) {
    let res;
    try {
      res = await fetchImpl(url, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ key, ...body }), redirect: "follow" });
    } catch {
      throw failure(502, "network", "Couldn't reach Google.");
    }
    const text = await res.text();
    let answer;
    try { answer = JSON.parse(text); } catch { answer = null; }
    if (!answer) {
      // A sign-in or "no access" page instead of JSON: the deployment isn't open to calls from this Mac.
      throw failure(403, "bridge-access", "Google answered with a page instead of the bridge. In Deploy → Manage deployments, set \"Who has access\" to Anyone, then try again.");
    }
    if (answer.error === "key") throw failure(401, "bridge-key", "The bridge didn't accept Felix's key. Copy the script again, paste it over the old one, and deploy a new version.");
    if (answer.error === "calendar") throw failure(403, "forbidden", "The bridge only reads your calendar, the vacation tracker and the Philippine holidays.");
    if (answer.error === "not-invited") throw failure(409, "not-invited", "You aren't a guest on that event, so there's nothing to reply to.");
    if (answer.error === "google") throw failure(502, "google", `Google said: ${answer.message || "something went wrong"}.`);
    if (answer.error) throw failure(400, "input", "The bridge didn't understand Felix's request. Copy the script again and deploy a new version.");
    return answer;
  }

  /**
   * The script and its settings file to paste into script.google.com, with Felix's key in it. The same key is kept
   * for an hour, so copying twice gives the same script.
   * @returns {Promise<{ code: string, manifest: string }>}
   */
  async function script() {
    // Once a bridge is saved, its key goes in again, so pasting an updated script keeps it working.
    const keep = (await saved())?.key;
    if (keep) pending = { key: keep, at: now() };
    else if (!pending || now() - pending.at > PENDING_MS) pending = { key: random(32).toString("base64url"), at: now() };
    const [code, manifest] = await Promise.all([readFile(path.join(dir, "Code.gs"), "utf8"), readFile(path.join(dir, "appsscript.json"), "utf8")]);
    return { code: code.replace("__FELIX_KEY__", pending.key), manifest };
  }

  /**
   * Tries the web app's address with the key from the copied script, and saves both only when it answers.
   * @param {{ url?: string }} fields
   * @returns {Promise<{ ok: true }>}
   */
  async function connect({ url = "" } = {}) {
    const address = String(url).trim();
    if (!WEB_APP.test(address)) throw failure(400, "input", "That isn't a web app address. It looks like https://script.google.com/macros/s/…/exec.");
    const key = pending?.key || (await saved())?.key;
    if (!key) throw failure(400, "input", "Copy the script first, so it has Felix's key.");
    const answer = await call({ url: address, key }, { action: "ping" });
    if (answer.felix !== "calendar-bridge") throw failure(400, "input", "That web app isn't Felix's calendar bridge.");
    const old = await secrets.account(BRIDGE_SERVICE);
    if (old && old !== address) await secrets.remove(BRIDGE_SERVICE, old);
    await secrets.write(BRIDGE_SERVICE, address, key);
    pending = null;
    return { ok: true };
  }

  /** Forgets the bridge (the web app keeps running until you archive it in Apps Script). */
  async function disconnect() {
    const old = await secrets.account(BRIDGE_SERVICE);
    if (old) await secrets.remove(BRIDGE_SERVICE, old);
  }

  /**
   * Lists events like the Calendar API's events address would.
   * @param {string} url
   * @returns {Promise<{ items: any[] }>}
   */
  async function get(url) {
    const bridge = await saved();
    if (!bridge) throw failure(409, "no-client", "Google isn't set up yet.");
    const { calendar, params } = eventsQuery(url);
    return call(bridge, { action: "events", calendar, params });
  }

  /**
   * Sends your reply to an invite on your calendar, with an optional note for the organizer.
   * @param {string} eventId
   * @param {string} response "accepted", "tentative" or "declined".
   * @param {string} [note] Up to 500 characters.
   * @returns {Promise<{ ok: true, response: string }>}
   * @throws {Error} "bridge-old" when the note was given but the deployed script is the first version, which drops it.
   */
  async function rsvp(eventId, response, note = "") {
    if (!/^[\w-]{1,1024}$/.test(String(eventId || ""))) throw failure(400, "input", "That isn't a calendar event.");
    if (!REPLIES.includes(response)) throw failure(400, "input", "Reply with accepted, tentative or declined.");
    const comment = String(note || "").trim();
    if (comment.length > 500) throw failure(400, "input", "Keep the note under 500 characters.");
    const bridge = await saved();
    if (!bridge) throw failure(409, "no-bridge", "Replying to invites needs the calendar bridge.");
    const answer = await call(bridge, { action: "rsvp", eventId, response, ...(comment ? { comment } : {}) });
    if (comment && !answer.comment) {
      throw failure(409, "bridge-old", "Your reply was sent, but not the note: your bridge script is the first version. Copy the script again from the Calendar setup, paste it over Code.gs, and deploy a new version.");
    }
    return { ok: true, response: answer.response };
  }

  /**
   * Which version of the script is deployed: 1 can't send a note with a reply; 2 can; 3 also reads the Philippine
   * holidays. Null when there's no bridge.
   * @returns {Promise<number | null>}
   */
  async function version() {
    const bridge = await saved();
    return bridge ? Number((await call(bridge, { action: "ping" })).version) || 1 : null;
  }

  return { ready, script, connect, disconnect, get, rsvp, version };
}
