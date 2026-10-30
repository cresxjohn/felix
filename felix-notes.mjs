/**
 * What Felix learns from talking with you: small dated notes, each one short fact in your own words, kept on this
 * Mac in data/felix/notes.json. They're learned after a conversation ends, in one cheap AI step, never during it.
 * Each question brings along only the few notes that fit it, plus a short "about you". A changed fact updates its
 * note and keeps the old wording in its history. While the Mac is idle, duplicates merge and small old details
 * fade into an archive; nothing is deleted unless you ask. Secrets never get in: anything that looks like a
 * password, a code, a card or account number or a key is dropped before saving.
 *
 * This sits beside the note cards Felix's AI writes in its workbench (felix-memory.mjs), which hold what it was
 * told to keep about people, repos and how-tos.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

const DAY = 24 * 3600e3;
const KINDS = ["about", "person", "preference", "event", "situation", "plan", "work"];
const TEXT_MAX = 200;
const QUOTE_MAX = 300;
const RECALL_MAX = 8;
// Exchanges kept for another try when learning fails, at most.
const KEEP_UNLEARNED = 60;
const ABOUT_MAX = 6;
const ABOUT_CHARS = 600;
const OLD_DAYS = 120;
const FADE_AFTER_EVENT_DAYS = 30;
const SAME_WORDS = 0.8;
const STOP = new Set(("the a an and or but if of to in on at for with from by about as is are was were be been it its this that these those "
  + "you your yours i me my mine we our they them their he she his her what who when where why how do does did can could would "
  + "should will just really very so not no yes have has had there here than then also too some any all more most").split(" "));
const SECRETS = [
  /\b(password|passcode|passwd|pwd|pin)\b/i,
  /\b(otp|one[- ]time code|verification code|security code|2fa|mfa)\b/i,
  /\b(api[ _-]?key|secret|token|private key|ssh key|access key)\b/i,
  /\b(card|account|routing|iban|swift|ssn|social security|passport|license) (number|no\.?|#)/i,
  /\b\d(?:[ -]?\d){12,18}\b/,
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{12,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bAKIA[0-9A-Z]{16}\b/,
  /\b[A-Za-z0-9+/_-]{32,}\b/,
];

/**
 * @typedef {{ id: string, text: string, quote: string, kind: string, scope: "work" | "personal", importance: number,
 *   saidAt: string, date?: string | null, followUp?: string | null, askedAt?: string | null, lastSeen?: string,
 *   mentions?: number, archived?: boolean, history?: Array<{ text: string, quote: string, saidAt: string }> }} Note
 *   `text` is the fact, said to you ("You have a dog named Mochi."); `quote` your own words it came from; `date` the
 *   day of a dated event, and `followUp` what to ask after it.
 * @typedef {{ at: number, you: string, felix: string }} Said One exchange, as learning sees it.
 */

/**
 * Whether some text looks like it holds a secret.
 * @param {string} text
 * @returns {boolean}
 */
export const hasSecret = (text) => SECRETS.some((re) => re.test(String(text || "")));

/**
 * The words that matter in some text, lowercase and with common endings taken off, so "interviews" finds "interview".
 * @param {string} text
 * @returns {Set<string>}
 */
export function wordsOf(text) {
  const words = String(text || "").toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return new Set(words.filter((w) => w.length > 2 && !STOP.has(w)).map((w) => w.replace(/(ing|ed|es|s)$/, "")).filter((w) => w.length > 2));
}

/**
 * How alike two sets of words are, from 0 to 1.
 * @param {Set<string>} a
 * @param {Set<string>} b
 * @returns {number}
 */
const overlap = (a, b) => [...a].filter((w) => b.has(w)).length / Math.max(1, a.size, b.size);

/**
 * Text squeezed to one line and a length.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
const tidy = (text, max) => String(text || "").replace(/\s+/g, " ").trim().slice(0, max);

/**
 * A day the way the notes say it: "Oct 12".
 * @param {string | number} at
 * @param {string} [timeZone]
 * @returns {string}
 */
export const dayOf = (at, timeZone) => new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone }).format(new Date(at));

