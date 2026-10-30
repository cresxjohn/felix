import { test } from "node:test";
import assert from "node:assert/strict";
import {
  FACT_SOURCES, ageOf, calendarRecord, createFacts, jiraRecord, oooRecord, tasksRecord, dayText, htmlText, isIsoTime, musicRecord, oncallRecord, prDetailRecord, prsRecord, relText,
  releasesRecord, timeText, usageRecord, whenText,
} from "../felix-facts.mjs";
import { CAL, IC, JIRA, MUSIC, NOW, OOO, PRS, PR_DETAIL, RELEASES, TASKS, TZ, USAGE, fakeFacts } from "./felix-fixtures.mjs";

const HOUR = 3600e3;

test("times and days read the way people say them", () => {
  assert.equal(timeText("2026-10-29T14:00:00Z", TZ), "10 PM");
  assert.equal(timeText("2026-10-30T00:30:00Z", TZ), "8:30 AM");
  assert.equal(dayText("2026-10-29T14:00:00Z", NOW, TZ), "today");
  assert.equal(dayText("2026-10-30T00:00:00Z", NOW, TZ), "tomorrow");
  assert.equal(dayText("2026-10-28T03:00:00Z", NOW, TZ), "yesterday");
  assert.equal(dayText("2026-11-02T00:00:00Z", NOW, TZ), "Mon, Nov 2");
  assert.equal(whenText("2026-10-29T14:00:00Z", NOW, TZ), "today at 10 PM");
});

test("relative times round to the nearest unit", () => {
  assert.equal(relText(NOW + 4 * 24 * HOUR, NOW), "in 4 days");
  assert.equal(relText(NOW + HOUR, NOW), "in 1 hour");
  assert.equal(relText(NOW - 20 * 60e3, NOW), "20 minutes ago");
  assert.equal(relText(NOW + 10e3, NOW), "just now");
});

test("ISO times are told apart from other strings", () => {
  assert.equal(isIsoTime("2026-10-29T14:00:00Z"), true);
  assert.equal(isIsoTime("2026-10-29T14:00:00.123+08:00"), true);
  assert.equal(isIsoTime("today at 10 PM"), false);
  assert.equal(isIsoTime(12), false);
});

test("the on-call record marks who's on now and your next shift", () => {
  const r = oncallRecord(IC, NOW, TZ);
  const [now, next, mine] = r.schedules[0].shifts;
  assert.equal(r.schedules[0].schedule, "Engineering IC");
  assert.deepEqual([now.who, now.onNow, now.until], ["Sonito Mole", true, "today at 10 PM"]);
  assert.deepEqual([next.who, next.onNow, next.from, next.startsIn], ["Anna Reyes", false, "today at 10 PM", "in 2 hours"]);
  assert.equal(mine.mine, true);
  assert.deepEqual([r.yourNextShift.from, r.yourNextShift.schedule], ["Mon, Nov 2 at 8 AM", "Engineering IC"]);
  assert.deepEqual(oncallRecord({}, NOW, TZ), { schedules: [], yourNextShift: null });
  assert.equal(oncallRecord({ schedules: [{ name: "x", shifts: [{ start: IC.myNext.start, end: IC.myNext.end }] }] }, NOW, TZ).schedules[0].shifts[0].who, "nobody");
});

test("the PRs record counts what the Open PRs card shows", () => {
  const r = prsRecord(PRS, NOW);
  assert.equal(r.you, "me");
  assert.deepEqual(r.yourPrs.map((p) => p.ref), ["fm#101", "fm#102", "fm#103", "fm#104"]);
  assert.deepEqual(r.counts, { yourPrs: 4, waitingOnYourReview: 1, yourPrsFailingChecks: 1, yourPrsWithConflicts: 1, yourPrsReadyToMerge: 2 });
  assert.deepEqual(r.waitingOnYourReview.map((p) => p.ref), ["bm#201"]);
  assert.deepEqual(r.reviewedEarlier.map((p) => p.ref), ["bm#202"]);
  assert.deepEqual(r.yourPrs[1].failingChecks, ["lint", "unit tests"]);
  assert.equal(r.yourPrs[0].updated, "2 hours ago");
  const bare = prsRecord({ login: "me", lists: { mine: [{ key: "fm", prs: [{ number: 1, title: "t", updatedAt: "2026-10-29T12:00:00Z" }] }], review: [] } }, NOW);
  assert.deepEqual([bare.yourPrs[0].checks, bare.yourPrs[0].failingChecks, bare.yourPrs[0].approvedBy], ["none", [], []]);
});

