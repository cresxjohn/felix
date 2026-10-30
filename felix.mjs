/**
 * Felix, your buddy in the bottom bar. A question goes to a local command when one matches, answered on this
 * Mac with no AI. Otherwise Felix reads the sources it needs and asks its AI, an agent working in Felix's own
 * workbench: it can read anything, build and change anything in the workbench, and remembers what lasts. Every
 * change outside the workbench waits for your yes on a card, and Felix checks every fact in the answer before
 * showing it.
 */
import { randomUUID } from "node:crypto";
import { matchCommand } from "./felix-commands.mjs";
import { ANSWERS, createSay, listText, plural } from "./felix-answers.mjs";
import { createChecker, createSentenceGate } from "./felix-verify.mjs";
import { createConversation } from "./felix-conversation.mjs";
import { timeText } from "./felix-facts.mjs";
import { MEMORY_RULES } from "./felix-memory.mjs";
import { createLearner } from "./felix-notes.mjs";
import { CRISIS_TEXT, friendLine, friendModel, inQuietHours, isCrisis, isPersonal } from "./felix-friend.mjs";
import { COMMAND_PHRASES } from "./felix-phrases.mjs";
import { parseWatch, watcherText } from "./felix-watch.mjs";
import { createEchoFilter, retryTalk, styleLine, toneProblems, withoutEcho, withoutRetryTalk } from "./felix-tone.mjs";
import { wakePhrase } from "./public/settings-schema.mjs";

const CONFIRM_MS = 2 * 60_000;
const PR_REFS = /\b(fm|bm) ?#? ?(\d{1,6})\b/gi;
const PR_READS_MAX = 2;
const BROAD = ["oncall", "prs", "releases", "usage"];
// A question that names no source reads the main ones only when it sounds like it's about work: "how's it going",
// "anything I should know". Small talk and general questions ("tell me a joke", "what's 15% of 80") read nothing,
// which makes them much faster.
const WORK_HINT = /\b(how'?s (it|everything|things|work|today) (going|looking)|how'?s it look(ing)?|how are things|what'?s (up|new|happening|going on|going down|broken|urgent)|anything (new|urgent|important|broken|on fire|i should|to worry|going on)|should i (know|worry|look|do|work)|need(s)? (my )?attention|status|update me|what did i miss|worry|blocking|blocked|on fire|today'?s|this morning|this afternoon|work)\b/i;
const REFERS_BACK = /\b(it|its|that|this one|that one|they|them|those|these|he|she|the same)\b/i;
// How a follow-up that names nothing starts: "and tomorrow?", "what about bm?".
const GOES_ON = /^(and|what about|how about|also|or|then|but|same for|ok(ay)?,? and)\b/i;
const SOURCE_NAMES = { oncall: "Datadog", prs: "GitHub", releases: "releases", usage: "AI usage", music: "Spotify", calendar: "Google Calendar",
  jira: "Jira", ooo: "Team out of office", tasks: "Tasks" };
// "Brief me" and "Wrap up my day" read everything connected, and say what isn't.
const BRIEF = /brief|my day|catch me up|wrap up|rundown/i;
const BRIEF_SOURCES = ["oncall", "prs", "releases", "calendar", "jira", "ooo", "tasks"];
const DEEP = /summar|brief|wrap up|catch me up|overview|explain|digest|walk me through|expound|elaborate|in detail|deep dive|\bwhy\b|how come|should i\b|advice|advise|recommend|compare|prioriti[sz]e|analy[sz]|what do you think/i;
const PR_CONTENT = /\b(about|changes?|changed|diff|code|does)\b/i;
const BUILDS = /\b(build|create|add|implement|improve|refactor|redesign|rename|remove|fix|change|update|make (it|a|an|the|felix|me))\b/i;
const MEMORY_WORDS = /\b(remember|forget|memory|memorize)\b/i;
const CURSOR_CLAUDE = { haiku: "claude-haiku-5-5-low", sonnet: "claude-sonnet-5-5-medium", opus: "claude-opus-5-5-medium" };

/**
 * The models Felix picks on Auto, for each AI tool and kind of question. Quick questions want a good answer
 * fast: Sonnet in its warm Claude session, or Composer 2.5 Fast on Cursor, whose own usage pool leaves Cursor's
 * named-model share for reviews. Deep ones (summaries, explanations, advice) want the best answer: Opus.
 */
export const PICKS = Object.freeze({
  claude: Object.freeze({ quick: "sonnet", deep: "opus" }),
  cursor: Object.freeze({ quick: "composer-2.5-fast", deep: CURSOR_CLAUDE.opus }),
});

/**
 * @typedef {"quick" | "deep"} Depth
 * @typedef {{ tool: "claude" | "cursor", model: string }} Pick
 */

/**
 * How much thought a question needs: deep for summaries, explanations, advice, what a PR changes, and building
 * or changing things; quick for the rest, which are lookups.
 * @param {string} text
 * @param {{ prs: unknown[] }} route
 * @returns {Depth}
 */
export const depthOf = (text, route) => (DEEP.test(text) || BUILDS.test(text) || (route.prs.length > 0 && PR_CONTENT.test(text)) ? "deep" : "quick");

/**
 * The AI tool and model a question goes to. On Auto, Claude while its plan has room and Cursor once a limit is
 * used up. A tool picked in Settings is kept. Either way, the model is the one picked in Settings, or on Auto,
 * Felix's pick for the question's depth; near Claude's limit (`lean`), lighter Claude models, to leave room for reviews.
 * @param {Record<string, unknown>} prefs
 * @param {Depth} depth
 * @param {boolean} pastLimit Whether Claude's plan is used up.
 * @param {boolean} [lean] Whether Claude's usage is past the "lean on lighter models" share in Settings.
 * @returns {Pick}
 */
export function pickModel(prefs, depth, pastLimit, lean = false) {
  const auto = prefs.felixTool === "auto";
  const tool = prefs.felixTool === "cursor" || (auto && pastLimit) ? "cursor" : "claude";
  const picks = lean && tool === "claude" ? LEAN : PICKS[tool];
  return { tool, model: auto || prefs.felixModel === "auto" ? picks[depth] : String(prefs.felixModel) };
}

/**
 * How much of Claude's plan is used: the highest share of any of its limits on the AI usage card, or null.
 * @param {Fact | null | undefined} usage
 * @returns {number | null}
 */
export function claudeShare(usage) {
  const claude = usage?.record?.tools?.find((t) => t.tool === "Claude");
  const shares = (claude?.limits || []).map((l) => Number(l.percentUsed)).filter(Number.isFinite);
  return shares.length ? Math.max(...shares) : null;
}

/**
 * The Cursor model that stands in when Claude refuses a question on its limit: the same Claude model on Cursor,
 * or Felix's Cursor pick for the question.
 * @param {string} model
 * @param {Depth} depth
 * @returns {string}
 */
export const onCursor = (model, depth) => CURSOR_CLAUDE[model] || PICKS.cursor[depth];

/**
 * A model's id, standing in for its name.
 * @param {"claude" | "cursor"} tool
 * @param {string} model
 * @returns {string}
 */
const modelId = (tool, model) => (tool === "cursor" ? `${model} (Cursor)` : model);

/**
 * Whether the AI usage card shows one of Claude's limits used up.
 * @param {Fact | null | undefined} usage
 * @returns {boolean}
 */
export function claudeUsedUp(usage) {
  const claude = usage?.record?.tools?.find((t) => t.tool === "Claude");
  return Boolean(claude?.limits?.some((l) => Number(l.percentUsed) >= 100));
}

/**
 * Who answered, as the chat shows it under a reply: the model's name, or "On this Mac" for a local command.
 * @param {string} how A local command's intent, or the model that answered.
 * @param {"claude" | "cursor" | undefined} tool The AI tool that answered; none for a local command.
 * @param {(tool: "claude" | "cursor", model: string) => string} [nameOf]
 * @returns {string}
 */
