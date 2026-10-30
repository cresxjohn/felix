/**
 * Felix's Google sign-ins, for the Calendar and Team out of office cards (the work account) and later the Personal
 * mode (the personal account). Each account uses a Google Cloud OAuth client of type "Desktop app" that you make
 * yourself; its client id and secret are saved in the Keychain from the card's Set up form. The sign-in runs in
 * the browser with PKCE and comes back to this Mac (127.0.0.1); the sign-in that lasts (the refresh token) is
 * kept in the Keychain, never on disk.
 */
import { createHash, randomBytes } from "node:crypto";
import { codedError, deleteKeychain, readKeychain, readKeychainAccount, writeKeychain } from "./keychain.mjs";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const PENDING_MS = 10 * 60e3;
const CLIENT_ID = /^[\w-]+\.apps\.googleusercontent\.com$/;
const CLIENT_SECRET = /^[\w-]{10,100}$/;

/** Each account's Keychain items and what it may do. */
export const ACCOUNTS = Object.freeze({
  work: {
    name: "work",
    client: "cmd-center-google-work-client",
    token: "cmd-center-google-work",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.events"],
  },
  // Your own Gmail, for the Personal mode's My day: read-only, it can't change anything.
  personal: {
    name: "personal",
    client: "cmd-center-google-personal-client",
    token: "cmd-center-google-personal",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/calendar.readonly"],
  },
});

/**
 * An error the server answers with its status.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string, status: number }}
 */
const failure = (status, code, message) => Object.assign(codedError(code, message), { status });

/**
 * The account for an id from a request.
 * @param {string} id
 * @returns {typeof ACCOUNTS.work}
 * @throws {Error} 400 for an unknown account.
 */
function accountFor(id) {
  if (!Object.hasOwn(ACCOUNTS, id)) throw failure(400, "input", `There is no Google account called "${id}".`);
  return ACCOUNTS[id];
}

/**
 * Creates the Google sign-ins.
 * @param {{ redirectBase: string, fetchImpl?: typeof fetch, now?: () => number, random?: typeof randomBytes,
 *   secrets?: { read: typeof readKeychain, account: typeof readKeychainAccount, write: typeof writeKeychain, remove: typeof deleteKeychain } }} options
 */
