/**
 * Felix's tools for his AI: every connected service, so he looks things up and gets things done himself rather than
 * answering only from what he was handed. Looking things up (your calendar for any days, who's out, on-call, Jira,
 * Slack, tasks, PRs, AI usage) runs at once. Doing something (an RSVP, a task, a Slack message) shows you a card to
 * allow first, unless Settings allow everything. Tasks are the exception: you gave Felix full say over them, so adding,
 * changing, ticking off and deleting run at once. GitHub is reached with the gh command, which Felix's AI already has.
 * Your Personal cards (lists, habits, the journal, important dates, time off) work the same way, with no cards, and
 * only when you ask about them. The journal can be added to, never read.
 */

/**
 * @typedef {{ name: string, description: string, inputSchema: object, run: (args: Record<string, any>) => Promise<unknown>,
 *   card?: (args: Record<string, any>) => { title: string, detail: string } }} Tool `card` marks an action: what the
 *   card you allow says.
 * @typedef {{
 *   calendar: { between: (r: { from: string, to: string, declined?: boolean }) => Promise<unknown> },
 *   rsvp: (eventId: string, response: string, note?: string) => Promise<unknown>,
 *   ooo: { out: (r: { from: string, to: string }) => Promise<unknown> },
 *   oncall: () => Promise<unknown>,
 *   jiraSearch: (o: { jql: string, limit?: number }) => Promise<unknown>,
 *   slack: { search: (q: string, count?: number) => Promise<unknown>, post: (channel: string, text: string) => Promise<unknown> },
 *   tasks: { list: (o: object) => unknown, add: (o: object) => unknown, update: (id: string, patch: object) => unknown,
 *     remove: (id: string) => unknown },
 *   prs: () => Promise<unknown>,
 *   usage: () => Promise<unknown>,
 *   onTasks?: () => void,
 *   personal?: ReturnType<typeof import("./felix-personal.mjs").createPersonalFelix>,
 *   wais?: { call: (tool: string, args?: Record<string, unknown>) => Promise<unknown> },
 * }} Services
 */

import { linkOf } from "./tasks.mjs";
import { findList } from "./felix-personal.mjs";

const DAY = { type: "string", description: "A day as YYYY-MM-DD." };
/** What a task change may touch. */
const TASK_FIELDS = ["title", "notes", "dueDate", "dueTime", "someday", "priority", "repeat", "project", "tags", "links", "done"];

/**
 * The tools, over the services as they are.
 * @param {Services} s
 * @returns {Tool[]}
 */
