/**
 * Felix's answers to the local commands, written from the data just read, with no AI. The common answers have
 * three or more wordings that take turns, so Felix doesn't sound like a recording.
 */
import { relText, timeText } from "./felix-facts.mjs";
import { dayOf } from "./felix-notes.mjs";
import { shiftReply } from "./shift.mjs";
import { addDays, ymd } from "./tasks.mjs";
import { findDates, findItems, nextYearFor, parseDay, splitItems } from "./felix-personal.mjs";

const PR_LINKS = { fm: "https://github.com/purepm/frontend-monorepo/pull/", bm: "https://github.com/purepm/backend-monorepo/pull/" };
const LIST_MAX = 3;
const TITLE_MAX = 60;
const SETTING_LABELS = { autoRefresh: "Auto refresh", fitToScreen: "Fit to screen" };
const MUSIC_SAID = {
  play: ["Playing.", "Here we go.", "Music's on."],
  pause: ["Paused.", "Pausing the music.", "Music's paused."],
  next: ["Skipping ahead.", "Next song.", "On to the next one."],
  previous: ["Going back a song.", "Back one song.", "Playing the last song again."],
};
const SHUFFLE_SAID = { true: ["Shuffle's on.", "Shuffling.", "Mixing it up."], false: ["Shuffle's off.", "Back in order.", "No more shuffle."] };
const REPEAT_SAID = {
  track: ["Repeating this song.", "This song's on repeat.", "Looping this one."],
  context: ["Repeat's on.", "Repeating the playlist.", "On repeat."],
  off: ["Repeat's off.", "No more repeat.", "Turned repeat off."],
};

/**
 * @typedef {import("./felix-facts.mjs").Fact} Fact
 * @typedef {{ id: string, action: "merge" | "review" | "undo-apply" | "forget" | "rsvp" | "learn-phrase" | "fix", url?: string, ref?: string, tool?: string,
 *   ids?: string[], eventId?: string, response?: string, note?: string, phrase?: string, command?: string, label: string }} Confirm
 * @typedef {{ text: string, facts?: Fact[], navigate?: string, link?: { url: string, name: string }, settings?: Record<string, unknown>,
 *   music?: string | { action: string, on?: boolean, mode?: string, query?: string, kind?: string }, confirm?: Omit<Confirm, "id">,
 *   changes?: import("./felix-workbench.mjs").Change[], remembered?: string[], tasks?: boolean, personal?: boolean,
 *   undo?: { label: string, task?: { remove?: string, reopen?: string, removeNext?: string | null } } }} Reply `changes` are the
 *   workbench's, waiting for Apply; `remembered` names the memory cards the AI saved; `undo` says how to take back what a
 *   command just did here.
 * @typedef {{ read: (name: string, arg?: object) => Promise<Fact>, say: (key: string, wordings: string[]) => string,
 *   lastFacts: () => Fact[], timeZone?: string, lastApply?: () => Promise<import("./felix-guard.mjs").ApplyStatus | null>,
 *   now?: () => number, quiet?: boolean, notes?: import("./felix-notes.mjs").Notes, learner?: ReturnType<typeof import("./felix-notes.mjs").createLearner>,
 *   personal?: ReturnType<typeof import("./felix-personal.mjs").createPersonalFelix> }} AnswerContext `personal` reaches your Personal cards.
 *   `lastApply` is the last change Felix applied to himself; `notes` and `learner` are what he's learned from you;
 *   `quiet` is set in quiet hours (or with friend mode off), when he doesn't bring personal things up on his own.
 */

/**
 * Picks one wording, never the one used last time for the same answer.
 * @param {() => number} [random]
 * @returns {(key: string, wordings: string[]) => string}
 */
export function createSay(random = Math.random) {
  const last = new Map();
  return (key, wordings) => {
    const choices = wordings.length > 1 ? wordings.filter((w) => w !== last.get(key)) : wordings;
    const pick = choices[Math.floor(random() * choices.length)] || choices[0];
    last.set(key, pick);
    return pick;
  };
}

/**
 * A day and time put the way you'd say it after "until" or "at": "10 PM today", "8 AM tomorrow", "Mon, Nov 2 at 8 AM".
 * @param {string} when As the records write it: "today at 10 PM".
 * @returns {string}
 */
export function spoken(when) {
  const m = /^(today|tomorrow|yesterday) at (.+)$/.exec(when);
  return m ? `${m[2]} ${m[1]}` : when;
}

/**
 * A list read out: "a", "a and b", "a, b and c".
 * @param {string[]} items
 * @returns {string}
 */
export function listText(items) {
  return items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/**
 * A count with its noun: "1 PR", "3 PRs".
 * @param {number} n
 * @param {string} noun
 * @returns {string}
 */
export const plural = (n, noun) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/**
 * A long title cut short at a word, so it reads like a person shortened it: "Add the bulk portal invite…".
 * @param {string} title
 * @param {number} [max]
 * @returns {string}
 */
export function shortTitle(title, max = TITLE_MAX) {
  const text = String(title || "").trim();
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > max / 2 ? cut.slice(0, word) : cut).replace(/[\s,;:.-]+$/, "")}…`;
}

/**
 * A PR named briefly: its number and the start of its title.
 * @param {{ ref: string, title?: string }} pr
 * @returns {string}
 */
const prName = (pr) => `${pr.ref} (${shortTitle(pr.title)})`;

/**
 * A short list to choose from: "a or b", "a, b or c", or the first few "and 2 more".
 * @param {string[]} items
 * @returns {string}
 */
const orList = (items) => {
  const named = items.slice(0, LIST_MAX);
  const more = items.length > LIST_MAX ? `, or one of ${items.length - LIST_MAX} more` : "";
  return `${named.length < 2 ? named.join("") : `${named.slice(0, -1).join(", ")} or ${named.at(-1)}`}${more}`;
};

/**
 * The first few PRs of a list, and how many more there are.
 * @param {Array<{ ref: string, title?: string }>} prs
 * @returns {string}
 */
const someOf = (prs) => {
  const named = prs.slice(0, LIST_MAX).map(prName);
  return prs.length > LIST_MAX ? `${named.join(", ")}, and ${prs.length - LIST_MAX} more` : listText(named);
};

/**
 * What to say when a source couldn't be read.
 * @param {AnswerContext} ctx
 * @param {Fact} fact
 * @param {string} what What it would have told you.
 * @returns {Reply}
 */
const unreadable = (ctx, fact, what) => ({
  text: `${ctx.say("unreadable", [
    `Hmm, I couldn't reach ${fact.source} just now, so I can't tell you ${what}.`,
    `${fact.source} isn't answering right now, so I can't say ${what}.`,
    `I tried ${fact.source}, but it didn't come through, so I can't tell you ${what} yet.`,
  ])} (${fact.error})`,
  facts: [fact],
});

/**
 * Names the schedule when there's more than one: " on the Philippines schedule".
 * @param {Array<{ schedule: string }>} schedules
 * @param {{ schedule: string }} s
 * @returns {string}
 */
const scheduleName = (schedules, s) => (schedules.length > 1 ? ` on the ${s.schedule} schedule` : "");

/**
 * Who's on call now, on each schedule.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function oncallNow(ctx) {
  const fact = await ctx.read("oncall");
  if (fact.error) return unreadable(ctx, fact, "who's on call");
  const { schedules } = fact.record;
  const lines = schedules.map((s) => {
    const shift = s.shifts.find((sh) => sh.onNow);
    const on = scheduleName(schedules, s);
    if (!shift) return ctx.say("oncall.nobody", [`Nobody's on call${on} right now.`, `No one's covering${on} right now.`, `The${on ? "" : " on-call"} slot${on} is empty right now.`]);
    const until = spoken(shift.until);
    if (shift.mine) {
      return ctx.say("oncall.you", [`You're on call${on} until ${until}. Hang in there!`, `It's you${on}, until ${until}.`, `You've got it${on} until ${until}.`]);
    }
    return ctx.say("oncall.now", [
      `${shift.who} is on call${on} until ${until}.`,
      `It's ${shift.who}${on}, until ${until}.`,
      `${shift.who} has it${on} until ${until}.`,
    ]);
  });
  return { text: lines.join(" ") || "Datadog doesn't show any on-call schedules.", facts: [fact] };
}

