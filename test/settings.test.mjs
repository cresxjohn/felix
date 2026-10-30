import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createSettings } from "../settings.mjs";
import {
  GROUPS, PROGRESS_PHRASES, SETTINGS, acceptsValue, applies, changeFor, cleanSettings, defaultSettings, patchProblems, placeholderFor, settingsIn, wakePhrase,
} from "../public/settings-schema.mjs";

// The card groups at their defaults, which keep each card as it was before it had settings.
const CARD_DEFAULTS = {
  cardIcons: true, cardLinks: true, cardUpdated: true,
  icNext: true, icMine: true, icLookahead: 45, icDays: 2, icComingUp: 2, icTable: true, icZone: false, icCache: 60, icRefresh: 0,
  jiraBoard: "181", jiraWhose: "mine", jiraSprint: "left", jiraProgress: true, jiraEmpty: true, jiraHide: "", jiraPlate: 3, jiraCache: 1, jiraRefresh: 0,
  prsTotals: true, prsNeeds: "always", prsNewCommits: "some", prsAiReview: "always", prsReadyMerge: "always", prsFailing: "always",
  prsConflict: "some", prsQueue: "some", prsChanges: "some", prsAiFix: "some", prsRepos: "both", prsReleases: true, prsRefresh: 0,
  prsPageTab: "mine", prsPageSort: "attention", prsPageGroup: true, prsPageRefresh: 5,
  aiClaude: true, aiCursor: true, aiOwnColours: true, aiWarnAt: 80, aiBadAt: 100, aiSpend: true, aiCache: 2, aiRefresh: 0,
  calDays: 2, calPast: true, calAllDay: true, calDeclined: false, calReplies: true, calJoin: "next", calCountdown: true, calCache: 5, calRefresh: 0,
  slackDays: 3, slackSaved: true, slackWatch: "", slackCache: 2, slackRefresh: 0,
  oooView: "last", oooWho: "last", oooAhead: 60, oooKind: true, oooNote: true, oooWhole: true, oooNew: true, oooCache: 5, oooRefresh: 0,
  tasksView: "last", ptasksView: "last", tasksUpcoming: true, tasksOverdue: "work", tasksSomeday: true, tasksDone: true, tasksDoneToday: true,
  tasksNewAt: "top", tasksPriority: 0, tasksAtPm: 7, tasksLabels: true, tasksLinks: 2, tasksSubs: true, tasksRepeat: true, tasksDrag: true,
  tasksReminders: true, tasksSound: "Glass", tasksRefresh: 0,
};

const DEFAULTS = {
  ...CARD_DEFAULTS,
  mode: "work", theme: "system", accentWork: "default", accentPersonal: "default", felixChatEars: true, felixKeepListening: true, felixPermissions: "ask", felixChatStyle: "bubbles", felixVoiceWhere: "auto", felixReplyWait: 7, felixReplyChime: true, fitToScreen: false, autoRefresh: true, refreshMinutes: 1, musicSeekSeconds: 10, musicLyrics: true,
  felixOn: true, felixTool: "auto", felixModel: "auto", felixCursorFallback: true,
  felixTalk: "voice", felixVoice: "am_michael", felixSpeed: 1,
  felixName: "Felix", felixWake: "", felixWakeOn: false, felixWakeName: true, felixWakeLevel: "normal", felixMic: "", felixLearnPhrases: true, felixLeanAt: 80,
  felixVoiceEngine: "kokoro", felixMacVoice: "", felixBargeIn: true, felixPttKey: "", felixMuteKey: "shift-meta-m", felixMuted: false, felixPausedUntil: "",
  felixSpeakUp: false, felixSpeakReviews: true, felixSpeakFixes: true, felixQuietMeetings: true, felixAwayMinutes: 5, felixCare: false, felixCareAfter: 120, felixWords: "",
  felixYourName: "", felixTone: "casual", felixChatty: "normal", felixHumor: "some",
  felixProgress: true, felixProgressDelay: 1.5, felixProgressEvery: 0, felixProgressPhrases: PROGRESS_PHRASES.join("\n"), felixMemoryLearn: true, felixMemoryAfter: 10, felixFriendOn: true, felixFriendPersonality: "warm", felixFriendModel: "auto", felixFriendRemember: "everything", felixQuietOn: true, felixQuietFrom: 22, felixQuietTo: 7,
  shiftOn: true, shiftHours: 9, shiftBreakPauses: false, shiftReminder: true, shiftSnooze: 30, shiftSlack: true,
  shiftMorning: "Good morning", shiftAfternoon: "Good afternoon", shiftEvening: "Good evening",
  shiftBreak: "Be right back!", shiftBack: "I'm back!", shiftBye: "Bye for now!",
};

/**
 * A settings store over an in-memory file.
 * @param {string | null} [saved] What the file holds; null for no file.
 * @returns {{ store: ReturnType<typeof createSettings>, writes: string[] }}
 */
