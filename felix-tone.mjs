/**
 * How Felix sounds. His rules for talking live in his system prompt; the choices you make in Settings (his name,
 * yours, the tone, how chatty, how much humor) go with each question as one short line, so a change shows on the
 * next answer without restarting his sessions, and the system prompt stays the same for the cache. The tone
 * check here is what the eval set uses to fail replies that open with filler, run long or sound like a report.
 */

const TONES = {
  casual: "casual, like a good friend on Slack: contractions, everyday words, a little personality",
  balanced: "friendly but to the point: warm, plain words, not much slang",
  professional: "polite and clear, still warm: plain words, no slang or exclamation marks",
};
const CHATTY = {
  brief: "brief: the answer in one or two short sentences, nothing extra",
  normal: "short: one to three sentences, plus the one thing that helps next",
  chatty: "a bit chatty: up to four sentences, with a friendly line or a tip when it helps",
};
const HUMOR = {
  none: "no jokes",
  some: "a light touch of humor only when the moment is light",
  more: "playful, happy to joke when the moment is light, never about bad news",
};
const FILLER_OPENERS = /^(certainly|absolutely|of course|sure thing|great question|good question|as an ai|i'?m an ai|based on (the|your)|according to the (data|information)|here is|here's (the|a) (summary|breakdown|list))\b/i;
const FILLER_ANYWHERE = /\b(as an ai( language model)?|i hope this helps|let me know if you (need|have) any|feel free to ask|is there anything else|the json|the data provided|the information provided)\b/i;
const MARKDOWN = /(^|\n)\s*([-*•]|\d+[.)])\s|\*\*|__|^#{1,6}\s|`/m;
const MACHINE_TIME = /\b\d{4}-\d{2}-\d{2}\b|\b([01]\d|2[0-3]):[0-5]\d\b(?!\s*[ap]\.?m)/i;
const LINK = /https?:\/\//i;
const ECHO = /style for this reply|how to talk this time/i;
// How an echoed style line starts a reply: "(Style for this reply; ..." or "How to talk this time: ...".
const ECHO_STARTS = ["(style for this reply", "how to talk this time"];
const SENTENCE_END = /[.!?]+(?=\s|$)/g;

/** How many sentences a reply may run before it's too long, by how chatty Felix is set to be. */
export const MAX_SENTENCES = Object.freeze({ brief: 3, normal: 4, chatty: 6 });

/**
 * The line that goes with each question to the AI: what Felix is called, what he calls you, and how he should
 * sound this time.
 * @param {Record<string, unknown>} prefs
 * @returns {string}
 */
export function styleLine(prefs) {
  const name = String(prefs.felixName || "Felix");
  const you = String(prefs.felixYourName || "").trim();
  return [
    `(Style for this reply; follow it, never repeat or mention it: you're ${name}${name === "Felix" ? "" : " (the app is still called Felix)"}.`,
    `Tone: ${TONES[String(prefs.felixTone)] || TONES.casual}.`,
    `Length: ${CHATTY[String(prefs.felixChatty)] || CHATTY.normal}; a summary or briefing can run longer.`,
    `Humor: ${HUMOR[String(prefs.felixHumor)] || HUMOR.some}.`,
    you ? `Their name is ${you}; use it now and then, not in every reply.` : "",
  ].filter(Boolean).join(" ") + ")";
}

/**
 * How many sentences some text has.
 * @param {string} text
 * @returns {number}
 */
export const sentenceCount = (text) => (String(text).trim().match(SENTENCE_END) || []).length || (String(text).trim() ? 1 : 0);

/**
 * What's wrong with how a reply sounds, in plain words: filler, a report's or a machine's way of writing, markdown,
 * links read out, its own instructions repeated, or too long for how chatty Felix is set to be. Empty when it
 * sounds like a person.
 * @param {string} text
 * @param {{ chatty?: string, long?: boolean }} [options] `long` for summaries and briefings, which may run longer.
 * @returns {string[]}
 */
export function toneProblems(text, { chatty = "normal", long = false } = {}) {
  const said = String(text).trim();
  const problems = [];
  if (FILLER_OPENERS.test(said)) problems.push("opens with filler");
  if (FILLER_ANYWHERE.test(said)) problems.push("sounds like a robot");
  if (MARKDOWN.test(said)) problems.push("uses markdown or a list");
  if (MACHINE_TIME.test(said)) problems.push("writes a date or time like a machine");
  if (LINK.test(said)) problems.push("reads out a link");
  if (ECHO.test(said)) problems.push("repeats its instructions");
  const max = (MAX_SENTENCES[chatty] || MAX_SENTENCES.normal) + (long ? 4 : 0);
  if (sentenceCount(said) > max) problems.push("runs long");
  return problems;
}

