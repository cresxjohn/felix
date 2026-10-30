// Small local server for Felix (formerly the Tech Lead Command Center). No dependencies; runs on the Mac (not in Docker)
// so it can start Claude Code reviews in hidden tmux sessions with Remote Control on.
//
// On start it also links the skills in skills/ (e.g. /review-pr) into the workspace's .claude/skills if missing.
//
// GET  /                      -> Felix's home (cards)
// GET  /prs, /prs/mine, /prs/review, /prs/releases -> the Open PRs page (/mine and /review redirect here)
// GET  /api/incident-commander[?fresh=1] -> Datadog on-call shifts for today, tomorrow and my next shift
// GET  /api/jira[?fresh=1]     -> My Jira Board: the open sprint's tickets by status, blocked, and waiting on me
// GET  /api/slack[?fresh=1]    -> the Slack card: your mentions, saved for later, and unread in the channels you watch
// GET  /api/slack/manifest     -> the Slack app manifest to make Felix's Slack app from
// GET  /api/calendar[?fresh=1] -> today's and the next few days' events on the work Google calendar
// GET  /api/ooo?from=&to=[&fresh=1] -> who's out in that range of days, from the vacation tracker
// GET  /api/team/roster        -> your team list plus every name the tracker used in the past year
// POST /api/team               -> { people } save your team list (who's on it, names, nicknames)
// POST /api/google-bridge/script -> { code, manifest } the Apps Script calendar bridge to paste, with Felix's key in it
// GET  /api/google-bridge/version -> { version } which version of the bridge script is deployed (null with no bridge)
// POST /api/connect/google-bridge -> { fields: { url } } try the deployed bridge and save it to the Keychain
// POST /api/disconnect/google-bridge -> forget the bridge
// POST /api/calendar/rsvp       -> { id, response: accepted|tentative|declined, note? } reply to an invite (through the bridge)
// GET  /api/tasks?scope=work|personal&view=today|upcoming|overdue|someday|done|all[&q=][&tag=]
//                               -> { view, today, tasks, counts, tags, projects } from data/tasks.db
// POST /api/tasks               -> { text, scope, parentId? } quick add ("Review fm#12247 tomorrow 3pm !high #review")
// POST /api/tasks/<id>          -> { patch } change a task (title, notes, priority, dueDate, dueTime, someday, repeat,
//                                  project, tags, links, done); a repeating task done makes its next one
// POST /api/tasks/<id>/delete   -> delete a task and its subtasks
// POST /api/tasks/reorder       -> { ids } the order after a drag
// Personal mode's own things, from data/personal.db (personal.mjs). Never shown in Work mode; Felix reaches them only
// when you ask (his personal commands and personal_ tools), never in work answers, briefings or the tools he builds:
// GET  /api/personal/lists[?list=<id>][&ticked=bottom|stay] -> { lists, list, items } the Lists card (starter lists on first use)
// POST /api/personal/lists      -> { name } a new list; /lists/reorder { ids } the lists' order
// POST /api/personal/lists/<id> -> { name } rename; /<id>/delete the list and its items; /<id>/items { text, at? } add
//                                  (one per line); /<id>/reorder { ids } the items' order; /<id>/clear delete the ticked
// POST /api/personal/items/<id> -> { patch: { text?, done? } } change or tick an item; /items/<id>/delete
// GET  /api/personal/habits[?weekStart=0-6] -> { today, days, habits, doneToday, archived } each habit with today, its
//                                  streaks and seven days (the last 7, or this week from weekStart)
// POST /api/personal/habits     -> { name, icon?, perDay? } a new habit; /habits/reorder { ids }
// POST /api/personal/habits/<id> -> { patch: { name?, icon?, perDay?, archived? } }; /<id>/check { day?, count? } tick
//                                  today (or a day in the last 60); /<id>/delete the habit and its check-ins
// GET  /api/personal/journal[?day=] -> { today, day, entry, earlier } a day's journal entry (today by default) and the
//                                  days written, newest first
// POST /api/personal/journal/<day> -> { text?, mood?, prompt? } save that day's entry as you type; empty removes it
// GET  /api/personal/timeoff[?fresh=1][&pick=1] -> My time off: your next break, booked leave and this year's days by kind, from the
//                                  vacation tracker for the person picked as you (timeoffMe); { needsMe, people } until then
// GET  /api/personal/myday[?fresh=1] -> My day: { weather, weatherError, holidays: { today, next, source, note }, calendar }
//                                  weather from Open-Meteo for mydayPlace, Philippine holidays, today's personal events
// GET  /api/wais[?space=&period=&accounts=a,b&outlook=&fresh=1] -> { connected, refused?, problem?, spaces, accounts, safe,
//                                  tasks, outlook, problems } the Wais card, from Wais's MCP server (read-only), kept 2 minutes
// POST /api/connect/wais        -> { fields: { token } } try a Wais access token with its spaces tool, then save it to the
//                                  Keychain; /api/disconnect/wais removes it
// GET  /api/personal/dates[?ahead=&limit=] -> { today, upcoming, later, all } birthdays, anniversaries and countdowns
// POST /api/personal/dates      -> { kind, title, month, day, year? } add one; /dates/<id> { patch } change it;
//                                  /dates/<id>/delete
// GET  /api/google/status      -> { work, personal, bridge } whether each Google app is saved and signed in
// GET  /api/google/connect/<work|personal> -> starts that Google sign-in (in a popup); /api/google/callback/<id> finishes it
// POST /api/google/finish/<work|personal> { address } -> finishes a sign-in begun on the iPad, from the address Google sent you back to
// GET  /api/shift              -> the work day (Start my day): its state, its settings, the times and whether Slack is connected
// POST /api/shift              -> { action: start|break|back|end } a step of the day; snooze ("not yet"); post|skip { id } the
//                                 step's Slack message, which only goes out on post
// GET  /api/connections        -> which accounts the cards use are connected (Jira, Datadog, Slack, Wais, Google), for Settings
// POST /api/connect/<service>  -> { fields } try a service's token (jira, datadog, slack) and save it to the Keychain if it works;
//                                 google-work and google-personal save that Google app's client ID and secret
// POST /api/disconnect/<service> -> remove that service's token from the Keychain
// GET  /api/prs               -> my PRs and PRs waiting on my review, fresh from GitHub, plus review sessions
// GET  /api/reviews           -> review sessions only (cheap; the page polls this while a review runs)
// GET  /api/pr?repo=fm&number=1 -> one PR's description, files, commits and activity for the details panel
// GET  /api/review/screen?url= -> the review session's terminal screen right now (live view)
// POST /api/review            -> { url, model? } start (or queue) a background /review-pr session
// POST /api/review/batch      -> { urls, model? } review several PRs; at most 3 run at once, the rest queue
// POST /api/fix               -> { url, kind: checks|conflict|comments|custom, request?, model? } fix my PR in a worktree
// GET  /api/fix/changes?url=  -> the fix's local commits and diff against the PR branch
// POST /api/fix/push          -> { url } push the fix's commits to the PR branch (never forced)
// POST /api/fix/discard       -> { url } close the fix session and remove its worktree
// POST /api/review/answer     -> { url, answer: A|B|C|D } answer the skill's posting question in that session
// POST /api/review/stop       -> { key } interrupt what a session is doing (like Esc); takes a review out of the queue
// POST /api/review/end        -> { key } close a session (key: PR link for reviews, "fix:<link>" for fixes)
// POST /api/review/open       -> { key, where: "warp"|"app" } open a session on this Mac to continue by hand
// POST /api/review-event      -> hook events from review sessions (hooks/report.sh)
// POST /api/remove-me         -> { url } remove me from the PR's requested reviewers on GitHub
// GET  /api/releases[?fresh=1] -> each repo's open release PR, my PRs in it, and the last release's dev and prod status
// POST /api/release/approve   -> { url } approve a release PR (changeset-release/main only)
// POST /api/merge             -> { url } add my ready PR (or a ready release PR) to the merge queue (squash merge if the repo has no queue)
// POST /api/merge/batch       -> { urls } the same for several PRs, one at a time; returns a result per PR
// GET  /settings              -> the Settings page
// GET  /api/settings          -> every setting's current value
// POST /api/settings          -> { patch } change some settings; answers with all of them
// POST /api/settings/reset    -> { keys? } put the named settings (or all of them) back to their defaults
// GET  /api/app/launcher      -> whether Chrome can save the installed app's launcher, and the fix when it can't
// GET  /api/music             -> each music source: signed in as whom, whether to sign in again, and the last sign-in's problem
// GET  /api/music/connect/<s>[?popup=1] -> starts the Spotify sign-in; /api/music/callback/<s> finishes it
//                                 on /music-signed-in in a sign-in window, otherwise on Settings
// GET  /api/music/playlists?source=spotify -> your playlists there
// GET  /api/music/spotify/now -> what Spotify is playing, on any of your devices, with shuffle and repeat
// GET  /api/music/spotify/list?kind=playlist|album|artist|liked&id=&name=&offset= -> one page of that list's songs
// GET  /api/music/spotify/search?q= -> a few songs, artists, albums and playlists for what you typed
// GET  /api/music/spotify/queue -> what plays now and up next
// GET  /api/music/spotify/recent -> the songs you played last
// GET  /api/music/spotify/saved?uri= -> { saved } whether a song is in your Liked Songs
// GET  /api/music/spotify/find?q=&kind=any|playlist|track -> what to play for something you said
// GET  /api/music/lyrics?track=&artist=&album=&durationMs= -> the song's lyrics from LRCLIB, timed when it has them
// POST /api/music/disconnect  -> { source } sign a source out
// POST /api/music/spotify     -> { action: play|pause|next|previous|volume|shuffle|repeat|seek|queue|save|transfer, uri?, uris?,
//                                 offset?, volume?, on?, mode?, positionMs?, device?, play? } control Spotify
// POST /api/music/spotify/token -> { token } a short-lived token for Felix's own Spotify player in the page
// POST /api/felix/ask          { text } -> lines of JSON: { step } while Felix checks its sources, { by } for the model at work, then { answer }
// POST /api/felix/steer        { text } -> { ok } add a message to the answer in progress, without stopping it
// POST /api/felix/confirm      { id, yes } -> { answer } carry out (or drop) a merge or review Felix asked about
// POST /api/felix/allow        { id, yes, spoken } -> { ok, text } allow (or not) a change Felix's AI asked to make
// POST /api/felix/apply        -> { ok, text, files } copy the workbench's changes into Felix (tests first), then restart
// POST /api/felix/discard      -> { ok, text } drop the workbench's changes
// GET  /api/felix/diff         -> the workbench's changes, as a patch
// GET  /api/felix/preview.png  -> a picture of the page the workbench's changes touch (404 when no page changed)
// POST /mcp                    Felix's MCP server for Claude Code: the gate's "allow" tool (token, this Mac only)
// POST /api/felix/warm         -> start Felix's AI session (and voice) ahead of a question
// POST /api/felix/hear         { audio (base64), type } -> { text } what was said, by whisper.cpp on this Mac
// GET  /api/voice-web           -> { files, job } Felix's voice files kept on this Mac for other devices, like the iPad
// GET  /voice-web/<hf|ort>/...  -> one of those files; one the Mac doesn't have yet is fetched, kept and passed on
// POST /api/voice-web/download  { variant } -> { job } fetch one size's files to the Mac ahead of time
// POST /api/felix/speakable     { text, phonemes? } -> { text, phonemes? } a phrase's words as Felix says them (and their
//                               sounds), for a device making the voice
// POST /api/voice-web/report    { steps, plan, error? } -> { ok } a device's report of how its voice loaded
// POST /api/voice-web/sample    { name, wav (base64) } -> { ok, file } a line a device made, kept on the Mac to listen to
//                               { audio, type, wake: true } -> { woke, rest? } whether it starts with the wake phrase; nothing else
// POST /api/felix/speak        { text } -> audio/wav of it read aloud, in the voice and speed from Settings
// GET  /api/felix/voice        -> { hear, speak } whether hearing is set up, and which engine speaks
// GET  /api/felix/apply-status -> { last } the last change Felix applied to himself, and whether he came back healthy
// GET  /api/felix/memory       -> { notes } every note Felix learned from your talks, archived ones marked
// GET  /api/felix/memory/export -> the notes as a JSON file to save
// POST /api/felix/memory/edit  { id, text } -> { ok, note } change a note's words (the old ones go into its history)
// POST /api/felix/memory/delete { id } -> { ok } delete a note for good
// GET  /api/felix/checkins     -> { checkins, quiet, off } things you told Felix about whose day has passed, for the Felix card
// POST /api/felix/checkins/done { id } -> { ok } a check-in answered or put aside, so it isn't asked again
// POST /api/felix/wrong        { id } -> { ok } a thumbs-down: the answer goes into Felix's test set as failing
// GET  /api/felix/watchers     -> { watchers, fired } what Felix watches PRs for, and what came true since last asked
// GET  /api/felix/phrases      -> { phrases } your own ways of saying Felix's commands
// POST /api/felix/phrases/delete { phrase } -> { ok } forget a learned phrase
// GET  /api/felix/budget       -> { today, claudeShare, leanAt } Felix's requests today and how full Claude's plan is
// GET  /api/felix/jobs         -> { jobs, tools, problems } Felix's background jobs, the tools he built and any that wouldn't load
// GET  /api/felix/news         -> { items, quiet } what Felix has to tell you on his own (watchers, ready reviews and fixes, nudges), and why he'd stay quiet
// GET  /api/felix/presence     -> { quiet } "locked", "away", "meeting" or null: whether Felix should keep quiet right now
// GET  /api/felix/voices       -> { kokoro, mac } the voices Felix can speak with
// GET  /api/felix/words        -> { auto, mine } the names and words Felix knows: added on his own, and yours from Settings
// GET  /api/health             -> { ok, pid } Felix is up (the restart guard checks this after an apply)
import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { appendFile, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import path from "node:path";
import { DATADOG_SERVICE, checkDatadog, incidentCommander, resetDatadogCache } from "./datadog.mjs";
import { KEYCHAIN_SERVICE as JIRA_SERVICE, checkJira, jiraBoard, jiraGet, jiraSearch, resetJiraCache } from "./jira.mjs";
import { createConnections } from "./connections.mjs";
import { SLACK_ACCOUNT, SLACK_MANIFEST, SLACK_SERVICE, checkSlack, createSlack, watchList } from "./slack.mjs";
import { createShift, serveShift } from "./shift.mjs";
import { createGoogle } from "./google.mjs";
import { createCalendar } from "./calendar.mjs";
import { createBridge } from "./google-bridge.mjs";
import { createOoo } from "./ooo.mjs";
import { createTasks, taskPrefs, ymd } from "./tasks.mjs";
import { createTimeOff } from "./timeoff.mjs";
import { createMyDay } from "./myday.mjs";
import { createPersonal, personalRoute } from "./personal.mjs";
import { createPersonalFelix } from "./felix-personal.mjs";
import { WAIS_ACCOUNT, WAIS_SERVICE, createWais } from "./wais.mjs";
import { aiUsage } from "./ai-usage.mjs";
import { createOriginCheck, readTailscaleStatus } from "./tailnet.mjs";
import { createSettings } from "./settings.mjs";
import { createNotes } from "./felix-notes.mjs";
import { createPhrases } from "./felix-phrases.mjs";
import { createWatchers } from "./felix-watch.mjs";
import { inQuietHours } from "./felix-friend.mjs";
import { createNews, macPresence, quietReason } from "./felix-presence.mjs";
import { autoWords, parseWords, wordsFor } from "./felix-words.mjs";
import { launcherCheck } from "./launcher.mjs";
import { createMusic } from "./music.mjs";
import { createLyrics } from "./lyrics.mjs";
import { calendarRecord, createFacts, usageRecord } from "./felix-facts.mjs";
import { createBrain } from "./felix-brain.mjs";
import { claudeShare, claudeUsedUp, countsFor, createFelix } from "./felix.mjs";
import { createAgent } from "./felix-agent.mjs";
import { createTools } from "./felix-tools.mjs";
import { createToolbox } from "./felix-toolbox.mjs";
import { ownSteps } from "./felix-steps.mjs";
import { createJobs, jobTools } from "./felix-jobs.mjs";
import { createBuilder } from "./felix-builder.mjs";
import { ctxServices } from "./felix-ctx.mjs";
import { createEars, createVoice, speakable } from "./felix-voice.mjs";
import { createVoiceWeb } from "./voice-web.mjs";
import { bargeReply, wakeReply } from "./felix-wake.mjs";
import { createCache } from "./felix-cache.mjs";
import { createPreview, pageFor } from "./felix-preview.mjs";

const PORT = Number(process.env.PORT || 4777);
// The code Felix runs: a release, a frozen copy of his folder (./prs restart makes one), so edits there never reach
// him, or the app on your iPad, until the next restart.
const HERE = path.dirname(fileURLToPath(import.meta.url));
// Felix's home: the folder you edit, with his data, the tools he builds and the scripts his sessions run.
const HOME = process.env.FELIX_HOME ? path.resolve(process.env.FELIX_HOME) : HERE;
// The workspace root that holds the fm/bm clones and the review-pr skill's .claude folder.
const WORKSPACE = path.resolve(HOME, "..");
const DATA = path.join(HOME, "data");
const REVIEWS_FILE = path.join(DATA, "reviews.json");
const WARP_LAUNCH_DIR = path.join(homedir(), ".warp", "launch_configurations");
const CLAUDE = process.env.CLAUDE_BIN || path.join(homedir(), ".local", "bin", "claude");
const GH = process.env.GH_BIN || "/opt/homebrew/bin/gh";

const REPOS = [
  { key: "fm", repo: "purepm/frontend-monorepo" },
  { key: "bm", repo: "purepm/backend-monorepo" },
];
const PR_URL = /^https:\/\/github\.com\/purepm\/(frontend|backend)-monorepo\/pull\/(\d+)$/;
const ANSWERS = { A: "A", B: "B", C: "C", D: "D" };
// Models a review can run on: claude's aliases for the latest of each. "" = your usual default.
const { CLAUDE_MODELS } = createRequire(import.meta.url)("./public/ai-models.js");
const MODELS = new Set(["", ...CLAUDE_MODELS.map((m) => m.id)]);
// Reviews and fixes run on Claude Code or on Cursor's agent (cursor-runner.mjs drives Cursor).
const CURSOR = process.env.CURSOR_AGENT_BIN || path.join(homedir(), ".local", "bin", "cursor-agent");
const TOOLS = new Set(["claude", "cursor"]);
function checkToolModel(tool, model) {
  if (!TOOLS.has(tool)) throw httpError(400, "Unknown AI tool.");
  if (tool === "claude" && !MODELS.has(model)) throw httpError(400, "Unknown model.");
  // Cursor model names come from `cursor-agent models` and may carry overrides like "name[effort=high]".
  if (tool === "cursor" && !/^[\w.:\-\[\]=,]{0,100}$/.test(model)) throw httpError(400, "Unknown model.");
}

// Review sessions may run with nobody watching, so the first turn must stop at the skill's posting question.
const REVIEW_NOTE = "This review was started from the Open PRs page and may be running with nobody watching. "
  + "Do not post anything to GitHub until the user answers your posting question. "
  + "Finish with the full report and the posting question, then stop.";

mkdirSync(DATA, { recursive: true });
const settings = createSettings({ file: path.join(DATA, "settings.json") });
const music = createMusic({ redirectBase: `http://127.0.0.1:${PORT}` });
const lyrics = createLyrics();
const FELIX_DIR = path.join(DATA, "felix");
const google = createGoogle({ redirectBase: `http://127.0.0.1:${PORT}` });
// Calendar and Team out of office read through the Apps Script bridge when it's set up, else the Google sign-in.
const bridge = createBridge();
const calendarSource = { get: async (account, url) => ((await bridge.ready()) ? bridge.get(url) : google.get(account, url)) };
const calendar = createCalendar({ google: calendarSource });
const ooo = createOoo({ google: calendarSource, dir: DATA });
// Personal mode's My day (weather, holidays, your personal calendar) and My time off (your own leave from the tracker).
const myDay = createMyDay({ calendarSource, google, ooo });
const timeOff = createTimeOff({ ooo, holidayNames: (from, to) => myDay.holidayNames(from, to), today: () => ymd(Date.now()) });
const tasks = await createTasks({ file: path.join(DATA, "tasks.db") });
// Personal mode's lists, habits, journal and dates. The /api/personal routes reach it, and Felix through
// personalFelix: his local commands and his personal_ tools, when you ask. Never his facts, briefings or own tools.
const personal = await createPersonal({ file: path.join(DATA, "personal.db") });
const personalFelix = createPersonalFelix({ store: personal, timeOff, myDay, settings });
// Where new tasks go, their priority, the "at 3" rule and done-today follow the Tasks settings.
tasks.configure(taskPrefs(await settings.get()));
settings.onChange((s) => tasks.configure(taskPrefs(s)));
// Task reminders: a Mac notification at the time a task is due, even with no Felix window open, with the sound set in
// Settings. The title and sound ride as arguments, never inside the script. With reminders off, due ones pass quietly.
setInterval(async () => {
  const due = tasks.dueReminders();
  const { tasksReminders, tasksSound } = await settings.get();
  if (!tasksReminders) return;
  const sound = tasksSound === "none" ? "" : " sound name (item 3 of argv)";
  for (const r of due) {
    execFile("osascript", ["-e", "on run argv", "-e", `display notification (item 2 of argv) with title (item 1 of argv)${sound}`, "-e", "end run",
      "Felix · task due", r.title, tasksSound], () => {});
  }
}, 30e3).unref();
// Wais, the money planner (the Personal Wais card), read-only through its own MCP server with your access token.
// A new environment or server path in Settings starts it again.
const wais = createWais({ settings });
let waisWhere = "";
settings.onChange((s) => {
  const where = `${s.waisEnv}|${s.waisPath}`;
  if (waisWhere && where !== waisWhere) wais.reset();
  waisWhere = where;
});
const connections = createConnections({
  dir: DATA,
  // The board number lives in Settings (My Jira Board); the card's Set up form saves it there.
  jira: {
    service: JIRA_SERVICE, check: checkJira, reset: resetJiraCache,
    board: async () => Number((await settings.get()).jiraBoard), setBoard: (board) => settings.update({ jiraBoard: String(board) }),
  },
  datadog: { service: DATADOG_SERVICE, check: checkDatadog, reset: resetDatadogCache },
  slack: { service: SLACK_SERVICE, account: SLACK_ACCOUNT, check: checkSlack, reset: () => slack.reset() },
  wais: { service: WAIS_SERVICE, account: WAIS_ACCOUNT, check: (fields) => wais.check(fields), reset: () => wais.reset() },
});
// The work day (Start my day), kept in data/shift.json; Felix's local commands reach it too.
const slack = createSlack();
const shift = createShift({ file: path.join(DATA, "shift.json"), settings, slack });
serveShift(shift);
shift.watch();
mkdirSync(FELIX_DIR, { recursive: true });
// Every connected service, for Felix's AI to look things up and get things done itself (actions ask you first).
// Some services are made further down; each is reached only when a tool runs.
const builtinTools = createTools({
  calendar,
  rsvp: (id, response, note) => bridge.rsvp(id, response, note),
  ooo,
  oncall: () => incidentCommander({}),
  jiraSearch: (o) => jiraSearch(o),
  slack: { search: (q, n) => slack.search(q, n), post: (channel, text) => slack.post(channel, text) },
  tasks,
  prs: () => prsCache.get(),
  usage: () => aiUsage({}),
  personal: personalFelix,
  wais: { call: (tool, args) => wais.call(tool, args) },
});
// What the tools Felix builds himself can reach: reads, and your tasks. They live in tools/, one file each.
const toolCtx = ctxServices({
  calendar,
  ooo,
  oncall: () => incidentCommander({}),
  jiraSearch: (o) => jiraSearch(o),
  jiraGet: (p) => jiraGet(p),
  slack: { search: (q, n) => slack.search(q, n), read: (m, f) => slack.read(m, f) },
  googleGet: (url) => {
    if (!String(url).startsWith("https://www.googleapis.com/calendar/v3/")) throw new Error("Only Google Calendar's API can be read.");
    return calendarSource.get("work", String(url));
  },
  tasks,
  prs: () => prsCache.get(),
  usage: () => aiUsage({}),
});
const toolbox = createToolbox({ dir: path.join(HOME, "tools"), store: path.join(FELIX_DIR, "tools"), builtins: builtinTools, services: toolCtx.services });
const agent = createAgent({
  repo: HOME,
  dir: FELIX_DIR,
  port: PORT,
  skip: ["Untitled"],
  // Restarts go through the guard, a process of its own that checks the new Felix comes back healthy and puts the
  // change back when he doesn't.
  restart: (why) => spawn(process.execPath, [path.join(HOME, "felix-guard.mjs"), "--repo", HOME, "--dir", FELIX_DIR, "--port", String(PORT),
    "--pid", String(process.pid), "--why", why], { cwd: HOME, detached: true, stdio: "ignore" }).unref(),
  // Felix's toolbox, read afresh on each request, so a tool he builds is there without a restart.
  tools: () => toolbox.list(),
});
agent.workbench.sync().catch((e) => console.error(`Felix's workbench couldn't catch up: ${e.message}`));
const prsCache = createCache({ load: () => listPrs(), freshMs: 60e3, staleMs: 5 * 60e3 });
const prCache = createCache({ load: ({ repo, number }) => prDetails(repo, number), key: ({ repo, number }) => `${repo}#${number}`, freshMs: 60e3, staleMs: 5 * 60e3 });
// What Felix learns from your talks, on this Mac only. While nobody has asked him anything for a while, he tidies it.
const notes = createNotes({ file: path.join(FELIX_DIR, "notes.json") });
const phrases = createPhrases({ file: path.join(FELIX_DIR, "phrases.json") });
const watchers = createWatchers({ file: path.join(FELIX_DIR, "watchers.json") });
// "That's wrong" and a thumbs-down add a failing case to Felix's test set, one JSON line each.
const evals = { save: (entry) => appendFile(path.join(FELIX_DIR, "evals.jsonl"), `${JSON.stringify(entry)}\n`) };
// Watchers are checked against the Open PRs data every minute; what came true waits for the page to ask.
setInterval(() => { felix.checkWatchers().catch(() => {}); }, 60e3).unref();
// What Felix may say on his own (a review or fix ready, a break nudge), checked every 20 seconds, and whether you're here.
const presence = macPresence();
const news = createNews();
setInterval(() => { felixNewsTick().catch(() => {}); }, 20e3).unref();
// The names and words Felix knows on his own, from your team, the on-call schedules and Jira, refreshed hourly.
let knownWords = autoWords({});
const refreshWords = () => learnWords().then((w) => { knownWords = w; }, () => {});
setTimeout(refreshWords, 5000).unref();
setInterval(refreshWords, 60 * 60e3).unref();
let lastAskAt = 0;
setInterval(() => {
  if (Date.now() - lastAskAt > 30 * 60e3) felix.tidyMemory().catch(() => {});
}, 60 * 60e3).unref();
const brain = createBrain({ bin: CLAUDE, cursorBin: CURSOR, cwd: agent.workbench.dir, systemPrompt: agent.rules, tools: agent.tools, allow: agent.allow, mcpServers: agent.cursorMcp });
const felix = createFelix({
  tasks,
  personal: personalFelix,
  wais: { call: (tool, args) => wais.call(tool, args) },
  facts: createFacts({
    readers: {
      oncall: () => incidentCommander({}),
      prs: () => prsCache.get(),
      releases: () => releases({}),
      usage: () => aiUsage({}),
      music: () => music.spotifyNow(),
      pr: (arg) => prCache.get(arg),
      // The cards' own sources, with the cards' own settings and caches.
      calendar: async () => {
        const s = await settings.get();
        return { ...(await calendar.events({ days: s.calDays, declined: s.calDeclined, cacheMinutes: s.calCache })), canReply: await bridge.ready() };
      },
      jira: async () => {
        const s = await settings.get();
        return jiraBoard({ boardId: Number(s.jiraBoard), whose: s.jiraWhose, cacheMinutes: s.jiraCache });
      },
      ooo: async ({ from, to } = {}) => {
        const today = new Date().toLocaleDateString("en-CA");
        const start = from || today;
        return ooo.out({ from: start, to: to || new Date(Date.parse(`${start}T12:00:00`) + 13 * 86400e3).toLocaleDateString("en-CA"), cacheMinutes: (await settings.get()).oooCache });
      },
      tasks: async () => ({ ...tasks.list({ scope: "work", view: "today" }), fetchedAt: new Date().toISOString() }),
    },
  }),
  brain,
  gate: agent.gate,
  workbench: { ...agent.workbench, test: agent.test },
  memory: agent.memory,
  notes,
  phrases,
  watchers,
  evals,
  settings,
  actions: {
    merge: (url) => mergePr(url).finally(() => prsCache.refresh().catch(() => {})),
    review: (url, tool) => startReview(url, "", tool),
    undoApply: () => agent.undoApply(),
    rsvp: async (id, response, note) => {
      const answer = await bridge.rsvp(id, response, note);
      calendar.reset();
      return answer;
    },
    fix: async (url, tool) => {
      await startFix(url, "checks", "", "", tool);
      return "started";
    },
    lastApply: () => agent.lastApply(),
  },
  log: (entry) => appendFile(path.join(FELIX_DIR, "log.jsonl"), `${JSON.stringify(entry)}\n`).catch(() => {}),
  modelName,
});
// Felix's helpers: background jobs (building a tool he's missing, a task handed off), a few at once, each getting
// back to you on its own through his news. The builder runs Opus 5.5 High on Claude while its plan has room, else on Cursor.
const builder = createBuilder({
  toolbox,
  dir: path.join(FELIX_DIR, "jobs"),
  repo: HOME,
  bin: CLAUDE,
  cursorBin: CURSOR,
  mcp: agent.access,
  docs: toolCtx.docs,
  state: async () => {
    const usage = await aiUsage({}).catch(() => null);
    return { claudeUsedUp: Boolean(brain.pastLimit?.()) || claudeUsedUp(usage ? { record: usageRecord(usage, Date.now()) } : null), tool: (await settings.get()).felixTool };
  },
});
const jobs = createJobs({
  file: path.join(FELIX_DIR, "jobs.json"),
  runners: { build: builder.build, task: builder.task },
  onDone: (job) => {
    const text = job.answer || (job.kind === "build" ? "I couldn't build a way to check that this time." : `I couldn't finish "${job.title}" this time.`);
    news.add([{ id: `job|${job.id}`, kind: "job", text, at: new Date().toISOString() }]);
  },
});
toolbox.add([...jobTools({ jobs, toolbox }), {
  name: "tool_try",
  description: "For building a tool: runs a tool file that isn't saved yet (in your build folder) on the user's real data, with these args, and gives back its answer or its error.",
  inputSchema: { type: "object", properties: { file: { type: "string", description: "The tool file's full path." }, args: { type: "object" } }, required: ["file"] },
  run: async (a) => {
    if (!builder.inside(a.file)) throw new Error("Only a tool file in a build folder can be tried.");
    return toolbox.tryFile(path.resolve(String(a.file)), a.args || {});
  },
}]);
ownSteps(toolbox.stepOf);
toolbox.reload().then(() => toolbox.watch(), (e) => console.error(`Felix's own tools didn't load: ${e.message}`));

/**
 * A model's name as the chat shows it under a reply, from the shared Claude list or Cursor's own list.
 * @param {"claude" | "cursor"} tool
 * @param {string} model
 * @returns {string}
 */
function modelName(tool, model) {
  if (tool === "cursor") return `${cursorModels.list.find((m) => m.id === model)?.name || model} (Cursor)`;
  return CLAUDE_MODELS.find((m) => m.id === model)?.name || model;
}
const VOICE_DIR = path.join(FELIX_DIR, "voice");
// Felix's voice files for other devices (the iPad), handed out from this Mac.
const voiceWeb = createVoiceWeb({ dir: path.join(VOICE_DIR, "web") });
const ears = createEars({
  whisperBin: process.env.WHISPER_BIN || "/opt/homebrew/bin/whisper-cli",
  ffmpegBin: process.env.FFMPEG_BIN || "/opt/homebrew/bin/ffmpeg",
  modelFile: path.join(VOICE_DIR, "ggml-base.en.bin"),
});
const voice = createVoice({
  python: path.join(VOICE_DIR, "venv", "bin", "python"),
  script: path.join(HERE, "voice", "kokoro_worker.py"),
  modelFile: path.join(VOICE_DIR, "kokoro-v1.0.onnx"),
  voicesFile: path.join(VOICE_DIR, "voices-v1.0.bin"),
});

// ---------- GitHub ----------

let token = process.env.GH_TOKEN || "";
/**
 * Reads the GitHub token from the gh login, once, and keeps it until GitHub refuses it.
 * @param {boolean} [refresh] Read it again even when one is kept.
 * @returns {Promise<string>}
 */
function ghToken(refresh = false) {
  if (token && !refresh) return Promise.resolve(token);
  return new Promise((resolve, reject) => execFile(GH, ["auth", "token"], { timeout: 60e3 }, (err, out, stderr) => {
    if (err) {
      const why = String(stderr || err.message).trim().split("\n")[0];
      console.error(`gh auth token failed: ${why}`);
      return reject(new Error(`Could not read your gh login (${why}). Run \`gh auth login\`, then ./prs restart.`));
    }
    token = out.trim();
    resolve(token);
  }));
}

async function github(pathname, init = {}, retry = true) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${await ghToken()}`, "User-Agent": "felix", Accept: "application/vnd.github+json", ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 && retry) { await ghToken(true); return github(pathname, init, false); }
  if (res.status === 401) throw new Error("GitHub refused your gh login. Run `gh auth login`, then ./prs restart.");
  return res;
}

const QUERY = `query($mine: String!, $requested: String!, $reviewed: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 100) { ...prs }
  requested: search(query: $requested, type: ISSUE, first: 100) { ...prs }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) { ...prs }
}
fragment prs on SearchResultItemConnection {
  nodes { ... on PullRequest {
    number title body url isDraft createdAt updatedAt headRefName baseRefName headRefOid
    author { login }
    reviewDecision mergeable mergeStateStatus isInMergeQueue mergeQueueEntry { position } additions deletions changedFiles
    repository { nameWithOwner }
    labels(first: 10) { nodes { name } }
    latestReviews(first: 30) { nodes { state submittedAt author { login } commit { oid } } }
    reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state createdAt }
    } } } } } }
  } }
}`;

// CANCELLED counts as non-failing: re-runs cancel the superseded run of the same job.
const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "CANCELLED"]);

// Keeps only the latest run of each check, like `gh pr checks` does, and reads each one's outcome.
function latestChecks(contexts = []) {
  const latest = new Map();
  for (const c of contexts) {
    const key = c.__typename === "StatusContext"
      ? `ctx:${c.context}`
      : `run:${c.checkSuite?.workflowRun?.workflow?.name}:${c.name}`;
    const at = c.startedAt || c.createdAt || "";
    const prev = latest.get(key);
    if (!prev || at >= (prev.startedAt || prev.createdAt || "")) latest.set(key, c);
  }
  return [...latest.values()].map((c) => {
    const isStatus = c.__typename === "StatusContext";
    const done = isStatus ? c.state !== "PENDING" && c.state !== "EXPECTED" : c.status === "COMPLETED";
    const result = isStatus ? c.state : c.conclusion;
    return {
      name: c.name || c.context,
      workflow: c.checkSuite?.workflowRun?.workflow?.name || null,
      outcome: !done ? "pending" : PASS.has(result) ? (result === "SKIPPED" || result === "CANCELLED" ? "skipped" : "passed") : "failed",
      result: result || c.status,
      description: c.description || null,
      url: c.detailsUrl || c.targetUrl || null,
      startedAt: c.startedAt || c.createdAt || null,
      completedAt: c.completedAt || null,
    };
  });
}

function summarizeChecks(contexts = []) {
  const out = { total: 0, passed: 0, failed: 0, pending: 0, failing: [] };
  for (const c of latestChecks(contexts)) {
    out.total++;
    if (c.outcome === "pending") out.pending++;
    else if (c.outcome === "failed") { out.failed++; out.failing.push(c.name); }
    else out.passed++;
  }
  out.state = out.total === 0 ? "none" : out.failed ? "failing" : out.pending ? "pending" : "passing";
  return out;
}

// Jira keys like PMHUB-32946, from the branch first, then the title and description.
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "ES"]);
function ticketKeys(...texts) {
  const keys = new Set();
  for (const text of texts) {
    for (const [, project, num] of String(text || "").matchAll(/\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/g)) {
      const p = project.toUpperCase();
      if (!NOT_TICKETS.has(p) && /^[A-Z]+[0-9]*$/.test(p)) keys.add(`${p}-${num}`);
    }
  }
  return [...keys];
}

function shape(pr, login) {
  const reviews = pr.latestReviews?.nodes || [];
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const mine = reviews.find((r) => r.author?.login === login);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login || "ghost",
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    branch: pr.headRefName,
    base: pr.baseRefName,
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable,
    // CLEAN = approved, checks pass, no conflicts: GitHub's own "ready to merge".
    mergeState: pr.mergeStateStatus || null,
    inMergeQueue: Boolean(pr.isInMergeQueue),
    queuePosition: pr.mergeQueueEntry?.position ?? null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: (pr.labels?.nodes || []).map((l) => l.name),
    tickets: ticketKeys(pr.headRefName, pr.title, pr.body),
    approvedBy: reviews.filter((r) => r.state === "APPROVED").map((r) => r.author?.login),
    changesRequestedBy: reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author?.login),
    myReview: mine ? { state: mine.state, submittedAt: mine.submittedAt, commit: mine.commit?.oid || null } : null,
    // The author pushed after my latest review: worth a re-review.
    newCommits: Boolean(mine?.commit?.oid && pr.headRefOid && mine.commit.oid !== pr.headRefOid),
    reviewRequests: (pr.reviewRequests?.nodes || [])
      .map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name)
      .filter(Boolean),
    checks: summarizeChecks(rollup?.contexts?.nodes),
  };
}

/**
 * Both PR lists from GitHub: my open PRs, and the ones waiting on my review. Release PRs are left out
 * of the review list, since the Releases tab shows them with their own Approve and Merge.
 * @returns {Promise<{ fetchedAt: string, login: string, lists: { mine: Array<object>, review: Array<object> } }>}
 */
async function listPrs() {
  const scope = `is:pr is:open archived:false ${REPOS.map((r) => `repo:${r.repo}`).join(" ")}`;
  const res = await github("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      // user-review-requested = asked by name, not through a team. It clears once I submit a review,
      // so PRs I reviewed from this page are kept through the reviewed-by search.
      variables: {
        mine: `${scope} author:@me`,
        requested: `${scope} user-review-requested:@me -author:@me`,
        reviewed: `${scope} reviewed-by:@me -author:@me sort:updated-desc`,
      },
    }),
  });
  const body = await res.json();
  if (body.errors?.length && !body.data) throw new Error(body.errors.map((e) => e.message).join("; "));
  const login = body.data.viewer.login;
  const toPrs = (search) => search.nodes.filter((n) => n.number).map((n) => ({ repo: n.repository.nameWithOwner, ...shape(n, login) }));

  const requested = toPrs(body.data.requested).map((p) => ({ ...p, requested: true }));
  const seen = new Set(requested.map((p) => p.url));
  const tracked = readReviews();
  const keptAfterReview = toPrs(body.data.reviewed)
    .filter((p) => (tracked[p.url] || p.newCommits) && !seen.has(p.url))
    .map((p) => ({ ...p, requested: false }));

  const byRepo = (prs) => REPOS.map(({ key, repo }) => ({
    key,
    repo,
    prs: prs.filter((p) => p.repo === repo).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
  return {
    fetchedAt: new Date().toISOString(),
    login,
    lists: { mine: byRepo(toPrs(body.data.mine)), review: byRepo([...requested, ...keptAfterReview].filter((p) => p.branch !== RELEASE_BRANCH)) },
  };
}

// Everything the details panel shows for one PR. GitHub pages can't be framed, so we rebuild the
// useful parts from the API; bodies come back as GitHub's own sanitized HTML.
async function prDetails(repoKey, number) {
  const repo = REPOS.find((r) => r.key === repoKey)?.repo;
  if (!repo || !/^\d+$/.test(String(number))) throw httpError(400, "Unknown PR.");
  const base = `/repos/${repo}`;
  const html = { Accept: "application/vnd.github.html+json" };
  const get = async (p, headers) => {
    const res = await github(p, { headers });
    if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, `GitHub answered ${res.status} for ${p}.`);
    return res.json();
  };
  const [owner, name] = repo.split("/");
  const [pr, files, commits, reviews, comments, codeComments, meta] = await Promise.all([
    get(`${base}/pulls/${number}`, html),
    get(`${base}/pulls/${number}/files?per_page=100`),
    get(`${base}/pulls/${number}/commits?per_page=100`),
    get(`${base}/pulls/${number}/reviews?per_page=100`, html),
    get(`${base}/issues/${number}/comments?per_page=100`, html),
    get(`${base}/pulls/${number}/comments?per_page=100`, html),
    github("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: PR_META_QUERY, variables: { owner, name, number: Number(number) } }),
    }).then((r) => r.json()).then((b) => b.data?.repository?.pullRequest || {}),
  ]);

  // Reviewers as GitHub's sidebar shows them: everyone asked, plus everyone who reviewed.
  const reviewers = new Map();
  for (const r of meta.latestReviews?.nodes || []) {
    if (r.author?.login) reviewers.set(r.author.login, { login: r.author.login, state: r.state, at: r.submittedAt, requested: false });
  }
  for (const n of meta.reviewRequests?.nodes || []) {
    const login = n.requestedReviewer?.login || n.requestedReviewer?.name;
    if (!login) continue;
    const prev = reviewers.get(login);
    reviewers.set(login, { login, state: prev?.state || null, at: prev?.at || null, requested: true, team: !n.requestedReviewer?.login });
  }

  // Inline code comments, grouped under the review they belong to.
  const byReview = new Map();
  for (const c of codeComments) {
    const list = byReview.get(c.pull_request_review_id) || [];
    list.push({
      id: c.id, replyTo: c.in_reply_to_id || null, author: c.user?.login, at: c.created_at, html: c.body_html || "",
      path: c.path, line: c.line ?? c.original_line, hunk: (c.diff_hunk || "").split("\n").slice(-6).join("\n"), url: c.html_url,
      outdated: c.position == null,
    });
    byReview.set(c.pull_request_review_id, list);
  }

  return {
    url: pr.html_url,
    number: pr.number,
    title: pr.title,
    author: pr.user?.login,
    state: pr.merged_at ? "merged" : pr.state,
    draft: pr.draft,
    head: pr.head?.ref,
    base: pr.base?.ref,
    bodyHtml: pr.body_html || "",
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergeableState: pr.mergeable_state,
    reviewDecision: meta.reviewDecision || null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    commitCount: pr.commits,
    reviewers: [...reviewers.values()],
    assignees: (meta.assignees?.nodes || []).map((a) => a.login),
    labels: (meta.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color })),
    milestone: meta.milestone ? { title: meta.milestone.title, url: meta.milestone.url } : null,
    tickets: ticketKeys(pr.head?.ref, pr.title, pr.body),
    checks: latestChecks(meta.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes),
    // `patch` is GitHub's unified diff for the file; GitHub leaves it out for very large or binary files.
    // `url` jumps to the file in the PR's "Files changed" view (GitHub anchors are diff-<sha256 of the path>).
    files: files.map((f) => ({
      name: f.filename,
      previousName: f.previous_filename || null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
      url: `${pr.html_url}/files#diff-${createHash("sha256").update(f.filename).digest("hex")}`,
    })),
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0], author: c.author?.login || c.commit.author?.name,
      date: c.commit.author?.date, url: c.html_url,
    })),
    // Conversation: reviews (with their inline code comments) and comments, oldest first.
    // Reviews that are only a reply to a code comment show up as that reply, like on GitHub.
    timeline: [
      ...reviews.filter((r) => r.state !== "PENDING").map((r) => ({
        kind: "review", state: r.state, author: r.user?.login, at: r.submitted_at, html: r.body_html || "", url: r.html_url,
        codeComments: byReview.get(r.id) || [],
      })).filter((r) => r.html || r.codeComments.length || r.state !== "COMMENTED"),
      ...comments.map((c) => ({ kind: "comment", author: c.user?.login, at: c.created_at, html: c.body_html || "", url: c.html_url })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at))),
  };
}

