// My Jira Board card: the board's open sprint and how many of your tickets sit in each of the board's columns,
// read from the board's own configuration so the card matches Jira. Jira Cloud REST (v3 and the agile API) with basic auth: your Jira email and an API token, both in the
// Keychain as one item, service "cmd-center-jira", account = the email. Asked at most once a minute, unless Settings says otherwise.
import { codedError, readKeychain, readKeychainAccount } from "./keychain.mjs";

export const KEYCHAIN_SERVICE = "cmd-center-jira";
export const SITE = process.env.JIRA_SITE || "purepm.atlassian.net";
const CACHE_MINUTES = 1;
const PAGE = 100;
const MAX_ISSUES = 500;

/**
 * @typedef {{ name: string, count: number, tone: "todo" | "doing" | "review" | "blocked" | "done" }} Column
 * @typedef {{ fetchedAt: string, site: string, board: { id: number, name: string }, sprint: { id: number, name: string,
 *   endDate: string | null, goal: string } | null, whose: "mine" | "all", columns: Column[], total: number, done: number,
 *   active: Array<{ key: string, summary: string, url: string, column: string, tone: Column["tone"] }> }} JiraBoard
 */

const caches = new Map(); // "board|whose" -> { at, body }
let statusCategories = null; // status id -> Jira's status category key
let myAccountId = null; // who Jira says you are, for counting the whole sprint

/**
 * A column's colour: Jira's status category of its statuses, with review, QA and testing columns split out of
 * "in progress", and a blocked column in red.
 * @param {string} name The column's name.
 * @param {Array<string | undefined>} categories The status categories of the column's statuses.
 * @returns {Column["tone"]}
 */
export function toneOf(name, categories) {
  if (/block/i.test(name || "")) return "blocked";
  if (categories.length && categories.every((c) => c === "done")) return "done";
  if (categories.length && categories.every((c) => c === "new" || c === "undefined")) return "todo";
  return /review|\bqa\b|test/i.test(name || "") ? "review" : "doing";
}

const ACRONYMS = new Set(["QA", "UAT", "QE", "PR", "UI", "UX", "API", "SIT", "BE", "FE", "PO", "DEV", "PROD"]);

/**
 * A column name with each word capitalized, so boards that shout ("TESTED") read like the rest ("Tested").
 * Common acronyms stay in capitals ("QA/UAT").
 * @param {string} name
 * @returns {string}
 */
export const titleCase = (name) => String(name || "").replace(/\p{L}[\p{L}\d']*/gu, (w) => {
  if (ACRONYMS.has(w.toUpperCase()) && w === w.toUpperCase()) return w;
  return w.charAt(0).toUpperCase() + (w === w.toUpperCase() ? w.slice(1).toLowerCase() : w.slice(1));
});

/**
 * Counts your tickets in each of the board's columns, in the board's order. A ticket whose status is on no column
 * (the board doesn't show it) isn't counted.
 * @param {Array<{ fields?: { status?: { id?: string } } }>} issues Your tickets in the sprint.
 * @param {Array<{ name: string, statuses?: Array<{ id: string }> }>} columns The board's columns, from its configuration.
 * @param {Map<string, string>} categories Status id to status category key.
 * @returns {Column[]}
 */
export function countColumns(issues, columns, categories) {
  const where = new Map();
  const out = (columns || []).map((c, i) => {
    for (const s of c.statuses || []) where.set(String(s.id), i);
    return { name: titleCase(c.name), count: 0, tone: toneOf(c.name, (c.statuses || []).map((s) => categories.get(String(s.id)))) };
  });
  for (const issue of issues) {
    const at = where.get(String(issue.fields?.status?.id));
    if (at !== undefined) out[at].count += 1;
  }
  return out;
}

/**
 * The sprint the card shows: the open one, or the one ending first when the board runs more than one.
 * @param {Array<{ id: number, name: string, endDate?: string, goal?: string }>} sprints
 * @returns {JiraBoard["sprint"]}
 */
export function pickSprint(sprints) {
  const open = [...(sprints || [])].sort((a, b) => Date.parse(a.endDate || "9999") - Date.parse(b.endDate || "9999"))[0];
  return open ? { id: open.id, name: open.name, endDate: open.endDate || null, goal: open.goal || "" } : null;
}

/**
 * Makes the Jira client: one GET at a time with your basic auth, and Jira's answers turned into coded errors.
 * @param {{ email: string, token: string, site: string, fetchImpl: typeof fetch }} options
 * @returns {(path: string) => Promise<any>}
 */