export const answeredBy = (how, tool, nameOf = modelId) => (tool ? nameOf(tool, how) : "On this Mac");
const ROUTES = [
  { re: /on.?call|shift|incident|\bic\b|datadog|takes? over|pager/i, source: "oncall" },
  { re: /\bprs?\b|pull request|review|merge|checks?\b|conflict|\bci\b|failing|approv|draft/i, source: "prs" },
  { re: /release|deploy|\bprod\b|production|staging|ship/i, source: "releases" },
  { re: /usage|limit|credits|tokens|\bplan\b|claude|cursor/i, source: "usage" },
  { re: /music|song|playing|spotify|track|artist|album/i, source: "music" },
  { re: /calendar|meeting|standup|\bevents?\b|\bfree\b|\bbusy\b|invite|schedule|agenda|1:1|one on one/i, source: "calendar" },
  { re: /jira|ticket|sprint|\bepic\b|story points|on my plate|\b[a-z]{2,10}-\d{1,6}\b/i, source: "jira" },
  { re: /out of (the )?office|who'?s out|\bout (today|tomorrow|this week|next week)|on leave|\bleave\b|vacation|\bpto\b|holiday|day off|\bsick\b/i, source: "ooo" },
  { re: /\btasks?\b|to-?dos?|due today|my list/i, source: "tasks" },
];
const NOT_YET = [
  { re: /slack|\bdms?\b|message|channel|mention|thread/i, name: "Slack" },
  // Your journal stays private: Felix can add a line to it when you ask, but his AI never reads it.
  { re: /journal/i, name: "your journal" },
];
const OFF_RECORD = /^off the record[,:.!—–-]*\s+(.+)$/is;
/** The cheap model each AI tool learns from a conversation with: one small step, after it ends. */
export const CHEAP = Object.freeze({ claude: "haiku", cursor: "composer-2.5-fast" });
/** The models Felix leans on near Claude's limit, to leave room for reviews: lighter than the usual picks. */
export const LEAN = Object.freeze({ quick: "haiku", deep: "sonnet" });
// Asking Felix to look something up on the web: the only time his AI may search or read it.
const WEB = /\b(search (the )?web|on the web|online|look (it |this |that )?up|google (it|that|for)|what'?s the (latest )?news|latest news|news (on|about))\b/i;
// The AI's way of saying a message was just another way of saying one of Felix's local commands.
const RUN = /^\s*RUN:\s*(.+?)\s*$/i;
// PRs in any case ("fm#1", "BM 7"); Jira keys only in capitals, so "covid-19" isn't one.
const REF = /\b(?:[fF][mM]|[bB][mM]) ?#? ?\d{1,6}\b|\b[A-Z]{2,10}-\d{1,6}\b/g;
const ORDINAL = /\b(?:the )?(first|second|third|fourth|fifth|last|1st|2nd|3rd|4th|5th) (?:one|pr|pull request|ticket)\b/i;
const ORDINAL_AT = { first: 0, "1st": 0, second: 1, "2nd": 1, third: 2, "3rd": 2, fourth: 3, "4th": 3, fifth: 4, "5th": 4, last: -1 };
const POINTER = /^(merge|review|fix|summari[sz]e|open|show me|watch) (it|that( one)?|this( one)?)$/i;
const SEEN_KEEP = 30;
/** How a setting is named when Felix says what he undid. */
const SETTING_WORDS = { autoRefresh: "auto refresh", fitToScreen: "fit to screen", mode: "the mode", felixMemoryLearn: "learning" };
/** Where a local command's data came from, so a follow-up like "and tomorrow?" can read it again. */
const ROUTE_OF = { "oncall.": ["oncall"], "prs.": ["prs"], "calendar.": ["calendar"], "jira.": ["jira"], "ooo.": ["ooo"], "tasks.": ["tasks"], usage: ["usage"], "music.now": ["music"] };
/** The models personal talk goes to on Auto: warmer and more careful than the quick picks. */
export const FRIEND_PICKS = Object.freeze({ claude: "sonnet", cursor: "claude-sonnet-5-5-medium" });
/** Where personal talk reads from: nowhere, so no work data comes into it. */
const NO_ROUTE = Object.freeze({ sources: [], prs: [], notYet: [], followsOn: false });
const CANT_CONFIRM = [
  "Hmm, I couldn't double-check that against what I just read, so I'd rather not guess. Mind asking it another way?",
  "I want to be sure before I tell you, and I couldn't match that to what I just checked. Try asking it a bit differently?",
  "I'm not confident about that one, and I don't want to give you something wrong. Could you ask it another way?",
];

/** How Felix talks and the rules it answers by. */
export const SYSTEM_PROMPT = [
  "You're Felix, a friendly buddy who helps a software engineer (a tech lead) get through the workday. You live on their Mac, in an app also called Felix, and you talk like an easygoing teammate who has their back.",
  "",
  "How you talk:",
  "- Like a person talks: short sentences, everyday words, contractions (\"you're\", \"it's\"). \"Yep\", \"Heads up\", \"Nice\", \"No worries\" are all fine.",
  "- The answer first, then the one thing that helps next, like what to look at or what's coming up. \"Sonito's on until 10 PM tonight\", not \"Based on the current schedule, the responder is...\".",
  "- Each message has a \"(Style for this reply ...)\" line: your name, their name, the tone, how long and how much humor. Follow it quietly; never repeat it or mention it.",
  "- Mix up how you start; don't open every reply the same way, and don't greet them the same way twice.",
  "- Read the room: upbeat when they share good news, gentle and calm when they sound stressed, brief when they're busy or terse, a little humor only when it fits. Bad news gets kindness, not alarm.",
  "- Never sound like a report. Don't say \"based on the data\", \"according to the information provided\", \"the JSON\" or \"I don't have access\". Say what you checked instead: \"GitHub shows...\", \"Datadog has...\", \"I checked your PRs and...\".",
  "- No robot filler: no \"Certainly!\", \"Great question!\", \"As an AI\", \"I hope this helps\" or \"Let me know if you need anything else\", and don't repeat the question back.",
  "- Your replies may be read aloud, so write for the ear: plain text only, no markdown, lists, headings, links or emoji, and never read out a list as \"one, two, three\".",
  "- Say times and dates the way people do (\"10 PM\", \"tomorrow morning\", \"in 4 days\"), never \"22:00\" or \"2026-10-29\". Shorten a long PR title to a few words.",
  "- Still facts only: a friendly tone never bends the truth.",
  "",
  "The tone to aim for (the names and numbers in these are made up; never use them):",
  "- Q: is there a PR that needs my attention? A: Yep, just one: fm#4521 from anna is waiting on your review. Checks are green, so it's ready whenever you are.",
  "- Q: am I on call this week? A: Not this week! Your next shift starts Mon, Nov 9 at 8 AM, in 11 days.",
  "- Q: how's my claude usage? A: You've used 42% of the 5-hour limit, and it resets today at 10 PM, so you've got room.",
  "- Q: anything failing? A: Heads up, fm#880 is failing lint. Everything else of yours looks good.",
  "- Q: merge my PR (they have two open) A: Which one, fm#880 or bm#312?",
  "",
  "Facts (a hard rule):",
  "- Every fact about their work (on-call, PRs, releases, AI usage, music) must come from the data in their latest message, or from what your tools read just now. Trust those over anything said earlier.",
  "- If neither answers the question, look it up with your tools, or say so honestly and kindly. Never guess or fill gaps from general knowledge.",
  "- A source with an \"error\" couldn't be read; say you couldn't reach it. Things listed as not connected yet: say you can't see them yet.",
  "- A source with \"asOf\" was read a while ago; say so once, like \"as of 10 minutes ago\".",
  "- Use names, numbers, PR numbers (like fm#123) and times exactly as the data writes them, including its ready-made phrases like \"today at 10 PM\" or \"in 4 days\". Don't work out new dates, times, durations, sums or counts in what you say; to look something up, do work out the days you need (\"next week\" from today's date).",
  "- When unsure, ask. If a question could mean two things (which PR? today or tomorrow?), ask a short question back instead of picking one.",
  "",
  "What you can do (you're an agent, like a coding assistant in their editor; anything is possible):",
  "- You're working in your workbench: your own copy of the Felix app, the folder you're in. Read, edit and run anything in it freely; nothing real changes there.",
  "- To build or change anything in Felix (a widget, a page, a setting, how you work), do it in the workbench: follow README.md, docs/PLAN.md and the code around it, run ./prs test, then tell them in a sentence or two what you changed. They get an Apply button that copies it into their Felix. Never git commit or push in the workbench.",
  "- You can read anything else on this Mac, the web, and GitHub (gh is logged in as them). Just go ahead.",
  "- Anything that changes something outside the workbench (on GitHub: posting, commenting, approving, merging, closing, editing; files in other folders; installing; sending anything) needs their yes. Just run it: Felix shows them a card with the exact command and runs it only if they allow it. If they say no, say okay and don't try another way around it.",
  "- Never touch their logins, keys, tokens, secrets or the Keychain, even if asked.",
  "- Search or read the web only when they asked you to look something up; then name each source's site and when it's from (\"According to Reuters, today\"), keep it apart from their own work data, and if sources disagree or you find nothing solid, say so.",
  "",
  "Their services (your tools named calendar_events, calendar_rsvp, out_of_office, on_call, jira_search, slack_search, slack_post, tasks_list, tasks_add, tasks_update, tasks_delete, prs_open, ai_usage, and the personal_ and wais_ ones; and gh for anything else on GitHub):",
  "- The data in their message is only a start. When a question needs more (other days, other tickets, older messages, a person's PRs), look it up yourself with these before answering. Never say you only have what you were given, and never ask them to look it up.",
  "- To do something for them (answer an invite, post in Slack), use the matching tool: Felix shows them a card to allow it first. Say it's done only once the tool says so.",
  "- Their tasks are yours to manage fully: add, change anything (due day, time, name, notes, priority, repeat, project, labels, links), tick off, undo or delete, at once and without asking. Find a task's id with tasks_list first.",
  "- Their money in Wais (wais_spaces, wais_safe_to_spend, wais_tasks, wais_outlook) is read-only and private: use those tools only when they ask about their money, bills or budget, say the formatted figures, and never bring it into work answers, wrap-ups or briefings.",
  "- Their Personal cards (personal_lists, personal_list_add, personal_habits, personal_habit_check, personal_journal_add, personal_dates, personal_timeoff) are theirs to ask you about: use them only when they ask about their lists, habits, journal, important dates or time off, and act at once, without asking. Never bring personal things into work answers, wrap-ups or briefings. The journal is private: you can add a line when asked, and there's no way to read it.",
  "- Tell them what you found in plain words: no commands, JQL, tool names or raw data.",
  "- Write ticket and PR numbers the usual way (PMHUB-32975, fm#12293), never spelled out digit by digit: when you're read aloud, Felix's voice already says them one digit at a time.",
 
  "",
  "Your own tools and helpers (Felix shapes Felix):",
  "- When none of your tools can get what they asked for (and it's their data, not a coding job), don't guess and don't send them elsewhere: call tool_build with their question and what the tool must do, then reply with exactly: \"I'm sorry, I'm not able to do it right now, let me look into this.\" The tool is built, tested and saved in the background, and the answer reaches them on its own. The user gave you full say here: never ask before building or extending a tool.",
  "- To make one of your own tools do more, call tool_build with extend set to its name. Your tools are only ever added to or extended, never removed.",
  "- Tools you built show in your tool list, or, if built after this conversation began, through my_tools and tool_use.",
  "- When they throw several things at you, or something will take a while, hand it to a helper with delegate (one per task) and tell them you're on it; each helper gets back to them on its own. jobs_status says how they're going.",
  "",
  "Felix's own commands (each runs right on this Mac, with no AI):",
  `- If my message is only another way of saying one of these, reply with exactly \"RUN: <the command>\" and nothing else: ${COMMAND_PHRASES.join("; ")}.`,
  "",
  "Your own code (the workbench is a copy of it), so a change fits in:",
  "- Server: server.mjs (every route, listed at its top), settings.mjs, and one module per source: datadog.mjs (on-call), ai-usage.mjs, music.mjs (Spotify), jira.mjs, google.mjs with calendar.mjs and ooo.mjs, slack.mjs, tasks.mjs (node:sqlite), shift.mjs (the work day), connections.mjs, keychain.mjs (secrets).",
  "- You: felix.mjs (answers, routing, these rules), felix-commands.mjs and felix-answers.mjs (local commands, no AI), felix-facts.mjs and felix-verify.mjs (facts and the fact check), felix-tone.mjs, felix-brain.mjs and felix-cursor.mjs (your Claude and Cursor sessions), felix-agent.mjs, felix-gate.mjs and felix-workbench.mjs (this workbench, the gate, Apply), felix-guard.mjs (the restart check after Apply), felix-memory.mjs, felix-voice.mjs and felix-wake.mjs (hearing, speaking, the wake phrase).",
  "- Pages in public/: home.html (Home and its cards), index.html (Open PRs), settings.html, shell.js and shell.css (top and bottom bars), felix.js (the chat), felix-voice.js, cards.js, theme.css (colour tokens for light and dark, Work and Personal). public/settings-schema.mjs lists every setting; Settings draws itself from it.",
  "- Rules: plain-English JSDoc on every function and short comments that say why; no npm packages (the server has none; Node's own modules only); every behaviour gets a setting in settings-schema.mjs with a sensible default; tests in test/*.test.mjs with node:test for everything new, and ./prs test must pass with line coverage at or above 99%; UI uses theme.css tokens and works in light and dark; never colored left accent borders on cards or rows; simple, friendly words on screen; facts only, never made-up data.",
  "- Work step by step: read the code around a change first, make it, run ./prs test, fix what fails, and say what you changed and how the tests went. A big build can take many steps; keep going until it's done. You can't restart Felix or touch the real copy; Apply does that, after its own test run, and puts the change back if Felix doesn't come back healthy. In your sandbox the preview tests can't open a local port, so those few may fail there; say so plainly, and Felix runs the full tests outside the sandbox right after you finish.",
  "- For a quick question, answer from the data in their message; reach for your tools when it's not there, or when they ask you to do something.",
].join("\n");

/**
 * Felix's rules with what it remembers: the memory rules and the index of its memory, which go to the AI once,
 * when a session starts.
 * @param {string} memoryIndex
 * @returns {string}
 */
export const rulesWith = (memoryIndex) => [SYSTEM_PROMPT, MEMORY_RULES, memoryIndex ? `Your memory's index right now:\n${memoryIndex}` : "Your memory is empty so far."].join("\n\n");

/**
 * @typedef {import("./felix-facts.mjs").Fact} Fact
 * @typedef {import("./felix-gate.mjs").Card} Card
 * @typedef {{ onProgress: (step: string) => void, onText: (text: string | null) => void, onAsk?: (card: Card) => void, onModel?: (name: string) => void }} Streams
 *   `onText` gets each checked piece of an AI reply as it's written; null takes back what was shown, before a
 *   second try. `onAsk` gets each change the AI wants to make, for you to allow or not. `onModel` gets the name of
 *   the model working on it, as it starts and again if another takes over.
 * @typedef {Streams & { prefs: Record<string, unknown>, pick: Pick, depth: Depth, onTool: (use: import("./felix-brain.mjs").ToolUse) => void }} Think
 * @typedef {import("./felix-answers.mjs").Reply} Reply
 * @typedef {import("./felix-answers.mjs").Confirm} Confirm
 * @typedef {import("./felix-workbench.mjs").Change} Change
 * @typedef {{ id: string, text: string, chips: Array<{ label: string, link: string | null }>, how: string, by: string, navigate?: string,
 *   settings?: Record<string, unknown>, music?: string, confirm?: { id: string, label: string }, changes?: Change[],
 *   tests?: { ok: boolean, tail: string }, restarting?: boolean }} Answer `tests` is how Felix's tests went in the workbench
 *   after a change there; `restarting` says Felix is restarting, so the page reloads.
 * @typedef {{ sync: () => Promise<boolean>, changes: () => Promise<Change[]>, test?: () => Promise<{ ok: boolean, tail: string }> }} Workbench
 *   `test` runs Felix's tests in the workbench.
 * @typedef {{ around: (question: string) => Promise<string>, snapshot: () => Promise<Map<string, number>>,
 *   changedSince: (before: Map<string, number>) => Promise<string[]> }} Memory
 * @typedef {{ begin: (sink: import("./felix-gate.mjs").Sink) => () => void }} Gate
 */

/**
 * The sources a question needs, and the things it asks about that Felix can't see yet. One that names nothing
 * reads the main sources only when it sounds like it's about work, like "how's it going"; small talk, general
 * questions, and asking Felix to build, change, remember or forget something read nothing. One that
 * names no PR and names nothing or points back, like "and who approved it?", follows on from the one before.
 * @param {string} text
 * @returns {import("./felix-conversation.mjs").Route}
 */
export function routeQuestion(text) {
  const prs = [...text.matchAll(PR_REFS)].slice(0, PR_READS_MAX).map((m) => ({ repo: m[1].toLowerCase(), number: Number(m[2]) }));
  const sources = ROUTES.filter((r) => r.re.test(text)).map((r) => r.source);
  const notYet = NOT_YET.filter((n) => n.re.test(text)).map((n) => n.name);
  const named = sources.length > 0 || prs.length > 0 || notYet.length > 0;
  const unnamed = !named && !BUILDS.test(text) && !MEMORY_WORDS.test(text);
  const broad = unnamed && WORK_HINT.test(text);
  const followsOn = !prs.length && (broad || REFERS_BACK.test(text) || (unnamed && GOES_ON.test(text.trim())));
  if (BRIEF.test(text)) return { sources: [...new Set([...sources, ...BRIEF_SOURCES])], prs, notYet: [...new Set([...notYet, "Slack"])], followsOn: false };
  return { sources: broad ? [...new Set([...sources, ...BROAD])] : sources, prs, notYet, followsOn };
}

/**
 * The data a question was answered from, as Claude sees it: each source's record, or why it couldn't be read.
 * @param {Fact[]} facts
 * @returns {Record<string, object>}
 */
export function dataFor(facts) {
  return Object.fromEntries(facts.map((f) => [
    f.name === "pr" ? `pr ${f.record?.ref || f.link || ""}`.trim() : f.name,
    f.error ? { source: f.source, error: f.error } : { source: f.source, ...(f.asOf ? { asOf: f.asOf } : {}), ...f.record },
  ]));
}

/**
 * The chips under an answer: each source and when it was read, linking to where it came from. Old data says how
 * old it is instead: "GitHub · as of 10 minutes ago".
 * @param {Fact[]} facts
 * @param {string} [timeZone]
 * @returns {Array<{ label: string, link: string | null }>}
 */
export function chipsFor(facts, timeZone) {
  const seen = new Map();
  for (const f of facts) {
    const label = `${f.source} · ${f.error ? "couldn't read" : f.asOf ? `as of ${f.asOf}` : timeText(f.fetchedAt, timeZone)}`;
    if (!seen.has(label)) seen.set(label, { label, link: f.link });
  }
  return [...seen.values()];
}

/**
 * What a local answer adds when some of its data is old: "That's as of 10 minutes ago." It names the source when
 * the answer read more than one. Nothing when the data is fresh, or the answer already says it.
 * @param {string} text
 * @param {Fact[]} facts
 * @returns {string}
 */
export function oldDataNote(text, facts) {
  const old = facts.filter((f) => f.asOf && !f.error);
  if (!old.length || /\bas of\b/i.test(text)) return "";
  const [first] = old;
  return facts.length > 1 ? ` ${first.source}'s info is as of ${first.asOf}.` : ` That's as of ${first.asOf}.`;
}

/**
 * Creates Felix.
 * @param {object} deps
 * @param {{ read: (name: string, arg?: object) => Promise<Fact> }} deps.facts
 * @param {{ ask: Function, askCursor: Function, warm: (model: string) => void, warmCursor?: () => void, pastLimit?: () => boolean }} deps.brain
 * @param {{ get: () => Promise<Record<string, unknown>> }} deps.settings
 * @param {{ merge: (url: string) => Promise<object>, review: (url: string, tool: string) => string,
 *   undoApply?: () => Promise<{ ok: boolean, text: string }>, lastApply?: () => Promise<import("./felix-guard.mjs").ApplyStatus | null>,
 *   rsvp?: (id: string, response: string, note: string) => Promise<unknown>, fix?: (url: string, tool: string) => Promise<string> }} deps.actions
 * @param {(entry: object) => void} [deps.log]
 * @param {() => number} [deps.now]
 * @param {() => number} [deps.random]
 * @param {string} [deps.timeZone]
 * @param {(tool: "claude" | "cursor", model: string) => string} [deps.modelName] A model's name for the chat.
 * @param {Gate} [deps.gate] Shows the AI's changes as cards while it answers.
 * @param {Workbench} [deps.workbench] Felix's own copy of the app, where its AI works.
 * @param {Memory} [deps.memory]
 * @param {import("./felix-notes.mjs").Notes} [deps.notes] What Felix has learned from you, which he learns after each conversation.
 * @param {typeof setTimeout} [deps.setTimer] The timer the quiet spell after a conversation is timed with (tests pass their own).
 * @param {typeof clearTimeout} [deps.clearTimer]
 * @param {ReturnType<typeof import("./felix-phrases.mjs").createPhrases>} [deps.phrases] Your own ways of saying Felix's commands.
 * @param {ReturnType<typeof import("./felix-watch.mjs").createWatchers>} [deps.watchers] What Felix watches PRs for.
 * @param {{ save: (entry: object) => Promise<void> }} [deps.evals] Felix's test set, which "that's wrong" adds to.
 * @param {Awaited<ReturnType<typeof import("./tasks.mjs").createTasks>>} [deps.tasks] Your tasks, for "add a task", "what's due" and "mark it done".
 * @param {ReturnType<typeof import("./felix-personal.mjs").createPersonalFelix>} [deps.personal] Your Personal cards, for "add eggs to
 *   groceries", "I drank water" and the like. Asked only when you ask; never read into work answers or briefings.
 * @param {{ call: (tool: string, args?: object) => Promise<any> }} [deps.wais] Wais, for "how much can I spend" and
 *   "what bills are due". Read-only, and only when you ask.
 */
export function createFelix({ facts, brain, settings, actions, log = () => {}, now = Date.now, random = Math.random, timeZone, modelName = modelId,
  gate, workbench, memory, notes, setTimer, clearTimer, tasks, phrases, watchers, evals, personal, wais }) {
  const say = createSay(random);
  const conversation = createConversation({ now });
  const learner = notes ? createLearner({
    notes,
    now,
    log,
    setTimer,
    clearTimer,
    learning: async () => {
      const prefs = await settings.get();
      return prefs.felixOn !== false && prefs.felixMemoryLearn !== false;
    },
    idleMs: async () => Number((await settings.get()).felixMemoryAfter || 10) * 60_000,
    extract: async (prompt) => {
      const prefs = await settings.get();
      const { tool } = pickModel(prefs, "quick", Boolean(brain.pastLimit?.()));
      const answer = await brain.once(prompt, { tool, model: CHEAP[tool] });
      if (answer.error) throw new Error(answer.error);
      return answer.text;
    },
  }) : null;
  /** @type {Map<string, Confirm & { expires: number }>} */
  const pending = new Map();
  /** @type {Fact[]} */
  let lastFacts = [];
  /** @type {"work" | "personal" | "crisis"} What kind of talk the last AI answer was. */
  let lastKind = "work";
  /** Whether the last question leaned on lighter models, so warming up starts those. */
  let lastLean = false;
  /** @type {object} The data the last answer was made from, for "that's wrong". */
  let lastData = {};
  /** @type {Map<string, { at: string, question: string, answer: string, how: string, by: string, data: object }>} Recent answers, by id. */
  const seen = new Map();
  /** @type {Array<{ label: string, settings?: Record<string, unknown>, task?: { remove?: string, reopen?: string, removeNext?: string | null }, final?: boolean }>} */
  const undos = [];

  /**
   * Turns a reply into what the page shows, and remembers its sources for "where did you get that".
   * @param {Reply} reply
   * @param {string} how A local command's intent, or the model that answered.
   * @param {"claude" | "cursor"} [tool] The AI tool that answered; none for a local command.
   * @returns {Answer}
   */
  function finish(reply, how, tool) {
    const used = reply.facts || [];
    if (how !== "sources") lastFacts = used;
    const remembered = reply.remembered?.length ? [{ label: `Memory updated · ${reply.remembered.join(", ")}`, link: null }] : [];
    const text = tool ? reply.text : `${reply.text}${oldDataNote(reply.text, used)}`;
    /** @type {Answer} */
    // A place outside Felix comes with a chip to open it, for when the page can't open it on its own (a spoken
    // command on the iPad has no tap to open a new window with).
    const outside = reply.link ? [{ label: `Open ${reply.link.name}`, link: reply.link.url }] : [];
    const out = { id: randomUUID(), text, chips: [...outside, ...chipsFor(used, timeZone), ...remembered], how, by: answeredBy(how, tool, modelName) };
    for (const key of ["navigate", "settings", "music", "tests", "restarting", "tasks", "personal"]) if (reply[key] !== undefined) out[key] = reply[key];
    if (reply.link) out.link = reply.link.url;
    if (reply.changes?.length) out.changes = reply.changes;
    if (reply.confirm) {
      const id = randomUUID();
      pending.set(id, { ...reply.confirm, id, expires: now() + CONFIRM_MS });
      out.confirm = { id, label: reply.confirm.label };
    }
    return out;
  }

  /**
   * Asks the picked model: Claude in its warm session, or a Cursor model. When Claude refuses on its limit, the
   * same Claude model on Cursor answers instead, always on Auto and when the backup setting allows it otherwise.
   * @param {string} turn
   * @param {Think} ctx
   * @param {ReturnType<typeof createSentenceGate>} sentences Takes the reply's text as it's written.
   * @param {string} [before] The turn this one follows, which Cursor may not have seen.
   * @returns {Promise<{ text: string, error: string | null, how: string, tool: "claude" | "cursor" }>}
   */
  async function think(turn, ctx, sentences, before = "") {
    const { pick, prefs, onTool } = ctx;
    // Some models read the style line back on a fresh session; it's dropped from what's shown and from the reply.
    const asked = async (ask) => {
      const echo = createEchoFilter(sentences.add);
      const answer = await ask(echo.add);
      echo.end();
      return { ...answer, text: withoutEcho(answer.text) };
    };
    const viaCursor = async (m) => {
      ctx.onModel?.(modelName("cursor", m));
      return { ...(await asked((onDelta) => brain.askCursor(turn, m, { onDelta, onTool, before }))), how: m, tool: "cursor" };
    };
    if (pick.tool === "cursor") {
      if (prefs.felixTool === "auto") ctx.onProgress(`Claude's plan is used up, so ${modelName("cursor", pick.model)} is answering`);
      return viaCursor(pick.model);
    }
    ctx.onModel?.(modelName("claude", pick.model));
    const answer = await asked((onDelta) => brain.ask(pick.model, turn, { onDelta, onTool }));
    if (!answer.limit) return { ...answer, how: pick.model, tool: "claude" };
    if (prefs.felixTool !== "auto" && !prefs.felixCursorFallback) {
      return { text: "", error: "Your Claude usage limit is reached, and Cursor as a backup is off in Settings.", how: pick.model, tool: "claude" };
    }
    sentences.reset();
    ctx.onProgress("Claude's out of usage, asking Cursor");
    return viaCursor(onCursor(pick.model, ctx.depth));
  }

  /**
   * The facts the AI needs for a question, read together, with whether Claude's plan is used up when that
   * matters (on Auto).
   * @param {ReturnType<typeof routeQuestion>} route
   * @param {Record<string, unknown>} prefs
   * @returns {Promise<{ read: Fact[], pastLimit: boolean, lean: boolean }>}
   */
  async function readFor(route, prefs) {
    const auto = prefs.felixTool === "auto";
    // Claude's usage matters on Auto (to switch to Cursor) and for leaning on lighter models near the limit.
    const leanAt = Number(prefs.felixLeanAt || 0);
    const [read, usage] = await Promise.all([
      Promise.all([...route.sources.map((s) => facts.read(s)), ...route.prs.map((p) => facts.read("pr", p))]),
      auto || (leanAt && prefs.felixTool !== "cursor") ? facts.read("usage") : null,
    ]);
    const share = claudeShare(usage);
    return { read, pastLimit: auto && (Boolean(brain.pastLimit?.()) || claudeUsedUp(usage)), lean: Boolean(leanAt) && share !== null && share >= leanAt };
  }

  /**
   * Answers with the AI, from fresh data, and checks the answer.
   * @param {string} text
   * @param {Streams} streams
   * @returns {Promise<Answer>}
   */
  /**
   * Gets ready for the AI: the facts it needs, what memory has on the question, a snapshot of memory to see what
   * the AI saves, and the workbench caught up with Felix.
   * @param {string} text
   * @param {ReturnType<typeof routeQuestion>} route
   * @param {Record<string, unknown>} prefs
   * @param {"work" | "personal"} [scope] Which notes come along: personal talk brings only personal ones.
   * @returns {Promise<{ read: Fact[], pastLimit: boolean, lean: boolean, recalled: string, before?: Map<string, number> }>}
   */
  async function prepare(text, route, prefs, scope = "work") {
    const [facts, recalled, before] = await Promise.all([
      readFor(route, prefs),
      Promise.all([memory ? memory.around(text).catch(() => "") : "", notes ? notes.recall(text, scope).catch(() => "") : ""]).then((parts) => parts.filter(Boolean).join("\n\n")),
      memory?.snapshot().catch(() => undefined),
      workbench?.sync().catch(() => false),
    ]);
    return { ...facts, recalled, before };
  }

  /**
   * What the AI changed while answering: files in the workbench, and cards in memory. When the workbench changed,
   * Felix runs the tests there himself, so you know before Apply whether it's ready.
   * @param {Map<string, number> | undefined} before
   * @param {(step: string) => void} onProgress
   * @returns {Promise<{ changes: Change[], remembered: string[], tests?: { ok: boolean, tail: string } }>}
   */
  async function afterWork(before, onProgress) {
    const [changes, remembered] = await Promise.all([
      workbench ? workbench.changes().catch(() => []) : [],
      memory && before ? memory.changedSince(before).catch(() => []) : [],
    ]);
    if (!changes.length || !workbench?.test) return { changes, remembered };
    onProgress("Running the tests in my workbench");
    const tests = await workbench.test().catch((e) => ({ ok: false, tail: `The tests didn't run: ${e.message}` }));
    return { changes, remembered, tests };
  }

  /**
   * Answers with the AI, from fresh data, and checks the answer. The AI may use tools on the way: what they read
   * counts as data, and each change it wants waits for your yes on a card.
   * @param {string} text
   * @param {Record<string, unknown>} prefs Settings as they are now.
   * @param {Streams} streams
   * @returns {Promise<Answer>}
   */
  async function answerWithAi(text, prefs, { onProgress, onText, onAsk = () => {}, onModel }) {
    // Personal talk reads no work data and goes to a warmer model; crisis wording gets real help shown first.
    const crisis = isCrisis(text);
    const asked = routeQuestion(text);
    const personal = crisis || (prefs.felixFriendOn !== false && isPersonal(text, namesWork(text, asked)));
    lastKind = crisis ? "crisis" : personal ? "personal" : "work";
    if (crisis) onText(`${CRISIS_TEXT}\n\n`);
    const route = personal ? NO_ROUTE : conversation.routeFor(asked);
    const names = [...new Set([...route.sources.map((s) => SOURCE_NAMES[s]), ...(route.prs.length ? ["GitHub"] : [])])];
    onProgress(names.length ? `Checking ${listText(names)}` : "Getting ready");
    const { read, pastLimit, lean, recalled, before } = await prepare(text, route, prefs, personal ? "personal" : "work");
    const web = WEB.test(text);
    const at = now();
    const data = dataFor(read);
    const nowText = `${new Intl.DateTimeFormat("en-US", { weekday: "long", month: "short", day: "numeric", timeZone }).format(at)} at ${timeText(at, timeZone)}`;
    const style = styleLine(prefs);
    const friend = personal ? friendLine(prefs, { crisis }) : "";
    const turn = [
      `It's ${nowText}.`,
      style,
      conversation.recap(),
      recalled,
      friend || (read.length ? `Data read just now, as JSON:\n${JSON.stringify(data)}` : "No work data was read for this one; use your tools if you need some."),
      route.notYet.length ? `Not connected yet, so you can't see: ${listText(route.notYet)}.` : "",
      web ? "They asked you to look this up on the web: search it, and name each source's site and when it's from in your answer." : "",
      `My question: ${text}`,
    ].filter(Boolean).join("\n\n");
    onProgress("Looking into it");
    // The names in the style line (Felix's and yours) may be said, so the check knows them too.
    const check = createChecker([data, text, nowText, new Date(at).toISOString(), recalled, style, friend, crisis ? CRISIS_TEXT : ""], { timeZone });
    const depth = depthOf(text, route);
    const picked = pickModel(prefs, depth, pastLimit, lean);
    lastLean = lean;
    // Said only when leaning really changed the model: not for one you picked yourself, nor for personal talk.
    if (lean && !personal && picked.model !== pickModel(prefs, depth, pastLimit, false).model) onProgress("Claude's plan is getting full, so I'm using a lighter model");
    const pick = personal ? { tool: picked.tool, model: friendModel(prefs, picked.tool, FRIEND_PICKS) } : picked;
    const onTool = (use) => {
      if (use.step) onProgress(use.step);
      if (use.seen) check.learn(use.seen);
    };
    const end = gate?.begin({ onAsk, onStep: onProgress, web, allowAll: prefs.felixPermissions === "all" });
    const draft = await checkedDraft(turn, text, check, { prefs, pick, depth, onProgress, onText, onTool, onModel }).finally(() => end?.());
    const work = await afterWork(before, onProgress);
    lastData = crisis ? {} : data;
    const run = RUN.exec(draft.text || "");
    if (run && !personal) return ranFor(text, run[1].replace(/[.!"]+$/, "").replace(/^"/, ""), draft, prefs);
    if (draft.error || !draft.text) {
      log({ at: new Date(at).toISOString(), question: crisis ? "(kept private)" : text, how: draft.how, tool: draft.tool, depth, error: draft.error });
      // The crisis message stands on its own when the AI can't answer.
      if (crisis) return finish({ text: CRISIS_TEXT }, draft.how, draft.tool);
      return finish({ text: `Sorry, I couldn't get an answer just now. ${draft.error || "The AI didn't reply."}`, facts: read, ...work }, draft.how, draft.tool);
    }
    const tone = toneProblems(draft.text, { chatty: String(prefs.felixChatty), long: depth === "deep" });
    // What was said in a crisis isn't written to Felix's log.
    if (crisis) log({ at: new Date(at).toISOString(), question: "(kept private)", how: draft.how, tool: draft.tool, personal: true, ok: draft.ok });
    else log({ at: new Date(at).toISOString(), question: text, how: draft.how, tool: draft.tool, depth, personal, web, drafts: draft.drafts, ok: draft.ok, unmatched: draft.unmatched, tone, data });
    if (draft.ok) conversation.add(text, draft.text, personal ? null : route);
    const said = draft.ok ? draft.text : say("cant", CANT_CONFIRM);
    return finish({ text: `${crisis ? `${CRISIS_TEXT}\n\n` : ""}${said}${testsNote(work.tests)}`, facts: read, ...work }, draft.how, draft.tool);
  }

  /**
   * One draft from the AI, its sentences shown as they're written and pass the check.
   * @param {string} turn
   * @param {Think} ctx
   * @param {(text: string) => { ok: boolean, unmatched: string[] }} check
   * @param {string} [before]
   * @param {boolean} [retry] Whether this is the second try after the fact check caught the first.
   * @returns {Promise<{ text: string, error: string | null, how: string, shown: string }>}
   */
  async function streamedDraft(turn, ctx, check, before, retry = false) {
    // A second try that starts talking about the first (which you never saw) stops showing there; its reply is tidied.
    // A reply that's only "RUN: <command>" is Felix's to carry out, never shown.
    const sentences = createSentenceGate((piece) => !RUN.test(piece) && !(retry && retryTalk(piece)) && check(piece).ok, ctx.onText);
    const answer = await think(turn, ctx, sentences, before);
    return { ...answer, shown: sentences.shown() };
  }

  /**
   * Gets the AI's answer and checks it. One the check catches gets one more try, told what didn't match. The
   * sentences already shown passed the check, so they stay, and the second try carries on after them.
   * @param {string} turn
   * @param {string} question
   * @param {(text: string) => { ok: boolean, unmatched: string[] }} check
   * @param {Think} ctx
   * @returns {Promise<{ text: string, error: string | null, how: string, ok: boolean, unmatched: string[], drafts: string[] }>}
   */
  async function checkedDraft(turn, question, check, ctx) {
    const first = await streamedDraft(turn, ctx, check);
    if (first.error || !first.text) return { ...first, ok: false, unmatched: [], drafts: [] };
    if (RUN.test(first.text)) return { ...first, ok: true, unmatched: [], drafts: [first.text] };
    const firstCheck = check(first.text);
    if (firstCheck.ok) return { ...first, ...firstCheck, drafts: [first.text] };
    ctx.onProgress("Double-checking");
    const kept = first.shown;
    const second = await streamedDraft(retryTurn(question, first.text, firstCheck.unmatched, kept), ctx, check, turn, true);
    const tried = { ...first, ...firstCheck, drafts: [first.text] };
    const again = withoutRetryTalk(second.text);
    if (second.error || !again) return keptOr(tried, kept);
    const text = kept + again;
    return keptOr({ ...second, text, ...check(text), drafts: [first.text, second.text] }, kept);
  }

  /**
   * Answers a question or carries out a command.
   * @param {string} text
   * @param {Partial<Streams>} [options]
   * @returns {Promise<Answer>}
   */
  async function ask(text, { onProgress = () => {}, onText = () => {}, onAsk, onModel } = {}) {
    const typed = String(text || "").trim().slice(0, 4000);
    // "Off the record, ..." keeps just this one out of what Felix learns.
    const offOnce = OFF_RECORD.exec(typed);
    const plain = offOnce ? offOnce[1].trim() : typed;
    if (!plain) return finish({ text: "Ask me anything, like \"who's on call?\"" }, "empty");
    const prefs = await settings.get();
    const name = String(prefs.felixName || "Felix");
    // "Merge the first one" after a list of PRs means the first PR in it.
    const said = withReferences(plain, conversation.lastAnswer());
    // Your lists, items, habits and dates, so "add eggs to groceries" matches only when you have a Groceries list.
    const known = knownPersonal();
    let command = matchCommand(said, name, wakePhrase(prefs), known);
    const learned = !command && phrases ? await phrases.commandFor(said, name, wakePhrase(prefs)) : null;
    if (learned) command = matchCommand(learned, undefined, undefined, known);
    if (!command) {
      const before = personal?.version();
      const answer = await answerWithAi(said, prefs, { onProgress, onText, onAsk, onModel });
      // The AI changed a Personal card with its tools: the open cards load again.
      if (personal && personal.version() !== before) answer.personal = true;
      // Talk in a crisis is never kept, and personal talk only when Settings let Felix remember it.
      const keep = lastKind === "work" || (lastKind === "personal" && prefs.felixFriendRemember !== "work");
      if (!offOnce && keep) learner?.heard(said, answer.text);
      if (lastKind !== "crisis") remember(answer, said);
      return answer;
    }
    const answer = await runLocal(command, said, prefs, offOnce);
    remember(answer, said);
    return answer;
  }

  /**
   * Runs a local command and keeps what can be undone.
   * @param {{ intent: string, slots: Record<string, string | boolean> }} command
   * @param {string} said
   * @param {Record<string, unknown>} prefs
   * @param {unknown} [offOnce] Set when it was said off the record.
   * @returns {Promise<Answer>}
   */
  async function runLocal(command, said, prefs, offOnce) {
    const lastApply = async () => (actions.lastApply ? actions.lastApply() : null);
    const ctx = { read: facts.read, say, lastFacts: () => lastFacts, timeZone, lastApply, now, notes, learner, tasks, personal, wais, said, mode: prefs.mode,
      quiet: prefs.felixFriendOn === false || inQuietHours(prefs, now(), timeZone) };
    const slots = asWritten(command.slots, said);
    const reply = OWN[command.intent] ? await OWN[command.intent](slots, prefs) : await ANSWERS[command.intent](ctx, slots);
    keepUndo(command.intent, reply, prefs);
    lastData = reply.facts?.length ? dataFor(reply.facts) : {};
    const own = isPersonalIntent(command.intent);
    // A journal line stays out of the log; it's kept only in the journal.
    log({ at: new Date(now()).toISOString(), question: command.intent === "journal.add" ? "(a journal line, kept private)" : said, how: command.intent, text: reply.text });
    const sources = Object.entries(ROUTE_OF).find(([k]) => command.intent.startsWith(k))?.[1];
    conversation.add(said, reply.text, sources ? { sources, prs: [], notYet: [], followsOn: false } : null);
    // Personal commands aren't passed to Felix's learning, which asks an AI: your lists and journal stay here.
    if (!offOnce && !command.intent.startsWith("memory.") && !own) learner?.heard(said, reply.text);
    return finish(reply, command.intent);
  }

  /**
   * Carries out what the AI worked out a message meant: one of Felix's own commands, run here. The first time,
   * Felix offers to remember your words for it, so next time they run here with no AI.
   * @param {string} said
   * @param {string} meant The command, as the AI named it.
   * @param {{ how: string, tool: "claude" | "cursor" }} draft
   * @param {Record<string, unknown>} prefs
   * @returns {Promise<Answer>}
   */
  async function ranFor(said, meant, draft, prefs) {
    const known = COMMAND_PHRASES.find((c) => c.toLowerCase() === meant.toLowerCase());
    const command = known ? matchCommand(known) : null;
    if (!command) return finish({ text: "Sorry, I couldn't work out what you meant. Could you say it another way?" }, draft.how, draft.tool);
    log({ at: new Date(now()).toISOString(), question: said, how: draft.how, tool: draft.tool, ran: meant });
    const answer = await runLocal(command, said, prefs);
    if (answer.confirm || !phrases || prefs.felixLearnPhrases === false) return answer;
    const id = randomUUID();
    pending.set(id, { id, action: "learn-phrase", phrase: said, command: known, label: "Remember it", expires: now() + CONFIRM_MS });
    return { ...answer, text: `${answer.text} Want me to remember that "${said}" means "${known}"? Then it runs right here next time, with no AI.`, confirm: { id, label: "Remember it" } };
  }

  /**
   * Keeps an answer for a while, so "that's wrong" or a thumbs-down can save it to the test set.
   * @param {Answer} answer
   * @param {string} question
   */
  function remember(answer, question) {
    if (answer.how === "wrong" || answer.how === "undo") return;
    seen.set(answer.id, { at: new Date(now()).toISOString(), question, answer: answer.text, how: answer.how, by: answer.by, data: lastData });
    if (seen.size > SEEN_KEEP) seen.delete(seen.keys().next().value);
  }

  /**
   * Keeps how to undo what a local command just did here: a setting it changed, or a task it added or ticked off.
   * @param {string} intent
   * @param {Reply & { undo?: object }} reply
   * @param {Record<string, unknown>} prefs The settings before the change.
   */
  function keepUndo(intent, reply, prefs) {
    if (reply.undo) undos.push(reply.undo);
    else if (reply.settings && !intent.startsWith("undo")) {
      const keys = Object.keys(reply.settings);
      undos.push({ label: `changing ${keys.map((k) => SETTING_WORDS[k] || k).join(" and ")}`, settings: Object.fromEntries(keys.map((k) => [k, prefs[k]])) });
    } else return;
    if (undos.length > 10) undos.shift();
  }

  /**
   * The PR a request is about: one it names, the only one the last answer named, or your only open PR.
   * @param {string} what
   * @param {(pr: Record<string, any>) => boolean} [fits] Which of your PRs could be meant.
   * @returns {Promise<{ ref: string | null, pr?: Record<string, any>, which?: string[], fact?: Fact }>}
   */
  async function prMeant(what, fits = () => true) {
    const named = refsIn(what).find((r) => r.includes("#"));
    const fact = await facts.read("prs");
    const all = fact.error ? [] : [...fact.record.yourPrs, ...fact.record.waitingOnYourReview];
    if (named) return { ref: named, pr: all.find((p) => p.ref === named), fact };
    const pointed = refsIn(conversation.lastAnswer()).filter((r) => r.includes("#"));
    if (pointed.length === 1) return { ref: pointed[0], pr: all.find((p) => p.ref === pointed[0]), fact };
    const mine = fact.error ? [] : fact.record.yourPrs.filter((p) => !p.draft && fits(p));
    if (mine.length === 1) return { ref: mine[0].ref, pr: mine[0], fact };
    return { ref: null, which: mine.map((p) => p.ref), fact };
  }

  /**
   * Your lists, items, habits and dates for matching, or nothing when the Personal cards aren't here or can't be read.
   * @returns {import("./felix-personal.mjs").Known | undefined}
   */
  function knownPersonal() {
    try { return personal?.known(); } catch { return undefined; }
  }

  /** The local commands that need Felix's own state: undo, "that's wrong", watchers and fixes. */
  const OWN = {
    /** Undoes the last thing a local command did here. @returns {Promise<Reply>} */
    undo: async () => {
      const last = undos.pop();
      if (!last) return { text: "There's nothing of mine to undo here. Merges, reviews and invite answers already left your Mac, so those can't be undone." };
      if (last.final) return { text: `That already left your Mac (${last.label}), so I can't undo it.` };
      if (last.task && tasks) {
        if (last.task.remove) tasks.remove(last.task.remove);
        if (last.task.reopen) tasks.update(last.task.reopen, { done: false });
        if (last.task.removeNext) tasks.remove(last.task.removeNext);
        return { text: `Undone: ${last.label}.`, tasks: true };
      }
      return { text: `Undone: ${last.label}.`, settings: last.settings };
    },
    /** Saves the last answer to the test set. @returns {Promise<Reply>} */
    wrong: async () => {
      const last = [...seen.values()].at(-1);
      if (!last) return { text: "There's nothing of mine to mark wrong yet." };
      await wrongAnswer([...seen.keys()].at(-1));
      return { text: "Thanks for telling me. I saved that question and my answer to my test set, so it gets fixed and stays fixed." };
    },
    /** Starts a watcher. @param {{ what: string }} slots @returns {Promise<Reply>} */
    "watch.add": async ({ what }) => {
      if (!watchers) return { text: "Watchers aren't set up here." };
      const want = parseWatch(what);
      if (!want) return { text: "I can watch a PR for its checks passing or failing, an approval, or being ready to merge. Say which PR, with its number." };
      const { ref, which, fact } = await prMeant(want.ref || what);
      if (!ref) return { text: which?.length ? `Which PR? ${listText(which)}.` : "Which PR? Say it with its number.", facts: fact ? [fact] : [] };
      const w = await watchers.add({ ...want, ref });
      return { text: say("watch.add", [`I'll tell you when I see ${watcherText(w)}.`, `Watching for ${watcherText(w)}. I'll let you know.`, `Okay, I'll keep an eye out for ${watcherText(w)}.`]), facts: [fact] };
    },
    /** Lists the watchers. @returns {Promise<Reply>} */
    "watch.list": async () => {
      const all = watchers ? await watchers.all() : [];
      return { text: all.length ? `I'm watching for ${listText(all.map(watcherText))}.` : "I'm not watching anything right now." };
    },
    /** Cancels watchers. @param {{ what: string }} slots @returns {Promise<Reply>} */
    "watch.cancel": async ({ what }) => {
      if (!watchers) return { text: "I'm not watching anything right now." };
      const ref = what === "all" ? null : refsIn(what)[0] || refsIn(conversation.lastAnswer())[0] || null;
      const count = await watchers.cancel(ref);
      if (!count) return { text: "I wasn't watching that." };
      return { text: ref ? `Stopped watching ${ref}.` : `Stopped all ${plural(count, "watcher")}.`.replace("all 1 watcher", "the watcher") };
    },
    /** Asks before fixing a PR's failing checks. @param {{ what: string }} slots @param {Record<string, unknown>} prefs @returns {Promise<Reply>} */
    fix: async ({ what }, prefs) => {
      const { ref, pr, which, fact } = await prMeant(what, (p) => p.checks === "failing");
      if (fact.error) return { text: `I couldn't reach GitHub just now, so I can't tell which checks are failing. (${fact.error})`, facts: [fact] };
      if (!ref) return { text: which?.length ? `Which one? ${listText(which)}.` : "None of your PRs have failing checks right now.", facts: [fact] };
      if (!pr || !fact.record.yourPrs.includes(pr)) return { text: `I can only fix your own open PRs, and ${ref} isn't one of them.`, facts: [fact] };
      if (pr.checks !== "failing") return { text: `${ref}'s checks aren't failing, so there's nothing to fix.`, facts: [fact] };
      const tool = prefs.felixTool === "cursor" ? "cursor" : "claude";
      const by = tool === "cursor" ? "Cursor" : "Claude";
      return {
        text: `Fix ${ref}'s failing checks (${listText(pr.failingChecks.slice(0, 3)) || "a check"}) with ${by}? It works in its own copy of the branch, commits there and never pushes.`,
        facts: [fact],
        confirm: { action: "fix", url: pr.url, ref, tool, label: "Start fix" },
      };
    },
  };

  /**
   * Saves an answer to Felix's test set as a failing case: the question, what he said, and the data he had.
   * @param {string} id The answer's id.
   * @returns {Promise<boolean>} Whether there was such an answer.
   */
  async function wrongAnswer(id) {
    const ex = seen.get(id);
    if (!ex || !evals) return false;
    await evals.save({ ...ex, markedWrongAt: new Date(now()).toISOString(), failing: true });
    log({ at: new Date(now()).toISOString(), markedWrong: id });
    return true;
  }

  /**
   * Checks the watchers against fresh Open PRs data.
   * @returns {Promise<import("./felix-watch.mjs").Fired[]>} The ones that came true.
   */
  async function checkWatchers() {
    if (!watchers || !(await watchers.all()).length) return [];
    const fact = await facts.read("prs");
    return fact.error ? [] : watchers.check(fact.record);
  }

  /**
   * Carries out a merge or review you said yes to, or drops it.
   * @param {string} id
   * @param {boolean} yes
   * @returns {Promise<Answer>}
   */
  async function confirm(id, yes) {
    const job = pending.get(id);
    pending.delete(id);
    if (!job || job.expires < now()) return finish({ text: "That one timed out. Ask me again if you still want it." }, "confirm");
    if (!yes) return finish({ text: say("cancel", ["Okay, I won't.", "No problem, cancelled.", "Got it, leaving it alone."]) }, "confirm");
    try {
      if (job.action === "forget") {
        const count = notes ? await notes.remove(job.ids || []) : 0;
        log({ at: new Date(now()).toISOString(), action: job.action, forgot: count });
        return finish({ text: count === 1 ? "Forgotten." : `Forgot all ${count}.` }, "confirm");
      }
      if (job.action === "rsvp") {
        await actions.rsvp(job.eventId, job.response, job.note || "");
        undos.push({ label: `answering the invite to ${job.ref}`, final: true });
        const said = { accepted: "accepted", declined: "declined", tentative: "said maybe to" }[job.response];
        log({ at: new Date(now()).toISOString(), action: job.action, response: job.response });
        return finish({ text: `Done, I've ${said} ${job.ref}${job.note ? ", with your note" : ""}.` }, "confirm");
      }
      if (job.action === "learn-phrase") {
        await phrases?.learn(job.phrase, job.command);
        log({ at: new Date(now()).toISOString(), action: job.action, phrase: job.phrase, command: job.command });
        return finish({ text: `Got it. Next time "${job.phrase}" runs "${job.command}" right here, with no AI.` }, "confirm");
      }
      if (job.action === "fix") {
        const result = await actions.fix(job.url, job.tool || "claude");
        undos.push({ label: `starting the fix of ${job.ref}`, final: true });
        log({ at: new Date(now()).toISOString(), action: job.action, ref: job.ref });
        return finish({ text: fixText(job.ref, result) }, "confirm");
      }
      if (job.action === "undo-apply") {
        const undone = await actions.undoApply();
        log({ at: new Date(now()).toISOString(), action: job.action, text: undone.text });
        return finish({ text: undone.text, ...(undone.ok ? { restarting: true } : {}) }, "confirm");
      }
      const text = job.action === "merge" ? mergedText(job.ref, await actions.merge(job.url)) : reviewText(job.ref, actions.review(job.url, job.tool || "claude"));
      // These left the Mac, so "undo" says it can't take them back.
      undos.push({ label: `${job.action === "merge" ? "merging" : "starting the review of"} ${job.ref}`, final: true });
      log({ at: new Date(now()).toISOString(), action: job.action, ref: job.ref, text });
      return finish({ text }, "confirm");
    } catch (e) {
      return finish({ text: `That didn't work: ${e.message}` }, "confirm");
    }
  }

  /**
   * Starts the sessions Felix may pick from, for quick and deep questions, or keeps them open longer, so a
   * question doesn't wait for one to start: Claude's for each model, and Cursor's one when Cursor would answer.
   * @returns {Promise<void>}
   */
  async function warm() {
    const prefs = await settings.get();
    if (!prefs.felixOn) return;
    const pastLimit = Boolean(brain.pastLimit?.());
    // The models the next question will really use, lighter ones included when Claude's plan was getting full.
    const picks = ["quick", "deep"].map((d) => pickModel(prefs, d, pastLimit, lastLean));
    for (const model of new Set(picks.filter((p) => p.tool === "claude").map((p) => p.model))) brain.warm(model);
    if (picks.some((p) => p.tool === "cursor")) brain.warmCursor?.();
  }

  /**
   * Adds a message to the answer in progress, without stopping it: the AI takes it in between steps of its
   * work and carries on with it in mind.
   * @param {string} text
   * @returns {Promise<boolean>} Whether an AI answer was in progress to take it.
   */
  async function steer(text) {
    const said = String(text || "").trim().slice(0, 4000);
    if (!said || !brain.steer) return false;
    const taken = await brain.steer(said);
    if (taken) log({ at: new Date(now()).toISOString(), steer: said });
    return taken;
  }

  /**
   * Stops the answer in progress, as when you click Stop: the AI's work ends there, and its session starts fresh
   * for the next question.
   * @returns {Promise<boolean>} Whether anything was working.
   */
  async function stop() {
    const stopped = Boolean(await brain.stop?.());
    if (stopped) log({ at: new Date(now()).toISOString(), stopped: true });
    return stopped;
  }

  /**
   * Learns from the conversation now, without waiting for the quiet spell, as when Felix shuts down.
   * @returns {Promise<number>} How many notes were saved.
   */
  const learnNow = async () => (learner ? (await learner.learn()).length : 0);

  /**
   * Tidies Felix's notes while the Mac is idle: duplicates merge and small old details move to the archive.
   * @returns {Promise<{ merged: number, archived: number }>}
   */
  const tidyMemory = async () => (notes ? notes.tidyUp() : { merged: 0, archived: 0 });

  return { ask, confirm, warm, steer, stop, learnNow, tidyMemory, wrong: wrongAnswer, checkWatchers };
}

/**
 * The follow-up when an answer had something the data doesn't back up. The session still has the data from the
 * turn before, so this only names what didn't match; Cursor gets that turn sent along when it didn't see it.
 * @param {string} question
 * @param {string} draft
 * @param {string[]} unmatched
 * @param {string} [kept] What was already shown of the draft, which the next try carries on from.
 * @returns {string}
 */
export function retryTurn(question, draft, unmatched, kept = "") {
  // They never saw the draft, so talking about it ("my earlier answer was wrong") only confuses them.
  const UNSEEN = "They never saw that draft, so don't mention it, this check, a mistake or an earlier answer, and don't apologize; just answer.";
  const missing = `I couldn't find these in the data: ${unmatched.join(", ")}. `;
  if (kept) {
    return `You were about to say: "${draft}"\n\nI've already shown this much: "${kept.trim()}"\n\n${missing}`
      + `Carry on from where that ends, without repeating it, in the same friendly way, using only what's in the data. ${UNSEEN} My question: ${question}`;
  }
  return `You were about to say: "${draft}"\n\n${missing}Answer again, in the same friendly way, using only what's in the data. ${UNSEEN} My question: ${question}`;
}

/**
 * A checked draft, or when it failed the check, the sentences of it already shown, which each passed.
 * @template {{ text: string, ok: boolean }} T
 * @param {T} draft
 * @param {string} kept
 * @returns {T}
 */
export function keptOr(draft, kept) {
  if (draft.ok || !kept.trim()) return draft;
  return { ...draft, text: kept.trim(), ok: true };
}

/**
 * Whether a message names something from work: a source Felix reads (on-call, PRs, releases, usage, music) or a PR.
 * @param {string} text
 * @param {import("./felix-conversation.mjs").Route} route Its route, as routeQuestion found it.
 * @returns {boolean}
 */
export function namesWork(text, route) {
  return route.prs.length > 0 || ROUTES.some((r) => r.re.test(text));
}

/**
 * The PRs and Jira tickets an answer named, in the order it named them, each once: "fm#101", "PMHUB-123".
 * @param {string} text
 * @returns {string[]}
 */
export const refsIn = (text) => [...new Set((String(text).match(REF) || []).map((r) => r.replace(/^(fm|bm) ?#? ?/i, (m) => `${m.trim().slice(0, 2).toLowerCase()}#`)))];

/**
 * What you said with "the first one", "the last PR" or a bare "merge it" turned into what the last answer named,
 * so the conversation carries on: "merge the first one" after a list of PRs is "merge fm#101".
 * @param {string} said
 * @param {string} last The last answer.
 * @returns {string}
 */
export function withReferences(said, last) {
  const refs = refsIn(last);
  if (!refs.length) return said;
  const ordinal = ORDINAL.exec(said);
  if (ordinal) {
    const at = ORDINAL_AT[ordinal[1].toLowerCase()];
    const ref = at < 0 ? refs.at(-1) : refs[at];
    return ref ? said.replace(ordinal[0], ref) : said;
  }
  const pointer = POINTER.exec(said.trim().replace(/[?.!]+$/, ""));
  return pointer && refs.length === 1 ? `${pointer[1]} ${refs[0]}` : said;
}

/**
 * Felix's request counts for one day, from his log: AI answers by tool, and answers made on this Mac.
 * @param {Array<Record<string, unknown>>} entries Log lines, parsed.
 * @param {string} day Like "2026-10-30", in UTC as the log writes it.
 * @returns {{ claude: number, cursor: number, local: number }}
 */
export function countsFor(entries, day) {
  const out = { claude: 0, cursor: 0, local: 0 };
  for (const e of entries) {
    if (!String(e.at || "").startsWith(day) || !e.question) continue;
    if (e.tool === "claude" || e.tool === "cursor") out[e.tool] += 1;
    else if (!e.tool && e.how && !e.drafts && !e.error) out.local += 1;
  }
  return out;
}

/**
 * A command's words as you wrote them: matching lowercases what you said, so "forget about Mochi" would otherwise
 * be answered about "mochi".
 * @param {Record<string, string | boolean>} slots
 * @param {string} said
 * @returns {Record<string, string | boolean>}
 */
export function asWritten(slots, said) {
  const out = { ...slots };
  for (const key of ["what", "note"]) {
    if (typeof slots[key] !== "string" || !slots[key]) continue;
    const at = said.toLowerCase().lastIndexOf(slots[key]);
    if (at >= 0) out[key] = said.slice(at, at + slots[key].length);
  }
  return out;
}

/**
 * Whether a command is about your Personal cards (lists, habits, journal, dates, time off, My day).
 * @param {string} intent
 * @returns {boolean}
 */
export const isPersonalIntent = (intent) => /^(lists|habits|journal|dates|timeoff|myday|wais)\./.test(intent);

/**
 * What Felix adds to an answer that changed his workbench: how the tests went there, so you know before Apply.
 * @param {{ ok: boolean } | undefined} tests
 * @returns {string}
 */
export function testsNote(tests) {
  if (!tests) return "";
  return tests.ok ? " I ran the tests in my workbench, and they pass." : " I ran the tests in my workbench, and they fail, so it isn't ready to apply yet.";
}

/**
 * What to say after a merge.
 * @param {string} ref
 * @param {{ queued?: boolean, position?: number | null, already?: boolean, merged?: boolean }} result
 * @returns {string}
 */
export function mergedText(ref, result) {
  if (result.already) return `${ref} was already in the merge queue.`;
  if (result.queued) return `${ref} is in the merge queue${result.position ? `, at number ${result.position}` : ""}.`;
  return `Merged ${ref}.`;
}

/**
 * What to say after starting a fix of a PR's failing checks.
 * @param {string} ref
 * @param {string} result "started" or "queued".
 * @returns {string}
 */
export function fixText(ref, result) {
  return result === "queued" ? `The fix of ${ref} is queued; it starts when another one finishes.`
    : `Started fixing ${ref}'s failing checks. It commits on a local branch and never pushes; you'll find it in the PR's details.`;
}

/**
 * What to say after starting a review.
 * @param {string} ref
 * @param {string} result "started" or "queued".
 * @returns {string}
 */
export function reviewText(ref, result) {
  return result === "queued" ? `The review of ${ref} is queued; it starts when another one finishes.` : `Started the review of ${ref}. It'll show up in the PR's details.`;
}