const PR_META_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewDecision
    assignees(first: 10) { nodes { login } }
    labels(first: 20) { nodes { name color } }
    milestone { title url }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
    latestReviews(first: 30) { nodes { state submittedAt author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state description targetUrl createdAt }
    } } } } } }
  } }
}`;

async function removeMeAsReviewer(url) {
  const [, side, number] = PR_URL.exec(url) || [];
  if (!number) throw httpError(400, "Not a fm or bm PR link.");
  const me = await (await github("/user")).json();
  const res = await github(`/repos/purepm/${side}-monorepo/pulls/${number}/requested_reviewers`, {
    method: "DELETE",
    body: JSON.stringify({ reviewers: [me.login] }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw httpError(502, `GitHub refused: ${body.message || res.status}`);
  }
}

// Merge one of my PRs. main in fm and bm requires the merge queue (which squashes), so the PR is added to
// the queue; a repo without a queue gets a squash merge instead. Only my own open, non-draft PRs.
const MERGE_INFO = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    id state isDraft baseRefName headRefName mergeStateStatus isInMergeQueue mergeQueueEntry { position } author { login }
  } }
}`;

async function graphql(query, variables) {
  const res = await github("/graphql", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, variables }) });
  const body = await res.json().catch(() => ({}));
  if (body.errors?.length) throw httpError(502, body.errors.map((e) => e.message).join("; "));
  if (!res.ok) throw httpError(502, `GitHub answered ${res.status}.`);
  return body.data;
}

