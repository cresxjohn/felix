import { test } from "node:test";
import assert from "node:assert/strict";
import { createTools } from "../felix-tools.mjs";

/**
 * Fake services that record what each tool asked for.
 * @returns {{ calls: Array<[string, unknown]>, services: import("../felix-tools.mjs").Services }}
 */
function fakes() {
  const calls = [];
  const rec = (name) => async (...args) => { calls.push([name, args]); return { ok: name }; };
  return {
    calls,
    services: {
      calendar: { between: rec("between") },
      rsvp: rec("rsvp"),
      ooo: { out: rec("out") },
      oncall: rec("oncall"),
      jiraSearch: rec("jira"),
      slack: { search: rec("search"), post: rec("post") },
      tasks: { list: rec("list"), add: rec("add"), update: rec("update"), remove: rec("remove") },
      prs: rec("prs"),
      usage: rec("usage"),
    },
  };
}

test("every service has a tool, and only the ones that do something carry a card to allow", () => {
  const tools = createTools(fakes().services);
  const names = tools.map((t) => t.name);
  assert.deepEqual(names, ["calendar_events", "calendar_rsvp", "out_of_office", "on_call", "jira_search", "slack_search", "slack_post", "tasks_list", "tasks_add", "tasks_update", "tasks_delete",
    "personal_lists", "personal_list_add", "personal_habits", "personal_habit_check", "personal_journal_add", "personal_dates", "personal_timeoff",
    "wais_spaces", "wais_safe_to_spend", "wais_tasks", "wais_outlook", "prs_open", "ai_usage"]);
  // Tasks and the Personal cards are Felix's to manage fully: no card for them.
  assert.deepEqual(tools.filter((t) => t.card).map((t) => t.name), ["calendar_rsvp", "slack_post"]);
  for (const t of tools) assert.equal(t.inputSchema.type, "object", t.name);
});

test("each tool passes its arguments on, and the cards say exactly what will happen", async () => {
  const { calls, services } = fakes();
  const tool = Object.fromEntries(createTools(services).map((t) => [t.name, t]));
  await tool.calendar_events.run({ from: "2026-11-02", to: "2026-11-06" });
  await tool.jira_search.run({ jql: "assignee = currentUser()", limit: 5 });
  await tool.tasks_list.run({});
  await tool.tasks_update.run({ id: "t1", dueDate: "2026-11-04", dueTime: null, links: ["fm#12", "nope"], sneaky: true });
  await tool.tasks_delete.run({ id: "t2" });
  assert.deepEqual(calls, [
    ["between", [{ from: "2026-11-02", to: "2026-11-06", declined: false }]],
    ["jira", [{ jql: "assignee = currentUser()", limit: 5 }]],
    ["list", [{ scope: "work", view: "today", q: "", tag: "", project: "" }]],
    ["update", ["t1", { dueDate: "2026-11-04", dueTime: null, links: [{ kind: "pr", url: "https://github.com/purepm/frontend-monorepo/pull/12", label: "fm#12" }] }]],
    ["remove", ["t2"]],
  ]);
  assert.deepEqual(tool.calendar_rsvp.card({ response: "declined", title: "Standup", note: "Out sick" }), { title: "Answer this invite?", detail: "No to Standup, with the note \"Out sick\"" });
  assert.deepEqual(tool.slack_post.card({ channel: "#team", text: "Back at 2" }), { title: "Post this in #team?", detail: "Back at 2" });

});

