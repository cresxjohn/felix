/**
 * What Felix knows, read fresh from the same sources the cards use. Each source becomes a small record: fields
 * only, never sentences, with times already written the way people say them ("today at 10 PM", "in 4 days"),
 * so Felix's answers, and the fact check on them, use the same words. A source that fails comes back as an error,
 * never as made-up data.
 */

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * Whether a value is a date and time as the sources send them.
 * @param {unknown} v
 * @returns {boolean}
 */
export const isIsoTime = (v) => typeof v === "string" && ISO.test(v);

/**
 * A time the way people say it: "10 PM", "8:30 AM".
 * @param {string | number | Date} at
 * @param {string} [timeZone]
 * @returns {string}
 */
export function timeText(at, timeZone) {
  const parts = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone }).formatToParts(new Date(at));
  const get = (type) => parts.find((p) => p.type === type)?.value;
  const minute = get("minute");
  return `${get("hour")}${minute === "00" ? "" : `:${minute}`} ${get("dayPeriod").toUpperCase()}`;
}

/**
 * The calendar day of a time, as "2026-10-29", in a time zone.
 * @param {string | number | Date} at
 * @param {string} [timeZone]
 * @returns {string}
 */
const dayKey = (at, timeZone) => new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone }).format(new Date(at));

/**
 * The day of a time the way people say it: "today", "tomorrow", "yesterday", or "Mon, Nov 2".
 * @param {string | number | Date} at
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {string}
 */
export function dayText(at, now, timeZone) {
  const day = dayKey(at, timeZone);
  const names = { [dayKey(now, timeZone)]: "today", [dayKey(now + DAY, timeZone)]: "tomorrow", [dayKey(now - DAY, timeZone)]: "yesterday" };
  return names[day] || new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone }).format(new Date(at));
}

/**
 * A day and time the way people say it: "today at 10 PM", "Mon, Nov 2 at 8 AM".
 * @param {string | number | Date} at
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {string}
 */
export const whenText = (at, now, timeZone) => `${dayText(at, now, timeZone)} at ${timeText(at, timeZone)}`;

/**
 * How far a time is from now, roughly: "in 4 days", "in 3 hours", "20 minutes ago", "just now".
 * @param {string | number | Date} at
 * @param {number} now
 * @returns {string}
 */
export function relText(at, now) {
  const ms = new Date(at).getTime() - now;
  const abs = Math.abs(ms);
  const [n, unit] = abs >= DAY ? [Math.round(abs / DAY), "day"] : abs >= HOUR ? [Math.round(abs / HOUR), "hour"] : [Math.round(abs / 60e3), "minute"];
  if (n === 0) return "just now";
  const span = `${n} ${unit}${n === 1 ? "" : "s"}`;
  return ms > 0 ? `in ${span}` : `${span} ago`;
}

/**
 * One on-call shift.
 * @param {{ start: string, end: string, user?: { name?: string }, mine?: boolean }} shift
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {object}
 */
function shiftRecord(shift, now, timeZone) {
  const start = new Date(shift.start).getTime();
  const end = new Date(shift.end).getTime();
  return {
    who: shift.user?.name || "nobody",
    mine: Boolean(shift.mine),
    onNow: start <= now && now < end,
    from: whenText(shift.start, now, timeZone),
    until: whenText(shift.end, now, timeZone),
    startsIn: relText(shift.start, now),
    start: shift.start,
    end: shift.end,
  };
}

/**
 * Who is on call, from the Incident Commander card's data.
 * @param {{ schedules?: Array<{ name: string, shifts?: object[] }>, myNext?: object & { schedule?: string } }} ic
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {object}
 */
export function oncallRecord(ic, now, timeZone) {
  return {
    schedules: (ic.schedules || []).map((s) => ({ schedule: s.name, shifts: (s.shifts || []).map((sh) => shiftRecord(sh, now, timeZone)) })),
    yourNextShift: ic.myNext ? { ...shiftRecord(ic.myNext, now, timeZone), schedule: ic.myNext.schedule } : null,
  };
}

/**
 * One PR from the Open PRs lists.
 * @param {string} repo "fm" or "bm".
 * @param {object} pr
 * @param {number} now
 * @returns {object}
 */
function prItem(repo, pr, now) {
  return {
    ref: `${repo}#${pr.number}`,
    title: pr.title,
    author: pr.author,
    url: pr.url,
    draft: Boolean(pr.isDraft),
    checks: pr.checks?.state || "none",
    failingChecks: pr.checks?.failing || [],
    conflicts: pr.mergeable === "CONFLICTING",
    readyToMerge: pr.mergeState === "CLEAN" && !pr.isDraft,
    inMergeQueue: Boolean(pr.inMergeQueue),
    reviewDecision: pr.reviewDecision,
    approvedBy: pr.approvedBy || [],
    changesRequestedBy: pr.changesRequestedBy || [],
    askedForYourReview: Boolean(pr.requested),
    updated: relText(pr.updatedAt, now),
  };
}