const RELEASE_BRANCH = "changeset-release/main";

async function mergePr(url) {
  const [, side, number] = PR_URL.exec(url) || [];
  if (!number) throw httpError(400, "Not a fm or bm PR link.");
  const info = await graphql(MERGE_INFO, { owner: "purepm", name: `${side}-monorepo`, number: Number(number) });
  const pr = info.repository?.pullRequest;
  if (!pr) throw httpError(404, "PR not found.");
  if (pr.author?.login !== info.viewer.login && pr.headRefName !== RELEASE_BRANCH) throw httpError(403, "Only your own PRs and the release PRs can be merged from here.");
  if (pr.state !== "OPEN") throw httpError(409, `This PR is ${pr.state.toLowerCase()}.`);
  if (pr.isDraft) throw httpError(409, "This PR is a draft.");
  if (pr.isInMergeQueue) return { queued: true, position: pr.mergeQueueEntry?.position ?? null, already: true };
  if (pr.mergeStateStatus !== "CLEAN") throw httpError(409, `Not ready to merge (GitHub says ${pr.mergeStateStatus.toLowerCase()}).`);
  const queue = await graphql(`query($owner: String!, $name: String!, $branch: String!) { repository(owner: $owner, name: $name) { mergeQueue(branch: $branch) { id } } }`,
    { owner: "purepm", name: `${side}-monorepo`, branch: pr.baseRefName });
  releaseCache = null;
  if (queue.repository?.mergeQueue) {
    const out = await graphql(`mutation($id: ID!) { enqueuePullRequest(input: { pullRequestId: $id }) { mergeQueueEntry { position } } }`, { id: pr.id });
    console.log(`Merge queue: added ${url}`);
    return { queued: true, position: out.enqueuePullRequest?.mergeQueueEntry?.position ?? null };
  }
  await graphql(`mutation($id: ID!) { mergePullRequest(input: { pullRequestId: $id, mergeMethod: SQUASH }) { pullRequest { merged } } }`, { id: pr.id });
  console.log(`Merged (squash) ${url}`);
  return { merged: true };
}

// Approve a release PR (and only a release PR: the changeset-release/main branch, someone else's).
async function approveRelease(url) {
  const [, side, number] = PR_URL.exec(url) || [];
  if (!number) throw httpError(400, "Not a fm or bm PR link.");
  const info = await graphql(MERGE_INFO, { owner: "purepm", name: `${side}-monorepo`, number: Number(number) });
  const pr = info.repository?.pullRequest;
  if (!pr) throw httpError(404, "PR not found.");
  if (pr.headRefName !== RELEASE_BRANCH) throw httpError(403, "Only the release PRs can be approved from here.");
  if (pr.state !== "OPEN") throw httpError(409, `This PR is ${pr.state.toLowerCase()}.`);
  if (pr.author?.login === info.viewer.login) throw httpError(409, "GitHub doesn't let you approve your own PR.");
  const res = await github(`/repos/purepm/${side}-monorepo/pulls/${number}/reviews`, { method: "POST", body: JSON.stringify({ event: "APPROVE" }) });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw httpError(502, `GitHub refused: ${body.message || res.status}`);
  }
  releaseCache = null;
  console.log(`Approved release ${url}`);
}