test("the releases, usage and music records keep only what Felix needs", () => {
  const rel = releasesRecord(RELEASES, NOW, TZ);
  assert.deepEqual(rel.repos[0].openRelease, { ref: "fm#300", title: "Release", checks: "passing", approved: true, inMergeQueue: false, packages: 2 });
  assert.deepEqual(rel.repos[0].lastRelease, { ref: "fm#299", merged: "yesterday at 5 PM", dev: "success", prod: "success" });
  assert.deepEqual(rel.repos[0].yourPrsInIt, ["fm#101"]);
  assert.deepEqual(rel.repos[1], { repo: "bm", openRelease: null, yourPrsInIt: [], lastRelease: null });
  assert.equal(releasesRecord({ repos: [{ key: "fm", last: { number: 1, mergedAt: RELEASES.repos[0].last.mergedAt, dev: { status: "in_progress" } } }] }, NOW, TZ).repos[0].lastRelease.prod, "unknown");
  assert.deepEqual(releasesRecord({}, NOW, TZ), { repos: [] });

  const use = usageRecord(USAGE, NOW, TZ);
  assert.deepEqual(use.tools[0].limits, [{ limit: "5-hour", percentUsed: 42, resets: "today at 10 PM" }, { limit: "weekly", percentUsed: 18, resets: null }]);
  assert.equal(use.tools[0].extraUsage, "3 USD");
  assert.equal(use.tools[0].atALimit, "keeps working, billed as extra usage");
  assert.deepEqual(use.tools[1], { tool: "Cursor", plan: null, error: "Not signed in", limits: [], extraUsage: null, atALimit: "stops until the limit resets" });
  assert.deepEqual(usageRecord({}, NOW, TZ), { tools: [] });

  assert.deepEqual(musicRecord(MUSIC), { playing: true, song: "Blue Song", artists: "The Band", device: "Felix" });
  assert.deepEqual(musicRecord({ playing: false, track: null, device: null }), { playing: false, song: null, artists: null, device: null });
});

test("a PR's details become text, cut to size", () => {
  assert.equal(htmlText("<p>a &amp; b&nbsp;&lt;c&gt; &quot;d&quot; &#39;e&#39;</p>"), `a & b <c> "d" 'e'`);
  assert.equal(htmlText(), "");
  const r = prDetailRecord("fm", PR_DETAIL);
  assert.equal(r.ref, "fm#101");
  assert.equal(r.state, "OPEN");
  assert.equal(r.description, "Adds & fixes");
  assert.deepEqual(r.files, ["a.ts (+10 -2)", "b.bin (+0 -0)"]);
  assert.equal(r.diff, "--- a.ts\n@@ -1 +1 @@\n");
  assert.deepEqual(r.failingChecks, ["e2e"]);
  assert.deepEqual(r.reviewers, [{ who: "anna", state: "APPROVED" }, { who: "sonito", state: "requested" }]);
  assert.deepEqual(r.conversation[0], { who: "anna", kind: "review approved", text: "Looks good" });
  assert.equal(r.conversation[1].kind, "comment");
  const big = prDetailRecord("fm", { ...PR_DETAIL, draft: true, files: Array.from({ length: 3 }, (_, i) => ({ name: `f${i}`, patch: "x".repeat(5000) })) });
  assert.equal(big.state, "draft");
  assert.equal(big.diff.length, 8000);
  const empty = prDetailRecord("bm", { number: 2 });
  assert.deepEqual([empty.files, empty.commits, empty.tickets, empty.conversation], [[], [], [], []]);
});

test("the reader returns each source's record, link and time, or its error", async () => {
  assert.deepEqual(FACT_SOURCES, ["oncall", "prs", "releases", "usage", "music", "pr", "calendar", "jira", "ooo", "tasks"]);
  const facts = fakeFacts(["releases"]);
  const oncall = await facts.read("oncall");
  assert.deepEqual([oncall.source, oncall.fetchedAt, oncall.link], ["Datadog", IC.fetchedAt, IC.schedules[0].url]);
  assert.equal(oncall.record.schedules[0].shifts[0].who, "Sonito Mole");
  const music = await facts.read("music");
  assert.deepEqual([music.source, music.fetchedAt, music.link], ["Spotify", new Date(NOW).toISOString(), null]);
  const one = await facts.read("pr", { repo: "fm", number: 101 });
  assert.deepEqual([one.link, one.record.ref], [PR_DETAIL.url, "fm#101"]);
  assert.equal((await facts.read("prs")).link, "/prs/mine");
  assert.equal((await facts.read("usage")).link, USAGE.tools[0].url);
  const down = await facts.read("releases");
  assert.deepEqual([down.source, down.error, down.record], ["GitHub releases", "releases is down", undefined]);
  assert.equal((await facts.read("slack")).error, "Felix can't read that yet.");
});

test("a reader that fails without a message, or returns nothing, still gives a fact", async () => {
  const facts = createFacts({ readers: { music: async () => { throw new Error(""); }, prs: async () => null }, now: () => NOW, timeZone: TZ });
  assert.equal((await facts.read("music")).error, "It didn't answer.");
  const empty = await createFacts({ readers: { oncall: async () => null }, now: () => NOW }).read("oncall");
  assert.deepEqual(empty.record, { schedules: [], yourNextShift: null });
  assert.equal(empty.link, null);
  assert.ok((await facts.read("prs")).error);
});

