/**
 * The Wais card's choices, kept in one hidden setting (waisChoices) so the Mac and the iPad share them: the space
 * picked, the tab, and for each space its Safe to spend period, its accounts and the outlook's period. Shared by the
 * home page and the server (wais.mjs), so both know the same periods.
 */

/** The periods the outlook can cover, in days. */
export const OUTLOOK_PERIODS = Object.freeze(["30", "60", "90", "365", "730", "1095", "1825"]);
/** The periods Safe to spend can cover: until payday, or a number of days. */
export const SAFE_PERIODS = Object.freeze(["payday", ...OUTLOOK_PERIODS]);
const TABS = ["tasks", "outlook"];
const ID = /^[\w-]{1,80}$/;
const MAX = 4000;

/**
 * @typedef {{ period?: string, accounts?: string[] | null, outlook?: string }} SpaceChoice `accounts` null means
 *   Wais's own saved choice; a list means those accounts.
 * @typedef {{ space: string | null, tab: "tasks" | "outlook", spaces: Record<string, SpaceChoice> }} Choices
 */

/**
 * The choices saved in Settings, with anything unreadable left out.
 * @param {unknown} text
 * @returns {Choices}
 */
export function readChoices(text) {
  let raw = {};
  try { raw = JSON.parse(String(text || "{}")) || {}; } catch { raw = {}; }
  const spaces = {};
  for (const [id, c] of Object.entries(raw.spaces && typeof raw.spaces === "object" ? raw.spaces : {})) {
    if (!ID.test(id) || !c || typeof c !== "object") continue;
    spaces[id] = {
      ...(SAFE_PERIODS.includes(c.period) ? { period: c.period } : {}),
      ...(Array.isArray(c.accounts) ? { accounts: c.accounts.filter((a) => typeof a === "string" && ID.test(a)).slice(0, 50) } : {}),
      ...(OUTLOOK_PERIODS.includes(c.outlook) ? { outlook: c.outlook } : {}),
    };
  }
  return { space: typeof raw.space === "string" && ID.test(raw.space) ? raw.space : null, tab: TABS.includes(raw.tab) ? raw.tab : "tasks", spaces };
}

/**
 * One space's choices: its period, accounts (null for Wais's own choice) and the outlook's period (30 days at first).
 * @param {Choices} choices
 * @param {string | null | undefined} spaceId
 * @returns {{ period: string | null, accounts: string[] | null, outlook: string }}
 */
export function choiceFor(choices, spaceId) {
  const c = (spaceId && choices.spaces[spaceId]) || {};
  return { period: c.period || null, accounts: c.accounts?.length ? c.accounts : null, outlook: c.outlook || "30" };
}

/**
 * The choices with a change: the space, the tab, or one space's period, accounts or outlook period. Accounts set to
 * null go back to Wais's own choice.
 * @param {Choices} choices
 * @param {{ space?: string, tab?: string, spaceId?: string, period?: string, accounts?: string[] | null, outlook?: string }} patch
 * @returns {Choices}
 */
export function withChoice(choices, patch) {
  const next = { space: choices.space, tab: choices.tab, spaces: { ...choices.spaces } };
  if (patch.space !== undefined && ID.test(patch.space)) next.space = patch.space;
  if (TABS.includes(patch.tab)) next.tab = patch.tab;
  if (patch.spaceId && ID.test(patch.spaceId)) {
    const c = { ...(next.spaces[patch.spaceId] || {}) };
    if (SAFE_PERIODS.includes(patch.period)) c.period = patch.period;
    if (OUTLOOK_PERIODS.includes(patch.outlook)) c.outlook = patch.outlook;
    if (patch.accounts === null) delete c.accounts;
    else if (Array.isArray(patch.accounts)) c.accounts = patch.accounts.filter((a) => ID.test(a)).slice(0, 50);
    // The space just changed moves to the end, so the oldest are the first to go when the setting is full.
    delete next.spaces[patch.spaceId];
    next.spaces[patch.spaceId] = c;
  }
  return next;
}

/**
 * The choices as the setting keeps them, leaving out the spaces changed longest ago when they don't fit.
 * @param {Choices} choices
 * @returns {string}
 */
export function writeChoices(choices) {
  const spaces = { ...choices.spaces };
  let text = JSON.stringify({ ...choices, spaces });
  while (text.length > MAX && Object.keys(spaces).length) {
    delete spaces[Object.keys(spaces)[0]];
    text = JSON.stringify({ ...choices, spaces });
  }
  return text;
}

/**
 * What the card asks the server for: the space (when one was picked) and that space's choices.
 * @param {Choices} choices
 * @param {string | null} [defaultSpace] Wais's default space, for choices made while no space was picked.
 * @returns {Record<string, string>}
 */
export function askFor(choices, defaultSpace = null) {
  // No space picked means Wais's default one, and that's the space the choices were saved under.
  const c = choiceFor(choices, choices.space || defaultSpace);
  return {
    ...(choices.space ? { space: choices.space } : {}),
    ...(c.period ? { period: c.period } : {}),
    ...(c.accounts ? { accounts: c.accounts.join(",") } : {}),
    outlook: c.outlook,
  };
}
