/**
 * Your own ways of saying Felix's commands. When something you say isn't a command Felix knows, but his AI works out
 * it meant one ("I'm heading out" for "end my day"), Felix offers to remember it; after your yes, the phrase runs
 * that command right here next time, with no AI. They're kept in data/felix/phrases.json, and Settings lists them
 * to remove.
 */
import { readFile, rename, writeFile } from "node:fs/promises";
import { normalize } from "./felix-commands.mjs";

const MAX = 200;

/**
 * The commands the AI may map a phrase to: one way of saying each local command. A phrase only ever runs one of
 * these, through the same matcher as if you'd said it.
 */
export const COMMAND_PHRASES = Object.freeze([
  "who's on call", "who's on call next", "when's my next shift", "what's waiting on my review", "what's failing", "how are my PRs doing",
  "how much usage is left", "what's playing", "play", "pause", "next song", "turn on auto refresh", "turn off auto refresh",
  "switch to work", "switch to personal", "start my day", "take a break", "i'm back", "end my day", "what's my next meeting",
  "what's on my calendar today", "what's on my plate", "who's out today", "what tasks are due today", "what do you know about me",
  "open settings", "show my PRs with conflicts", "show my PRs with failing checks",
]);

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
 * Creates the learned-phrases store.
 * @param {{ file: string, now?: () => number, read?: (file: string) => Promise<string>, write?: (file: string, text: string) => Promise<void> }} options
 */
export function createPhrases({ file, now = Date.now, read = (f) => readFile(f, "utf8"), write = writeAtomic }) {
  /** @type {Array<{ phrase: string, command: string, at: string }> | null} */
  let list = null;
  const load = async () => {
    list ||= await read(file).then((t) => JSON.parse(t).phrases || [], () => []);
    return list;
  };
  const save = () => write(file, `${JSON.stringify({ phrases: list }, null, 2)}\n`);

  return {
    /** Every learned phrase, newest first. @returns {Promise<Array<{ phrase: string, command: string, at: string }>>} */
    all: async () => [...(await load())].reverse(),
    /**
     * Remembers that a phrase means a command, replacing what it meant before.
     * @param {string} phrase As you said it.
     * @param {string} command One of COMMAND_PHRASES.
     * @returns {Promise<boolean>} False when the command isn't one Felix knows, or the phrase is empty.
     */
    async learn(phrase, command) {
      const key = normalize(phrase);
      if (!key || !COMMAND_PHRASES.includes(command)) return false;
      const kept = (await load()).filter((p) => p.phrase !== key);
      list = [...kept, { phrase: key, command, at: new Date(now()).toISOString() }].slice(-MAX);
      await save();
      return true;
    },
    /**
     * The command a phrase was learned for, if it was.
     * @param {string} said
     * @param {string} [name] What you call Felix.
     * @param {string} [wake] Your activation phrase.
     * @returns {Promise<string | null>}
     */
    async commandFor(said, name, wake) {
      const key = normalize(said, name, wake);
      return (await load()).find((p) => p.phrase === key)?.command || null;
    },
    /**
     * Forgets a learned phrase.
     * @param {string} phrase
     * @returns {Promise<boolean>} Whether there was one.
     */
    async remove(phrase) {
      const before = (await load()).length;
      list = list.filter((p) => p.phrase !== normalize(phrase));
      if (list.length === before) return false;
      await save();
      return true;
    },
  };
}
