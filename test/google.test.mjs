import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { ACCOUNTS, createGoogle } from "../google.mjs";

const NOW = Date.parse("2026-10-30T01:00:00Z");
const MIN = 60e3;
const BASE = "http://127.0.0.1:4777";
const CLIENT_ID = "123-abc.apps.googleusercontent.com";
const CLIENT_SECRET = "GOCSPX-secret_123";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

/**
 * Google sign-ins over an in-memory Keychain, a clock and a fake Google.
 * @param {{ client?: boolean, refresh?: string | null, token?: Function, api?: Function }} [options]
 *   `token` answers the token endpoint with the form it was sent; `api` answers every other address.
 */
function setup({ client = true, refresh = null, token, api } = {}) {
  const items = new Map(); // "service|account" -> secret
  const clock = { t: NOW };
  const calls = [];
  let n = 0;
  const secrets = {
    read: async (s, a) => {
      const key = [...items.keys()].find((k) => k.startsWith(`${s}|`) && (!a || k === `${s}|${a}`));
      return key ? items.get(key) : null;
    },
    account: async (s) => [...items.keys()].find((k) => k.startsWith(`${s}|`))?.split("|")[1] || null,
    write: async (s, a, v) => { items.set(`${s}|${a}`, v); },
    remove: async (s, a) => { items.delete(`${s}|${a}`); },
  };
  if (client) items.set(`${ACCOUNTS.work.client}|${CLIENT_ID}`, CLIENT_SECRET);
  if (refresh) items.set(`${ACCOUNTS.work.token}|refresh-token`, refresh);
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      const form = Object.fromEntries(new URLSearchParams(String(init.body)));
      return (token || (() => reply(200, { access_token: `access-${calls.length}`, expires_in: 3600 })))(form);
    }
    return (api || (() => reply(200, { ok: true })))(url, init);
  };
  const google = createGoogle({ redirectBase: BASE, fetchImpl, now: () => clock.t, random: (size) => Buffer.alloc(size, ++n), secrets });
  return { google, items, clock, calls };
}

const refreshSaved = (items) => items.get(`${ACCOUNTS.work.token}|refresh-token`) || null;

test("saveClient checks the client id and secret before saving", async () => {
  const { google, items } = setup({ client: false });
  await assert.rejects(google.saveClient("work", { clientId: "nope", clientSecret: CLIENT_SECRET }), { status: 400, code: "input", message: /googleusercontent/ });
  await assert.rejects(google.saveClient("work", { clientId: CLIENT_ID, clientSecret: "short" }), { status: 400, code: "input", message: /secret/ });
  await assert.rejects(google.saveClient("work", {}), { code: "input" });
  assert.equal(items.size, 0);
  await google.saveClient("work", { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET });
  assert.equal(items.get(`${ACCOUNTS.work.client}|${CLIENT_ID}`), CLIENT_SECRET);
});

test("a new client replaces the old one and signs the account out", async () => {
  const { google, items } = setup({ refresh: "r1" });
  await google.saveClient("work", { clientId: CLIENT_ID, clientSecret: "GOCSPX-newer_456" });
  assert.equal(items.get(`${ACCOUNTS.work.client}|${CLIENT_ID}`), "GOCSPX-newer_456");
  assert.equal(refreshSaved(items), null);
  await google.saveClient("work", { clientId: "999-new.apps.googleusercontent.com", clientSecret: CLIENT_SECRET });
  assert.deepEqual([...items.keys()], [`${ACCOUNTS.work.client}|999-new.apps.googleusercontent.com`]);
});

test("status says whether the client is saved and the account signed in", async () => {
  assert.deepEqual(await setup({ client: false }).google.status("work"), { client: false, connected: false, email: null, error: null });
  assert.deepEqual(await setup({ client: false, refresh: "r1" }).google.status("work"), { client: false, connected: false, email: null, error: null });
  assert.deepEqual(await setup().google.status("work"), { client: true, connected: false, email: null, error: null });
  assert.deepEqual(await setup({ refresh: "r1" }).google.status("work"), { client: true, connected: true, email: null, error: null });
});

test("an unknown account is a 400 everywhere", async () => {
  const { google } = setup();
  for (const id of ["home", "toString", "__proto__"]) {
    await assert.rejects(google.status(id), { status: 400, code: "input" }, id);
    await assert.rejects(google.connectUrl(id, "/"), { status: 400 }, id);
    await assert.rejects(google.finish(id, {}), { status: 400 }, id);
    await assert.rejects(google.saveClient(id, {}), { status: 400 }, id);
    await assert.rejects(google.signOut(id), { status: 400 }, id);
    await assert.rejects(google.get(id, EVENTS), { status: 400 }, id);
  }
});