function client({ email, token, site, fetchImpl }) {
  const auth = `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
  return async (path) => {
    const res = await fetchImpl(`https://${site}${path}`, { headers: { Authorization: auth, Accept: "application/json" } });
    if (res.status === 401 || res.status === 403) {
      throw codedError("auth", "Jira refused the token. It may have expired or been revoked; make a new one and save it again.");
    }
    if (res.status === 404) throw codedError("not-found", "Jira couldn't find that board. Check the board number in Settings.");
    if (!res.ok) throw codedError("http", `Jira answered ${res.status}.`);
    return res.json();
  };
}

/**
 * Reads your Jira email and token from the Keychain.
 * @param {{ readSecret?: typeof readKeychain, readAccount?: typeof readKeychainAccount }} deps
 * @returns {Promise<{ email: string, token: string }>}
 * @throws {Error & { code: "no-token" }} when they aren't saved yet.
 */
async function credentials({ readSecret = readKeychain, readAccount = readKeychainAccount } = {}) {
  const [email, token] = await Promise.all([readAccount(KEYCHAIN_SERVICE), readSecret(KEYCHAIN_SERVICE)]);
  if (!email || !token) throw codedError("no-token", "Jira isn't connected yet.");
  return { email, token };
}

/**
 * The order your open tickets are listed in: what you're on now, then what's next, then what's waiting on review;
 * anything else open (blocked, tested) after those.
 * @param {{ name: string, tone: Column["tone"] }} column
 * @returns {number}
 */
function plateRank({ name, tone }) {
  if (tone === "doing") return 0;
  if (tone === "todo") return 1;
  if (tone === "review" && /review/i.test(name)) return 2;
  if (tone === "blocked") return 3;
  return 4;
}

/**
 * Your tickets that aren't done, for the card's "On your plate": in progress first, then to do, then code review,
 * then the rest; within one column, the board's order and then the ticket number.
 * @param {Array<{ key: string, fields?: { summary?: string, status?: { id?: string } } }>} issues
 * @param {Array<{ name: string, statuses?: Array<{ id: string }> }>} columns
 * @param {Column[]} counted The same columns as countColumns gave them, with their tones.
 * @param {string} site
 * @returns {Array<{ key: string, summary: string, url: string, column: string, tone: Column["tone"] }>}
 */
export function inPlay(issues, columns, counted, site = SITE) {
  const where = new Map();
  (columns || []).forEach((c, i) => { for (const s of c.statuses || []) where.set(String(s.id), i); });
  return issues
    .map((issue) => ({ issue, at: where.get(String(issue.fields?.status?.id)) }))
    .filter(({ at }) => at !== undefined && counted[at].tone !== "done")
    .sort((a, b) => plateRank(counted[a.at]) - plateRank(counted[b.at]) || a.at - b.at
      || a.issue.key.localeCompare(b.issue.key, undefined, { numeric: true }))
    .map(({ issue, at }) => ({ key: issue.key, summary: issue.fields?.summary || "", url: `https://${site}/browse/${issue.key}`, column: counted[at].name, tone: counted[at].tone }));
}

/**
 * Your tickets in a sprint, or every ticket in it, a page at a time.
 * @param {(path: string) => Promise<any>} get
 * @param {number} sprintId
 * @param {boolean} [everyone] Every ticket, each with its assignee, instead of only yours.
 * @returns {Promise<Array<{ key: string, fields: Record<string, any> }>>}
 */
async function sprintIssues(get, sprintId, everyone = false) {
  const issues = [];
  const filter = everyone ? "" : `jql=${encodeURIComponent("assignee = currentUser()")}&`;
  const fields = everyone ? "status,summary,assignee" : "status,summary";
  for (let at = 0; at < MAX_ISSUES; at += PAGE) {
    const page = await get(`/rest/agile/1.0/sprint/${sprintId}/issue?${filter}fields=${fields}&maxResults=${PAGE}&startAt=${at}`);
    issues.push(...(page.issues || []));
    if (issues.length >= (page.total ?? 0) || !(page.issues || []).length) break;
  }
  return issues;
}

/**
 * Loads the card's data for a board, from the cache (a minute unless Settings says otherwise) unless fresh: the open
 * sprint, and how many of your tickets (or, with whose "all", every ticket) sit in each of the board's own columns.
 * The tickets in play are always yours.
 * @param {{ boardId?: number, whose?: "mine" | "all", cacheMinutes?: number, fresh?: boolean, site?: string, fetchImpl?: typeof fetch,
 *   now?: () => number, readSecret?: typeof readKeychain, readAccount?: typeof readKeychainAccount }} [options]
 * @returns {Promise<JiraBoard>}
 */