/**
 * Who's on call next, on each schedule.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function oncallNext(ctx) {
  const fact = await ctx.read("oncall");
  if (fact.error) return unreadable(ctx, fact, "who's on call next");
  const { schedules } = fact.record;
  const lines = schedules.map((s) => {
    const shift = s.shifts.find((sh) => !sh.onNow && new Date(sh.start).getTime() > Date.parse(fact.fetchedAt));
    const on = scheduleName(schedules, s);
    if (!shift) return `Nobody's lined up after the current shift${on}.`;
    const who = shift.mine ? "You" : shift.who;
    return ctx.say("oncall.next", [
      `${who} take${shift.mine ? "" : "s"} over${on} at ${spoken(shift.from)}.`,
      `Next up${on} is ${shift.mine ? "you" : shift.who}, from ${spoken(shift.from)}.`,
      `${shift.mine ? "You're" : `${shift.who}'s`} up next${on}, starting ${spoken(shift.from)}.`,
    ]);
  });
  return { text: lines.join(" ") || "Datadog doesn't show any on-call schedules.", facts: [fact] };
}

/**
 * When your next on-call shift is.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function oncallMine(ctx) {
  const fact = await ctx.read("oncall");
  if (fact.error) return unreadable(ctx, fact, "when your next shift is");
  const shift = fact.record.yourNextShift;
  if (!shift) return { text: "I don't see a shift coming up for you in Datadog. Enjoy!", facts: [fact] };
  if (shift.onNow) return { text: `You're on call right now, until ${spoken(shift.until)}.`, facts: [fact] };
  return {
    text: ctx.say("oncall.mine", [
      `Your next shift starts ${spoken(shift.from)}, ${shift.startsIn}.`,
      `You're up next ${spoken(shift.from)}, ${shift.startsIn}.`,
      `You're on again ${spoken(shift.from)}, ${shift.startsIn}.`,
    ]),
    facts: [fact],
  };
}

/**
 * The PRs waiting on your review.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function prsReview(ctx) {
  const fact = await ctx.read("prs");
  if (fact.error) return unreadable(ctx, fact, "what's waiting on your review");
  const waiting = fact.record.waitingOnYourReview;
  if (!waiting.length) return { text: ctx.say("prs.none", ["Nothing's waiting on your review. Nice!", "You're all caught up on reviews.", "No reviews waiting on you right now."]), facts: [fact] };
  const count = plural(waiting.length, "PR");
  return {
    text: ctx.say("prs.review", [
      `Yep, ${count} waiting on your review: ${someOf(waiting)}.`,
      `You've got ${count} to review: ${someOf(waiting)}.`,
      `${count} ${waiting.length === 1 ? "needs" : "need"} your review: ${someOf(waiting)}.`,
    ]),
    facts: [fact],
  };
}

/**
 * Your PRs with failing checks.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function prsFailing(ctx) {
  const fact = await ctx.read("prs");
  if (fact.error) return unreadable(ctx, fact, "which checks are failing");
  const failing = fact.record.yourPrs.filter((p) => p.checks === "failing");
  if (!failing.length) return { text: ctx.say("prs.green", ["Nothing's failing on your PRs. Nice!", "All your PRs' checks look good.", "No failing checks on your PRs."]), facts: [fact] };
  const each = failing.slice(0, LIST_MAX).map((p) => `${p.ref} is failing ${listText(p.failingChecks.slice(0, LIST_MAX)) || "a check"}`);
  const more = failing.length > LIST_MAX ? ` ${plural(failing.length - LIST_MAX, "more PR")} too.` : "";
  const lead = ctx.say("prs.failing", ["Heads up, ", "Quick heads up: ", "Hmm, "]);
  return { text: `${lead}${each.join(". ")}.${more}`, facts: [fact] };
}

/**
 * How your own PRs are doing.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function prsMine(ctx) {
  const fact = await ctx.read("prs");
  if (fact.error) return unreadable(ctx, fact, "how your PRs are doing");
  const c = fact.record.counts;
  if (!c.yourPrs) {
    return { text: ctx.say("prs.mine.none", ["You don't have any open PRs right now.", "No open PRs of yours right now.", "Nothing of yours is open right now."]), facts: [fact] };
  }
  const parts = [
    c.yourPrsReadyToMerge && `${c.yourPrsReadyToMerge} ready to merge`,
    c.yourPrsFailingChecks && `${c.yourPrsFailingChecks} with failing checks`,
    c.yourPrsWithConflicts && `${c.yourPrsWithConflicts} with conflicts`,
  ].filter(Boolean);
  const detail = parts.length ? ` ${listText(parts).replace(/^./, (ch) => ch.toUpperCase())}.` : "";
  const count = plural(c.yourPrs, "open PR");
  return { text: `${ctx.say("prs.mine", [`You have ${count}.`, `You've got ${count}.`, `${count.replace(/^./, (ch) => ch.toUpperCase())} of yours.`])}${detail}`, facts: [fact] };
}

/**
 * How much AI usage is left.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function usage(ctx) {
  const fact = await ctx.read("usage");
  if (fact.error) return unreadable(ctx, fact, "your AI usage");
  const lines = fact.record.tools.map((t) => {
    if (t.error) return `I couldn't read ${t.tool}'s usage.`;
    // Said the way people say it: a whole percent, not "18.4384%".
    const limits = t.limits.map((l) => `${Math.round(Number(l.percentUsed))}% of the ${l.limit} limit${l.resets ? ` (resets ${spoken(l.resets)})` : ""}`);
    return limits.length ? `${t.tool} has used ${listText(limits)}.` : `${t.tool} doesn't show any limits.`;
  });
  return { text: lines.join(" ") || "I don't have any AI tools to check.", facts: [fact] };
}

/**
 * What's playing.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function musicNow(ctx) {
  const fact = await ctx.read("music");
  if (fact.error) return unreadable(ctx, fact, "what's playing");
  const m = fact.record;
  if (!m.playing || !m.song) return { text: "Nothing's playing right now. Want some music? Pick a playlist in the bar, or say \"play\".", facts: [fact] };
  const by = m.artists ? ` by ${m.artists}` : "";
  return { text: ctx.say("music.now", [`${m.song}${by}.`, `It's ${m.song}${by}.`, `That's ${m.song}${by}.`]), facts: [fact] };
}

/**
 * Where the last answer's facts came from.
 * @param {AnswerContext} ctx
 * @returns {Reply}
 */
function sources(ctx) {
  const facts = ctx.lastFacts();
  if (!facts.length) return { text: "That one didn't need anything looked up." };
  const each = facts.map((f) => (f.error ? `${f.source}, which didn't answer` : `${f.source}, read at ${timeText(f.fetchedAt, ctx.timeZone)}`));
  return { text: ctx.say("sources", [`That came from ${listText(each)}.`, `I got that from ${listText(each)}.`, `That's from ${listText(each)}.`]), facts };
}

/**
 * Asks before merging one of your PRs.
 * @param {AnswerContext} ctx
 * @param {{ repo: string, number: string }} slots
 * @returns {Promise<Reply>}
 */
async function merge(ctx, { repo, number }) {
  const ref = `${repo}#${number}`;
  const fact = await ctx.read("prs");
  if (fact.error) return unreadable(ctx, fact, `whether ${ref} can merge`);
  const pr = fact.record.yourPrs.find((p) => p.ref === ref);
  if (!pr) return { text: `I can only merge your own open PRs, and ${ref} isn't one of them.`, facts: [fact] };
  if (pr.inMergeQueue) return { text: `${ref} is already in the merge queue.`, facts: [fact] };
  if (!pr.readyToMerge) return { text: `${ref} isn't ready to merge yet. GitHub doesn't show it as clean.`, facts: [fact] };
  return { text: `Merge ${prName(pr)}?`, facts: [fact], confirm: { action: "merge", url: pr.url, ref, label: "Merge" } };
}

/**
 * Asks before starting an AI review of a PR.
 * @param {AnswerContext} ctx
 * @param {{ repo: string, number: string, tool: string }} slots
 * @returns {Reply}
 */