// One at a time, so GitHub sees them in the order picked; each PR gets its own result.
async function mergeBatch(urls) {
  const results = [];
  for (const url of [...new Set(urls)].slice(0, 50)) {
    try { results.push({ url, ok: true, ...(await mergePr(url)) }); }
    catch (e) { results.push({ url, ok: false, error: e.message }); }
  }
  return results;
}

// ---------- Releases ----------
// Each repo keeps one open "chore: release main (changeset)" PR on changeset-release/main. Merging it runs
// "1 - Merges to main", which deploys the released packages to dev. The card shows the open release, my PRs
// in it, and the last release's dev deploy and whether its packages have been promoted to prod.
const RELEASE_QUERY = `query($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    open: pullRequests(headRefName: "changeset-release/main", states: OPEN, first: 1, orderBy: { field: CREATED_AT, direction: DESC }) {
      nodes { number url title createdAt updatedAt body mergeStateStatus isInMergeQueue reviewDecision
        latestReviews(first: 20) { nodes { state author { login } } }
        reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } } }
    }
    last: pullRequests(headRefName: "changeset-release/main", states: MERGED, first: 1, orderBy: { field: UPDATED_AT, direction: DESC }) {
      nodes { number url mergedAt body mergeCommit { oid } }
    }
  }
}`;
const RELEASE_CACHE_MS = 60e3;
let releaseCache = null; // { at, body }

// "<details><summary>@apps/pms-spa: 1.1453.1 -> 1.1454.0</summary> ... * fix thing (#12256) ([abc](...))"
function parseRelease(body = "") {
  const packages = [];
  for (const m of body.matchAll(/<details><summary>([^<]+?):\s*([^\s<]+)\s*->\s*([^\s<]+)<\/summary>([\s\S]*?)<\/details>/g)) {
    const changes = [];
    let kind = "";
    for (const line of m[4].split("\n")) {
      const h = /^###\s+(.+)/.exec(line);
      if (h) { kind = h[1].trim(); continue; }
      const c = /^\*\s+(.+?)\s+\(#(\d+)\)/.exec(line);
      if (c) changes.push({ kind, text: c[1], pr: Number(c[2]) });
    }
    packages.push({ name: m[1].trim(), from: m[2], to: m[3], changes, dependencyOnly: !changes.length });
  }
  return packages;
}

// Prod: "4 - Platform promotion/release" deploys the promotion-manifest.yml at the commit it runs on (the
// manifest update commit). So a release is in prod once a successful prod run's manifest lists each of its
// deployable packages at that version or newer. Libraries aren't in the manifest and are skipped.
const manifestCache = new Map(); // "<repo>@<sha>" -> { section: { name: version } }

function parseManifest(text) {
  const out = {};
  let inComponents = false, section = null;
  for (const line of text.split("\n")) {
    if (/^\S/.test(line)) { inComponents = /^components:\s*$/.test(line); section = null; continue; }
    if (!inComponents) continue;
    let m;
    if ((m = /^ {2}([\w-]+):\s*$/.exec(line))) { section = m[1]; out[section] = {}; }
    else if (section && (m = /^ {4}([\w.-]+):\s*['"]?([\w.-]+)['"]?\s*$/.exec(line))) out[section][m[1]] = m[2];
  }
  return out;
}

async function manifestAt(repo, sha) {
  const key = `${repo}@${sha}`;
  if (!manifestCache.has(key)) {
    const res = await github(`/repos/${repo}/contents/promotion-manifest.yml?ref=${sha}`, { headers: { Accept: "application/vnd.github.raw+json" } });
    manifestCache.set(key, res.ok ? parseManifest(await res.text()) : null);
  }
  return manifestCache.get(key);
}

function versionAtLeast(have, want) {
  const a = String(have).split(/[.-]/).map(Number), b = String(want).split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) { if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0); }
  return true;
}

// "@services/core-service" -> section "services", name "core-service"; "endpoints/search" -> "endpoints", "search".
const manifestSpot = (pkg) => { const [section, name] = pkg.replace(/^@/, "").split("/"); return { section, name }; };

async function prodStatus(repo, packages) {
  const runs = ((await (await github(`/repos/${repo}/actions/workflows/release.yml/runs?per_page=20`)).json()).workflow_runs || [])
    .filter((r) => /\bto prod environment\b/.test(r.display_title || ""));
  const done = runs.filter((r) => r.status === "completed" && r.conclusion === "success");
  if (!done.length) return null;
  const covers = async (run) => {
    const m = await manifestAt(repo, run.head_sha);
    if (!m) return null;
    const spots = packages.map((p) => ({ ...manifestSpot(p.name), to: p.to })).filter((x) => m[x.section]);
    return { total: spots.length, covered: spots.filter((x) => m[x.section][x.name] && versionAtLeast(m[x.section][x.name], x.to)).length };
  };
  const latest = await covers(done[0]);
  if (!latest) return null;
  if (!latest.total) return { state: "none" }; // nothing deployable in this release
  const running = runs.find((r) => r.status !== "completed" && new Date(r.created_at) > new Date(done[0].created_at));
  if (latest.covered < latest.total) {
    return { state: latest.covered ? "partial" : "not-yet", covered: latest.covered, total: latest.total, running: runInfo(running) };
  }
  // In prod: find the first promotion that carried all of it.
  let first = done[0];
  for (const run of done.slice(1, 8)) {
    const c = await covers(run);
    if (!c || c.covered < c.total) break;
    first = run;
  }
  return { state: "in-prod", covered: latest.covered, total: latest.total, run: runInfo(first) };
}

const runInfo = (r) => r && { name: r.name, title: r.display_title, status: r.status, conclusion: r.conclusion, url: r.html_url, at: r.created_at, updatedAt: r.updated_at };

async function repoRelease({ key, repo }, login) {
  const [owner, name] = repo.split("/");
  const data = await graphql(RELEASE_QUERY, { owner, name });
  const open = data.repository.open.nodes[0] || null;
  const last = data.repository.last.nodes[0] || null;
  const packages = parseRelease(open?.body);
  const numbers = [...new Set(packages.flatMap((p) => p.changes.map((c) => c.pr)))];

  // Which of those PRs are mine: my recently merged PRs in this repo.
  let mine = [];
  if (numbers.length) {
    const found = await graphql(`query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { number title url mergedAt } } } }`,
      { q: `repo:${repo} is:pr is:merged author:${login} sort:updated-desc` });
    const mineByNumber = new Map(found.search.nodes.filter((n) => n.number).map((n) => [n.number, n]));
    mine = numbers.filter((n) => mineByNumber.has(n)).map((n) => ({
      ...mineByNumber.get(n),
      packages: packages.filter((p) => p.changes.some((c) => c.pr === n)).map((p) => `${p.name.replace(/^@[^/]+\//, "")} ${p.to}`),
    }));
  }

  // Dev: the "1 - Merges to main" run for the last release's merge commit.
  let dev = null;
  if (last?.mergeCommit?.oid) {
    const runs = await (await github(`/repos/${repo}/actions/runs?head_sha=${last.mergeCommit.oid}&event=push&per_page=20`)).json();
    dev = runInfo((runs.workflow_runs || []).find((r) => r.name === "1 - Merges to main"));
  }

  return {
    key, repo,
    open: open && {
      number: open.number, url: open.url, title: open.title, createdAt: open.createdAt, updatedAt: open.updatedAt,
      checks: open.commits.nodes[0]?.commit?.statusCheckRollup?.state || null,
      mergeState: open.mergeStateStatus, inMergeQueue: open.isInMergeQueue,
      reviewDecision: open.reviewDecision || null,
      approvedBy: open.latestReviews.nodes.filter((r) => r.state === "APPROVED").map((r) => r.author?.login).filter(Boolean),
      changesBy: open.latestReviews.nodes.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author?.login).filter(Boolean),
      awaiting: open.reviewRequests.nodes.map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name).filter(Boolean),
      iApproved: open.latestReviews.nodes.some((r) => r.state === "APPROVED" && r.author?.login === login),
      packages,
    },
    mine,
    last: last && { number: last.number, url: last.url, mergedAt: last.mergedAt, dev, prod: await prodStatus(repo, parseRelease(last.body)).catch(() => null) },
  };
}

async function releases({ fresh = false } = {}) {
  if (!fresh && releaseCache && Date.now() - releaseCache.at < RELEASE_CACHE_MS) return releaseCache.body;
  const login = (await graphql(`query { viewer { login } }`)).viewer.login;
  const repos = await Promise.all(REPOS.map((r) => repoRelease(r, login).catch((e) => ({ key: r.key, repo: r.repo, error: e.message }))));
  const body = { fetchedAt: new Date().toISOString(), repos };
  releaseCache = { at: Date.now(), body };
  return body;
}

// ---------- Claude sessions: reviews and fixes ----------
// Each session is an interactive Claude Code session in a hidden tmux window, with Remote Control on so
// it also shows up in the Claude phone app and on claude.ai/code. Hooks (hooks/report.sh) tell this
// server what the session is doing. reviews.json keeps one entry per key:
//   "<pr url>"      a review of someone's PR (/review-pr)
//   "fix:<pr url>"  a fix on one of my PRs, made in its own git worktree
// Entry: { type, sessionId, tmux, cwd, status, startedAt, updatedAt, steps, lastStep, result, error,
//          answer, rcUrl, note, log, model, ...fix fields }
// status: queued -> running -> ready (waiting on you) -> answering -> answered | pushed;
//         or waiting (asks for approval), failed, stopped, ended.

const TMUX = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";
const HOOKS_SETTINGS = path.join(HOME, "hooks", "settings.json");
const BUSY = ["running", "answering", "waiting"];
const MAX_RUNNING = 3; // reviews beyond this wait in a queue

// Hooks only run in sessions this server starts: the settings file is passed with --settings.
function writeHooksSettings() {
  const command = `${path.join(HOME, "hooks", "report.sh")}`;
  const hook = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "StopFailure", "SessionEnd"];
  writeFileSync(HOOKS_SETTINGS, JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, hook])) }, null, 2));
}
writeHooksSettings();

// The skills review sessions need (today just /review-pr) live in this repo under skills/. On first start on a
// new Mac, each one is linked into the workspace's .claude/skills, where sessions started there find it. A link,
// not a copy, so edits made on this Mac land in git. A skill already in the workspace is left alone.
function installSkills() {
  const from = path.join(HOME, "skills");
  const to = path.join(WORKSPACE, ".claude", "skills");
  if (!existsSync(from)) return;
  for (const name of readdirSync(from)) {
    const target = path.join(to, name);
    // Keep anything that resolves; replace a link left dangling by a moved or renamed project folder.
    try {
      if (!lstatSync(target).isSymbolicLink() || existsSync(target)) continue;
      unlinkSync(target);
    } catch {}
    try {
      mkdirSync(to, { recursive: true });
      symlinkSync(path.relative(to, path.join(from, name)), target);
      console.log(`Installed the ${name} skill: ${target}`);
    } catch (e) {
      console.error(`Couldn't install the ${name} skill: ${e.message}`);
    }
  }
}
installSkills();

function readReviews() {
  try { return JSON.parse(readFileSync(REVIEWS_FILE, "utf8")); } catch { return {}; }
}

function writeReviews(all) {
  writeFileSync(REVIEWS_FILE, JSON.stringify(all, null, 2));
}

// "fix:<url>" -> { url, fix: true }; validates the PR link.
function parseKey(key) {
  const fix = String(key).startsWith("fix:");
  const url = fix ? key.slice(4) : String(key);
  const m = PR_URL.exec(url);
  if (!m) throw httpError(400, "Not a fm or bm PR link.");
  return { url, fix, repoKey: m[1] === "frontend" ? "fm" : "bm", side: m[1], number: m[2] };
}

function tmuxName(key) {
  const { fix, repoKey, number } = parseKey(key);
  return `openprs-${fix ? "fix-" : ""}${repoKey}-${number}`;
}

function sessionAlive(name) {
  if (!name) return false;
  try { execFileSync(TMUX, ["has-session", "-t", `=${name}`], { stdio: "ignore" }); return true; } catch { return false; }
}

function stepLabel(tool, input = {}) {
  if (tool === "Bash") return input.description || String(input.command || "").slice(0, 90);
  if (tool === "Read") return `Read ${path.basename(input.file_path || "")}`;
  if (tool === "Edit" || tool === "Write") return `${tool === "Edit" ? "Edit" : "Write"} ${path.basename(input.file_path || "")}`;
  if (tool === "Grep") return `Search for ${String(input.pattern || "").slice(0, 60)}`;
  if (tool === "Glob") return `Find ${input.pattern || "files"}`;
  if (tool === "Skill") return `Load ${input.skill || "skill"}`;
  if (tool === "Agent" || tool === "Task") return input.description || "Run a helper";
  if (tool?.startsWith("mcp__")) return tool.split("__").slice(2).join(" ");
  return tool;
}

// The Remote Control link the session prints when it starts (claude.ai/code/session_…).
function findRcUrl(name) {
  try {
    const screen = execFileSync(TMUX, ["capture-pane", "-p", "-J", "-S", "-200", "-t", `=${name}:`], { encoding: "utf8" });
    return screen.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/)?.[0] || null;
  } catch { return null; }
}

// Fills in what hooks can't tell us: the Remote Control link, and sessions that ended without a SessionEnd.
function refresh(r) {
  if (r.status === "queued") { r.alive = false; return r; }
  const alive = sessionAlive(r.tmux);
  if (alive && !r.rcUrl) r.rcUrl = findRcUrl(r.tmux);
  if (!alive && [...BUSY, "ready"].includes(r.status)) {
    r.status = r.status === "ready" ? "ended" : r.stopRequested ? "stopped" : "failed";
    if (r.status === "failed") r.error = r.error || "The session closed before it finished.";
    r.updatedAt = new Date().toISOString();
  }
  r.alive = alive;
  return r;
}

function reviewsSnapshot() {
  const all = readReviews();
  for (const r of Object.values(all)) refresh(r);
  writeReviews(all);
  return Object.fromEntries(Object.entries(all).map(([key, r]) => [key, {
    type: r.type || "review", sessionId: r.sessionId, status: r.status, alive: r.alive, startedAt: r.startedAt, updatedAt: r.updatedAt,
    steps: r.steps || 0, lastStep: r.lastStep || null, result: r.result || null, error: r.error || null,
    answer: r.answer || null, rcUrl: r.rcUrl || null, note: r.note || null, log: r.log || [], model: r.model || "", tool: r.tool || "claude",
    kind: r.kind || null, head: r.head || null, branch: r.branch || null, pushedAt: r.pushedAt || null,
  }]));
}

// The session's terminal screen right now, for the page's live view.
function reviewScreen(key) {
  const r = readReviews()[key];
  if (!r) throw httpError(404, "No Claude session for this PR.");
  if (!sessionAlive(r.tmux)) return { alive: false, text: "" };
  const text = execFileSync(TMUX, ["capture-pane", "-p", "-J", "-S", "-400", "-t", `=${r.tmux}:`], { encoding: "utf8" });
  return { alive: true, text: text.replace(/\s+$/, "") };
}

// A short, timestamped record of what the session did; kept after it ends.
function addLog(r, text, kind = "step") {
  r.log = [...(r.log || []), { at: new Date().toISOString(), kind, text: String(text).slice(0, 200) }].slice(-300);
}

