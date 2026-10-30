import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { KEYCHAIN_SERVICE, checkJira, countColumns, inPlay, jiraBoard, jiraGet, jiraSearch, pickSprint, resetJiraCache, titleCase, toneOf } from "../jira.mjs";

const NOW = Date.parse("2026-10-30T01:00:00Z");
const SITE = "jira.example.net";
const reply = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

const COLUMNS = [
  { name: "To Do", statuses: [{ id: "1" }] },
  { name: "In Progress", statuses: [{ id: "3" }] },
  { name: "Code Review", statuses: [{ id: "10" }] },
  { name: "Blocked", statuses: [{ id: "11" }] },
  { name: "Done", statuses: [{ id: "4" }, { id: "5" }] },
];
const STATUSES = [
  { id: "1", statusCategory: { key: "new" } },
  { id: "3", statusCategory: { key: "indeterminate" } },
  { id: "10", statusCategory: { key: "indeterminate" } },
  { id: "11", statusCategory: { key: "indeterminate" } },
  { id: "4", statusCategory: { key: "done" } },
  { id: "5", statusCategory: { key: "done" } },
];
const issue = (status) => ({ key: `PMHUB-${status}`, fields: { status: { id: status } } });

/**
 * A fake Jira that answers by address, and remembers what was asked.
 * @param {Record<string, (url: string) => any>} [overrides] Answers by a part of the address.
 */
function fakeJira(overrides = {}) {
  const calls = [];
  const routes = {
    "/rest/agile/1.0/board/181/configuration": () => reply(200, { columnConfig: { columns: COLUMNS } }),
    "/rest/agile/1.0/board/181/sprint?state=active": () => reply(200, { values: [{ id: 7, name: "Sprint 7", endDate: "2026-11-05T00:00:00Z", goal: "Ship" }] }),
    "/rest/agile/1.0/board/181": () => reply(200, { name: "Portalverse" }),
    "/rest/api/3/status": () => reply(200, STATUSES),
    "/rest/agile/1.0/sprint/7/issue": () => reply(200, { total: 4, issues: [issue("1"), issue("3"), issue("5"), issue("99")] }),
    ...overrides,
  };
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const p = url.replace(`https://${SITE}`, "");
    const key = Object.keys(routes).sort((a, b) => b.length - a.length).find((k) => p === k || p.startsWith(`${k}?`) || (k.includes("?") && p === k));
    if (!key) throw new Error(`unexpected ${url}`);
    return routes[key](p);
  };
  return { fetchImpl, calls };
}

const creds = { readAccount: async (s) => (s === KEYCHAIN_SERVICE ? "me@pure.co" : null), readSecret: async (s) => (s === KEYCHAIN_SERVICE ? "tok-123" : null) };

beforeEach(() => resetJiraCache());

test("toneOf colours a column by its status categories and name", () => {
  assert.equal(toneOf("Blocked", ["indeterminate"]), "blocked");
  assert.equal(toneOf("Done", ["done", "done"]), "done");
  assert.equal(toneOf("To Do", ["new"]), "todo");
  assert.equal(toneOf("Backlog", ["undefined", "new"]), "todo");
  assert.equal(toneOf("Code Review", ["indeterminate"]), "review");
  assert.equal(toneOf("QA", ["indeterminate"]), "review");
  assert.equal(toneOf("Testing", []), "review");
  assert.equal(toneOf("In Progress", ["indeterminate", "done"]), "doing");
  assert.equal(toneOf(undefined, []), "doing");
});

test("countColumns counts tickets in the board's order and skips statuses on no column", () => {
  const cats = new Map(STATUSES.map((s) => [s.id, s.statusCategory.key]));
  assert.deepEqual(countColumns([issue("1"), issue("4"), issue("5"), issue("99"), {}], COLUMNS, cats), [
    { name: "To Do", count: 1, tone: "todo" },
    { name: "In Progress", count: 0, tone: "doing" },
    { name: "Code Review", count: 0, tone: "review" },
    { name: "Blocked", count: 0, tone: "blocked" },
    { name: "Done", count: 2, tone: "done" },
  ]);
  assert.deepEqual(countColumns([issue("1")], undefined, cats), []);
  assert.deepEqual(countColumns([], [{ name: "Empty" }], cats), [{ name: "Empty", count: 0, tone: "doing" }]);
});

