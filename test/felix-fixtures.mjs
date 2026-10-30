/**
 * Made-up card data for Felix's tests, all at one moment: Thursday, Oct 29, 2026 at 8 PM in Manila.
 */
import { createFacts } from "../felix-facts.mjs";

export const TZ = "Asia/Manila";
export const NOW = Date.parse("2026-10-29T12:00:00Z");

/**
 * One PR as the Open PRs lists send it.
 * @param {number} number
 * @param {object} [extra]
 * @returns {object}
 */
export const pr = (number, extra = {}) => ({
  number, title: `Change ${number}`, url: `https://github.com/purepm/frontend-monorepo/pull/${number}`, author: "me",
  isDraft: false, updatedAt: "2026-10-29T10:00:00Z", reviewDecision: "REVIEW_REQUIRED", mergeable: "MERGEABLE", mergeState: "BLOCKED",
  inMergeQueue: false, approvedBy: [], changesRequestedBy: [], requested: false, checks: { state: "passing", failing: [] }, ...extra,
});

export const IC = {
  fetchedAt: "2026-10-29T11:58:00Z",
  schedules: [{
    name: "Engineering IC",
    url: "https://app.datadoghq.com/on-call/schedules/abc",
    shifts: [
      { start: "2026-10-29T06:00:00Z", end: "2026-10-29T14:00:00Z", user: { name: "Sonito Mole" } },
      { start: "2026-10-29T14:00:00Z", end: "2026-10-30T00:00:00Z", user: { name: "Anna Reyes" } },
      { start: "2026-11-02T00:00:00Z", end: "2026-11-02T08:00:00Z", user: { name: "Pat Cruz" }, mine: true },
    ],
  }],
  myNext: { start: "2026-11-02T00:00:00Z", end: "2026-11-02T08:00:00Z", user: { name: "Pat Cruz" }, mine: true, schedule: "Engineering IC" },
};

export const PRS = {
  fetchedAt: "2026-10-29T11:59:00Z",
  login: "me",
  lists: {
    mine: [{
      key: "fm",
      prs: [
        pr(101, { mergeState: "CLEAN", reviewDecision: "APPROVED", approvedBy: ["anna"] }),
        pr(102, { checks: { state: "failing", failing: ["lint", "unit tests"] } }),
        pr(103, { mergeable: "CONFLICTING", mergeState: "DIRTY" }),
        pr(104, { mergeState: "CLEAN", inMergeQueue: true }),
      ],
    }, { key: "bm", prs: [] }],
    review: [{ key: "fm", prs: [] }, { key: "bm", prs: [pr(201, { author: "anna", requested: true }), pr(202, { author: "sonito" })] }],
  },
};

export const RELEASES = {
  fetchedAt: "2026-10-29T11:50:00Z",
  repos: [
    {
      key: "fm",
      open: { number: 300, title: "Release", checks: "passing", reviewDecision: "APPROVED", inMergeQueue: false, packages: [{}, {}] },
      mine: [{ number: 101 }],
      last: { number: 299, mergedAt: "2026-10-28T09:00:00Z", dev: { conclusion: "success" }, prod: { state: "success" } },
    },
    { key: "bm", open: null, mine: [], last: null },
  ],
};

export const USAGE = {
  fetchedAt: "2026-10-29T11:55:00Z",
  tools: [
    { name: "Claude", plan: "Max", url: "https://claude.ai/settings/usage", limits: [{ label: "5-hour", percent: 42, resetsAt: "2026-10-29T14:00:00Z" }, { label: "weekly", percent: 18 }], extra: { enabled: true, used: { amount: 3, currency: "USD" } } },
    { name: "Cursor", error: "Not signed in" },
  ],
};

export const MUSIC = { playing: true, track: { title: "Blue Song", artists: "The Band" }, device: { name: "Felix" } };

export const PR_DETAIL = {
  url: "https://github.com/purepm/frontend-monorepo/pull/101", number: 101, title: "Change 101", author: "me", state: "OPEN", draft: false,
  head: "feat/change", bodyHtml: "<p>Adds &amp; fixes</p>", reviewDecision: "APPROVED", additions: 10, deletions: 2, changedFiles: 1, commitCount: 1,
  reviewers: [{ login: "anna", state: "APPROVED" }, { login: "sonito" }], tickets: ["PMHUB-32946"],
  checks: [{ name: "lint", outcome: "passed" }, { name: "e2e", outcome: "failed" }],
  files: [{ name: "a.ts", additions: 10, deletions: 2, patch: "@@ -1 +1 @@" }, { name: "b.bin", additions: 0, deletions: 0 }],
  commits: [{ message: "feat: change" }],
  timeline: [{ kind: "review", state: "APPROVED", author: "anna", html: "<p>Looks good</p>" }, { kind: "comment", author: "sonito", html: "<p>Nice</p>" }],
};