/**
 * My PRs and the ones waiting on my review, with the counts the Open PRs card shows.
 * @param {{ login: string, lists: { mine: Array<{ key: string, prs: object[] }>, review: Array<{ key: string, prs: object[] }> } }} data
 * @param {number} now
 * @returns {object}
 */
export function prsRecord(data, now) {
  const flat = (groups) => groups.flatMap((g) => g.prs.map((pr) => prItem(g.key, pr, now)));
  const mine = flat(data.lists.mine);
  const review = flat(data.lists.review);
  const waiting = review.filter((p) => p.askedForYourReview);
  return {
    you: data.login,
    yourPrs: mine,
    waitingOnYourReview: waiting,
    reviewedEarlier: review.filter((p) => !p.askedForYourReview),
    counts: {
      yourPrs: mine.length,
      waitingOnYourReview: waiting.length,
      yourPrsFailingChecks: mine.filter((p) => p.checks === "failing").length,
      yourPrsWithConflicts: mine.filter((p) => p.conflicts).length,
      yourPrsReadyToMerge: mine.filter((p) => p.readyToMerge).length,
    },
  };
}

/**
 * Each repo's open release PR and its last release, from the Releases tab's data.
 * @param {{ repos: object[] }} data
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {object}
 */
export function releasesRecord(data, now, timeZone) {
  return {
    repos: (data.repos || []).map((r) => ({
      repo: r.key,
      openRelease: r.open ? {
        ref: `${r.key}#${r.open.number}`, title: r.open.title, checks: r.open.checks, approved: r.open.reviewDecision === "APPROVED",
        inMergeQueue: Boolean(r.open.inMergeQueue), packages: (r.open.packages || []).length,
      } : null,
      yourPrsInIt: (r.mine || []).map((m) => `${r.key}#${m.number}`),
      lastRelease: r.last ? {
        ref: `${r.key}#${r.last.number}`, merged: whenText(r.last.mergedAt, now, timeZone),
        dev: r.last.dev?.conclusion || r.last.dev?.status || "unknown", prod: r.last.prod?.state || "unknown",
      } : null,
    })),
  };
}

/**
 * How much of each AI plan is used, from the AI usage card's data.
 * @param {{ tools: object[] }} data
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {object}
 */
export function usageRecord(data, now, timeZone) {
  return {
    tools: (data.tools || []).map((t) => ({
      tool: t.name,
      plan: t.plan || null,
      error: t.error || null,
      limits: (t.limits || []).map((l) => ({ limit: l.label, percentUsed: l.percent, resets: l.resetsAt ? whenText(l.resetsAt, now, timeZone) : null })),
      extraUsage: t.extra?.enabled && t.extra.used ? `${t.extra.used.amount} ${t.extra.used.currency}` : null,
      atALimit: t.extra?.enabled ? "keeps working, billed as extra usage" : "stops until the limit resets",
    })),
  };
}

/**
 * What Spotify is playing.
 * @param {{ playing: boolean, track: object | null, device: object | null }} now
 * @returns {object}
 */
export function musicRecord(now) {
  return { playing: Boolean(now.playing), song: now.track?.title || null, artists: now.track?.artists || null, device: now.device?.name || null };
}

/**
 * Your calendar from today on, from the Calendar card's data: each event's title, when it starts and ends the way
 * people say it, whether it's on now, and your answer to the invite. Felix can answer invites only when `canReply`.
 * @param {{ events?: Array<Record<string, any>>, canReply?: boolean }} data
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {object}
 */
export function calendarRecord(data, now, timeZone) {
  const events = (data.events || []).filter((e) => Date.parse(e.end) > now).slice(0, 25).map((e) => {
    const start = Date.parse(e.start);
    return {
      id: e.id,
      title: e.title,
      when: e.allDay ? `${dayText(start, now, timeZone)}, all day` : whenText(start, now, timeZone),
      until: e.allDay ? null : timeText(e.end, timeZone),
      startsIn: relText(start, now),
      onNow: start <= now,
      allDay: Boolean(e.allDay),
      yourAnswer: { accepted: "yes", declined: "no", tentative: "maybe", needsAction: "not answered" }[e.response] || null,
      hasJoinLink: Boolean(e.join),
      start: e.start,
      end: e.end,
    };
  });
  const next = events.find((e) => !e.allDay && !e.onNow) || null;
  return { events, nextMeeting: next ? next.title : null, canAnswerInvites: Boolean(data.canReply) };
}