function memoryStore(saved = null) {
  const writes = [];
  const read = async () => {
    if (saved === null) throw Object.assign(new Error("missing"), { code: "ENOENT" });
    return saved;
  };
  const write = async (_file, text) => { writes.push(text); };
  return { store: createSettings({ file: "settings.json", read, write }), writes };
}

test("every setting has a known group, a label, help and a default it accepts", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  for (const s of SETTINGS) {
    assert.ok(groups.has(s.group), s.key);
    assert.ok(s.label && s.help, s.key);
    assert.ok(acceptsValue(s, s.default), s.key);
  }
  assert.deepEqual(defaultSettings(), DEFAULTS);
});

test("a setting that depends on another names a known on-and-off setting", () => {
  for (const s of SETTINGS.filter((x) => x.requires)) {
    assert.equal(SETTINGS.find((x) => x.key === s.requires)?.type, "boolean", s.key);
  }
});

test("the mode menu lists Personal before Work", () => {
  assert.deepEqual(SETTINGS.find((s) => s.key === "mode").options.map((o) => o.value), ["personal", "work"]);
});

test("settingsIn lists a group's settings in order", () => {
  assert.deepEqual(settingsIn("refresh").map((s) => s.key), ["autoRefresh", "refreshMinutes"]);
  assert.deepEqual(settingsIn("nope"), []);
});

test("acceptsValue checks booleans by type and choices by their options", () => {
  const fit = SETTINGS.find((s) => s.key === "fitToScreen");
  const every = SETTINGS.find((s) => s.key === "refreshMinutes");
  assert.equal(acceptsValue(fit, true), true);
  assert.equal(acceptsValue(fit, "true"), false);
  assert.equal(acceptsValue(every, 5), true);
  assert.equal(acceptsValue(every, "5"), false);
  assert.equal(acceptsValue(every, 3), false);
});

test("a model setting takes any model id its AI tool might list, and nothing else", () => {
  const model = SETTINGS.find((s) => s.key === "felixModel");
  assert.equal(SETTINGS.find((s) => s.key === model.tool)?.type, "choice");
  for (const id of ["auto", "opus", "composer-2.5-fast", "claude-opus-5-5-medium", "gpt-5.6[effort=high]"]) assert.equal(acceptsValue(model, id), true, id);
  for (const id of ["", "a b", "x".repeat(101), 5, null]) assert.equal(acceptsValue(model, id), false, String(id));
});

test("applies needs a setting's switch on and the values it depends on", () => {
  const backup = SETTINGS.find((s) => s.key === "felixCursorFallback");
  assert.equal(applies(backup, { felixOn: true, felixTool: "claude" }), true);
  assert.equal(applies(backup, { felixOn: true, felixTool: "auto" }), false);
  assert.equal(applies(backup, { felixOn: false, felixTool: "claude" }), false);
  assert.equal(applies(SETTINGS.find((s) => s.key === "mode"), {}), true);
});

test("changeFor puts the settings a change resets back to their defaults", () => {
  assert.deepEqual(changeFor("felixTool", "cursor"), { felixModel: "auto", felixFriendModel: "auto", felixTool: "cursor" });
  assert.deepEqual(changeFor("mode", "personal"), { mode: "personal" });
  assert.deepEqual(changeFor("colour", "red"), { colour: "red" });
});

test("the voice and speed settings offer a sample to hear", () => {
  assert.deepEqual(SETTINGS.filter((s) => s.sample).map((s) => s.key), ["felixVoice", "felixMacVoice", "felixSpeed"]);
});

test("cleanSettings keeps good values, drops unknown keys and puts bad ones back to their defaults", () => {
  assert.deepEqual(cleanSettings(null), DEFAULTS);
  assert.deepEqual(cleanSettings("x"), DEFAULTS);
  assert.deepEqual(cleanSettings({ mode: "personal", fitToScreen: "yes", refreshMinutes: 10, extra: 1 }),
    { ...DEFAULTS, mode: "personal", refreshMinutes: 10 });
});

test("patchProblems explains each bad key or value in plain words", () => {
  assert.deepEqual(patchProblems({ fitToScreen: true, refreshMinutes: 2 }), []);
  assert.deepEqual(patchProblems(null), ["Send the settings to change as an object."]);
  assert.deepEqual(patchProblems([1]), ["Send the settings to change as an object."]);
  assert.deepEqual(patchProblems({ colour: "red", mode: "play" }), ['There is no setting called "colour".', `Mode can't be "play".`]);
});

test("get gives the defaults when there is no file, or the file is broken", async () => {
  assert.deepEqual(await memoryStore().store.get(), DEFAULTS);
  assert.deepEqual(await memoryStore("{not json").store.get(), DEFAULTS);
});

