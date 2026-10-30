import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createConnections } from "../connections.mjs";

/**
 * A connector over a temp folder, with fake service checks and a fake Keychain.
 * @param {string} dir
 * @param {{ fail?: string, slack?: boolean }} [options] `fail` names a service whose check throws.
 */
function connector(dir, { fail = "", slack = true, wais = false } = {}) {
  const keychain = new Map(); // "service|account" -> secret
  const log = [];
  const service = (id) => ({
    service: `svc-${id}`,
    account: `${id}-user`,
    check: async (fields) => {
      log.push(["check", id, fields]);
      if (fail === id) throw Object.assign(new Error(`${id} said no`), { code: "auth" });
      return id === "datadog" ? {} : { name: `${id} person` };
    },
    reset: () => log.push(["reset", id]),
  });
  const datadog = service("datadog");
  const c = createConnections({
    dir,
    jira: service("jira"),
    datadog,
    ...(slack ? { slack: service("slack") } : {}),
    ...(wais ? { wais: service("wais") } : {}),
    keychain: {
      write: async (s, a, secret) => { keychain.set(`${s}|${a}`, secret); },
      remove: async (s, a) => { log.push(["remove", s, a]); keychain.delete(`${s}|${a}`); },
      account: async (s) => [...keychain.keys()].find((k) => k.startsWith(`${s}|`))?.split("|")[1] || null,
    },
  });
  return { c, keychain, log, datadog };
}

/** Runs a test body with a fresh temp folder. */
async function inTemp(fn) {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-connections-"));
  try { await fn(dir); } finally { await rm(dir, { recursive: true, force: true }); }
}

test("connect checks the fields before trying the service", () => inTemp(async (dir) => {
  const { c, log } = connector(dir);
  await assert.rejects(c.connect("jira", { email: "not an email", token: "abcdefgh12" }), { code: "input", message: /email/ });
  await assert.rejects(c.connect("jira", { email: "me@pure.co", token: "short" }), { code: "input", message: /Jira API token/ });
  await assert.rejects(c.connect("jira", { email: "me@pure.co" }), { code: "input" });
  await assert.rejects(c.connect("jira", null), { code: "input" });
  await assert.rejects(c.connect("datadog", { token: "has spaces in it" }), { code: "input", message: /Datadog/ });
  await assert.rejects(c.connect("slack", { token: "xoxb-1234567890" }), { code: "input", message: /xoxp-/ });
  assert.deepEqual(log, []);
}));

test("nothing is saved when the service refuses the details", () => inTemp(async (dir) => {
  const { c, keychain } = connector(dir, { fail: "jira" });
  await assert.rejects(c.connect("jira", { email: "me@pure.co", token: "abcdefgh12" }), { code: "auth" });
  assert.equal(keychain.size, 0);
  assert.deepEqual(await c.choices(), {});
}));

test("connecting Jira saves the token under the email and the board in connections.json", () => inTemp(async (dir) => {
  const { c, keychain, log } = connector(dir);
  assert.deepEqual(await c.connect("jira", { email: "  me@pure.co ", token: "abcdefgh12", board: 42.9 }), { ok: true, name: "jira person" });
  assert.deepEqual(log.find((l) => l[0] === "check"), ["check", "jira", { email: "me@pure.co", token: "abcdefgh12" }]);
  assert.equal(keychain.get("svc-jira|me@pure.co"), "abcdefgh12");
  assert.deepEqual(JSON.parse(await readFile(path.join(dir, "connections.json"), "utf8")), { jira: { board: 42 } });
  assert.ok(log.some((l) => l[0] === "reset" && l[1] === "jira"));
  await c.connect("jira", { email: "me@pure.co", token: "abcdefgh34", board: "nope" });
  assert.deepEqual(await c.choices(), { jira: { board: 181 } });
  assert.ok(!log.some((l) => l[0] === "remove"));
}));

test("a new Jira email removes the old one's token", () => inTemp(async (dir) => {
  const { c, keychain, log } = connector(dir);
  await c.connect("jira", { email: "old@pure.co", token: "abcdefgh12" });
  await c.connect("jira", { email: "new@pure.co", token: "abcdefgh34" });
  assert.deepEqual([...keychain.keys()], ["svc-jira|new@pure.co"]);
  assert.deepEqual(log.filter((l) => l[0] === "remove"), [["remove", "svc-jira", "old@pure.co"]]);
}));

test("choices keep other services' entries and start empty from a bad file", () => inTemp(async (dir) => {
  await writeFile(path.join(dir, "connections.json"), "{ not json");
  const { c } = connector(dir);
  assert.deepEqual(await c.choices(), {});
  await writeFile(path.join(dir, "connections.json"), JSON.stringify({ other: { x: 1 } }));
  await c.connect("jira", { email: "me@pure.co", token: "abcdefgh12", board: "7" });
  assert.deepEqual(await c.choices(), { other: { x: 1 }, jira: { board: 7 } });
}));

test("the data folder is made when it isn't there yet", () => inTemp(async (dir) => {
  const nested = path.join(dir, "a", "b");
  const { c } = connector(nested);
  await c.connect("jira", { email: "me@pure.co", token: "abcdefgh12" });
  assert.deepEqual(await c.choices(), { jira: { board: 181 } });
}));