function review(ctx, { repo, number, tool }) {
  const ref = `${repo}#${number}`;
  const by = tool === "cursor" ? "Cursor" : "Claude";
  return {
    text: `Start a ${by} review of ${ref}? It runs in the background, and you'll find it in the PR's details.`,
    confirm: { action: "review", url: `${PR_LINKS[repo]}${number}`, ref, tool, label: "Start review" },
  };
}

/**
 * Asks which PR to merge when you didn't say: your PRs that are ready, or all your open ones when none are. With
 * only one to choose from, it goes straight to asking before merging that one.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function mergeWhich(ctx) {
  const fact = await ctx.read("prs");
  if (fact.error) return unreadable(ctx, fact, "which of your PRs can merge");
  const open = fact.record.yourPrs.filter((p) => !p.draft);
  const ready = open.filter((p) => p.readyToMerge && !p.inMergeQueue);
  const choices = ready.length ? ready : open;
  if (!choices.length) return { text: "You don't have an open PR to merge right now.", facts: [fact] };
  if (choices.length === 1) {
    const [repo, number] = choices[0].ref.split("#");
    return merge(ctx, { repo, number });
  }
  const which = orList(choices.map(prName));
  return { text: ctx.say("merge.which", [`Which one? ${which}.`, `Which PR, ${which}?`, `Sure, which one: ${which}?`]), facts: [fact] };
}

/**
 * Asks which PR to review when you didn't say: the ones waiting on your review. With only one, it asks before
 * starting the review of that one.
 * @param {AnswerContext} ctx
 * @param {{ tool: string }} slots
 * @returns {Promise<Reply>}
 */
async function reviewWhich(ctx, { tool }) {
  const fact = await ctx.read("prs");
  if (fact.error) return unreadable(ctx, fact, "which PRs are waiting on your review");
  const waiting = fact.record.waitingOnYourReview;
  if (!waiting.length) return { text: "Nothing's waiting on your review. Which PR did you mean? Say it like \"review fm#123\".", facts: [fact] };
  if (waiting.length === 1) {
    const [repo, number] = waiting[0].ref.split("#");
    return { ...review(ctx, { repo, number, tool }), facts: [fact] };
  }
  return { text: ctx.say("review.which", [`Which one? ${orList(waiting.map(prName))}.`, `Which PR, ${orList(waiting.map(prName))}?`]), facts: [fact] };
}

/**
 * Asks before undoing the last change Felix applied to himself, saying which and when; or says there's none.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function undoApply(ctx) {
  const last = await ctx.lastApply?.();
  if (!last || !["ok", "restarting", "broken"].includes(last.state)) {
    const why = last?.state === "rolled-back" ? " My last one was already put back, since Felix didn't come back healthy with it." : "";
    return { text: `There's no change of mine to undo.${why}` };
  }
  const files = last.files || [];
  const when = last.at ? `, from ${relText(last.at, (ctx.now || Date.now)())}` : "";
  const which = files.length === 1 ? `my change to ${files[0]}` : `my last change (${plural(files.length, "file")})`;
  return { text: `Undo ${which}${when}? Felix restarts after.`, confirm: { action: "undo-apply", label: "Undo it" } };
}

/**
 * The time or the date, from the Mac's clock in your time zone.
 * @param {{ now?: () => number, timeZone?: string }} ctx
 * @param {{ what?: "time" | "date" }} slots
 * @returns {{ text: string }}
 */
function timeNow(ctx, { what = "time" } = {}) {
  const at = (ctx.now || Date.now)();
  const day = new Intl.DateTimeFormat("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: ctx.timeZone }).format(at);
  if (what === "date") return { text: `It's ${day}.` };
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: ctx.timeZone }).format(at);
  return { text: `It's ${timeText(at, ctx.timeZone)} on ${weekday}.` };
}

/**
 * A greeting, with a follow-up on a dated thing you told Felix about once it has passed ("How did the interview
 * go?"), asked once.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function greeting(ctx) {
  const hello = ctx.say("greeting", ["Hey! What can I do for you?", "Hi! Ask me anything about your day.", "Hey there. What's up?", "Hey! What's on your mind?", "Hi there. How can I help?"]);
  // In quiet hours, or with friend mode off, the follow-up waits.
  const [due] = (!ctx.quiet && (await ctx.notes?.dueFollowUps())) || [];
  if (!due) return { text: hello };
  await ctx.notes.asked(due.id);
  return { text: `${hello.replace(/ (What|Ask|How)[^.!?]*[.!?]$/, "")} ${due.followUp}`.trim() };
}

/**
 * Reads back what Felix remembers about you, with the day you told him each thing. No AI: it's the notes as saved.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function memoryAbout(ctx) {
  const notes = ctx.notes ? await ctx.notes.live() : [];
  if (!notes.length) return { text: "I don't have anything saved about you yet. I learn from what you tell me, a little while after we talk." };
  const picked = [...notes].sort((a, b) => b.importance - a.importance || Date.parse(b.saidAt) - Date.parse(a.saidAt)).slice(0, LIST_MAX + 2);
  const items = picked.map((n) => `${n.text.replace(/[.!]+$/, "").replace(/^You\b/, "you")} (${dayOf(n.saidAt, ctx.timeZone)})`);
  const more = notes.length > picked.length ? ` That's ${notes.length} things in all.` : "";
  return { text: `Here's what I remember: ${items.join("; ")}.${more} You can see, change or delete them under Memory in Settings.` };
}

/**
 * Asks before forgetting the notes about something, naming each one.
 * @param {AnswerContext} ctx
 * @param {{ what: string }} slots
 * @returns {Promise<Reply>}
 */
async function memoryForget(ctx, { what }) {
  const found = ctx.notes ? await ctx.notes.search(what, LIST_MAX) : [];
  if (!found.length) return { text: `I don't have anything saved about "${what}".` };
  const list = found.map((n) => n.text.replace(/[.!]+$/, "")).join("; ");
  return {
    text: `Forget ${found.length === 1 ? "this" : `these ${found.length}`}: ${list}?`,
    confirm: { action: "forget", ids: found.map((n) => n.id), label: "Forget" },
  };
}

/**
 * Forgets the last thing you said, or what Felix just noted from it.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function memoryForgetLast(ctx) {
  const done = ctx.learner ? await ctx.learner.forgetLast() : { dropped: false, removed: [] };
  if (done.dropped) return { text: ctx.say("memory.forgot", ["Okay, I won't remember that.", "Got it, that's forgotten.", "Done, I won't keep that."]) };
  if (done.removed.length) return { text: `Forgot it: ${done.removed.map((n) => n.text.replace(/[.!]+$/, "")).join("; ")}.` };
  return { text: "There's nothing I've just noted to forget. Say what it's about, like \"forget my interview\"." };
}


// ---------- Personal cards ----------
// Lists, habits, the journal, important dates, time off and My day, by voice and chat. Short replies, made to be
// spoken. Anything that changes a card says personal: true, so the open cards load again.

const NO_PERSONAL = { text: "Your Personal cards aren't set up here." };
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** The first letter in capitals: "eggs" is "Eggs". @param {string} t */
const capFirst = (t) => (t ? t.charAt(0).toUpperCase() + t.slice(1) : t);
/** An item as it goes on a list: your words, with a capital first letter when you said it all in small letters. */
const itemWords = (t) => (t === t.toLowerCase() ? capFirst(t) : t);
/** "today", "tomorrow" or "in 5 days". @param {number} n */
const whenSaid = (n) => (n <= 0 ? "today" : n === 1 ? "tomorrow" : `in ${n} days`);
/** "Tuesday, Nov 3" from YYYY-MM-DD. @param {string} day */
const daySaid = (day) => new Date(`${day}T12:00:00`).toLocaleDateString("en-US", { weekday: "long", month: "short", day: "numeric" });
/** "November 3" from a month and day. */
const monthDaySaid = (month, day) => `${MONTH_NAMES[month - 1]} ${day}`;
/** "October 31 to November 2", or one day. */
const rangeSaid = (from, to) => (from === to ? daySaid(from) : `${monthDaySaid(Number(from.slice(5, 7)), Number(from.slice(8)))} to ${monthDaySaid(Number(to.slice(5, 7)), Number(to.slice(8)))}`);

/**
 * 1st, 2nd, 3rd, 11th, 21st.
 * @param {number} n
 * @returns {string}
 */