export function createTools(s) {
  /** @type {Tool[]} */
  const tools = [
    {
      name: "calendar_events",
      description: "Your work calendar's events between two days (both included, at most 92 days): title, time, where, who's coming, your answer, the meeting link and the event's id (for calendar_rsvp). Use it for any days, not only the ones you were given.",
      inputSchema: { type: "object", properties: { from: DAY, to: DAY, declined: { type: "boolean", description: "Include events you declined." } }, required: ["from", "to"] },
      run: (a) => s.calendar.between({ from: a.from, to: a.to, declined: Boolean(a.declined) }),
    },
    {
      name: "calendar_rsvp",
      description: "Answers a calendar invite as the user: yes, no or maybe, with an optional note to the organizer. The user allows it first.",
      inputSchema: { type: "object", properties: { eventId: { type: "string" }, response: { type: "string", enum: ["accepted", "declined", "tentative"] }, note: { type: "string" }, title: { type: "string", description: "The event's title, for the card the user sees." } }, required: ["eventId", "response"] },
      card: (a) => ({ title: "Answer this invite?", detail: `${{ accepted: "Yes", declined: "No", tentative: "Maybe" }[a.response] || a.response} to ${a.title || "the event"}${a.note ? `, with the note "${a.note}"` : ""}` }),
      run: (a) => s.rsvp(String(a.eventId), String(a.response), String(a.note || "")),
    },
    {
      name: "out_of_office",
      description: "Who is on leave (vacation, sick, out) between two days, from the team's vacation tracker.",
      inputSchema: { type: "object", properties: { from: DAY, to: DAY }, required: ["from", "to"] },
      run: (a) => s.ooo.out({ from: a.from, to: a.to }),
    },
    {
      name: "on_call",
      description: "Who is Incident Commander now and next, and the user's own coming shifts, from Datadog On-Call.",
      inputSchema: { type: "object", properties: {} },
      run: () => s.oncall(),
    },
    {
      name: "jira_search",
      description: "Searches Jira with JQL (like `assignee = currentUser() AND sprint in openSprints()` or `key = PMHUB-32975`): key, summary, status, assignee, priority, type, last change, due day and link. At most 50.",
      inputSchema: { type: "object", properties: { jql: { type: "string" }, limit: { type: "number" } }, required: ["jql"] },
      run: (a) => s.jiraSearch({ jql: a.jql, limit: a.limit }),
    },
    {
      name: "slack_search",
      description: "Searches the user's Slack the way Slack's search box does (`from:@anna release`, `in:#incidents after:2026-10-01`, `to:me`): who, where, what, when and a link. At most 30, newest first.",
      inputSchema: { type: "object", properties: { query: { type: "string" }, count: { type: "number" } }, required: ["query"] },
      run: (a) => s.slack.search(a.query, a.count),
    },
    {
      name: "slack_post",
      description: "Posts a message in a Slack channel or DM as the user. The user allows it first, seeing exactly what it says.",
      inputSchema: { type: "object", properties: { channel: { type: "string", description: "A channel id, or #name." }, text: { type: "string" } }, required: ["channel", "text"] },
      card: (a) => ({ title: `Post this in ${a.channel}?`, detail: String(a.text || "") }),
      run: (a) => s.slack.post(String(a.channel), String(a.text)),
    },
    {
      name: "tasks_list",
      description: "The user's tasks in Felix: work or personal, in a view (today, upcoming, overdue, someday, done), optionally searched by words, a #tag or a project.",
      inputSchema: { type: "object", properties: { scope: { type: "string", enum: ["work", "personal"] }, view: { type: "string", enum: ["today", "upcoming", "overdue", "someday", "done"] }, q: { type: "string" }, tag: { type: "string" }, project: { type: "string" } } },
      run: async (a) => s.tasks.list({ scope: a.scope || "work", view: a.view || "today", q: a.q || "", tag: a.tag || "", project: a.project || "" }),
    },
    {
      name: "tasks_add",
      description: "Adds a task the way the user would type it (\"Send the report Friday 3pm #work\"; days, times and #tags are understood), or a subtask under another task with parentId. Runs at once: the user gave you full say over their tasks.",
      inputSchema: { type: "object", properties: { text: { type: "string" }, scope: { type: "string", enum: ["work", "personal"] }, parentId: { type: "string", description: "A task's id, to add this as its subtask." } }, required: ["text"] },
      run: async (a) => {
        const task = await s.tasks.add({ text: String(a.text), scope: a.scope || "work", parentId: a.parentId || null });
        s.onTasks?.();
        return task;
      },
    },
    {
      name: "tasks_update",
      description: "Changes anything about a task by its id (from tasks_list): only the fields given change. Runs at once: the user gave you full say over their tasks. Ticking off is done: true; undoing it, done: false.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          notes: { type: "string" },
          dueDate: { type: ["string", "null"], description: "A day as YYYY-MM-DD, or null for no due day." },
          dueTime: { type: ["string", "null"], description: "A 24-hour time as HH:MM, or null for none." },
          someday: { type: "boolean", description: "Someday has no due day." },
          priority: { type: "number", enum: [0, 1, 2, 3], description: "0 none, 1 low, 2 medium, 3 high." },
          repeat: { type: ["string", "null"], description: "Like \"every day\", \"every weekday\", \"every monday\", \"every sprint\", \"every month\", or null." },
          project: { type: ["string", "null"], description: "A project's name, or null for none." },
          tags: { type: "array", items: { type: "string" }, description: "The labels it should have, all of them, without #." },
          links: { type: "array", items: { type: "string" }, description: "The links it should have, all of them: web addresses, fm#123 or PMHUB-123." },
          done: { type: "boolean" },
        },
        required: ["id"],
      },
      run: async (a) => {
        const { id, ...rest } = a;
        const patch = Object.fromEntries(Object.entries(rest).filter(([k]) => TASK_FIELDS.includes(k)));
        if (Array.isArray(patch.links)) patch.links = patch.links.map(linkOf).filter(Boolean);
        const task = await s.tasks.update(String(id), patch);
        s.onTasks?.();
        return task;
      },
    },
    {
      name: "tasks_delete",
      description: "Deletes a task, and its subtasks, by its id. Runs at once: the user gave you full say over their tasks.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      run: async (a) => {
        await s.tasks.remove(String(a.id));
        s.onTasks?.();
        return { deleted: String(a.id) };
      },
    },
    ...personalTools(s),
    ...waisTools(s),
    {
      name: "prs_open",
      description: "The user's open PRs and the ones waiting on their review in fm and bm, with checks, approvals and conflicts. For anything else on GitHub, use the gh command.",
      inputSchema: { type: "object", properties: {} },
      run: () => s.prs(),
    },
    {
      name: "ai_usage",
      description: "How much of the Claude and Cursor plan limits is used, and when each resets.",
      inputSchema: { type: "object", properties: {} },
      run: () => s.usage(),
    },
  ];
  return tools;
}

