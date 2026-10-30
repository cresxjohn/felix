/**
 * Felix's tools for his AI: every connected service, so he looks things up and gets things done himself rather than
 * answering only from what he was handed. Looking things up (your calendar for any days, who's out, on-call, Jira,
 * Slack, tasks, PRs, AI usage) runs at once. Doing something (an RSVP, a task, a Slack message) shows you a card to
 * allow first, unless Settings allow everything. Tasks are the exception: you gave Felix full say over them, so adding,
 * changing, ticking off and deleting run at once. GitHub is reached with the gh command, which Felix's AI already has.
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
 * }} Services
 */

import { linkOf } from "./tasks.mjs";

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