/**
 * The instructions for the one AI step that learns from a conversation.
 * @param {Said[]} said The exchanges, oldest first.
 * @param {Note[]} known Notes it might update, so it can name them.
 * @param {string} today Like "2026-10-30, Friday".
 * @param {string[]} [days] The days around today, like "Thu, Nov 5 = 2026-11-05", so dates are looked up, not worked out.
 * @returns {string}
 */
export function learnPrompt(said, known, today, days = []) {
  return [
    "You pick out what's worth remembering from a talk between a person and Felix, their assistant. Reply with JSON only, no other words:",
    '{"notes":[{"text":"...","quote":"...","kind":"...","scope":"...","importance":1,"date":null,"followUp":null,"updates":null}]}',
    "- text: one short fact said to them, starting with You, like \"You have a dog named Mochi.\" or \"You prefer async reviews.\"",
    "  Write days as the day itself (\"on Thu, Nov 5\"), never \"next week\", \"tomorrow\" or \"last Friday\", since the note is read later.",
    "- quote: their own words it came from, copied exactly from a Me: line. Never Felix's words.",
    `- kind: one of ${KINDS.join(", ")}. scope: work or personal. importance: 1 (small detail) to 3 (matters a lot to them).`,
    "- date: for a dated event (an interview, a trip, a deadline), its day as YYYY-MM-DD, looked up in the days below; else null.",
    "- followUp: for a dated event, a short friendly question to ask after it, like \"How did the interview go?\"; else null.",
    "- updates: the id of a known note this one changes (they moved teams, a date moved), else null.",
    "Keep only what they said about themselves, their life, the people in it, their plans, likes and dislikes, and how they like to work.",
    "Never keep live work data (PRs, on-call, releases, usage), anything Felix said, guesses, or anything secret (passwords, codes, numbers, keys).",
    "If nothing is worth keeping, reply {\"notes\":[]}.",
    `Today is ${today}.`,
    days.length ? `The days around today (use these, don't work dates out):\n${days.join("\n")}` : "",
    known.length ? `Known notes:\n${known.map((n) => `${n.id}: ${n.text}`).join("\n")}` : "No known notes yet.",
    `The talk:\n${said.map((s) => `Me: ${s.you}\nFelix: ${tidy(s.felix, 400)}`).join("\n")}`,
  ].filter(Boolean).join("\n");
}

/**
 * The days from a week before to three weeks after a moment, each with its weekday, for the learning step to look
 * dates up in: "Thu, Nov 5 = 2026-11-05".
 * @param {number} now
 * @param {string} [timeZone]
 * @returns {string[]}
 */
export function daysAround(now, timeZone) {
  const label = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone });
  const iso = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone });
  return Array.from({ length: 29 }, (_, i) => new Date(now + (i - 7) * DAY)).map((d) => `${label.format(d)} = ${iso.format(d)}`);
}

/**
 * The notes in the AI's reply that can be kept: well formed, from your own words in this talk, and with no secret
 * in them. Each gets the day you said it.
 * @param {string} reply The AI's reply.
 * @param {Said[]} said
 * @returns {Array<Omit<Note, "id"> & { updates: string | null }>}
 */
export function notesFrom(reply, said) {
  const json = String(reply || "").match(/\{[\s\S]*\}/)?.[0] || "";
  let list;
  try {
    list = JSON.parse(json).notes;
  } catch {
    return [];
  }
  if (!Array.isArray(list)) return [];
  const flat = (t) => tidy(t, 10_000).toLowerCase().replace(/[’‘]/g, "'");
  return list.flatMap((n) => {
    const text = tidy(n?.text, TEXT_MAX);
    const quote = tidy(n?.quote, QUOTE_MAX);
    const from = said.find((s) => quote && flat(s.you).includes(flat(quote)));
    if (!text || !from || hasSecret(text) || hasSecret(quote)) return [];
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(n.date || "")) && Number.isFinite(Date.parse(n.date)) ? n.date : null;
    return [{
      text, quote, kind: KINDS.includes(n.kind) ? n.kind : "about", scope: n.scope === "work" ? "work" : "personal",
      importance: Math.min(3, Math.max(1, Math.round(Number(n.importance) || 1))), saidAt: new Date(from.at).toISOString(),
      date, followUp: date && n.followUp ? tidy(n.followUp, 120) : null, updates: typeof n.updates === "string" ? n.updates : null,
    }];
  });
}