test("Datadog saves and removes its token, with or without a reset", () => inTemp(async (dir) => {
  const { c, keychain, log, datadog } = connector(dir);
  assert.deepEqual(await c.connect("datadog", { token: "dd-token-123" }), { ok: true });
  assert.equal(keychain.get("svc-datadog|datadog"), "dd-token-123");
  assert.deepEqual(await c.disconnect("datadog"), { ok: true });
  assert.equal(keychain.size, 0);
  assert.equal(log.filter((l) => l[0] === "reset" && l[1] === "datadog").length, 2);
  delete datadog.reset;
  await c.connect("datadog", { token: "dd-token-456" });
  await c.disconnect("datadog");
  assert.equal(keychain.size, 0);
}));

test("Slack saves a user token under its account and removes it", () => inTemp(async (dir) => {
  const { c, keychain } = connector(dir);
  assert.deepEqual(await c.connect("slack", { token: "xoxe.xoxp-1-abcdefgh" }), { ok: true, name: "slack person" });
  assert.equal(keychain.get("svc-slack|slack-user"), "xoxe.xoxp-1-abcdefgh");
  await c.disconnect("slack");
  assert.equal(keychain.size, 0);
}));

test("Slack is unknown when it isn't given, and so is any other name", () => inTemp(async (dir) => {
  const { c } = connector(dir, { slack: false });
  for (const id of ["slack", "github", "toString", "__proto__"]) {
    await assert.rejects(c.connect(id, { token: "xoxp-12345678" }), { code: "input", message: /service/ }, id);
    await assert.rejects(c.disconnect(id), { code: "input" }, id);
  }
}));

test("disconnecting Jira removes the saved token, and is fine when there's none", () => inTemp(async (dir) => {
  const { c, keychain, log } = connector(dir);
  await c.connect("jira", { email: "me@pure.co", token: "abcdefgh12" });
  assert.deepEqual(await c.disconnect("jira"), { ok: true });
  assert.equal(keychain.size, 0);
  const removes = log.filter((l) => l[0] === "remove").length;
  await c.disconnect("jira");
  assert.equal(log.filter((l) => l[0] === "remove").length, removes);
  assert.equal(log.filter((l) => l[0] === "reset" && l[1] === "jira").length, 3);
}));

test("status says which services are connected, with Jira's email and board, and no secrets", () => inTemp(async (dir) => {
  const { c } = connector(dir);
  assert.deepEqual(await c.status(), { jira: { connected: false, who: null, board: null }, datadog: { connected: false }, slack: { connected: false } });
  await c.connect("jira", { email: "cres@example.com", token: "token-123456", board: "42" });
  await c.connect("datadog", { token: "dd-token-123456" });
  const s = await c.status();
  assert.deepEqual(s, { jira: { connected: true, who: "cres@example.com", board: 42 }, datadog: { connected: true }, slack: { connected: false } });
  assert.doesNotMatch(JSON.stringify(s), /token-123456/);
  assert.equal("slack" in (await connector(dir, { slack: false }).c.status()), false);
}));

test("with board and setBoard, the Jira board is read from and saved to Felix's settings, not connections.json", () => inTemp(async (dir) => {
  const saved = { board: 181 };
  const keychain = new Map();
  const c = createConnections({
    dir,
    jira: {
      service: "svc-jira", check: async () => ({ name: "Cres" }), reset: () => {},
      board: async () => saved.board, setBoard: async (n) => { saved.board = n; },
    },
    datadog: { service: "svc-dd", check: async () => ({}) },
    keychain: {
      write: async (s, a, secret) => { keychain.set(`${s}|${a}`, secret); },
      remove: async () => {},
      account: async (s) => [...keychain.keys()].find((k) => k.startsWith(`${s}|`))?.split("|")[1] || null,
    },
  });
  await c.connect("jira", { email: "cres@example.com", token: "token-123456", board: "42" });
  assert.equal(saved.board, 42);
  assert.deepEqual(await c.choices(), {});
  assert.equal((await c.status()).jira.board, 42);
  saved.board = undefined;
  assert.equal((await c.status()).jira.board, 181);
}));

test("Wais is tried with its own check, then its token is saved under its account, and status shows it", () => inTemp(async (dir) => {
  const { c, keychain, log } = connector(dir, { wais: true });
  const token = `wais_pat_${"ab".repeat(24)}`;
  assert.deepEqual(await c.connect("wais", { token: `  ${token} ` }), { ok: true, name: "wais person" });
  assert.deepEqual(log.find((l) => l[0] === "check" && l[1] === "wais"), ["check", "wais", { token }], "the check sees the token, trimmed");
  assert.equal(keychain.get("svc-wais|wais-user"), token);
  assert.equal((await c.status()).wais.connected, true);
  assert.ok(!JSON.stringify(await c.status()).includes(token), "no secret in the status");
  await c.disconnect("wais");
  assert.equal((await c.status()).wais.connected, false);
  assert.equal(log.filter((l) => l[0] === "reset" && l[1] === "wais").length, 2, "the server starts again with the new token, or none");
  assert.equal("wais" in (await connector(dir).c.status()), false, "no Wais in the status when it isn't given");
}));

test("a token Wais refuses is never saved", () => inTemp(async (dir) => {
  const { c, keychain } = connector(dir, { wais: true, fail: "wais" });
  await assert.rejects(c.connect("wais", { token: "wais_pat_x" }), { code: "auth" });
  assert.equal(keychain.size, 0);
}));