test("connectUrl needs a saved client", async () => {
  await assert.rejects(setup({ client: false }).google.connectUrl("work", "/"), { status: 409, code: "no-client" });
});

test("connectUrl builds Google's sign-in address with PKCE", async () => {
  const { google } = setup();
  const url = new URL(await google.connectUrl("work", "/after"));
  assert.equal(`${url.origin}${url.pathname}`, "https://accounts.google.com/o/oauth2/v2/auth");
  const q = Object.fromEntries(url.searchParams);
  const verifier = Buffer.alloc(32, 1).toString("base64url");
  assert.deepEqual(q, {
    client_id: CLIENT_ID, response_type: "code", redirect_uri: `${BASE}/api/google/callback/work`,
    scope: ACCOUNTS.work.scopes.join(" "), state: Buffer.alloc(16, 2).toString("base64url"),
    access_type: "offline", prompt: "consent", include_granted_scopes: "true",
    code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
  });
});

test("finish swaps the code for tokens, keeps the refresh token and goes back where the popup started", async () => {
  const forms = [];
  const { google, items, calls } = setup({
    token: (form) => { forms.push(form); return reply(200, { access_token: "acc-1", refresh_token: "ref-1", expires_in: 3600 }); },
    api: (url) => (url === USERINFO ? reply(200, { email: "me@pure.co" }) : reply(200, { items: [] })),
  });
  const state = new URL(await google.connectUrl("work", "/after")).searchParams.get("state");
  assert.equal(await google.finish("work", { code: "code-1", state }), "/after");
  assert.deepEqual(forms, [{
    grant_type: "authorization_code", code: "code-1", redirect_uri: `${BASE}/api/google/callback/work`,
    code_verifier: Buffer.alloc(32, 1).toString("base64url"), client_id: CLIENT_ID, client_secret: CLIENT_SECRET,
  }]);
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(refreshSaved(items), "ref-1");
  assert.deepEqual(await google.get("work", EVENTS), { items: [] });
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer acc-1");
  assert.equal(await google.email("work"), "me@pure.co");
  assert.deepEqual(await google.status("work"), { client: true, connected: true, email: "me@pure.co", error: null });
  // The state is used up.
  await assert.rejects(google.finish("work", { code: "code-1", state }), { code: "stale" });
});

test("finish turns away an unknown or old state, and the reason shows in status", async () => {
  const { google, clock } = setup();
  await assert.rejects(google.finish("work", { code: "c", state: "made-up" }), (e) => e.code === "stale" && e.status === 400 && e.returnTo === undefined);
  assert.match((await google.status("work")).error, /took too long/);
  const state = new URL(await google.connectUrl("work", "/back")).searchParams.get("state");
  assert.equal((await google.status("work")).error, null); // a new try clears it
  clock.t += 11 * MIN;
  await assert.rejects(google.finish("work", { code: "c", state }), (e) => e.code === "stale" && e.returnTo === "/back");
});

test("an old pending sign-in is forgotten when the next one starts", async () => {
  const { google, clock } = setup();
  const old = new URL(await google.connectUrl("work", "/one")).searchParams.get("state");
  clock.t += 11 * MIN;
  await google.connectUrl("work", "/two");
  clock.t -= 11 * MIN; // even back in its time, it's gone
  await assert.rejects(google.finish("work", { code: "c", state: old }), { code: "stale" });
});

test("finish explains a cancelled or refused sign-in", async () => {
  const { google } = setup();
  const start = async () => new URL(await google.connectUrl("work", "/back")).searchParams.get("state");
  await assert.rejects(google.finish("work", { error: "access_denied", state: await start() }), { code: "denied", message: /cancelled/ });
  await assert.rejects(google.finish("work", { error: "server_error", code: null, state: await start() }), { code: "denied", message: /server_error/ });
  await assert.rejects(google.finish("work", { state: await start() }), { code: "denied", message: /no code/ });
  assert.match((await google.status("work")).error, /no code/);
});

test("finish keeps Google's reason when the code is refused, and doesn't sign out", async () => {
  const { google, items } = setup({ refresh: "keep-me", token: () => reply(400, { error: "invalid_grant", error_description: "Bad Request" }) });
  const state = new URL(await google.connectUrl("work", "/back")).searchParams.get("state");
  await assert.rejects(google.finish("work", { code: "c", state }), (e) => e.code === "expired" && e.status === 401 && /Bad Request/.test(e.message) && e.returnTo === "/back");
  assert.match((await google.status("work")).error, /Bad Request/);
  assert.equal(refreshSaved(items), "keep-me");
});

