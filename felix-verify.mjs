/**
 * Felix's fact check, in code rather than another AI call. Before an answer is shown, every number, time, PR
 * number, ticket key and name in it must match something in the data Felix just read (or the question asked).
 * One that doesn't blocks the answer, so Felix says it can't confirm instead of guessing.
 */
import { readFileSync } from "node:fs";
import { isIsoTime, timeText } from "./felix-facts.mjs";

const DICTIONARY = "/usr/share/dict/words";
const KNOWN_TERMS = ["felix", "github", "datadog", "claude", "cursor", "spotify", "jira", "slack", "haiku", "sonnet", "opus",
  "pr", "prs", "ci", "ok", "okay", "ai", "am", "pm", "fm", "bm", "ic", "qa", "url", "api", "id", "hmm", "yep", "nope"];
const FALLBACK_WORDS = ["the", "a", "an", "and", "or", "but", "it", "its", "you", "your", "yours", "he", "she", "they", "we", "there",
  "here", "this", "that", "these", "those", "today", "tomorrow", "yesterday", "tonight", "now", "no", "yes", "nothing", "everything",
  "all", "none", "one", "both", "looks", "sure", "also", "only", "just", "right", "next", "after", "before", "until", "still", "not",
  "is", "are", "was", "be", "has", "have", "had", "can", "could", "would", "should", "will", "on", "off", "in", "at", "for", "with",
  "from", "to", "of", "by", "about", "nobody", "someone", "everyone", "good", "great", "nice", "hey", "hi", "hello", "thanks",
  "sorry", "well", "so", "if", "when", "while", "what", "who", "which", "why", "how", "where", "my", "me", "our", "their", "his", "her",
  "will", "may", "nice"];
