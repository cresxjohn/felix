/**
 * What a tool Felix builds can reach, as `ctx` (felix-tool-worker.mjs): your connected services by path, each with
 * a line saying what it takes and gives back, which the builder reads. Reads only, outside Felix: posting, answering
 * invites and the like stay with the built-in tools, which ask you first. Your tasks are the exception: Felix has
 * full say over them. No token or secret ever reaches a tool.
 */

// Public web pages only: never this Mac, the home network or the tailnet.
const PRIVATE_HOST = /^(localhost$|127\.|0\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|\[|::1$)|(\.|^)(ts\.net|local|localhost|internal)$/i;
const WEB_CHARS = 400_000;

/**
 * @typedef {{ calendar: { between: Function }, ooo: { out: Function, team: Function }, oncall: Function,
 *   jiraSearch: Function, jiraGet: Function, slack: { search: Function, read: Function }, googleGet: (url: string) => Promise<unknown>,
 *   tasks: { list: Function, add: Function, update: Function, remove: Function }, prs: Function, usage: Function,
 *   fetchImpl?: typeof fetch, onTasks?: () => void }} Deps
 */

/**
 * Reads a public web page or API as text (JSON comes back parsed).
 * @param {string} url
 * @param {typeof fetch} fetchImpl
 * @returns {Promise<unknown>}
 */
async function webGet(url, fetchImpl) {
  const u = new URL(String(url));
  if (!/^https?:$/.test(u.protocol) || PRIVATE_HOST.test(u.hostname)) throw new Error("Only public web addresses can be read.");
  const res = await fetchImpl(u, { headers: { Accept: "application/json, text/*;q=0.9" }, redirect: "follow", signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${u.hostname} answered ${res.status}.`);
  const text = (await res.text()).slice(0, WEB_CHARS);
  try { return JSON.parse(text); } catch { return text; }
}

/**
 * The services, by path, and what each does.
 * @param {Deps} d
 * @returns {{ services: Record<string, (...args: any[]) => unknown>, docs: Array<[string, string]> }}
 */
export function ctxServices(d) {
  const fetchImpl = d.fetchImpl || fetch;
  const changed = (v) => { d.onTasks?.(); return v; };
  /** @type {Array<[string, (...args: any[]) => unknown, string]>} */
  const all = [
    ["calendar.between", (r) => d.calendar.between(r), "({ from, to, declined? }) days as YYYY-MM-DD, both counted, at most 92 days → { events: [{ id, title, start, end, allDay, join, link, response, location }] } from the user's work calendar."],
    ["ooo.out", (r) => d.ooo.out(r), "({ from, to }) days as YYYY-MM-DD → { out: [{ name, kind, note, from, to, person, onTeam, holiday, whole }], teamSize, unknown } from the team's vacation tracker calendar. kind is one of PTO, VL (vacation leave), SL (sick), EL, UTO, OOO, Offset, Birthday, Holiday, WFH, Leave, Sick, Out, Off, Traveling, Limited. onTeam marks the user's own team. Ask for at most about 3 months at a time: the tracker gives back at most 500 entries per call."],
    ["ooo.team", () => d.ooo.team(), "() → [{ id, name, nicknames, onTeam }]: the people the user listed, onTeam for their own team."],
    ["oncall", () => d.oncall(), "() → who is Incident Commander now and next, and the user's coming shifts (Datadog On-Call)."],
    ["jira.search", (o) => d.jiraSearch(o), "({ jql, limit? }) at most 50 → { total, issues: [{ key, summary, status, assignee, priority, type, updated, due, link }] }."],
    ["jira.get", (p) => d.jiraGet(p), "(path) any Jira REST path starting /rest/ (GET), like \"/rest/api/3/issue/PMHUB-1?fields=summary\" or \"/rest/agile/1.0/board/181/sprint?state=active\" → Jira's JSON."],
    ["slack.search", (q, n) => d.slack.search(q, n), "(query, count?) Slack search syntax, at most 30 → { total, messages: [{ who, where, text, when, link }] }."],
    ["slack.read", (m, f) => d.slack.read(m, f), "(method, fields?) a Slack Web API method that only reads (conversations.history, conversations.replies, users.list, users.info, conversations.list…) with its form fields → Slack's JSON."],
    ["google.get", (url) => d.googleGet(url), "(url) a GET on Google's APIs as the user's work account, https://www.googleapis.com/calendar/v3/… (Calendar only) → Google's JSON."],
    ["tasks.list", (o) => d.tasks.list(o), "({ scope: \"work\"|\"personal\", view: \"today\"|\"upcoming\"|\"overdue\"|\"someday\"|\"done\"|\"all\", q?, tag?, project? }) → the user's tasks in Felix."],
    ["tasks.add", async (o) => changed(await d.tasks.add(o)), "({ text, scope?, parentId? }) adds a task the way the user types it (\"Send the report Friday 3pm #work\") → the task."],
    ["tasks.update", async (id, patch) => changed(await d.tasks.update(id, patch)), "(id, patch) changes a task: title, notes, dueDate, dueTime, someday, priority, repeat, project, tags, links, done → the task."],
    ["tasks.remove", async (id) => changed(await d.tasks.remove(id)), "(id) deletes a task and its subtasks."],
    ["prs", () => d.prs(), "() → the user's open PRs and the ones waiting on their review in fm and bm, with checks, approvals and conflicts."],
    ["usage", () => d.usage(), "() → how much of the Claude and Cursor plan limits is used, and when each resets."],
    ["web.get", (url) => webGet(url, fetchImpl), "(url) a public web page or API (GET, no login) → its JSON, or its text."],
  ];
  return {
    services: Object.fromEntries(all.map(([p, fn]) => [p, fn])),
    docs: all.map(([p, , doc]) => [p, doc]),
  };
}
