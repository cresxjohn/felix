import { test } from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_SERVICE, createBridge, eventsQuery } from "../google-bridge.mjs";

const URL_OK = "https://script.google.com/macros/s/AKfycbx1234567890abcdefghijklmnop/exec";
const URL_DOMAIN = "https://script.google.com/a/macros/purehomeriver.com/s/AKfycbx1234567890abcdefghijklmnop/exec";
const EVENTS = "https://www.googleapis.com/calendar/v3/calendars/primary/events?timeMin=2026-10-30T00%3A00%3A00Z&singleEvents=true";

/**
 * A bridge over an in-memory Keychain and a fake web app. `app` answers each call's JSON body with an object to
 * send back as JSON, or a string to send back as a page.
 * @param {{ app?: (body: any) => any, saved?: { url: string, key: string } }} [options]
 */
function setup({ app = () => ({ ok: true, felix: "calendar-bridge" }), saved } = {}) {
  const items = new Map();
  if (saved) items.set(`${BRIDGE_SERVICE}|${saved.url}`, saved.key);
  const calls = [];
  let n = 0;
  const secrets = {
    read: async (s, a) => items.get(`${s}|${a}`) ?? null,
    account: async (s) => [...items.keys()].find((k) => k.startsWith(`${s}|`))?.slice(s.length + 1) ?? null,
    write: async (s, a, v) => { items.set(`${s}|${a}`, v); },
    remove: async (s, a) => { items.delete(`${s}|${a}`); },
  };
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, body });
    const out = app(body);
    if (out instanceof Error) throw out;
    return { text: async () => (typeof out === "string" ? out : JSON.stringify(out)) };
  };
  const random = (size) => Buffer.alloc(size, ++n);
  const bridge = createBridge({ fetchImpl, secrets, random, now: () => 1000 });
  return { bridge, items, calls };
}

test("eventsQuery reads the calendar and query from an events address", () => {
  assert.deepEqual(eventsQuery(EVENTS), { calendar: "primary", params: { timeMin: "2026-10-30T00:00:00Z", singleEvents: "true" } });
  assert.equal(eventsQuery("https://x/calendars/c_a%40group.calendar.google.com/events").calendar, "c_a@group.calendar.google.com");
  assert.throws(() => eventsQuery("https://x/calendars/primary"), { code: "input" });
});

test("the script carries a fresh key, the same one until you connect", async () => {
  const { bridge } = setup();
  const a = await bridge.script();
  assert.match(a.code, /const KEY = "[\w-]{40,}";/);
  assert.doesNotMatch(a.code, /__FELIX_KEY__/);
  assert.match(a.manifest, /calendar\.events/);
  assert.equal((await bridge.script()).code, a.code);
});

test("connect checks the address, tries the bridge with the script's key, then saves it", async () => {
  const { bridge, items, calls } = setup();
  await assert.rejects(bridge.connect({ url: "https://example.com/exec" }), { code: "input" });
  await assert.rejects(bridge.connect({ url: URL_OK }), { code: "input", message: /Copy the script first/ });
  const { code } = await bridge.script();
  const key = code.match(/const KEY = "([\w-]+)"/)[1];
  assert.equal(await bridge.ready(), false);
  assert.deepEqual(await bridge.connect({ url: ` ${URL_DOMAIN} ` }), { ok: true });
  assert.deepEqual(calls.at(-1), { url: URL_DOMAIN, body: { key, action: "ping" } });
  assert.equal(items.get(`${BRIDGE_SERVICE}|${URL_DOMAIN}`), key);
  assert.equal(await bridge.ready(), true);
  // A new address replaces the old one, with the same key.
  await bridge.connect({ url: URL_OK });
  assert.deepEqual([...items.keys()], [`${BRIDGE_SERVICE}|${URL_OK}`]);
  await bridge.disconnect();
  assert.equal(await bridge.ready(), false);
  await bridge.disconnect();
});

test("connect refuses a web app that isn't the bridge", async () => {
  const { bridge, items } = setup({ app: () => ({ ok: true }) });
  await bridge.script();
  await assert.rejects(bridge.connect({ url: URL_OK }), { code: "input", message: /isn't Felix's calendar bridge/ });
  assert.equal(items.size, 0);
});

