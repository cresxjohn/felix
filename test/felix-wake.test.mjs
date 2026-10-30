import { test } from "node:test";
import assert from "node:assert/strict";
import { editDistance, matchWake, soundOf, soundsLike, wakeReply } from "../felix-wake.mjs";

const FELIX = { felixName: "Felix", felixWake: "", felixWakeName: true };

test("words are compared by how they sound, so whisper's spellings of a name match", () => {
  for (const heard of ["Felix", "felix", "Phelix", "Felicks", "Feliks", "FELIX'S", "Fellix"]) assert.equal(soundOf(heard), soundOf("felix"), heard);
  assert.notEqual(soundOf("fellas"), soundOf("felix"));
  assert.equal(soundOf("123"), "");
  assert.deepEqual([editDistance("felix", "helix"), editDistance("", "ab"), editDistance("fellas", "felix")], [1, 2, 3]);
});

test("a name of five letters or more may be one letter off; a short one must sound the same", () => {
  assert.equal(soundsLike("Helix", "felix"), true);
  assert.equal(soundsLike("Felis", "felix"), true);
  assert.equal(soundsLike("fellas", "felix"), false);
  assert.equal(soundsLike("relax", "felix"), false);
  assert.equal(soundsLike("Joe", "jo"), true);
  assert.equal(soundsLike("go", "jo"), false);
  assert.equal(soundsLike("", "felix"), false);
});

test("the phrase at the start wakes Felix, and what follows in the same breath is the question", () => {
  assert.deepEqual(matchWake("Hey Felix, who's on call?", FELIX), { rest: "who's on call?" });
  assert.deepEqual(matchWake("Hey, Felix.", FELIX), { rest: "" });
  assert.deepEqual(matchWake("A Phelix what's playing", FELIX), { rest: "what's playing" });
  assert.deepEqual(matchWake("Okay Felicks — usage", FELIX), { rest: "usage" });
  assert.deepEqual(matchWake("Um, hey Felix, merge my PR.", FELIX), { rest: "merge my PR." });
  assert.deepEqual(matchWake("Hay Helix", FELIX), { rest: "" });
});

test("the name alone wakes him only when Settings allow it", () => {
  assert.deepEqual(matchWake("Felix, who's next?", FELIX), { rest: "who's next?" });
  assert.equal(matchWake("Felix, who's next?", { ...FELIX, felixWakeName: false }), null);
  assert.deepEqual(matchWake("Hey Felix who's next", { ...FELIX, felixWakeName: false }), { rest: "who's next" });
});

test("Felix mid-sentence, other talk and noise don't wake him", () => {
  for (const heard of ["I told Felix about it", "So um hey Felix", "Hey fellas, lunch?", "Thank you.", "", "Hey", "Hey there Felix", "relax, Felix"]) {
    assert.equal(matchWake(heard, FELIX), null, heard);
  }
  assert.equal(matchWake(undefined, FELIX), null);
});

test("a new name and your own phrase are what wake him", () => {
  const max = { felixName: "Max", felixWake: "", felixWakeName: true };
  assert.deepEqual(matchWake("Hey Max, play", max), { rest: "play" });
  assert.deepEqual(matchWake("Max play", max), { rest: "play" });
  assert.equal(matchWake("Hey Felix, play", max), null);
  assert.equal(matchWake("Hey Mac, play", max), null);
  const own = { felixName: "Felix", felixWake: "Yo buddy", felixWakeName: false };
  assert.deepEqual(matchWake("yo buddy, usage", own), { rest: "usage" });
  assert.deepEqual(matchWake("Hey buddy usage", own), { rest: "usage" });
  assert.equal(matchWake("Hey Felix usage", own), null);
  assert.deepEqual(matchWake("Felix usage", { felixWake: "Yo buddy" }), { rest: "usage" });
  assert.deepEqual(matchWake("Hey Mary Jo, usage", { felixName: "Mary Jo", felixWakeName: true }), { rest: "usage" });
  assert.deepEqual(matchWake("Mary Joe usage", { felixName: "Mary Jo", felixWakeName: true }), { rest: "usage" });
});

test("a clip that doesn't wake Felix gives back nothing of what was heard", () => {
  const heard = "my bank PIN is 4821 and the code is blue";
  const reply = wakeReply(heard, FELIX);
  assert.deepEqual(reply, { woke: false });
  for (const word of heard.split(" ")) assert.equal(JSON.stringify(reply).includes(word), false, word);
  assert.deepEqual(wakeReply("Hey Felix, who's on call?", FELIX), { woke: true, rest: "who's on call?" });
  assert.deepEqual(Object.keys(wakeReply("Hey Felix", FELIX)).sort(), ["rest", "woke"]);
});

test("cutting in: 'stop', 'wait' or his name stop him; talking over him becomes the next question; his own voice is ignored", async () => {
  const { bargeReply, echoOf } = await import("../felix-wake.mjs");
  const saying = "You have three PRs waiting on your review.";
  const prefs = { felixName: "Felix" };
  assert.deepEqual(bargeReply("Stop.", { saying, prefs }), { action: "stop" });
  assert.deepEqual(bargeReply("wait a sec", { saying, prefs }), { action: "stop" });
  assert.deepEqual(bargeReply("Felix", { saying, prefs }), { action: "stop" });
  assert.deepEqual(bargeReply("Felix, who's on call?", { saying, prefs }), { action: "ask", rest: "who's on call?" });
  assert.deepEqual(bargeReply("no I meant the other one", { saying, prefs }), { action: "ask", rest: "no I meant the other one" });
  assert.deepEqual(bargeReply("three PRs waiting", { saying, prefs }), { action: "ignore" }, "his own voice coming back");
  assert.deepEqual(bargeReply("um", { saying, prefs }), { action: "ignore" });
  assert.deepEqual(bargeReply("", { prefs }), { action: "ignore" });
  assert.deepEqual(bargeReply("go on then please", { prefs }), { action: "ask", rest: "go on then please" });
  assert.equal(echoOf("anything", ""), false);
  assert.equal(echoOf("", saying), false);
});