// Thursday, Oct 29 in Manila (UTC+8): a meeting on now, two later today, one tomorrow, and an all-day event.
export const CAL = {
  fetchedAt: "2026-10-29T11:58:00Z",
  canReply: true,
  events: [
    { id: "e0", title: "Design sync", start: "2026-10-29T11:30:00Z", end: "2026-10-29T12:15:00Z", allDay: false, join: "https://meet.google.com/x", response: "accepted" },
    { id: "e1", title: "Release review", start: "2026-10-29T13:00:00Z", end: "2026-10-29T13:30:00Z", allDay: false, join: "", response: "needsAction" },
    { id: "e2", title: "Planning", start: "2026-10-29T14:00:00Z", end: "2026-10-29T15:00:00Z", allDay: false, join: "", response: "tentative" },
    { id: "e3", title: "Standup", start: "2026-10-30T01:00:00Z", end: "2026-10-30T01:15:00Z", allDay: false, join: "", response: "declined" },
    { id: "e4", title: "Team day", start: "2026-10-30T00:00:00", end: "2026-10-31T00:00:00", allDay: true, join: "", response: null },
    { id: "old", title: "Earlier", start: "2026-10-29T01:00:00Z", end: "2026-10-29T02:00:00Z", allDay: false },
  ],
};

export const JIRA = {
  fetchedAt: "2026-10-29T11:59:00Z", site: "purepm.atlassian.net", board: { id: 181, name: "Portalverse" }, sprint: { name: "Sprint 42" },
  columns: [{ name: "To Do", count: 5 }, { name: "In Progress", count: 3 }, { name: "Done", count: 7 }], total: 15, done: 7,
  active: [
    { key: "PMHUB-1", summary: "Bulk invite retries", column: "In Progress", url: "https://purepm.atlassian.net/browse/PMHUB-1" },
    { key: "PMHUB-2", summary: "Contact info search", column: "To Do", url: "https://purepm.atlassian.net/browse/PMHUB-2" },
  ],
};

export const OOO = {
  fetchedAt: "2026-10-29T11:00:00Z", from: "2026-10-29", to: "2026-11-11", teamSize: 4, unknown: [],
  out: [
    { name: "Ana Cruz", kind: "VL", note: "", from: "2026-10-29", to: "2026-10-30", onTeam: true, holiday: false },
    { name: "Ben Ramos", kind: "SL", note: "", from: "2026-10-30", to: "2026-10-30", onTeam: true, holiday: false },
    { name: "Someone Else", kind: "VL", note: "", from: "2026-10-29", to: "2026-10-29", onTeam: false, holiday: false },
    { name: "PH Holiday", kind: "Holiday", note: "All Saints' Day", from: "2026-11-02", to: "2026-11-02", onTeam: false, holiday: true },
    { name: "Cara Lim", kind: "PTO", note: "trip", from: "2026-11-04", to: "2026-11-05", onTeam: true, holiday: false },
  ],
};

export const TASKS = {
  today: "2026-10-29",
  tasks: [{ title: "Write the release notes", dueDate: "2026-10-29", dueTime: "15:00" }, { title: "Old one", dueDate: "2026-10-27" }, { title: "Done thing", doneAt: "2026-10-29T03:00:00Z" }],
};

/**
 * Felix's reader over the made-up data. A source named in `failing` throws instead; `swap` replaces a source's data.
 * @param {string[]} [failing]
 * @param {Record<string, object>} [swap]
 * @returns {ReturnType<typeof createFacts>}
 */
export function fakeFacts(failing = [], swap = {}) {
  const data = { oncall: IC, prs: PRS, releases: RELEASES, usage: USAGE, music: MUSIC, pr: PR_DETAIL, calendar: CAL, jira: JIRA, ooo: OOO, tasks: TASKS, ...swap };
  const readers = Object.fromEntries(Object.entries(data).map(([name, raw]) => [name, async () => {
    if (failing.includes(name)) throw new Error(`${name} is down`);
    return structuredClone(raw);
  }]));
  return createFacts({ readers, now: () => NOW, timeZone: TZ });
}
