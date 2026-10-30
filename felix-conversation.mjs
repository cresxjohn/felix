/**
 * What Felix and you just talked about, kept by Felix itself, so every answer can follow the conversation:
 * whichever model or AI tool answers, and after a session restarts. Only the last few exchanges are kept, and
 * only while the conversation is fresh.
 */

const KEEP = 4;
const FRESH_MS = 30 * 60_000;
const ANSWER_CHARS = 500;
const INTRO = "What we just talked about, oldest first. It's only for following the conversation: things may have changed since, so take facts from the data.";

/**
 * @typedef {{ sources: string[], prs: Array<{ repo: string, number: number }>, notYet: string[], followsOn: boolean }} Route
 * @typedef {{ at: number, question: string, answer: string, route: Route | null }} Exchange
 */

/**
 * An answer cut to a length a recap can carry, at a word.
 * @param {string} text
 * @returns {string}
 */
export function clipped(text) {
  const flat = String(text || "").replace(/\s+/g, " ").trim();
  if (flat.length <= ANSWER_CHARS) return flat;
  return `${flat.slice(0, ANSWER_CHARS).replace(/\s+\S*$/, "")}…`;
}

/**
 * Creates the conversation.
 * @param {{ now?: () => number, keep?: number, freshMs?: number }} [options]
 */
export function createConversation({ now = Date.now, keep = KEEP, freshMs = FRESH_MS } = {}) {
  /** @type {Exchange[]} */
  const said = [];

  /**
   * The exchanges still fresh, oldest first.
   * @returns {Exchange[]}
   */
  const fresh = () => said.filter((e) => now() - e.at < freshMs);

  return {
    /**
     * Remembers a question and its answer.
     * @param {string} question
     * @param {string} answer
     * @param {Route | null} [route] Where the answer's data came from; none for a local command.
     */
    add(question, answer, route = null) {
      said.push({ at: now(), question, answer: clipped(answer), route });
      if (said.length > keep) said.shift();
    },

    /**
     * The last answer, while the conversation is fresh, so "the first one" can point into it; "" when there's none.
     * @returns {string}
     */
    lastAnswer() {
      return fresh().at(-1)?.answer || "";
    },

    /**
     * The recap to send with a question, or "" when there's nothing fresh.
     * @returns {string}
     */
    recap() {
      const recent = fresh();
      return recent.length ? [INTRO, ...recent.map((e) => `Me: ${e.question}\nYou: ${e.answer}`)].join("\n") : "";
    },

    /**
     * The route for a question. One that follows on, like "and who approved it?", reads the last answer's
     * sources and PRs too.
     * @param {Route} route
     * @returns {Route}
     */
    routeFor(route) {
      const last = route.followsOn && fresh().reverse().find((e) => e.route)?.route;
      if (!last) return route;
      return { ...route, sources: [...new Set([...route.sources, ...last.sources])], prs: last.prs };
    },
  };
}