export function ordinal(n) {
  const v = n % 100;
  return `${n}${v >= 11 && v <= 13 ? "th" : ["th", "st", "nd", "rd"][n % 10] || "th"}`;
}

/**
 * Adds what you said to a list you named: "add eggs and milk to groceries".
 * @param {AnswerContext & { personal?: any, said?: string }} ctx
 * @param {{ list: string, items: string }} slots
 * @returns {Reply & { personal?: boolean }}
 */
function listsAdd(ctx, { list, items }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const l = p.listNamed(list);
  if (!l) return { text: `You don't have a ${list} list.` };
  const things = splitItems(inOwnWords(ctx.said, items)).map(itemWords);
  if (!things.length) return { text: `What should I add to ${l.name}?` };
  const names = p.addItems(l.id, things.join("\n")).map((i) => i.text.toLowerCase());
  const are = names.length === 1 ? "is" : "are";
  return {
    text: ctx.say("lists.add", [`Added ${listText(names)} to ${l.name}.`, `${capFirst(listText(names))} ${are} on ${l.name} now.`, `Got it: ${listText(names)} on ${l.name}.`]),
    personal: true,
  };
}

/**
 * The open items you named, each found once, or what to ask when one could be on two lists.
 * @param {any} p
 * @param {string} items
 * @param {string} list
 * @returns {{ found?: Array<{ id: string, text: string, list: string }>, ask?: string, missing?: string }}
 */
function itemsMeant(p, items, list, { ticked = false } = {}) {
  const open = p.known().items.filter((i) => ticked || !i.done);
  const found = [];
  for (const thing of splitItems(items)) {
    const hits = findItems(thing, open, list || null);
    if (!hits.length) return { missing: thing };
    if (hits.length > 1) return { ask: `Which ${thing}? ${orList(hits.map((h) => `${h.text} on ${h.list}`))}.` };
    found.push(hits[0]);
  }
  return { found };
}

/**
 * Ticks items off: "got the eggs", "tick off sunscreen on packing".
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ items: string, list: string }} slots
 * @returns {Reply & { personal?: boolean }}
 */
function listsTick(ctx, { items, list }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const m = itemsMeant(p, items, list);
  if (m.ask) return { text: m.ask };
  if (m.missing) return { text: `I couldn't find ${m.missing} on ${list || "your lists"}.` };
  for (const i of m.found) p.tickItem(i.id);
  const names = listText(m.found.map((i) => i.text.toLowerCase()));
  const where = [...new Set(m.found.map((i) => i.list))];
  return { text: ctx.say("lists.tick", [`Ticked off ${names}.`, `Crossed ${names} off ${listText(where)}.`, `Nice, ${names} done.`]), personal: true };
}

/**
 * Takes items off a list: "remove milk from groceries".
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ items: string, list: string }} slots
 * @returns {Reply & { personal?: boolean }}
 */
function listsRemove(ctx, { items, list }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const m = itemsMeant(p, items, list, { ticked: true });
  if (m.ask) return { text: m.ask };
  if (m.missing) return { text: `I couldn't find ${m.missing} on ${list}.` };
  for (const i of m.found) p.removeItem(i.id);
  return { text: `Took ${listText(m.found.map((i) => i.text.toLowerCase()))} off ${list}.`, personal: true };
}

/**
 * What's left on a list.
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ list: string }} slots
 * @returns {Reply}
 */
function listsShow(ctx, { list }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const l = p.listNamed(list);
  if (!l) return { text: `You don't have a ${list} list.` };
  const all = p.items(l.id);
  const open = all.filter((i) => !i.done).map((i) => i.text.toLowerCase());
  if (!all.length) return { text: `Nothing on ${l.name} yet.` };
  if (!open.length) return { text: `Everything on ${l.name} is ticked off.` };
  const named = open.length > 6 ? `${open.slice(0, 6).join(", ")} and ${open.length - 6} more` : listText(open);
  return { text: `${l.name} has ${plural(open.length, "thing")} left: ${named}.` };
}

/**
 * Ticks a habit for today: "I drank water", "done with reading". Asks which when you could mean more than one.
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ ids: string }} slots
 * @returns {Reply & { personal?: boolean }}
 */
function habitsCheck(ctx, { ids }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const board = p.habits().habits;
  const meant = String(ids).split(",").map((id) => board.find((h) => h.id === id)).filter(Boolean);
  if (!meant.length) return { text: "I couldn't find that habit." };
  if (meant.length > 1) return { text: `Which one? ${orList(meant.map((h) => h.name))}.` };
  const [was] = meant;
  const streakNote = (h) => (h.streak > 1 ? `, a ${h.streak}-day streak` : "");
  if (was.today.done) return { text: `${was.name} is already done today${streakNote(was)}.` };
  const h = p.checkHabit(was.id);
  if (!h.today.done) return { text: `${h.name}: ${h.today.count} of ${h.today.goal} today.`, personal: true };
  return { text: ctx.say("habits.check", [`Nice! ${h.name} is done for today${streakNote(h)}.`, `${h.name}, done${streakNote(h)}.`, `Ticked ${h.name} for today${streakNote(h)}.`]), personal: true };
}

/**
 * How today's habits are going.
 * @param {AnswerContext & { personal?: any }} ctx
 * @returns {Reply}
 */
function habitsStatus(ctx) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const list = p.habits().habits;
  if (!list.length) return { text: "You don't have any habits yet. Add one on the Habits card." };
  const done = list.filter((h) => h.today.done).map((h) => h.name.toLowerCase());
  const left = list.filter((h) => !h.today.done).map((h) => h.name.toLowerCase());
  if (!left.length) return { text: `All ${list.length} done today. Nice work!` };
  if (!done.length) return { text: `None done yet today. Still to go: ${listText(left)}.` };
  return { text: `${done.length} of ${list.length} done today: ${listText(done)}. Still to go: ${listText(left)}.` };
}

/**
 * A habit's streak: "what's my reading streak".
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ what: string, ids: string }} slots
 * @returns {Reply}
 */
function habitsStreak(ctx, { what, ids }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const board = p.habits().habits;
  const meant = String(ids || "").split(",").map((id) => board.find((h) => h.id === id)).filter(Boolean);
  if (!meant.length) return { text: `I don't see a habit like ${what}.` };
  if (meant.length > 1) return { text: `Which one? ${orList(meant.map((h) => h.name))}.` };
  const [h] = meant;
  if (h.streak) return { text: `Your ${h.name.toLowerCase()} streak is ${plural(h.streak, "day")}.${h.today.done ? "" : " Tick it today to keep it going."}` };
  return { text: h.best ? `No ${h.name.toLowerCase()} streak right now. Your best was ${plural(h.best, "day")}.` : `No ${h.name.toLowerCase()} streak yet. Tick it today to start one.` };
}

/**
 * Adds a line to today's journal, after what's there. The line isn't said back.
 * @param {AnswerContext & { personal?: any, said?: string }} ctx
 * @param {{ text: string }} slots
 * @returns {Reply & { personal?: boolean }}
 */
function journalAdd(ctx, { text }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const line = capFirst(inOwnWords(ctx.said, text).trim());
  if (!line) return { text: "What should I write in your journal?" };
  p.journalAppend(line);
  return { text: ctx.say("journal.add", ["Added to today's journal.", "Noted in your journal.", "It's in today's journal."]), personal: true };
}

/**
 * A date's next time in words: "today", "tomorrow", or "on Tuesday, Nov 3, in 4 days", with the age or anniversary.
 * @param {{ kind: string, title: string, next: { on: string, inDays: number, years: number | null } }} d
 * @returns {string}
 */
function dateLine(d) {
  const n = d.next.inDays;
  const when = n === 0 ? "today" : n === 1 ? "tomorrow" : `on ${daySaid(d.next.on)}, in ${n} days`;
  const years = d.next.years ? (d.kind === "birthday" ? ` Turns ${d.next.years}.` : d.kind === "anniversary" ? ` It's the ${ordinal(d.next.years)}.` : "") : "";
  return `${d.title} is ${when}.${years}`;
}

/**
 * What's coming up in the next 60 days.
 * @param {AnswerContext & { personal?: any }} ctx
 * @returns {Reply}
 */