const TIME = /\b(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s?m\b\.?/gi;
const NUMBER = /\d+(?:[.,]\d+)*/g;
const CAPITALIZED = /\p{Lu}[\p{L}\p{M}'’.-]*/gu;
const ENDINGS = [["ies", "y"], ["ied", "y"], ["es", ""], ["s", ""], ["ed", "e"], ["ed", ""], ["ing", "e"], ["ing", ""], ["ly", ""], ["er", ""], ["est", ""]];

let dictionary = null;

/**
 * Everyday English words, lowercase, from the Mac's word list. Names and places there are capitalized, so they
 * aren't in it and still get checked; so are words the list has both ways, like "Marco" and "marco", since a
 * capital one is most likely a name. A short list stands in when the word list is missing.
 * @param {string} [file]
 * @returns {Set<string>}
 */
export function ordinaryWords(file = DICTIONARY) {
  if (dictionary && file === DICTIONARY) return dictionary;
  let words;
  try {
    const all = readFileSync(file, "utf8").split("\n").filter(Boolean);
    const named = new Set(all.filter((w) => w !== w.toLowerCase()).map((w) => w.toLowerCase()));
    words = all.filter((w) => w === w.toLowerCase() && !named.has(w));
  } catch {
    words = FALLBACK_WORDS;
  }
  const set = new Set([...words, ...KNOWN_TERMS, ...FALLBACK_WORDS]);
  if (file === DICTIONARY) dictionary = set;
  return set;
}

/**
 * A time as one key, so "10 PM", "10:00pm" and "10 p.m." match.
 * @param {string | number} hour
 * @param {string | undefined} minute
 * @param {string} half "a" or "p".
 * @returns {string}
 */
const timeKey = (hour, minute, half) => `${Number(hour) % 12}:${minute || "00"}${half.toLowerCase()}m`;

/**
 * Adds a number with the ways it may be rounded when said, so 69.485 also allows 69, 70, 69.5 and 69.49.
 * @param {{ numbers: Set<number> }} known
 * @param {number} n
 */
function addNumber(known, n) {
  known.numbers.add(n);
  if (Number.isInteger(n)) return;
  for (const rounded of [Math.floor(n), Math.ceil(n), roundTo(n, 0), roundTo(n, 1), roundTo(n, 2)]) known.numbers.add(rounded);
}

/**
 * Rounds the way a person would, halves up, so 69.485 rounds to 69.49 even though it's stored a hair under.
 * @param {number} n
 * @param {number} places
 * @returns {number}
 */
const roundTo = (n, places) => Math.round(n * 10 ** places + 1e-9) / 10 ** places;

/**
 * Adds the words and numbers in some text.
 * @param {{ words: Set<string>, numbers: Set<number>, times: Set<string> }} known
 * @param {string} text
 */
function addText(known, text) {
  for (const [, h, m, half] of text.matchAll(TIME)) known.times.add(timeKey(h, m, half));
  for (const n of text.match(NUMBER) || []) addNumber(known, Number(n.replace(/,/g, "")));
  for (const w of text.toLowerCase().match(/[\p{L}\p{M}]+/gu) || []) known.words.add(w);
}

/**
 * Adds a date and time the way Felix could say it: its time, weekday, month and day.
 * @param {{ words: Set<string>, numbers: Set<number>, times: Set<string> }} known
 * @param {string} iso
 * @param {string} [timeZone]
 */
function addTime(known, iso, timeZone) {
  const at = new Date(iso);
  addText(known, timeText(at, timeZone));
  for (const options of [{ weekday: "long" }, { weekday: "short" }, { month: "long" }, { month: "short" }, { day: "numeric" }]) {
    addText(known, new Intl.DateTimeFormat("en-US", { ...options, timeZone }).format(at));
  }
}

/**
 * Everything an answer may say: the words, numbers and times in the data and the question. Lists also give
 * their length, since "2 PRs" counts a list.
 * @param {unknown[]} values The data read for the answer, and the question.
 * @param {{ timeZone?: string }} [options]
 * @returns {{ words: Set<string>, numbers: Set<number>, times: Set<string> }}
 */
export function knownFacts(values, { timeZone } = {}) {
  const known = { words: new Set(), numbers: new Set(), times: new Set() };
  const walk = (v) => {
    if (typeof v === "string") return isIsoTime(v) ? addTime(known, v, timeZone) : addText(known, v);
    if (typeof v === "number") return addNumber(known, v);
    if (Array.isArray(v)) {
      known.numbers.add(v.length);
      return v.forEach(walk);
    }
    if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(values);
  return known;
}

/**
 * Whether a word is an everyday one, counting its other forms: the word list has "check" and "wait" but not
 * "checks", "approved" or "waiting".
 * @param {string} word
 * @param {Set<string>} ordinary
 * @returns {boolean}
 */
export function isOrdinary(word, ordinary) {
  if (ordinary.has(word)) return true;
  return ENDINGS.some(([ending, add]) => {
    if (!word.endsWith(ending) || word.length < ending.length + 3) return false;
    const stem = word.slice(0, -ending.length);
    return ordinary.has(stem + add) || (!add && ordinary.has(stem.replace(/(.)\1$/, "$1")));
  });
}

/**
 * The names in an answer that need checking: capitalized words that aren't everyday words, like people,
 * weekdays and months. "Sonito's" is checked as "sonito"; "On-call" as "on" and "call".
 * @param {string} text
 * @param {Set<string>} ordinary
 * @returns {string[]}
 */
function namesIn(text, ordinary) {
  const out = [];
  for (const token of text.match(CAPITALIZED) || []) {
    for (const part of token.split(/[-.]/)) {
      const word = part.split(/['’]/)[0].toLowerCase();
      if (word.length > 1 && /^\p{L}/u.test(word) && !isOrdinary(word, ordinary)) out.push(word);
    }
  }
  return out;
}

/**
 * Checks an answer against what Felix read.
 * @param {string} answer
 * @param {unknown[]} values The data read for this answer, and the question.
 * @param {{ timeZone?: string, ordinary?: Set<string> }} [options]
 * @returns {{ ok: boolean, unmatched: string[] }}
 */
export function checkFacts(answer, values, options = {}) {
  return createChecker(values, options)(answer);
}

/**
 * @typedef {((answer: string) => { ok: boolean, unmatched: string[] }) & { learn: (more: unknown) => void }} Checker Checks a
 *   piece of an answer; `learn` adds more it may say, like what the AI's tools read while answering.
 */

/**
 * A checker for one answer's data, which reads the data once however many pieces of the answer it checks.
 * @param {unknown[]} values The data read for this answer, and the question.
 * @param {{ timeZone?: string, ordinary?: Set<string> }} [options]
 * @returns {Checker}
 */
export function createChecker(values, { timeZone, ordinary = ordinaryWords() } = {}) {
  const known = knownFacts(values, { timeZone });
  /** @type {Checker} */
  const check = (answer) => {
    const unmatched = [];
    for (const [whole, h, m, half] of answer.matchAll(TIME)) {
      if (!known.times.has(timeKey(h, m, half))) unmatched.push(whole.trim().replace(/\.$/, ""));
    }
    const rest = answer.replace(TIME, " ");
    for (const n of rest.match(NUMBER) || []) if (!known.numbers.has(Number(n.replace(/,/g, "")))) unmatched.push(n);
    for (const name of namesIn(rest, ordinary)) if (!known.words.has(name)) unmatched.push(name);
    return { ok: unmatched.length === 0, unmatched: [...new Set(unmatched)] };
  };
  check.learn = (more) => {
    const extra = knownFacts([more], { timeZone });
    for (const key of /** @type {const} */ (["words", "numbers", "times"])) extra[key].forEach((v) => known[key].add(v));
  };
  return check;
}

/**
 * Lets a reply through as it's written, one whole sentence at a time, and only sentences that pass the check.
 * After one fails, nothing more is let through; the finished reply is still checked as a whole. Spaces before the
 * first sentence are dropped, so what was shown lines up with the reply it starts.
 * @param {(text: string) => boolean} passes
 * @param {(text: string | null) => void} show Gets each passed piece; null means "take back what was shown".
 * @returns {{ add: (piece: string) => void, reset: () => void, shown: () => string }}
 */
export function createSentenceGate(passes, show) {
  let text = "";
  let shown = 0;
  let stopped = false;
  return {
    add(piece) {
      if (stopped) return;
      text += piece;
      if (!shown) text = text.trimStart();
      let end = shown;
      for (const m of text.slice(shown).matchAll(/[.!?]["')\]’”]*\s+|\n+/g)) end = shown + m.index + m[0].length;
      if (end === shown) return;
      const ready = text.slice(shown, end);
      if (!passes(ready)) {
        stopped = true;
        return;
      }
      show(ready);
      shown = end;
    },
    reset() {
      if (shown) show(null);
      text = "";
      shown = 0;
      stopped = false;
    },
    shown: () => text.slice(0, shown),
  };
}
