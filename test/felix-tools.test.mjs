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
  assert.deepEqual(names, ["calendar_events", "calendar_rsvp", "out_of_office", "on_call", "jira_search", "slack_search", "slack_post", "tasks_list", "tasks_add", "tasks_update", "tasks_delete", "prs_open", "ai_usage"]);
  // Tasks are Felix's to manage fully: no card for them.
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
