import { test } from "node:test";
import assert from "node:assert/strict";
import { clipped, createConversation } from "../felix-conversation.mjs";

const route = (extra = {}) => ({ sources: ["oncall"], prs: [], notYet: [], followsOn: false, ...extra });

test("a long answer is cut at a word for the recap, and spacing is tidied", () => {
  assert.equal(clipped("  Sonito   has it.\nThen Anna. "), "Sonito has it. Then Anna.");
  const long = clipped(`${"word ".repeat(200)}end`);
  assert.ok(long.length <= 501);
  assert.match(long, /word…$/);
  assert.equal(clipped(undefined), "");
});

test("the recap lists the last few exchanges, oldest first, only while they're fresh", () => {
  let clock = 0;
  const talk = createConversation({ now: () => clock, keep: 2, freshMs: 100 });
  assert.equal(talk.recap(), "");
  talk.add("who's on call?", "Sonito.");
  clock = 10;
  talk.add("and later?", "Anna, from 10 PM.", route());
  talk.add("thanks", "Anytime!");
  const recap = talk.recap().split("\n");
  assert.match(recap[0], /^What we just talked about, oldest first/);
  assert.deepEqual(recap.slice(1), ["Me: and later?", "You: Anna, from 10 PM.", "Me: thanks", "You: Anytime!"]);
  clock = 105;
  assert.deepEqual(talk.recap().split("\n").slice(1), ["Me: and later?", "You: Anna, from 10 PM.", "Me: thanks", "You: Anytime!"]);
  clock = 200;
  assert.equal(talk.recap(), "");
});

test("a question that names nothing follows on from the last answer's sources and PRs", () => {
  let clock = 0;
  const talk = createConversation({ now: () => clock, freshMs: 100 });
  const broad = route({ sources: ["oncall", "prs"], followsOn: true });
  assert.equal(talk.routeFor(broad), broad);
  talk.add("summarize fm#101", "It adds caching.", route({ sources: ["music"], prs: [{ repo: "fm", number: 101 }] }));
  talk.add("thanks", "Anytime!");
  assert.deepEqual(talk.routeFor(broad), { sources: ["oncall", "prs", "music"], prs: [{ repo: "fm", number: 101 }], notYet: [], followsOn: true });
  const specific = route({ sources: ["releases"] });
  assert.equal(talk.routeFor(specific), specific);
  clock = 200;
  assert.equal(talk.routeFor(broad), broad);
});