function datesUpcoming(ctx) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const v = p.datesView({ ahead: 60, limit: 3 });
  if (!v.all.length) return { text: "You don't have any important dates yet. Say something like \"remind me Lola's birthday is November 3\"." };
  if (!v.upcoming.length) return { text: v.later ? `Nothing in the next 60 days. Next is ${v.later.title}, ${daySaid(v.later.next.on)}.` : "Nothing coming up." };
  return { text: `Coming up: ${listText(v.upcoming.map((d) => `${d.title} ${whenSaid(d.next.inDays)}`))}.` };
}

/**
 * When one date is: "when is Mama's birthday".
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ what: string }} slots
 * @returns {Reply}
 */
function datesWhen(ctx, { what }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const found = findDates(what, p.datesView({ ahead: 366, limit: 1 }).all);
  if (!found.length) return { text: `I don't have ${what} saved. Say "remind me ${what} is" and the day, and I'll keep it.` };
  if (found.length > 1) return { text: `Which one? ${orList(found.map((d) => d.title))}.` };
  const [d] = found;
  if (!d.next) return { text: `${d.title} was on ${monthDaySaid(d.month, d.day)}, ${d.year}.` };
  return { text: dateLine(d) };
}

/**
 * Saves a date you told Felix: "remind me Lola's birthday is November 3".
 * @param {AnswerContext & { personal?: any, said?: string }} ctx
 * @param {{ title: string, kind: string, date: string }} slots
 * @returns {Reply & { personal?: boolean }}
 */
function datesAdd(ctx, { title, kind, date }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const d = parseDay(date);
  if (!d) return { text: "I didn't catch the day. Try \"November 3\"." };
  const name = capFirst(inOwnWords(ctx.said, title).replace(/^the /i, "").trim());
  const today = p.today();
  const year = kind === "event" ? d.year || nextYearFor(d, today) : d.year;
  if (findDates(name, p.datesView({ ahead: 366, limit: 1 }).all).some((x) => x.title.toLowerCase() === name.toLowerCase())) {
    return { text: `You already have ${name} saved. Change it on the Important dates card.` };
  }
  try {
    const added = p.addDate({ kind, title: name, month: d.month, day: d.day, year });
    const when = added.next ? ` That's ${whenSaid(added.next.inDays)}.` : "";
    return { text: `Got it: ${added.title}, ${monthDaySaid(d.month, d.day)}.${when}`, personal: true };
  } catch (e) {
    return { text: e.code === "input" ? e.message : "I couldn't save that date." };
  }
}

/**
 * Your time off, or what's stopping Felix from reading it.
 * @param {any} p
 * @returns {Promise<{ v?: any, reply?: Reply }>}
 */
async function timeoffOf(p) {
  try {
    const v = await p.timeoff();
    if (v.needsMe) return { reply: { text: "Pick yourself on the My time off card first, so I know which leave is yours." } };
    return { v };
  } catch {
    return { reply: { text: "I can't reach the vacation tracker right now." } };
  }
}

/**
 * Your next break.
 * @param {AnswerContext & { personal?: any }} ctx
 * @returns {Promise<Reply>}
 */
async function timeoffNext(ctx) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const { v, reply } = await timeoffOf(p);
  if (reply) return reply;
  const b = v.next;
  if (!b) return { text: `No break in the next ${v.ahead >= 365 ? "year" : v.ahead >= 180 ? "6 months" : `${v.ahead} days`}.` };
  if (b.now) return { text: `You're on a break now. You're back on ${daySaid(addDays(b.to, 1))}.` };
  const why = b.holidays.length ? ` It's for ${listText(b.holidays.map((h) => h.name || "a holiday"))}.` : b.kinds.length ? ` That's your ${listText(b.kinds)}.` : "";
  return { text: `Your next break is ${rangeSaid(b.from, b.to)}, ${whenSaid(b.inDays)}: ${plural(b.days, "day")} off.${why}` };
}

/**
 * How many days off you've taken this year.
 * @param {AnswerContext & { personal?: any }} ctx
 * @returns {Promise<Reply>}
 */
async function timeoffUsed(ctx) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  const { v, reply } = await timeoffOf(p);
  if (reply) return reply;
  if (!v.year.total) return { text: "You haven't taken any leave this year yet." };
  return { text: `You've taken ${plural(v.year.total, "day")} off this year: ${listText(v.year.kinds.map((k) => `${k.days} ${k.kind}`))}.` };
}

/**
 * The weather, today or tomorrow, or whether it'll rain.
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ when: string, rain: boolean }} slots
 * @returns {Promise<Reply>}
 */
async function mydayWeather(ctx, { when, rain }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  let w;
  try { w = (await p.myday()).weather; } catch { w = null; }
  if (!w) return { text: "I can't get the weather right now." };
  const old = w.stale ? " That's from a little while ago." : "";
  if (when === "tomorrow") {
    const day = addDays(w.now.time.slice(0, 10), 1);
    const hours = w.hours.filter((h) => h.time.startsWith(day));
    if (!hours.length) return { text: "I don't have tomorrow's weather yet." };
    const temps = hours.map((h) => h.temp);
    const wet = Math.max(...hours.map((h) => h.rain || 0));
    const skies = hours.map((h) => h.sky);
    const sky = skies.sort((a, b) => skies.filter((x) => x === b).length - skies.filter((x) => x === a).length)[0].toLowerCase();
    if (rain) return { text: `${wet >= 50 ? "Likely" : wet >= 20 ? "Maybe" : "Probably not"}: up to a ${wet}% chance of rain tomorrow.${old}` };
    return { text: `Tomorrow in ${w.place}: ${Math.round(Math.min(...temps))}° to ${Math.round(Math.max(...temps))}°, mostly ${sky}${wet >= 20 ? `, up to a ${wet}% chance of rain` : ""}.${old}` };
  }
  const chance = w.today.rain;
  if (rain) {
    if (chance === null) return { text: `It's ${w.now.sky.toLowerCase()} right now. I don't have a rain chance for today.${old}` };
    return { text: `${chance >= 50 ? "Likely" : chance >= 20 ? "Maybe" : "Probably not"}: a ${chance}% chance of rain today.${old}` };
  }
  const wet = chance !== null && chance >= 20 ? `, with a ${chance}% chance of rain` : "";
  return { text: `It's ${Math.round(w.now.temp)}° and ${w.now.sky.toLowerCase()} in ${w.place}. Today's high is ${Math.round(w.today.high)}°, low ${Math.round(w.today.low)}°${wet}.${old}` };
}

/**
 * Whether today or tomorrow is a holiday, or when the next one is.
 * @param {AnswerContext & { personal?: any }} ctx
 * @param {{ day: string }} slots
 * @returns {Promise<Reply>}
 */
async function mydayHoliday(ctx, { day }) {
  const p = ctx.personal;
  if (!p) return NO_PERSONAL;
  let v;
  try { v = await p.myday(); } catch { v = null; }
  const h = v?.holidays;
  if (!h || h.error) return { text: "I can't check the holidays right now." };
  const name = (x) => x.name || "a holiday";
  // Without a name (the calendar bridge can't read the holiday calendar yet), just the day.
  const next = !h.next ? "I don't see one in the next three months."
    : h.next.name ? `The next one is ${h.next.name}, ${daySaid(h.next.day)}.` : `The next holiday is ${daySaid(h.next.day)}.`;
  if (day === "today") return { text: h.today.length ? `Yes, today is ${listText(h.today.map(name))}.` : `No, today isn't a holiday. ${next}` };
  if (day === "tomorrow") {
    const tomorrow = addDays(v.today, 1);
    return { text: h.next?.day === tomorrow ? `Yes, tomorrow is ${name(h.next)}.` : `No, tomorrow isn't a holiday. ${next}` };
  }
  return { text: h.next ? `The next holiday is ${name(h.next)}, ${daySaid(h.next.day)}, ${whenSaid(Math.round((Date.parse(`${h.next.day}T12:00:00Z`) - Date.parse(`${v.today}T12:00:00Z`)) / 86400e3))}.` : "I don't see a holiday in the next three months." };
}

/**
 * What's safe to spend, from Wais.
 * @param {AnswerContext & { wais?: { call: Function } }} ctx
 * @returns {Promise<Reply>}
 */