/**
 * The tools for your Personal cards: few and clear. They run at once, like tasks, and only on what you have.
 * @param {Services} s
 * @returns {Tool[]}
 */
function personalTools(s) {
  /** Felix's way into the Personal cards, or a plain error when they aren't here. */
  const p = () => {
    if (!s.personal) throw new Error("The Personal cards aren't set up here.");
    return s.personal;
  };
  /** A list by the name the user used ("groceries", "my packing list"). */
  const listFor = (name) => {
    const own = findList(String(name || ""), p().lists().map((l) => l.name));
    const list = own && p().listNamed(own);
    if (!list) throw new Error(`There's no list called ${name}. The lists are ${p().lists().map((l) => l.name).join(", ") || "none yet"}.`);
    return list;
  };
  return [
    {
      name: "personal_lists",
      description: "The user's own lists from Personal mode (like Groceries, Packing, Wishlist): every list with how many items are left and ticked, or, with list, that list's items.",
      inputSchema: { type: "object", properties: { list: { type: "string", description: "A list's name, to see its items." } } },
      run: async (a) => (a.list ? { list: listFor(a.list), items: p().items(listFor(a.list).id) } : { lists: p().lists() }),
    },
    {
      name: "personal_list_add",
      description: "Adds items to one of the user's lists, by the list's name. Runs at once: the user gave you full say over their lists.",
      inputSchema: { type: "object", properties: { list: { type: "string" }, items: { type: "array", items: { type: "string" } } }, required: ["list", "items"] },
      run: async (a) => {
        const things = (Array.isArray(a.items) ? a.items : [a.items]).map((t) => String(t).trim()).filter(Boolean);
        if (!things.length) throw new Error("Say what to add.");
        return { list: listFor(a.list).name, added: p().addItems(listFor(a.list).id, things.join("\n")) };
      },
    },
    {
      name: "personal_habits",
      description: "The user's daily habits: each one's id, today's count and goal, current and best streak, and the last 7 days.",
      inputSchema: { type: "object", properties: {} },
      run: async () => p().habits(),
    },
    {
      name: "personal_habit_check",
      description: "Marks one of the user's habits done (or, with done: false, not done) for today or a past day, by its id from personal_habits. Runs at once.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, day: DAY, done: { type: "boolean" } }, required: ["id"] },
      run: async (a) => p().setHabit(String(a.id), { day: a.day || undefined, done: a.done !== false }),
    },
    {
      name: "personal_journal_add",
      description: "Adds a line to the end of today's journal entry, in the user's own words. It never replaces what's there, and the journal can't be read back: it stays private.",
      inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
      run: async (a) => {
        const line = String(a.text || "").trim();
        if (!line) throw new Error("Say what to write.");
        p().journalAppend(line);
        return { added: true };
      },
    },
    {
      name: "personal_dates",
      description: "The user's important dates (birthdays, anniversaries, countdowns), each with when it next comes round. With add, saves a new one first: kind birthday or anniversary (every year; year optional, for the age) or event (a countdown, with its year).",
      inputSchema: {
        type: "object",
        properties: {
          add: {
            type: "object",
            properties: { kind: { type: "string", enum: ["birthday", "anniversary", "event"] }, title: { type: "string" }, month: { type: "number" }, day: { type: "number" }, year: { type: ["number", "null"] } },
            required: ["kind", "title", "month", "day"],
          },
        },
      },
      run: async (a) => {
        const added = a.add ? p().addDate({ kind: a.add.kind, title: a.add.title, month: a.add.month, day: a.add.day, year: a.add.year ?? null }) : null;
        return { ...(added ? { added } : {}), ...p().datesView({ ahead: 366, limit: 20 }) };
      },
    },
    {
      name: "personal_timeoff",
      description: "The user's own time off from the vacation tracker: the next break (days off, weekends counted), booked leave, and this year's days off by kind.",
      inputSchema: { type: "object", properties: {} },
      run: async () => p().timeoff(),
    },
  ];
}