export function createGoogle({ redirectBase, fetchImpl = fetch, now = Date.now, random = randomBytes,
  secrets = { read: readKeychain, account: readKeychainAccount, write: writeKeychain, remove: deleteKeychain } }) {
  const pending = new Map();
  const tokens = new Map();
  const emails = new Map();
  const errors = new Map();

  const redirectUri = (id) => `${redirectBase}/api/google/callback/${id}`;

  /**
   * An account's OAuth client, as saved from the Set up form.
   * @param {string} id
   * @returns {Promise<{ id: string, secret: string } | null>}
   */
  async function client(id) {
    const a = accountFor(id);
    const [clientId, secret] = await Promise.all([secrets.account(a.client), secrets.read(a.client)]);
    return clientId && secret ? { id: clientId, secret } : null;
  }

  /**
   * Saves an account's OAuth client from the Set up form. A new client signs the account out.
   * @param {string} id
   * @param {{ clientId?: string, clientSecret?: string }} fields
   * @returns {Promise<void>}
   * @throws {Error} 400 when they don't look like a Google client.
   */
  async function saveClient(id, { clientId = "", clientSecret = "" }) {
    const a = accountFor(id);
    if (!CLIENT_ID.test(clientId)) throw failure(400, "input", "That doesn't look like a Google client ID. It ends in .apps.googleusercontent.com.");
    if (!CLIENT_SECRET.test(clientSecret)) throw failure(400, "input", "That doesn't look like a Google client secret.");
    const old = await secrets.account(a.client);
    if (old && old !== clientId) await secrets.remove(a.client, old);
    await secrets.write(a.client, clientId, clientSecret);
    await signOut(id);
  }

  /**
   * Signs an account out: the lasting sign-in leaves the Keychain. The OAuth client stays.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function signOut(id) {
    const a = accountFor(id);
    tokens.delete(id);
    emails.delete(id);
    await secrets.remove(a.token, "refresh-token");
  }

  /**
   * An account's state, for the cards: whether its OAuth client is saved, whether it's signed in and as whom, and
   * why the last sign-in failed.
   * @param {string} id
   * @returns {Promise<{ client: boolean, connected: boolean, email: string | null, error: string | null }>}
   */
  async function status(id) {
    const a = accountFor(id);
    const [c, refresh] = await Promise.all([client(id), secrets.read(a.token, "refresh-token")]);
    return { client: Boolean(c), connected: Boolean(c && refresh), email: emails.get(id) || null, error: errors.get(id) || null };
  }

  /**
   * The address that starts an account's sign-in, remembered for 10 minutes.
   * @param {string} id
   * @param {string} returnTo Where the popup's last page goes.
   * @returns {Promise<string>}
   * @throws {Error} 409 when the OAuth client isn't saved yet.
   */
  async function connectUrl(id, returnTo) {
    const a = accountFor(id);
    const c = await client(id);
    if (!c) throw failure(409, "no-client", "Save your Google app's client ID and secret first.");
    errors.delete(id);
    for (const [key, p] of pending) if (p.expires < now()) pending.delete(key);
    const verifier = random(32).toString("base64url");
    const state = random(16).toString("base64url");
    pending.set(state, { id, verifier, returnTo, expires: now() + PENDING_MS });
    const params = new URLSearchParams({
      client_id: c.id, response_type: "code", redirect_uri: redirectUri(id), scope: a.scopes.join(" "), state,
      access_type: "offline", prompt: "consent", include_granted_scopes: "true",
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    return `${AUTHORIZE}?${params}`;
  }

  /**
   * Asks Google for tokens, and keeps them.
   * @param {string} id
   * @param {Record<string, string>} form
   * @returns {Promise<string>} The access token.
   * @throws {Error} "expired" when the sign-in is no longer good.
   */
  async function requestTokens(id, form) {
    const a = accountFor(id);
    const c = await client(id);
    if (!c) throw failure(409, "no-client", "Save your Google app's client ID and secret first.");
    const body = new URLSearchParams({ ...form, client_id: c.id, client_secret: c.secret });
    const res = await fetchImpl(TOKEN, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (form.grant_type === "refresh_token") await signOut(id);
      throw failure(401, "expired", `Google didn't accept the sign-in (${answer.error_description || answer.error || res.status}). Sign in again.`);
    }
    if (answer.refresh_token) await secrets.write(a.token, "refresh-token", answer.refresh_token);
    tokens.set(id, { access: answer.access_token, expires: now() + (answer.expires_in ?? 3600) * 1000 });
    return answer.access_token;
  }

  /**
   * Finishes a sign-in from Google's redirect. Why it failed shows in the account's status until the next try.
   * @param {string} id
   * @param {{ code?: string | null, state?: string | null, error?: string | null }} query
   * @returns {Promise<string>} Where the popup goes next.
   * @throws {Error & { returnTo?: string }} When it was refused, cancelled or too old.
   */
  async function finish(id, { code, state, error }) {
    accountFor(id);
    const p = pending.get(String(state));
    pending.delete(String(state));
    try {
      if (!p || p.id !== id || p.expires < now()) throw failure(400, "stale", "That Google sign-in took too long. Click Sign in again.");
      if (error === "access_denied" && code == null) throw failure(400, "denied", "The Google sign-in was cancelled, or your organization doesn't allow this app yet.");
      if (error || !code) throw failure(400, "denied", `Google said no (${error || "no code"}).`);
      await requestTokens(id, { grant_type: "authorization_code", code, redirect_uri: redirectUri(id), code_verifier: p.verifier });
      emails.delete(id);
      return p.returnTo;
    } catch (e) {
      errors.set(id, e.message);
      throw Object.assign(e, { returnTo: p?.returnTo });
    }
  }

  /**
   * A current access token, renewed from the saved sign-in when needed.
   * @param {string} id
   * @returns {Promise<string>}
   * @throws {Error} "no-client" or "not-connected" when it isn't set up or signed in.
   */
  async function accessToken(id) {
    const a = accountFor(id);
    const t = tokens.get(id);
    if (t && t.expires - 60e3 > now()) return t.access;
    if (!(await client(id))) throw failure(409, "no-client", "Google isn't set up yet.");
    const refresh = await secrets.read(a.token, "refresh-token");
    if (!refresh) throw failure(409, "not-connected", "Google isn't signed in yet.");
    return requestTokens(id, { grant_type: "refresh_token", refresh_token: refresh });
  }

  /**
   * Reads a Google API address as the account, and gives back its JSON.
   * @param {string} id
   * @param {string} url
   * @returns {Promise<any>}
   */
  async function get(id, url) {
    let res;
    try {
      res = await fetchImpl(url, { headers: { Authorization: `Bearer ${await accessToken(id)}`, Accept: "application/json" } });
    } catch (e) {
      if (e.code) throw e;
      throw failure(502, "network", "Couldn't reach Google.");
    }
    if (res.status === 401) {
      tokens.delete(id);
      throw failure(401, "expired", "Google's sign-in expired. Sign in again.");
    }
    if (res.status === 403) throw failure(403, "forbidden", "Google said this account can't read that calendar.");
    if (res.status === 404) throw failure(404, "not-found", "Google couldn't find that calendar.");
    if (!res.ok) throw failure(502, "http", `Google answered ${res.status}.`);
    return res.json();
  }

  /**
   * The signed-in account's email, asked for once.
   * @param {string} id
   * @returns {Promise<string | null>}
   */
  async function email(id) {
    if (emails.has(id)) return emails.get(id);
    const me = await get(id, USERINFO).catch(() => null);
    emails.set(id, me?.email || null);
    return me?.email || null;
  }

  return { status, saveClient, signOut, connectUrl, finish, get, email };
}
