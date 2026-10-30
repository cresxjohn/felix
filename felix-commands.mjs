/**
 * Felix's local commands: the common things you ask or say, matched on this Mac with no AI, so they cost nothing
 * and answer fast. Anything that doesn't match goes to the AI. Each command names an intent and the parts it
 * picked out of what you said (its slots).
 */
import { SCHEDULES, SITE as DATADOG_SITE } from "./datadog.mjs";
import { findDates, findHabits, findItems, findList, parseDay, saysNot, splitItems } from "./felix-personal.mjs";

/** No lists, items, habits or dates: what matching knows when nothing is passed. @type {import("./felix-personal.mjs").Known} */
const NOTHING_KNOWN = Object.freeze({ lists: [], items: [], habits: [], dates: [] });

/**
 * A habit command's parts, when what you said names habits you have and doesn't say you didn't.
 * @param {string} said
 * @param {import("./felix-personal.mjs").Known} k
 * @returns {{ ids: string, said: string } | null}
 */
const habitSlots = (said, k) => {
  if (!said || saysNot(said)) return null;
  const found = findHabits(said, k.habits);
  return found.length ? { ids: found.map((h) => h.id).join(","), said } : null;
};

/**
 * A tick-off command's parts, when every thing you named is an open item (on the list you named, if you named one).
 * @param {string} what
 * @param {string | undefined} listSaid
 * @param {import("./felix-personal.mjs").Known} k
 * @returns {{ items: string, list: string } | null}
 */
const tickSlots = (what, listSaid, k, { ticked = false } = {}) => {
  const list = listSaid ? findList(listSaid, k.lists) : null;
  if (listSaid && !list) return null;
  const things = splitItems(what);
  // Ticking looks only at what's still open; removing takes ticked items too.
  const pool = ticked ? k.items : k.items.filter((i) => !i.done);
  return things.length && things.every((t) => findItems(t, pool, list).length) ? { items: what, list: list || "" } : null;
};

/**
 * Your Personal cards by voice and chat: lists, habits, the journal, important dates, time off and My day. Each one
 * that changes or reads something by name fires only on a list, item, habit or date you have, so near-misses
 * ("groceries were expensive", "I drank coffee") are left alone.
 * @type {Array<{ intent: string, re: RegExp, slots?: (m: RegExpMatchArray, k: import("./felix-personal.mjs").Known) => (Record<string, string | boolean> | null) }>}
 */