test("pickSprint takes the one ending first, and none when there's none", () => {
  assert.deepEqual(pickSprint([
    { id: 2, name: "Later", endDate: "2026-11-20T00:00:00Z" },
    { id: 3, name: "No end" },
    { id: 1, name: "Sooner", endDate: "2026-11-06T00:00:00Z", goal: "Go" },
  ]), { id: 1, name: "Sooner", endDate: "2026-11-06T00:00:00Z", goal: "Go" });
  assert.deepEqual(pickSprint([{ id: 3, name: "No end" }]), { id: 3, name: "No end", endDate: null, goal: "" });
  assert.equal(pickSprint([]), null);
  assert.equal(pickSprint(undefined), null);
});

test("jiraBoard reads the board, its columns, the open sprint and your tickets", async () => {
  const { fetchImpl, calls } = fakeJira();
  const body = await jiraBoard({ site: SITE, fetchImpl, now: () => NOW, ...creds });
  assert.deepEqual(body, {
    fetchedAt: new Date(NOW).toISOString(),
    site: SITE,
    board: { id: 181, name: "Portalverse" },
    sprint: { id: 7, name: "Sprint 7", endDate: "2026-11-05T00:00:00Z", goal: "Ship" },
    whose: "mine",
    columns: [
      { name: "To Do", count: 1, tone: "todo" },
      { name: "In Progress", count: 1, tone: "doing" },
      { name: "Code Review", count: 0, tone: "review" },
      { name: "Blocked", count: 0, tone: "blocked" },
      { name: "Done", count: 1, tone: "done" },
    ],
    total: 3,
    done: 1,
    active: body.active,
  });
  assert.ok(body.active.every((t) => t.url.startsWith("https://jira.example.net/browse/") && t.tone !== "done"));
  const auth = `Basic ${Buffer.from("me@pure.co:tok-123").toString("base64")}`;
  assert.ok(calls.every((c) => c.init.headers.Authorization === auth && c.init.headers.Accept === "application/json"));
  const issues = calls.find((c) => c.url.includes("/sprint/7/issue")).url;
  assert.ok(issues.includes(`jql=${encodeURIComponent("assignee = currentUser()")}`));
  assert.ok(issues.includes("fields=status,summary&maxResults=100&startAt=0"));
});

test("jiraBoard pages through your tickets", async () => {
  const starts = [];
  const { fetchImpl } = fakeJira({
    "/rest/agile/1.0/sprint/7/issue": (p) => {
      const at = Number(new URLSearchParams(p.split("?")[1]).get("startAt"));
      starts.push(at);
      return reply(200, { total: 150, issues: Array.from({ length: at === 0 ? 100 : 50 }, () => issue("3")) });
    },
  });
  const body = await jiraBoard({ site: SITE, fetchImpl, now: () => NOW, ...creds });
  assert.deepEqual(starts, [0, 100]);
  assert.equal(body.columns[1].count, 150);
  assert.equal(body.total, 150);
});

test("jiraBoard stops paging on an empty page", async () => {
  let pages = 0;
  const { fetchImpl } = fakeJira({ "/rest/agile/1.0/sprint/7/issue": () => { pages += 1; return reply(200, {}); } });
  assert.equal((await jiraBoard({ site: SITE, fetchImpl, now: () => NOW, ...creds })).total, 0);
  assert.equal(pages, 1);
});

test("jiraBoard with no open sprint, no board name and no columns shows an empty card", async () => {
  const { fetchImpl, calls } = fakeJira({
    "/rest/agile/1.0/board/42/configuration": () => reply(200, {}),
    "/rest/agile/1.0/board/42/sprint?state=active": () => reply(200, { values: [] }),
    "/rest/agile/1.0/board/42": () => reply(200, {}),
    "/rest/api/3/status": () => reply(200, null),
  });
  const body = await jiraBoard({ boardId: 42, site: SITE, fetchImpl, now: () => NOW, ...creds });
  assert.deepEqual([body.board, body.sprint, body.columns, body.total], [{ id: 42, name: "Board 42" }, null, [], 0]);
  assert.ok(!calls.some((c) => c.url.includes("/issue")));
});

test("jiraBoard is cached for a minute, fresh skips the cache, and reset forgets statuses", async () => {
  const { fetchImpl, calls } = fakeJira();
  const clock = { t: NOW };
  const opts = { site: SITE, fetchImpl, now: () => clock.t, ...creds };
  const first = await jiraBoard(opts);
  const n = calls.length;
  clock.t += 59e3;
  assert.equal(await jiraBoard(opts), first);
  assert.equal(calls.length, n);
  const fresh = await jiraBoard({ ...opts, fresh: true });
  assert.notEqual(fresh, first);
  // The statuses are asked for once, until the cache is reset.
  assert.equal(calls.filter((c) => c.url.endsWith("/rest/api/3/status")).length, 1);
  clock.t += 61e3;
  await jiraBoard(opts);
  assert.equal(calls.filter((c) => c.url.endsWith("/rest/agile/1.0/board/181")).length, 3);
  resetJiraCache();
  await jiraBoard(opts);
  assert.equal(calls.filter((c) => c.url.endsWith("/rest/api/3/status")).length, 2);
});

