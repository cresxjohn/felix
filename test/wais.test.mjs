import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { WAIS_PATH, createWais, refusedToken, waisAsk, waisProblem, waisSpec, waisView } from "../wais.mjs";

const TOKEN = `wais_pat_${"ab12".repeat(12)}`;
const REFUSED = new Error("wais: that token is not valid, or it was revoked");
const money = (amount) => ({ amount, formatted: `₱${amount.toLocaleString("en-US")}` });

/** Wais's answers, shaped as its MCP server gives them. */
const ANSWERS = {
  spaces: () => ({ default: "s1", spaces: [{ id: "s1", name: "Personal", role: "owner", timezone: "Asia/Manila" }, { id: "s2", name: "Family", role: "member", timezone: "Asia/Manila" }] }),
  accounts: (a) => ({ space: { id: a.space || "s1", name: "Personal" }, periods: [{ id: "payday", label: "Until payday", days: null }, { id: "30", label: "Next 30 days", days: 30 }], defaultPeriod: "payday",
    accounts: [{ id: "a1", name: "BPI Savings", kind: "bank", balance: money(42000), ccy: "PHP", inDefault: true }] }),
  safe_to_spend: (a) => ({ space: { id: a.space || "s1", name: "Personal" }, today: "2026-10-30", period: { id: a.period || "payday", label: "Until payday" }, accounts: a.accounts || "all",
    safeToSpend: money(18450), runsShortOn: null, lowest: { ...money(6200), on: "2026-11-14" }, payday: "2026-10-31", untilPayday: 1, days: 1, bills: [], link: "https://wais/safe" }),
  tasks: () => ({ space: { id: "s1", name: "Personal" }, today: "2026-10-30", count: 3, chips: { today: 1, review: 1, late: 1 }, folded: { count: 1, ...money(899) }, items: [], link: "https://wais/tasks" }),
  outlook: (a) => ({ space: { id: "s1", name: "Personal" }, today: "2026-10-30", period: { id: a.period }, periods: ["30", "60"], now: money(42000), low: { ...money(6200), on: "2026-11-14", inDays: 15 }, end: { ...money(30000), on: "2026-11-29" }, series: [], nothingPlanned: false, link: "https://wais/outlook" }),
};

/**
 * A Wais connection over a fake MCP client that answers from ANSWERS and records every call and start.
 * @param {{ token?: string | null, answer?: (tool: string, args: object) => unknown, prefs?: object }} [o]
 */
function setup({ token = TOKEN, answer, prefs = {} } = {}) {
  const calls = [];
  const clients = [];
  let clock = Date.parse("2026-10-30T01:00:00Z");
  const makeClient = ({ name, spec }) => {
    const c = {
      name, spec, stopped: 0,
      call: async (tool, args) => { calls.push([tool, args, clients.indexOf(c)]); return answer ? answer(tool, args) : ANSWERS[tool](args); },
      stop: () => { c.stopped += 1; },
    };
    clients.push(c);
    return c;
  };
  const wais = createWais({ settings: { get: async () => ({ waisEnv: "dev", waisPath: "/tmp/wais.mjs", ...prefs }) }, readToken: async () => token, makeClient, now: () => clock });
  return { wais, calls, clients, later: (ms) => { clock += ms; } };
}

test("the server starts with Node, the environment and the token, and only those", async () => {
  assert.deepEqual(waisSpec({ token: TOKEN, env: "prod", path: "/x/wais.mjs" }), { command: process.execPath, args: ["/x/wais.mjs"], env: { WAIS_ENV: "prod", WAIS_TOKEN: TOKEN } });
  assert.equal(waisSpec({ token: "t", env: "anything", path: "" }).env.WAIS_ENV, "dev");
  assert.equal(waisSpec({ token: "t", env: "dev", path: "" }).args[0], WAIS_PATH);
  const { clients } = setup({ prefs: { waisEnv: "prod", waisPath: "/y/wais.mjs" } });
  assert.deepEqual(await clients[0].spec(), { command: process.execPath, args: ["/y/wais.mjs"], env: { WAIS_ENV: "prod", WAIS_TOKEN: TOKEN } });
  assert.equal(await setup({ token: null }).clients[0].spec(), null, "no token, no server");
});

