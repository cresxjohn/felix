/**
 * Felix's progress lines: when he's reading a reply aloud and the answer takes a moment, he says what he's really
 * doing ("Hold on, checking GitHub"), then a short update every few seconds while it's still coming. Each line is
 * one of your phrases with the real step in it, never a made-up one, and never the same line twice in a row. The
 * page loads this to speak them; the tests load it too.
 */
import { PROGRESS_PHRASES } from "./settings-schema.mjs";

const STILL = /\bstill\b/i;
// Steps that say nothing about the question ("Looking into it" while he thinks): never read out. Felix waits for a
// real step, like checking your calendar, and says nothing at all when the answer comes first.
const GENERIC = /^(|looking into it|getting ready|double-checking|on it|working|thinking it over)$/i;
const RECHECK_MS = 500;
const GERUND = /^([A-Z][a-z]+(?:-[a-z]+)?ing)\b/;

/**
 * The steps Felix's AI and its tools report, put the way you'd say them. Tool steps name the tool first
 * ("Read felix.mjs", "Bash ./prs test"), which isn't for reading out, so they become what the tool does.
 */
const STEPS = [
  { re: /^Checking (.+)$/, say: (m) => `checking ${m[1]}` },
  { re: /^Looking into it$/, say: () => "looking into it" },
  { re: /^Double-checking$/, say: () => "double-checking my answer" },
  { re: /^Getting ready$/, say: () => "getting ready" },
  { re: /asking Cursor$|Cursor\)? is answering$/, say: () => "asking Cursor" },
  { re: /^On it$/, say: () => "working on it" },
  { re: /^(Read|Grep|Glob|LS|Search|Find|List)\b/i, say: () => "reading through the code" },
  { re: /^(Edit|MultiEdit|Write|NotebookEdit)\b/i, say: () => "making the change in my workbench" },
  { re: /^(Bash|Run|Terminal|Shell)\b.*\btest/i, say: () => "running the tests" },
  { re: /^(Bash|Run|Terminal|Shell)\b/i, say: () => "running a command" },
  { re: /^(WebFetch|WebSearch|Fetch)\b/i, say: () => "looking it up on the web" },
  { re: /^TodoWrite\b/, say: () => "planning it out" },
];

/**
 * What Felix is doing, the way he'd say it after "Hold on,": "checking GitHub", "running the tests". A step he
 * can't put into words becomes "working on it", which is always true.
 * @param {string} step As the server names it, like "Checking GitHub and Datadog".
 * @returns {string}
 */
export function spokenStep(step) {
  const text = String(step || "").trim();
  if (!text) return "pulling that up";
  for (const s of STEPS) {
    const m = text.match(s.re);
    if (m) return s.say(m);
  }
  const gerund = text.match(GERUND);
  return gerund ? `${gerund[1].toLowerCase()}${text.slice(gerund[1].length)}` : "working on it";
}

/**
 * Your phrases from Settings, one a line, or Felix's own when the box is empty.
 * @param {unknown} text
 * @returns {string[]}
 */
export function phraseList(text) {
  const list = String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
  return list.length ? list : [...PROGRESS_PHRASES];
}

/**
 * The next line to say. The first one comes from the phrases without "still"; an update while the step hasn't
 * changed prefers the ones with it. Never the line said last; null when there's nothing new to say.
 * @param {string} step
 * @param {string[]} phrases
 * @param {{ update: boolean, sameStep: boolean, last: string, random?: () => number }} options
 * @returns {string | null}
 */
export function lineFor(step, phrases, { update, sameStep, last, random = Math.random }) {
  const said = spokenStep(step);
  const lines = (list) => [...new Set(list.map((p) => p.replace(/\{step\}/g, said).replace(/^./, (ch) => ch.toUpperCase())))].filter((l) => l !== last);
  const still = phrases.filter((p) => STILL.test(p));
  const fresh = phrases.filter((p) => !STILL.test(p));
  const prefer = update && sameStep ? still : fresh;
  const choices = lines(prefer).length ? lines(prefer) : lines(phrases);
  if (!choices.length) return null;
  return choices[Math.floor(random() * choices.length)] || choices[0];
}

/**
 * @typedef {{ set: (fn: () => void, ms: number) => unknown, clear: (id: unknown) => void }} Timers
 */

/** The page's own timers. Called through arrows, since a browser refuses setTimeout called on another object. */
const BROWSER_TIMERS = { set: (fn, ms) => setTimeout(fn, ms), clear: (id) => clearTimeout(id) };

/**
 * Starts Felix's progress lines for one answer. After `delayMs` with no answer, once he's on a real step (not just
 * thinking), he says the first line, then one
 * every `everyMs` while it's still coming (never, with 0). A line still being said when the next is due is let finish, and that
 * update is skipped. `stop` ends them, when the answer starts or you stop him.
 * @param {{ delayMs: number, everyMs: number, phrases: string[], say: (line: string) => Promise<unknown> | unknown,
 *   random?: () => number, timers?: Timers }} options
 * @returns {{ step: (step: string) => void, stop: () => void, said: () => string[] }}
 */
export function createProgress({ delayMs, everyMs, phrases, say, random = Math.random, timers = BROWSER_TIMERS }) {
  const spoken = [];
  let step = "";
  let lastStep = null;
  let saying = false;
  let stopped = false;
  let timer = timers.set(tick, delayMs);

  /**
   * Says the next line, unless one is still being said, then waits for the next update.
   */
  function tick() {
    if (stopped) return;
    // Nothing worth saying yet: look again shortly, until a real step comes or the answer does.
    if (GENERIC.test(step.trim())) {
      timer = timers.set(tick, RECHECK_MS);
      return;
    }
    // With updates off (0), the first line is the only one: one "hold on" per question.
    if (everyMs > 0) timer = timers.set(tick, everyMs);
    if (saying) return;
    const line = lineFor(step, phrases, { update: spoken.length > 0, sameStep: lastStep === step, last: spoken.at(-1) || "", random });
    if (!line) return;
    spoken.push(line);
    lastStep = step;
    saying = true;
    Promise.resolve().then(() => say(line)).catch(() => {}).finally(() => { saying = false; });
  }

  return {
    /** What Felix is doing now, as the server names it. @param {string} next */
    step: (next) => { step = String(next || ""); },
    /** Ends the lines: no more are said. */
    stop: () => {
      stopped = true;
      timers.clear(timer);
    },
    /** The lines said so far. @returns {string[]} */
    said: () => [...spoken],
  };
}
