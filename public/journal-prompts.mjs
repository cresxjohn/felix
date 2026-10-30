/**
 * The Journal card's gentle prompts: a fixed list kept here, with no AI, shared by the home page and the store's
 * tests. Each day starts on its own prompt, and "Another" steps along the list.
 */

/** @type {ReadonlyArray<string>} */
export const JOURNAL_PROMPTS = Object.freeze([
  "Best part of today?",
  "What made you smile today?",
  "What's on your mind tonight?",
  "Something you're thankful for?",
  "What did you learn today?",
  "Who was good to talk to today?",
  "What would you like to remember about today?",
  "What was hard today, and how did you get through it?",
  "What are you looking forward to?",
  "What gave you energy today?",
  "What tired you out today?",
  "One small win from today?",
  "What would make tomorrow a good day?",
  "How did you look after yourself today?",
  "What surprised you today?",
  "Anything you'd do differently?",
  "What felt easy today?",
  "Who would you like to thank, and for what?",
]);

/**
 * The prompt for a day: the same one all day, a different one the next. `skip` steps further along the list.
 * @param {string} day YYYY-MM-DD
 * @param {number} [skip]
 * @returns {string}
 */
export function promptFor(day, skip = 0) {
  // Days counted in UTC from the date's own numbers, so the time zone never changes which prompt a day gets.
  const n = Math.round(Date.parse(`${day}T12:00:00Z`) / 86400e3) || 0;
  const len = JOURNAL_PROMPTS.length;
  return JOURNAL_PROMPTS[(((n + Math.trunc(skip)) % len) + len) % len];
}