/**
 * Writes a file in one step, so a crash never leaves half a file.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeAtomic(file, text) {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

/**
 * Creates the notes store.
 * @param {{ file: string, now?: () => number, timeZone?: string, read?: (file: string) => Promise<string>,
 *   write?: (file: string, text: string) => Promise<void> }} options
 */
export function createNotes({ file, now = Date.now, timeZone, read = (f) => readFile(f, "utf8"), write = writeAtomic }) {
  /** @type {Note[] | null} */
  let notes = null;
  let saving = Promise.resolve();

  /** @returns {Promise<Note[]>} Every note, loaded once. */
  const all = async () => {
    notes ||= await read(file).then((t) => JSON.parse(t).notes || [], () => []);
    return notes;
  };

  /** Saves the notes, one write at a time. @returns {Promise<void>} */
  const save = () => {
    const text = `${JSON.stringify({ notes }, null, 2)}\n`;
    saving = saving.catch(() => {}).then(() => write(file, text));
    return saving;
  };

  const iso = () => new Date(now()).toISOString();
  const live = async () => (await all()).filter((n) => !n.archived);

  /**
   * Keeps what one conversation taught: new notes, and changes to known ones with their old wording kept.
   * @param {ReturnType<typeof notesFrom>} learned
   * @returns {Promise<Note[]>} The notes saved.
   */
  async function keep(learned) {
    const list = await all();
    const saved = [];
    for (const { updates, ...n } of learned) {
      const old = updates && list.find((x) => x.id === updates && !x.archived);
      if (old) {
        old.history = [...(old.history || []), { text: old.text, quote: old.quote, saidAt: old.saidAt }];
        Object.assign(old, n, { askedAt: null });
        saved.push(old);
        continue;
      }
      const same = list.find((x) => !x.archived && x.text.toLowerCase() === n.text.toLowerCase());
      if (same) {
        same.mentions = (same.mentions || 1) + 1;
        saved.push(same);
        continue;
      }
      const note = { id: randomUUID().slice(0, 8), ...n, mentions: 1 };
      list.push(note);
      saved.push(note);
    }
    if (saved.length) await save();
    return saved;
  }

  /**
   * The notes that fit a question, best first: the ones sharing its words, weighed by how much they matter and
   * how recent they are.
   * @param {string} question
   * @param {number} [max]
   * @param {"work" | "personal"} [scope] Only notes of this kind of talk; any when left out.
   * @returns {Promise<Note[]>}
   */
  async function search(question, max = RECALL_MAX, scope) {
    const words = wordsOf(question);
    const scored = (await live()).filter((n) => !scope || n.scope === scope).map((n) => {
      const shared = [...wordsOf(`${n.text} ${n.quote}`)].filter((w) => words.has(w)).length;
      const age = (now() - Date.parse(n.saidAt)) / DAY;
      return { n, score: shared ? shared * 3 + n.importance + (n.mentions || 1) * 0.5 - Math.min(2, age / 90) : 0 };
    });
    return scored.filter((s) => s.score > 0).sort((a, b) => b.score - a.score).slice(0, max).map((s) => s.n);
  }

  /**
   * A short "about you": the notes about you that matter most, as one paragraph.
   * @param {"work" | "personal"} [scope] Only notes of this kind of talk; any when left out.
   * @returns {Promise<string>}
   */
  async function about(scope) {
    const picked = (await live()).filter((n) => (!scope || n.scope === scope) && (n.kind === "about" || n.kind === "preference" || n.kind === "work"))
      .sort((a, b) => b.importance - a.importance || Date.parse(b.saidAt) - Date.parse(a.saidAt)).slice(0, ABOUT_MAX);
    let text = "";
    for (const n of picked) if (`${text} ${n.text}`.length <= ABOUT_CHARS) text = `${text} ${n.text}`.trim();
    return text;
  }

  /**
   * What goes with a question: the short "about you", and the notes that fit it, each with the day you said it.
   * The ones used are marked seen, which keeps them from fading. Personal talk brings only personal notes, and work
   * questions only work ones, so the two stay apart.
   * @param {string} question
   * @param {"work" | "personal"} [scope]
   * @returns {Promise<string>} Empty when Felix has nothing.
   */
  async function recall(question, scope) {
    const [you, fits] = await Promise.all([about(scope), search(question, RECALL_MAX, scope)]);
    if (!you && !fits.length) return "";
    for (const n of fits) n.lastSeen = iso();
    if (fits.length) await save();
    return [
      "What you've learned from them, in your notes (say when they told you, like \"you told me on Oct 12\"; if it isn't here or in your memory, say you don't remember):",
      you ? `About them: ${you}` : "",
      ...fits.map((n) => `- ${dayOf(n.saidAt, timeZone)}: ${n.text} (their words: "${n.quote}")${n.date ? ` [on ${n.date}]` : ""}`),
    ].filter(Boolean).join("\n");
  }

  /**
   * Dated events that have passed and haven't been asked about yet.
   * @returns {Promise<Note[]>}
   */
  async function dueFollowUps() {
    const today = new Date(now()).toISOString().slice(0, 10);
    return (await live()).filter((n) => n.date && n.followUp && !n.askedAt && n.date < today
      && now() - Date.parse(n.date) < FADE_AFTER_EVENT_DAYS * DAY);
  }

  /**
   * Notes a follow-up as asked, so it's asked once.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function asked(id) {
    const n = (await all()).find((x) => x.id === id);
    if (!n) return;
    n.askedAt = iso();
    await save();
  }

  /**
   * Tidies up while the Mac is idle: notes saying the same thing merge into the newest (its mentions add up, the
   * others' wording goes into its history), and small details nobody has needed for months, and events long past,
   * move to the archive. Nothing is deleted.
   * @returns {Promise<{ merged: number, archived: number }>}
   */
  async function tidyUp() {
    const list = await live();
    let merged = 0;
    let archived = 0;
    const newest = [...list].sort((a, b) => Date.parse(b.saidAt) - Date.parse(a.saidAt));
    for (const [i, keepIt] of newest.entries()) {
      if (keepIt.archived) continue;
      const mine = wordsOf(keepIt.text);
      for (const other of newest.slice(i + 1)) {
        if (other.archived || other.kind !== keepIt.kind || overlap(mine, wordsOf(other.text)) < SAME_WORDS) continue;
        keepIt.mentions = (keepIt.mentions || 1) + (other.mentions || 1);
        keepIt.importance = Math.max(keepIt.importance, other.importance);
        keepIt.history = [...(keepIt.history || []), { text: other.text, quote: other.quote, saidAt: other.saidAt }, ...(other.history || [])];
        Object.assign(other, { archived: true, mergedInto: keepIt.id });
        merged++;
      }
    }
    for (const n of list) {
      if (n.archived) continue;
      const seen = Date.parse(n.lastSeen || n.saidAt);
      const stale = n.importance <= 1 && (n.mentions || 1) <= 1 && now() - seen > OLD_DAYS * DAY;
      const over = n.date && now() - Date.parse(n.date) > FADE_AFTER_EVENT_DAYS * DAY;
      if (stale || over) {
        n.archived = true;
        archived++;
      }
    }
    if (merged || archived) await save();
    return { merged, archived };
  }

  return {
    all,
    live,
    keep,
    search,
    about,
    recall,
    dueFollowUps,
    asked,
    tidyUp,
    /**
     * Changes a note's words, from the memory page; the old wording goes into its history.
     * @param {string} id
     * @param {string} text
     * @returns {Promise<Note | null>} Null when there's no such note, or the new words hold a secret.
     */
    async edit(id, text) {
      const n = (await all()).find((x) => x.id === id);
      const words = tidy(text, TEXT_MAX);
      if (!n || !words || hasSecret(words)) return null;
      n.history = [...(n.history || []), { text: n.text, quote: n.quote, saidAt: n.saidAt }];
      n.text = words;
      await save();
      return n;
    },
    /**
     * Deletes notes for good, as when you say "forget that" or click Delete.
     * @param {string[]} ids
     * @returns {Promise<number>} How many were deleted.
     */
    async remove(ids) {
      const list = await all();
      const gone = new Set(ids);
      notes = list.filter((n) => !gone.has(n.id));
      const count = list.length - notes.length;
      if (count) await save();
      return count;
    },
  };
}

