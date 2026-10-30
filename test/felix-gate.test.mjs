import { test } from "node:test";
import assert from "node:assert/strict";
import { SAY_IT, cardFor, createGate, fromClaude, fromCursor } from "../felix-gate.mjs";

const WORKBENCH = "/tmp/felix-workbench";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A gate with numbered card ids, and a question in progress that records its cards and steps.
 * @param {object} [extra]
 */
function open(extra = {}) {
  let n = 0;
  const gate = createGate({ inside: [WORKBENCH], newId: () => `c${(n += 1)}`, ...extra });
  const cards = [];
  const steps = [];
  const end = gate.begin({ onAsk: (c) => cards.push(c), onStep: (s) => steps.push(s) });
  return { gate, cards, steps, end };
}

test("reads and edits inside the workbench go straight through, with no card", async () => {
  const { gate, cards } = open();
  assert.equal(await gate.request(fromClaude("Read", { file_path: "/etc/hosts" })), true);
  assert.equal(await gate.request(fromClaude("Bash", { command: "gh pr list" })), true);
  assert.equal(await gate.request(fromClaude("Edit", { file_path: `${WORKBENCH}/public/home.html` })), true);
  assert.equal(await gate.request(fromClaude("Write", { file_path: "memory/people/anna.md" })), true);
  assert.equal(await gate.request(fromCursor({ kind: "search", title: "rg felix" })), true);
  assert.deepEqual(cards, []);
});

test("a change waits on a card for a click or a typed yes, and a spoken yes isn't enough", async () => {
  const { gate, cards } = open();
  const merging = gate.request(fromCursor({ kind: "execute", title: "`gh pr merge 12`" }));
  await wait(0);
  assert.deepEqual(cards, [{ id: "c1", title: "Run this command?", detail: "gh pr merge 12" }]);
  assert.deepEqual(gate.answer("c1", true, { spoken: true }), { ok: false, text: SAY_IT });
  assert.deepEqual(gate.answer("c1", true), { ok: true, text: "Allowed." });
  assert.equal(await merging, true);
  assert.deepEqual(gate.answer("c1", true), { ok: false, text: "That one isn't waiting anymore." });
  const editing = gate.request(fromClaude("Edit", { file_path: "/Users/me/other/app.js" }));
  await wait(0);
  assert.equal(cards[1].title, "Change this file?");
  assert.deepEqual(gate.answer("c2", false), { ok: true, text: "Okay, not doing that." });
  assert.equal(await editing, false);
});

test("never-run commands are turned down without a card, and so is anything with no question in progress", async () => {
  const { gate, cards, steps, end } = open();
  assert.equal(await gate.request(fromClaude("Bash", { command: "security find-generic-password -s x" })), false);
  assert.deepEqual(steps, ["Felix never runs that one"]);
  const waiting = gate.request(fromClaude("Bash", { command: "rm -rf x" }));
  await wait(0);
  end();
  assert.equal(await waiting, false);
  assert.equal(await gate.request(fromClaude("Bash", { command: "rm -rf x" })), false);
  assert.equal(await gate.request(fromClaude("Bash", { command: "ls" })), true);
  assert.equal(cards.length, 1);
});

test("a card nobody answers is turned down after a while", async () => {
  const { gate } = open({ waitMs: 10 });
  assert.equal(await gate.request(fromClaude("mcp__other__thing", { a: 1 })), false);
});

test("an ended question leaves a newer one's sink alone", async () => {
  const gate = createGate({ inside: [WORKBENCH], newId: () => "x" });
  const first = gate.begin({ onAsk: () => {} });
  const cards = [];
  const second = gate.begin({ onAsk: (c) => cards.push(c) });
  first();
  const touching = gate.request(fromClaude("Bash", { command: "touch x" }));
  await wait(0);
  assert.equal(cards.length, 1);
  second();
  assert.equal(await touching, false);
});

