const KINDS = ["PTO", "VL", "SL", "EL", "UTO", "OOO", "Offset", "Birthday", "Holiday", "WFH", "Leave", "Sick", "Out", "Off", "Traveling", "Limited"];
const KIND_ALIASES = { vacation: "VL", "vacation leave": "VL", "sick leave": "SL", "emergency leave": "EL" };
const ALL_KINDS = new Set(["all", "any", "*"]);
const ENTRY_LIMIT = 500;
const TIME_ZONE = "Asia/Manila";
const DAY_MS = 86400000;
const HALF_DAY = /\b(half|morning|afternoon|am|pm)\b/i;

/**
 * Gives back today's year in the user's time zone.
 * @returns {number}
 */
function currentYear() {
  return Number(new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric" }).format(new Date()));
}

/**
 * Turns a YYYY-MM-DD string into a UTC day number.
 * @param {string} date
 * @returns {number}
 */
function toDay(date) {
  return Math.floor(Date.parse(`${date}T00:00:00Z`) / DAY_MS);
}

/**
 * Turns a UTC day number back into YYYY-MM-DD.
 * @param {number} day
 * @returns {string}
 */
function fromDay(day) {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/**
 * Checks and settles the year to look at.
 * @param {unknown} year
 * @returns {number}
 */
function resolveYear(year) {
  if (year === undefined || year === null || year === "") return currentYear();
  const value = Number(year);
  if (!Number.isInteger(value) || value < 1970 || value > 2100) {
    throw new Error(`"${year}" isn't a year I can look up; use a year like 2027.`);
  }
  return value;
}

/**
 * Maps one kind name to the tracker's spelling.
 * @param {string} raw
 * @returns {string}
 */
function resolveKind(raw) {
  const key = String(raw).trim().toLowerCase();
  const found = KIND_ALIASES[key] ?? KINDS.find((kind) => kind.toLowerCase() === key);
  if (!found) throw new Error(`"${raw}" isn't a kind of leave in the tracker. Kinds: ${KINDS.join(", ")}, or "all".`);
  return found;
}

/**
 * Settles which kinds of leave to keep; null means every kind except holidays.
 * @param {string|string[]|undefined} kind
 * @returns {string[]|null}
 */
function resolveKinds(kind) {
  const list = (Array.isArray(kind) ? kind : [kind ?? "VL"]).filter((item) => String(item).trim() !== "");
  if (list.length === 0) return ["VL"];
  if (list.some((item) => ALL_KINDS.has(String(item).trim().toLowerCase()))) return null;
  return [...new Set(list.map(resolveKind))];
}

/**
 * Splits a year into quarters, each within the tracker's 92-day window.
 * @param {number} year
 * @returns {{from: string, to: string}[]}
 */
function quarters(year) {
  return [0, 3, 6, 9].map((month) => ({
    from: fromDay(Date.UTC(year, month, 1) / DAY_MS),
    to: fromDay(Date.UTC(year, month + 3, 1) / DAY_MS - 1),
  }));
}

/**
 * Reads one range from the tracker, halving it while the tracker hits its entry limit.
 * @param {{ooo: {out: Function}}} ctx
 * @param {string} from
 * @param {string} to
 * @returns {Promise<{out: object[], unknown: string[]}>}
 */
async function fetchRange(ctx, from, to) {
  let result;
  try {
    result = await ctx.ooo.out({ from, to });
  } catch (error) {
    throw new Error(`The vacation tracker couldn't be read for ${from} to ${to}: ${error?.message ?? error}`);
  }
  const out = Array.isArray(result?.out) ? result.out : [];
  const unknown = Array.isArray(result?.unknown) ? result.unknown : [];
  if (out.length < ENTRY_LIMIT || from === to) return { out, unknown };
  const middle = Math.floor((toDay(from) + toDay(to)) / 2);
  const [first, second] = await Promise.all([
    fetchRange(ctx, from, fromDay(middle)),
    fetchRange(ctx, fromDay(middle + 1), to),
  ]);
  return { out: [...first.out, ...second.out], unknown: [...first.unknown, ...second.unknown] };
}

/**
 * Reads the whole year from the tracker, without the repeats that cross quarter edges.
 * @param {{ooo: {out: Function}}} ctx
 * @param {number} year
 * @returns {Promise<object[]>}
 */
async function fetchYear(ctx, year) {
  const parts = await Promise.all(quarters(year).map(({ from, to }) => fetchRange(ctx, from, to)));
  const seen = new Map();
  for (const entry of parts.flatMap((part) => part.out)) {
    const key = [entry.person ?? entry.name, entry.kind, entry.from, entry.to, entry.note].join("|");
    if (!seen.has(key)) seen.set(key, entry);
  }
  return [...seen.values()];
}

/**
 * Gathers the holiday dates that leave days shouldn't count.
 * @param {object[]} entries
 * @param {string} region
 * @returns {Set<number>}
 */
function holidayDays(entries, region) {
  const wanted = String(region ?? "PH").trim().toLowerCase();
  const days = new Set();
  if (wanted === "none") return days;
  for (const entry of entries) {
    if (!isHoliday(entry)) continue;
    if (!ALL_KINDS.has(wanted) && String(entry.name).toLowerCase() !== wanted) continue;
    for (let day = toDay(entry.from); day <= toDay(entry.to); day++) days.add(day);
  }
  return days;
}

/**
 * Counts the working days of a leave that fall in the year.
 * @param {{from: string, to: string}} entry
 * @param {number} year
 * @param {Set<number>} holidays
 * @returns {number}
 */
function workingDays(entry, year, holidays) {
  const start = Math.max(toDay(entry.from), Date.UTC(year, 0, 1) / DAY_MS);
  const end = Math.min(toDay(entry.to), Date.UTC(year + 1, 0, 1) / DAY_MS - 1);
  let count = 0;
  for (let day = start; day <= end; day++) {
    const weekday = new Date(day * DAY_MS).getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !holidays.has(day)) count++;
  }
  return count;
}

/**
 * Builds a check for whether an entry belongs to the person asked about.
 * @param {string|undefined} person
 * @param {{id: string, name: string, nicknames?: string[]}[]} team
 * @returns {{matches: (entry: object) => boolean, listed: boolean}}
 */
function personMatcher(person, team) {
  const query = String(person ?? "").trim().toLowerCase();
  if (!query) return { matches: () => true, listed: false };
  const hits = (text) => String(text ?? "").toLowerCase().includes(query);
  const ids = new Set(team.filter((member) => [member.name, ...(member.nicknames ?? [])].some(hits)).map((member) => member.id));
  return { matches: (entry) => ids.has(entry.person) || hits(entry.name), listed: ids.size > 0 };
}

/**
 * Tells whether an entry is a public holiday rather than someone's leave.
 * @param {{holiday?: boolean, kind?: string}} entry
 * @returns {boolean}
 */
function isHoliday(entry) {
  return Boolean(entry.holiday) || entry.kind === "Holiday";
}

/**
 * Reads the people the user listed, or none when that list can't be read.
 * @param {{ooo: {team?: Function}}} ctx
 * @returns {Promise<object[]>}
 */
async function readTeam(ctx) {
  try {
    const team = await ctx.ooo.team?.();
    return Array.isArray(team) ? team : [];
  } catch {
    return [];
  }
}

/**
 * Splits the year's leave into the people asked about and the tracker names nobody listed.
 * @param {object[]} entries
 * @param {{matches: (entry: object) => boolean}} matcher
 * @param {boolean} teamOnly
 * @returns {{scoped: object[], unlisted: object[]}}
 */
function splitScope(entries, matcher, teamOnly) {
  const leave = entries.filter((entry) => !isHoliday(entry) && matcher.matches(entry));
  return {
    scoped: leave.filter((entry) => !teamOnly || entry.onTeam),
    unlisted: teamOnly ? leave.filter((entry) => !entry.person) : [],
  };
}

/**
 * Settles the run's options from Felix's arguments.
 * @param {object} args
 * @returns {{year: number, kinds: string[]|null, person: string|undefined, teamOnly: boolean, holidayRegion: string|undefined}}
 */
function readArgs(args = {}) {
  const person = typeof args.person === "string" && args.person.trim() ? args.person.trim() : undefined;
  return {
    year: resolveYear(args.year),
    kinds: resolveKinds(args.kind),
    person,
    teamOnly: typeof args.teamOnly === "boolean" ? args.teamOnly : !person,
    holidayRegion: args.holidayRegion,
  };
}

/**
 * Counts a leave's days, halving a one-day leave whose note marks it as part of the day.
 * @param {{from: string, to: string, note?: string}} entry
 * @param {number} year
 * @param {Set<number>} holidays
 * @returns {number}
 */
function leaveDays(entry, year, holidays) {
  const days = workingDays(entry, year, holidays);
  return days === 1 && entry.from === entry.to && HALF_DAY.test(entry.note ?? "") ? 0.5 : days;
}

/**
 * Groups leave entries by person, with dates and working days.
 * @param {object[]} entries
 * @param {{year: number, holidays: Set<number>, showKind: boolean, showTeam: boolean}} options
 * @returns {object[]}
 */
function groupByPerson(entries, { year, holidays, showKind, showTeam }) {
  const people = new Map();
  for (const entry of [...entries].sort((a, b) => a.from.localeCompare(b.from))) {
    const key = entry.person ?? entry.name;
    if (!people.has(key)) {
      people.set(key, { name: entry.name, ...(showTeam ? { onTeam: Boolean(entry.onTeam) } : {}), days: 0, leaves: [] });
    }
    const days = leaveDays(entry, year, holidays);
    const leave = { from: entry.from, to: entry.to, days };
    if (showKind) leave.kind = entry.kind;
    if (entry.note) leave.note = entry.note;
    const row = people.get(key);
    row.days += days;
    row.leaves.push(leave);
  }
  return [...people.values()];
}

/**
 * Counts the entries of other kinds, so a different spelling of leave isn't missed.
 * @param {object[]} entries
 * @returns {Record<string, number>|undefined}
 */
function countOtherKinds(entries) {
  if (entries.length === 0) return undefined;
  const counts = {};
  for (const entry of entries) counts[entry.kind] = (counts[entry.kind] ?? 0) + 1;
  return counts;
}

export default {
  name: "team_leave_year",
  description:
    "Who has leave in a given year, from the team vacation tracker: each person with their leave dates (YYYY-MM-DD) and working days " +
    "(weekdays, minus public holidays; a morning or afternoon off counts as 0.5). Defaults to vacation leave (VL), the user's own team, and this year. " +
    "Use for questions like 'who on the team has VL next year', 'how much PTO did Mae take in 2026', or 'who's off in 2027'. " +
    "Set kind to another kind (PTO, SL, EL, UTO, OOO, Offset, Birthday, WFH, Leave…), a list of kinds, or \"all\". " +
    "otherKinds counts the same people's entries of other kinds, e.g. leave filed as PTO instead of VL.",
  step: "Checking the leave tracker",
  inputSchema: {
    type: "object",
    properties: {
      year: { type: "integer", description: "The year to look at, like 2027. Defaults to this year." },
      kind: {
        description: "Kind of leave: VL (default), PTO, SL, EL, UTO, OOO, Offset, Birthday, WFH, Leave, Sick, Out, Off, Traveling, Limited, a list of them, or \"all\".",
        anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
      },
      person: { type: "string", description: "Only this person (name or nickname). Leave out for everyone." },
      teamOnly: { type: "boolean", description: "Only the user's own team. Defaults to true, or false when a person is named." },
      holidayRegion: {
        type: "string",
        description: "Whose public holidays to leave out of the day counts: PH (default), US, all, or none.",
      },
    },
    required: [],
  },
  async run(args, ctx) {
    const { year, kinds, person, teamOnly, holidayRegion } = readArgs(args ?? {});
    const entries = await fetchYear(ctx, year);
    const matcher = personMatcher(person, person ? await readTeam(ctx) : []);
    const { scoped, unlisted } = splitScope(entries, matcher, teamOnly);
    const isWanted = (entry) => !kinds || kinds.includes(entry.kind);
    const people = groupByPerson(scoped.filter(isWanted), {
      year,
      holidays: holidayDays(entries, holidayRegion),
      showKind: !kinds || kinds.length > 1,
      showTeam: !teamOnly,
    });
    const notListed = [...new Set(unlisted.filter(isWanted).map((entry) => entry.name))];
    const otherKinds = kinds ? countOtherKinds(scoped.filter((entry) => !isWanted(entry))) : undefined;
    return {
      year,
      kinds: kinds ?? "all",
      scope: teamOnly ? "team" : "everyone",
      ...(person ? { person, personFound: matcher.listed || scoped.length > 0 } : {}),
      count: people.length,
      people,
      ...(otherKinds ? { otherKinds } : {}),
      ...(notListed.length ? { notInYourList: notListed.slice(0, 10) } : {}),
    };
  },
};