test("the bridge's answers become clear errors", async () => {
  const cases = [
    ["<html>Sign in</html>", "bridge-access", 403],
    [{ error: "key" }, "bridge-key", 401],
    [{ error: "calendar" }, "forbidden", 403],
    [{ error: "not-invited" }, "not-invited", 409],
    [{ error: "google", message: "Quota" }, "google", 502],
    [{ error: "google" }, "google", 502],
    [{ error: "bad-request" }, "input", 400],
    [new TypeError("fetch failed"), "network", 502],
  ];
  for (const [answer, code, status] of cases) {
    const { bridge } = setup({ app: () => answer, saved: { url: URL_OK, key: "k".repeat(43) } });
    await assert.rejects(bridge.get(EVENTS), { code, status });
  }
});

test("get lists events through the bridge, and needs it set up", async () => {
  await assert.rejects(setup().bridge.get(EVENTS), { code: "no-client", status: 409 });
  const { bridge, calls } = setup({ app: () => ({ items: [{ id: "e1" }] }), saved: { url: URL_OK, key: "secret-key" } });
  assert.deepEqual(await bridge.get(EVENTS), { items: [{ id: "e1" }] });
  assert.deepEqual(calls[0].body, { key: "secret-key", action: "events", calendar: "primary", params: { timeMin: "2026-10-30T00:00:00Z", singleEvents: "true" } });
});

test("rsvp sends your reply, and checks it first", async () => {
  const { bridge, calls } = setup({ app: (b) => ({ ok: true, response: b.response }), saved: { url: URL_OK, key: "secret-key" } });
  await assert.rejects(bridge.rsvp("bad id!", "accepted"), { code: "input" });
  await assert.rejects(bridge.rsvp("ev1", "maybe"), { code: "input" });
  assert.deepEqual(await bridge.rsvp("ev1_20261030", "tentative"), { ok: true, response: "tentative" });
  assert.deepEqual(calls[0].body, { key: "secret-key", action: "rsvp", eventId: "ev1_20261030", response: "tentative" });
  await assert.rejects(bridge.rsvp("ev1", "accepted", "x".repeat(501)), { code: "input" });
  await assert.rejects(setup().bridge.rsvp("ev1", "accepted"), { code: "no-bridge" });
});

test("a copied script's key expires after an hour", async () => {
  let t = 0;
  let n = 0;
  const bridge = createBridge({ now: () => t, random: (size) => Buffer.alloc(size, ++n), fetchImpl: async () => ({ text: async () => "{}" }),
    secrets: { read: async () => null, account: async () => null, write: async () => {}, remove: async () => {} } });
  const a = (await bridge.script()).code;
  t = 61 * 60e3;
  assert.notEqual((await bridge.script()).code, a);
});

test("a note goes with the reply, and an old script that drops it says so", async () => {
  const { bridge, calls } = setup({ app: (b) => ({ ok: true, response: b.response, comment: typeof b.comment === "string" }), saved: { url: URL_OK, key: "secret-key" } });
  assert.deepEqual(await bridge.rsvp("ev1", "declined", "  Out that day, sorry!  "), { ok: true, response: "declined" });
  assert.equal(calls[0].body.comment, "Out that day, sorry!");
  const old = setup({ app: (b) => ({ ok: true, response: b.response }), saved: { url: URL_OK, key: "secret-key" } });
  await assert.rejects(old.bridge.rsvp("ev1", "accepted", "See you there"), { code: "bridge-old", status: 409 });
  assert.deepEqual(await old.bridge.rsvp("ev1", "accepted"), { ok: true, response: "accepted" });
});

test("once a bridge is saved, copying the script again keeps its key", async () => {
  const { bridge } = setup({ saved: { url: URL_OK, key: "saved-key-123" } });
  assert.match((await bridge.script()).code, /const KEY = "saved-key-123";/);
  assert.deepEqual(await bridge.connect({ url: URL_OK }), { ok: true });
});

test("version asks the deployed script which version it is", async () => {
  assert.equal(await setup().bridge.version(), null);
  assert.equal(await setup({ app: () => ({ ok: true, felix: "calendar-bridge", version: 2 }), saved: { url: URL_OK, key: "k" } }).bridge.version(), 2);
  assert.equal(await setup({ app: () => ({ ok: true, felix: "calendar-bridge" }), saved: { url: URL_OK, key: "k" } }).bridge.version(), 1);
});