test("get reads the saved file once and hands out copies", async () => {
  const { store } = memoryStore(JSON.stringify({ mode: "personal" }));
  const first = await store.get();
  first.mode = "work";
  assert.equal((await store.get()).mode, "personal");
});

test("update saves the change with the rest, and refuses bad changes with a 400", async () => {
  const { store, writes } = memoryStore(JSON.stringify({ refreshMinutes: 5 }));
  assert.deepEqual(await store.update({ fitToScreen: true }), { ...DEFAULTS, refreshMinutes: 5, fitToScreen: true });
  assert.deepEqual(JSON.parse(writes.at(-1)), { ...DEFAULTS, refreshMinutes: 5, fitToScreen: true });
  await assert.rejects(store.update({ refreshMinutes: 7 }), (e) => e.status === 400 && /Refresh every/.test(e.message));
  await assert.rejects(store.update("x"), (e) => e.status === 400);
  assert.equal(writes.length, 1);
});

test("reset puts named settings, or all of them, back to their defaults", async () => {
  const { store } = memoryStore(JSON.stringify({ mode: "personal", fitToScreen: true, refreshMinutes: 15 }));
  assert.deepEqual(await store.reset(["refreshMinutes"]), { ...DEFAULTS, mode: "personal", fitToScreen: true });
  assert.deepEqual(await store.reset(), DEFAULTS);
  await assert.rejects(store.reset(["colour"]), (e) => e.status === 400);
  await assert.rejects(store.reset("mode"), (e) => e.status === 400);
});

test("saves go out one at a time, in order, and one failed write doesn't stop the next", async () => {
  const order = [];
  let fail = true;
  const write = async (_file, text) => {
    await new Promise((r) => setTimeout(r, 5));
    if (fail) { fail = false; throw new Error("disk full"); }
    order.push(JSON.parse(text).refreshMinutes);
  };
  const store = createSettings({ file: "s.json", read: async () => "{}", write });
  const results = await Promise.allSettled([store.update({ refreshMinutes: 2 }), store.update({ refreshMinutes: 5 }), store.update({ refreshMinutes: 10 })]);
  assert.equal(results[0].status, "rejected");
  assert.deepEqual(order, [5, 10]);
});

