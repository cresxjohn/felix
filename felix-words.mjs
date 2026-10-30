/**
 * The names and words Felix should hear and say right: your team's names, the people on call, your Jira projects
 * and your work terms. Whisper is told to expect them, so "Sonito" isn't heard as "so neat oh", and any you give a
 * way of saying ("PMHUB = P M hub") are read aloud that way. Most fill in from the app on their own; you add or fix
 * your own in Settings, one a line.
 */

const TERMS = ["PMHUB", "fm", "bm", "Datadog", "Jira", "Slack", "Claude", "Cursor", "Kokoro", "Felix", "PR", "PRs", "on call", "IC"];
const AUTO_MAX = 60;
// A person's name: one to three capitalised words ("Sonito", "Ale Nieto", "Brian M"), not a tracker note like "Flight to Davao".
const NAME = /^\p{Lu}[\p{L}'.-]*(?: \p{Lu}[\p{L}'.-]*){0,2}$/u;

/**
 * Your own words from Settings: one a line, "word" or "word = how to say it".
 * @param {unknown} text
 * @returns {Array<{ word: string, sayAs: string | null }>}
 */
export function parseWords(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
    const [word, as] = l.split("=").map((p) => p.trim());
    return { word, sayAs: as || null };
  }).filter((w) => w.word && w.word.length <= 40);
}

/**
 * The words that fill in on their own: people's names from your team list and the on-call schedules, your Jira
 * projects' keys, and Felix's usual terms, each once.
 * Your team comes first, and only what looks like a person's name counts.
 * @param {{ people?: Array<{ name?: string, nicknames?: string[], onTeam?: boolean }>, oncall?: string[], jiraKeys?: string[] }} sources
 * @returns {string[]}
 */
export function autoWords({ people = [], oncall = [], jiraKeys = [] }) {
  const team = [...people].sort((a, b) => Number(Boolean(b.onTeam)) - Number(Boolean(a.onTeam)));
  const names = [...oncall, ...team.flatMap((p) => [p.name, ...(p.nicknames || [])])].filter(Boolean).map(String).filter((n) => NAME.test(n));
  const projects = [...new Set(jiraKeys.map((k) => String(k).split("-")[0]).filter((k) => /^[A-Z]{2,10}$/.test(k)))];
  const seen = new Set();
  return [...TERMS, ...projects, ...names].filter((w) => {
    const key = w.toLowerCase();
    if (seen.has(key) || w === "nobody") return false;
    seen.add(key);
    return true;
  }).slice(0, AUTO_MAX);
}

/**
 * Everything Felix uses: the words whisper should expect (yours first), and how to say the ones you gave a way of
 * saying.
 * @param {string[]} auto
 * @param {unknown} mine The words setting.
 * @returns {{ hear: string[], sayAs: Array<{ word: string, sayAs: string }> }}
 */
export function wordsFor(auto, mine) {
  const own = parseWords(mine);
  const hear = [...new Set([...own.map((w) => w.word), ...auto])].slice(0, AUTO_MAX);
  return { hear, sayAs: own.filter((w) => w.sayAs).map((w) => ({ word: w.word, sayAs: /** @type {string} */ (w.sayAs) })) };
}