test("jiraBoard can count the whole sprint, while the tickets in play stay yours", async () => {
  const mine = (status) => ({ ...issue(status), fields: { ...issue(status).fields, assignee: { accountId: "me-1" } } });
  const theirs = (status) => ({ key: `PMHUB-9${status}`, fields: { status: { id: status }, assignee: { accountId: "them-2" } } });
  const { fetchImpl, calls } = fakeJira({
    "/rest/agile/1.0/sprint/7/issue": () => reply(200, { total: 4, issues: [mine("3"), theirs("3"), theirs("10"), { key: "PMHUB-77", fields: { status: { id: "5" } } }] }),
    "/rest/api/3/myself": () => reply(200, { accountId: "me-1" }),
  });
  const opts = { whose: "all", site: SITE, fetchImpl, now: () => NOW, ...creds };
  const body = await jiraBoard(opts);
  assert.equal(body.whose, "all");
  assert.deepEqual(body.columns.map((c) => c.count), [0, 2, 1, 0, 1]);
  assert.deepEqual([body.total, body.done], [4, 1]);
  assert.deepEqual(body.active.map((t) => t.key), ["PMHUB-3"]);
  const url = calls.find((c) => c.url.includes("/sprint/7/issue")).url;
  assert.ok(!url.includes("jql=") && url.includes("fields=status,summary,assignee"));
  // Who you are is asked once, and "mine" and "all" are cached apart.
  resetJiraCache();
  await jiraBoard({ ...opts, fresh: true });
  await jiraBoard({ ...opts, fresh: true });
  assert.equal(calls.filter((c) => c.url.endsWith("/rest/api/3/myself")).length, 2);
  assert.equal((await jiraBoard({ ...opts, whose: "mine" })).whose, "mine");
});

test("jiraBoard keeps its answer as long as Settings says", async () => {
  const { fetchImpl, calls } = fakeJira();
  const clock = { t: NOW };
  const opts = { cacheMinutes: 5, site: SITE, fetchImpl, now: () => clock.t, ...creds };
  const first = await jiraBoard(opts);
  const n = calls.length;
  clock.t += 4 * 60e3;
  assert.equal(await jiraBoard(opts), first);
  assert.equal(calls.length, n);
  clock.t += 2 * 60e3;
  assert.notEqual(await jiraBoard(opts), first);
});

test("jiraBoard says Jira isn't connected when the email or token is missing", async () => {
  const { fetchImpl, calls } = fakeJira();
  await assert.rejects(jiraBoard({ site: SITE, fetchImpl, readAccount: async () => null, readSecret: async () => "tok" }), { code: "no-token" });
  await assert.rejects(jiraBoard({ site: SITE, fetchImpl, readAccount: async () => "me@pure.co", readSecret: async () => null }), { code: "no-token" });
  assert.equal(calls.length, 0);
});

test("jiraBoard turns Jira's refusals into coded errors", async () => {
  for (const [status, code] of [[401, "auth"], [403, "auth"], [404, "not-found"], [500, "http"]]) {
    resetJiraCache();
    const { fetchImpl } = fakeJira({ "/rest/agile/1.0/board/181": () => reply(status, {}) });
    await assert.rejects(jiraBoard({ site: SITE, fetchImpl, now: () => NOW, ...creds }), { code }, String(status));
  }
  const { fetchImpl } = fakeJira({ "/rest/agile/1.0/board/181": () => reply(502, {}) });
  await assert.rejects(jiraBoard({ site: SITE, fetchImpl, ...creds }), { message: "Jira answered 502." });
});

test("checkJira tries an email and token and says who Jira thinks you are", async () => {
  const seen = [];
  const fetchImpl = async (url, init) => { seen.push([url, init.headers.Authorization]); return reply(200, { displayName: "Cres Lazo" }); };
  assert.deepEqual(await checkJira({ email: "me@pure.co", token: "t0k", site: SITE, fetchImpl }), { name: "Cres Lazo" });
  assert.deepEqual(seen, [[`https://${SITE}/rest/api/3/myself`, `Basic ${Buffer.from("me@pure.co:t0k").toString("base64")}`]]);
  assert.deepEqual(await checkJira({ email: "me@pure.co", token: "t0k", site: SITE, fetchImpl: async () => reply(200, {}) }), { name: "me@pure.co" });
  await assert.rejects(checkJira({ email: "me@pure.co", token: "bad", site: SITE, fetchImpl: async () => reply(401, {}) }), { code: "auth" });
});