test("a refused token is told apart, and problems are plain words with no token in them", () => {
  assert.equal(refusedToken(REFUSED), true);
  assert.equal(refusedToken(new Error("Wais took too long")), false);
  assert.equal(waisProblem(REFUSED), "Wais refused the token. It may have been revoked.");
  assert.equal(waisProblem(new Error(`wais: space nope isn't yours (${TOKEN})`)), "space nope isn't yours ((token))");
  assert.match(waisProblem(new Error("Wais couldn't start: spawn ENOENT")), /server path in Settings/);
  assert.equal(waisProblem(new Error("Wais took too long to answer.")), "Wais took too long to answer.");
  assert.equal(waisProblem(Object.assign(new Error("Wais isn't set up yet."), { code: "not-set-up" })), "Wais isn't connected yet.");
});

test("the card's request is checked: unknown periods and odd ids are left out, and the outlook is 30 days at first", () => {
  assert.deepEqual(waisAsk({}), { outlook: "30" });
  assert.deepEqual(waisAsk({ space: "s2", period: "payday", accounts: "a1, a2,,bad id", outlook: "365" }), { space: "s2", period: "payday", accounts: ["a1", "a2"], outlook: "365" });
  assert.deepEqual(waisAsk({ space: "../x", period: "7", accounts: ["a1"], outlook: "12" }), { accounts: ["a1"], outlook: "30" });
});

test("the view: each part on its own, a failed part says why, and a refused token makes the whole card say so", () => {
  const ok = (value) => ({ status: "fulfilled", value });
  const no = (reason) => ({ status: "rejected", reason });
  const v = waisView({ spaces: ok(1), accounts: ok(2), safe: ok(3), tasks: no(new Error("wais: tasks broke")), outlook: ok(5) }, "t");
  assert.deepEqual(v, { connected: true, refused: false, fetchedAt: "t", problems: { tasks: "tasks broke" }, spaces: 1, accounts: 2, safe: 3, tasks: null, outlook: 5 });
  const all = Object.fromEntries(["spaces", "accounts", "safe", "tasks", "outlook"].map((k) => [k, no(REFUSED)]));
  assert.deepEqual(waisView(all, "t"), { connected: true, refused: true, problem: "Wais refused the token. It may have been revoked." });
});

test("not connected says so without starting anything; connected asks the five tools at once with the card's choices", async () => {
  const off = setup({ token: null });
  assert.deepEqual(await off.wais.view(), { connected: false });
  assert.equal(off.calls.length, 0);
  const { wais, calls } = setup();
  const v = await wais.view({ space: "s2", period: "30", accounts: "a1", outlook: "90" });
  assert.deepEqual(calls.map(([tool, args]) => [tool, args]), [
    ["spaces", {}], ["accounts", { space: "s2" }], ["safe_to_spend", { space: "s2", period: "30", accounts: ["a1"] }], ["tasks", { space: "s2" }], ["outlook", { space: "s2", period: "90" }],
  ]);
  assert.deepEqual([v.connected, v.refused, v.safe.safeToSpend.formatted, v.outlook.period.id, v.tasks.count, v.spaces.default], [true, false, "₱18,450", "90", 3, "s1"]);
  // With nothing picked, Wais uses its own saved choice.
  await wais.view({ fresh: true });
  assert.deepEqual(calls.slice(5).map(([tool, args]) => [tool, args]), [["spaces", {}], ["accounts", {}], ["safe_to_spend", {}], ["tasks", {}], ["outlook", { period: "30" }]]);
});