async function waisSafe(ctx) {
  if (!ctx.wais) return { text: "Wais isn't connected here." };
  let s;
  try { s = await ctx.wais.call("safe_to_spend", {}); } catch (e) { return { text: `I couldn't reach Wais: ${e.message}` }; }
  const span = s.period?.id === "payday" && s.payday ? `until payday on ${daySaid(s.payday)}` : `over the ${String(s.period?.label || "period").toLowerCase()}`;
  const short = s.runsShortOn ? ` Heads up: money runs short on ${daySaid(s.runsShortOn)}.` : "";
  return { text: `You can safely spend ${s.safeToSpend.formatted} ${span}.${short}` };
}

/**
 * The bills due, review and late in Wais, the ones its card names first.
 * @param {AnswerContext & { wais?: { call: Function } }} ctx
 * @returns {Promise<Reply>}
 */
async function waisTasks(ctx) {
  if (!ctx.wais) return { text: "Wais isn't connected here." };
  let t;
  try { t = await ctx.wais.call("tasks", {}); } catch (e) { return { text: `I couldn't reach Wais: ${e.message}` }; }
  if (!t.count) return { text: "No bills to pay right now." };
  const when = (i) => (i.state === "late" ? `${plural(Math.abs(i.days), "day")} late` : i.days === 0 ? "today" : `in ${plural(i.days, "day")}`);
  // A bill is money out, so Wais writes it with a minus; it's said without one ("₱287.85", not "minus ₱287.85").
  const owed = (i) => String(i.formatted || "").replace(/^[-−\u2060\s]+/u, "");
  const named = (t.items || []).filter((i) => i.onCard).slice(0, 3).map((i) => `${i.title}, ${owed(i)}, ${when(i)}`);
  const more = t.count > named.length ? ` And ${t.count - named.length} more.` : "";
  return { text: `${plural(t.count, "bill")} to see to: ${named.join("; ")}.${more}` };
}

/** Each local command's answer, by intent. */
/**
 * The words you used, in your own capitals: commands match in lower case, but a task should keep "Review PMHUB-123".
 * @param {string} said What you typed or said.
 * @param {string} lower The part a command picked out, in lower case.
 * @returns {string}
 */
export function inOwnWords(said, lower) {
  const plain = String(said || "").replace(/[’‘]/g, "'").replace(/\s+/g, " ").trim();
  const at = plain.toLowerCase().lastIndexOf(lower);
  return at >= 0 ? plain.slice(at, at + lower.length) : lower;
}

/**
 * Which list a task goes on: the one you named ("a personal task"), else the mode you're in.
 * @param {{ mode?: string }} ctx
 * @param {string} [scope]
 * @returns {"work" | "personal"}
 */
const taskScope = (ctx, scope) => (scope === "personal" || scope === "work" ? scope : ctx.mode === "personal" ? "personal" : "work");

/**
 * When a task is due, said simply: "today at 3 PM", "tomorrow", "Friday", "Nov 12".
 * @param {{ dueDate: string | null, dueTime: string | null }} t
 * @param {string} today YYYY-MM-DD
 * @returns {string}
 */
export function dueSaid(t, today) {
  if (!t.dueDate) return "";
  const at = new Date(`${t.dueDate}T${t.dueTime || "12:00"}:00`);
  const time = t.dueTime ? ` at ${at.toLocaleTimeString("en-US", { hour: "numeric", minute: at.getMinutes() ? "2-digit" : undefined })}` : "";
  if (t.dueDate < today) return `overdue since ${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}`;
  if (t.dueDate === today) return `today${time}`;
  if (t.dueDate === addDays(today, 1)) return `tomorrow${time}`;
  if (t.dueDate <= addDays(today, 6)) return `${at.toLocaleDateString("en-US", { weekday: "long" })}${time}`;
  return `${at.toLocaleDateString("en-US", { month: "short", day: "numeric" })}${time}`;
}

/**
 * Adds a task from what you said: "add a task: review fm#123 tomorrow 3pm !high #review", "remind me to call Mom".
 * @param {AnswerContext & { tasks?: any, said?: string, mode?: string }} ctx
 * @param {{ scope: string, text: string }} slots
 * @returns {{ text: string, tasks?: boolean }}
 */
function tasksAdd(ctx, { scope, text }) {
  if (!ctx.tasks) return { text: "Tasks aren't set up on this Mac yet." };
  const where = taskScope(ctx, scope);
  try {
    const task = ctx.tasks.add({ text: inOwnWords(ctx.said, text).replace(/[.!?]+$/, ""), scope: where });
    const today = ymd(ctx.now ? ctx.now() : Date.now());
    const due = dueSaid(task, today);
    const bits = [due && `for ${due}`, task.priority === 3 && "high priority", task.repeat && `repeating ${task.repeat}`].filter(Boolean);
    const detail = `${bits.length ? `, ${bits.join(", ")}` : ""}${where === "personal" && ctx.mode !== "personal" ? ", on your personal list" : ""}`;
    return {
      text: ctx.say("tasks.add", [`Added "${task.title}"${detail}.`, `Got it: "${task.title}"${detail}.`, `On your list: "${task.title}"${detail}.`]),
      tasks: true,
      undo: { label: `adding "${task.title}"`, task: { remove: task.id } },
    };
  } catch (e) {
    return { text: e.code === "input" ? e.message : "I couldn't add that task." };
  }
}

/**
 * What's on your list: due today (with anything overdue), tomorrow, coming up, or overdue.
 * @param {AnswerContext & { tasks?: any, mode?: string }} ctx
 * @param {{ when: string }} slots
 * @returns {{ text: string }}
 */
function tasksList(ctx, { when }) {
  if (!ctx.tasks) return { text: "Tasks aren't set up on this Mac yet." };
  const today = ymd(ctx.now ? ctx.now() : Date.now());
  const scope = taskScope(ctx, "");
  const view = when === "overdue" ? "overdue" : when === "today" ? "today" : "upcoming";
  let open = ctx.tasks.list({ scope, view }).tasks.filter((t) => !t.doneAt);
  if (when === "tomorrow") open = open.filter((t) => t.dueDate === addDays(today, 1));
  if (when === "this week") open = open.filter((t) => t.dueDate <= addDays(today, 6));
  const label = { today: "today", tomorrow: "tomorrow", overdue: "overdue", "this week": "this week" }[when] || "coming up";
  if (!open.length) {
    const none = when === "overdue" ? "Nothing's overdue. Nice!" : when === "today" ? "Nothing due today. Nice!" : `Nothing ${label === "coming up" ? "coming up" : `due ${label}`}.`;
    return { text: none };
  }
  const late = when === "today" ? open.filter((t) => t.dueDate && t.dueDate < today).length : 0;
  const named = open.slice(0, LIST_MAX).map((t) => `${t.title}${t.dueTime && t.dueDate === today ? ` (${dueSaid(t, today).replace(/^today at /, "")})` : ""}`);
  const more = open.length > LIST_MAX ? `, and ${open.length - LIST_MAX} more` : "";
  const head = when === "overdue" ? `${plural(open.length, "task")} overdue` : `${plural(open.length, "task")} ${label === "coming up" ? "coming up" : label === "today" ? "for today" : `due ${label}`}`;
  return { text: `${head}${late ? `, ${late} of them overdue` : ""}: ${open.length > LIST_MAX ? named.join(", ") + more : listText(named)}.` };
}

/**
 * Ticks off the open task that best matches what you said, or asks which one.
 * @param {AnswerContext & { tasks?: any, mode?: string }} ctx
 * @param {{ text: string }} slots
 * @returns {{ text: string, tasks?: boolean }}
 */
