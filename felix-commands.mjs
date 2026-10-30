/**
 * Felix's local commands: the common things you ask or say, matched on this Mac with no AI, so they cost nothing
 * and answer fast. Anything that doesn't match goes to the AI. Each command names an intent and the parts it
 * picked out of what you said (its slots).
 */

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
 * @type {Array<{ intent: string, re: RegExp, slots?: (m: RegExpMatchArray) => (Record<string, string | boolean> | null) }>}
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
  { intent: "navigate", re: /^(open|show( me)?|go to|take me to|bring up) (.+)$/, slots: (m) => placeFor(m[3]) },
];

/**
 * Where a place name leads: a Felix page, or a PR in the Open PRs page.
 * @param {string} name
 * @returns {{ route: string, name: string } | null}
 */
export function placeFor(name) {
  const pr = PR_REF.exec(name);
  if (pr) return { route: `/prs/mine?pr=${pr[1]}-${pr[2]}`, name: `${pr[1]}#${pr[2]}` };
  const place = PLACES.find((p) => p.re.test(name));
  return place ? { route: place.route, name: place.name } : null;
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
 * @returns {{ intent: string, slots: Record<string, string | boolean> } | null}
 */
export function matchCommand(text, name, wake) {
  const said = normalize(text, name, wake);
  for (const c of COMMANDS) {
    const m = said.match(c.re);
    if (!m) continue;
    const slots = c.slots ? c.slots(m) : {};
    if (slots) return { intent: c.intent, slots };
  }
  return null;
}