test("old data says how old it is; fresh data and the slow-changing on-call schedule don't", async () => {
  assert.equal(ageOf("2026-10-29T11:50:00Z", 5 * 60e3, NOW), "10 minutes ago");
  assert.equal(ageOf("2026-10-29T11:58:00Z", 5 * 60e3, NOW), undefined);
  assert.equal(ageOf("not a time", 0, NOW), undefined);
  const facts = fakeFacts();
  assert.equal((await facts.read("releases")).asOf, "10 minutes ago");
  assert.equal("asOf" in (await facts.read("prs")), false);
  const oldCall = fakeFacts([], { oncall: { ...IC, fetchedAt: "2026-10-29T11:10:00Z" } });
  assert.equal("asOf" in (await oldCall.read("oncall")), false);
  const olderCall = fakeFacts([], { oncall: { ...IC, fetchedAt: "2026-10-29T09:00:00Z" } });
  assert.equal((await olderCall.read("oncall")).asOf, "3 hours ago");
});

test("the calendar record says each event's time the way people do, what's on now, and your answer to it", () => {
  const r = calendarRecord(CAL, NOW, TZ);
  assert.equal(r.events.length, 5, "an event already over is left out");
  assert.deepEqual(r.events[0], {
    id: "e0", title: "Design sync", when: "today at 7:30 PM", until: "8:15 PM", startsIn: "30 minutes ago", onNow: true, allDay: false,
    yourAnswer: "yes", hasJoinLink: true, start: CAL.events[0].start, end: CAL.events[0].end,
  });
  assert.equal(r.events[1].yourAnswer, "not answered");
  assert.equal(r.events[2].yourAnswer, "maybe");
  assert.equal(r.events[3].yourAnswer, "no");
  assert.equal(r.events[4].when, "tomorrow, all day");
  assert.equal(r.events[4].until, null);
  assert.equal(r.events[4].yourAnswer, null);
  assert.equal(r.nextMeeting, "Release review");
  assert.equal(r.canAnswerInvites, true);
  assert.deepEqual(calendarRecord({}, NOW, TZ), { events: [], nextMeeting: null, canAnswerInvites: false });
});

test("the Jira record lists your open tickets with their status, and the sprint's counts", () => {
  const r = jiraRecord(JIRA);
  assert.deepEqual(r.yourOpenTickets[0], { key: "PMHUB-1", summary: "Bulk invite retries", status: "In Progress", url: "https://purepm.atlassian.net/browse/PMHUB-1" });
  assert.deepEqual([r.board, r.sprint, r.doneInSprint, r.totalInSprint, r.columns.length], ["Portalverse", "Sprint 42", 7, 15, 3]);
  assert.deepEqual(jiraRecord({}), { board: null, sprint: null, yourOpenTickets: [], doneInSprint: 0, totalInSprint: 0, columns: [] });
});

test("the out-of-office record keeps people and holidays apart, with their days said plainly", () => {
  const r = oooRecord(OOO, NOW, TZ);
  assert.deepEqual(r.out[0], { who: "Ana Cruz", kind: "VL", note: null, from: "today", to: "tomorrow", onYourTeam: true, fromDay: "2026-10-29", toDay: "2026-10-30" });
  assert.equal(r.out.length, 4);
  assert.deepEqual(r.holidays, [{ name: "All Saints' Day (PH Holiday)", from: "Mon, Nov 2", to: "Mon, Nov 2", fromDay: "2026-11-02", toDay: "2026-11-02" }]);
  assert.equal(r.teamSize, 4);
  assert.deepEqual(oooRecord({ out: [{ name: "Colombia", kind: "Holiday", holiday: true, from: "2026-11-02", to: "2026-11-02" }] }, NOW, TZ).holidays[0].name, "the Colombia holiday");
  assert.deepEqual(oooRecord({}, NOW, TZ), { from: null, to: null, out: [], holidays: [], teamSize: null });
});

test("the tasks record splits open tasks from the ones done today, and marks the overdue ones", () => {
  const r = tasksRecord(TASKS);
  assert.deepEqual(r.open, [{ title: "Write the release notes", due: "2026-10-29", at: "15:00", overdue: false }, { title: "Old one", due: "2026-10-27", at: null, overdue: true }]);
  assert.deepEqual(r.doneToday, ["Done thing"]);
  assert.deepEqual(tasksRecord({}), { today: null, open: [], doneToday: [] });
});

test("the new sources read through the same reader, with their own names and links", async () => {
  const facts = fakeFacts();
  const cal = await facts.read("calendar");
  assert.deepEqual([cal.source, cal.link], ["Google Calendar", "https://calendar.google.com/"]);
  const jira = await facts.read("jira");
  assert.deepEqual([jira.source, jira.link], ["Jira", "https://purepm.atlassian.net/jira/your-work"]);
  assert.equal((await fakeFacts([], { jira: { ...JIRA, site: undefined } }).read("jira")).link, null);
  const ooo = await facts.read("ooo");
  assert.deepEqual([ooo.source, ooo.link], ["Team out of office", null]);
  const tasks = await facts.read("tasks");
  assert.deepEqual([tasks.source, tasks.link], ["Tasks", "/"]);
});