// Called by hooks/report.sh for every hook event in one of our sessions.
function onHookEvent(key, ev) {
  const all = readReviews();
  const r = all[key];
  if (!r || (ev.session_id && ev.session_id !== r.sessionId)) return; // not one of ours, or an old session
  const fix = r.type === "fix";
  switch (ev.hook_event_name) {
    case "SessionStart":
      if (r.status !== "ready") r.lastStep = fix ? "Starting the fix" : "Starting the review";
      addLog(r, ev.source === "resume" ? "Session resumed" : "Session started", "event");
      break;
    case "UserPromptSubmit": {
      const text = String(ev.prompt || "").trim();
      if (["ready", "answered", "ended", "pushed"].includes(r.status)) {
        r.status = "answering";
        r.answer = /^[ABCD]$/i.test(text) ? text.toUpperCase() : text.slice(0, 60);
        r.lastStep = "Working on your answer";
        addLog(r, `You answered: ${text}`, "you");
      } else {
        r.status = "running";
        addLog(r, `Prompt: ${text.slice(0, 160)}`, "you");
      }
      break;
    }
    case "PreToolUse":
      r.steps = (r.steps || 0) + 1;
      r.lastStep = stepLabel(ev.tool_name, ev.tool_input);
      if (r.status === "waiting") r.status = r.answer ? "answering" : "running";
      addLog(r, r.lastStep);
      break;
    case "Notification":
      // Claude is waiting on the person: a permission prompt or an idle reminder.
      if (/permission|approv/i.test(`${ev.notification_type} ${ev.message}`)) {
        r.status = "waiting";
        r.note = ev.message || "Claude needs your approval.";
        addLog(r, r.note, "wait");
      }
      break;
    case "Stop":
      r.result = ev.last_assistant_message || r.result;
      r.status = fix ? "ready" : r.answer ? "answered" : "ready";
      r.note = null;
      addLog(r, fix ? "Changes ready for you to check and push" : r.answer ? "Finished your answer" : "Review ready, waiting on your answer", "done");
      break;
    case "StopFailure":
      r.status = "failed";
      r.error = ev.error || ev.message || "Claude stopped with an error.";
      addLog(r, r.error, "error");
      break;
    case "SessionEnd":
      if (BUSY.includes(r.status)) { r.status = r.stopRequested ? "stopped" : "failed"; r.error = r.error || "The session closed before it finished."; }
      else if (r.status === "ready") r.status = "ended";
      addLog(r, "Session closed", "event");
      break;
  }
  r.updatedAt = new Date().toISOString();
  writeReviews(all);
  if (!BUSY.includes(r.status)) startQueued();
}

// Starts claude in a hidden tmux window. Arguments go straight to claude (no shell), so nothing here
// is read as shell syntax.
function launchSession(all, key, { cwd, title, prompt, note, model, extraArgs = [], tool = "claude" }) {
  if (tool === "cursor") return launchCursorSession(all, key, { cwd, prompt, note, model });
  const name = tmuxName(key);
  if (sessionAlive(name)) execFileSync(TMUX, ["kill-session", "-t", `=${name}`]); // replace an older session for this PR
  const sessionId = randomUUID();
  execFileSync(TMUX, [
    "new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd,
    "-e", `OPEN_PRS_REVIEW=${key}`, "-e", `OPEN_PRS_PORT=${PORT}`,
    CLAUDE,
    "--session-id", sessionId,
    "--remote-control", title,
    "--settings", HOOKS_SETTINGS,
    // Nobody is at the Mac to click permission prompts; this matches the workspace's own default.
    "--permission-mode", "bypassPermissions",
    ...(model ? ["--model", model] : []),
    ...extraArgs,
    "--append-system-prompt", note,
    prompt,
  ]);
  const now = new Date().toISOString();
  const prev = all[key] || {};
  all[key] = {
    ...prev, sessionId, tmux: name, cwd, model, tool: "claude", status: "running", startedAt: now, updatedAt: now,
    steps: 0, lastStep: "Starting Claude", result: null, error: null, answer: null, rcUrl: null, note: null, stopRequested: false,
    log: [...(prev.log || []), { at: now, kind: "event", text: `Started (${model || "default model"})` }].slice(-300),
  };
}

// Cursor's commands wait for a sign-in that never comes when it isn't signed in, so `status` is asked
// first (quick). A good answer is trusted for ten minutes.
let cursorSignedInAt = 0;
function checkCursorSignedIn() {
  if (Date.now() - cursorSignedInAt < 600e3) return;
  let out = "";
  try {
    out = execFileSync(CURSOR, ["status"], { encoding: "utf8", timeout: 20e3 });
  } catch (e) {
    if (e.code === "ENOENT") throw httpError(502, "Cursor's CLI isn't installed. See SETUP.md.");
    out = `${e.stdout || ""}${e.stderr || ""}`;
  }
  if (/not logged in/i.test(out) || !/logged in/i.test(out)) throw httpError(502, "Cursor isn't signed in. Run `cursor-agent login`, then try again.");
  cursorSignedInAt = Date.now();
}

// Cursor: a new chat, then cursor-runner.mjs in a hidden tmux window. Cursor has no system-prompt flag, so
// the note goes first in the prompt. No Remote Control link: Cursor sessions are followed on this page.
// Cursor's models, from `cursor-agent models` (lines like "gpt-5 - GPT-5"), cached for an hour. Empty when
// Cursor isn't installed or signed in; the page then offers only Cursor's default model.
let cursorModels = { at: 0, list: [], error: null };
function listCursorModels() {
  if (Date.now() - cursorModels.at < 3600e3) return cursorModels;
  const list = [];
  let error = null;
  try {
    checkCursorSignedIn();
    const out = execFileSync(CURSOR, ["models"], { encoding: "utf8", timeout: 30e3 });
    // Names can carry zero-width spaces and double spaces. The "(default)" one is what no --model picks,
    // which the page already offers as "Auto", so it is left out.
    for (const line of out.replace(/\x1b\[[0-9;]*m|[\u200b-\u200d\ufeff]/g, "").split("\n")) {
      const m = line.trim().match(/^([\w.:\-\[\]=,]+)\s+-\s+(.+?)(\s+\((current|default)\))?$/);
      if (m && m[3]?.trim() !== "(default)") list.push({ id: m[1], name: m[2].replace(/\s+/g, " ") });
    }
  } catch (e) {
    error = e.status ? e.message : /not logged in|login/i.test(`${e.stdout}${e.stderr}`) ? "Cursor isn't signed in. Run `cursor-agent login`." : "Couldn't list Cursor's models.";
  }
  cursorModels = { at: list.length ? Date.now() : 0, list, error };
  return cursorModels;
}

function launchCursorSession(all, key, { cwd, prompt, note, model }) {
  const name = tmuxName(key);
  if (sessionAlive(name)) execFileSync(TMUX, ["kill-session", "-t", `=${name}`]);
  checkCursorSignedIn();
  let chat;
  try {
    chat = execFileSync(CURSOR, ["create-chat"], { encoding: "utf8", timeout: 60e3 }).trim().split(/\s+/).pop();
  } catch (e) {
    throw httpError(502, /not logged in|login/i.test(`${e.stdout}${e.stderr}`) ? "Cursor isn't signed in. Run `cursor-agent login`, then try again." : `Couldn't start Cursor: ${String(e.stderr || e.message).slice(0, 200)}`);
  }
  if (!/^[\w-]{8,}$/.test(chat)) throw httpError(502, "Cursor didn't return a chat id.");
  execFileSync(TMUX, [
    "new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd,
    "-e", `OPEN_PRS_REVIEW=${key}`, "-e", `OPEN_PRS_PORT=${PORT}`, "-e", `CURSOR_AGENT_BIN=${CURSOR}`,
    process.execPath, path.join(HOME, "cursor-runner.mjs"),
    "--chat", chat, ...(model ? ["--model", model] : []), "--", `${note}\n\n${prompt}`,
  ]);
  const now = new Date().toISOString();
  const prev = all[key] || {};
  all[key] = {
    ...prev, sessionId: chat, tmux: name, cwd, model, tool: "cursor", status: "running", startedAt: now, updatedAt: now,
    steps: 0, lastStep: "Starting Cursor", result: null, error: null, answer: null, rcUrl: null, note: null, stopRequested: false,
    log: [...(prev.log || []), { at: now, kind: "event", text: `Started on Cursor (${model || "default model"})` }].slice(-300),
  };
}

function runningCount(all) {
  return Object.values(all).filter((r) => BUSY.includes(r.status) && sessionAlive(r.tmux)).length;
}

// ---------- Reviews ----------

function launchReview(all, url, model, tool = "claude") {
  const { repoKey, number } = parseKey(url);
  // Cursor doesn't load the workspace's Claude skills by name, so it is pointed at the skill file itself.
  const prompt = tool === "cursor"
    ? `Review ${url} by following the review-pr skill exactly: read .claude/skills/review-pr/SKILL.md and the files it points to, and treat "${url}" as its argument.`
    : `/review-pr ${url}`;
  launchSession(all, url, { cwd: WORKSPACE, title: `Review ${repoKey}#${number}`, prompt, note: REVIEW_NOTE, model, tool });
  all[url].type = "review";
}

// Starts a review now, or queues it when MAX_RUNNING sessions are already working.
function startReview(url, model = "", tool = "claude") {
  parseKey(url);
  checkToolModel(tool, model);
  const all = readReviews();
  const current = all[url] && refresh(all[url]);
  if (current && [...BUSY, "queued"].includes(current.status)) throw httpError(409, "A review of this PR is already running or queued.");
  if (runningCount(all) >= MAX_RUNNING) {
    const now = new Date().toISOString();
    all[url] = { ...(current || {}), type: "review", model, tool, status: "queued", queuedAt: now, startedAt: now, updatedAt: now, alive: false, lastStep: "Waiting for a free slot" };
    addLog(all[url], `Queued (${MAX_RUNNING} reviews already running)`, "event");
    writeReviews(all);
    return "queued";
  }
  launchReview(all, url, model, tool);
  writeReviews(all);
  return "started";
}

function startQueued() {
  const all = readReviews();
  const queued = Object.entries(all).filter(([, r]) => r.status === "queued").sort(([, a], [, b]) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  let changed = false;
  for (const [url, r] of queued) {
    if (runningCount(all) >= MAX_RUNNING) break;
    try { launchReview(all, url, r.model || "", r.tool || "claude"); } catch (e) { Object.assign(r, { status: "failed", error: e.message }); }
    changed = true;
  }
  if (changed) writeReviews(all);
}
setInterval(startQueued, 15e3).unref();

function startBatch(urls, model, tool = "claude") {
  checkToolModel(tool, model);
  const out = { started: 0, queued: 0, skipped: 0 };
  for (const url of urls.slice(0, 30)) {
    try { out[startReview(String(url), model, tool)]++; } catch { out.skipped++; }
  }
  return out;
}

function liveSession(key) {
  const r = readReviews()[key];
  if (!r) throw httpError(404, "No Claude session for this PR.");
  if (!sessionAlive(r.tmux)) throw httpError(409, "That session has ended. Start a new one or open it to resume.");
  return r;
}

// Types the answer into the session, as if you typed it in the terminal.
function answerReview(url, answer) {
  if (!ANSWERS[answer]) throw httpError(400, "Answer must be A, B, C or D.");
  const r = liveSession(url);
  if (r.status !== "ready") throw httpError(409, "The review is not waiting on an answer.");
  execFileSync(TMUX, ["send-keys", "-t", `=${r.tmux}:`, "-l", ANSWERS[answer]]);
  execFileSync(TMUX, ["send-keys", "-t", `=${r.tmux}:`, "Enter"]);
  const all = readReviews();
  Object.assign(all[url], { status: "answering", answer, lastStep: "Sending your answer", updatedAt: new Date().toISOString() });
  writeReviews(all);
}

// Stop interrupts the current work (like pressing Esc); End closes the session for good.
// Both also take a review out of the queue.
function stopReview(key) {
  const all = readReviews();
  if (all[key]?.status === "queued") return endReview(key);
  const r = liveSession(key);
  // Claude stops what it's doing on Escape; the Cursor runner ends on Ctrl-C (its chat can be resumed).
  execFileSync(TMUX, ["send-keys", "-t", `=${r.tmux}:`, r.tool === "cursor" ? "C-c" : "Escape"]);
  Object.assign(all[key], { status: "stopped", stopRequested: true, lastStep: "Stopped", updatedAt: new Date().toISOString() });
  writeReviews(all);
}

function endReview(key) {
  const all = readReviews();
  const r = all[key];
  if (!r) throw httpError(404, "No Claude session for this PR.");
  if (sessionAlive(r.tmux)) execFileSync(TMUX, ["kill-session", "-t", `=${r.tmux}`]);
  if ([...BUSY, "queued"].includes(r.status)) { r.status = "stopped"; r.stopRequested = true; }
  else if (r.status === "ready") r.status = "ended";
  r.updatedAt = new Date().toISOString();
  writeReviews(all);
  startQueued();
}

// ---------- Fixes on my own PRs ----------
// Claude works in a separate git worktree (<repo>-wt-pr-<n>) on a local branch that tracks the PR's
// branch. It commits locally but may not push; the page shows the commits and diff, and you push.

const run = promisify(execFile);
const git = (cwd, args, opts = {}) => run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 180e3, ...opts });

const FIX_PROMPTS = {
  checks: (p) => `My PR ${p.url} (branch ${p.head}) has failing checks: ${p.failing.join(", ") || "see the PR"}. Find the cause (gh run view --log-failed, or each check's details), fix it in this worktree, run the relevant tests or linters, and commit the fix.`,
  conflict: (p) => `My PR ${p.url} (branch ${p.head}) has merge conflicts with ${p.base}. Merge origin/${p.base} into this branch (git fetch origin ${p.base} && git merge origin/${p.base}), resolve every conflict keeping the intent of both sides, run the relevant tests, and commit the merge.`,
  comments: (p) => `Reviewers left comments on my PR ${p.url}. Read every review and inline comment (gh api repos/${p.repo}/pulls/${p.number}/reviews and gh api repos/${p.repo}/pulls/${p.number}/comments), make the code changes you agree with in this worktree, and commit them. In your summary, list each comment and what you did, and explain any you think should not be changed.`,
  custom: (p) => `On my PR ${p.url} (branch ${p.head}): ${p.request}\nIf this needs code changes, make them in this worktree and commit them.`,
};

const fixNote = (p) => `You are working in a separate git worktree at ${p.wt}, on local branch ${p.branch}, which tracks origin/${p.head} (the PR's branch). `
  + "Commit your work locally with a clear Conventional Commits message. Do NOT push, do NOT force-push or rewrite history, "
  + "do NOT comment on, review or merge the PR on GitHub, and do NOT add .changeset files. "
  + "The user reads your changes in the Open PRs page and pushes from there. "
  + "End with a short summary: what you changed, how you checked it, and anything left undone.";

// Belt and braces: these commands are blocked in fix sessions even with permissions bypassed.
const FIX_BLOCKED = ["Bash(git push:*)", "Bash(gh pr comment:*)", "Bash(gh pr review:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)"].join(",");

async function startFix(url, kind, request, model = "", tool = "claude") {
  const { repoKey, side, number } = parseKey(url);
  if (!FIX_PROMPTS[kind]) throw httpError(400, "Unknown kind of fix.");
  checkToolModel(tool, model);
  if (kind === "custom" && !String(request || "").trim()) throw httpError(400, "Say what Claude should change.");
  const key = `fix:${url}`;
  const all0 = readReviews();
  if (all0[key] && BUSY.includes(refresh(all0[key]).status)) throw httpError(409, "Claude is already working on this PR.");

  const [d, me] = await Promise.all([prDetails(repoKey, number), github("/user").then((r) => r.json())]);
  if (d.author !== me.login) throw httpError(403, "Fix with Claude is only for your own PRs.");
  if (d.state !== "open") throw httpError(409, "This PR is not open.");

  const repoDir = path.join(WORKSPACE, repoKey);
  const wt = path.join(WORKSPACE, `${repoKey}-wt-pr-${number}`);
  const branch = `openprs/pr-${number}`;
  await git(repoDir, ["fetch", "origin", d.head, d.base]);
  if (!existsSync(wt)) {
    // Hooks off for this one command: bm's post-checkout hook runs npm install, which is slow and can fail.
    // Claude's own commits in the worktree still run the repo's normal hooks.
    await run("git", ["-c", "core.hooksPath=/dev/null", "-C", repoDir, "worktree", "add", "-B", branch, wt, `origin/${d.head}`],
      { maxBuffer: 64 * 1024 * 1024, timeout: 300e3 });
  } else {
    // Reusing an earlier worktree: catch up with the PR branch when there's nothing local in the way.
    await git(wt, ["merge", "--ff-only", `origin/${d.head}`]).catch(() => {});
  }

  const p = {
    url, head: d.head, base: d.base, repo: `purepm/${side}-monorepo`, number, wt, branch,
    failing: d.checks.filter((c) => c.outcome === "failed").map((c) => c.name),
    request: String(request || "").trim().slice(0, 2000),
  };
  if (tool === "cursor") await blockPushForCursor(wt);
  const all = readReviews();
  launchSession(all, key, {
    cwd: wt, title: `Fix ${repoKey}#${number}`, prompt: FIX_PROMPTS[kind](p), note: fixNote(p), model, tool,
    extraArgs: ["--disallowedTools", FIX_BLOCKED],
  });
  Object.assign(all[key], { type: "fix", kind, wt, branch, head: d.head, base: d.base, repoDir, pushedAt: null });
  writeReviews(all);
  if (tool === "claude") acceptFolderTrust(all[key].tmux);
}