test("Claude's and Cursor's tool uses read the same way, and each card says exactly what will run", () => {
  assert.deepEqual(fromClaude("NotebookEdit", { notebook_path: "a.ipynb" }), { tool: "edit", file: "a.ipynb" });
  assert.deepEqual(fromClaude("Bash"), { tool: "shell", command: "" });
  assert.deepEqual(fromClaude("Glob", {}), { tool: "read", detail: "Glob" });
  assert.deepEqual(fromCursor({ kind: "edit", locations: [{ path: "/x/a.js" }] }), { tool: "edit", file: "/x/a.js" });
  assert.deepEqual(fromCursor({ kind: "delete", title: "Delete a.js" }), { tool: "edit", file: "Delete a.js" });
  assert.deepEqual(fromCursor(), { tool: "other", detail: "a tool" });
  assert.deepEqual(cardFor({ tool: "other", detail: "x".repeat(700) }).detail.length, 600);
  assert.equal(createGate({ inside: [WORKBENCH] }).kindOf({ tool: "edit", file: "" }), "change");
});

test("the web is searched or read only on a question where you asked Felix to look something up", async () => {
  const { createGate, fromClaude, fromCursor } = await import("../felix-gate.mjs");
  const gate = createGate({ inside: ["/tmp/wb"] });
  assert.deepEqual(fromClaude("WebSearch", { query: "kokoro voices" }), { tool: "web", detail: "kokoro voices" });
  assert.deepEqual(fromClaude("WebFetch", { url: "https://x.y" }), { tool: "web", detail: "https://x.y" });
  assert.deepEqual(fromClaude("WebFetch", {}), { tool: "web", detail: "WebFetch" });
  assert.deepEqual(fromCursor({ kind: "fetch", title: "Fetch x" }), { tool: "web", detail: "Fetch x" });
  const steps = [];
  let end = gate.begin({ onAsk: () => {}, onStep: (s) => steps.push(s) });
  assert.equal(await gate.request({ tool: "web", detail: "news" }), false);
  assert.deepEqual(steps, ["Felix searches the web only when you ask"]);
  end();
  end = gate.begin({ onAsk: () => {}, web: true });
  assert.equal(await gate.request({ tool: "web", detail: "news" }), true);
  end();
  assert.equal(await gate.request({ tool: "web", detail: "news" }), false, "with no question in progress, no web");
});

test("Allow everything lets changes through without a card, but never-run commands and unasked web use stay out", async () => {
  const gate = createGate({ inside: [WORKBENCH] });
  const cards = [];
  const steps = [];
  const end = gate.begin({ onAsk: (c) => cards.push(c), onStep: (s) => steps.push(s), allowAll: true });
  assert.equal(await gate.request(fromCursor({ kind: "execute", title: "`gh pr merge 12`" })), true);
  assert.equal(await gate.request(fromClaude("Edit", { file_path: "/Users/me/other/app.js" })), true);
  assert.equal(await gate.request(fromClaude("Bash", { command: "security find-generic-password -s x" })), false);
  assert.equal(await gate.request(fromClaude("WebSearch", { query: "weather" })), false);
  assert.deepEqual(cards, []);
  assert.deepEqual(steps, ["Felix never runs that one", "Felix searches the web only when you ask"]);
  end();
  assert.equal(await gate.request(fromCursor({ kind: "execute", title: "`gh pr merge 12`" })), false, "with no question in progress, nothing changes");
});

test("an action on a service shows its own card, and Allow everything lets it through", async () => {
  assert.deepEqual(cardFor({ tool: "action", title: "Post this in #team?", detail: "Back at 2" }), { title: "Post this in #team?", detail: "Back at 2" });
  const { gate, cards } = open();
  const posting = gate.request({ tool: "action", title: "Post this in #team?", detail: "Back at 2" });
  await wait(0);
  assert.deepEqual(cards, [{ id: "c1", title: "Post this in #team?", detail: "Back at 2" }]);
  gate.answer("c1", true);
  assert.equal(await posting, true);
  const all = createGate({ inside: [WORKBENCH] });
  all.begin({ onAsk: () => assert.fail("no card with Allow everything"), allowAll: true });
  assert.equal(await all.request({ tool: "action", title: "Add this task?", detail: "x" }), true);
});
