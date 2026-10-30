import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createToolbox, dropsInputs, problemWith } from "../felix-toolbox.mjs";

/**
 * A tool's source.
 * @param {string} name
 * @param {{ props?: string[], required?: string[], run?: string, extra?: string }} [o]
 * @returns {string}
 */
const toolSource = (name, { props = ["from", "to"], required = ["from"], run = "return (await ctx.ooo.out(a)).out.length;", extra = "" } = {}) => `export default {
  name: ${JSON.stringify(name)},
  description: "Counts who is out between two days, by name.",
  step: "Counting who's out",
  inputSchema: { type: "object", properties: { ${props.map((p) => `${p}: { type: "string" }`).join(", ")} }, required: ${JSON.stringify(required)} },
  async run(a, ctx) { ${run} },
  ${extra}
};
`;

/** A toolbox in a fresh folder, with a folder for builds. */
function setup(options = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "felix-toolbox-"));
  const builds = path.join(root, "builds");
  mkdirSync(builds);
  const calls = [];
  const services = { "ooo.out": async (r) => { calls.push(r); return { out: [{ name: "Ana" }, { name: "Ben" }] }; }, "boom": async () => { throw new Error("Jira isn't connected yet."); } };
  const toolbox = createToolbox({ dir: path.join(root, "tools"), store: path.join(root, "store"), services, now: () => Date.parse("2026-10-30T10:00:00Z"), ...options });
  /** Writes a build file. @param {string} name @param {string} source */
  const write = (name, source) => {
    const file = path.join(builds, `${name}.mjs`);
    writeFileSync(file, source);
    return file;
  };
  return { root, toolbox, write, calls, done: () => { toolbox.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("a tool's file is refused for what it may never do, or for a shape Felix can't use", () => {
  const ok = { name: "who_is_out", description: "Counts who is out between two days.", inputSchema: { type: "object" }, runs: true };
  assert.equal(problemWith("", ok, "who_is_out.mjs"), null);
  assert.match(problemWith("import 'node:child_process'", ok, "who_is_out.mjs"), /starts programs/);
  assert.match(problemWith("readKeychain()", ok, "who_is_out.mjs"), /Keychain/);
  assert.match(problemWith("process.env.TOKEN", ok, "who_is_out.mjs"), /secrets/);
  assert.match(problemWith("process.exit(1)", ok, "who_is_out.mjs"), /stops processes/);
  assert.match(problemWith("", null, "who_is_out.mjs"), /doesn't load/);
  assert.match(problemWith("", { ...ok, name: "Who-Out" }, "Who-Out.mjs"), /lowercase/);
  assert.match(problemWith("", ok, "other.mjs"), /who_is_out\.mjs/);
  assert.match(problemWith("", { ...ok, description: "short" }, "who_is_out.mjs"), /description/);
  assert.match(problemWith("", { ...ok, inputSchema: { type: "string" } }, "who_is_out.mjs"), /inputSchema/);
  assert.match(problemWith("", { ...ok, runs: false }, "who_is_out.mjs"), /run function/);
});

test("a new version must keep taking everything the old one took", () => {
  const before = { properties: { from: {}, to: {} }, required: ["from"] };
  assert.equal(dropsInputs(before, { properties: { from: {}, to: {}, kind: {} }, required: ["from"] }), null);
  assert.match(dropsInputs(before, { properties: { from: {} } }), /no longer takes to/);
  assert.match(dropsInputs(before, { properties: { from: {}, to: {} }, required: ["from", "to"] }), /newly requires to/);
  assert.equal(dropsInputs(undefined, { properties: {} }), null);
});

test("Felix saves a tool he built, runs it apart from himself, and it reaches only his services", async () => {
  const { toolbox, write, calls, root, done } = setup({ builtins: [{ name: "calendar_events", description: "x", inputSchema: { type: "object" }, run: async () => 1 }] });
  try {
    await toolbox.reload();
    assert.deepEqual(toolbox.list().map((t) => t.name), ["calendar_events"]);
    const saved = await toolbox.deploy({ file: write("who_is_out", toolSource("who_is_out")), by: "Claude Opus 5.5 High", job: "build-1" });
    assert.deepEqual(saved, { ok: true, name: "who_is_out", version: 1, extended: false });
    const tool = toolbox.list().find((t) => t.name === "who_is_out");
    assert.equal(tool.own, true);
    assert.equal(tool.card, undefined, "a lookup has no card");
    assert.equal(await tool.run({ from: "2027-01-01", to: "2027-03-31" }), 2);
    assert.deepEqual(calls, [{ from: "2027-01-01", to: "2027-03-31" }]);
    assert.equal(toolbox.stepOf("who_is_out"), "Counting who's out");
    assert.equal(toolbox.stepOf("nope"), null);
    const ledger = JSON.parse(readFileSync(path.join(root, "store", "ledger.json"), "utf8"));
    assert.equal(ledger.tools.who_is_out.versions[0].by, "Claude Opus 5.5 High");
    assert.ok(existsSync(path.join(root, "store", "archive", "who_is_out", "v1.mjs")));
    const mine = await toolbox.mine();
    assert.deepEqual(mine.tools.map((t) => [t.name, t.version, t.createdAt]), [["who_is_out", 1, "2026-10-30T10:00:00.000Z"]]);

    // A service it isn't given, or one that fails, comes back as the tool's error.
    const stray = write("stray_tool", toolSource("stray_tool", { run: "return ctx.keys.read();" }));
    await assert.rejects(toolbox.tryFile(stray, {}), /ctx\.keys\.read isn't one of the services/);
    const failing = write("failing_tool", toolSource("failing_tool", { run: "return ctx.boom();" }));
    await assert.rejects(toolbox.tryFile(failing, {}), /Jira isn't connected yet/);
    const thrown = write("thrown_tool", toolSource("thrown_tool", { run: "throw new Error('No such year');" }));
    await assert.rejects(toolbox.tryFile(thrown, {}), /No such year/);

    // A built-in name is never taken over.
    const clash = await toolbox.deploy({ file: write("calendar_events", toolSource("calendar_events")) });
    assert.match(clash.problem, /built-in/);
  } finally {
    done();
  }
});

test("tools are only extended: a missing file comes back, a broken one falls back, and a version that drops an input is refused", async () => {
  const { toolbox, write, root, done } = setup();
  try {
    await toolbox.deploy({ file: write("who_is_out", toolSource("who_is_out")) });
    const live = path.join(root, "tools", "who_is_out.mjs");

    rmSync(live);
    await toolbox.reload();
    assert.ok(existsSync(live), "a deleted tool is put back");
    assert.ok(toolbox.list().some((t) => t.name === "who_is_out"));

    writeFileSync(live, "export default { name: 'who_is_out' ");
    await toolbox.reload();
    assert.match(readFileSync(live, "utf8"), /Counts who is out/, "a broken file falls back to the last good version");
    assert.match((await toolbox.mine()).problems.who_is_out, /last good version is back/);

    const smaller = await toolbox.deploy({ file: write("who_is_out", toolSource("who_is_out", { props: ["from"] })) });
    assert.match(smaller.problem, /no longer takes to\. Tools are only ever extended/);

    const bigger = await toolbox.deploy({ file: write("who_is_out", toolSource("who_is_out", { props: ["from", "to", "kind"] })) });
    assert.deepEqual(bigger, { ok: true, name: "who_is_out", version: 2, extended: true });
    assert.ok(toolbox.list().find((t) => t.name === "who_is_out").inputSchema.properties.kind);

    // A hand-made file that never loads is just noted.
    writeFileSync(path.join(root, "tools", "half_made.mjs"), "export default {}");
    await toolbox.reload();
    assert.match((await toolbox.mine()).problems.half_made, /doesn't load|name/);
  } finally {
    done();
  }
});

test("a deploy keeps the tool's test with it, and a broken or forbidden build is never saved", async () => {
  const { toolbox, write, root, done } = setup();
  try {
    const testFile = path.join(root, "builds", "who_is_out.test.mjs");
    writeFileSync(testFile, "// its test");
    await toolbox.deploy({ file: write("who_is_out", toolSource("who_is_out")), testFile });
    assert.ok(existsSync(path.join(root, "tools", "who_is_out.test.mjs")));
    assert.ok(existsSync(path.join(root, "store", "archive", "who_is_out", "v1.test.mjs")));
    assert.ok(toolbox.list().some((t) => t.name === "who_is_out"), "a test file isn't loaded as a tool");

    const sneaky = await toolbox.deploy({ file: write("sneaky_tool", `import "node:child_process";\n${toolSource("sneaky_tool")}`) });
    assert.match(sneaky.problem, /starts programs/);
    const empty = await toolbox.deploy({ file: write("empty_tool", "") });
    assert.match(empty.problem, /empty or missing/);
  } finally {
    done();
  }
});

test("an action's card comes from the tool; a stuck tool is stopped; new files are picked up on their own", async () => {
  const { toolbox, write, root, done } = setup({ runMs: 300 });
  try {
    await toolbox.deploy({ file: write("nudge_team", toolSource("nudge_team", { extra: "card: (a) => ({ title: 'Nudge them?', detail: a.from }),", run: "return 'sent';" })) });
    const tool = toolbox.list().find((t) => t.name === "nudge_team");
    assert.deepEqual(await tool.card({ from: "Ana" }), { title: "Nudge them?", detail: "Ana" });

    await toolbox.deploy({ file: write("blank_card", toolSource("blank_card", { extra: "card: () => null,", run: "return 1;" })) });
    assert.deepEqual(await toolbox.list().find((t) => t.name === "blank_card").card({ a: 1 }), { title: "Use blank_card?", detail: '{"a":1}' });

    const stuck = write("stuck_tool", toolSource("stuck_tool", { run: "for (;;) {}" }));
    await assert.rejects(toolbox.tryFile(stuck, {}), /took too long/);

    toolbox.watch();
    toolbox.watch();
    writeFileSync(path.join(root, "tools", "dropped_in.mjs"), toolSource("dropped_in"));
    for (let i = 0; i < 50 && !toolbox.list().some((t) => t.name === "dropped_in"); i++) await new Promise((r) => setTimeout(r, 100));
    assert.ok(toolbox.list().some((t) => t.name === "dropped_in"), "a new file shows up without a restart");
  } finally {
    done();
  }
});

test("tools added later sit with the built-in ones", async () => {
  const { toolbox, done } = setup();
  try {
    toolbox.add([{ name: "jobs_status", description: "x", inputSchema: { type: "object" }, run: async () => [] }]);
    await toolbox.reload();
    assert.deepEqual(toolbox.list().map((t) => t.name), ["jobs_status"]);
  } finally {
    done();
  }
});