test("the default writer saves to disk in one step", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-settings-"));
  try {
    const file = path.join(dir, "settings.json");
    const store = createSettings({ file });
    await store.update({ mode: "personal" });
    assert.equal(JSON.parse(await readFile(file, "utf8")).mode, "personal");
    assert.equal((await createSettings({ file }).get()).mode, "personal");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("the theme follows the Mac unless set to dark or light", () => {
  const theme = SETTINGS.find((s) => s.key === "theme");
  assert.deepEqual(theme.options.map((o) => o.value), ["system", "dark", "light"]);
  assert.equal(theme.default, "system");
  assert.equal(acceptsValue(theme, "dark"), true);
  assert.equal(acceptsValue(theme, "sepia"), false);
});

test("text settings take typed text within their length and pattern, with line breaks only in a box of lines", () => {
  const name = SETTINGS.find((s) => s.key === "felixName");
  const phrases = SETTINGS.find((s) => s.key === "felixProgressPhrases");
  const you = SETTINGS.find((s) => s.key === "felixYourName");
  assert.equal(acceptsValue(name, "Max"), true);
  assert.equal(acceptsValue(name, "Mary Jo"), true);
  assert.equal(acceptsValue(name, ""), false);
  assert.equal(acceptsValue(name, "R2D2"), false);
  assert.equal(acceptsValue(name, "x".repeat(21)), false);
  assert.equal(acceptsValue(name, 5), false);
  assert.equal(acceptsValue(you, ""), true);
  assert.equal(acceptsValue(you, "Cres\nJohn"), false);
  assert.equal(acceptsValue(phrases, "Hold on, {step}.\nStill {step}."), true);
  assert.equal(acceptsValue(phrases, "tab\there"), false);
  assert.equal(acceptsValue(phrases, "x".repeat(1001)), false);
  assert.deepEqual(patchProblems({ felixName: "" }), ["Felix's name can't be \"\"."]);
});

test("the activation phrase follows Felix's name unless you write your own", () => {
  const wake = SETTINGS.find((s) => s.key === "felixWake");
  assert.equal(placeholderFor(wake, { felixName: "Max" }), "Hey Max");
  assert.equal(placeholderFor(wake, {}), "Hey ");
  assert.equal(placeholderFor(SETTINGS.find((s) => s.key === "felixName"), {}), "");
  assert.equal(wakePhrase({ felixName: "Max", felixWake: "" }), "Hey Max");
  assert.equal(wakePhrase({ felixName: "Max", felixWake: "  Yo buddy " }), "Yo buddy");
  assert.equal(wakePhrase({}), "Hey Felix");
});

test("the progress line settings depend on their switch, and the tone settings on Felix", () => {
  for (const key of ["felixProgressDelay", "felixProgressEvery", "felixProgressPhrases"]) {
    assert.equal(SETTINGS.find((s) => s.key === key).requires, "felixProgress", key);
  }
  for (const key of ["felixName", "felixWake", "felixYourName", "felixTone", "felixChatty", "felixHumor", "felixProgress"]) {
    assert.equal(SETTINGS.find((s) => s.key === key).requires, "felixOn", key);
  }
  assert.ok(PROGRESS_PHRASES.every((p) => p.includes("{step}")));
});

test("listening for the phrase is off by default, and its settings depend on it", () => {
  const by = (key) => SETTINGS.find((s) => s.key === key);
  assert.equal(by("felixWakeOn").default, false);
  assert.equal(by("felixWakeName").requires, "felixWakeOn");
  assert.equal(by("felixWakeLevel").requires, "felixWakeOn");
  assert.deepEqual(by("felixWakeLevel").options.map((o) => o.value), ["high", "normal", "low"]);
  assert.equal(by("felixMic").devices, true);
  assert.equal(acceptsValue(by("felixMic"), "a1b2c3d4"), true);
  assert.equal(acceptsValue(by("felixMic"), "x".repeat(201)), false);
});

test("each live card has its own group, with a Refresh every that follows Auto refresh and a choice to reload only by hand", () => {
  for (const id of ["ic", "jira", "prs", "ai", "cal", "ooo", "tasks"]) {
    assert.ok(GROUPS.some((g) => g.id === id), id);
    const refresh = SETTINGS.find((s) => s.key === `${id}Refresh`);
    assert.equal(refresh.group, id);
    assert.equal(refresh.requires, "autoRefresh");
    assert.deepEqual([refresh.options[0].value, refresh.options.at(-1).value], [0, -1]);
  }
  assert.deepEqual(settingsIn("ic").map((s) => s.key).slice(-2), ["icCache", "icRefresh"]);
});

test("the card settings' small headings come in one run each, within their group", () => {
  for (const g of GROUPS) {
    const seen = new Set();
    let last = "";
    for (const s of settingsIn(g.id).filter((x) => x.part)) {
      if (s.part !== last) assert.ok(!seen.has(s.part), `${g.id}: ${s.part} comes back`);
      seen.add(s.part);
      last = s.part;
    }
  }
});

test("the Jira board takes a board number only, and the menus with minutes say them plainly", () => {
  const board = SETTINGS.find((s) => s.key === "jiraBoard");
  for (const ok of ["181", "7", "123456789"]) assert.equal(acceptsValue(board, ok), true, ok);
  for (const bad of ["", "0", "0181", "18a", "1234567890", 181]) assert.equal(acceptsValue(board, bad), false, String(bad));
  assert.deepEqual(SETTINGS.find((s) => s.key === "icCache").options.map((o) => o.label), ["15 minutes", "30 minutes", "1 hour", "2 hours", "4 hours"]);
  assert.equal(SETTINGS.find((s) => s.key === "jiraCache").options[0].label, "1 minute");
  assert.deepEqual(patchProblems({ calJoin: 10, tasksSound: "none", jiraHide: "Done\nBlocked" }), []);
  assert.deepEqual(patchProblems({ calJoin: 7 }), ["Join stands out can't be 7."]);
});

test("onChange hears every saved change and reset, a throwing listener doesn't stop the save, and it can stop", async () => {
  const { store } = memoryStore();
  const heard = [];
  store.onChange(() => { throw new Error("boom"); });
  const stop = store.onChange((s) => heard.push(s.calDays));
  assert.equal((await store.update({ calDays: 5 })).calDays, 5);
  await store.reset(["calDays"]);
  stop();
  await store.update({ calDays: 7 });
  assert.deepEqual(heard, [5, 2]);
});

test("voice and presence: speaking up and nudges are off by default, the pause is Felix's own, and it only takes a time", () => {
  const by = (key) => SETTINGS.find((s) => s.key === key);
  assert.equal(by("felixSpeakUp").default, false);
  assert.equal(by("felixCare").default, false);
  assert.equal(by("felixPausedUntil").hidden, true);
  assert.equal(acceptsValue(by("felixPausedUntil"), "2026-10-30T03:30:00.000Z"), true);
  assert.equal(acceptsValue(by("felixPausedUntil"), ""), true);
  assert.equal(acceptsValue(by("felixPausedUntil"), "soon"), false);
  assert.equal(by("felixMacVoice").voices, true);
  assert.deepEqual(by("felixMacVoice").only, { felixVoiceEngine: ["mac"] });
  assert.deepEqual(by("felixPttKey").options.map((o) => o.value), ["", "AltRight", "ControlRight", "MetaRight", "F5"]);
});