function tasksDone(ctx, { text }) {
  if (!ctx.tasks) return { text: "Tasks aren't set up on this Mac yet." };
  const want = text.toLowerCase().replace(/^(the|my) /, "").trim();
  const open = ctx.tasks.list({ scope: taskScope(ctx, ""), view: "all" }).tasks.filter((t) => !t.doneAt);
  const exact = open.filter((t) => t.title.toLowerCase() === want);
  const near = exact.length ? exact : open.filter((t) => t.title.toLowerCase().includes(want) || want.includes(t.title.toLowerCase()));
  if (!near.length) return { text: `I couldn't find an open task like "${text}".` };
  if (near.length > 1) return { text: `Which one? ${orList(near.map((t) => `"${t.title}"`))}.` };
  const { task, next } = ctx.tasks.update(near[0].id, { done: true });
  const after = next ? ` The next one is ${dueSaid(next, ymd(ctx.now ? ctx.now() : Date.now()))}.` : "";
  return {
    text: `${ctx.say("tasks.done", [`Ticked off "${task.title}".`, `Done: "${task.title}".`, `Nice, "${task.title}" is done.`])}${after}`,
    tasks: true,
    undo: { label: `ticking off "${task.title}"`, task: { reopen: task.id, removeNext: next?.id || null } },
  };
}

/**
 * Where a moment falls on the wall clock in a time zone: its day as a count of days, and minutes into that day,
 * so events and asked-about times compare the way your calendar shows them.
 * @param {string | number} at
 * @param {string} [timeZone]
 * @returns {{ day: number, minutes: number }}
 */
function wallOf(at, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone })
    .formatToParts(new Date(at)).map((p) => [p.type, p.value]));
  return { day: Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)) / 86400e3, minutes: Number(parts.hour) * 60 + Number(parts.minute) };
}

/**
 * The hour someone means by "at 3": with no AM or PM, 1 to 7 is the afternoon and 8 to 11 the morning.
 * @param {string} hour
 * @param {string} half "am", "pm" or "".
 * @returns {number} From 0 to 23.
 */
export function hourMeant(hour, half) {
  const h = Number(hour) % 12;
  if (half === "am") return h;
  if (half === "pm") return h + 12;
  return h >= 1 && h <= 7 ? h + 12 : Number(hour) === 12 ? 12 : h;
}

/**
 * A time of day the way people say it: "3 PM", "10:30 AM".
 * @param {number} minutes Minutes into the day.
 * @returns {string}
 */
const clock = (minutes) => {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h % 12 || 12}${m ? `:${String(m).padStart(2, "0")}` : ""} ${h < 12 ? "AM" : "PM"}`;
};

/**
 * The calendar's events that aren't all day, with where they start and end on the wall clock.
 * @param {Fact} fact
 * @param {string} [timeZone]
 */
const timedEvents = (fact, timeZone) => fact.record.events.filter((e) => !e.allDay).map((e) => ({ ...e, from: wallOf(e.start, timeZone), to: wallOf(e.end, timeZone) }));

/**
 * Your next meeting, and the one you're in now.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function calendarNext(ctx) {
  const fact = await ctx.read("calendar");
  if (fact.error) return unreadable(ctx, fact, "what's on your calendar");
  const events = fact.record.events.filter((e) => !e.allDay);
  const now = events.find((e) => e.onNow);
  const next = events.find((e) => !e.onNow);
  if (!now && !next) return { text: "Nothing else on your calendar for the next few days.", facts: [fact] };
  const during = now ? `You're in ${now.title} until ${now.until}. ` : "";
  const after = next ? ctx.say("calendar.next", [
    `Your next meeting is ${next.title}, ${spoken(next.when)}, ${next.startsIn}.`,
    `Next up: ${next.title}, ${spoken(next.when)}, ${next.startsIn}.`,
    `${next.title} is next, ${spoken(next.when)}, ${next.startsIn}.`,
  ]) : "Nothing after that.";
  return { text: `${during}${after}`, facts: [fact] };
}

/**
 * Whether you're free at a time today or tomorrow: what's on then, if anything. All-day events don't count.
 * @param {AnswerContext} ctx
 * @param {{ day: string, hour: string, minute: string, half: string }} slots
 * @returns {Promise<Reply>}
 */
async function calendarFree(ctx, { day, hour, minute, half }) {
  const fact = await ctx.read("calendar");
  if (fact.error) return unreadable(ctx, fact, "whether you're free");
  const today = wallOf((ctx.now || Date.now)(), ctx.timeZone).day;
  const want = { day: today + (day === "tomorrow" ? 1 : 0), minutes: hourMeant(hour, half) * 60 + Math.min(59, Number(minute)) };
  const at = want.day * 1440 + want.minutes;
  const busy = timedEvents(fact, ctx.timeZone).find((e) => e.from.day * 1440 + e.from.minutes <= at && at < e.to.day * 1440 + e.to.minutes);
  const when = `${clock(want.minutes)} ${day}`;
  if (busy) return { text: `No, you've got ${busy.title} then, ${spoken(busy.when)} until ${busy.until}.`, facts: [fact] };
  return { text: ctx.say("calendar.free", [`Yes, you're free at ${when}.`, `You're free at ${when}.`, `Nothing on your calendar at ${when}.`]), facts: [fact] };
}

/**
 * What's on your calendar today or tomorrow.
 * @param {AnswerContext} ctx
 * @param {{ day: string }} slots
 * @returns {Promise<Reply>}
 */
async function calendarDay(ctx, { day }) {
  const fact = await ctx.read("calendar");
  if (fact.error) return unreadable(ctx, fact, "what's on your calendar");
  const target = wallOf((ctx.now || Date.now)(), ctx.timeZone).day + (day === "tomorrow" ? 1 : 0);
  const on = timedEvents(fact, ctx.timeZone).filter((e) => e.from.day === target);
  if (!on.length) return { text: `Nothing on your calendar ${day}.`, facts: [fact] };
  const named = on.map((e) => `${e.title} at ${clock(e.from.minutes)}`);
  const list = named.length > LIST_MAX + 1 ? `${named.slice(0, LIST_MAX).join(", ")}, and ${named.length - LIST_MAX} more` : listText(named);
  return { text: `${on.length === 1 ? "Just one" : `${on.length} meetings`} ${day}: ${list}.`, facts: [fact] };
}

/**
 * Your open Jira tickets in the sprint, in progress first.
 * @param {AnswerContext} ctx
 * @returns {Promise<Reply>}
 */
async function jiraMine(ctx) {
  const fact = await ctx.read("jira");
  if (fact.error) return unreadable(ctx, fact, "what's on your board");
  const open = fact.record.yourOpenTickets;
  if (!open.length) return { text: "You don't have any open tickets in the sprint.", facts: [fact] };
  const named = open.slice(0, LIST_MAX).map((t) => `${t.key} (${shortTitle(t.summary, 40)}), ${t.status.toLowerCase()}`);
  const more = open.length > LIST_MAX ? `, and ${open.length - LIST_MAX} more` : "";
  return {
    text: `${ctx.say("jira.mine", [`You've got ${plural(open.length, "open ticket")}`, `${plural(open.length, "ticket")} on your plate`, `On your plate, ${plural(open.length, "ticket")}`])}: ${open.length > LIST_MAX ? named.join("; ") + more : named.join("; ")}.`,
    facts: [fact],
  };
}

/**
 * Who's out today, tomorrow, this week or next week: your team when you've picked one, else everyone, and any holiday.
 * @param {AnswerContext} ctx
 * @param {{ when: string }} slots
 * @returns {Promise<Reply>}
 */