const PERSONAL = [
  {
    intent: "journal.add",
    re: /^(?:note|write|add|put|jot)(?: (?:this|that|down|it))? (?:in|to|into|on|down in) (?:my |the )?(?:journal|diary)(?: that)?[:,]? (.+)$|^(?:journal|dear diary)[:,] (.+)$|^(?:add to|note for) (?:my |the )?journal[:,]? (.+)$/,
    slots: (m) => ({ text: m.slice(1).find(Boolean) }),
  },
  { intent: "lists.add", re: /^(?:add|put) (.+?) (?:to|on|onto|in|into) (?:my |the |our )?(.+?)$/, slots: (m, k) => { const list = findList(m[2], k.lists); return list ? { list, items: m[1] } : null; } },
  { intent: "lists.remove", re: /^(?:remove|delete|take|cross) (.+?) (?:off|from|out of)(?: of)? (?:my |the |our )?(.+?)$/, slots: (m, k) => { const list = findList(m[2], k.lists); return list && tickSlots(m[1], m[2], k, { ticked: true }) ? { list, items: m[1] } : null; } },
  { intent: "lists.tick", re: /^(?:i )?(?:got|bought|picked up|packed|have) (.+?)(?: (?:for|from|on|in) (?:my |the |our )?(.+?))?$/, slots: (m, k) => tickSlots(m[1], m[2], k) },
  { intent: "lists.tick", re: /^(?:tick|check|cross) off (.+?)(?: (?:on|from) (?:my |the |our )?(.+?))?$/, slots: (m, k) => tickSlots(m[1], m[2], k) },
  {
    intent: "lists.show",
    re: /^(?:what'?s|what is|what do i have|anything) (?:on|in) (?:my |the |our )?(.+?)$|^(?:read|show|tell)(?: me)? (?:my |the |our )?(.+?) list$/,
    slots: (m, k) => { const list = findList(m[1] || m[2], k.lists); return list ? { list } : null; },
  },
  {
    intent: "habits.check",
    re: /^(?:i )?(?:just |already |finally )?(?:did|finished|completed|did my) (.+?)(?: today| tonight| this morning)?$|^(?:i'?m |i am )?done with (?:my )?(.+?)(?: for today| today)?$|^(?:mark|tick|check)(?: off)? (.+?)(?: as)? (?:done|complete)(?: for today| today)?$/,
    slots: (m, k) => habitSlots(m.slice(1).find(Boolean), k),
  },
  { intent: "habits.check", re: /^i (?:just |already |finally )?(.+?)(?: today| tonight| this morning| already)?$/, slots: (m, k) => habitSlots(m[1], k) },
  { intent: "habits.status", re: /^how are my habits(?: doing| going| today)?$|^how am i doing (?:on|with) (?:my )?habits(?: today)?$|^(?:what are |show me |read me )?my habits(?: today)?$|^(?:any )?habits (?:left|to do)(?: today)?$/ },
  {
    intent: "habits.streak",
    re: /^(?:what'?s|what is|how long is|how'?s) my (.+?) streak$/,
    slots: (m, k) => ({ what: m[1], ids: findHabits(m[1], k.habits).map((h) => h.id).join(",") }),
  },
  {
    intent: "dates.add",
    re: /^(?:remind me|remember|note|save)(?: that)? (.+?) (birthday|anniversary) is (?:on )?(.+)$/,
    slots: (m) => (parseDay(m[3]) ? { title: `${m[1]} ${m[2]}`, kind: m[2], date: m[3] } : null),
  },
  { intent: "dates.add", re: /^(?:remind me|remember|note|save)(?: that)? (.+?) is (?:on )?(.+)$/, slots: (m) => (parseDay(m[2]) ? { title: m[1], kind: "event", date: m[2] } : null) },
  { intent: "dates.upcoming", re: /^(?:what'?s|what is) coming up$|^(?:any )?(?:birthdays|anniversaries|important dates)(?: coming up| soon| this month)?$|^(?:what are |when are )?(?:my |the )?(?:next |upcoming )(?:birthdays|anniversaries|important dates|dates)$/ },
  {
    intent: "timeoff.next",
    re: /^when(?:'?s| is) my next (?:break|day off|days off|leave|vacation|long weekend|holiday)$|^when do i (?:get|have) (?:a |my next )?(?:break|day off)$/,
  },
  {
    intent: "timeoff.used",
    re: /^how many (?:leave |vacation |pto |)days(?: off)? (?:have i|did i|i'?ve) (?:used|taken|take|use|had)(?: so far)?(?: this year)?$|^how much (?:leave|pto|vacation)(?: time)? (?:have i|did i|i'?ve) (?:used|taken|take|use)(?: so far)?(?: this year)?$/,
  },
  {
    intent: "myday.weather",
    re: /^(?:what'?s|how'?s|what is|how is) the weather(?: like)?(?: (today|tomorrow|now|outside|right now))?$|^weather(?: (today|tomorrow))?$|^(?:is it|will it) (?:going to |gonna )?rain(?: (today|tomorrow))?$|^(?:how hot is it|what'?s the temperature|what is the temperature)(?: (today|tomorrow|now|outside))?$/,
    slots: (m) => ({ when: m.slice(1).includes("tomorrow") ? "tomorrow" : "today", rain: /rain/.test(m[0]) }),
  },
  {
    intent: "myday.holiday",
    re: /^is (today|tomorrow) a (?:public |bank )?holiday$|^(?:is there a )?holiday (today|tomorrow)$|^(?:when'?s|when is|what'?s|what is) the next (?:public )?holiday$|^(?:any )?holidays? (?:coming up|soon)$/,
    slots: (m) => ({ day: m[1] || m[2] || "next" }),
  },
  // Wais, your money planner: read-only.
  { intent: "wais.safe", re: /^how much (?:can i|am i able to|is safe to) spend(?: (?:until|till|before) (?:payday|pay day))?$|^(?:what'?s|what is) (?:my )?safe to spend$|^safe to spend$/ },
  { intent: "wais.tasks", re: /^(?:what|which|any) bills (?:are )?(?:due|left|to pay)(?: today| this week| soon)?$|^(?:what|which) bills do i (?:have|need) to pay(?: today| this week)?$|^any (?:late|overdue) bills$/ },
  {
    intent: "dates.when",
    re: /^when(?:'?s| is) (?:the |my |our )?(.+)$|^how (?:many days|long) (?:until|till|to) (?:the |my |our )?(.+)$/,
    slots: (m, k) => { const what = m[1] || m[2]; return findDates(what, k.dates).length || /\b(birthday|anniversary)\b/.test(what) ? { what } : null; },
  },
];

/** Places Felix can open, by how you might name them. */
const PLACES = [
  { re: /^(the )?(home|home page|dashboard|start page)$/, route: "/", name: "home" },
  { re: /^(my )?prs? (with )?conflicts?$|^conflicts$/, route: "/prs/mine?status=conflict", name: "your PRs with conflicts" },
  { re: /^(my )?(prs? with )?failing( checks| prs?)?$/, route: "/prs/mine?status=failing", name: "your PRs with failing checks" },
  { re: /^(my )?prs? (that are )?ready to merge$/, route: "/prs/mine?status=ready-merge", name: "your PRs ready to merge" },
  { re: /^(the )?(prs? )?(waiting on me|waiting on my review|to review|for review|that need my review)$|^(my )?reviews?$/, route: "/prs/review", name: "the PRs waiting on your review" },
  { re: /^(my )?(open )?prs?( page)?$|^open prs$/, route: "/prs/mine", name: "your PRs" },
  { re: /^(the )?releases?( page| tab)?$/, route: "/prs/releases", name: "the releases" },
  { re: /^music settings$/, route: "/settings#music", name: "the music settings" },
  { re: /^(the )?settings( page)?$/, route: "/settings", name: "Settings" },
];

const PR_REF = /^(fm|bm) ?#? ?(\d{1,6})$/;

/** The PRs page's filters by how you'd say them; some only exist on one tab. */
const PR_FILTERS = [
  { re: /\bfail(ing|ed)?\b|\bbroken\b/, id: "failing", label: "with failing checks" },
  { re: /\bconflicts?\b|\bconflicting\b/, id: "conflict", label: "with conflicts" },
  { re: /\bready to merge\b|\bmergeable\b/, id: "ready-merge", label: "ready to merge", only: "mine" },
  { re: /\bin (the )?merge queue\b|\bqueued\b/, id: "in-queue", label: "in the merge queue", only: "mine" },
  { re: /\bapproved\b/, id: "approved", label: "that are approved" },
  { re: /\bchanges requested\b|\brequested changes\b/, id: "changes", label: "with changes requested" },
  { re: /\bdrafts?\b/, id: "draft", label: "that are drafts" },
  { re: /\b(checks )?running( checks)?\b|\bpending checks\b/, id: "running", label: "with checks running" },
  { re: /\bnew commits\b/, id: "new-commits", label: "with new commits", only: "review" },
  { re: /\bneed(s|ing)? (a )?review\b|\bunreviewed\b/, id: "needs", label: "that need a review" },
];
/** Words that mean the PRs waiting on your review, not your own. */
const REVIEW_TAB = /\b(waiting (on|for) (me|my review)|to review|for (my )?review|need(s)? my review|review requests?|i('m| am) reviewing)\b/;
/** A PR's panel tabs by how you'd say them. */
const PANELS = [
  { re: /^(files?|changes|diff|code)$/, id: "files", label: "files" },
  { re: /^(checks?|ci|builds?)$/, id: "checks", label: "checks" },
  { re: /^commits?$/, id: "commits", label: "commits" },
  { re: /^(conversation|comments?|discussion)$/, id: "conversation", label: "conversation" },
  { re: /^(ai review|ai|claude|cursor|review)$/, id: "claude", label: "AI review" },
];
const PANEL_WORDS = "files?|changes|diff|code|checks?|ci|builds?|commits?|conversation|comments?|discussion|ai review|ai|claude|cursor|review";
const PR_PANEL = new RegExp(`^(?:the )?(${PANEL_WORDS})(?: tab)? (?:of|for|on|in) (fm|bm) ?#? ?(\\d{1,6})$|^(fm|bm) ?#? ?(\\d{1,6})(?:'s)?(?: pr)?(?:'s)? (${PANEL_WORDS})(?: tab)?$`);

/**
 * The cards on Home you can go to by name, and the mode each is in. "Tasks" alone is the Tasks card of the mode
 * you're in.
 */
const CARDS = [
  { re: /^(my )?work (tasks?|to-?dos?)$/, card: "tasks", name: "your work tasks" },
  { re: /^(my )?personal (tasks?|to-?dos?)$/, card: "ptasks", name: "your personal tasks" },
  { re: /^(my |the )?(tasks?|to-?dos?|to-?do list)( card)?$/, card: "here-tasks", name: "your tasks" },
  { re: /^(my |the )?habits?( card)?$/, card: "habits", name: "your habits" },
  { re: /^(my |the )?lists?( card)?$/, card: "lists", name: "your lists" },
  { re: /^(my |the )?journal( card)?$/, card: "journal", name: "your journal" },
  { re: /^(the )?my day( card)?$/, card: "myday", name: "My day" },
  { re: /^(my |the )?(important dates|dates|birthdays|countdowns)( card)?$/, card: "dates", name: "your important dates" },
  { re: /^(my |the )?(time off|leaves?|leave)( card)?$/, card: "timeoff", name: "your time off" },
  { re: /^(the )?wais( card)?$|^(my |the )?(money|budget|safe to spend|outlook)( card)?$/, card: "bills", name: "Wais" },
  { re: /^(the )?felix card$|^(my |the )?check-?ins?$/, card: "buddy", name: "your check-ins" },
  { re: /^(the )?(on-?call|incident commander|ic)( card)?$/, card: "ic", name: "on-call" },
  { re: /^(my |the )?(jira( board)?|sprint|tickets)( card)?$/, card: "jira", name: "your Jira board" },
  // "Show my meetings" is a question Felix answers with your meetings; "open my calendar" goes to the card.
  { re: /^(my |the )?(calendar|meetings)( card)?$/, card: "cal", name: "your calendar", notShown: true },
  { re: /^(the )?(team )?(out of office|who'?s out|ooo)( card)?$/, card: "ooo", name: "who's out" },
  { re: /^(my |the )?slack( card)?$/, card: "slack", name: "your Slack" },
  { re: /^(my |the )?ai usage( card)?$/, card: "ai", name: "AI usage" },
];

/**
 * A list of PRs with filters, from words like "PRs waiting on me with failing checks": the tab and its filters. Plain
 * ones ("my PRs") are left to PLACES.
 * @param {string} name
 * @returns {{ route: string, name: string } | null}
 */
function prListFor(name) {
  if (!/\bprs?\b|\bpull requests?\b/.test(name)) return null;
  const tab = REVIEW_TAB.test(name) ? "review" : "mine";
  const picked = PR_FILTERS.filter((f) => f.re.test(name) && (!f.only || f.only === tab));
  if (!picked.length) return null;
  const whose = tab === "review" ? "the PRs waiting on your review" : "your PRs";
  const labels = picked.map((f) => f.label);
  return { route: `/prs/${tab}?status=${picked.map((f) => f.id).join(",")}`, name: `${whose} ${labels.length > 1 ? `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}` : labels[0]}` };
}

/**
 * A PR with one of its tabs open, from words like "fm#12247's files" or "the checks of bm 7001".
 * @param {string} name
 * @returns {{ route: string, name: string } | null}
 */
function prPanelFor(name) {
  const m = PR_PANEL.exec(name);
  if (!m) return null;
  const [word, repo, number] = m[1] ? [m[1], m[2], m[3]] : [m[6], m[4], m[5]];
  const panel = PANELS.find((p) => p.re.test(word));
  return panel ? { route: `/prs/mine?pr=${repo}-${number}&panel=${panel.id}`, name: `${repo}#${number}'s ${panel.label}` } : null;
}

/**
 * A card on Home, from its name: Home scrolls to it and points it out, switching mode first when it's on the other
 * side.
 * @param {string} name
 * @param {string} [verb] How you asked: "show" + a question-like card (your meetings) is left for Felix to answer.
 * @returns {{ route: string, name: string } | null}
 */
function cardFor(name, verb = "open") {
  const c = CARDS.find((x) => x.re.test(name) && !(x.notShown && /^show/.test(verb)));
  return c ? { route: `/?card=${c.card}`, name: c.name } : null;
}

/** Slack's link that opens a channel by its name, in the app or on the web. */
const SLACK_TEAM = "TRA9H4H8D";
const SLACK_CHANNEL = /^(?:the )?#([a-z0-9][a-z0-9._-]*)(?: channel)?(?: (?:in|on) slack)?$|^(?:the )?([a-z0-9][a-z0-9 ._-]*?) channel(?: (?:in|on) slack)?$/;

/**
 * A place outside Felix, from its name: a Slack channel ("#incident-response", "the incident response channel"), an
 * on-call schedule in Datadog ("the Datadog schedule" is yours, the Philippines one; "the Americas schedule"), or
 * Datadog's On-Call.
 * @param {string} name
 * @returns {{ url: string, name: string } | null}
 */
export function linkFor(name) {
  const ch = SLACK_CHANNEL.exec(name);
  if (ch) {
    const channel = (ch[1] || ch[2]).trim().replace(/\s+/g, "-");
    return { url: `https://slack.com/app_redirect?team=${SLACK_TEAM}&channel=${encodeURIComponent(channel)}`, name: `#${channel} in Slack` };
  }
  if (/\b(schedules?|rotation|rota)\b/.test(name) && /\b(datadog|on-?call|ic|incident commanders?)\b|\b(americas|us|pure|philippines|ph|kastl)\b/.test(name)) {
    const which = /\b(americas|us|pure)\b/.test(name) ? SCHEDULES.find((s) => s.key === "americas") : SCHEDULES.find((s) => s.key === "ph");
    return { url: `https://${DATADOG_SITE}/on-call/schedules/${which.id}`, name: `the ${which.name} on-call schedule in Datadog` };
  }
  if (/^(the )?datadog( on-?call)?$|^(the )?on-?call (page )?in datadog$/.test(name)) return { url: `https://${DATADOG_SITE}/on-call`, name: "Datadog On-Call" };
  return null;
}
const RSVP = { accept: "accepted", "say yes to": "accepted", decline: "declined", "say no to": "declined", "say maybe to": "tentative", maybe: "tentative", "tentatively accept": "tentative" };
const MUSIC = { play: "play", resume: "play", pause: "pause", stop: "pause", next: "next", skip: "next", previous: "previous", last: "previous", back: "previous" };
/** Words that say "it" rather than name something to play, left for the AI. */
const NOT_A_NAME = /^(it|that|this|them|something else|it again|that again)$/;
/** Shuffle, repeat, playing something by name and searching Spotify, by the ways you might say them. */
const MUSIC_SAYINGS = [
  {
    intent: "music.shuffle",
    re: /^((turn|switch) )?shuffle (on|off)$|^turn (on|off) shuffle$|^shuffle( (the )?(music|songs|playlist|this|it))?$|^(start|stop) shuffling$|^(no more|don'?t|do not) shuffle$|^unshuffle$|^play in order$/,
    slots: (m) => ({ on: !/\b(off|stop|no more|don'?t|do not|unshuffle|in order)\b/.test(m[0]) }),
  },
  {
    intent: "music.repeat",
    re: /^repeat (this|the) (song|track)$|^repeat one$|^(put )?(this|the) (song|track) on repeat$|^loop (this|the) (song|track)$/,
    slots: () => ({ mode: "track" }),
  },
  {
    intent: "music.repeat",
    re: /^((turn )?repeat off|turn off repeat|stop repeating|(don'?t|do not) repeat|no repeat)$/,
    slots: () => ({ mode: "off" }),
  },
  {
    intent: "music.repeat",
    re: /^((turn )?repeat on|turn on repeat|repeat (the |this )?(playlist|album|all)|loop (the |this )?(playlist|album))$/,
    slots: () => ({ mode: "context" }),
  },
  { intent: "music.play", re: /^play (my |the )?(.+?) playlist$/, slots: (m) => ({ query: m[2], kind: "playlist" }) },
  { intent: "music.play", re: /^play (the )?(song|track) (.+)$/, slots: (m) => ({ query: m[3], kind: "track" }) },
  { intent: "music.play", re: /^play (.+?) by (.+)$/, slots: (m) => ({ query: `${m[1]} ${m[2]}`, kind: "track" }) },
  { intent: "music.play", re: /^play (.+)$/, slots: (m) => (NOT_A_NAME.test(m[1]) ? null : { query: m[1], kind: "any" }) },
  {
    intent: "music.search",
    re: /^search (spotify|music) for (.+)$|^(search|look) (for |up )?(.+) on spotify$|^(search for|find|look up) (the )?(song|track|album|artist|playlist) (.+)$/,
    slots: (m) => ({ query: m[2] || m[5] || m[9] }),
  },
];
const SETTING_NAMES = { "auto refresh": "autoRefresh", autorefresh: "autoRefresh", "fit to screen": "fitToScreen" };
const BREAK = "(a |my |the )?(quick |short |coffee |lunch )?break";
/** The work day's steps (shift.mjs), by the ways you might say them. A bare "back" stays the music's. */
const SHIFT_SAYINGS = [
  ["start", /^(start|begin) (my|the) (work ?)?(day|shift)$|^start work(ing)?$|^clock(ing)? in$|^i'?m clocking in$|^let'?s (start|begin) (my|the) (work ?)?day$/],
  ["break", new RegExp(`^(take|taking|start|starting) ${BREAK}$|^i'?m (taking|going on|on) ${BREAK}$|^going on ${BREAK}$|^break time$|^brb$|^be right back$`)],
  ["back", new RegExp(`^i'?m back( from ${BREAK})?$|^i am back$|^back from ${BREAK}$|^(resume|resuming) (my |the )?(shift|day|work)$|^end (my |the )?break$|^break'?s over$|^(i'?m )?back to work$`)],
  ["end", /^(end|finish) (my|the) (work ?)?(day|shift)$|^clock(ing)? out$|^i'?m (done|finished) for (the day|today)$|^(i'?m )?(heading|signing|logging) (out|off)( for (the day|today))?$|^(sign|log) off( for (the day|today))?$|^(let'?s )?call it a day$/],
  ["post", /^(yes,? )?(post it|post that|send it|go ahead and post( it)?|post (it )?(to|in) slack)$/],
  ["skip", /^(no,? )?(don'?t|do not) (post|send)( it| that)?$|^skip (the )?post(ing)?$/],
  ["status", /^how long (have i (been working|worked)|has my (day|shift) been)( today)?$|^how much (time|of my day|of my shift) is left( today)?$|^when (does|is) my (day|shift) (end|over)$|^when can i (log off|stop|go home|sign off)$/],
];

/**
 * The commands, in the order they're tried. `slots` reads the parts a match picked out.
 * @type {Array<{ intent: string, re: RegExp, slots?: (m: RegExpMatchArray, k: import("./felix-personal.mjs").Known) => (Record<string, string | boolean> | null) }>}
 */
const COMMANDS = [
  { intent: "greeting", re: /^(hi|hello|hey|yo|good (morning|afternoon|evening))$/ },
  { intent: "thanks", re: /^(thanks|thank you|ty|cheers|nice|great|awesome)( a lot| so much)?$/ },
  { intent: "help", re: /^(help|what can you do|what do you do|what can i ask( you)?)$/ },
  // The time and the date are answered right here: no sources, no AI.
  {
    intent: "clock",
    re: /^(what'?s|what is) the (time|date|day)( (now|today|right now))?$|^what time is it( now| right now)?$|^(do you have|got) the time$|^(the )?time$|^(what'?s|what is) (today'?s date|the date today|today)$|^what day is (it|today)( today)?$|^what'?s the date$/,
    slots: (m) => ({ what: /time/.test(m[0]) ? "time" : "date" }),
  },
  { intent: "sources", re: /^(where did you get (that|this)( from)?|what'?s your source|what is your source|source|sources)$/ },
  { intent: "oncall.next", re: /^(who'?s|who is) (on call |on-call )?(next|up next|taking over)|^who takes over|^who'?s on (call |on-call )?(tonight|tomorrow)$/ },
  { intent: "oncall.now", re: /^(who'?s|who is) (on call|on-call|the ic|the incident commander|ic)( (now|right now|today))?$/ },
  { intent: "oncall.mine", re: /^when'?s? (is )?my (next )?(shift|on ?call|on-call|ic shift)$|^when am i (next )?on call$/ },
  { intent: "prs.review", re: /^(how many|what|which|any) prs? (do i have to review|to review|need my review|needs my review|need me|are waiting (on|for) (me|my review)|waiting (on|for) (me|my review))$|^what'?s waiting on (me|my review)$/ },
  { intent: "prs.failing", re: /^(what'?s|what is|which|any)( of my prs?)? (failing|broken)( on my prs?)?$|^(any |which )?failing checks( on my prs?)?$/ },
  { intent: "prs.mine", re: /^(how many prs do i have( open)?|how are my prs( doing)?|my prs status|status of my prs)$/ },
  { intent: "usage", re: /^(how much )?(ai|claude|cursor) usage( left| is left)?$|^how much (claude|ai|usage) (is )?(left|used)$|^(my )?usage$/ },
  { intent: "music.now", re: /^(what'?s|what is) (playing|this song|the song)( now)?$|^what song is (this|playing)$/ },
  {
    intent: "music.control",
    re: /^(play|resume|pause|stop|next|skip|previous|last|back)( (the )?(music|song|track))?$|^(next|previous|last) (song|track)$|^go back a (song|track)$/,
    slots: (m) => ({ action: MUSIC[m[1] || m[5] || "back"] }),
  },
  { intent: "music.control", re: /^play (some )?(music|something|anything)$/, slots: () => ({ action: "play" }) },
  ...MUSIC_SAYINGS,
  {
    intent: "settings.toggle",
    re: /^turn (on|off) (auto ?refresh|fit to screen)$|^turn (auto ?refresh|fit to screen) (on|off)$/,
    slots: (m) => ({ key: SETTING_NAMES[(m[2] || m[3]).replace(/^auto ?refresh$/, "auto refresh")], on: (m[1] || m[4]) === "on" }),
  },
  { intent: "mode", re: /^(switch to |go to |open )(the )?(work ?space|workspace)$/, slots: () => ({ mode: "work" }) },
  { intent: "mode", re: /^work ?space$/, slots: () => ({ mode: "work" }) },
  { intent: "mode", re: /^(switch to |go to )?(work|personal)( mode)?$/, slots: (m) => (m[1] || m[3] ? { mode: m[2] } : null) },
  { intent: "merge", re: /^merge (fm|bm) ?#? ?(\d{1,6})$/, slots: (m) => ({ repo: m[1], number: m[2] }) },
  { intent: "merge.which", re: /^merge my (pr|pull request)$/ },
  { intent: "review", re: /^review (fm|bm) ?#? ?(\d{1,6})( with (claude|cursor))?$/, slots: (m) => ({ repo: m[1], number: m[2], tool: m[4] || "claude" }) },
  { intent: "review.which", re: /^review (a|my next) (pr|pull request)( with (claude|cursor))?$/, slots: (m) => ({ tool: m[4] || "claude" }) },
  ...SHIFT_SAYINGS.map(([action, re]) => ({ intent: "shift", re, slots: () => ({ action }) })),
  { intent: "undo.apply", re: /^(undo|revert|roll ?back) (the |your |my |that )?(last )?(apply|applied change|change to( felix)?|change you applied)$|^(undo|revert|roll ?back) (the |your |my )?last change( to( felix)?)?$|^put felix back$/ },
  // What Felix remembers (felix-notes.mjs): what he knows, off the record, forgetting, and pausing learning.
  { intent: "memory.about", re: /^what (do you know|do you remember|have you learned|have you learnt) about me$|^what do you remember$/ },
  { intent: "memory.offrecord", re: /^(this is |let'?s go |keep this |we'?re )?off the record$/ },
  { intent: "memory.onrecord", re: /^(back )?on the record$|^(you can )?remember (again|this again)$/ },
  { intent: "memory.forgetlast", re: /^forget (that|it|what i just said|what i said|i said that)$|^don'?t remember that$/ },
  { intent: "memory.forget", re: /^forget (about |that i told you about |what i told you about )?(?!that$|it$)(.+)$/, slots: (m) => ({ what: m[2] }) },
  { intent: "memory.pause", re: /^(pause|stop) (learning|remembering|your memory)( things)?$|^stop remembering things$/, slots: () => ({ on: false }) },
  { intent: "memory.resume", re: /^(resume|start|restart) (learning|remembering)( things)?( again)?$|^(turn on|unpause) (learning|your memory)$/, slots: () => ({ on: true }) },
  // Tasks (tasks.mjs): add one in plain words ("add a task: review fm#123 tomorrow 3pm !high"), hear what's due, or
  // tick one off. The task's words are taken from what you typed, so they keep your capitals.
  {
    intent: "tasks.add",
    re: /^(?:add|create|make|new|put)(?: a| an| new| another)*( work| personal)? (?:task|to-?do|todo|reminder)(?: for (work|personal|me|myself))?(?: (?:to|on) my (?:task list|tasks|to-?do list|list))?[:,]? (?:to )?(.+)$/,
    slots: (m) => ({ scope: (m[1] || m[2] || "").trim(), text: m[3] }),
  },
  { intent: "tasks.add", re: /^(?:add|put) (.+?) (?:to|on|in) my( work| personal)? (?:task list|tasks|to-?do list|to-?dos|todo list|list)$/, slots: (m) => ({ scope: (m[2] || "").trim(), text: m[1] }) },
  { intent: "tasks.add", re: /^remind me to (.+)$/, slots: (m) => ({ scope: "", text: m[1] }) },
  {
    intent: "tasks.list",
    re: /^(?:what|which|any|show(?: me)?|list)? ?(?:are |is )?(?:my |the )?(?:open )?(?:tasks|to-?dos|task list|to-?do list)(?: are| do i have)?(?: due)?(?: for)?(?: (today|tomorrow|overdue|this week|upcoming|coming up))?$|^what'?s on my (?:task list|tasks|to-?do list|to-?dos|todo list|list)(?: for)?(?: (today|tomorrow))?$|^what (?:tasks|to-?dos) (?:are |do i have )?(?:due )?(today|tomorrow|overdue|this week|coming up)$|^what do i (?:have|need) to do(?: (today|tomorrow))?$|^(?:what'?s|anything) (overdue)$|^(?:any|show(?: me)?(?: my)?) (overdue|upcoming) (?:tasks|to-?dos)$|^what is on my (?:task list|tasks|to-?do list|to-?dos|list)(?: for)?(?: (today|tomorrow))?$/,
    slots: (m) => ({ when: m.slice(1).find(Boolean) || "today" }),
  },
  // Personal cards first, so "done with reading" ticks your habit before it looks for a task by that name.
  ...PERSONAL,
  {
    intent: "tasks.done",
    re: /^(?:mark|tick|check)(?: off)? (.+?)(?: as)? (?:done|complete|completed|finished)$|^(?:tick|check) off (.+)$|^(?:i'?m )?done with (.+)$|^(?:i )?(?:finished|completed) (.+)$/,
    slots: (m) => ({ text: m.slice(1).find(Boolean) }),
  },
  // "Wrap up my day" and "brief me" go to Felix's AI, with every connected source (felix.mjs routes them).
  // Undo the last thing Felix did here; "that's wrong" saves the last answer to his test set.
  { intent: "undo", re: /^(undo|undo (that|it|the last thing|what you just did)|take (that|it) back|revert that)$/ },
  { intent: "wrong", re: /^(that'?s|that is|this is|it'?s) (wrong|not right|incorrect|not true)$|^wrong( answer)?$|^(you'?re|you are) wrong$|^bad answer$/ },
  // Watchers: "tell me when CI passes on fm#123", list them, cancel them.
  { intent: "watch.list", re: /^(what are you watching( for)?|what('?re| are) you (keeping an eye on|waiting for)|(list|show)( me)? (my |the )?watchers|my watchers)$/ },
  { intent: "watch.cancel", re: /^(?:stop watching|cancel (?:the |my )?(?:watchers?|watch(?:ing)?)(?: on| for)?|stop (?:the |my )?watchers?(?: on| for)?)(?: (.+))?$/, slots: (m) => ({ what: m[1] || "" }) },
  { intent: "watch.cancel", re: /^(?:cancel|stop|clear) all (?:my |the )?watch(?:ers|es|ing)$/, slots: () => ({ what: "all" }) },
  { intent: "watch.add", re: /^(?:tell me|let me know|ping me|notify me|alert me|remind me) (?:when|if|once|as soon as) (.+)$/, slots: (m) => ({ what: m[1] }) },
  // Fix a PR's failing checks with the AI, which asks first, like the PR page's Fix button.
  { intent: "fix", re: /^fix (?:the |my )?(?:failing )?(?:checks|ci|tests|build|lint)(?: (?:on|for|in) (.+))?$/, slots: (m) => ({ what: m[1] || "my pr" }) },
  { intent: "fix", re: /^fix ((?:fm|bm) ?#? ?\d{1,6})$/, slots: (m) => ({ what: m[1] }) },
  // The calendar, Jira and who's out, answered from the cards' data. Answering an invite always asks first.
  { intent: "calendar.next", re: /^(what'?s|what is|when'?s|when is) my next (meeting|call|event)$|^(my )?next meeting$/ },
  {
    intent: "calendar.free",
    re: /^am i (free|busy|available|in a meeting) (?:(today|tomorrow) )?(?:at|around) (\d{1,2})(?::(\d{2}))? ?(am|pm|a\.m\.|p\.m\.)?(?: (today|tomorrow))?$/,
    slots: (m) => ({ day: m[2] || m[6] || "today", hour: m[3], minute: m[4] || "00", half: (m[5] || "").replace(/\./g, "") }),
  },
  {
    intent: "calendar.day",
    re: /^(?:what'?s|what is) (?:on )?my (?:calendar|schedule|agenda)(?: for)?(?: (today|tomorrow))?$|^(?:what|any) meetings(?: do i have)?(?: (today|tomorrow))?$|^what meetings do i have(?: (today|tomorrow))?$/,
    slots: (m) => ({ day: m[1] || m[2] || m[3] || "today" }),
  },
  { intent: "jira.mine", re: /^(what'?s|what is) on my plate$|^(what are )?my (jira )?tickets$|^what am i working on$|^what'?s on my (jira )?board$/ },
  {
    intent: "ooo.who",
    re: /^(?:who'?s|who is|is anyone|anyone) (?:out|off|on leave|away|on vacation)(?: of (?:the )?office)?(?: (today|tomorrow|this week|next week))?$/,
    slots: (m) => ({ when: m[1] || "today" }),
  },
  {
    intent: "calendar.rsvp",
    re: /^(accept|decline|say yes to|say no to|say maybe to|maybe|tentatively accept) (?:the |my )?(.+?(?:meeting|invite|invitation|call|event|standup|sync|1:1|one))(?: and (?:say|tell them|add a note|note)(?: that)? (.+))?$/,
    slots: (m) => ({ response: RSVP[m[1]], what: m[2], note: m[3] || "" }),
  },
  { intent: "link", re: /^(open|show( me)?|go to|take me to|bring up|jump to) (.+)$/, slots: (m) => linkFor(m[3]) },
  // Moving cards around isn't built yet: Felix says so and opens the layout settings there are.
  { intent: "layout", re: /^(edit|change|customi[sz]e|rearrange|personali[sz]e|arrange) (the |my )?(layout|cards|home( page)?|dashboard)$/ },
  { intent: "navigate", re: /^(open|show( me)?|go to|take me to|bring up|jump to) (.+)$/, slots: (m) => placeFor(m[3], m[1]) },
];

/**
 * Where a place name leads: a Felix page (with the PRs page's filters or a PR's tab), a PR, or a card on Home.
 * @param {string} name
 * @param {string} [verb] How you asked ("open", "show me").
 * @returns {{ route: string, name: string } | null}
 */
export function placeFor(name, verb = "open") {
  const filtered = prListFor(name) || prPanelFor(name);
  if (filtered) return filtered;
  const pr = PR_REF.exec(name);
  if (pr) return { route: `/prs/mine?pr=${pr[1]}-${pr[2]}`, name: `${pr[1]}#${pr[2]}` };
  const place = PLACES.find((p) => p.re.test(name));
  return place ? { route: place.route, name: place.name } : cardFor(name, verb);
}

/**
 * Text made safe to match as it is inside a pattern.
 * @param {string} text
 * @returns {string}
 */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * What you said, ready to match: lowercase, plain quotes, no "hey Felix" (or your own activation phrase) or
 * "please", and no closing punctuation.
 * @param {string} text
 * @param {string} [name] What you call Felix.
 * @param {string} [wake] Your activation phrase, like "hey felix".
 * @returns {string}
 */
export function normalize(text, name = "felix", wake = "") {
  const who = literal(name.toLowerCase().trim() || "felix");
  const call = new RegExp(`^(hey |ok |okay |hi )?${who}[,!.]?\\s+|[,\\s]+${who}[.!?]*$`, "g");
  const phrase = literal(wake.toLowerCase().replace(/\s+/g, " ").replace(/[,!.?]+$/, "").trim());
  const said = String(text).toLowerCase().replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  return (phrase ? said.replace(new RegExp(`^${phrase}[,!.]?\\s+`), "") : said)
    .replace(call, "").replace(/^(can|could|would) you (please )?/, "").replace(/^please /, "")
    .replace(/,? please$/, "").replace(/[?.!]+$/, "").trim();
}

/**
 * The local command for what you said, if there is one.
 * @param {string} text
 * @param {string} [name]
 * @param {string} [wake]
 * @param {import("./felix-personal.mjs").Known} [known] Your lists, items, habits and dates, for the Personal commands.
 * @returns {{ intent: string, slots: Record<string, string | boolean> } | null}
 */
export function matchCommand(text, name, wake, known = NOTHING_KNOWN) {
  const said = normalize(text, name, wake);
  for (const c of COMMANDS) {
    const m = said.match(c.re);
    if (!m) continue;
    const slots = c.slots ? c.slots(m, known) : {};
    if (slots) return { intent: c.intent, slots };
  }
  return null;
}