test("answers are kept two minutes per choice; fresh asks again; a refused token isn't kept; reset stops the server", async () => {
  const { wais, calls, clients, later } = setup();
  await wais.view({ outlook: "30" });
  await wais.view({ outlook: "30" });
  assert.equal(calls.length, 5);
  await wais.view({ outlook: "60" });
  assert.equal(calls.length, 10, "another choice asks again");
  later(119e3);
  await wais.view({ outlook: "30" });
  assert.equal(calls.length, 10);
  later(2e3);
  await wais.view({ outlook: "30" });
  assert.equal(calls.length, 15);
  await wais.view({ outlook: "30", fresh: true });
  assert.equal(calls.length, 20);
  wais.reset();
  assert.equal(clients[0].stopped, 1);
  await wais.view({ outlook: "30" });
  assert.equal(calls.length, 25, "reset forgets what was kept");
  const refused = setup({ answer: () => { throw REFUSED; } });
  assert.equal((await refused.wais.view()).refused, true);
  assert.equal((await refused.wais.view()).refused, true);
  assert.equal(refused.calls.length, 10, "asked again each time, so a new token shows at once");
});

test("connecting tries the token with the spaces tool on a server of its own, then stops it", async () => {
  const { wais, clients, calls } = setup({ token: null });
  await assert.rejects(wais.check({ token: "nope" }), { code: "input", message: /wais_pat_/ });
  assert.equal(calls.length, 0);
  assert.deepEqual(await wais.check({ token: TOKEN }), { name: "Personal" });
  const trial = clients[1];
  assert.deepEqual(await trial.spec(), { command: process.execPath, args: ["/tmp/wais.mjs"], env: { WAIS_ENV: "dev", WAIS_TOKEN: TOKEN } }, "the token tried, not a saved one");
  assert.equal(trial.stopped, 1);
  const refused = setup({ answer: () => { throw REFUSED; } });
  await assert.rejects(refused.wais.check({ token: TOKEN }), { code: "auth", message: /Wais refused that token/ });
  const down = setup({ answer: () => { throw new Error("Wais couldn't start: spawn ENOENT"); } });
  await assert.rejects(down.wais.check({ token: TOKEN }), { code: "error", message: /server path/ });
  assert.deepEqual(await setup({ answer: () => ({ spaces: [] }) }).wais.check({ token: TOKEN }), {});
});

test("Felix's AI calls go through the same server, with failures in plain words", async () => {
  const { wais, calls } = setup();
  assert.equal((await wais.call("tasks", { space: "s1" })).count, 3);
  assert.deepEqual(calls.at(-1).slice(0, 2), ["tasks", { space: "s1" }]);
  await assert.rejects(setup({ answer: () => { throw REFUSED; } }).wais.call("tasks"), /Wais refused the token/);
  assert.equal(await setup().wais.connected(), true);
  assert.equal(await setup({ token: null }).wais.connected(), false);
});

test("with the real MCP client, the server gets the environment and token from Settings and nothing of Felix's own", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "felix-wais-"));
  const file = path.join(dir, "wais-mcp.mjs");
  writeFileSync(file, `
import { createInterface } from "node:readline";
const reply = (m) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...m }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === "initialize") return reply({ id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "wais" } } });
  if (m.id === undefined) return;
  if (process.env.WAIS_TOKEN !== "${TOKEN}") return reply({ id: m.id, result: { isError: true, content: [{ type: "text", text: "wais: that token is not valid, or it was revoked" }] } });
  reply({ id: m.id, result: { content: [{ type: "text", text: JSON.stringify({ default: "s1", spaces: [{ id: "s1", name: process.env.WAIS_ENV + " space" }], felix: process.env.FELIX_SECRET || null }) }] } });
});
`);
  process.env.FELIX_SECRET = "keep-me-home";
  try {
    const wais = createWais({ settings: { get: async () => ({ waisEnv: "prod", waisPath: file }) }, readToken: async () => TOKEN });
    assert.deepEqual(await wais.call("spaces"), { default: "s1", spaces: [{ id: "s1", name: "prod space" }], felix: null });
    assert.deepEqual(await wais.check({ token: TOKEN }), { name: "prod space" });
    await assert.rejects(wais.check({ token: `wais_pat_${"0".repeat(48)}` }), { code: "auth" });
    wais.reset();
  } finally {
    delete process.env.FELIX_SECRET;
    rmSync(dir, { recursive: true, force: true });
  }
});
