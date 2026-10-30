/**
 * What Felix's AI is doing, in plain words for the chat: "Looking through your records", "Running the tests", never the
 * command, file path or tool name behind it. Claude's tools and Cursor's both come through here, so the steps read
 * the same whichever answers.
 */

/** Commands by what they're for, first match wins. */
const COMMANDS = [
  [/(^|[\s;&|(])(\.\/prs\s+test|npm\s+(run\s+)?test|node\s+--test|npx\s+(vitest|jest)|vitest|jest|pytest)\b/, "Running the tests"],
  [/(^|[\s;&|(])gh\s/, "Checking GitHub"],
  [/(^|[\s;&|(])git\s/, "Checking the code's history"],
  [/(^|[\s;&|(])(curl|wget)\s/, "Fetching a web page"],
  [/(^|[\s;&|(])(npm|npx|pnpm|yarn)\s/, "Setting things up"],
  [/(^|[\s;&|(])(rg|grep|ls|cat|head|tail|find|sed\s+-n|wc|tree|less|awk|jq)\b/, "Looking through your records"],
  [/(^|[\s;&|(])(mkdir|cp|mv|rm|touch|sed\s+-i|tee)\b/, "Making a change"],
];

/**
 * A command in plain words.
 * @param {string} command
 * @returns {string}
 */
export function commandStep(command) {
  const hit = COMMANDS.find(([re]) => re.test(String(command)));
  return hit ? hit[1] : "Running a step";
}

/** Claude's tools in plain words; a few take their own words from what they're for (see `claudeStep`). */
const CLAUDE = {
  Read: "Reading a file",
  NotebookRead: "Reading a file",
  Glob: "Looking through your records",
  Grep: "Looking through your records",
  LS: "Looking through your records",
  Edit: "Making a change",
  MultiEdit: "Making a change",
  Write: "Making a change",
  NotebookEdit: "Making a change",
  WebSearch: "Searching the web",
  WebFetch: "Reading a web page",
  TodoWrite: "Planning the steps",
  BashOutput: "Checking on a step",
  KillShell: "Stopping a step",
};

/** Felix's own service tools in plain words. */
const SERVICES = {
  calendar_events: "Checking your calendar",
  calendar_rsvp: "Answering the invite",
  out_of_office: "Checking who's out",
  on_call: "Checking who's on call",
  jira_search: "Checking Jira",
  slack_search: "Checking Slack",
  slack_post: "Posting in Slack",
  tasks_list: "Checking your tasks",
  tasks_add: "Adding the task",
  tasks_update: "Updating your task",
  tasks_delete: "Removing the task",
  personal_lists: "Checking your lists",
  personal_list_add: "Adding to your list",
  personal_habits: "Checking your habits",
  personal_habit_check: "Ticking your habit",
  personal_journal_add: "Writing in your journal",
  personal_dates: "Checking your important dates",
  personal_timeoff: "Checking your time off",
  wais_spaces: "Checking Wais",
  wais_safe_to_spend: "Checking what's safe to spend",
  wais_tasks: "Checking your bills in Wais",
  wais_outlook: "Checking your money outlook",
  prs_open: "Checking your PRs",
  ai_usage: "Checking AI usage",
  tool_build: "Starting on a new tool",
  delegate: "Handing it to a helper",
  jobs_status: "Checking on my helpers",
  my_tools: "Checking my tools",
  tool_use: "Using one of my tools",
  tool_try: "Trying the new tool",
};

/** The words a tool Felix built shows while it runs, by its name, set by his toolbox. */
let ownStep = (_name) => null;

/**
 * Lets the toolbox say what Felix's own tools show while they run.
 * @param {(name: string) => string | null} fn
 */
export function ownSteps(fn) {
  ownStep = fn;
}

/**
 * One of Felix's service tools named anywhere in a tool's name or title ("mcp__felix__calendar_events",
 * "felix-calendar_events"), in plain words.
 * @param {string} text
 * @returns {string | null}
 */
const serviceStep = (text) => {
  const name = Object.keys(SERVICES).find((n) => String(text).includes(n));
  return name ? SERVICES[name] : null;
};

/** Cursor's kinds of tool calls in plain words. */
const CURSOR = {
  read: "Reading a file",
  search: "Looking through your records",
  edit: "Making a change",
  delete: "Making a change",
  move: "Making a change",
  fetch: "Reading a web page",
  think: "Looking into it",
};

/**
 * The step a tool Claude starts shows as.
 * @param {string} name
 * @param {Record<string, unknown>} input
 * @returns {string}
 */
export function claudeStep(name, input = {}) {
  if (name === "Bash") return commandStep(String(input.command || ""));
  // A helper's task is described in plain words by the AI itself, so it can show.
  if (name === "Task" || name === "Agent") return input.description ? `Working on: ${String(input.description).slice(0, 60)}` : "Handing part of the work to a helper";
  if (name.startsWith("mcp__")) return serviceStep(name) || ownStep(name.replace(/^mcp__[^_]+__/, "")) || "Using one of my tools";
  return CLAUDE[name] || "Working";
}

/**
 * The step a tool Cursor starts shows as. Cursor names a command in backticks in its title.
 * @param {{ kind?: string, title?: string }} call
 * @returns {string}
 */
export function cursorStep(call = {}) {
  // Cursor may name one of Felix's tools in the title, its input or its extra details: wherever it is, it counts.
  const service = serviceStep(call.title || "") || serviceStep(JSON.stringify(call));
  if (service) return service;
  // A tool Felix built shows its own words; Cursor names it "felix-team_leave_year" or "mcp__felix__team_leave_year".
  const own = /felix(?:-|__)([a-z][a-z0-9_]{2,47})/.exec(JSON.stringify(call));
  if (own && ownStep(own[1])) return ownStep(own[1]);
  if (call.kind === "execute") return commandStep(String(call.title || "").replace(/`/g, ""));
  return CURSOR[String(call.kind)] || "Working";
}