/**
 * The tools for Wais, the user's money planner: read-only, over Wais's own MCP server. Money comes as { amount,
 * formatted }; say the formatted figure.
 * @param {Services} s
 * @returns {Tool[]}
 */
function waisTools(s) {
  /** Calls Wais, or says plainly that it isn't connected here. */
  const wais = (tool, args) => {
    if (!s.wais) throw new Error("Wais isn't connected here.");
    return s.wais.call(tool, args);
  };
  const SPACE = { type: "string", description: "A space's id, from wais_spaces. Leave it out for the user's default space." };
  const PERIODS = ["30", "60", "90", "365", "730", "1095", "1825"];
  return [
    {
      name: "wais_spaces",
      description: "The user's Wais spaces (their own, shared ones) and which is the default.",
      inputSchema: { type: "object", properties: {} },
      run: () => wais("spaces", {}),
    },
    {
      name: "wais_safe_to_spend",
      description: "What the user can safely spend in Wais: until payday or over a number of days, the day money runs short if it does, the lowest point, and bills ahead. Without period or accounts it uses their saved choice.",
      inputSchema: { type: "object", properties: { space: SPACE, period: { type: "string", enum: ["payday", ...PERIODS] }, accounts: { type: "array", items: { type: "string" } } } },
      run: (a) => wais("safe_to_spend", Object.fromEntries(Object.entries({ space: a.space, period: a.period, accounts: a.accounts }).filter(([, v]) => v !== undefined && v !== ""))),
    },
    {
      name: "wais_tasks",
      description: "The user's money tasks in Wais (bills to pay today, to review, or late), with due days and amounts.",
      inputSchema: { type: "object", properties: { space: SPACE } },
      run: (a) => wais("tasks", a.space ? { space: a.space } : {}),
    },
    {
      name: "wais_outlook",
      description: "The user's projected balance in Wais over a period (30 days unless asked): now, the lowest point and when, and the end.",
      inputSchema: { type: "object", properties: { space: SPACE, period: { type: "string", enum: PERIODS } } },
      run: (a) => wais("outlook", { ...(a.space ? { space: a.space } : {}), period: PERIODS.includes(a.period) ? a.period : "30" }),
    },
  ];
}