test("the Personal tools reach the cards by name, add after what's there, and never read the journal", async () => {
  process.env.TZ = "Asia/Manila";
  const { createPersonal } = await import("../personal.mjs");
  const { createPersonalFelix } = await import("../felix-personal.mjs");
  const store = await createPersonal({ file: ":memory:", now: () => Date.parse("2026-10-30T01:00:00Z") });
  const personal = createPersonalFelix({ store, settings: { get: async () => ({ timeoffMe: "me", timeoffAhead: 90 }) },
    timeOff: { view: async (o) => ({ asked: o }) }, myDay: { view: async () => ({}) } });
  const tool = Object.fromEntries(createTools({ ...fakes().services, personal }).map((t) => [t.name, t]));
  assert.deepEqual((await tool.personal_lists.run({})).lists.map((l) => l.name), ["Groceries", "Packing", "Wishlist"]);
  const added = await tool.personal_list_add.run({ list: "my grocery list", items: ["Eggs", " ", "Milk"] });
  assert.deepEqual([added.list, added.added.map((i) => i.text)], ["Groceries", ["Eggs", "Milk"]]);
  assert.deepEqual((await tool.personal_lists.run({ list: "groceries" })).items.map((i) => i.text), ["Eggs", "Milk"]);
  await assert.rejects(tool.personal_list_add.run({ list: "shopping", items: ["x"] }), /There's no list called shopping\. The lists are Groceries, Packing, Wishlist\./);
  await assert.rejects(tool.personal_list_add.run({ list: "packing", items: [] }), /Say what to add/);
  const h = store.addHabit({ name: "Drink water" });
  assert.equal((await tool.personal_habits.run({})).habits[0].name, "Drink water");
  assert.equal((await tool.personal_habit_check.run({ id: h.id })).today.done, true);
  assert.equal((await tool.personal_habit_check.run({ id: h.id, day: "2026-10-29" })).week.find((d) => d.day === "2026-10-29").done, true);
  assert.equal((await tool.personal_habit_check.run({ id: h.id, done: false })).today.done, false);
  store.writeJournal("2026-10-30", { text: "Morning walk." });
  assert.deepEqual(await tool.personal_journal_add.run({ text: "Dinner with Mama." }), { added: true }, "it says it's added, not what's in the journal");
  assert.equal(store.journalDay().entry.text, "Morning walk.\nDinner with Mama.");
  await assert.rejects(tool.personal_journal_add.run({ text: "  " }), /Say what to write/);
  assert.ok(!Object.keys(tool).some((n) => /journal/.test(n) && n !== "personal_journal_add"), "no tool reads the journal");
  const dates = await tool.personal_dates.run({ add: { kind: "birthday", title: "Lola's birthday", month: 11, day: 3 } });
  assert.deepEqual([dates.added.title, dates.upcoming[0].next.inDays], ["Lola's birthday", 4]);
  assert.equal((await tool.personal_dates.run({})).all.length, 1);
  assert.deepEqual(await tool.personal_timeoff.run({}), { asked: { me: "me", ahead: 90, cacheMinutes: undefined } });
  assert.ok(personal.version() >= 5, "each change is counted, so the open cards load again");
  // Without the Personal cards, the tools say so plainly.
  const none = Object.fromEntries(createTools(fakes().services).map((t) => [t.name, t]));
  await assert.rejects(none.personal_habits.run({}), /The Personal cards aren't set up here/);
});

test("the Wais tools only read, pass their choices on, and say plainly when Wais isn't here", async () => {
  const calls = [];
  const tool = Object.fromEntries(createTools({ ...fakes().services, wais: { call: async (t, a) => { calls.push([t, a]); return { ok: t }; } } }).map((t) => [t.name, t]));
  for (const name of ["wais_spaces", "wais_safe_to_spend", "wais_tasks", "wais_outlook"]) assert.equal(tool[name].card, undefined, name);
  await tool.wais_spaces.run({});
  await tool.wais_safe_to_spend.run({});
  await tool.wais_safe_to_spend.run({ space: "s2", period: "payday", accounts: ["a1"], extra: 1 });
  await tool.wais_tasks.run({ space: "s2" });
  await tool.wais_outlook.run({});
  await tool.wais_outlook.run({ space: "s2", period: "365" });
  await tool.wais_outlook.run({ period: "7" });
  assert.deepEqual(calls, [
    ["spaces", {}], ["safe_to_spend", {}], ["safe_to_spend", { space: "s2", period: "payday", accounts: ["a1"] }], ["tasks", { space: "s2" }],
    ["outlook", { period: "30" }], ["outlook", { space: "s2", period: "365" }], ["outlook", { period: "30" }],
  ]);
  const none = Object.fromEntries(createTools(fakes().services).map((t) => [t.name, t]));
  await assert.rejects(async () => none.wais_tasks.run({}), /Wais isn't connected here/);
});
