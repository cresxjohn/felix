import { test } from "node:test";
import assert from "node:assert/strict";
import { OUTLOOK_PERIODS, SAFE_PERIODS, askFor, choiceFor, readChoices, withChoice, writeChoices } from "../public/wais-choices.mjs";

test("choices read from Settings, with anything unreadable left out", () => {
  assert.deepEqual(readChoices(""), { space: null, tab: "tasks", spaces: {} });
  assert.deepEqual(readChoices("not json"), { space: null, tab: "tasks", spaces: {} });
  assert.deepEqual(readChoices(JSON.stringify({ space: "s1", tab: "outlook", spaces: { s1: { period: "30", accounts: ["a1", "bad id", 7], outlook: "90" }, "../x": { period: "30" }, s2: { period: "7", outlook: "12" } } })),
    { space: "s1", tab: "outlook", spaces: { s1: { period: "30", accounts: ["a1"], outlook: "90" }, s2: {} } });
  assert.deepEqual(readChoices(JSON.stringify({ space: 5, tab: "nope" })), { space: null, tab: "tasks", spaces: {} });
  assert.deepEqual(SAFE_PERIODS, ["payday", ...OUTLOOK_PERIODS]);
});

test("each space keeps its own period, accounts and outlook; another space starts from Wais's choice", () => {
  let c = readChoices("");
  c = withChoice(c, { space: "s1" });
  c = withChoice(c, { spaceId: "s1", period: "90", accounts: ["a2", "a1"], outlook: "365" });
  c = withChoice(c, { spaceId: "s2", period: "payday" });
  c = withChoice(c, { tab: "outlook" });
  assert.deepEqual(choiceFor(c, "s1"), { period: "90", accounts: ["a2", "a1"], outlook: "365" });
  assert.deepEqual(choiceFor(c, "s2"), { period: "payday", accounts: null, outlook: "30" });
  assert.deepEqual(choiceFor(c, "s3"), { period: null, accounts: null, outlook: "30" });
  assert.deepEqual(choiceFor(c, null), { period: null, accounts: null, outlook: "30" });
  c = withChoice(c, { spaceId: "s1", accounts: null });
  assert.equal(choiceFor(c, "s1").accounts, null, "back to Wais's own pick");
  assert.equal(choiceFor(withChoice(c, { spaceId: "s1", accounts: [] }), "s1").accounts, null, "none picked is Wais's own pick too");
  assert.deepEqual([c.space, c.tab], ["s1", "outlook"]);
  assert.deepEqual(withChoice(c, { tab: "nope", space: "../x", spaceId: "s1", period: "7" }), c, "bad values change nothing");
  assert.deepEqual(readChoices(writeChoices(c)), c, "kept and read back the same");
});

test("the card asks for its space's choices, and nothing it doesn't have", () => {
  assert.deepEqual(askFor(readChoices("")), { outlook: "30" });
  let c = withChoice(readChoices(""), { space: "s1" });
  c = withChoice(c, { spaceId: "s1", period: "payday", accounts: ["a1", "a2"], outlook: "60" });
  assert.deepEqual(askFor(c), { space: "s1", period: "payday", accounts: "a1,a2", outlook: "60" });
  assert.deepEqual(askFor(withChoice(c, { space: "s2" })), { space: "s2", outlook: "30" });
});

test("choices made while no space is picked belong to Wais's default space, and are asked for with it", () => {
  // The card shows Wais's default space until one is picked, and saves a period or accounts under that space's id.
  const c = withChoice(readChoices(""), { spaceId: "home", period: "30", accounts: ["a1"], outlook: "90" });
  assert.equal(c.space, null);
  assert.deepEqual(askFor(c, "home"), { period: "30", accounts: "a1", outlook: "90" });
  assert.deepEqual(askFor(c), { outlook: "30" }, "without knowing the default, nothing is guessed");
  assert.deepEqual(askFor(withChoice(c, { space: "farm" }), "home"), { space: "farm", outlook: "30" }, "a picked space has its own choices");
});

test("when the setting would be too long, the spaces changed longest ago go first", () => {
  let c = readChoices("");
  for (let i = 0; i < 60; i++) c = withChoice(c, { spaceId: `space-${i}`, period: "30", accounts: Array.from({ length: 8 }, (_, j) => `account-${i}-${j}`) });
  const text = writeChoices(c);
  assert.ok(text.length <= 4000);
  const kept = Object.keys(readChoices(text).spaces);
  assert.equal(kept.at(-1), "space-59");
  assert.ok(!kept.includes("space-0"));
  // Changing an old space moves it to the end, so it stays.
  c = withChoice(c, { spaceId: "space-0", outlook: "90" });
  assert.ok(Object.keys(readChoices(writeChoices(c)).spaces).includes("space-0"));
});
