import { test } from "node:test";
import assert from "node:assert/strict";
import { ctxServices } from "../felix-ctx.mjs";

/** Services that note what they were asked. */
function deps(fetchImpl) {
  const seen = [];
  const note = (name) => async (...args) => { seen.push([name, ...args]); return { from: name }; };
  let changed = 0;
  const d = {
    calendar: { between: note("between") }, ooo: { out: note("out"), team: note("team") }, oncall: note("oncall"),
    jiraSearch: note("jiraSearch"), jiraGet: note("jiraGet"), slack: { search: note("search"), read: note("read") }, googleGet: note("googleGet"),
    tasks: { list: note("list"), add: note("add"), update: note("update"), remove: note("remove") }, prs: note("prs"), usage: note("usage"),
    fetchImpl, onTasks: () => { changed += 1; },
  };
  return { d, seen, changed: () => changed };
}

test("a built tool reaches each service by its path, and every path is described for the builder", async () => {
  const { d, seen, changed } = deps();
  const { services, docs } = ctxServices(d);
  assert.deepEqual(Object.keys(services), docs.map(([p]) => p));
  assert.ok(docs.every(([, doc]) => doc.length > 10));
  await services["ooo.out"]({ from: "2027-01-01", to: "2027-03-31" });
  await services["ooo.team"]();
  await services["calendar.between"]({ from: "a", to: "b" });
  await services["oncall"]();
  await services["jira.search"]({ jql: "x" });
  await services["jira.get"]("/rest/api/3/myself");
  await services["slack.search"]("from:@ana", 5);
  await services["slack.read"]("users.list", { limit: 10 });
  await services["google.get"]("https://www.googleapis.com/calendar/v3/x");
  await services["tasks.list"]({ scope: "work" });
  await services["prs"]();
  await services["usage"]();
  assert.equal(changed(), 0, "reading tasks changes nothing");
  await services["tasks.add"]({ text: "Plan leave" });
  await services["tasks.update"]("t1", { done: true });
  await services["tasks.remove"]("t1");
  assert.equal(changed(), 3, "the tasks page hears about each change");
  assert.deepEqual(seen.map((s) => s[0]), ["out", "team", "between", "oncall", "jiraSearch", "jiraGet", "search", "read", "googleGet", "list", "prs", "usage", "add", "update", "remove"]);
  assert.deepEqual(seen[7], ["read", "users.list", { limit: 10 }]);
});

test("the web is read only at public addresses, JSON parsed", async () => {
  const asked = [];
  const fetchImpl = async (u) => {
    asked.push(String(u));
    if (String(u).includes("fail")) return { ok: false, status: 503 };
    return { ok: true, text: async () => (String(u).includes("json") ? '{"a":1}' : "plain page") };
  };
  const { services } = ctxServices(deps(fetchImpl).d);
  assert.deepEqual(await services["web.get"]("https://example.com/json"), { a: 1 });
  assert.equal(await services["web.get"]("https://example.com/page"), "plain page");
  await assert.rejects(services["web.get"]("https://example.com/fail"), /answered 503/);
  for (const url of ["http://localhost:4777/api", "http://127.0.0.1/", "http://192.168.1.4/", "http://10.0.0.1/", "https://macbook-air-2.taile6e8fb.ts.net/", "file:///etc/hosts", "http://100.101.2.3/"]) {
    await assert.rejects(services["web.get"](url), /Only public web addresses/, url);
  }
  assert.equal(asked.length, 3);
  const { services: plain } = ctxServices({ ...deps().d, fetchImpl: undefined });
  assert.equal(typeof plain["web.get"], "function");
});