export async function jiraBoard({
  boardId = 181, whose = "mine", cacheMinutes = CACHE_MINUTES, fresh = false, site = SITE, fetchImpl = fetch, now = Date.now, readSecret, readAccount,
} = {}) {
  const key = `${boardId}|${whose}`;
  const hit = caches.get(key);
  if (!fresh && hit && now() - hit.at < cacheMinutes * 60e3) return hit.body;
  const get = client({ ...(await credentials({ readSecret, readAccount })), site, fetchImpl });
  const [board, config, sprints] = await Promise.all([
    get(`/rest/agile/1.0/board/${boardId}`),
    get(`/rest/agile/1.0/board/${boardId}/configuration`),
    get(`/rest/agile/1.0/board/${boardId}/sprint?state=active`),
  ]);
  statusCategories ??= new Map(((await get("/rest/api/3/status")) || []).map((s) => [String(s.id), s.statusCategory?.key]));
  const sprint = pickSprint(sprints.values);
  const everyone = whose === "all";
  const issues = sprint ? await sprintIssues(get, sprint.id, everyone) : [];
  // The whole sprint is counted, but On your plate stays yours: Jira says who you are, once.
  if (everyone && sprint) myAccountId ??= (await get("/rest/api/3/myself")).accountId;
  const mine = everyone ? issues.filter((i) => i.fields?.assignee?.accountId === myAccountId) : issues;
  const columns = countColumns(issues, config.columnConfig?.columns, statusCategories);
  /** @type {JiraBoard} */
  const body = {
    fetchedAt: new Date(now()).toISOString(),
    site,
    board: { id: boardId, name: board.name || `Board ${boardId}` },
    sprint,
    whose: everyone ? "all" : "mine",
    columns,
    total: columns.reduce((n, c) => n + c.count, 0),
    done: columns.filter((c) => c.tone === "done").reduce((n, c) => n + c.count, 0),
    active: inPlay(mine, config.columnConfig?.columns, columns, site),
  };
  caches.set(key, { at: now(), body });
  return body;
}

/**
 * Searches Jira with JQL, for Felix's AI to look up any tickets ("what's blocked in my sprint", "PMHUB-32975"): each
 * ticket's key, summary, status, assignee, priority, type, when it changed, and its link. At most 50 at once.
 * @param {{ jql: string, limit?: number, site?: string, fetchImpl?: typeof fetch, readSecret?: Function, readAccount?: Function }} options
 * @returns {Promise<{ total: number, issues: Array<Record<string, string | null>> }>}
 */
export async function jiraSearch({ jql, limit = 20, site = SITE, fetchImpl = fetch, readSecret, readAccount }) {
  const get = client({ ...(await credentials({ readSecret, readAccount })), site, fetchImpl });
  const fields = "summary,status,assignee,priority,issuetype,updated,duedate";
  const q = new URLSearchParams({ jql: String(jql), maxResults: String(Math.max(1, Math.min(50, Number(limit) || 20))), fields });
  const found = await get(`/rest/api/3/search/jql?${q}`);
  const issues = (found.issues || []).map((i) => ({
    key: i.key,
    summary: i.fields?.summary || "",
    status: i.fields?.status?.name || null,
    assignee: i.fields?.assignee?.displayName || null,
    priority: i.fields?.priority?.name || null,
    type: i.fields?.issuetype?.name || null,
    updated: i.fields?.updated || null,
    due: i.fields?.duedate || null,
    link: `https://${site}/browse/${i.key}`,
  }));
  return { total: issues.length, issues };
}

/**
 * Reads any Jira REST path as you (GET only), for the tools Felix builds himself: "/rest/api/3/issue/PMHUB-1".
 * @param {string} apiPath Starts with "/rest/".
 * @param {{ site?: string, fetchImpl?: typeof fetch, readSecret?: Function, readAccount?: Function }} [options]
 * @returns {Promise<unknown>}
 */
export async function jiraGet(apiPath, { site = SITE, fetchImpl = fetch, readSecret, readAccount } = {}) {
  if (!/^\/rest\//.test(String(apiPath))) throw codedError("http", "Only Jira's /rest/ paths can be read.");
  return client({ ...(await credentials({ readSecret, readAccount })), site, fetchImpl })(String(apiPath));
}

/**
 * Tries an email and token against Jira before they're saved, so only a working pair reaches the Keychain.
 * @param {{ email: string, token: string, site?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ name: string }>} Who Jira says you are.
 * @throws {Error & { code: string }} When Jira refuses them or can't be reached.
 */
export async function checkJira({ email, token, site = SITE, fetchImpl = fetch }) {
  const me = await client({ email, token, site, fetchImpl })("/rest/api/3/myself");
  return { name: me.displayName || email };
}

/** Forgets the cached boards and Jira's statuses, as after saving a new token. */
export function resetJiraCache() {
  caches.clear();
  statusCategories = null;
  myAccountId = null;
}