async function oooWho(ctx, { when }) {
  const fact = await ctx.read("ooo");
  if (fact.error) return unreadable(ctx, fact, "who's out");
  const now = (ctx.now || Date.now)();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: ctx.timeZone }).format(new Date(now));
  const plus = (n) => new Date(Date.parse(`${today}T12:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const span = { today: [today, today], tomorrow: [plus(1), plus(1)], "this week": [today, plus(5 - weekday)], "next week": [plus(8 - weekday), plus(12 - weekday)] }[when] || [today, today];
  const overlaps = (r) => r.fromDay <= span[1] && r.toDay >= span[0];
  const { out, holidays, teamSize } = fact.record;
  const everyone = out.filter(overlaps);
  const people = everyone.filter((r) => !teamSize || r.onYourTeam);
  // With a team picked, people outside it are counted, so "nobody on your team" isn't mistaken for "nobody".
  const others = everyone.length - people.length;
  const outside = teamSize && others ? ` ${others === 1 ? "1 person outside your team is" : `${others} people outside your team are`} out too.` : "";
  const free = holidays.filter(overlaps).map((h) => h.name);
  const holiday = free.length ? ` ${free.length === 1 ? "There's a holiday then" : "There are holidays then"}: ${listText(free)}.` : "";
  if (!people.length) {
    const none = teamSize ? `Nobody on your team is out ${when}.` : `${ctx.say("ooo.none", ["Everyone's in", "Nobody's out", "No one's off"])} ${when}.`;
    return { text: `${none}${outside}${holiday}`, facts: [fact] };
  }
  const named = people.map((r) => `${r.who} (${r.kind}${when === "today" || r.from === r.to ? "" : `, ${r.from} to ${r.to}`})`);
  return { text: `${listText(named)} ${people.length === 1 ? "is" : "are"} out ${when}.${outside}${holiday}`, facts: [fact] };
}

/**
 * Asks before answering an invite: the next meeting, one at a time you name, or one by its title. Only when Felix
 * can answer invites (the calendar's reply bridge is set up).
 * @param {AnswerContext} ctx
 * @param {{ response: string, what: string, note: string }} slots
 * @returns {Promise<Reply>}
 */
async function calendarRsvp(ctx, { response, what, note }) {
  const fact = await ctx.read("calendar");
  if (fact.error) return unreadable(ctx, fact, "which meeting that is");
  if (!fact.record.canAnswerInvites) return { text: "I can't answer invites yet. Set up replies in the Calendar card first.", facts: [fact] };
  const events = timedEvents(fact, ctx.timeZone);
  const time = /(\d{1,2})(?::(\d{2}))? ?(am|pm)?/i.exec(what);
  const words = what.toLowerCase().replace(/\b(meeting|invite|invitation|call|event|one)\b/g, "").trim();
  const pick = /\bnext\b/.test(what) ? events.filter((e) => !e.onNow)
    : time ? events.filter((e) => e.from.minutes === hourMeant(time[1], (time[3] || "").toLowerCase()) * 60 + Number(time[2] || 0))
      : events.filter((e) => words && e.title.toLowerCase().includes(words));
  if (!pick.length) return { text: `I couldn't find "${what}" on your calendar.`, facts: [fact] };
  const event = pick[0];
  const verb = { accepted: "Accept", declined: "Decline", tentative: "Say maybe to" }[response];
  const says = note ? `, with the note "${note}"` : "";
  return {
    text: `${verb} ${event.title}, ${spoken(event.when)}${says}?`,
    facts: [fact],
    confirm: { action: "rsvp", eventId: event.id, response, note, ref: event.title, label: { accepted: "Accept", declined: "Decline", tentative: "Maybe" }[response] },
  };
}

export const ANSWERS = {
  greeting,
  "memory.about": memoryAbout,
  "memory.forget": memoryForget,
  "memory.forgetlast": memoryForgetLast,
  "memory.offrecord": (ctx) => {
    ctx.learner?.offRecord(true);
    return { text: "Okay, this is off the record. I won't remember anything you say until you say \"back on the record\", or we stop talking for a while." };
  },
  "memory.onrecord": (ctx) => {
    ctx.learner?.offRecord(false);
    return { text: "Back on the record. I'll remember what matters from here." };
  },
  "memory.pause": () => ({ text: "Okay, I'll stop learning from our talks. What I already know stays. Say \"start remembering\" to turn it back on.", settings: { felixMemoryLearn: false } }),
  "memory.resume": () => ({ text: "I'll learn from our talks again, a little while after each one.", settings: { felixMemoryLearn: true } }),
  thanks: (ctx) => ({ text: ctx.say("thanks", ["Anytime.", "You got it.", "Happy to help."]) }),
  clock: timeNow,
  help: () => ({
    text: "Ask me who's on call, when your next shift is, what's waiting on your review, what's failing, or how much AI usage is left. "
      + "I can also open pages (\"show my PRs with conflicts\"), merge or review a PR (\"merge fm#123\"), and play, pause, skip, shuffle or repeat the music, or play something by name (\"play my focus playlist\"). "
      + "Tell me tasks in plain words (\"add a task: review fm#123 tomorrow 3pm !high\"), ask what's due, or say \"mark it done\".",
  }),
  sources,
  "oncall.now": oncallNow,
  "oncall.next": oncallNext,
  "oncall.mine": oncallMine,
  "prs.review": prsReview,
  "prs.failing": prsFailing,
  "prs.mine": prsMine,
  usage,
  "music.now": musicNow,
  "music.control": (ctx, { action }) => ({ text: ctx.say(`music.${action}`, MUSIC_SAID[action]), music: action }),
  "music.shuffle": (ctx, { on = true }) => ({ text: ctx.say(`music.shuffle.${on}`, SHUFFLE_SAID[on]), music: { action: "shuffle", on } }),
  "music.repeat": (ctx, { mode = "context" }) => ({ text: ctx.say(`music.repeat.${mode}`, REPEAT_SAID[mode]), music: { action: "repeat", mode } }),
  // The page finds it on Spotify and plays it, or opens the player on a search when Spotify has nothing.
  "music.play": (ctx, { query = "", kind = "any" }) => ({
    text: ctx.say("music.play", [`Finding ${query || "that"}.`, `Looking up ${query || "that"}.`, `Let me find ${query || "that"}.`]),
    music: { action: "find", query, kind },
  }),
  "music.search": (ctx, { query = "" }) => ({
    text: ctx.say("music.search", [`Here's what Spotify has for ${query || "that"}.`, `Searching Spotify for ${query || "that"}.`, `Looking on Spotify for ${query || "that"}.`]),
    music: { action: "search", query },
  }),
  "settings.toggle": (ctx, { key, on }) => ({
    text: ctx.say("settings.toggle", [`${SETTING_LABELS[key]} is ${on ? "on" : "off"}.`, `Done, ${SETTING_LABELS[key]} is ${on ? "on" : "off"}.`, `Turned ${SETTING_LABELS[key]} ${on ? "on" : "off"}.`]),
    settings: { [key]: on },
  }),
  mode: (ctx, { mode }) => {
    const name = mode === "work" ? "Work" : "Personal";
    return { text: ctx.say("mode", [`Switched to ${name} mode.`, `Here's ${name} mode.`, `${name} mode it is.`]), settings: { mode } };
  },
  navigate: (ctx, { route, name }) => ({ text: ctx.say("navigate", [`Opening ${name}.`, `Here's ${name}.`, `Taking you to ${name}.`]), navigate: route }),
  link: (ctx, { url, name }) => ({ text: ctx.say("link", [`Opening ${name}.`, `Here's ${name}.`]), link: { url, name } }),
  // Moving cards around isn't built yet, so Felix says so plainly and opens the layout settings there are.
  layout: (ctx) => ({ text: ctx.say("layout", ["Moving cards around isn't built yet. Here are the layout settings there are: full width and Fit to screen."]), navigate: "/settings#home" }),
  merge,
  "merge.which": mergeWhich,
  review,
  "review.which": reviewWhich,
  "calendar.next": calendarNext,
  "calendar.free": calendarFree,
  "calendar.day": calendarDay,
  "calendar.rsvp": calendarRsvp,
  "jira.mine": jiraMine,
  "ooo.who": oooWho,
  "undo.apply": undoApply,
  // The work day: a step, the yes or no to its Slack post, or how it's going. Nothing posts without that yes.
  shift: (ctx, slots) => shiftReply(slots),
  "tasks.add": tasksAdd,
  "tasks.list": tasksList,
  "tasks.done": tasksDone,
  "lists.add": listsAdd,
  "lists.tick": listsTick,
  "lists.remove": listsRemove,
  "lists.show": listsShow,
  "habits.check": habitsCheck,
  "habits.status": habitsStatus,
  "habits.streak": habitsStreak,
  "journal.add": journalAdd,
  "dates.upcoming": datesUpcoming,
  "dates.when": datesWhen,
  "dates.add": datesAdd,
  "timeoff.next": timeoffNext,
  "timeoff.used": timeoffUsed,
  "myday.weather": mydayWeather,
  "myday.holiday": mydayHoliday,
  "wais.safe": waisSafe,
  "wais.tasks": waisTasks,
  notyet: (ctx, { what }) => ({ text: `"${what.replace(/^./, (ch) => ch.toUpperCase())}" isn't built yet. It comes with the Slack and calendar part of Felix.` }),
};
