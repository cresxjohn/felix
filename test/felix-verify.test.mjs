import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkFacts, createSentenceGate, isOrdinary, knownFacts, ordinaryWords } from "../felix-verify.mjs";
import { IC, NOW, PRS, TZ, fakeFacts } from "./felix-fixtures.mjs";
import { oncallRecord, prsRecord } from "../felix-facts.mjs";

const ORDINARY = ordinaryWords("/no/such/word-list");
const options = { timeZone: TZ, ordinary: ORDINARY };
const oncall = oncallRecord(IC, NOW, TZ);
const prs = prsRecord(PRS, NOW);

test("the word list falls back to common words, and reads a real one when there", async () => {
  assert.ok(ORDINARY.has("the") && ORDINARY.has("felix") && ORDINARY.has("datadog"));
  assert.ok(!ORDINARY.has("sonito"));
  const dir = await mkdtemp(path.join(tmpdir(), "felix-words-"));
  const file = path.join(dir, "words");
  await writeFile(file, "apple\nBoston\nbanana\nMarco\nmarco\n\n");
  const words = ordinaryWords(file);
  assert.ok(words.has("apple") && words.has("banana") && words.has("pr"));
  assert.ok(!words.has("boston") && !words.has("marco"));
  await rm(dir, { recursive: true });
  assert.equal(ordinaryWords(), ordinaryWords());
});

test("known facts hold the data's words, numbers, list lengths and times", () => {
  const known = knownFacts([oncall, "When's my shift?"], { timeZone: TZ });
  assert.ok(known.words.has("sonito") && known.words.has("reyes") && known.words.has("shift"));
  assert.ok(known.numbers.has(3) && known.numbers.has(2));
  assert.ok(known.times.has("10:00pm") && known.times.has("8:00am"));
  assert.ok(known.words.has("monday") && known.words.has("mon") && known.words.has("november") && known.words.has("nov"));
  assert.ok(knownFacts([{ n: 7, ok: true, none: null }]).numbers.has(7));
});

test("an answer that only uses what was read passes", () => {
  const cases = [
    "Sonito Mole is on call until 10 PM today, then Anna Reyes takes over.",
    "Sonito's on until 10pm. Anna's next.",
    "Your next shift is Monday, November 2 at 8 AM, in 4 days.",
    "Nobody's on call? No, it's Sonito.",
    "You have 4 open PRs. Fm#102 is failing lint and unit tests.",
    "Anna Reyes picks up at 10 p.m. tonight.",
  ];
  for (const answer of cases) assert.deepEqual(checkFacts(answer, [oncall, prs], options), { ok: true, unmatched: [] }, answer);
});

test("made-up names, numbers and times are caught", () => {
  assert.deepEqual(checkFacts("Marco Diaz is on call until 10 PM.", [oncall], options), { ok: false, unmatched: ["marco", "diaz"] });
  assert.deepEqual(checkFacts("Sonito is on until 11 PM.", [oncall], options).unmatched, ["11 PM"]);
  assert.deepEqual(checkFacts("You have 9 PRs open.", [prs], options).unmatched, ["9"]);
  assert.deepEqual(checkFacts("fm#999 is failing.", [prs], options).unmatched, ["999"]);
  assert.deepEqual(checkFacts("It's on Sunday.", [oncall], options).unmatched, ["sunday"]);
});

test("the question counts as known, and ticket keys and PR numbers are checked by their parts", () => {
  assert.equal(checkFacts("PMHUB-32946 is linked.", [{ tickets: ["PMHUB-32946"] }], options).ok, true);
  assert.deepEqual(checkFacts("PMHUB-77 is linked.", [{ tickets: ["PMHUB-32946"] }], options).unmatched, ["77"]);
  assert.equal(checkFacts("Yes, Kamote is a fine name.", ["Is Kamote a good name?"], options).ok, true);
  assert.equal(checkFacts("1,200 lines changed.", [{ additions: 1200 }], options).ok, true);
});

test("the sentence gate lets whole, passing sentences through as they're written", () => {
  const shown = [];
  const gate = createSentenceGate((s) => !s.includes("Marco"), (t) => shown.push(t));
  for (const piece of ["Costs 18", ".53 USD", " so far. Next", " line\n", "Then Marco", " joins. More."]) gate.add(piece);
  assert.deepEqual(shown, ["Costs 18.53 USD so far. ", "Next line\n"]);
  assert.equal(gate.shown(), "Costs 18.53 USD so far. Next line\n");
  gate.add(" Even more. ");
  assert.equal(shown.length, 2);
  gate.reset();
  assert.deepEqual(shown.at(-1), null);
  gate.add("\n  Fresh start. ");
  assert.deepEqual(shown.at(-1), "Fresh start. ");
  const quiet = createSentenceGate(() => true, (t) => shown.push(t));
  quiet.reset();
  assert.equal(quiet.shown(), "");
});

test("a decimal in the data may be said rounded", () => {
  const data = [{ percentUsed: 69.485, note: "Auto at 4.1066666666666665%" }];
  for (const said of ["69", "70", "69.5", "69.49", "4", "4.1", "5"]) assert.equal(checkFacts(`About ${said}% used.`, data, options).ok, true, said);
  assert.deepEqual(checkFacts("About 68% used.", data, options).unmatched, ["68"]);
});

test("other forms of everyday words count as everyday words", () => {
  const words = new Set(["check", "approve", "wait", "reply", "stop", "quick", "great"]);
  for (const w of ["check", "checks", "approved", "waiting", "replies", "replied", "stopped", "quickly", "greater", "greatest"]) assert.ok(isOrdinary(w, words), w);
  for (const w of ["marco", "ed", "sonitos"]) assert.ok(!isOrdinary(w, words), w);
});

test("a correct answer that starts a sentence with a word form isn't blocked", async () => {
  const fact = await fakeFacts().read("prs");
  const answer = "Yeah, bm#201 from anna is waiting on your review. Checks are passing, but it needs review approval.";
  assert.deepEqual(checkFacts(answer, [{ prs: fact.record }], { timeZone: TZ }), { ok: true, unmatched: [] });
});

test("the facts Felix reads can back up its own words", async () => {
  const fact = await fakeFacts().read("oncall");
  assert.equal(checkFacts("Sonito Mole has it until 10 PM today.", [{ oncall: fact.record }], { timeZone: TZ }).ok, true);
});
