/**
 * Every Felix setting, its group, its default and the values it accepts. The server checks saves against this
 * list and the Settings page draws itself from it, so a new setting needs only one entry here.
 */

/** @typedef {{ value: string | number, label: string }} Option */
/**
 * @typedef {{ key: string, group: string, label: string, help: string, type: "boolean" | "choice" | "model" | "text",
 *   default: boolean | string | number, options?: Option[], requires?: string, only?: Record<string, unknown[]>,
 *   resets?: string[], tool?: string, sample?: boolean, max?: number, pattern?: RegExp, lines?: number,
 *   placeholder?: string, devices?: boolean, part?: string, voices?: boolean, hidden?: boolean, swatches?: boolean }} Setting
 * `requires` names a switch that must be on, and `only` the values other settings must have, for this one to
 * apply. `resets` lists settings that go back to their defaults when this one changes. A "model" setting holds
 * a model id, listed by the AI tool in the setting `tool` names; its choices come from the tool, not from here.
 * `sample` puts a Play sample button by the setting, for hearing Felix's voice as set. A "text" setting holds
 * what you type, up to `max` characters, matching `pattern` when it has one; `lines` makes it a box of that many
 * lines, one item a line, and `placeholder` is the grey hint, with `{key}` standing for another setting's value.
 * `devices` makes a text setting a menu of this Mac's microphones, holding the chosen one's id ("" for the default).
 * `part` puts a run of related settings in a group under a small heading on the Settings page.
 * `voices` makes a text setting a menu of this Mac's own voices. `hidden` keeps a setting off the Settings page: one
 * Felix sets himself, like how long he's paused.
 */
