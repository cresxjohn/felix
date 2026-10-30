/**
 * Felix as a friend. You can tell him about your day, share good news or vent, and he answers like a close friend:
 * warm, on your side, and honest. Personal talk is told apart from work questions, and kept apart from work data:
 * no work card is read for it, and only personal notes come along. It goes to a warmer model (a setting), with its
 * own short rules. If you ever sound like you might be in danger, a fixed message with real help (NCMH's crisis
 * hotline in the Philippines) comes first, before anything the AI says, and that talk is never kept in memory.
 * Quiet hours keep him from bringing personal things up on his own.
 */

// Feelings, the people in your life and life outside work: what makes a message personal.
const PERSONAL = new RegExp([
  "\\bi(?:'m| am| feel| felt|'ve been| have been)\\s+(?:so |really |kind of |kinda |a bit |pretty |very |just )?(?:sad|down|low|stressed|anxious|lonely|alone|happy|excited|tired|exhausted|drained|burn(?:ed|t) out|worried|upset|angry|mad|frustrated|overwhelmed|nervous|scared|afraid|hurt|lost|stuck|proud|grateful|bored|homesick|heartbroken|depressed|sick)\\b",
  "\\b(?:my|our) (?:mom|mum|mother|dad|father|parents?|wife|husband|partner|girlfriend|boyfriend|fianc[eé]e?|kids?|son|daughter|baby|family|brother|sister|siblings?|friends?|best friend|dog|cat|pet|lola|lolo|tita|tito|grandma|grandpa)\\b",
  "\\b(?:feel|feeling|felt)\\b",
  "\\b(?:vent|rant|talk about (?:it|something|life)|can we talk|need to talk|need someone|cheer me up|hug)\\b",
  "\\b(?:long day|rough day|bad day|good day|great day|tough week|rough week|my weekend|this weekend|on vacation|birthday|gift for|present for|anniversary|break ?up|broke up|got engaged|got married|pregnant|passed away|funeral|therapy|therapist|my health|doctor|hospital)\\b",
  "\\b(?:lonely|homesick|heartbroken|grief|grieving|miss (?:him|her|them|home|my))\\b",
].join("|"), "i");