// Cursor's agent reads permission rules from .cursor/cli.json in the workspace; denied commands win even
// with --force. The same pushes and PR posts Claude is blocked from are denied here. The file is kept out
// of git status through the repo's info/exclude.
const CURSOR_FIX_DENY = ["Shell(git push)", "Shell(gh pr comment)", "Shell(gh pr review)", "Shell(gh pr merge)", "Shell(gh pr close)"];
async function blockPushForCursor(wt) {
  mkdirSync(path.join(wt, ".cursor"), { recursive: true });
  writeFileSync(path.join(wt, ".cursor", "cli.json"), JSON.stringify({ permissions: { allow: [], deny: CURSOR_FIX_DENY } }, null, 2));
  const exclude = (await git(wt, ["rev-parse", "--git-path", "info/exclude"])).stdout.trim();
  const file = path.isAbsolute(exclude) ? exclude : path.join(wt, exclude);
  const now = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!now.split("\n").includes(".cursor/cli.json")) {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${now}${now && !now.endsWith("\n") ? "\n" : ""}.cursor/cli.json\n`);
  }
}

// A new worktree is a folder Claude Code hasn't seen, so it asks "Do you trust this folder?" before
// starting. This server just made the worktree from your own repo for your own PR, so it answers yes
// (Claude Code then remembers it). Only that exact prompt is answered; it gives up after 30 seconds.
function acceptFolderTrust(name, triesLeft = 30) {
  setTimeout(() => {
    let screen = "";
    try { screen = execFileSync(TMUX, ["capture-pane", "-p", "-t", `=${name}:`], { encoding: "utf8" }); } catch { return; }
    if (/Yes, I trust this folder/.test(screen) && /safety check/i.test(screen)) {
      try {
        execFileSync(TMUX, ["send-keys", "-t", `=${name}:`, "Down"]);
        execFileSync(TMUX, ["send-keys", "-t", `=${name}:`, "Enter"]);
      } catch {}
      return;
    }
    if (triesLeft > 0 && !/remote-control is active|\/rc active/i.test(screen)) acceptFolderTrust(name, triesLeft - 1);
  }, 1000);
}

function fixEntry(url) {
  const r = readReviews()[`fix:${url}`];
  if (!r?.wt) throw httpError(404, "No Claude fix for this PR.");
  if (!existsSync(r.wt)) throw httpError(410, "The fix's worktree is gone.");
  return r;
}

// Splits `git diff` output into files shaped like the GitHub files list, so the page can reuse its diff view.
function parseDiff(text) {
  return text.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git")).map((chunk) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const at = chunk.indexOf("\n@@");
    const patch = at >= 0 ? chunk.slice(at + 1) : null;
    const lines = patch ? patch.split("\n") : [];
    return {
      name: m?.[2] || "?", previousName: m && m[1] !== m[2] ? m[1] : null,
      status: /^new file/m.test(chunk) ? "added" : /^deleted file/m.test(chunk) ? "removed" : /^rename from/m.test(chunk) ? "renamed" : "modified",
      additions: lines.filter((l) => l.startsWith("+")).length, deletions: lines.filter((l) => l.startsWith("-")).length,
      patch: patch && patch.length < 400e3 ? patch.replace(/\n$/, "") : null,
    };
  });
}

// What pushing would change on the PR branch: local commits and the diff against origin/<head>.
async function fixChanges(url) {
  const r = fixEntry(url);
  await git(r.wt, ["fetch", "origin", r.head]).catch(() => {});
  const upstream = `origin/${r.head}`;
  const [log, counts, status, diff] = await Promise.all([
    git(r.wt, ["log", "--format=%h%x09%an%x09%cI%x09%s", `${upstream}..HEAD`]),
    git(r.wt, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]),
    git(r.wt, ["status", "--porcelain"]),
    git(r.wt, ["diff", upstream, "HEAD"]),
  ]);
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
  return {
    head: r.head, branch: r.branch, worktree: r.wt, ahead, behind,
    uncommitted: status.stdout.split("\n").filter(Boolean).length,
    commits: log.stdout.split("\n").filter(Boolean).map((l) => { const [sha, author, date, ...msg] = l.split("\t"); return { sha, author, date, message: msg.join("\t") }; }),
    files: parseDiff(diff.stdout),
  };
}

// Pushes the worktree's commits to the PR branch. Never forced: if the branch moved, it fails.
async function pushFix(url) {
  const r = fixEntry(url);
  const all = readReviews();
  const key = `fix:${url}`;
  if (BUSY.includes(refresh(all[key]).status)) throw httpError(409, "Claude is still working. Wait for it to finish first.");
  const { stdout } = await git(r.wt, ["rev-list", "--count", `origin/${r.head}..HEAD`]);
  if (Number(stdout.trim()) === 0) throw httpError(409, "There are no new commits to push.");
  try {
    await git(r.wt, ["push", "origin", `HEAD:refs/heads/${r.head}`]);
  } catch (e) {
    throw httpError(409, `Push was refused: ${String(e.stderr || e.message).trim().split("\n").slice(-2).join(" ")}`);
  }
  Object.assign(all[key], { status: "pushed", pushedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  addLog(all[key], `Pushed to ${r.head}`, "done");
  writeReviews(all);
}

// Closes the session and removes the worktree and its local branch. Unpushed commits are lost.
async function discardFix(url) {
  const key = `fix:${url}`;
  const all = readReviews();
  const r = all[key];
  if (!r) throw httpError(404, "No Claude fix for this PR.");
  if (sessionAlive(r.tmux)) execFileSync(TMUX, ["kill-session", "-t", `=${r.tmux}`]);
  if (r.wt && existsSync(r.wt)) await git(r.repoDir, ["worktree", "remove", "--force", r.wt]);
  if (r.branch) await git(r.repoDir, ["branch", "-D", r.branch]).catch(() => {});
  delete all[key];
  writeReviews(all);
}

// ---------- Idle sessions and opening by hand ----------

// Each open session keeps a Claude process running, so idle ones are closed on a timer. They can still
// be resumed later. Answered (or stopped/failed/pushed) sessions close after 30 minutes without activity;
// one still waiting on you stays open for a day so you can answer from your phone.
const IDLE_LIMIT_MS = { answered: 30 * 60e3, pushed: 30 * 60e3, stopped: 30 * 60e3, failed: 30 * 60e3, ended: 30 * 60e3, ready: 24 * 3600e3 };

function endIdleSessions() {
  const all = readReviews();
  let changed = false;
  for (const r of Object.values(all)) {
    const limit = IDLE_LIMIT_MS[r.status];
    if (!limit || !sessionAlive(r.tmux) || Date.now() - new Date(r.updatedAt) < limit) continue;
    try { execFileSync(TMUX, ["kill-session", "-t", `=${r.tmux}`]); } catch {}
    addLog(r, "Session closed after being idle", "event");
    if (r.status === "ready") r.status = "ended";
    r.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) writeReviews(all);
}
setInterval(endIdleSessions, 5 * 60e3).unref();

// Opens the session on this Mac: a Warp window attached to the live tmux session (or resuming it if
// it ended), or the Claude app. On the phone, use the Remote Control link instead.
function openSession(key, where) {
  const r = readReviews()[key];
  if (!r?.sessionId) throw httpError(404, "No Claude session for this PR.");
  const alive = sessionAlive(r.tmux);
  const cwd = r.cwd && existsSync(r.cwd) ? r.cwd : WORKSPACE;
  if (where === "app") {
    if (r.tool === "cursor") throw httpError(409, "This session runs on Cursor; open it in Warp instead.");
    if (alive) throw httpError(409, "The session is still running in the background. Open it with the Remote Control link, or end it first.");
    // `claude --desktop` refuses to run without a terminal, so give it one with macOS's `script`.
    spawn("/usr/bin/script", ["-q", "/dev/null", CLAUDE, "--desktop", "--resume", r.sessionId], { cwd, detached: true, stdio: "ignore" }).unref();
    return;
  }
  const name = tmuxName(key);
  // Quoted: zsh would read a bare `=name` as "path of the command name".
  const command = alive ? `${TMUX} attach -t '=${name}'` : `${r.tool === "cursor" ? CURSOR : CLAUDE} --resume ${r.sessionId}`;
  mkdirSync(WARP_LAUNCH_DIR, { recursive: true });
  const file = path.join(WARP_LAUNCH_DIR, `${name}.yaml`);
  // Only a UUID, a fixed tmux name and validated paths go into the command line.
  writeFileSync(file, [
    "---",
    `name: ${name}`,
    "windows:",
    "  - tabs:",
    `      - title: ${name.replace("openprs-", "")}`,
    "        layout:",
    `          cwd: ${cwd}`,
    "          commands:",
    `            - exec: ${command}`,
    "",
  ].join("\n"));
  spawn("open", [`warp://launch/${name}`], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => { try { unlinkSync(file); } catch {} }, 15000);
}

// ---------- HTTP ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit = 20000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw httpError(413, "Request too large.");
  }
  return JSON.parse(raw || "{}");
}

const allowedOrigin = createOriginCheck({ port: PORT, readStatus: readTailscaleStatus });

/**
 * Writes must come from a Felix page: JSON only (blocks plain cross-site form posts), and an Origin of
 * Felix on localhost or on this Mac's tailnet address.
 * @param {import("node:http").IncomingMessage} req
 * @returns {Promise<void>} Rejects with a 403 otherwise.
 */
async function checkWrite(req) {
  const okOrigin = await allowedOrigin(req.headers.origin);
  if (!okOrigin || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw httpError(403, "Requests must come from the Felix page.");
  }
}

const PAGES = { "/": "home.html", "/prs": "index.html", "/prs/mine": "index.html", "/prs/review": "index.html", "/prs/releases": "index.html", "/settings": "settings.html", "/music-signed-in": "music-signed-in.html", "/voice-lab": "voice-lab.html" };
const ON_THEIR_OWN = new Set(["/music-signed-in", "/voice-lab"]);

/**
 * Whether a page request gets Felix's lasting outer page (host.html), which then loads the page in its frame so the
 * bottom bar and music carry on between pages. Only a window's own page loads do; the frame's own request, and
 * browsers that don't say what they're loading, get the page itself. A load passed on by the service worker says
 * what it is in X-Felix-Dest, because the browser then sends Sec-Fetch-Dest "empty".
 * @param {import("node:http").IncomingMessage} req
 * @param {string} pathname
 * @returns {boolean}
 */
const inOuterPage = (req, pathname) => (req.headers["x-felix-dest"] || req.headers["sec-fetch-dest"]) === "document" && !ON_THEIR_OWN.has(pathname);
// Files both pages share. Anything not listed here is not served.
const ASSETS = {
  "/theme.css": "text/css; charset=utf-8",
  "/pr-status.js": "text/javascript; charset=utf-8",
  "/layout.js": "text/javascript; charset=utf-8",
  "/shell.js": "text/javascript; charset=utf-8",
  "/cards.js": "text/javascript; charset=utf-8",
  "/music.js": "text/javascript; charset=utf-8",
  "/music.css": "text/css; charset=utf-8",
  "/felix.js": "text/javascript; charset=utf-8",
  "/felix-voice.js": "text/javascript; charset=utf-8",
  "/felix-hints.js": "text/javascript; charset=utf-8",
  "/felix-idle.js": "text/javascript; charset=utf-8",
  "/pickers.js": "text/javascript; charset=utf-8",
  "/reorder.js": "text/javascript; charset=utf-8",
  "/journal-prompts.mjs": "text/javascript; charset=utf-8",
  "/places.mjs": "text/javascript; charset=utf-8",
  "/wais-choices.mjs": "text/javascript; charset=utf-8",
  "/voice-device.js": "text/javascript; charset=utf-8",
  "/vendor/kokoro.web.js": "text/javascript; charset=utf-8",
  "/ai-models.js": "text/javascript; charset=utf-8",
  "/dropdown.js": "text/javascript; charset=utf-8",
  "/shell.css": "text/css; charset=utf-8",
  "/settings-schema.mjs": "text/javascript; charset=utf-8",
  "/shift.js": "text/javascript; charset=utf-8",
  "/shift-clock.mjs": "text/javascript; charset=utf-8",
  "/felix-progress.mjs": "text/javascript; charset=utf-8",
  "/felix-diff.mjs": "text/javascript; charset=utf-8",
  "/felix-wake-clips.mjs": "text/javascript; charset=utf-8",
  "/card-load.mjs": "text/javascript; charset=utf-8",
  "/app.js": "text/javascript; charset=utf-8",
  "/sw.js": "text/javascript; charset=utf-8",
  "/offline.html": "text/html; charset=utf-8",
  "/manifest.webmanifest": "application/manifest+json; charset=utf-8",
  "/icons/icon.svg": "image/svg+xml",
  "/icons/icon-192.png": "image/png",
  "/icons/icon-512.png": "image/png",
  "/icons/maskable-192.png": "image/png",
  "/icons/maskable-512.png": "image/png",
  "/icons/apple-touch-icon.png": "image/png",
  "/screenshots/home-wide.png": "image/png",
};
// Pictures of the workbench's changes, from its own pages on the next port.
const preview = createPreview({ dir: agent.workbench.dir, pages: PAGES, apiPort: PORT, cacheDir: path.join(FELIX_DIR, "previews") });

/**
 * Sends a picture of the page the workbench's changes touch, taken once for each version of them.
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<void>}
 */
async function felixPreview(res) {
  const route = pageFor(await agent.workbench.changes());
  if (!route) return json(res, 404, { error: "No page changed in the workbench." });
  const key = createHash("sha1").update(await agent.workbench.diff()).digest("hex").slice(0, 16);
  const file = await preview.shot(route, key);
  if (!file) return json(res, 502, { error: "Couldn't take a picture of the change." });
  res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "no-store" });
  res.end(await readFile(file));
}

/**
 * The page the Google sign-in popup ends on: it tells the Felix window that opened it, then closes itself.
 * @param {import("node:http").ServerResponse} res
 * @param {boolean} ok
 * @param {string} text What to say if it can't close itself.
 */
function googleDone(res, ok, text) {
  const message = JSON.stringify({ felix: "google-signed-in", ok, text });
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(`<!doctype html><meta charset="utf-8"><title>Felix · Google</title><body style="font:15px system-ui;padding:24px">`
    + `<p>${text.replace(/[<>&]/g, "")}</p><script>try { window.opener?.postMessage(${message}, "*"); } catch {} setTimeout(() => window.close(), ${ok ? 300 : 4000});</script></body>`);
}

// Old Open PRs links keep working.
const MOVED = { "/mine": "/prs/mine", "/review": "/prs/review", "/index.html": "/prs" };

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

/**
 * Sends the browser somewhere else.
 * @param {import("node:http").ServerResponse} res
 * @param {string} location
 */
function redirect(res, location) {
  res.writeHead(302, { Location: location, "Cache-Control": "no-store" });
  res.end();
}

/**
 * Where a music sign-in ends, on the address the browser used when that is this Mac, since a sign-in can only come
 * back here: the small "signed in" page in a sign-in window, otherwise Settings.
 * @param {import("node:http").IncomingMessage} req
 * @param {string} source
 * @param {boolean} popup Whether the sign-in runs in its own small window.
 * @returns {string}
 */
function musicReturn(req, source, popup) {
  const host = String(req.headers.host || "");
  const here = /^(localhost|127\.0\.0\.1):\d+$/.test(host) ? `http://${host}` : "";
  return popup ? `${here}/music-signed-in?${new URLSearchParams({ source })}` : `${here}/settings#music`;
}

