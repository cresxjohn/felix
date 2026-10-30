/**
 * Waking Felix by voice: "Hey Felix", or just "Felix" when Settings allow it. The page sends each short clip of
 * speech it hears to whisper.cpp on this Mac; this decides whether the words start with the phrase. Words that
 * don't are dropped at once: the page only ever gets back whether Felix woke and, when he did, what was said after
 * the phrase. Nothing heard is stored or logged. Whisper often mishears a name a little ("Phelix", "Felicks"), so
 * the name is compared by how it sounds, and only at the very start: "I told Felix" doesn't wake him. While Felix
 * talks, the same hearing lets you cut in (barge-in), without his own voice counting as you.
 */
import { wakePhrase } from "./public/settings-schema.mjs";

const WORD = /[\p{L}\p{N}']+/gu;
// What whisper writes for "hey" at the start of a clip, and the sounds people put before a name.
const GREETINGS = new Set(["hey", "hay", "hei", "heyy", "hi", "a", "eh", "ay", "okay", "ok", "yo", "hello"]);
const FILLERS = new Set(["um", "uh", "erm", "so", "oh"]);
const FILLERS_MAX = 1;

/**
 * A word written the way it sounds, so spellings whisper mixes up come out the same: "Phelix", "Felicks" and
 * "Feliks" all sound like "Felix".
 * @param {string} word
 * @returns {string}
 */
export function soundOf(word) {
  const w = String(word).toLowerCase().replace(/'s$/, "").replace(/[^a-z]/g, "")
    .replace(/ph/g, "f").replace(/ck/g, "k").replace(/x/g, "ks").replace(/c/g, "k").replace(/q/g, "k").replace(/z/g, "s")
    .replace(/(.)\1+/g, "$1");
  return w ? w[0] + w.slice(1).replace(/[aeiouy]+/g, "a") : "";
}

/**
 * How many single-letter changes turn one word into the other.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function editDistance(a, b) {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const next = [i];
    for (let j = 1; j <= b.length; j++) next[j] = Math.min(row[j] + 1, next[j - 1] + 1, row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    row = next;
  }
  return row[b.length];
}

/**
 * Whether a heard word is the name: the same sound, or for names of five letters or more, one letter off
 * ("Felis", "Helix"). Short names must sound the same, since one letter turns them into everyday words.
 * @param {string} heard
 * @param {string} name
 * @returns {boolean}
 */
export function soundsLike(heard, name) {
  const h = String(heard).toLowerCase().replace(/'s$/, "");
  const n = String(name).toLowerCase();
  if (!h || !n) return false;
  if (h === n || soundOf(h) === soundOf(n)) return true;
  return n.length >= 5 && editDistance(h, n) <= 1;
}

/**
 * The words of some text, with where each ends, so the rest of what was said can be cut out as it was written.
 * @param {string} text
 * @returns {Array<{ word: string, end: number }>}
 */
const wordsOf = (text) => [...String(text).matchAll(WORD)].map((m) => ({ word: m[0].toLowerCase(), end: m.index + m[0].length }));

/**
 * Whether the words heard start with the wake words, and where they end. The name words are compared by sound,
 * and "hey" also takes what whisper writes for it ("a", "hi", "okay").
 * @param {Array<{ word: string, end: number }>} heard
 * @param {string[]} wake The wake words, lowercase.
 * @param {Set<string>} names The words of Felix's name.
 * @returns {number} Where the phrase ends in the text, or -1 when it isn't there.
 */
function startsWith(heard, wake, names) {
  if (!wake.length || heard.length < wake.length) return -1;
  for (let i = 0; i < wake.length; i++) {
    const want = wake[i];
    const got = heard[i].word;
    const ok = names.has(want) ? soundsLike(got, want) : got === want || (GREETINGS.has(want) && GREETINGS.has(got)) || soundOf(got) === soundOf(want);
    if (!ok) return -1;
  }
  return heard[wake.length - 1].end;
}

/**
 * Whether what was heard wakes Felix, and the question said after the phrase in the same breath. The phrase must
 * come first; one "um" or "so" before it is fine. With `felixWakeName` on, the name alone wakes him too.
 * @param {string} text What whisper heard.
 * @param {Record<string, unknown>} prefs Settings: `felixName`, `felixWake` (the phrase) and `felixWakeName`.
 * @returns {{ rest: string } | null} Null when it doesn't wake him.
 */
export function matchWake(text, prefs) {
  const said = String(text || "");
  let heard = wordsOf(said);
  let skipped = 0;
  while (skipped < FILLERS_MAX && heard.length && FILLERS.has(heard[0].word)) {
    heard = heard.slice(1);
    skipped++;
  }
  const name = String(prefs.felixName || "Felix");
  const names = new Set(wordsOf(name).map((w) => w.word));
  const tries = [wordsOf(wakePhrase(prefs)).map((w) => w.word)];
  if (prefs.felixWakeName !== false) tries.push([...names]);
  for (const wake of tries) {
    const end = startsWith(heard, wake, names);
    if (end >= 0) return { rest: said.slice(end).replace(/^[\s,.!?:;—–-]+/, "").trim() };
  }
  return null;
}

/**
 * What the page gets back for a clip it sent while listening for the phrase: whether Felix woke and, if so, the
 * rest of what was said. When he didn't wake, nothing of what was heard comes back.
 * @param {string} heard
 * @param {Record<string, unknown>} prefs
 * @returns {{ woke: false } | { woke: true, rest: string }}
 */
export function wakeReply(heard, prefs) {
  const match = matchWake(heard, prefs);
  return match ? { woke: true, rest: match.rest } : { woke: false };
}

// Short words that cut Felix off while he talks.
const STOP_WORDS = /^(stop|wait|hold on|hang on|cancel|quiet|shush|pause|enough|never ?mind|okay,? stop|ok,? stop|that'?s enough)\b/i;
const ECHO_SHARE = 0.6;
const TALK_OVER_WORDS = 3;

/**
 * Whether what the microphone heard while Felix talked is just his own voice coming back: most of its words are in
 * the sentence he was saying.
 * @param {string} heard
 * @param {string} saying What Felix was saying right then.
 * @returns {boolean}
 */
export function echoOf(heard, saying) {
  const words = wordsOf(heard).map((w) => w.word);
  if (!words.length || !saying) return false;
  const said = new Set(wordsOf(saying).map((w) => w.word));
  return words.filter((w) => said.has(w)).length / words.length >= ECHO_SHARE;
}

/**
 * What to do with speech heard while Felix talks: his own voice is ignored; "stop", "wait" or his name stop him;
 * his name with more after it, or a few words of talking over him, stop him and become your next question.
 * @param {string} heard
 * @param {{ saying?: string, prefs: Record<string, unknown> }} context
 * @returns {{ action: "ignore" | "stop" } | { action: "ask", rest: string }}
 */
export function bargeReply(heard, { saying = "", prefs }) {
  const text = String(heard || "").trim();
  if (!text || echoOf(text, saying)) return { action: "ignore" };
  if (STOP_WORDS.test(text)) return { action: "stop" };
  const named = matchWake(text, { ...prefs, felixWakeName: true });
  if (named) return named.rest ? { action: "ask", rest: named.rest } : { action: "stop" };
  return wordsOf(text).length >= TALK_OVER_WORDS ? { action: "ask", rest: text } : { action: "ignore" };
}
