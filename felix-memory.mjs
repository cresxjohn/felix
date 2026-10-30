/**
 * Felix's memory: short note cards in a folder, one per thing worth keeping (a person, a repo, a service, a
 * decision, a preference), linked to each other with [[name]]. Felix's code builds the graph from those links,
 * with no AI call: when you ask about something that has a card, the question carries that card and a line
 * about each card linked to it. The index (README.md) is short and goes to the AI once, when a session starts;
 * every other card is read only when a question needs it, so memory costs almost nothing per question.
 * Felix's AI writes the cards itself, in its workbench, where edits are free.
 */
import { readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const INDEX = "README.md";
const INDEX_CHARS = 2000;
const CARD_CHARS = 900;
const LINE_CHARS = 140;
const MAX_CARDS = 3;
const MAX_NEIGHBORS = 6;
const LINK = /\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g;
const AKA = /^aka:\s*(.+)$/im;

export const MEMORY_RULES = [
  "Your memory (a hard rule on what goes in it):",
  "- It's the memory/ folder in your workbench: README.md is the index, and each card is one short markdown file, like memory/people/anna.md or memory/repos/fm.md.",
  "- A card starts with a \"# Name\" heading, then an optional \"aka: other names\" line, then a few lines. Link related cards with [[name]], like \"reviews [[fm]]\". Date what changes: \"2026-10-29: prefers async reviews\".",
  "- Save what lasts: who people are, what they own, my preferences, decisions and how-tos I tell you. Update or merge a card instead of adding a new one, and keep each under 900 characters.",
  "- Keep README.md under 2,000 characters: one line per card, \"[[name]]: what it's about\".",
  "- Never save secrets, tokens, passwords or keys, and never live work data (PR lists, on-call, releases, usage), since that's always read fresh.",
  "- When I ask you to forget something, take it out of the cards and the index.",
  "- Memory is saved the moment you write it, and it's never part of Apply; don't mention Apply for it.",
  "- Besides these cards, each message may carry notes Felix learned from your talks, each with the day it was said. When you use one, say when they told you (\"you told me on Oct 12\"). When they ask about something that's in neither, say you don't remember them telling you. Never guess, and never infer private things they didn't say.",
  "- When they say something is off the record, don't write it into a card.",
].join("\n");

/**
 * @typedef {{ name: string, file: string, text: string, line: string, links: string[], names: string[] }} Card
 */

/**
 * A card's name: its file name, lowercased.
 * @param {string} file
 * @returns {string}
 */
const nameOf = (file) => path.basename(file, ".md").toLowerCase();

/**
 * A card read from its file.
 * @param {string} file
 * @param {string} text
 * @returns {Card}
 */
export function cardOf(file, text) {
  const name = nameOf(file);
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const title = (lines.find((l) => l.startsWith("# ")) || "").slice(2).trim();
  const aka = (text.match(AKA)?.[1] || "").split(",").map((a) => a.trim().toLowerCase()).filter(Boolean);
  const line = lines.find((l) => !l.startsWith("#") && !AKA.test(l)) || title;
  return {
    name,
    file,
    text: text.trim(),
    line: line.slice(0, LINE_CHARS),
    links: [...new Set([...text.matchAll(LINK)].map((m) => nameOf(m[1].trim())))].filter((l) => l !== name),
    names: [...new Set([name, title.toLowerCase(), ...aka].filter((n) => n.length > 1))],
  };
}

/**
 * Whether the text names a card, as a whole word.
 * @param {string} text Lowercased.
 * @param {Card} card
 * @returns {boolean}
 */
const names = (text, card) => card.names.some((n) => new RegExp(`(^|[^\\p{L}\\d])${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\d])`, "u").test(text));

/**
 * Every markdown file in a folder and the folders inside it.
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function markdownIn(dir) {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries.filter((e) => e.isFile() && e.name.endsWith(".md")).map((e) => path.join(e.parentPath ?? e.path, e.name));
}

/**
 * Creates Felix's memory.
 * @param {{ dir: string }} options The memory folder.
 */
export function createMemory({ dir }) {
  /**
   * Every card, by name.
   * @returns {Promise<Map<string, Card>>}
   */
  async function cards() {
    const files = (await markdownIn(dir)).filter((f) => path.relative(dir, f) !== INDEX);
    const read = await Promise.all(files.map(async (f) => cardOf(f, await readFile(f, "utf8"))));
    return new Map(read.map((c) => [c.name, c]));
  }

  /**
   * The index, cut to its size limit; empty when there's none yet. It's read when a session starts, before the
   * session's rules are set, so it's read right away.
   * @returns {string}
   */
  function index() {
    try {
      return readFileSync(path.join(dir, INDEX), "utf8").trim().slice(0, INDEX_CHARS);
    } catch {
      return "";
    }
  }

  /**
   * What memory has on a question: the cards it names, and a line about each card linked to them, either way.
   * @param {string} question
   * @returns {Promise<string>} Empty when it names nothing Felix remembers.
   */
  async function around(question) {
    const all = await cards();
    const text = question.toLowerCase();
    const hits = [...all.values()].filter((c) => names(text, c)).slice(0, MAX_CARDS);
    if (!hits.length) return "";
    const seen = new Set(hits.map((c) => c.name));
    const near = new Set();
    for (const c of hits) {
      c.links.forEach((l) => near.add(l));
      for (const other of all.values()) if (other.links.includes(c.name)) near.add(other.name);
    }
    const neighbors = [...near].filter((n) => !seen.has(n) && all.has(n)).slice(0, MAX_NEIGHBORS).map((n) => `- [[${n}]]: ${all.get(n)?.line}`);
    return [
      "From your memory:",
      ...hits.map((c) => c.text.slice(0, CARD_CHARS)),
      neighbors.length ? `Linked to those:\n${neighbors.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }

  /**
   * When each memory file last changed.
   * @returns {Promise<Map<string, number>>}
   */
  async function snapshot() {
    const files = await markdownIn(dir);
    return new Map(await Promise.all(files.map(async (f) => /** @type {[string, number]} */ ([f, (await stat(f)).mtimeMs]))));
  }

  /**
   * The cards that changed, were added or were taken out since a snapshot; the index doesn't count.
   * @param {Map<string, number>} before
   * @returns {Promise<string[]>}
   */
  async function changedSince(before) {
    const after = await snapshot();
    const files = [...after].filter(([f, t]) => before.get(f) !== t).map(([f]) => f).concat([...before.keys()].filter((f) => !after.has(f)));
    return [...new Set(files.filter((f) => path.relative(dir, f) !== INDEX).map(nameOf))].sort();
  }

  return { index, around, snapshot, changedSince };
}
