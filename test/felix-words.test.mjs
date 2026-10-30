import { test } from "node:test";
import assert from "node:assert/strict";
import { autoWords, parseWords, wordsFor } from "../felix-words.mjs";

test("your words come one a line, with an optional way of saying them", () => {
  assert.deepEqual(parseWords("Jamsed\n PMHUB = P M hub \n\n=nothing\n" + "x".repeat(41)), [{ word: "Jamsed", sayAs: null }, { word: "PMHUB", sayAs: "P M hub" }]);
  assert.deepEqual(parseWords(null), []);
});

test("words fill in from your team, the people on call and your Jira projects, each once", () => {
  const auto = autoWords({ people: [{ name: "Sonito Mole", nicknames: ["Sonito"] }, { name: "felix" }], oncall: ["Michael Rodriguez", "nobody"], jiraKeys: ["PMHUB-1", "WAIS-2", "bad"] });
  assert.ok(auto.includes("Sonito") && auto.includes("Michael Rodriguez") && auto.includes("WAIS"));
  assert.equal(auto.filter((w) => w.toLowerCase() === "felix").length, 1);
  assert.equal(auto.includes("nobody"), false);
  assert.ok(autoWords({ people: Array.from({ length: 100 }, (_, i) => ({ name: `Person ${i}` })) }).length <= 60);
  assert.ok(autoWords({}).includes("Datadog"));
  const picked = autoWords({ people: [{ name: "Dhvani Flight to Davao PH" }, { name: "Zed Out" }, { name: "Ana Cruz", onTeam: true }] });
  assert.equal(picked.includes("Dhvani Flight to Davao PH"), false);
  assert.ok(picked.indexOf("Ana Cruz") < picked.indexOf("Zed Out"), "your team first");
});

test("whisper hears your words first, and the ones you gave a way of saying are read that way", () => {
  const { hear, sayAs } = wordsFor(["Datadog", "Sonito"], "Jamsed\nPMHUB = P M hub\nSonito");
  assert.deepEqual(hear.slice(0, 4), ["Jamsed", "PMHUB", "Sonito", "Datadog"]);
  assert.deepEqual(sayAs, [{ word: "PMHUB", sayAs: "P M hub" }]);
});
