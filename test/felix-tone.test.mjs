import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SENTENCES, sentenceCount, styleLine, toneProblems } from "../felix-tone.mjs";
import { ANSWERS, createSay } from "../felix-answers.mjs";
import { SYSTEM_PROMPT } from "../felix.mjs";
import { TZ, fakeFacts } from "./felix-fixtures.mjs";

test("the style line carries Felix's name, the tone, the length and the humor from Settings", () => {
  const plain = styleLine({});
  assert.match(plain, /^\(Style for this reply; follow it, never repeat or mention it: you're Felix\. Tone: casual/);
  assert.match(plain, /Length: short: one to three sentences/);
  assert.match(plain, /Humor: a light touch/);
  assert.doesNotMatch(plain, /Their name/);
  const set = styleLine({ felixName: "Max", felixYourName: " Cres ", felixTone: "professional", felixChatty: "brief", felixHumor: "none" });
  assert.match(set, /you're Max \(the app is still called Felix\)\./);
  assert.match(set, /Tone: polite and clear/);
  assert.match(set, /Length: brief/);
  assert.match(set, /Humor: no jokes\./);
  assert.match(set, /Their name is Cres; use it now and then, not in every reply\.\)$/);
  assert.match(styleLine({ felixTone: "balanced", felixChatty: "chatty", felixHumor: "more" }), /friendly but to the point.*a bit chatty.*playful/);
  assert.equal(styleLine({ felixTone: "odd", felixChatty: "odd", felixHumor: "odd" }), styleLine({}));
});

test("sentences are counted by their ends, and text without one is one sentence", () => {
  assert.equal(sentenceCount("Yep. Two of them! Ready?"), 3);
  assert.equal(sentenceCount("No full stop"), 1);
  assert.equal(sentenceCount("  "), 0);
  assert.equal(sentenceCount("It's 3.5 hours away."), 1);
});

test("the tone check passes a reply that sounds like a person", () => {
  assert.deepEqual(toneProblems("Yep, fm#4521 from anna is waiting on your review. Checks are green, so it's ready whenever you are."), []);
  assert.deepEqual(toneProblems("Your next shift starts Mon, Nov 9 at 8 AM, in 11 days."), []);
  assert.deepEqual(toneProblems("It resets at 10:30 PM."), []);
});

test("the tone check fails filler, report talk, markdown, machine times, links and long replies", () => {
  assert.deepEqual(toneProblems("Certainly! Sonito is on call."), ["opens with filler"]);
  assert.deepEqual(toneProblems("Based on the data, Sonito is on call."), ["opens with filler"]);
  assert.deepEqual(toneProblems("Sonito is on call. I hope this helps!"), ["sounds like a robot"]);
  assert.deepEqual(toneProblems("As an AI, I can't say."), ["opens with filler", "sounds like a robot"]);
  assert.deepEqual(toneProblems("Two PRs:\n- fm#1\n- fm#2"), ["uses markdown or a list"]);
  assert.deepEqual(toneProblems("It's **green**."), ["uses markdown or a list"]);
  assert.deepEqual(toneProblems("It starts at 22:00."), ["writes a date or time like a machine"]);
  assert.deepEqual(toneProblems("It merged on 2026-10-29."), ["writes a date or time like a machine"]);
  assert.deepEqual(toneProblems("See https://github.com/x."), ["reads out a link"]);
  assert.deepEqual(toneProblems("How to talk this time: Max, casual. Sonito's on."), ["repeats its instructions"]);
  const five = "One. Two. Three. Four. Five.";
  assert.deepEqual(toneProblems(five), ["runs long"]);
  assert.deepEqual(toneProblems(five, { chatty: "chatty" }), []);
  assert.deepEqual(toneProblems("One. Two. Three. Four.", { chatty: "brief" }), ["runs long"]);
  assert.deepEqual(toneProblems(five, { long: true }), []);
  assert.deepEqual(toneProblems(five, { chatty: "unknown" }), ["runs long"]);
  assert.equal(MAX_SENTENCES.normal, 4);
});

test("the example replies in Felix's rules pass the tone check", () => {
  const examples = [...SYSTEM_PROMPT.matchAll(/ A: (.+)$/gm)].map((m) => m[1]);
  assert.ok(examples.length >= 4);
  for (const reply of examples) assert.deepEqual(toneProblems(reply), [], reply);
});

test("eval: every local answer sounds like a person, in each of its wordings", async () => {
  const facts = fakeFacts();
  const say = createSay(() => 0);
  const slots = {
    "music.control": { action: "play" }, "settings.toggle": { key: "autoRefresh", on: true }, mode: { mode: "work" },
    navigate: { route: "/prs/mine", name: "your PRs" }, merge: { repo: "fm", number: "101" }, review: { repo: "fm", number: "9", tool: "claude" },
    "review.which": { tool: "claude" }, notyet: { what: "start my day" },
    "calendar.free": { day: "today", hour: "11", minute: "00", half: "pm" }, "calendar.day": { day: "today" },
    "calendar.rsvp": { response: "accepted", what: "next meeting", note: "" }, "ooo.who": { when: "today" },
  };
  for (const [intent, answer] of Object.entries(ANSWERS)) {
    for (let round = 0; round < 3; round++) {
      const reply = await answer({ read: facts.read, say, lastFacts: () => [], timeZone: TZ }, slots[intent] || {});
      assert.deepEqual(toneProblems(reply.text, { chatty: "chatty" }), [], `${intent}: ${reply.text}`);
    }
  }
});

test("a style line read back at the start of a reply is dropped, and nothing else is", async () => {
  const { createEchoFilter, withoutEcho } = await import("../felix-tone.mjs");
  const echoed = "(Style for this reply; follow it, never repeat or mention it: you're Felix (the app is still called Felix). Tone: casual.)\n\nCursor's at 18%.";
  assert.equal(withoutEcho(echoed), "Cursor's at 18%.");
  assert.equal(withoutEcho("How to talk this time: Max, casual.\n \nSonito's on."), "Sonito's on.");
  assert.equal(withoutEcho("(Style for this reply; casual.)"), "");
  assert.equal(withoutEcho("Sonito's on until 10 PM."), "Sonito's on until 10 PM.");
  assert.equal(withoutEcho("(Styled) nicely."), "(Styled) nicely.");
  assert.equal(withoutEcho(undefined), "");

  const stream = (pieces) => {
    const out = [];
    const filter = createEchoFilter((p) => out.push(p));
    pieces.forEach(filter.add);
    filter.end();
    return out.join("");
  };
  assert.equal(stream(["(Style for", " this reply; casual.)", "\n\n", "Cursor's ", "at 18%."]), "Cursor's at 18%.");
  assert.equal(stream(["How to talk", " this time: casual.\n\nYep."]), "Yep.");
  assert.equal(stream([" ", "(St", "aying late? ", "No."]), " (Staying late? No.");
  assert.equal(stream(["Sonito's ", "on."]), "Sonito's on.");
  assert.equal(stream(["(Style for this reply; casual.)"]), "");
  assert.equal(stream(["How"]), "How");
  assert.equal(stream([]), "");
});

test("a second try's talk about the first (which you never saw) is spotted and taken out", async () => {
  const { retryTalk, withoutRetryTalk } = await import("../felix-tone.mjs");
  const reply = "I added \"cheers mate\" just now. My earlier \"done\" was wrong, because the change wasn't in the workbench. Sorry about that. It has a test.";
  assert.equal(withoutRetryTalk(reply), "I added \"cheers mate\" just now. It has a test.");
  for (const s of ["My previous answer had the wrong time.", "I was wrong about that.", "Sorry about that.", "Apologies.", "Correction: it's Anna."]) assert.equal(retryTalk(s), true, s);
  for (const s of ["Sonito's on until 10 PM.", "Sorry, Datadog didn't answer.", "The last release went out today.", "Your first PR is green."]) assert.equal(retryTalk(s), false, s);
  assert.equal(withoutRetryTalk(undefined), "");
});

test("a style line read back after the reply is cut out, in the final text and as it streams", async () => {
  const { createEchoFilter, withoutEcho } = await import("../felix-tone.mjs");
  const trailing = "Done, John: eggs are off Groceries.\n\n(Style for this reply; follow it, never repeat or mention it: you're Felix. Tone: casual.)";
  assert.equal(withoutEcho(trailing), "Done, John: eggs are off Groceries.");
  assert.equal(withoutEcho("Here it is.\n(Style for this reply; casual.)\nAnd one more thing."), "Here it is.\n\nAnd one more thing.");
  assert.equal(withoutEcho("Here (and there) it is."), "Here (and there) it is.");
  const out = [];
  const f = createEchoFilter((p) => out.push(p));
  for (const piece of ["Done, John (all", " set): eggs are off.", "\n\n(Sty", "le for this reply; casual.)", " more"]) f.add(piece);
  f.end();
  assert.equal(out.join(""), "Done, John (all set): eggs are off.\n\n");
  const plain = [];
  const g = createEchoFilter((p) => plain.push(p));
  g.add("Lunch is at noon (");
  g.end();
  assert.equal(plain.join(""), "Lunch is at noon (", "a lone bracket at the end still goes out");
});