test("column names read the same way: each word capitalized, acronyms kept", () => {
  assert.deepEqual(["TESTED", "To Do", "code review", "IN REVIEW", "QA/UAT", "Won't do"].map(titleCase),
    ["Tested", "To Do", "Code Review", "In Review", "QA/UAT", "Won't Do"]);
  assert.equal(titleCase(undefined), "");
  assert.equal(countColumns([], [{ name: "TESTED", statuses: [] }], new Map())[0].name, "Tested");
});

test("inPlay lists your open tickets: in progress, then to do, then code review, then the rest", () => {
  const columns = [{ name: "To Do", statuses: [{ id: "1" }] }, { name: "In Progress", statuses: [{ id: "3" }] }, { name: "Code Review", statuses: [{ id: "8" }] },
    { name: "Tested", statuses: [{ id: "9" }] }, { name: "Blocked", statuses: [{ id: "6" }] }, { name: "Done", statuses: [{ id: "4" }] }];
  const counted = [{ name: "To Do", tone: "todo" }, { name: "In Progress", tone: "doing" }, { name: "Code Review", tone: "review" },
    { name: "Tested", tone: "review" }, { name: "Blocked", tone: "blocked" }, { name: "Done", tone: "done" }];
  const issue = (key, status, summary) => ({ key, fields: { status: { id: status }, ...(summary ? { summary } : {}) } });
  const list = inPlay([issue("P-10", "9", "Ship it"), issue("P-6", "6"), issue("P-2", "3", "Build it"), issue("P-11", "8"), issue("P-9", "3"),
    issue("P-1", "1"), issue("P-3", "4"), issue("P-4", "77")], columns, counted, "x.net");
  assert.deepEqual(list.map((t) => [t.key, t.column]), [["P-2", "In Progress"], ["P-9", "In Progress"], ["P-1", "To Do"], ["P-11", "Code Review"], ["P-6", "Blocked"], ["P-10", "Tested"]]);
  assert.deepEqual([list[0].url, list[0].summary, list[1].summary], ["https://x.net/browse/P-2", "Build it", ""]);
  assert.deepEqual(inPlay([], undefined, []), []);
});

test("a JQL search gives each ticket's key, summary, status, owner and link, and caps how many", async () => {
  let asked = "";
  const fetchImpl = async (url) => {
    asked = url;
    return new Response(JSON.stringify({ issues: [{ key: "PMHUB-1", fields: { summary: "Fix login", status: { name: "In Progress" }, assignee: { displayName: "Anna" }, priority: { name: "High" }, issuetype: { name: "Bug" }, updated: "2026-10-30T01:00:00Z", duedate: null } }] }), { status: 200 });
  };
  const found = await jiraSearch({ jql: "assignee = currentUser()", limit: 500, fetchImpl, readSecret: async () => "tok", readAccount: async () => "me@x.co" });
  const q = new URL(asked).searchParams;
  assert.equal(new URL(asked).pathname, "/rest/api/3/search/jql");
  assert.equal(q.get("jql"), "assignee = currentUser()");
  assert.equal(q.get("maxResults"), "50");
  assert.deepEqual(found.issues[0], { key: "PMHUB-1", summary: "Fix login", status: "In Progress", assignee: "Anna", priority: "High", type: "Bug", updated: "2026-10-30T01:00:00Z", due: null, link: `https://${new URL(asked).host}/browse/PMHUB-1` });
});

test("Felix's own tools read any Jira REST path as you, and only read", async () => {
  const asked = [];
  const fetchImpl = async (url, init) => { asked.push([url, init.method]); return { ok: true, status: 200, json: async () => ({ id: "10" }) }; };
  const secrets = { fetchImpl, readSecret: async () => "tok", readAccount: async () => "me@x.co" };
  assert.deepEqual(await jiraGet("/rest/api/3/issue/PMHUB-1?fields=summary", secrets), { id: "10" });
  assert.deepEqual(asked, [["https://purepm.atlassian.net/rest/api/3/issue/PMHUB-1?fields=summary", undefined]]);
  await assert.rejects(jiraGet("https://evil.example/x", secrets), /Only Jira's \/rest\/ paths/);
});