/**
 * Where a music sign-in starts: the source's own login, or straight back for a source Felix doesn't know.
 * @param {string} source
 * @param {string} back
 * @returns {string}
 */
function signInUrl(source, back) {
  try {
    return music.connectUrl(source, back);
  } catch {
    return back;
  }
}

/**
 * Answers the music GET routes.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 * @param {URLSearchParams} q
 * @returns {Promise<boolean>} Whether the route was a music one.
 */
async function musicGet(req, res, pathname, q) {
  const [, , , step, source = ""] = pathname.split("/");
  if (pathname === "/api/music") json(res, 200, { sources: await music.status() });
  else if (pathname === "/api/music/playlists") json(res, 200, { playlists: await music.playlists(q.get("source") || "") });
  else if (pathname === "/api/music/spotify/now") json(res, 200, await music.spotifyNow());
  else if (pathname === "/api/music/spotify/list") json(res, 200, await music.spotifyTracks(Object.fromEntries(q)));
  else if (pathname === "/api/music/spotify/search") json(res, 200, await music.spotifySearch(q.get("q")));
  else if (pathname === "/api/music/spotify/queue") json(res, 200, await music.spotifyQueue());
  else if (pathname === "/api/music/spotify/recent") json(res, 200, { tracks: await music.spotifyRecent() });
  else if (pathname === "/api/music/spotify/saved") json(res, 200, { saved: await music.spotifySaved(q.get("uri")) });
  else if (pathname === "/api/music/spotify/find") json(res, 200, await music.spotifyFind({ q: q.get("q"), kind: q.get("kind") || "any" }));
  else if (pathname === "/api/music/lyrics") json(res, 200, await lyrics.lookup(Object.fromEntries(q)));
  else if (step === "connect") {
    const back = musicReturn(req, source, q.get("popup") === "1");
    redirect(res, signInUrl(source, back));
  } else if (step === "callback") {
    redirect(res, await music.finish(source, { code: q.get("code"), state: q.get("state"), error: q.get("error") }).catch((e) => e.returnTo || "/settings#music"));
  } else return false;
  return true;
}

/**
 * Answers the music POST routes.
 * @param {string} pathname
 * @param {{ source?: unknown, action?: unknown, uri?: unknown, volume?: unknown, device?: unknown, play?: unknown }} body
 * @returns {Promise<object | null>} The answer, or null when the route isn't a music one.
 */
async function musicPost(pathname, body) {
  if (pathname === "/api/music/spotify/token") return { token: await music.spotifyToken() };
  const source = String(body.source || "");
  if (pathname === "/api/music/disconnect") await music.disconnect(source);
  else if (pathname === "/api/music/spotify") await music.spotifyControl(body);
  else return null;
  return { ok: true, sources: pathname === "/api/music/spotify" ? undefined : await music.status() };
}

/**
 * Answers a question to Felix as lines of JSON, so the page can show what Felix is doing while it works: a
 * `{ step }` line for each thing Felix checks, `{ text }` lines with the reply as it's written (each piece already
 * checked), `{ reset: true }` when that's taken back for a second try, `{ ask }` with a card for each change
 * Felix's AI wants to make, then `{ answer }` (or `{ error }`).
 * @param {import("node:http").ServerResponse} res
 * @param {{ text?: unknown }} body
 * @returns {Promise<void>}
 */