const UNTIL = /^$|^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const MODEL_ID = /^[\w.:\-[\]=,]{1,100}$/;
// Typed text may not carry control characters; a box of lines may carry line breaks.
const ONE_LINE = /^[^\p{Cc}]*$/u;
const MANY_LINES = /^(?:[^\p{Cc}]|\n)*$/u;
const NAME = /^\p{L}[\p{L}' -]{0,19}$/u;

/**
 * Menu items for a list of minutes: "1 minute", "15 minutes", "1 hour", "2 hours".
 * @param {number[]} list
 * @returns {Option[]}
 */
const minutes = (list) => list.map((n) => ({ value: n, label: n === 1 ? "1 minute" : n === 60 ? "1 hour" : n > 60 ? `${n / 60} hours` : `${n} minutes` }));

/**
 * A card's own Refresh every: with the other cards (0, the Auto refresh timer), its own minutes, or only when you
 * click Refresh (-1).
 * @param {string} group The card's group, which is also the start of the key.
 * @param {string} name The card, as the help names it.
 * @returns {Setting}
 */
const cardRefresh = (group, name) => ({
  key: `${group}Refresh`, group, part: "Loading", label: "Refresh every", type: "choice", default: 0, requires: "autoRefresh",
  help: `How often ${name} reloads. With the other cards follows Auto refresh. The Refresh button always reloads it.`,
  options: [{ value: 0, label: "With the other cards" }, ...minutes([1, 2, 5, 10, 15, 30, 60]), { value: -1, label: "Only when I click Refresh" }],
});

/**
 * How often the server may ask a service again; a reload sooner than this gets the same answer.
 * @param {string} key
 * @param {string} group
 * @param {string} service
 * @param {number} def Minutes.
 * @param {number[]} list
 * @returns {Setting}
 */
const askEvery = (key, group, service, def, list) => ({
  key, group, part: "Loading", label: `Ask ${service} at most every`, type: "choice", default: def, options: minutes(list),
  help: `Felix keeps ${service}'s answer this long, so reloading sooner shows the same data. Refresh in the top bar asks again at once.`,
});

/**
 * The colours a mode can wear, its own first ("default", drawn as `swatch`). Each is a colour that reads well with
 * white text; dark mode lightens it.
 * @param {string} name The mode's own colour's name.
 * @param {string} swatch Its colour, for the swatch.
 * @returns {Array<{ value: string, label: string, swatch: string }>}
 */
const accentOptions = (name, swatch) => [
  { value: "default", label: name, swatch },
  ...[["#2F55D4", "Felix blue"], ["#5C6B23", "Olive"], ["#0F766E", "Teal"], ["#15803D", "Green"], ["#0369A1", "Sky"], ["#4F46E5", "Indigo"],
    ["#7C3AED", "Violet"], ["#BE185D", "Rose"], ["#B45309", "Amber"], ["#475569", "Slate"]]
    .filter(([hex]) => hex !== swatch).map(([hex, label]) => ({ value: hex, label, swatch: hex })),
];

/** When an Open PRs count shows on the card. */
const COUNT_SHOW = [{ value: "always", label: "Always" }, { value: "some", label: "When there are some" }, { value: "never", label: "Never" }];

/** The Mac's notification sounds. */
const SOUNDS = ["Basso", "Blow", "Bottle", "Frog", "Funk", "Glass", "Hero", "Morse", "Ping", "Pop", "Purr", "Sosumi", "Submarine", "Tink"];

/** A Tasks card's views, for the "opens on" menus. */
const TASK_VIEWS = [["today", "Today"], ["upcoming", "Upcoming"], ["overdue", "Overdue"], ["someday", "Someday"], ["done", "Done"]];

/**
 * An hour of the day the way people say it: "12 AM", "7 AM", "10 PM".
 * @param {number} h From 0 to 23.
 * @returns {string}
 */
function hourLabel(h) {
  return `${h % 12 || 12} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * The lines Felix says while an answer takes a moment, out of the box. `{step}` is what he's doing right then.
 * Lines with "still" are kept for the updates after the first.
 */
export const PROGRESS_PHRASES = Object.freeze([
  "One moment, {step}.", "Hold on, {step}.", "Give me a sec, {step}.", "Bear with me, {step}.",
  "Still {step}.", "Still on it, {step}.", "Still going, {step}.",
]);

/** @type {ReadonlyArray<{ id: string, title: string, about: string }>} */
export const GROUPS = Object.freeze([
  { id: "home", title: "Home and layout", about: "Which mode the home page shows, and how it fits the window." },
  { id: "refresh", title: "Auto refresh", about: "How often the home page reloads its live cards." },
  { id: "ic", title: "Incident Commander", about: "Who's Incident Commander now and next, and your next shift, from Datadog On-Call." },
  { id: "jira", title: "My Jira Board", about: "Your open sprint, counted in your board's own columns, from Jira." },
  { id: "prs", title: "Open PRs", about: "The PR counts that need you and the release PRs on the home card, and how the Open PRs page opens." },
  { id: "ai", title: "AI usage", about: "How much of Claude's and Cursor's plan limits you've used." },
  { id: "cal", title: "Calendar", about: "Today's meetings and the days after, from your work Google Calendar." },
  { id: "slack", title: "Slack", about: "Where people mentioned you, what you saved for later, and the channels you watch, from Slack, as you." },
  { id: "ooo", title: "Team out of office", about: "Who on your team is on leave, from the Tech Team Vacation Tracker." },
  { id: "tasks", title: "Tasks", about: "The Work and Personal task cards. Tasks are saved on this Mac." },
  { id: "music", title: "Music", about: "The player in the bottom bar. Sign in to Spotify and your music plays right here in Felix." },
  { id: "felix", title: "Felix", about: "Your buddy in the bottom bar. Type a question or a command; Felix answers from your cards' data and checks every fact first." },
  { id: "voice", title: "Voice and presence", about: "How Felix sounds, how you cut in or hold a key to talk, and when he speaks up on his own or stays quiet. The pill in the top bar shows what he's doing, and mutes or pauses him." },
  { id: "friend", title: "Felix as a friend", about: "Talk to Felix about your day, good news or anything on your mind. Personal talk stays apart from work data, and he's honest with you, not a yes-man." },
  { id: "memory", title: "Memory", about: "What Felix remembers from your talks: small dated notes in your own words, kept on this Mac. Search, change, delete or export them here. Say \"off the record\" and nothing is kept; say \"forget that\" and it's gone." },
  { id: "shift", title: "Start my day", about: "Your work day: Start my day, breaks, End my day, the countdown, and the attendance messages for #attendance-engineering-ph." },
]);

/** The order of each section's sub-headings, where it isn't simply the order the settings are listed in. */
export const PART_ORDER = Object.freeze({
  felix: ["", "AI", "Conversation", "Personality"],
  voice: ["Speaking", "While he works", "Listening for his name", "Talking with him", "Speaking up"],
});

/** @type {ReadonlyArray<Setting>} */
export const SETTINGS = Object.freeze([
  {
    key: "mode", group: "home", label: "Mode", type: "choice", default: "work",
    help: "Work shows your work cards. Personal shows your own: your day, important dates, habits, tasks, lists and journal. The switch in the top bar changes it too.",
    options: [{ value: "personal", label: "Personal" }, { value: "work", label: "Work" }],
  },
  {
    key: "theme", group: "home", label: "Theme", type: "choice", default: "system",
    help: "Dark or light. Match my Mac follows your Mac's appearance as it changes during the day. Work and Personal each have their own colours in both.",
    options: [{ value: "system", label: "Match my Mac" }, { value: "dark", label: "Dark" }, { value: "light", label: "Light" }],
  },
  {
    key: "accentWork", group: "home", label: "Work colour", type: "choice", default: "default", swatches: true,
    help: "The colour of buttons, links and highlights in Work mode. Felix blue comes from Felix's smile.",
    options: accentOptions("Felix blue", "#2F55D4"),
  },
  {
    key: "accentPersonal", group: "home", label: "Personal colour", type: "choice", default: "default", swatches: true,
    help: "The same, for Personal mode. Olive is Personal's own.",
    options: accentOptions("Olive", "#5C6B23"),
  },
  {
    key: "fitToScreen", group: "home", label: "Fit to screen", type: "boolean", default: false,
    help: "The home page fills the window exactly, with no page scrolling, so every card is in view at once. A card whose content is longer than its space scrolls on its own. Works on wide windows, where cards sit side by side.",
  },
  { key: "cardIcons", group: "home", part: "Cards", label: "Card icons", type: "boolean", default: true, help: "The small icon by each card's name." },
  { key: "cardLinks", group: "home", part: "Cards", label: "Card links", type: "boolean", default: true, help: "The link at a card's top right, like Open Jira." },
  { key: "cardUpdated", group: "home", part: "Cards", label: "When cards were updated", type: "boolean", default: true, help: "\"Updated 2m ago\" at the foot of each card." },
  {
    key: "autoRefresh", group: "refresh", label: "Auto refresh", type: "boolean", default: true,
    help: "Reloads the live cards on a timer while the window is in view. The ring around the refresh button shows how long until the next reload.",
  },
  {
    key: "refreshMinutes", group: "refresh", label: "Refresh every", type: "choice", default: 1, requires: "autoRefresh",
    help: "Each reload of Open PRs uses about 13 of GitHub's 5,000 points an hour, so every minute is about 16%.",
    options: [1, 2, 5, 10, 15].map((n) => ({ value: n, label: n === 1 ? "1 minute" : `${n} minutes` })),
  },
  // ---------- Incident Commander ----------
  { key: "icNext", group: "ic", label: "Who's next", type: "boolean", default: true, help: "Shows who takes over next, and when." },
  { key: "icMine", group: "ic", label: "Your shift", type: "boolean", default: true, help: "Shows when your next shift is." },
  {
    key: "icLookahead", group: "ic", label: "Look for your shift in the next", type: "choice", default: 45, requires: "icMine",
    help: "How far ahead Felix looks for your next shift.", options: [14, 30, 45, 60].map((n) => ({ value: n, label: `${n} days` })),
  },
  {
    key: "icDays", group: "ic", label: "Days of shifts", type: "choice", default: 2,
    help: "How many days the shifts table and Coming up cover.",
    options: [{ value: 1, label: "Today" }, { value: 2, label: "Today and tomorrow" }, ...[3, 5, 7].map((n) => ({ value: n, label: `${n} days` }))],
  },
  {
    key: "icComingUp", group: "ic", label: "Coming up", type: "choice", default: 2,
    help: "How many later shifts a narrow card lists when it has room.",
    options: [{ value: 0, label: "None" }, ...[1, 2, 3, 4, 5].map((n) => ({ value: n, label: n === 1 ? "1 shift" : `${n} shifts` }))],
  },
  { key: "icTable", group: "ic", label: "Shifts table", type: "boolean", default: true, help: "On a wide card, shows each schedule's shifts by day." },
  { key: "icZone", group: "ic", label: "Show the time zone", type: "boolean", default: false, help: "Adds the time zone to the card's times, like 10:00 PM GMT+8." },
  askEvery("icCache", "ic", "Datadog", 60, [15, 30, 60, 120, 240]),
  cardRefresh("ic", "Incident Commander"),
  // ---------- My Jira Board ----------
  {
    key: "jiraBoard", group: "jira", label: "Board", type: "text", default: "181", max: 9, pattern: /^[1-9]\d{0,8}$/,
    help: "The number after /boards/ in your board's address. The Set up form on the card fills it in.",
  },
  {
    key: "jiraWhose", group: "jira", label: "Count", type: "choice", default: "mine",
    help: "Count only your tickets, or every ticket in the sprint. On your plate always lists yours.",
    options: [{ value: "mine", label: "My tickets" }, { value: "all", label: "The whole sprint" }],
  },
  {
    key: "jiraSprint", group: "jira", label: "Sprint line", type: "choice", default: "left", help: "How the sprint's name shows at the top.",
    options: [{ value: "left", label: "Name and days left" }, { value: "end", label: "Name and end date" }, { value: "name", label: "Name only" }, { value: "none", label: "Hide it" }],
  },
  { key: "jiraProgress", group: "jira", label: "Progress bar", type: "boolean", default: true, help: "Shows how many tickets are done, like 6 of 27 done." },
  { key: "jiraEmpty", group: "jira", label: "Empty columns", type: "boolean", default: true, help: "Shows columns with nothing in them, greyed out." },
  {
    key: "jiraHide", group: "jira", label: "Columns to hide", type: "text", default: "", max: 500, lines: 3,
    help: "One column a line, named as on the board, like Done.",
  },
  {
    key: "jiraPlate", group: "jira", label: "On your plate", type: "choice", default: 3, help: "How many of your tickets in play the card lists.",
    options: [{ value: 0, label: "Hide it" }, ...[3, 5, 8, 10].map((n) => ({ value: n, label: `${n} tickets` }))],
  },
  askEvery("jiraCache", "jira", "Jira", 1, [1, 2, 5, 10, 15]),
  cardRefresh("jira", "My Jira Board"),
  // ---------- Open PRs ----------
  { key: "prsTotals", group: "prs", label: "Totals", type: "boolean", default: true, help: "Shows the two big numbers: PRs to review, and yours." },
  ...[
    ["prsNeeds", "Need your review", "always"], ["prsNewCommits", "New commits since your review", "some"], ["prsAiReview", "AI review waiting", "always"],
    ["prsReadyMerge", "Ready to merge", "always"], ["prsFailing", "Checks failing", "always"], ["prsConflict", "Merge conflicts", "some"],
    ["prsQueue", "In merge queue", "some"], ["prsChanges", "Changes requested", "some"], ["prsAiFix", "AI fix needs you", "some"],
  ].map(([key, label, def]) => ({ key, group: "prs", part: "Counts", label, type: "choice", default: def, options: COUNT_SHOW, help: `When the card shows this count.` })),
  {
    key: "prsRepos", group: "prs", part: "Card", label: "Repos", type: "choice", default: "both", help: "Which repos the card counts and shows releases for.",
    options: [{ value: "both", label: "Both" }, { value: "fm", label: "frontend-monorepo" }, { value: "bm", label: "backend-monorepo" }],
  },
  { key: "prsReleases", group: "prs", part: "Card", label: "Releases", type: "boolean", default: true, help: "Shows each repo's release PR, with Approve and Merge." },
  cardRefresh("prs", "Open PRs"),
  {
    key: "prsPageTab", group: "prs", part: "Open PRs page", label: "Open PRs page opens on", type: "choice", default: "mine", help: "The tab the page shows first.",
    options: [{ value: "mine", label: "My PRs" }, { value: "review", label: "Needs my review" }],
  },
  {
    key: "prsPageSort", group: "prs", part: "Open PRs page", label: "Page sorts by", type: "choice", default: "attention", help: "The page's first sort, before you pick another.",
    options: [["attention", "Needs attention first"], ["updated", "Recently updated"], ["stale", "Least recently updated"], ["newest", "Newest"],
      ["oldest", "Oldest"], ["largest", "Largest"], ["smallest", "Smallest"], ["number", "PR number"]].map(([value, label]) => ({ value, label })),
  },
  { key: "prsPageGroup", group: "prs", part: "Open PRs page", label: "Page groups by repo", type: "boolean", default: true, help: "Off shows one list across both repos." },
  {
    key: "prsPageRefresh", group: "prs", part: "Open PRs page", label: "Page reloads every", type: "choice", default: 5, help: "How often the Open PRs page reloads itself.",
    options: minutes([1, 2, 5, 10, 15, 30]),
  },
  // ---------- AI usage ----------
  { key: "aiClaude", group: "ai", label: "Claude", type: "boolean", default: true, help: "Shows Claude Code's limits." },
  { key: "aiCursor", group: "ai", label: "Cursor", type: "boolean", default: true, help: "Shows Cursor's limits." },
  {
    key: "aiOwnColours", group: "ai", part: "Colours", label: "Claude picks its own colours", type: "boolean", default: true, requires: "aiClaude",
    help: "Claude says itself when a limit is close. Off, Claude follows the levels below, as Cursor does.",
  },
  {
    key: "aiWarnAt", group: "ai", part: "Colours", label: "Amber from", type: "choice", default: 80, help: "When a limit's bar turns amber.",
    options: [50, 60, 70, 75, 80, 85, 90, 95].map((n) => ({ value: n, label: `${n}%` })),
  },
  {
    key: "aiBadAt", group: "ai", part: "Colours", label: "Red from", type: "choice", default: 100, help: "When a limit's bar turns red.",
    options: [80, 90, 95, 100].map((n) => ({ value: n, label: `${n}%` })),
  },
  { key: "aiSpend", group: "ai", part: "Details", label: "Spend", type: "boolean", default: true, help: "Shows Claude's extra usage and Cursor's on-demand spend in the details." },
  askEvery("aiCache", "ai", "the AI tools", 2, [1, 2, 5, 10]),
  cardRefresh("ai", "AI usage"),
  // ---------- Calendar ----------
  {
    key: "calDays", group: "cal", label: "Days to show", type: "choice", default: 2, help: "Today, and the days after it when the card has room.",
    options: [{ value: 1, label: "Today only" }, { value: 2, label: "Today and tomorrow" }, ...[3, 4, 5, 7].map((n) => ({ value: n, label: `${n} days` }))],
  },
  { key: "calPast", group: "cal", label: "Meetings that ended", type: "boolean", default: true, help: "Keeps today's past meetings in the list, greyed out." },
  { key: "calAllDay", group: "cal", label: "All-day events", type: "boolean", default: true, help: "Shows events that last all day." },
  { key: "calDeclined", group: "cal", label: "Meetings you declined", type: "boolean", default: false, help: "Shows them, marked Declined." },
  { key: "calReplies", group: "cal", label: "Yes, Maybe and No", type: "boolean", default: true, help: "Answer buttons on invites you haven't answered." },
  {
    key: "calJoin", group: "cal", label: "Join stands out", type: "choice", default: "next", help: "When Join turns into the main button.",
    options: [{ value: "next", label: "For the next meeting" }, ...[15, 10, 5].map((n) => ({ value: n, label: `${n} minutes before` })), { value: "never", label: "Never" }],
  },
  { key: "calCountdown", group: "cal", label: "Next in", type: "boolean", default: true, help: "Shows how long until your next meeting, at the top of the card." },
  askEvery("calCache", "cal", "Google", 5, [1, 2, 5, 10, 15]),
  cardRefresh("cal", "Calendar"),
  // ---------- Team out of office ----------
  {
    key: "oooView", group: "ooo", label: "Opens on", type: "choice", default: "last", help: "The view the card shows when it loads.",
    options: [{ value: "last", label: "The one I picked last" }, { value: "today", label: "Today" }, { value: "tomorrow", label: "Tomorrow" }, { value: "upcoming", label: "Upcoming" }],
  },
  {
    key: "oooWho", group: "ooo", label: "Shows", type: "choice", default: "last", help: "Your team or everyone, when the card loads.",
    options: [{ value: "last", label: "The one I picked last" }, { value: "team", label: "My team" }, { value: "all", label: "Everyone" }],
  },
  {
    key: "oooAhead", group: "ooo", label: "Upcoming looks ahead", type: "choice", default: 60, help: "How far the Upcoming view reaches, from tomorrow.",
    options: [[14, "2 weeks"], [30, "1 month"], [60, "2 months"], [90, "3 months"], [180, "6 months"]].map(([value, label]) => ({ value, label })),
  },
  { key: "oooKind", group: "ooo", label: "Kind of leave", type: "boolean", default: true, help: "Shows PTO, VL and the like by each name." },
  { key: "oooNote", group: "ooo", label: "Notes", type: "boolean", default: true, help: "Shows the tracker's note, like (Birthday)." },
  { key: "oooWhole", group: "ooo", label: "Out the whole time", type: "boolean", default: true, help: "Marks who's out for every day of a longer view." },
  { key: "oooNew", group: "ooo", label: "Ask about new names", type: "boolean", default: true, help: "Asks whether a new name in the tracker is on your team." },
  askEvery("oooCache", "ooo", "Google", 5, [1, 2, 5, 10, 15]),
  cardRefresh("ooo", "Team out of office"),
  // ---------- Slack ----------
  {
    key: "slackDays", group: "slack", label: "Mentions from the last", type: "choice", default: 3, help: "How far back the card looks for messages that mention you.",
    options: [{ value: 1, label: "Day" }, { value: 3, label: "3 days" }, { value: 7, label: "Week" }, { value: 14, label: "2 weeks" }],
  },
  { key: "slackSaved", group: "slack", label: "Saved for later", type: "boolean", default: true, help: "Shows the messages you saved for later in Slack." },
  {
    key: "slackWatch", group: "slack", label: "Channels to watch", type: "text", default: "", max: 600, lines: 3, placeholder: "eng-releases, incidents",
    help: "Channels whose unread messages the card counts, one per line or separated by commas. You must be in them.",
  },
  askEvery("slackCache", "slack", "Slack", 2, [1, 2, 5, 10, 15]),
  cardRefresh("slack", "Slack"),
  // ---------- Tasks ----------
  {
    key: "tasksView", group: "tasks", part: "Views", label: "Work card opens on", type: "choice", default: "last", help: "The view the Work card shows when it loads.",
    options: [{ value: "last", label: "The one I picked last" }, ...TASK_VIEWS.map(([value, label]) => ({ value, label }))],
  },
  {
    key: "ptasksView", group: "tasks", part: "Views", label: "Personal card opens on", type: "choice", default: "last", help: "The view the Personal card shows when it loads.",
    options: [{ value: "last", label: "The one I picked last" }, ...TASK_VIEWS.map(([value, label]) => ({ value, label }))],
  },
  { key: "tasksUpcoming", group: "tasks", part: "Views", label: "Upcoming view", type: "boolean", default: true, help: "Tasks due after today." },
  {
    key: "tasksOverdue", group: "tasks", part: "Views", label: "Overdue view", type: "choice", default: "work", help: "Tasks past their day. Today lists them too.",
    options: [{ value: "work", label: "Work card only" }, { value: "both", label: "Both cards" }, { value: "none", label: "Neither" }],
  },
  { key: "tasksSomeday", group: "tasks", part: "Views", label: "Someday view", type: "boolean", default: true, help: "Tasks with no day." },
  { key: "tasksDone", group: "tasks", part: "Views", label: "Done view", type: "boolean", default: true, help: "Tasks you've ticked off." },
  { key: "tasksDoneToday", group: "tasks", part: "Views", label: "Keep done tasks in Today", type: "boolean", default: true, help: "A task you tick stays at the bottom of Today until midnight." },
  {
    key: "tasksNewAt", group: "tasks", part: "New tasks", label: "New tasks go", type: "choice", default: "top", help: "Where a task you add lands in the list.",
    options: [{ value: "top", label: "At the top" }, { value: "bottom", label: "At the bottom" }],
  },
  {
    key: "tasksPriority", group: "tasks", part: "New tasks", label: "Priority for new tasks", type: "choice", default: 0, help: "Used when you don't type one, like !high.",
    options: ["None", "Low", "Medium", "High"].map((label, value) => ({ value, label })),
  },
  {
    key: "tasksAtPm", group: "tasks", part: "New tasks", label: "\"at 3\" means", type: "choice", default: 7,
    help: "A time typed with no AM or PM. Hours up to this one are the afternoon; later ones the morning.",
    options: [{ value: 0, label: "Always the morning" }, ...[5, 6, 7, 8, 9, 11].map((n) => ({ value: n, label: `PM up to at ${n}` }))],
  },
  { key: "tasksLabels", group: "tasks", part: "Rows", label: "Labels", type: "boolean", default: true, help: "Shows a task's first label, which filters the list when clicked." },
  {
    key: "tasksLinks", group: "tasks", part: "Rows", label: "Links on a task", type: "choice", default: 2, help: "PR, ticket and web links shown on each row.",
    options: [{ value: 0, label: "None" }, ...[1, 2, 3].map((n) => ({ value: n, label: `Up to ${n}` }))],
  },
  { key: "tasksSubs", group: "tasks", part: "Rows", label: "Subtask count", type: "boolean", default: true, help: "Shows how many subtasks are done, like 1/3." },
  { key: "tasksRepeat", group: "tasks", part: "Rows", label: "Repeat mark", type: "boolean", default: true, help: "Shows ↻ on tasks that repeat." },
  { key: "tasksDrag", group: "tasks", part: "Rows", label: "Drag to reorder", type: "boolean", default: true, help: "Drag tasks in Today to put them in order." },
  { key: "tasksReminders", group: "tasks", part: "Reminders", label: "Reminders", type: "boolean", default: true, help: "A Mac notification when a task with a time is due." },
  {
    key: "tasksSound", group: "tasks", part: "Reminders", label: "Reminder sound", type: "choice", default: "Glass", requires: "tasksReminders", help: "The sound the notification makes.",
    options: [...SOUNDS.map((s) => ({ value: s, label: s })), { value: "none", label: "No sound" }],
  },
  cardRefresh("tasks", "the Work Tasks card"),
  {
    key: "musicSeekSeconds", group: "music", label: "Arrow keys jump", type: "choice", default: 10,
    help: "How far ← and → move in the song while the player is open. Shift with an arrow goes to the previous or next song.",
    options: [5, 10, 15, 30].map((n) => ({ value: n, label: `${n} seconds` })),
  },
  {
    key: "musicLyrics", group: "music", label: "Lyrics", type: "boolean", default: true,
    help: "Shows a Lyrics button in the player, with the words moving along as the song plays. Lyrics come from LRCLIB, a free lyrics library. Felix sends it only the song's title, artist, album and length.",
  },
  {
    key: "felixOn", group: "felix", label: "Felix", type: "boolean", default: true,
    help: "Shows the chat box in the bottom bar. Common questions and commands are answered on this Mac with no AI; the rest use Claude through your Claude Code plan.",
  },
  {
    key: "felixTool", group: "felix", part: "AI", label: "AI", type: "choice", default: "auto", requires: "felixOn", resets: ["felixModel", "felixFriendModel"],
    help: "Auto uses Claude Code while your Claude plan has room, and Cursor once a Claude limit is used up, so nothing is billed as Claude extra usage. Cursor takes about 10 seconds more, since its CLI starts fresh for each question. Claude or Cursor always uses that one.",
    options: [{ value: "auto", label: "Auto" }, { value: "claude", label: "Claude" }, { value: "cursor", label: "Cursor" }],
  },
  {
    key: "felixModel", group: "felix", part: "AI", label: "Model", type: "model", default: "auto", requires: "felixOn", tool: "felixTool",
    help: "Auto lets Felix pick for each question: Sonnet for quick ones, and Opus for summaries, explanations and advice. On Cursor, Composer 2.5 Fast for quick ones and Cursor's Opus for the rest. Or pick one model for every work question, from the same lists as Open PRs. Personal talk uses its own model (Felix as a friend), and learning uses the smallest one.",
  },
  {
    key: "felixChatStyle", group: "felix", part: "Conversation", label: "Show the conversation as", type: "choice", default: "bubbles", requires: "felixOn",
    help: "Bubbles above the bar that fade when things go quiet, nothing at all, or the full chat. Bubbles show your words live as you speak, and their corner button opens the full chat. With Voice only, a typed question's answer shows for a moment above the bar. Any style opens the full chat when Felix needs you to allow a change.",
    options: [{ value: "bubbles", label: "Bubbles" }, { value: "hidden", label: "Voice only" }, { value: "panel", label: "Full chat" }],
  },
  {
    key: "felixChatEars", group: "felix", part: "Conversation", label: "Listen while we talk", type: "boolean", default: true, requires: "felixOn",
    help: "Once you start a conversation, Felix keeps listening, so you can just talk. He waits through short pauses, and what you say while he works is added to what he's doing; with Cut in while he talks on, you can talk over him too. Typing pauses it, the mic button turns it off, and two quiet minutes, Esc or closing the chat end it, and the mic closes.",
  },
  {
    key: "felixPermissions", group: "felix", part: "AI", label: "Changes", type: "choice", default: "ask", requires: "felixOn",
    help: "What Felix's AI may do without asking, like Claude Code's permission modes. Ask before changes: reading, and editing in Felix's own workbench, go straight through; any other command or file change waits for your Allow. Allow everything: commands and file changes run without asking, like bypass permissions. Either way, a few things, like your login and the Keychain, are never run, and he searches the web only when you ask.",
    options: [{ value: "ask", label: "Ask before changes" }, { value: "all", label: "Allow everything" }],
  },
  {
    key: "felixCursorFallback", group: "felix", part: "AI", label: "Use Cursor when Claude runs out", type: "boolean", default: true, requires: "felixOn",
    only: { felixTool: ["claude"] },
    help: "When Claude stops at your usage limit, Cursor answers instead. This is for when Claude is picked above (Auto always does it), with extra usage off. Cursor uses the same Claude model when it has it (Haiku, Sonnet or Opus), and its own pick otherwise.",
  },
  {
    key: "felixTalk", group: "voice", part: "Speaking", label: "Read replies aloud", type: "choice", default: "voice", requires: "felixOn",
    help: "When Felix reads his replies out loud: only when you talked to him, always, or never. Hearing and speaking both run on this Mac, so no audio leaves it. Set up once with ./prs voice.",
    options: [{ value: "voice", label: "When I talk" }, { value: "always", label: "Always" }, { value: "never", label: "Never" }],
  },
  {
    key: "felixVoiceEngine", group: "voice", part: "Speaking", label: "Voice engine", type: "choice", default: "kokoro", requires: "felixOn",
    help: "Kokoro sounds the most natural, and can be made on this device or the Mac (Where Kokoro is made, below). Apple's voices are the Mac's own, made on the Mac; the Premium and Enhanced ones (a free download in System Settings, Accessibility, Spoken Content) sound much better. Both are free and stay on your devices.",
    options: [{ value: "kokoro", label: "Kokoro" }, { value: "mac", label: "Apple's voices" }],
  },
  {
    key: "felixVoiceWhere", group: "voice", part: "Speaking", label: "Where Kokoro is made", type: "choice", default: "auto", requires: "felixOn",
    only: { felixVoiceEngine: ["kokoro"] },
    help: "For the Kokoro voice. Auto makes Felix's voice on the device you're using once its copy is downloaded (Voice on this device, below), and on the Mac until then. Made on the device, it leaves the Mac free and runs on the device's graphics chip, usually with no pauses. If the device can't make a phrase, the Mac does.",
    options: [{ value: "auto", label: "Auto" }, { value: "device", label: "This device" }, { value: "mac", label: "The Mac" }],
  },
  {
    key: "felixVoice", group: "voice", part: "Speaking", label: "Voice", type: "choice", default: "am_michael", requires: "felixOn", only: { felixVoiceEngine: ["kokoro"] }, sample: true,
    help: "Felix's Kokoro voice, one of its American male voices, the clearest first. Until Kokoro is set up, the Mac's own voice speaks instead. Play sample reads a random line.",
    options: [
      { value: "am_michael", label: "Michael" }, { value: "am_fenrir", label: "Fenrir" }, { value: "am_puck", label: "Puck" },
      { value: "am_adam", label: "Adam" }, { value: "am_echo", label: "Echo" }, { value: "am_eric", label: "Eric" },
      { value: "am_liam", label: "Liam" }, { value: "am_onyx", label: "Onyx" }, { value: "am_santa", label: "Santa (jolly)" },
    ],
  },
  {
    key: "felixMacVoice", group: "voice", part: "Speaking", label: "Apple voice", type: "text", default: "", requires: "felixOn", only: { felixVoiceEngine: ["mac"] }, max: 80, voices: true, sample: true,
    help: "Which of Apple's English voices Felix speaks with, when the voice engine is Apple's voices. They're always made on the Mac.",
  },
  {
    key: "felixSpeed", group: "voice", part: "Speaking", label: "Speaking speed", type: "choice", default: 1, requires: "felixOn", sample: true,
    help: "How fast Felix talks.",
    options: [{ value: 0.9, label: "Relaxed" }, { value: 1, label: "Normal" }, { value: 1.15, label: "Brisk" }, { value: 1.3, label: "Fast" }],
  },
  {
    key: "felixName", group: "felix", part: "Personality", label: "Felix's name", type: "text", default: "Felix", requires: "felixOn", max: 20, pattern: NAME,
    help: "What your buddy is called. He answers to it, uses it when he talks about himself, and the chat box shows it. Letters only, up to 20.",
  },
  {
    key: "felixWakeOn", group: "voice", part: "Listening for his name", label: "Listen for the activation phrase", type: "boolean", default: false, requires: "felixOn",
    help: "While a Felix window is open and in view, the microphone stays on and Felix listens for his phrase. Each bit of speech is written out by whisper on this Mac, and anything that doesn't start with the phrase is dropped at once, never kept or shown. He doesn't listen while he talks, while you use the mic button, or while the window is hidden. The pill in the top bar turns it on or off too.",
  },
  {
    key: "felixWake", group: "voice", part: "Listening for his name", label: "Activation phrase", type: "text", default: "", requires: "felixOn", max: 40, placeholder: "Hey {felixName}",
    help: "The words that wake Felix when he's listening for them, and that start a question, like \"Hey Felix, who's on call?\". Left empty, it follows his name.",
  },
  {
    key: "felixWakeName", group: "voice", part: "Listening for his name", label: "Also wake on just the name", type: "boolean", default: true, requires: "felixWakeOn",
    help: "\"Felix, who's on call?\" wakes him too, not only the whole phrase. Only at the start: \"I told Felix\" doesn't.",
  },
  {
    key: "felixWakeLevel", group: "voice", part: "Listening for his name", label: "Sensitivity", type: "choice", default: "normal", requires: "felixWakeOn",
    help: "How loud speech must be before Felix checks it for his phrase. High hears you from across the room but checks more background talk; Low needs you close.",
    options: [{ value: "high", label: "High" }, { value: "normal", label: "Normal" }, { value: "low", label: "Low" }],
  },
  {
    key: "felixMic", group: "voice", part: "Listening for his name", label: "Microphone", type: "text", default: "", requires: "felixOn", max: 200, devices: true,
    help: "Which microphone Felix hears you on, for the mic button and the activation phrase. The Mac's default follows System Settings.",
  },
  {
    key: "felixLearnPhrases", group: "felix", part: "Conversation", label: "Offer to learn my phrases", type: "boolean", default: true, requires: "felixOn",
    help: "When you say something Felix's commands don't know and his AI works out which one you meant, he runs it and offers to remember your words, so next time they run right here with no AI. Your learned phrases are listed below.",
  },
  {
    key: "felixLeanAt", group: "felix", part: "AI", label: "Lean on lighter models at", type: "choice", default: 80, requires: "felixOn", only: { felixTool: ["auto"] },
    help: "On Auto: Felix and your PR reviews share Claude's plan. Once any of its limits is this full, Felix answers with lighter models (Haiku for quick questions, Sonnet for bigger ones) to leave room for reviews. Local commands never use it.",
    options: [{ value: 0, label: "Never" }, { value: 70, label: "70% used" }, { value: 80, label: "80% used" }, { value: 90, label: "90% used" }],
  },
  {
    key: "felixKeepListening", group: "voice", part: "Talking with him", label: "Keep the conversation going", type: "boolean", default: true, requires: "felixOn", only: { felixChatEars: [false] },
    help: "With Listen while we talk off: when you talk to Felix, he listens for your reply after he answers, so you can go back and forth hands-free. Stay quiet, or say \"that's all\", to finish.",
  },
  {
    key: "felixReplyWait", group: "voice", part: "Talking with him", label: "Wait for your reply", type: "choice", default: 7, requires: "felixKeepListening",
    help: "How long he listens after answering before the conversation ends on its own.",
    options: [{ value: 4, label: "4 seconds" }, { value: 7, label: "7 seconds" }, { value: 10, label: "10 seconds" }, { value: 15, label: "15 seconds" }],
  },
  { key: "felixReplyChime", group: "voice", part: "Talking with him", label: "Chime when it's your turn", type: "boolean", default: true, requires: "felixKeepListening", help: "A soft two-note sound when he starts listening for your reply." },
  {
    key: "felixBargeIn", group: "voice", part: "Talking with him", label: "Cut in while he talks", type: "boolean", default: true, requires: "felixOn",
    help: "While Felix reads a reply aloud, just start talking: his voice drops the moment you do, then he stops and listens, and what you say is your next question. \"Stop\" or \"wait\" just stops him. His own voice is taken out, so it doesn't count as you, and if it was only a cough he carries on. Works once you've let this page use the microphone.",
  },
  {
    key: "felixPttKey", group: "voice", part: "Talking with him", label: "Hold to talk", type: "choice", default: "", requires: "felixOn",
    help: "Hold this key while the Felix window is in front, talk, and let go. Works even in a meeting, when he isn't listening for his name.",
    options: [{ value: "", label: "Off" }, { value: "AltRight", label: "Right Option" }, { value: "ControlRight", label: "Right Control" }, { value: "MetaRight", label: "Right Command" }, { value: "F5", label: "F5" }],
  },
  {
    key: "felixMuteKey", group: "voice", part: "Talking with him", label: "Mute key", type: "choice", default: "shift-meta-m", requires: "felixOn",
    help: "Mutes or unmutes Felix while the Felix window is in front. Muted, he doesn't speak or listen for his name; typing still works.",
    options: [{ value: "", label: "Off" }, { value: "shift-meta-m", label: "Shift ⌘ M" }, { value: "shift-meta-period", label: "Shift ⌘ ." }],
  },
  { key: "felixMuted", group: "voice", part: "Talking with him", label: "Muted", type: "boolean", default: false, requires: "felixOn", help: "Felix doesn't speak or listen for his name. The pill in the top bar turns it on or off too." },
  { key: "felixPausedUntil", group: "voice", part: "Talking with him", label: "Paused until", type: "text", default: "", max: 30, pattern: UNTIL, hidden: true, help: "Set by \"Pause for 30 minutes\" in the top bar." },
  {
    key: "felixSpeakUp", group: "voice", part: "Speaking up", label: "Speak up on my own", type: "boolean", default: false, requires: "felixOn",
    help: "Felix tells you, out loud and in the chat, when something you started is done, without you asking. Watchers you set up always tell you.",
  },
  { key: "felixSpeakReviews", group: "voice", part: "Speaking up", label: "When a review is ready", type: "boolean", default: true, requires: "felixSpeakUp", help: "\"Claude's review of fm#12247 is ready.\"" },
  { key: "felixSpeakFixes", group: "voice", part: "Speaking up", label: "When a fix is ready", type: "boolean", default: true, requires: "felixSpeakUp", help: "\"Claude's fix of fm#12247 is ready to look at.\"" },
  {
    key: "felixQuietMeetings", group: "voice", part: "Speaking up", label: "Quiet in meetings", type: "boolean", default: true, requires: "felixOn",
    help: "During a meeting on your calendar that you haven't declined, Felix doesn't speak up on his own or listen for his name; what he'd say shows in the chat. Hold to talk still works.",
  },
  {
    key: "felixAwayMinutes", group: "voice", part: "Speaking up", label: "Quiet when I'm away for", type: "choice", default: 5, requires: "felixOn",
    help: "When nobody's touched the keyboard or mouse for this long, or the screen is locked, Felix stays quiet and stops listening for his name until you're back. To talk to him from across the room, pick Only when locked.",
    options: [{ value: 0, label: "Only when locked" }, { value: 2, label: "2 minutes" }, { value: 5, label: "5 minutes" }, { value: 10, label: "10 minutes" }, { value: 15, label: "15 minutes" }],
  },
  {
    key: "felixCare", group: "voice", part: "Speaking up", label: "Nudge me to take breaks", type: "boolean", default: false, requires: "felixOn",
    help: "While your work day runs (Start my day), Felix gently suggests a break after a long stretch without one. Three a day at most, never in a meeting or when you're away.",
  },
  {
    key: "felixCareAfter", group: "voice", part: "Speaking up", label: "Nudge after", type: "choice", default: 120, requires: "felixCare",
    help: "How long without a break before a nudge.",
    options: [60, 90, 120, 180].map((m) => ({ value: m, label: m % 60 ? `${Math.floor(m / 60)} hour ${m % 60} minutes` : `${m / 60} hour${m === 60 ? "" : "s"}` })),
  },
  {
    key: "felixWords", group: "voice", part: "Listening for his name", label: "Names and words", type: "text", default: "", requires: "felixOn", max: 2000, lines: 4,
    help: "Names and words Felix should hear and say right, one a line. Add \" = \" and how to say it to change how he reads it aloud, like \"PMHUB = P M hub\". Your team, the people on call and your Jira projects are added on their own (listed below).",
  },
  {
    key: "felixYourName", group: "felix", part: "Personality", label: "Your name", type: "text", default: "", requires: "felixOn", max: 30,
    help: "What Felix calls you, now and then, not in every line. Left empty, he doesn't use a name.",
  },
  {
    key: "felixTone", group: "felix", part: "Personality", label: "Tone", type: "choice", default: "casual", requires: "felixOn",
    help: "How Felix's AI replies sound. Casual talks like a good friend on Slack, Balanced is friendly but to the point, Professional is polite and plain, still warm. Whatever the tone, he sticks to the facts.",
    options: [{ value: "casual", label: "Casual" }, { value: "balanced", label: "Balanced" }, { value: "professional", label: "Professional" }],
  },
  {
    key: "felixChatty", group: "felix", part: "Personality", label: "How chatty", type: "choice", default: "normal", requires: "felixOn",
    help: "How much Felix says. Brief gives the answer and little else; Chatty adds a friendly line or a tip. Summaries and briefings run longer either way.",
    options: [{ value: "brief", label: "Brief" }, { value: "normal", label: "Normal" }, { value: "chatty", label: "Chatty" }],
  },
  {
    key: "felixHumor", group: "felix", part: "Personality", label: "Humor", type: "choice", default: "some", requires: "felixOn",
    help: "How much Felix jokes. Even at More, he keeps it for light moments, never for bad news.",
    options: [{ value: "none", label: "None" }, { value: "some", label: "A little" }, { value: "more", label: "More" }],
  },
  {
    key: "felixProgress", group: "voice", part: "While he works", label: "Say what I'm doing", type: "boolean", default: true, requires: "felixOn",
    help: "When Felix reads a reply aloud and it takes a moment, he says once what he's doing, like \"Hold on, checking GitHub\". The reply cuts it off, and so does Stop talking.",
  },
  {
    key: "felixProgressDelay", group: "voice", part: "While he works", label: "Speak up after", type: "choice", default: 1.5, requires: "felixProgress",
    help: "How long Felix waits with no answer before he says what he's doing.",
    options: [1, 1.5, 2, 3].map((n) => ({ value: n, label: `${n} seconds` })),
  },
  {
    key: "felixProgressEvery", group: "voice", part: "While he works", label: "Update every", type: "choice", default: 0, requires: "felixProgress",
    help: "Felix says one line when he starts on your question. Never keeps it to that one; otherwise he adds a short update this often while the answer is still coming.",
    options: [{ value: 0, label: "Never" }, ...[6, 10, 15].map((n) => ({ value: n, label: `${n} seconds` }))],
  },
  {
    key: "felixProgressPhrases", group: "voice", part: "While he works", label: "Lines he says while working", type: "text", default: PROGRESS_PHRASES.join("\n"), requires: "felixProgress",
    max: 1000, lines: 4,
    help: "One line each. {step} is what Felix is doing right then, like \"checking GitHub\". Lines with \"still\" are for the updates. Empty the box to go back to these.",
  },
  {
    key: "felixMemoryLearn", group: "memory", label: "Learn from our talks", type: "boolean", default: true, requires: "felixOn",
    help: "After a conversation goes quiet, Felix asks his AI once (its smallest model) what's worth remembering, and keeps short notes in your own words. Secrets are never kept. Off pauses learning; what he already knows stays and he still uses it.",
  },
  {
    key: "felixMemoryAfter", group: "memory", label: "A talk ends after", type: "choice", default: 10, requires: "felixMemoryLearn",
    help: "How long you're quiet before Felix counts the conversation as over and learns from it.",
    options: [5, 10, 30].map((n) => ({ value: n, label: `${n} minutes quiet` })),
  },
  {
    key: "felixFriendOn", group: "friend", label: "Friend mode", type: "boolean", default: true, requires: "felixOn",
    help: "When you talk about how you feel, the people in your life or your day, Felix answers as a friend: no work data comes into it, and it goes to the model below. Off, he treats everything as work questions. If you ever sound like you're in danger, he always shows how to reach real help.",
  },
  {
    key: "felixFriendPersonality", group: "friend", label: "Personality", type: "choice", default: "warm", requires: "felixFriendOn",
    help: "How Felix is with you in personal talk. Whatever you pick, he stays honest.",
    options: [{ value: "warm", label: "Warm" }, { value: "cheerful", label: "Cheerful" }, { value: "calm", label: "Calm" }, { value: "direct", label: "Straight-talking" }],
  },
  {
    key: "felixFriendModel", group: "friend", label: "Model for personal talk", type: "model", default: "auto", requires: "felixFriendOn", tool: "felixTool",
    help: "Auto uses Sonnet, which takes more care than the quick picks: Claude's, or Cursor's when Cursor answers. Or pick one model for personal talk.",
  },
  {
    key: "felixFriendRemember", group: "friend", label: "What Felix may remember", type: "choice", default: "everything", requires: "felixFriendOn",
    help: "Everything learns from personal talk too, as Memory describes. Work only keeps personal talk out of his notes. Anything said when you might be in danger is never kept.",
    options: [{ value: "everything", label: "Everything" }, { value: "work", label: "Work only" }],
  },
  {
    key: "felixQuietOn", group: "friend", label: "Quiet hours", type: "boolean", default: true, requires: "felixFriendOn",
    help: "In these hours Felix doesn't bring personal things up on his own: no check-ins on the Felix card and no \"how did it go?\" when you say hi. He still answers when you talk to him. The same start and end hour means no quiet hours.",
  },
  {
    key: "felixQuietFrom", group: "friend", label: "Quiet from", type: "choice", default: 22, requires: "felixQuietOn",
    help: "When quiet hours start.",
    options: Array.from({ length: 24 }, (_, h) => ({ value: h, label: hourLabel(h) })),
  },
  {
    key: "felixQuietTo", group: "friend", label: "Quiet until", type: "choice", default: 7, requires: "felixQuietOn",
    help: "When quiet hours end.",
    options: Array.from({ length: 24 }, (_, h) => ({ value: h, label: hourLabel(h) })),
  },
  {
    key: "shiftOn", group: "shift", label: "Start my day", type: "boolean", default: true,
    help: "Shows Start my day in the home page's top bar. While your day runs, a clock shows how long since you started and how long is left, with Take a break and End my day.",
  },
  {
    key: "shiftHours", group: "shift", label: "Day length", type: "choice", default: 9, requires: "shiftOn",
    help: "How long your day is. When it's up, Felix suggests ending your day, for a better work-life balance.",
    options: [7, 7.5, 8, 8.5, 9, 9.5, 10].map((n) => ({ value: n, label: `${n} hours` })),
  },
  {
    key: "shiftBreakPauses", group: "shift", label: "Breaks pause the countdown", type: "boolean", default: false, requires: "shiftOn",
    help: "Off: your hours run from when you start, breaks included, as a 9-hour day usually includes the break. On: the countdown stops while you're on a break, so your day ends later by your breaks.",
  },
  {
    key: "shiftReminder", group: "shift", label: "Remind me when my day is up", type: "boolean", default: true, requires: "shiftOn",
    help: "When your hours are up, Felix shows a gentle note with End my day and \"not yet\", and sends a Mac notification, even with the window closed.",
  },
  {
    key: "shiftSnooze", group: "shift", label: "\"Not yet\" asks again after", type: "choice", default: 30, requires: "shiftReminder",
    help: "How long Felix waits to remind you again after you say not yet.",
    options: [15, 30, 60].map((n) => ({ value: n, label: n === 60 ? "1 hour" : `${n} minutes` })),
  },
  {
    key: "shiftSlack", group: "shift", label: "Post to Slack", type: "boolean", default: true, requires: "shiftOn",
    help: "Each step offers its message for #attendance-engineering-ph, posted as you after you say yes, and Start my day and End my day set you active or away. Until Slack is connected, Felix offers the message to copy instead.",
  },
  ...[
    ["shiftMorning", "Good morning", "Start my day, before noon"],
    ["shiftAfternoon", "Good afternoon", "Start my day, noon to 6 PM"],
    ["shiftEvening", "Good evening", "Start my day, after 6 PM"],
    ["shiftBreak", "Be right back!", "Take a break"],
    ["shiftBack", "I'm back!", "I'm back"],
    ["shiftBye", "Bye for now!", "End my day"],
  ].map(([key, text, label]) => ({
    key, group: "shift", label, type: "text", default: text, placeholder: text, max: 200, requires: "shiftOn",
    help: `The message ${label.replace(/,.*$/, "")} posts. Leave it empty for "${text}".`,
  })),
]);

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));

/**
 * Every setting at its default.
 * @returns {Record<string, boolean | string | number>}
 */
export function defaultSettings() {
  return Object.fromEntries(SETTINGS.map((s) => [s.key, s.default]));
}

/**
 * Whether a value is one the setting accepts.
 * @param {Setting} setting
 * @param {unknown} value
 * @returns {boolean}
 */
export function acceptsValue(setting, value) {
  if (setting.type === "boolean") return typeof value === "boolean";
  if (setting.type === "model") return typeof value === "string" && MODEL_ID.test(value);
  if (setting.type === "text") {
    return typeof value === "string" && value.length <= setting.max && (setting.lines ? MANY_LINES : ONE_LINE).test(value)
      && (!setting.pattern || setting.pattern.test(value));
  }
  return setting.options.some((o) => o.value === value);
}

/**
 * Whether a setting applies with the others as they are: its switch is on and the settings it depends on have
 * one of the values it needs.
 * @param {Setting} setting
 * @param {Record<string, unknown>} values
 * @param {Set<string>} [seen] Settings already checked on the way up.
 * @returns {boolean}
 */
export function applies(setting, values, seen = new Set()) {
  // A setting counts only when every setting above it does: Felix off turns off his voice's details too.
  if (seen.has(setting.key)) return true;
  seen.add(setting.key);
  const upOn = (key) => {
    const above = SETTINGS.find((x) => x.key === key);
    return !above || applies(above, values, seen);
  };
  if (setting.requires && (!values[setting.requires] || !upOn(setting.requires))) return false;
  return Object.entries(setting.only || {}).every(([key, allowed]) => allowed.includes(values[key]) && upOn(key));
}

/**
 * The change to save when a setting is set: the new value, plus the defaults of the settings it resets.
 * @param {string} key
 * @param {unknown} value
 * @returns {Record<string, unknown>}
 */
export function changeFor(key, value) {
  const resets = BY_KEY.get(key)?.resets || [];
  return { ...Object.fromEntries(resets.map((k) => [k, BY_KEY.get(k).default])), [key]: value };
}

/**
 * Settings read from disk, with anything unknown dropped and anything invalid back at its default.
 * @param {unknown} saved
 * @returns {Record<string, boolean | string | number>}
 */
export function cleanSettings(saved) {
  const out = defaultSettings();
  if (!saved || typeof saved !== "object") return out;
  for (const s of SETTINGS) if (acceptsValue(s, saved[s.key])) out[s.key] = saved[s.key];
  return out;
}

/**
 * What is wrong with a change, in plain words.
 * @param {unknown} patch Setting keys and their new values.
 * @returns {string[]} Empty when every key is known and every value accepted.
 */
export function patchProblems(patch) {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return ["Send the settings to change as an object."];
  return Object.entries(patch).flatMap(([key, value]) => {
    const s = BY_KEY.get(key);
    if (!s) return [`There is no setting called "${key}".`];
    return acceptsValue(s, value) ? [] : [`${s.label} can't be ${JSON.stringify(value)}.`];
  });
}

/**
 * A text setting's grey hint, with each `{key}` filled in from the other settings: "Hey {felixName}" is "Hey Felix".
 * @param {Setting} setting
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export const placeholderFor = (setting, values) => String(setting.placeholder || "").replace(/\{(\w+)\}/g, (_, k) => String(values[k] ?? ""));

/**
 * The phrase that starts a question to Felix: the one set in Settings, or "Hey" and his name.
 * @param {Record<string, unknown>} values
 * @returns {string}
 */
export const wakePhrase = (values) => String(values.felixWake || "").trim() || `Hey ${values.felixName || "Felix"}`;

/**
 * The settings in a group, each sub-heading's together in the section's own order (PART_ORDER).
 * @param {string} group
 * @returns {Setting[]}
 */
export function settingsIn(group) {
  const order = PART_ORDER[group];
  const list = SETTINGS.filter((s) => s.group === group);
  if (!order) return list;
  // Each sub-heading's settings together, in the section's own order; within one, as listed.
  const rank = (s) => Math.max(0, order.indexOf(s.part || ""));
  return list.map((s, i) => ({ s, i })).sort((a, b) => rank(a.s) - rank(b.s) || a.i - b.i).map((e) => e.s);
}