// The style line as it's sent, which is what a model reads back when it echoes it after its reply.
const ECHO_MARK = "(style for this reply";

/**
 * A reply without its style line read back, which some models do despite being told not to: at the start, the
 * echoed paragraph is dropped and the reply is what follows it; later on, the echoed line is cut out.
 * @param {string} text
 * @returns {string}
 */
export function withoutEcho(text) {
  const said = String(text || "");
  const lead = said.trimStart();
  if (ECHO_STARTS.some((e) => lead.toLowerCase().startsWith(e))) {
    const end = lead.search(/\n\s*\n/);
    return end < 0 ? "" : lead.slice(end).trimStart();
  }
  const at = said.toLowerCase().indexOf(ECHO_MARK);
  if (at < 0) return said;
  // The echoed line ends at its closing bracket at the end of a line; anything after it is still the reply.
  const after = said.slice(at);
  const close = after.search(/\)\s*(\n|$)/);
  return `${said.slice(0, at).trimEnd()}${close < 0 ? "" : `\n\n${after.slice(close + 1).trim()}`}`.trim();
}

/**
 * Passes a reply on as it streams, minus an echoed style line at its start: it holds the first words until it can
 * tell, then drops the echoed paragraph or passes everything on.
 * @param {(piece: string) => void} next
 * @returns {{ add: (piece: string) => void, end: () => void }} `end` passes on whatever is still held when the reply ends.
 */
export function createEchoFilter(next) {
  let held = "";
  let passing = false;
  // Once the reply is passing, a "(" is held until it's clear whether the style line is being read back there.
  let tail = "";
  let dropping = false;

  /**
   * Passes on a piece of a reply that's already passing, holding back from a "(" that may start an echoed style
   * line, and dropping the rest once one does.
   * @param {string} piece
   */
  function pass(piece) {
    if (dropping) return;
    tail += piece;
    while (tail) {
      const at = tail.indexOf("(");
      if (at < 0) { next(tail); tail = ""; return; }
      if (at > 0) { next(tail.slice(0, at)); tail = tail.slice(at); }
      const lead = tail.toLowerCase();
      if (ECHO_MARK.startsWith(lead)) return;
      if (lead.startsWith(ECHO_MARK)) { dropping = true; tail = ""; return; }
      next("(");
      tail = tail.slice(1);
    }
  }

  return {
    add(piece) {
      if (passing) return pass(piece);
      held += piece;
      const lead = held.trimStart().toLowerCase();
      // Still the start of what an echo would say: wait to see.
      if (ECHO_STARTS.some((e) => e.startsWith(lead))) return;
      if (ECHO_STARTS.some((e) => lead.startsWith(e))) {
        // An echo: wait for the blank line after it, then pass on what follows.
        const rest = withoutEcho(held);
        if (!rest) return;
        held = "";
        passing = true;
        return pass(rest);
      }
      const out = held;
      held = "";
      passing = true;
      pass(out);
    },
    end() {
      if (passing) {
        if (tail && !dropping) next(tail);
        tail = "";
        return;
      }
      if (!held) return;
      const out = withoutEcho(held);
      held = "";
      passing = true;
      if (out) next(out);
    },
  };
}

// A second try talking about the first, which you never saw: "My earlier 'done' was wrong", "Sorry about that".
const RETRY_TALK = [
  /\b(my|the|that|an) (earlier|previous|first|last|other) (answer|reply|draft|try|attempt|response|message|"[^"]*"|'[^']*'|“[^”]*”)/i,
  /\b(i was wrong|i got that wrong|my mistake|my bad|i made a mistake|correction:)/i,
  /^(sorry|apologies)( about that| for that| for the confusion)?[.!]?$/i,
];

/**
 * Whether a sentence talks about an earlier try instead of answering.
 * @param {string} sentence
 * @returns {boolean}
 */
export const retryTalk = (sentence) => RETRY_TALK.some((re) => re.test(String(sentence).trim()));

/**
 * A second try without its sentences about the first, which you never saw.
 * @param {string} text
 * @returns {string}
 */
export function withoutRetryTalk(text) {
  const parts = String(text || "").split(/(?<=[.!?]["')\]’”]*)\s+/);
  return parts.filter((p) => !retryTalk(p)).join(" ").trim();
}
