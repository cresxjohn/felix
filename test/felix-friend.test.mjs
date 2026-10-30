import { test } from "node:test";
import assert from "node:assert/strict";
import { CRISIS_TEXT, friendLine, friendModel, inQuietHours, isCrisis, isPersonal } from "../felix-friend.mjs";

test("crisis wording is caught, and everyday talk about bugs and deadlines isn't", () => {
  for (const t of ["I want to die", "sometimes I think about killing myself", "I don't want to be alive anymore", "I've been hurting myself",
    "everyone would be better off without me", "I can't go on like this", "thinking about suicide", "I just want to end it all"]) assert.equal(isCrisis(t), true, t);
  for (const t of ["this bug is killing me", "kill the process on port 4777", "the deadline will be the death of me", "I'm dying to see the release", "end the meeting", "", undefined]) {
    assert.equal(isCrisis(t), false, String(t));
  }
});

test("the crisis message points to real help, and says to call 911 in danger", () => {
  assert.match(CRISIS_TEXT, /NCMH crisis hotline, 1553/);
  assert.match(CRISIS_TEXT, /call 911/);
  assert.match(CRISIS_TEXT, /reach out to someone you trust/);
});

test("talk about feelings, family and life outside work is personal; work questions aren't", () => {
  for (const t of ["I had a rough day", "I'm so stressed lately", "my mom is in the hospital", "can we talk?", "I feel like nobody listens",
    "my girlfriend and I broke up", "I'm really proud of myself today", "my dog Mochi turns 3 this weekend", "I want to die"]) {
    assert.equal(isPersonal(t, false), true, t);
  }
  for (const t of ["who's on call?", "summarize fm#12", "add a weather widget", "what's failing", "hello", "how much usage is left"]) assert.equal(isPersonal(t, false), false, t);
  assert.equal(isPersonal("I'm stressed about fm#12", true), false, "naming work keeps it a work question");
  assert.equal(isPersonal("I'm so stressed", true), false);
});

test("the friend rules follow the personality, and say what to do after the crisis message", () => {
  const warm = friendLine({});
  assert.match(warm, /no work data was read/);
  assert.match(warm, /warm and caring/);
  assert.match(warm, /not a yes-man/);
  assert.match(warm, /reaching out to people they trust/);
  assert.match(warm, /NCMH crisis hotline, 1553/);
  assert.doesNotMatch(warm, /already showed them/);
  assert.match(friendLine({ felixFriendPersonality: "direct", felixYourName: "Cres" }), /straight-talking[\s\S]*Their name is Cres\./);
  assert.match(friendLine({ felixFriendPersonality: "nope" }), /warm and caring/);
  assert.match(friendLine({}, { crisis: true }), /already showed them the crisis hotline message/);
  for (const p of ["cheerful", "calm"]) assert.ok(friendLine({ felixFriendPersonality: p }).length > 100, p);
});

test("personal talk goes to the friend model from Settings, or Felix's own pick on Auto", () => {
  const picks = { claude: "sonnet", cursor: "cursor-sonnet" };
  assert.equal(friendModel({ felixTool: "claude", felixFriendModel: "auto" }, "claude", picks), "sonnet");
  assert.equal(friendModel({ felixTool: "claude", felixFriendModel: "opus" }, "claude", picks), "opus");
  assert.equal(friendModel({ felixTool: "auto", felixFriendModel: "opus" }, "cursor", picks), "cursor-sonnet", "Auto picks for the tool in use");
  assert.equal(friendModel({}, "claude", picks), "sonnet");
});

test("quiet hours can run past midnight, and are off when switched off or from and until match", () => {
  const at = (h) => Date.parse(`2026-10-30T${String(h).padStart(2, "0")}:30:00Z`);
  const utc = "UTC";
  assert.deepEqual([21, 22, 23, 0, 6, 7, 12].map((h) => inQuietHours({}, at(h), utc)), [false, true, true, true, true, false, false]);
  assert.deepEqual([12, 13, 14].map((h) => inQuietHours({ felixQuietFrom: 13, felixQuietTo: 14 }, at(h), utc)), [false, true, false]);
  assert.equal(inQuietHours({ felixQuietOn: false }, at(23), utc), false);
  assert.equal(inQuietHours({ felixQuietFrom: 5, felixQuietTo: 5 }, at(5), utc), false);
  assert.equal(inQuietHours({}, Date.parse("2026-10-30T15:00:00Z"), "Asia/Manila"), true, "11 PM in Manila");
});

test("personal talk writes no memory cards when Settings keep it out of memory, or in a crisis", () => {
  const NO_CARDS = /Don't write, change or delete any memory card/;
  assert.doesNotMatch(friendLine({}), NO_CARDS);
  assert.match(friendLine({ felixFriendRemember: "work" }), NO_CARDS);
  assert.match(friendLine({ felixMemoryLearn: false }), NO_CARDS);
  assert.match(friendLine({}, { crisis: true }), NO_CARDS);
});