async function felixAsk(res, body) {
  lastAskAt = Date.now();
  res.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
  let done = false;
  // Stop in the page drops the connection; that stops the AI's work too, so it doesn't run on unseen.
  res.on("close", () => { if (!done) felix.stop().catch(() => {}); });
  const send = (line) => { if (!res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(line)}\n`); };
  const onText = (text) => send(text === null ? { reset: true } : { text });
  try {
    send({ answer: await felix.ask(String(body.text || ""), { onProgress: (step) => send({ step }), onText, onAsk: (card) => send({ ask: card }), onModel: (by) => send({ by }) }) });
  } catch (e) {
    send({ error: e.message || "Felix couldn't answer." });
  }
  done = true;
  res.end();
}

/**
 * Felix's MCP endpoint, for Claude Code to ask the gate before it uses a tool. Only Claude's own requests get in:
 * they carry Felix's token and come straight from this Mac. Notifications get a bare 202.
 * @param {import("node:http").IncomingMessage} req
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<void>}
 */
async function felixMcp(req, res) {
  if (!agent.authorized(req.headers)) return json(res, 401, { error: "Not allowed" });
  if (req.method !== "POST") return json(res, 405, { error: "POST only" });
  const answer = await agent.mcp(await readBody(req, 4e6));
  if (!answer) {
    res.writeHead(202);
    return res.end();
  }
  json(res, 200, answer);
}

/**
 * Felix's own use of AI today, counted from his log, and how full Claude's plan is, from the AI usage card, with the
 * share past which he leans on lighter models.
 * @returns {Promise<{ today: { claude: number, cursor: number, local: number }, claudeShare: number | null, leanAt: number }>}
 */
async function felixBudget() {
  const text = await readFile(path.join(FELIX_DIR, "log.jsonl"), "utf8").catch(() => "");
  const entries = text.split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
  const usage = await aiUsage({}).catch(() => null);
  const share = claudeShare(usage ? { record: usageRecord(usage, Date.now()) } : null);
  return { today: countsFor(entries, new Date().toISOString().slice(0, 10)), claudeShare: share, leanAt: Number((await settings.get()).felixLeanAt || 0) };
}

/**
 * The check-ins for the Felix card on the Personal home: dated things you told Felix about whose day has passed,
 * each asked once. None in quiet hours, or with friend mode off; the card says which.
 * @returns {Promise<{ checkins: Array<{ id: string, followUp: string, saidAt: string, quote: string }>, quiet: boolean, off: boolean }>}
 */
async function felixCheckins() {
  const prefs = await settings.get();
  const off = prefs.felixOn === false || prefs.felixFriendOn === false;
  const quiet = !off && inQuietHours(prefs, Date.now());
  if (off || quiet) return { checkins: [], quiet, off };
  const due = await notes.dueFollowUps();
  return { checkins: due.map((n) => ({ id: n.id, followUp: String(n.followUp), saidAt: n.saidAt, quote: n.quote })), quiet, off };
}

/**
 * Answers the Felix POST routes.
 * @param {import("node:http").ServerResponse} res
 * @param {string} pathname
 * @param {{ text?: unknown, id?: unknown, yes?: unknown, audio?: unknown, type?: unknown }} body
 * @returns {Promise<boolean>} False when the route isn't a Felix one.
 */
async function felixPost(res, pathname, body) {
  if (pathname === "/api/felix/ask") await felixAsk(res, body);
  else if (pathname === "/api/felix/steer") json(res, 200, { ok: await felix.steer(String(body.text || "")) });
  else if (pathname === "/api/felix/confirm") json(res, 200, await felix.confirm(String(body.id || ""), body.yes === true));
  else if (pathname === "/api/felix/allow") json(res, 200, agent.gate.answer(String(body.id || ""), body.yes === true, { spoken: body.spoken === true }));
  else if (pathname === "/api/felix/apply") json(res, 200, await agent.apply());
  else if (pathname === "/api/felix/discard") json(res, 200, await agent.discard());
  else if (pathname === "/api/felix/memory/edit") {
    const note = await notes.edit(String(body.id || ""), String(body.text || ""));
    if (!note) throw httpError(400, "That note isn't there, or the new words look like a secret, which Felix never keeps.");
    json(res, 200, { ok: true, note });
  } else if (pathname === "/api/felix/memory/delete") json(res, 200, { ok: (await notes.remove([String(body.id || "")])) === 1 });
  else if (pathname === "/api/felix/wrong") json(res, 200, { ok: await felix.wrong(String(body.id || "")) });
  else if (pathname === "/api/felix/phrases/delete") json(res, 200, { ok: await phrases.remove(String(body.phrase || "")) });
  else if (pathname === "/api/felix/checkins/done") {
    await notes.asked(String(body.id || ""));
    json(res, 200, { ok: true });
  }
  else if (pathname === "/api/felix/warm") await felixWarm(res);
  else if (pathname === "/api/felix/hear") await felixHear(res, body);
  else if (pathname === "/api/felix/speak") await felixSpeak(res, String(body.text || ""));
  // A phrase with its words shaped for speaking (Names and words, PR numbers, dates), for a device making the voice itself.
  else if (pathname === "/api/felix/speakable") {
    const prefs = await settings.get();
    const text = speakable(String(body.text || ""), wordsFor(knownWords, prefs.felixWords).sayAs);
    // With `phonemes`, its sounds too: a device makes the voice from them, since an iPad can't work them out itself.
    json(res, 200, body.phonemes === true ? { text, phonemes: text ? await voice.phonemes(text, String(prefs.felixVoice)) : "" } : { text });
  }
  else return false;
  return true;
}

/**
 * Gets Felix ready ahead of a question: its AI session, the PR list (the one slow source), and its voice when
 * replies may be read aloud.
 * @param {import("node:http").ServerResponse} res
 * @returns {Promise<void>}
 */
async function felixWarm(res) {
  felix.warm().catch(() => {});
  prsCache.get().catch(() => {});
  // Kokoro warms up only when it's the voice that will speak.
  const prefs = await settings.get();
  if (prefs.felixTalk !== "never" && prefs.felixVoiceEngine !== "mac") voice.warm();
  json(res, 200, { ok: true });
}

/**
 * Writes out what was said in a recording. A clip sent while listening for the wake phrase gets back only whether
 * it starts with the phrase and what came after it; anything else heard is dropped here, never sent or logged.
 * @param {import("node:http").ServerResponse} res
 * @param {{ audio?: unknown, type?: unknown, wake?: unknown }} body
 * @returns {Promise<void>}
 */
async function felixHear(res, body) {
  const prefs = await settings.get();
  if (body.wake === true && !prefs.felixWakeOn) throw httpError(409, "Listening for the wake phrase is off in Settings.");
  const words = wordsFor(knownWords, prefs.felixWords).hear;
  const heard = await ears.hear(Buffer.from(String(body.audio || ""), "base64"), String(body.type || ""), String(prefs.felixName || ""), words);
  // Speech heard while Felix talked: only what to do with it comes back (his own voice is ignored).
  if (body.barge === true) return json(res, 200, bargeReply(heard, { saying: String(body.saying || ""), prefs }));
  json(res, 200, body.wake === true ? wakeReply(heard, prefs) : { text: heard });
}

/**
 * Why Felix should stay quiet right now: the screen is locked, you're away, or a meeting is on; null when he may speak.
 * @param {Record<string, unknown>} prefs
 * @returns {Promise<"locked" | "away" | "meeting" | null>}
 */
async function quietNow(prefs) {
  const [here, cal] = await Promise.all([
    presence(),
    calendar.events({ days: 1, cacheMinutes: Number(prefs.calCache) || 5 }).then((d) => ({ record: calendarRecord(d, Date.now()) }), (e) => ({ error: e.message })),
  ]);
  return quietReason({ prefs, presence: here, calendar: cal });
}

/**
 * Notes what's new on its own: reviews and fixes that finished, and a break nudge when one's due (not while you're
 * away or in a meeting).
 * @returns {Promise<void>}
 */
async function felixNewsTick() {
  const prefs = await settings.get();
  if (prefs.felixOn === false) return;
  news.sessions(readReviews(), prefs);
  // A break nudge never comes in a meeting, even with Quiet in meetings off.
  if (prefs.felixCare === true && !(await quietNow({ ...prefs, felixQuietMeetings: true }))) news.care((await shift.view()).shift, prefs);
}

/**
 * The names Felix should know, from your team list, the people on call and your open Jira tickets. A source that
 * can't be read is left out.
 * @returns {Promise<string[]>}
 */
async function learnWords() {
  const s = await settings.get();
  const [people, ic, jira] = await Promise.all([
    ooo.roster({ cacheMinutes: s.oooCache }).catch(() => []),
    incidentCommander({}).catch(() => ({})),
    jiraBoard({ boardId: Number(s.jiraBoard), whose: s.jiraWhose, cacheMinutes: s.jiraCache }).catch(() => ({})),
  ]);
  const oncall = (ic.schedules || []).flatMap((x) => (x.shifts || []).map((sh) => sh.user?.name)).filter(Boolean);
  return autoWords({ people, oncall, jiraKeys: (jira.active || []).map((t) => t.key) });
}

/**
 * Sends a sentence read aloud as WAV audio, in the voice and speed from Settings. X-Felix-Engine says which
 * engine read it: "kokoro", or "say" for the Mac's own voice.
 * @param {import("node:http").ServerResponse} res
 * @param {string} text
 * @returns {Promise<void>}
 */
async function felixSpeak(res, text) {
  const prefs = await settings.get();
  const { audio, engine } = await voice.speak(text, {
    voice: String(prefs.felixVoice), speed: Number(prefs.felixSpeed), engine: prefs.felixVoiceEngine === "mac" ? "mac" : "kokoro",
    macVoice: String(prefs.felixMacVoice || ""), sayAs: wordsFor(knownWords, prefs.felixWords).sayAs,
  });
  res.writeHead(200, { "Content-Type": "audio/wav", "Cache-Control": "no-store", "X-Felix-Engine": engine });
  res.end(audio);
}

const SHIFT_STEPS = new Set(["start", "break", "back", "end"]);

/**
 * Carries out a work-day change from the page: a step, "not yet", or the yes or no to its Slack post. A step that
 * can't follow the day as it is, or a post that's no longer waiting, answers 409 with why.
 * @param {{ action?: unknown, id?: unknown }} body
 * @returns {Promise<object>} The day as the page draws it.
 */
async function shiftPost(body) {
  const action = String(body.action || "");
  try {
    if (SHIFT_STEPS.has(action)) return await shift.act(action);
    if (action === "snooze") return await shift.snooze();
    if (action === "post" || action === "skip") return await shift.answer(String(body.id || ""), action === "post");
  } catch (e) {
    throw ["state", "off", "gone"].includes(e.code) ? Object.assign(e, { status: 409 }) : e;
  }
  throw httpError(400, "Unknown work-day action.");
}

/**
 * The largest request body a POST route takes: hook events carry whole reports and recordings are audio.
 * @param {string} pathname
 * @returns {number}
 */
const bodyLimit = (pathname) => (pathname === "/api/review-event" || pathname === "/api/felix/hear" || pathname === "/api/voice-web/sample" ? 4e6 : pathname === "/api/team" ? 200000 : 20000);

createServer(async (req, res) => {
  const { pathname, search } = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && PAGES[pathname]) {
      const outer = inOuterPage(req, pathname);
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Sec-Fetch-Dest", ...(outer ? { "X-Felix-Host": "1" } : {}) });
      return res.end(await readFile(path.join(HERE, "public", outer ? "host.html" : PAGES[pathname])));
    }
    if (req.method === "GET" && ASSETS[pathname]) {
      res.writeHead(200, { "Content-Type": ASSETS[pathname], "Cache-Control": "no-store" });
      return res.end(await readFile(path.join(HERE, "public", pathname.slice(1))));
    }
    if (req.method === "GET" && MOVED[pathname]) {
      res.writeHead(301, { Location: MOVED[pathname] + search });
      return res.end();
    }
    if (req.method === "GET" && pathname === "/api/incident-commander") {
      const fresh = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("fresh") === "1";
      try {
        const s = await settings.get();
        return json(res, 200, await incidentCommander({ fresh, days: s.icDays, lookahead: s.icLookahead, cacheMinutes: s.icCache }));
      } catch (e) {
        return json(res, e.code === "auth" || e.code === "no-token" ? 401 : 502, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && pathname === "/api/jira") {
      const fresh = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("fresh") === "1";
      try {
        const s = await settings.get();
        return json(res, 200, await jiraBoard({ boardId: Number(s.jiraBoard), whose: s.jiraWhose, cacheMinutes: s.jiraCache, fresh }));
      } catch (e) {
        return json(res, e.code === "auth" || e.code === "no-token" ? 401 : 502, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && (pathname === "/api/slack" || pathname === "/api/slack/manifest")) {
      if (pathname === "/api/slack/manifest") {
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
        return res.end(SLACK_MANIFEST);
      }
      const s = await settings.get();
      try {
        return json(res, 200, await slack.card({
          fresh: new URL(req.url, `http://localhost:${PORT}`).searchParams.get("fresh") === "1",
          days: Number(s.slackDays) || 3, watch: watchList(s.slackWatch), saved: s.slackSaved !== false, cacheMinutes: Number(s.slackCache) || 2,
        }));
      } catch (e) {
        const status = { "no-token": 409, auth: 401, scope: 403, rate: 429 }[e.code] || 502;
        return json(res, status, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && pathname === "/api/calendar") {
      const fresh = new URL(req.url, `http://localhost:${PORT}`).searchParams.get("fresh") === "1";
      try {
        const s = await settings.get();
        const events = await calendar.events({ fresh, days: s.calDays, declined: s.calDeclined, cacheMinutes: s.calCache });
        return json(res, 200, { ...events, canReply: await bridge.ready() });
      } catch (e) {
        return json(res, e.status || 502, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && (pathname === "/api/ooo" || pathname === "/api/team/roster")) {
      const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      const day = /^\d{4}-\d{2}-\d{2}$/;
      try {
        const cacheMinutes = (await settings.get()).oooCache;
        if (pathname === "/api/team/roster") return json(res, 200, { people: await ooo.roster({ fresh: q.get("fresh") === "1", cacheMinutes }) });
        const from = String(q.get("from") || "");
        const to = String(q.get("to") || from);
        if (!day.test(from) || !day.test(to) || to < from) return json(res, 400, { error: "Give a from and to day like 2026-10-30.", code: "input" });
        return json(res, 200, await ooo.out({ from, to, fresh: q.get("fresh") === "1", cacheMinutes }));
      } catch (e) {
        return json(res, e.status || 502, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && pathname === "/api/tasks") {
      const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      try {
        return json(res, 200, tasks.list({ scope: q.get("scope") || "work", view: q.get("view") || "today", q: q.get("q") || "", tag: q.get("tag") || "", project: q.get("project") || "" }));
      } catch (e) {
        return json(res, e.code === "input" ? 400 : 500, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && (pathname === "/api/personal/timeoff" || pathname === "/api/personal/myday")) {
      const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      const fresh = q.get("fresh") === "1";
      const s = await settings.get();
      try {
        if (pathname === "/api/personal/myday") return json(res, 200, await myDay.view({ place: s.mydayPlace, fresh }));
        return json(res, 200, await timeOff.view({ me: s.timeoffMe, ahead: s.timeoffAhead, fresh, cacheMinutes: s.oooCache, pick: q.get("pick") === "1" }));
      } catch (e) {
        return json(res, e.status || 502, { error: e.message, code: e.code || "error" });
      }
    }
    if (req.method === "GET" && pathname === "/api/wais") {
      const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      return json(res, 200, await wais.view({ space: q.get("space") || "", period: q.get("period") || "", accounts: q.get("accounts") || "", outlook: q.get("outlook") || "", fresh: q.get("fresh") === "1" }));
    }
    if (req.method === "GET" && pathname.startsWith("/api/personal/")) {
      const answer = personalRoute(personal, { method: "GET", pathname, query: new URL(req.url, `http://localhost:${PORT}`).searchParams });
      return json(res, answer.status, answer.body);
    }
    if (req.method === "GET" && pathname === "/api/google-bridge/version") {
      try { return json(res, 200, { version: await bridge.version() }); } catch (e) { return json(res, e.status || 502, { error: e.message, code: e.code || "error" }); }
    }
    if (req.method === "GET" && pathname === "/api/connections") {
      return json(res, 200, { ...(await connections.status()), google: { bridge: await bridge.ready(), app: await google.status("work") } });
    }
    if (req.method === "GET" && pathname === "/api/google/status") return json(res, 200, { work: await google.status("work"), personal: await google.status("personal"), bridge: await bridge.ready() });
    if (req.method === "GET" && pathname.startsWith("/api/google/connect/")) {
      try {
        redirect(res, await google.connectUrl(pathname.split("/")[4], "/"));
      } catch (e) {
        googleDone(res, false, e.message);
      }
      return;
    }
    if (req.method === "GET" && pathname.startsWith("/api/google/callback/")) {
      const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
      try {
        await google.finish(pathname.split("/")[4], { code: q.get("code"), state: q.get("state"), error: q.get("error") });
        calendar.reset();
        ooo.reset();
        myDay.reset();
        googleDone(res, true, "Signed in to Google. You can close this window.");
      } catch (e) {
        googleDone(res, false, e.message);
      }
      return;
    }
    if (req.method === "GET" && pathname === "/api/ai-usage") {
      const s = await settings.get();
      const tools = [s.aiClaude && "claude", s.aiCursor && "cursor"].filter(Boolean);
      return json(res, 200, await aiUsage({ fresh: new URL(req.url, `http://localhost:${PORT}`).searchParams.get("fresh") === "1", tools, cacheMinutes: s.aiCache }));
    }
    if (req.method === "GET" && pathname === "/api/prs") {
      const data = await prsCache.refresh();
      return json(res, 200, { ...data, reviews: reviewsSnapshot() });
    }
    if (req.method === "GET" && pathname === "/api/models") {
      const c = listCursorModels();
      return json(res, 200, { cursor: c.list, cursorError: c.error });
    }
    if (req.method === "GET" && pathname === "/api/reviews") return json(res, 200, { reviews: reviewsSnapshot() });
    if (req.method === "GET" && pathname === "/api/settings") return json(res, 200, { settings: await settings.get() });
    if (req.method === "GET" && pathname === "/api/shift") return json(res, 200, await shift.view());
    if (req.method === "GET" && pathname === "/api/health") return json(res, 200, { ok: true, pid: process.pid });
    if (req.method === "GET" && pathname === "/api/felix/apply-status") return json(res, 200, { last: await agent.lastApply() });
    if (req.method === "GET" && pathname === "/api/felix/memory") return json(res, 200, { notes: await notes.all() });
    if (req.method === "GET" && pathname === "/api/felix/checkins") return json(res, 200, await felixCheckins());
    if (req.method === "GET" && pathname === "/api/felix/watchers") return json(res, 200, { watchers: await watchers.all(), fired: watchers.takeFired() });
    if (req.method === "GET" && pathname === "/api/felix/news") {
      const prefs = await settings.get();
      const fired = watchers.takeFired().map((f) => ({ id: f.id, kind: "watch", text: f.text, at: f.at }));
      return json(res, 200, { items: [...fired, ...news.take()], quiet: await quietNow(prefs) });
    }
    if (req.method === "GET" && pathname === "/api/felix/jobs") return json(res, 200, { jobs: jobs.list({ limit: 30 }), ...(await toolbox.mine()) });
    if (req.method === "GET" && pathname === "/api/felix/presence") return json(res, 200, { quiet: await quietNow(await settings.get()) });
    if (req.method === "GET" && pathname === "/api/voice-web") return json(res, 200, await voiceWeb.status());
    if (req.method === "GET" && pathname.startsWith("/voice-web/")) return await voiceWeb.serve(decodeURIComponent(pathname.slice("/voice-web/".length)), res);
    if (req.method === "GET" && pathname === "/api/felix/voices") return json(res, 200, { kokoro: await voice.voices().catch(() => []), mac: await voice.macVoices() });
    if (req.method === "GET" && pathname === "/api/felix/words") return json(res, 200, { auto: knownWords, mine: parseWords((await settings.get()).felixWords) });
    if (req.method === "GET" && pathname === "/api/felix/phrases") return json(res, 200, { phrases: await phrases.all() });
    if (req.method === "GET" && pathname === "/api/felix/budget") return json(res, 200, await felixBudget());
    if (req.method === "GET" && pathname === "/api/felix/memory/export") {
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="felix-memory-${new Date().toISOString().slice(0, 10)}.json"` });
      return res.end(`${JSON.stringify({ exported: new Date().toISOString(), notes: await notes.all() }, null, 2)}\n`);
    }
    if (req.method === "GET" && pathname === "/api/felix/voice") {
      const engine = (await settings.get()).felixVoiceEngine;
      return json(res, 200, { hear: ears.ready(), speak: engine !== "mac" && voice.ready() ? "kokoro" : "say" });
    }
    if (req.method === "GET" && pathname === "/api/app/launcher") return json(res, 200, await launcherCheck());
    if (req.method === "GET" && pathname === "/api/releases") {
      return json(res, 200, await releases({ fresh: new URL(req.url, `http://localhost:${PORT}`).searchParams.get("fresh") === "1" }));
    }
    const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    if (req.method === "GET" && pathname.startsWith("/api/music") && (await musicGet(req, res, pathname, q))) return;
    if (req.method === "GET" && pathname === "/api/review/screen") return json(res, 200, reviewScreen(q.get("key") || q.get("url") || ""));
    if (req.method === "GET" && pathname === "/api/fix/changes") return json(res, 200, await fixChanges(q.get("url") || ""));
    if (req.method === "GET" && pathname === "/api/pr") {
      return json(res, 200, await prCache.refresh({ repo: q.get("repo"), number: q.get("number") }));
    }

    if (pathname === "/mcp") return await felixMcp(req, res);
    if (req.method === "GET" && pathname === "/api/felix/preview.png") return await felixPreview(res);
    if (req.method === "GET" && pathname === "/api/felix/diff") {
      res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      return res.end((await agent.workbench.diff()) || "No changes in Felix's workbench.");
    }
    if (req.method === "POST") {
      await checkWrite(req);
      const body = await readBody(req, bodyLimit(pathname));
      if (pathname.startsWith("/api/felix/") && (await felixPost(res, pathname, body))) return;
      if (pathname.startsWith("/api/personal/")) {
        const answer = personalRoute(personal, { method: "POST", pathname, body });
        return json(res, answer.status, answer.body);
      }
      if (pathname === "/api/voice-web/download") return json(res, 200, { job: voiceWeb.download(String(body.variant || "")) });
      if (pathname === "/api/voice-web/report") {
        await voiceWeb.report(body && typeof body === "object" ? body : {});
        return json(res, 200, { ok: true });
      }
      if (pathname === "/api/voice-web/sample") return json(res, 200, { ok: true, file: await voiceWeb.sample(String(body.name || ""), String(body.wav || "")) });
      const url = String(body.url || "");
      // `key` names a session: a PR link for a review, "fix:<link>" for a fix.
      const key = String(body.key || url);
      let extra = {};
      const tool = String(body.tool || "claude");
      if (pathname === "/api/review") extra = { result: startReview(url, String(body.model || ""), tool) };
      else if (pathname === "/api/review/batch") extra = startBatch(Array.isArray(body.urls) ? body.urls : [], String(body.model || ""), tool);
      else if (pathname === "/api/review/answer") answerReview(url, String(body.answer || ""));
      else if (pathname === "/api/review-event") {
        // From hooks/report.sh: the session key rides in a header, the hook's own JSON is the body.
        const hookKey = String(req.headers["x-open-prs-review"] || "");
        try { parseKey(hookKey); onHookEvent(hookKey, body); } catch {}
        return json(res, 200, { ok: true });
      }
      else if (pathname === "/api/review/stop") stopReview(key);
      else if (pathname === "/api/review/end") endReview(key);
      else if (pathname === "/api/review/open") openSession(key, body.where === "app" ? "app" : "warp");
      else if (pathname === "/api/fix") await startFix(url, String(body.kind || ""), String(body.request || ""), String(body.model || ""), tool);
      else if (pathname === "/api/fix/push") await pushFix(url);
      else if (pathname === "/api/fix/discard") await discardFix(url);
      else if (pathname === "/api/remove-me") await removeMeAsReviewer(url);
      else if (pathname === "/api/merge") extra = { result: await mergePr(url) };
      else if (pathname === "/api/release/approve") await approveRelease(url);
      else if (pathname === "/api/merge/batch") extra = { results: await mergeBatch(Array.isArray(body.urls) ? body.urls.map(String) : []) };
      else if (pathname === "/api/settings") return json(res, 200, { ok: true, settings: await settings.update(body.patch) });
      else if (pathname === "/api/settings/reset") return json(res, 200, { ok: true, settings: await settings.reset(body.keys) });
      else if (pathname === "/api/shift") return json(res, 200, await shiftPost(body));
      else if (pathname === "/api/connect/google-work" || pathname === "/api/connect/google-personal") {
        try {
          await google.saveClient(pathname.endsWith("work") ? "work" : "personal", body.fields || {});
          calendar.reset();
          myDay.reset();
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, e.status || 502, { error: e.message, code: e.code || "error" });
        }
      }
      else if (pathname === "/api/google/finish/work" || pathname === "/api/google/finish/personal") {
        // Signing in from the iPad: Google sends you back to this Mac's own address, which the iPad can't open, so
        // you paste that address here and Felix finishes on the Mac. Its state must match the sign-in Felix started.
        const id = pathname.endsWith("work") ? "work" : "personal";
        try {
          const back = new URL(String(body.address || "").trim());
          if (back.pathname !== `/api/google/callback/${id}`) throw httpError(400, "That isn't the address Google sent you back to. Copy the whole address from the page that didn't load.");
          await google.finish(id, { code: back.searchParams.get("code"), state: back.searchParams.get("state"), error: back.searchParams.get("error") });
          calendar.reset();
          ooo.reset();
          myDay.reset();
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, e.status || 400, { error: e instanceof TypeError ? "That doesn't look like an address. Copy the whole address from the page that didn't load." : e.message });
        }
      }
      else if (pathname === "/api/team") return json(res, 200, { ok: true, people: await ooo.saveTeam(body.people) });
      else if (pathname === "/api/google-bridge/script" || pathname === "/api/connect/google-bridge" || pathname === "/api/disconnect/google-bridge" || pathname === "/api/calendar/rsvp") {
        try {
          if (pathname === "/api/google-bridge/script") return json(res, 200, await bridge.script());
          if (pathname === "/api/disconnect/google-bridge") await bridge.disconnect();
          else if (pathname === "/api/connect/google-bridge") await bridge.connect(body.fields || {});
          else {
            const answer = await bridge.rsvp(String(body.id || ""), String(body.response || ""), String(body.note || ""));
            calendar.reset();
            return json(res, 200, answer);
          }
          calendar.reset();
          ooo.reset();
          return json(res, 200, { ok: true });
        } catch (e) {
          return json(res, e.status || 502, { error: e.message, code: e.code || "error" });
        }
      }
      else if (pathname === "/api/tasks" || pathname.startsWith("/api/tasks/")) {
        try {
          const [, , , id, action] = pathname.split("/");
          if (!id) return json(res, 200, { ok: true, task: tasks.add({ text: body.text, scope: body.scope, parentId: body.parentId || null }) });
          if (id === "reorder") { tasks.reorder(body.ids); return json(res, 200, { ok: true }); }
          if (action === "delete") { tasks.remove(id); return json(res, 200, { ok: true }); }
          if (action) throw httpError(404, "Not found");
          return json(res, 200, { ok: true, ...tasks.update(id, body.patch || {}) });
        } catch (e) {
          if (e.status && !e.code) throw e;
          return json(res, e.code === "input" ? 400 : e.status || 500, { error: e.message, code: e.code || "error" });
        }
      }
      else if (pathname === "/api/disconnect/google-work" || pathname === "/api/disconnect/google-personal") {
        await google.signOut(pathname.endsWith("work") ? "work" : "personal");
        calendar.reset();
        myDay.reset();
        return json(res, 200, { ok: true });
      }
      else if (pathname.startsWith("/api/connect/")) {
        try {
          return json(res, 200, await connections.connect(pathname.slice("/api/connect/".length), body.fields));
        } catch (e) {
          return json(res, e.code === "input" ? 400 : e.code === "auth" ? 401 : 502, { error: e.message, code: e.code || "error" });
        }
      }
      else if (pathname.startsWith("/api/disconnect/")) return json(res, 200, await connections.disconnect(pathname.slice("/api/disconnect/".length)));
      else if (pathname.startsWith("/api/music/")) {
        const answer = await musicPost(pathname, body);
        if (answer) return json(res, 200, answer);
        throw httpError(404, "Not found");
      }
      else throw httpError(404, "Not found");
      return json(res, 200, { ok: true, ...extra, reviews: reviewsSnapshot() });
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    // An answer that had already started can't be replaced by an error; end it instead of crashing the server.
    if (res.headersSent) return void res.end();
    json(res, e.status || 502, { error: e.message, ...(typeof e.code === "string" && !e.code.startsWith("E") ? { code: e.code } : {}) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Felix on http://localhost:${PORT}`));