/**
 * Your open Jira tickets in the sprint, from the Jira card's data: in progress, then to do, then in review.
 * @param {{ board?: { name?: string }, sprint?: { name?: string } | null, active?: Array<Record<string, any>>, done?: number, total?: number, columns?: Array<Record<string, any>> }} data
 * @returns {object}
 */
export function jiraRecord(data) {
  return {
    board: data.board?.name || null,
    sprint: data.sprint?.name || null,
    yourOpenTickets: (data.active || []).map((t) => ({ key: t.key, summary: t.summary, status: t.column, url: t.url })),
    doneInSprint: data.done ?? 0,
    totalInSprint: data.total ?? 0,
    columns: (data.columns || []).map((c) => ({ name: c.name, count: c.count })),
  };
}

/**
 * Who's out of office, from the Team out of office card's data: each leave with its kind and days, holidays apart.
 * @param {{ from?: string, to?: string, out?: Array<Record<string, any>>, teamSize?: number }} data
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {object}
 */
export function oooRecord(data, now, timeZone) {
  const day = (d) => dayText(Date.parse(`${d}T12:00:00`), now, timeZone);
  const rows = data.out || [];
  return {
    from: data.from ? day(data.from) : null,
    to: data.to ? day(data.to) : null,
    out: rows.filter((r) => !r.holiday).map((r) => ({ who: r.name, kind: r.kind, note: r.note || null, from: day(r.from), to: day(r.to), onYourTeam: Boolean(r.onTeam), fromDay: r.from, toDay: r.to })),
    // A holiday's title names where it's kept ("PH Holiday"), and its note the day itself ("All Saints' Day").
    holidays: rows.filter((r) => r.holiday).map((r) => ({ name: r.note ? `${r.note} (${r.name})` : `the ${r.name} holiday`, from: day(r.from), to: day(r.to), fromDay: r.from, toDay: r.to })),
    teamSize: data.teamSize ?? null,
  };
}

/**
 * Your work tasks due today (overdue ones too) and done today, from the Tasks card's data.
 * @param {{ today?: string, tasks?: Array<Record<string, any>> }} data
 * @returns {object}
 */
export function tasksRecord(data) {
  const tasks = data.tasks || [];
  const name = (t) => ({ title: t.title, due: t.dueDate || null, at: t.dueTime || null, overdue: Boolean(t.dueDate && data.today && t.dueDate < data.today) });
  return { today: data.today || null, open: tasks.filter((t) => !t.doneAt).map(name), doneToday: tasks.filter((t) => t.doneAt).map((t) => t.title) };
}

/**
 * Text from GitHub's HTML, with tags dropped and the common entities turned back into characters.
 * @param {string} html
 * @returns {string}
 */
export function htmlText(html = "") {
  const entities = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", nbsp: " " };
  return html.replace(/<[^>]*>/g, " ").replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (_, e) => entities[e]).replace(/\s+/g, " ").trim();
}

const LIMITS = { description: 3000, diff: 8000, files: 80, timeline: 20, comment: 600 };

/**
 * One PR in full, for "summarize fm#12247": its description, files, diff, commits and conversation, cut to size.
 * @param {string} repo
 * @param {object} d The details panel's data.
 * @returns {object}
 */
export function prDetailRecord(repo, d) {
  let diff = "";
  for (const f of d.files || []) {
    if (diff.length >= LIMITS.diff) break;
    if (f.patch) diff += `--- ${f.name}\n${f.patch}\n`;
  }
  return {
    ref: `${repo}#${d.number}`,
    title: d.title,
    author: d.author,
    state: d.draft ? "draft" : d.state,
    branch: d.head,
    reviewDecision: d.reviewDecision,
    size: { additions: d.additions, deletions: d.deletions, files: d.changedFiles, commits: d.commitCount },
    tickets: d.tickets || [],
    description: htmlText(d.bodyHtml).slice(0, LIMITS.description),
    files: (d.files || []).slice(0, LIMITS.files).map((f) => `${f.name} (+${f.additions} -${f.deletions})`),
    diff: diff.slice(0, LIMITS.diff),
    commits: (d.commits || []).map((c) => c.message),
    reviewers: (d.reviewers || []).map((r) => ({ who: r.login, state: r.state || "requested" })),
    failingChecks: (d.checks || []).filter((c) => c.outcome === "failed").map((c) => c.name),
    conversation: (d.timeline || []).slice(-LIMITS.timeline).map((t) => ({
      who: t.author, kind: t.state ? `${t.kind} ${t.state.toLowerCase()}` : t.kind, text: htmlText(t.html).slice(0, LIMITS.comment),
    })),
  };
}