// Words that, at the very start of a message, make it plainly about work even if it mentions a feeling.
const WORK_FIRST = /^(?:who'?s|when'?s|what'?s (?:failing|waiting|playing)|merge|review|summari[sz]e|open|show|build|add|fix|create|deploy|release)\b/i;

// Wording that may mean someone is in danger. Kept narrow on purpose: "this bug is killing me" isn't in it.
const CRISIS = /\b(?:kill(?:ing)? myself|end(?:ing)? (?:my|it all|my own) life|end it all|suicid\w*|take my (?:own )?life|want(?:ed)? to die|wanna die|wish i (?:was|were) dead|better off (?:dead|without me)|no reason to (?:live|go on)|don'?t want to (?:live|be alive|be here anymore)|can'?t go on|self[- ]?harm|hurt(?:ing)? myself|cut(?:ting)? myself|overdose)\b/i;

/**
 * The fixed message shown before anything else when someone may be in danger. It's written here, not by the AI,
 * so it's always the same, always there and always right.
 */
export const CRISIS_TEXT = "I'm really glad you told me, and I'm here with you. You don't have to go through this alone. "
  + "If you might hurt yourself or you're in danger right now, please call 911. "
  + "You can also talk to someone at the NCMH crisis hotline, 1553, any time, day or night. "
  + "If you can, reach out to someone you trust and let them know how you're feeling right now.";

/** What each personality setting asks of Felix when the talk is personal. */
const PERSONALITIES = {
  warm: "warm and caring, like a close friend who's always glad to hear from them",
  cheerful: "upbeat and encouraging, quick to celebrate the good things",
  calm: "calm and steady, unhurried, good to talk to when things feel like too much",
  direct: "straight-talking and practical, kind but honest without sugar-coating",
};

/**
 * Whether a message someone may be in danger needs the crisis message first.
 * @param {string} text
 * @returns {boolean}
 */
export const isCrisis = (text) => CRISIS.test(String(text || ""));

/**
 * Whether a message is personal talk rather than a work question: it's about feelings, the people in their life or
 * life outside work, and it names no work source or PR. Crisis wording always counts as personal.
 * @param {string} text
 * @param {boolean} namesWork Whether it names a work source, a PR or something like the calendar or Jira.
 * @returns {boolean}
 */
export function isPersonal(text, namesWork) {
  const said = String(text || "").trim();
  if (isCrisis(said)) return true;
  return !namesWork && !WORK_FIRST.test(said) && PERSONAL.test(said);
}

/**
 * The rules that go with a personal message, in place of the work data: how to be a good friend, with the
 * personality from Settings, and no memory cards when Settings keep personal talk (or a crisis) out of memory.
 * @param {Record<string, unknown>} prefs
 * @param {{ crisis?: boolean }} [options] `crisis` when the crisis message was already shown.
 * @returns {string}
 */
export function friendLine(prefs, { crisis = false } = {}) {
  const you = String(prefs.felixYourName || "").trim();
  return [
    `This is personal talk, not a work question, so no work data was read and none should come into it. Be their friend: ${PERSONALITIES[String(prefs.felixFriendPersonality)] || PERSONALITIES.warm}.`,
    "- Listen first. Reflect back what you heard in your own words before any advice, and ask a gentle question when it helps. Keep it short, like a text from a friend.",
    "- Be honest, not a yes-man: when you think they're being too hard on themselves, or about to make a choice that could hurt them, say so kindly. Never invent facts or pretend to know what you don't.",
    "- Cheer them on for good news. For hard things, stay with them, and gently encourage reaching out to people they trust: family, friends, someone they can talk to in person.",
    "- Use what they told you before only from your notes, saying when (\"you told me on Oct 12\"). Don't bring up work unless they do.",
    "- If they ever sound like they might be in danger, point them to real help: 911 for an emergency, and the NCMH crisis hotline, 1553, any time.",
    crisis ? "- Felix already showed them the crisis hotline message just now, which starts \"I'm really glad you told me\". Don't repeat it or the numbers, and don't open the same way; stay with them warmly, ask how they are right now and whether they're safe, and encourage them to call or reach out to someone today." : "",
    you ? `- Their name is ${you}.` : "",
    // What Settings say may be kept from personal talk holds for the AI's own memory cards too, not only Felix's notes.
    crisis || prefs.felixFriendRemember === "work" || prefs.felixMemoryLearn === false
      ? "- Don't write, change or delete any memory card in this conversation: nothing from it is kept." : "",
  ].filter(Boolean).join("\n");
}

/**
 * The model for personal talk: the one picked in Settings, or on Auto, Sonnet on Claude and Cursor's Sonnet on Cursor,
 * which take more care than the quick picks.
 * @param {Record<string, unknown>} prefs
 * @param {"claude" | "cursor"} tool The AI tool the question goes to.
 * @param {Record<"claude" | "cursor", string>} picks Felix's own picks for personal talk on each tool.
 * @returns {string}
 */
export function friendModel(prefs, tool, picks) {
  const set = String(prefs.felixFriendModel || "auto");
  return set === "auto" || prefs.felixTool === "auto" ? picks[tool] : set;
}

/**
 * The hour of a moment in a time zone, from 0 to 23.
 * @param {number} at
 * @param {string} [timeZone]
 * @returns {number}
 */
const hourOf = (at, timeZone) => Number(new Intl.DateTimeFormat("en-US", { hour: "numeric", hourCycle: "h23", timeZone }).format(new Date(at)));

/**
 * Whether it's quiet hours, when Felix doesn't bring personal things up on his own. The hours may run past
 * midnight (10 PM to 7 AM); the same hour for both means no quiet hours.
 * @param {Record<string, unknown>} prefs
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {boolean}
 */
export function inQuietHours(prefs, now, timeZone) {
  if (prefs.felixQuietOn === false) return false;
  const from = Number(prefs.felixQuietFrom ?? 22);
  const to = Number(prefs.felixQuietTo ?? 7);
  if (from === to) return false;
  const h = hourOf(now, timeZone);
  return from < to ? h >= from && h < to : h >= from || h < to;
}