test("finish copes with a token answer that isn't JSON", async () => {
  const { google } = setup({ token: () => ({ status: 500, ok: false, json: async () => { throw new SyntaxError("bad"); } }) });
  const state = new URL(await google.connectUrl("work", "/back")).searchParams.get("state");
  await assert.rejects(google.finish("work", { code: "c", state }), { message: /\(500\)/ });
});

test("finish says no client when it was removed during the sign-in", async () => {
  const { google, items } = setup();
  const state = new URL(await google.connectUrl("work", "/back")).searchParams.get("state");
  items.clear();
  await assert.rejects(google.finish("work", { code: "c", state }), { status: 409, code: "no-client" });
});

test("get renews the access token from the saved sign-in, and keeps it until a minute before it ends", async () => {
  const forms = [];
  const { google, clock, calls } = setup({
    refresh: "ref-1",
    token: (form) => { forms.push(form); return reply(200, { access_token: `acc-${forms.length}` }); },
  });
  await google.get("work", EVENTS);
  assert.deepEqual(forms[0], { grant_type: "refresh_token", refresh_token: "ref-1", client_id: CLIENT_ID, client_secret: CLIENT_SECRET });
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer acc-1");
  assert.equal(calls.at(-1).init.headers.Accept, "application/json");
  clock.t += 58 * MIN;
  await google.get("work", EVENTS);
  assert.equal(forms.length, 1);
  clock.t += 2 * MIN; // expires_in defaults to an hour
  await google.get("work", EVENTS);
  assert.equal(forms.length, 2);
  assert.equal(calls.at(-1).init.headers.Authorization, "Bearer acc-2");
});

test("a refused renewal signs the account out", async () => {
  const { google, items } = setup({ refresh: "ref-1", token: () => reply(400, { error: "invalid_grant" }) });
  await assert.rejects(google.get("work", EVENTS), { status: 401, code: "expired", message: /invalid_grant/ });
  assert.equal(refreshSaved(items), null);
  await assert.rejects(google.get("work", EVENTS), { status: 409, code: "not-connected" });
});

test("get needs a client and a sign-in", async () => {
  await assert.rejects(setup({ client: false, refresh: "r" }).google.get("work", EVENTS), { status: 409, code: "no-client" });
  await assert.rejects(setup().google.get("work", EVENTS), { status: 409, code: "not-connected" });
});

test("get turns Google's answers into coded errors", async () => {
  const cases = [[401, 401, "expired"], [403, 403, "forbidden"], [404, 404, "not-found"], [500, 502, "http"]];
  for (const [answer, status, code] of cases) {
    const { google } = setup({ refresh: "r", api: () => reply(answer, {}) });
    await assert.rejects(google.get("work", EVENTS), { status, code }, String(answer));
  }
  const down = setup({ refresh: "r", api: () => { throw new TypeError("fetch failed"); } });
  await assert.rejects(down.google.get("work", EVENTS), { status: 502, code: "network" });
});

test("a 401 from the API forgets the access token so the next call renews it", async () => {
  let api = 401;
  const forms = [];
  const { google } = setup({ refresh: "r", api: () => reply(api, {}), token: (f) => { forms.push(f); return reply(200, { access_token: "a" }); } });
  await assert.rejects(google.get("work", EVENTS), { code: "expired" });
  api = 200;
  await google.get("work", EVENTS);
  assert.equal(forms.length, 2);
});

test("email is asked for once, and is null when Google won't say", async () => {
  let asked = 0;
  const { google } = setup({ refresh: "r", api: (url) => { if (url === USERINFO) asked += 1; return reply(200, {}); } });
  assert.equal(await google.email("work"), null);
  assert.equal(await google.email("work"), null);
  assert.equal(asked, 1);
  const off = setup();
  assert.equal(await off.google.email("work"), null);
});

test("signOut forgets the sign-in and the email but keeps the client", async () => {
  const { google, items } = setup({ refresh: "r", api: () => reply(200, { email: "me@pure.co" }) });
  assert.equal(await google.email("work"), "me@pure.co");
  await google.signOut("work");
  assert.equal(refreshSaved(items), null);
  assert.deepEqual(await google.status("work"), { client: true, connected: false, email: null, error: null });
});