const MINUTE = 60e3;

/**
 * Each source: its name on screen, where its link goes, how its data becomes a record, and how old its data may
 * be before Felix says how old it is. The on-call schedule rarely changes, so it keeps for an hour; PRs, releases
 * and usage for 5 minutes; what's playing for one.
 */
const SOURCES = {
  oncall: { source: "Datadog", oldMs: HOUR, link: (raw) => raw.schedules?.[0]?.url || null, shape: (raw, ctx) => oncallRecord(raw, ctx.now, ctx.timeZone) },
  prs: { source: "GitHub", oldMs: 5 * MINUTE, link: () => "/prs/mine", shape: (raw, ctx) => prsRecord(raw, ctx.now) },
  releases: { source: "GitHub releases", oldMs: 5 * MINUTE, link: () => "/prs/releases", shape: (raw, ctx) => releasesRecord(raw, ctx.now, ctx.timeZone) },
  usage: { source: "AI usage", oldMs: 5 * MINUTE, link: (raw) => raw.tools?.[0]?.url || null, shape: (raw, ctx) => usageRecord(raw, ctx.now, ctx.timeZone) },
  music: { source: "Spotify", oldMs: MINUTE, link: () => null, shape: (raw) => musicRecord(raw) },
  pr: { source: "GitHub", oldMs: 5 * MINUTE, link: (raw) => raw.url || null, shape: (raw, ctx) => prDetailRecord(ctx.arg.repo, raw) },
  calendar: { source: "Google Calendar", oldMs: 5 * MINUTE, link: () => "https://calendar.google.com/", shape: (raw, ctx) => calendarRecord(raw, ctx.now, ctx.timeZone) },
  jira: { source: "Jira", oldMs: 5 * MINUTE, link: (raw) => (raw.site ? `https://${raw.site}/jira/your-work` : null), shape: (raw) => jiraRecord(raw) },
  ooo: { source: "Team out of office", oldMs: HOUR, link: () => null, shape: (raw, ctx) => oooRecord(raw, ctx.now, ctx.timeZone) },
  tasks: { source: "Tasks", oldMs: MINUTE, link: () => "/", shape: (raw) => tasksRecord(raw) },
};

/** Every source Felix can read. */
export const FACT_SOURCES = Object.freeze(Object.keys(SOURCES));

/**
 * @typedef {{ name: string, source: string, fetchedAt: string, link: string | null, record?: object, error?: string, asOf?: string }} Fact
 *   `asOf` says how long ago old data was read, like "10 minutes ago"; fresh data has none.
 */

/**
 * How long ago data was read, when it's older than its source keeps fresh: "10 minutes ago". Undefined when fresh.
 * @param {string} fetchedAt
 * @param {number} oldMs
 * @param {number} now
 * @returns {string | undefined}
 */
export function ageOf(fetchedAt, oldMs, now) {
  const at = Date.parse(fetchedAt);
  return Number.isFinite(at) && now - at > oldMs ? relText(at, now) : undefined;
}

/**
 * Builds Felix's reader.
 * @param {object} deps
 * @param {Record<string, (arg?: object) => Promise<object>>} deps.readers The card data for each source, by name.
 * @param {() => number} [deps.now]
 * @param {string} [deps.timeZone] The Mac's, when left out.
 * @returns {{ read: (name: string, arg?: object) => Promise<Fact> }}
 */
export function createFacts({ readers, now = Date.now, timeZone }) {
  /**
   * Reads one source now. A failure comes back as the error, so Felix can say it couldn't read it.
   * @param {string} name
   * @param {object} [arg] What to read, for sources that need it (a PR's repo and number).
   * @returns {Promise<Fact>}
   */
  async function read(name, arg = {}) {
    const meta = SOURCES[name];
    if (!meta || !readers[name]) return { name, source: name, fetchedAt: new Date(now()).toISOString(), link: null, error: "Felix can't read that yet." };
    try {
      const raw = await readers[name](arg);
      const t = now();
      const fetchedAt = raw?.fetchedAt || new Date(t).toISOString();
      const asOf = ageOf(fetchedAt, meta.oldMs, t);
      const fact = { name, source: meta.source, fetchedAt, link: meta.link(raw || {}), record: meta.shape(raw || {}, { now: t, timeZone, arg }) };
      return asOf ? { ...fact, asOf } : fact;
    } catch (e) {
      return { name, source: meta.source, fetchedAt: new Date(now()).toISOString(), link: null, error: e.message || "It didn't answer." };
    }
  }
  return { read };
}