/**
 * @typedef {ReturnType<typeof createNotes>} Notes
 */

/**
 * Learns from conversations: it collects what you say, and once you've been quiet a while, asks the AI once what's
 * worth keeping and saves it. Things said off the record, and the last thing you said when you say "forget that",
 * aren't kept.
 * @param {{ notes: Notes, extract: (prompt: string) => Promise<string>, learning: () => Promise<boolean>, idleMs: () => Promise<number>,
 *   now?: () => number, log?: (entry: object) => void, setTimer?: typeof setTimeout, clearTimer?: typeof clearTimeout }} options
 *   `learning` says whether learning is on in Settings; `idleMs` how long a quiet spell ends a conversation.
 */
export function createLearner({ notes, extract, learning, idleMs, now = Date.now, log = () => {},
  // The quiet-spell timer never keeps Node running on its own: a talk still waiting to be learned doesn't hold up a shutdown.
  setTimer = (fn, ms) => setTimeout(fn, ms).unref(), clearTimer = (t) => clearTimeout(t) }) {
  /** @type {Said[]} */
  let said = [];
  let offRecord = false;
  /** @type {Note[]} */
  let lastBatch = [];
  let timer = null;

  /**
   * Learns from what was said since the last time: one AI step, then the notes it found are kept.
   * @returns {Promise<Note[]>}
   */
  async function learn() {
    clearTimer(timer);
    timer = null;
    const talk = said;
    said = [];
    offRecord = false;
    if (!talk.length || !(await learning())) return [];
    const known = (await notes.search(talk.map((s) => s.you).join(" "), 20));
    const today = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(now()));
    const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(new Date(now()));
    try {
      const saved = await notes.keep(notesFrom(await extract(learnPrompt(talk, known, `${today}, ${weekday}`, daysAround(now()))), talk));
      if (saved.length) lastBatch = saved;
      log({ at: new Date(now()).toISOString(), learned: saved.map((n) => n.id) });
      return saved;
    } catch (e) {
      // The AI couldn't take it (a limit, say): the talk goes back, to be learned from with the next quiet spell.
      said = [...talk, ...said].slice(-KEEP_UNLEARNED);
      log({ at: new Date(now()).toISOString(), learnFailed: e.message });
      return [];
    }
  }

  return {
    /**
     * Takes one exchange of the conversation, unless it's off the record, and waits for a quiet spell to learn.
     * @param {string} you
     * @param {string} felix
     * @returns {Promise<void>}
     */
    async heard(you, felix) {
      if (!offRecord) said.push({ at: now(), you, felix });
      clearTimer(timer);
      timer = setTimer(() => { learn(); }, await idleMs());
    },
    learn,
    /** Keeps the rest of this conversation off the record, or puts it back on. @param {boolean} on */
    offRecord: (on) => { offRecord = on; },
    /** Whether this conversation is off the record. @returns {boolean} */
    isOffRecord: () => offRecord,
    /**
     * Forgets the last thing you said: it's taken out of what will be learned, or when it was already learned,
     * the notes from that last learning are deleted.
     * @returns {Promise<{ dropped: boolean, removed: Note[] }>}
     */
    async forgetLast() {
      if (said.length) {
        said.pop();
        return { dropped: true, removed: [] };
      }
      const removed = lastBatch;
      lastBatch = [];
      await notes.remove(removed.map((n) => n.id));
      return { dropped: false, removed };
    },
  };
}
