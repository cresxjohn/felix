import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SCOPES, TASK_PREFS, VIEWS, addDays, createTasks, nextDue, parseQuick, taskPrefs, ymd } from "../tasks.mjs";

const HOUR = 3600e3;
// 9:00 AM on Friday 30 October 2026 on this Mac's clock, so days read the same in any time zone.
const NOW = new Date(2026, 9, 30, 9, 0, 0).getTime();
const TODAY = ymd(NOW);
const dow = (day) => new Date(`${day}T12:00:00`).getDay();
/** The first day after `day` (or on it, with `orSame`) that falls on a weekday number. */
function nextWeekday(day, want, orSame = false) {
  let d = orSame ? day : addDays(day, 1);
  while (dow(d) !== want) d = addDays(d, 1);
  return d;
}

/** A task store in memory with a clock the test moves. */
async function store(t = NOW) {
  const clock = { t };
  const tasks = await createTasks({ file: ":memory:", now: () => clock.t });
  return { tasks, clock };
}

const titles = (list) => list.tasks.map((t) => t.title);

test("ymd and addDays read days on this Mac's clock", () => {
  assert.equal(TODAY, "2026-10-30");
  assert.equal(addDays("2026-10-30", 2), "2026-11-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.deepEqual(SCOPES, ["work", "personal"]);
  assert.ok(VIEWS.includes("someday"));
});

test("nextDue steps each repeat rule forward", () => {
  assert.equal(nextDue("every day", TODAY, TODAY), addDays(TODAY, 1));
  assert.equal(nextDue("daily", TODAY, TODAY), addDays(TODAY, 1));
  assert.equal(nextDue("every week", TODAY, TODAY), addDays(TODAY, 7));
  assert.equal(nextDue("weekly", TODAY, TODAY), addDays(TODAY, 7));
  assert.equal(nextDue("every sprint", TODAY, TODAY), addDays(TODAY, 14));
  assert.equal(nextDue("every 2 weeks", TODAY, TODAY), addDays(TODAY, 14));
  assert.equal(nextDue("every 3 days", TODAY, TODAY), addDays(TODAY, 3));
  assert.equal(nextDue("every weekday", TODAY, TODAY), nextWeekday(TODAY, 1)); // Friday to Monday
  assert.equal(nextDue("every weekday", "2026-10-27", "2026-10-27"), "2026-10-28");
  assert.equal(nextDue("every monday", TODAY, TODAY), nextWeekday(TODAY, 1));
  assert.equal(nextDue("every wed", TODAY, TODAY), nextWeekday(TODAY, 3));
  assert.equal(nextDue("every month", "2026-01-31", "2026-01-31"), "2026-02-28");
  assert.equal(nextDue("monthly", "2026-10-15", "2026-10-15"), "2026-11-15");
  assert.equal(nextDue("every fortnight", TODAY, TODAY), null);
  assert.equal(nextDue("", TODAY, TODAY), null);
});

test("nextDue counts from today when there's no day, from a later day when it's ahead, and catches up when late", () => {
  assert.equal(nextDue("every day", null, TODAY), addDays(TODAY, 1));
  assert.equal(nextDue("every day", "2026-11-10", TODAY), "2026-11-11");
  assert.equal(nextDue("every day", "2026-10-01", TODAY), TODAY);
  assert.ok(nextDue("every week", "2026-10-01", TODAY) >= TODAY);
});

test("quick add reads days: today, tonight, tomorrow, next week and in N days", () => {
  assert.deepEqual(parseQuick("Ship it today", NOW), {
    title: "Ship it", dueDate: TODAY, dueTime: null, priority: 0, tags: [], project: null, repeat: null, someday: false, links: [],
  });
  assert.equal(parseQuick("Ship it tod", NOW).dueDate, TODAY);
  const tonight = parseQuick("Pack bags tonight", NOW);
  assert.deepEqual([tonight.title, tonight.dueDate, tonight.dueTime], ["Pack bags", TODAY, "20:00"]);
  for (const word of ["tomorrow", "tmrw", "tmr"]) assert.equal(parseQuick(`Call Ana ${word}`, NOW).dueDate, addDays(TODAY, 1), word);
  assert.equal(parseQuick("Plan next week", NOW).dueDate, nextWeekday(TODAY, 1));
  assert.equal(parseQuick("Renew in 3 days", NOW).dueDate, addDays(TODAY, 3));
  assert.equal(parseQuick("Renew in a week", NOW).dueDate, addDays(TODAY, 7));
  assert.equal(parseQuick("Renew in 2 weeks", NOW).dueDate, addDays(TODAY, 14));
  assert.equal(parseQuick("Renew in one month", NOW).dueDate, "2026-11-30");
  assert.equal(parseQuick("Renew in 3 months", NOW).dueDate, "2027-01-30");
});

test("quick add reads weekdays, next weekdays, month names, ISO days and month/day", () => {
  assert.equal(parseQuick("Demo fri", NOW).dueDate, nextWeekday(TODAY, 5)); // never today
  assert.equal(parseQuick("Demo friday", NOW).dueDate, nextWeekday(TODAY, 5));
  assert.equal(parseQuick("Demo next fri", NOW).dueDate, addDays(nextWeekday(TODAY, 5), 7));
  assert.equal(parseQuick("Demo on tuesday", NOW).dueDate, nextWeekday(TODAY, 2));
  assert.equal(parseQuick("Demo thursday", NOW).dueDate, nextWeekday(TODAY, 4));
  assert.equal(parseQuick("Demo saturday", NOW).dueDate, nextWeekday(TODAY, 6));
  assert.equal(parseQuick("Demo wednesday", NOW).dueDate, nextWeekday(TODAY, 3));
  const oct = parseQuick("Halloween Oct 31", NOW);
  assert.deepEqual([oct.title, oct.dueDate], ["Halloween", "2026-10-31"]);
  assert.equal(parseQuick("Taxes on April 15th", NOW).dueDate, "2027-04-15"); // passed this year
  assert.equal(parseQuick("Party on 31 Oct", NOW).dueDate, "2026-10-31");
  assert.equal(parseQuick("Party on 3rd sept", NOW).dueDate, "2027-09-03");
  assert.equal(parseQuick("Launch 2026-11-05", NOW).dueDate, "2026-11-05");
  const slash = parseQuick("Submit report 11/3", NOW);
  assert.deepEqual([slash.title, slash.dueDate], ["Submit report", "2026-11-03"]);
  assert.equal(parseQuick("Submit report 13/3", NOW).dueDate, null);
  assert.equal(parseQuick("Submit report Oct 40", NOW).dueDate, null);
});

test("quick add keeps words that only look like a month and a number", () => {
  const p = parseQuick("Fix 2 bugs", NOW);
  assert.deepEqual([p.title, p.dueDate], ["Fix 2 bugs", null]);
  assert.equal(parseQuick("2 apples", NOW).title, "2 apples");
});

test("quick add keeps the word order when a word and number aren't a date", () => {
  assert.equal(parseQuick("Read chapter 12", NOW).title, "Read chapter 12");
  const p = parseQuick("Pay rent 31 Oct", NOW);
  assert.deepEqual([p.title, p.dueDate], ["Pay rent", "2026-10-31"]);
  assert.equal(parseQuick("Party 3rd sept", NOW).dueDate, "2027-09-03");
  assert.equal(parseQuick("Do it in 3 hours", NOW).title, "Do it in 3 hours");
});

test("quick add keeps short day names inside a sentence, and times it can't read", () => {
  assert.deepEqual([parseQuick("Fix the mon bug", NOW).title, parseQuick("Fix the mon bug", NOW).dueDate], ["Fix the mon bug", null]);
  assert.equal(parseQuick("Sun is out", NOW).title, "Sun is out");
  assert.notEqual(parseQuick("Demo fri", NOW).dueDate, null);
  assert.notEqual(parseQuick("Demo on sat", NOW).dueDate, null);
  const p = parseQuick("Meet at 13", NOW);
  assert.deepEqual([p.title, p.dueTime], ["Meet at 13", null]);
  assert.equal(parseQuick("Call 13pm", NOW).dueTime, null);
});

test("quick add reads times: 3pm, 3:30pm, 15:00, at 3, noon", () => {
  const at = (text) => parseQuick(text, NOW).dueTime;
  assert.equal(at("Call tomorrow 3pm"), "15:00");
  assert.equal(at("Call tomorrow at 3:30pm"), "15:30");
  assert.equal(at("Call tomorrow 9 am"), "09:00");
  assert.equal(at("Call tomorrow 12am"), "00:00");
  assert.equal(at("Call tomorrow 12pm"), "12:00");
  assert.equal(at("Call tomorrow 15:00"), "15:00");
  assert.equal(at("Call tomorrow at 7:05"), "07:05");
  assert.equal(at("Call tomorrow at 3"), "15:00");
  assert.equal(at("Call tomorrow at 9"), "09:00");
  assert.equal(at("Call tomorrow at noon"), "12:00");
  assert.equal(at("Call tomorrow noon"), "12:00");
  assert.equal(at("Call tomorrow at 13"), null);
  assert.equal(at("Call tomorrow 3:75pm"), null);
});

test("a time with no day is today when it's still ahead, else tomorrow", () => {
  const later = parseQuick("Standup 3pm", NOW);
  assert.deepEqual([later.title, later.dueDate, later.dueTime], ["Standup", TODAY, "15:00"]);
  const gone = parseQuick("Standup 8am", NOW);
  assert.deepEqual([gone.dueDate, gone.dueTime], [addDays(TODAY, 1), "08:00"]);
});

test("quick add reads priority, labels and a project", () => {
  assert.equal(parseQuick("Fix !high", NOW).priority, 3);
  assert.equal(parseQuick("Fix !h", NOW).priority, 3);
  assert.equal(parseQuick("Fix !1", NOW).priority, 3);
  assert.equal(parseQuick("Fix !med", NOW).priority, 2);
  assert.equal(parseQuick("Fix !low", NOW).priority, 1);
  assert.equal(parseQuick("Fix !3", NOW).priority, 1);
  assert.equal(parseQuick("Fix !!", NOW).priority, 2);
  assert.equal(parseQuick("Fix !!!", NOW).priority, 3);
  const p = parseQuick("Fix login #Review #bug #review @Portal fm#123 #123", NOW);
  assert.deepEqual(p.tags, ["review", "bug"]);
  assert.equal(p.project, "Portal");
  assert.equal(p.title, "Fix login fm#123 #123");
});

test("quick add reads repeats and sets the first day", () => {
  const r = (text) => { const p = parseQuick(text, NOW); return [p.repeat, p.dueDate]; };
  assert.deepEqual(r("Standup every day"), ["every day", TODAY]);
  assert.deepEqual(r("Standup daily"), ["every day", TODAY]);
  assert.deepEqual(r("Standup every weekday"), ["every weekday", TODAY]);
  assert.deepEqual(r("Report every week"), ["every week", TODAY]);
  assert.deepEqual(r("Report weekly"), ["every week", TODAY]);
  assert.deepEqual(r("Plan every sprint"), ["every sprint", TODAY]);
  assert.deepEqual(r("Rent every month"), ["every month", TODAY]);
  assert.deepEqual(r("Rent monthly"), ["every month", TODAY]);
  assert.deepEqual(r("Water every 2 weeks"), ["every 2 weeks", TODAY]);
  assert.deepEqual(r("Sync every monday"), ["every monday", nextWeekday(TODAY, 1, true)]);
  assert.deepEqual(r("Sync every fri"), ["every friday", TODAY]); // today is a Friday
  assert.deepEqual(r("Sync every sun"), ["every sunday", nextWeekday(TODAY, 0, true)]);
});

test("someday clears any day and time", () => {
  for (const text of ["Learn Go someday", "Learn Go some day tomorrow 3pm", "Learn Go later"]) {
    const p = parseQuick(text, NOW);
    assert.deepEqual([p.title, p.someday, p.dueDate, p.dueTime], ["Learn Go", true, null, null], text);
  }
});

test("quick add links PRs, Jira tickets and web pages", () => {
  const p = parseQuick("Review fm#12247 and BM#88 for PMHUB-123 see https://www.example.com/a?b=1 now", NOW);
  assert.equal(p.title, "Review fm#12247 and BM#88 for PMHUB-123 see now");
  assert.deepEqual(p.links, [
    { kind: "url", url: "https://www.example.com/a?b=1", label: "example.com" },
    { kind: "pr", url: "https://github.com/purepm/frontend-monorepo/pull/12247", label: "fm#12247" },
    { kind: "pr", url: "https://github.com/purepm/backend-monorepo/pull/88", label: "bm#88" },
    { kind: "jira", url: "https://purepm.atlassian.net/browse/PMHUB-123", label: "PMHUB-123" },
  ]);
  assert.equal(parseQuick("", NOW).title, "");
  assert.equal(parseQuick(undefined).title, "");
});

test("quick add doesn't throw on a link it can't read", () => {
  assert.equal(parseQuick("See https://[::1", NOW).title, "See https://[::1");
});

test("add makes a task from quick-add text, newest on top", async () => {
  const { tasks } = await store();
  const a = tasks.add({ text: "Review fm#12247 tomorrow 3pm !high #review @Portal" });
  assert.equal(a.scope, "work");
  assert.equal(a.title, "Review fm#12247");
  assert.deepEqual([a.dueDate, a.dueTime, a.priority, a.project, a.tags], [addDays(TODAY, 1), "15:00", 3, "Portal", ["review"]]);
  assert.equal(a.links[0].label, "fm#12247");
  assert.equal(a.someday, false);
  assert.equal(a.doneAt, null);
  assert.deepEqual(a.subtasks, []);
  const b = tasks.add({ text: "Groceries", scope: "personal" });
  assert.equal(b.scope, "personal");
  const c = tasks.add({ text: "Second @portal" });
  assert.equal(c.project, "Portal"); // same project, any case
  assert.ok(c.position < a.position);
  assert.deepEqual(tasks.get(a.id).title, "Review fm#12247");
  assert.throws(() => tasks.add({ text: "!high #x" }), { code: "input", message: /name/ });
  assert.throws(() => tasks.add({ text: "Nope", scope: "home" }), { code: "input" });
  assert.throws(() => tasks.get("missing"), { code: "not-found", status: 404 });
  tasks.close();
});

test("views list the right tasks with counts, labels and projects", async () => {
  const { tasks, clock } = await store();
  tasks.add({ text: "Due today today #ops" });
  tasks.add({ text: "No day" });
  tasks.add({ text: "Late 2026-10-20 #ops" });
  tasks.add({ text: "Big launch 2026-11-04 @Infra" });
  tasks.add({ text: "Soon 2026-11-02 9am" });
  tasks.add({ text: "Dream someday" });
  const done = tasks.add({ text: "Finished #old" });
  tasks.add({ text: "Home stuff", scope: "personal" });
  clock.t += HOUR;
  tasks.update(done.id, { done: true });

  const today = tasks.list();
  assert.equal(today.view, "today");
  assert.equal(today.today, TODAY);
  assert.deepEqual(titles(today), ["Late", "No day", "Due today", "Finished"]);
  assert.deepEqual(today.counts, { today: 3, upcoming: 2, overdue: 1, someday: 1 });
  assert.deepEqual(today.tags, ["ops"]);
  assert.deepEqual(today.projects, ["Infra"]);
  assert.deepEqual(titles(tasks.list({ view: "upcoming" })), ["Soon", "Big launch"]);
  assert.deepEqual(titles(tasks.list({ view: "overdue" })), ["Late"]);
  assert.deepEqual(titles(tasks.list({ view: "someday" })), ["Dream"]);
  assert.deepEqual(titles(tasks.list({ view: "done" })), ["Finished"]);
  assert.equal(tasks.list({ view: "all" }).tasks.length, 7);
  assert.deepEqual(titles(tasks.list({ scope: "personal", view: "all" })), ["Home stuff"]);
  assert.throws(() => tasks.list({ view: "week" }), { code: "input" });
  assert.throws(() => tasks.list({ scope: "x" }), { code: "input" });
});

test("a task done today stays in Today until the day ends, by this Mac's midnight", async () => {
  // Half past midnight here is still yesterday in UTC for zones east of it, so a UTC day compare would drop it.
  const { tasks, clock } = await store(new Date(2026, 9, 30, 0, 30).getTime());
  const t = tasks.add({ text: "Early bird" });
  tasks.update(t.id, { done: true });
  assert.deepEqual(titles(tasks.list()), ["Early bird"]);
  assert.equal(tasks.list().counts.today, 0);
  clock.t = new Date(2026, 9, 31, 0, 30).getTime();
  assert.deepEqual(titles(tasks.list()), []);
  assert.deepEqual(titles(tasks.list({ view: "done" })), ["Early bird"]);
});

test("search matches title or notes and treats % and _ as plain text", async () => {
  const { tasks } = await store();
  tasks.add({ text: "Fix 100% bug" });
  tasks.add({ text: "Fix 1000 bugs" });
  tasks.add({ text: "Rename a_b" });
  tasks.add({ text: "Rename axb" });
  const n = tasks.add({ text: "Plain" });
  tasks.update(n.id, { notes: "mentions back\\slash" });
  assert.deepEqual(titles(tasks.list({ q: "100%" })), ["Fix 100% bug"]);
  assert.deepEqual(titles(tasks.list({ q: "a_b" })), ["Rename a_b"]);
  assert.deepEqual(titles(tasks.list({ q: "back\\slash" })), ["Plain"]);
  assert.deepEqual(titles(tasks.list({ q: "  fix " })).sort(), ["Fix 100% bug", "Fix 1000 bugs"]);
  assert.equal(tasks.list({ q: "   " }).tasks.length, 5);
});

test("the label filter shows only tasks with that label", async () => {
  const { tasks } = await store();
  tasks.add({ text: "One #review" });
  tasks.add({ text: "Two #Review #bug" });
  tasks.add({ text: "Three" });
  assert.deepEqual(titles(tasks.list({ tag: "REVIEW" })).sort(), ["One", "Two"]);
  assert.deepEqual(titles(tasks.list({ tag: "bug", q: "two" })), ["Two"]);
});

test("update checks its input and gives coded errors", async () => {
  const { tasks } = await store();
  const t = tasks.add({ text: "Thing" });
  assert.throws(() => tasks.update(t.id, { title: "   " }), { code: "input" });
  assert.throws(() => tasks.update(t.id, { dueDate: "31/10/2026" }), { code: "input", message: /2026-10-31/ });
  assert.throws(() => tasks.update(t.id, { dueTime: "3pm" }), { code: "input", message: /15:00/ });
  assert.throws(() => tasks.update(t.id, { dueTime: "24:00" }), { code: "input" });
  assert.throws(() => tasks.update(t.id, { repeat: "every blue moon" }), { code: "input", message: /repeat/ });
  assert.throws(() => tasks.update("gone", { title: "x" }), { code: "not-found" });
});

test("update changes each field", async () => {
  const { tasks } = await store();
  const t = tasks.add({ text: "Thing someday" });
  assert.equal(t.someday, true);
  let { task, next } = tasks.update(t.id, {
    title: "  New   name ", notes: "Some notes", priority: 2, dueDate: "2026-11-02", dueTime: "10:30", project: "Ops",
    tags: ["#One", "two", "two", "1bad", "x".repeat(50)], links: [{ url: "https://a.example/x", label: "A" }, { url: "ftp://nope" }, { url: "http://b.example" }, null],
  });
  assert.equal(next, null);
  assert.deepEqual([task.title, task.notes, task.priority, task.dueDate, task.dueTime, task.someday, task.project], ["New name", "Some notes", 2, "2026-11-02", "10:30", false, "Ops"]);
  assert.deepEqual(task.tags, ["one", "two"]);
  assert.deepEqual(task.links, [{ kind: "url", url: "https://a.example/x", label: "A" }, { kind: "url", url: "http://b.example", label: "http://b.example" }]);
  ({ task } = tasks.update(t.id, { priority: 9, project: null, notes: null }));
  assert.deepEqual([task.priority, task.project, task.notes], [0, null, ""]);
  ({ task } = tasks.update(t.id, { someday: true }));
  assert.deepEqual([task.someday, task.dueDate, task.dueTime], [true, null, null]);
  ({ task } = tasks.update(t.id, { someday: false, dueDate: null, repeat: "every day" }));
  assert.deepEqual([task.someday, task.repeat], [false, "every day"]);
  ({ task } = tasks.update(t.id, { repeat: "" }));
  assert.equal(task.repeat, null);
  ({ task } = tasks.update(t.id, {}));
  assert.equal(task.title, "New name");
});

test("done keeps the first done time, and undone clears it", async () => {
  const { tasks, clock } = await store();
  const t = tasks.add({ text: "Thing" });
  const first = tasks.update(t.id, { done: true }).task.doneAt;
  assert.equal(first, new Date(NOW).toISOString());
  clock.t += HOUR;
  assert.equal(tasks.update(t.id, { done: true }).task.doneAt, first);
  assert.equal(tasks.update(t.id, { done: false }).task.doneAt, null);
});

test("done on a repeating task makes the next one with its labels, links and subtasks", async () => {
  const { tasks } = await store();
  const t = tasks.add({ text: "Water plants every monday #home fm#12 !low @Garden" });
  assert.equal(t.dueDate, nextWeekday(TODAY, 1, true));
  tasks.update(t.id, { notes: "Use the blue can" });
  tasks.add({ text: "Front porch", parentId: t.id });
  const sub2 = tasks.add({ text: "Back yard", parentId: t.id });
  tasks.update(sub2.id, { done: true });
  const { task, next } = tasks.update(t.id, { done: true });
  assert.equal(task.repeat, null);
  assert.ok(task.doneAt);
  assert.notEqual(next.id, t.id);
  assert.equal(next.title, "Water plants fm#12");
  assert.equal(next.notes, "Use the blue can");
  assert.equal(next.repeat, "every monday");
  assert.equal(next.dueDate, addDays(t.dueDate, 7));
  assert.deepEqual([next.priority, next.project, next.tags], [1, "Garden", ["home"]]);
  assert.deepEqual(next.links, task.links);
  assert.deepEqual(next.subtasks.map((s) => [s.title, s.doneAt]), [["Front porch", null], ["Back yard", null]]);
  // Ticking it again doesn't make another.
  assert.equal(tasks.update(t.id, { done: true }).next, null);
  assert.equal(tasks.list({ view: "all" }).tasks.length, 2);
});

test("a repeat set in the same change as done still makes the next one, but a subtask never repeats", async () => {
  const { tasks } = await store();
  const t = tasks.add({ text: "Report today 4pm" });
  const { next } = tasks.update(t.id, { repeat: "every day", done: true });
  assert.deepEqual([next.dueDate, next.dueTime], [addDays(TODAY, 1), "16:00"]);
  const sub = tasks.add({ text: "Part every day", parentId: next.id });
  assert.equal(tasks.update(sub.id, { done: true }).next, null);
});

test("subtasks join their parent's scope and list under it", async () => {
  const { tasks } = await store();
  const p = tasks.add({ text: "Trip", scope: "personal" });
  const a = tasks.add({ text: "Book flight", parentId: p.id, scope: "work" });
  const b = tasks.add({ text: "Pack", parentId: p.id });
  assert.equal(a.scope, "personal");
  assert.equal(a.parentId, p.id);
  assert.ok(b.position > a.position);
  const list = tasks.list({ scope: "personal", view: "all" });
  assert.deepEqual(titles(list), ["Trip"]);
  assert.deepEqual(list.tasks[0].subtasks.map((s) => s.title), ["Book flight", "Pack"]);
  assert.throws(() => tasks.add({ text: "Orphan", parentId: "nope" }), { code: "not-found" });
});

test("reorder puts tasks in the order given", async () => {
  const { tasks } = await store();
  const a = tasks.add({ text: "A" });
  const b = tasks.add({ text: "B" });
  const c = tasks.add({ text: "C" });
  assert.deepEqual(titles(tasks.list()), ["C", "B", "A"]);
  tasks.reorder([a.id, b.id, c.id]);
  assert.deepEqual(titles(tasks.list()), ["A", "B", "C"]);
  tasks.reorder("nope");
  assert.deepEqual(titles(tasks.list()), ["A", "B", "C"]);
});

test("remove deletes a task with its subtasks, labels and links", async () => {
  const { tasks } = await store();
  const p = tasks.add({ text: "Parent #x https://example.com" });
  tasks.add({ text: "Child", parentId: p.id });
  tasks.add({ text: "Keep" });
  tasks.remove(p.id);
  const d = tasks.dump();
  assert.deepEqual(d.tasks.map((t) => t.title), ["Keep"]);
  assert.deepEqual(d.taskTags, []);
  assert.deepEqual(d.links, []);
  assert.throws(() => tasks.remove(p.id), { code: "not-found" });
});

test("dueReminders fires once when a task's time comes, and not for done tasks", async () => {
  const { tasks, clock } = await store();
  const a = tasks.add({ text: "Call Ana today 10am" });
  const b = tasks.add({ text: "Ping Bo today 10am" });
  tasks.add({ text: "No time today" });
  tasks.update(b.id, { done: true });
  assert.deepEqual(tasks.dueReminders(), []);
  clock.t += HOUR;
  assert.deepEqual(tasks.dueReminders(), [{ id: a.id, title: "Call Ana", dueTime: "10:00" }]);
  assert.deepEqual(tasks.dueReminders(), []);
  // Moving the time arms it again.
  tasks.update(a.id, { dueTime: "09:30" });
  assert.equal(tasks.dueReminders().length, 1);
  tasks.update(a.id, { dueDate: null });
  assert.equal(tasks.get(a.id).dueTime, "09:30");
  assert.deepEqual(tasks.dueReminders(), []);
});

test("dump gives every table for the backup", async () => {
  const { tasks } = await store();
  tasks.add({ text: "One #a @P fm#1" });
  const d = tasks.dump();
  assert.deepEqual(Object.keys(d), ["projects", "tasks", "tags", "taskTags", "links"]);
  assert.equal(d.projects[0].name, "P");
  assert.equal(d.tags[0].name, "a");
  assert.equal(d.links[0].label, "fm#1");
  assert.equal(d.tasks[0].title, "One fm#1");
});

test("a task file is made in its folder and kept between openings", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-tasks-"));
  try {
    const file = path.join(dir, "nested", "tasks.db");
    const first = await createTasks({ file, now: () => NOW });
    first.add({ text: "Survives" });
    first.close();
    assert.ok((await stat(file)).isFile());
    const again = await createTasks({ file, now: () => NOW });
    assert.deepEqual(titles(again.list()), ["Survives"]);
    again.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a bare \"at 3\" follows the afternoon hours set in Settings", () => {
  assert.equal(parseQuick("Call at 7 tomorrow", NOW).dueTime, "19:00");
  assert.equal(parseQuick("Call at 7 tomorrow", NOW, { pmUpTo: 5 }).dueTime, "07:00");
  assert.equal(parseQuick("Call at 3 tomorrow", NOW, { pmUpTo: 0 }).dueTime, "03:00");
  assert.equal(parseQuick("Call at 11 tomorrow", NOW, { pmUpTo: 11 }).dueTime, "23:00");
  assert.equal(parseQuick("Call at 3pm tomorrow", NOW, { pmUpTo: 0 }).dueTime, "15:00");
});

test("the store follows Settings: new tasks at the bottom, a default priority, the at-3 rule, and Today without done tasks", async () => {
  const { tasks } = await store();
  assert.deepEqual(taskPrefs({ tasksNewAt: "bottom", tasksPriority: 2, tasksAtPm: 5, tasksDoneToday: false }), { newAt: "bottom", priority: 2, pmUpTo: 5, doneToday: false });
  const first = tasks.add({ text: "First" });
  tasks.configure(taskPrefs({ tasksNewAt: "bottom", tasksPriority: 2, tasksAtPm: 5, tasksDoneToday: false }));
  const second = tasks.add({ text: "Second today at 7" });
  assert.deepEqual([second.priority, second.dueTime], [2, "07:00"]);
  assert.equal(tasks.add({ text: "Third !low" }).priority, 1);
  assert.deepEqual(titles(tasks.list()), ["First", "Second", "Third"]);
  tasks.update(first.id, { done: true });
  assert.deepEqual(titles(tasks.list()), ["Second", "Third"]);
  // Values left out keep what they were; unknown ones are ignored.
  tasks.configure({ doneToday: true, colour: "red", newAt: undefined });
  assert.deepEqual(titles(tasks.list()), ["Second", "Third", "First"]);
  tasks.configure(null);
  tasks.configure(TASK_PREFS);
  assert.equal(tasks.add({ text: "Fourth" }).priority, 0);
  assert.equal(titles(tasks.list())[0], "Fourth");
});

test("the first task added at the bottom of an empty list goes first", async () => {
  const { tasks } = await store();
  tasks.configure({ newAt: "bottom" });
  assert.equal(tasks.add({ text: "Only" }).position, 0);
});

test("the list filters by project, by name, in its own scope", async () => {
  const tasks = await createTasks({ file: ":memory:", now: () => Date.parse("2026-10-30T01:00:00Z") });
  tasks.add({ text: "Ship it @Portal" });
  tasks.add({ text: "Plan it @Portal", scope: "personal" });
  tasks.add({ text: "Other thing" });
  assert.deepEqual(tasks.list({ view: "all", project: "portal" }).tasks.map((t) => t.title), ["Ship it"]);
  assert.deepEqual(tasks.list({ view: "all", project: "Nope" }).tasks, []);
  tasks.close();
});

test("quick add drops a word left hanging by the day it named", () => {
  const NOW2 = Date.parse("2026-10-30T01:00:00Z");
  assert.equal(parseQuick("Book the team lunch for Friday", NOW2).title, "Book the team lunch");
  assert.equal(parseQuick("Send the deck by tomorrow", NOW2).title, "Send the deck");
  assert.equal(parseQuick("Plan for", NOW2).title, "Plan for");
  assert.equal(parseQuick("Look for the keys", NOW2).title, "Look for the keys");
});

test("a link is kept from a web address, a PR or a ticket, and anything else is turned down", async () => {
  const { linkOf } = await import("../tasks.mjs");
  assert.deepEqual(linkOf("bm#45"), { kind: "pr", url: "https://github.com/purepm/backend-monorepo/pull/45", label: "bm#45" });
  assert.deepEqual(linkOf("pmhub-7"), { kind: "jira", url: "https://purepm.atlassian.net/browse/PMHUB-7", label: "PMHUB-7" });
  assert.equal(linkOf("https://example.com/a").kind, "url");
  assert.equal(linkOf("call Anna"), null);
});
