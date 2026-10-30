import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { MEMORY_RULES, cardOf, createMemory } from "../felix-memory.mjs";

/**
 * A memory folder with a few cards in it.
 * @returns {Promise<{ dir: string, memory: ReturnType<typeof createMemory>, write: (file: string, text: string) => Promise<void> }>}
 */
async function withCards() {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-memory-"));
  const write = async (file, text) => {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), text);
  };
  await write("README.md", "# Felix's memory\n[[zorblat]]: payments lead\n");
  await write("people/zorblat.md", "# Zorblat\naka: Zee, z-man\nLeads payments. Reviews [[fm]].\n- 2026-10-29: prefers async reviews.\n");
  await write("repos/fm.md", "# fm\nThe frontend monorepo, owned by [[zorblat]] and [[quixotl]].\n");
  await write("people/quixotl.md", "# Quixotl\nDesigner on [[fm]].\n");
  await write("people/lonely.md", "# Lonely\n");
  return { dir, memory: createMemory({ dir }), write };
}

test("a card has its name, its other names, its first line and its links", () => {
  const card = cardOf("/m/people/Zorblat.md", "# Zorblat\naka: Zee, z-man\n\nLeads payments. Reviews [[fm]] and [[Zorblat]] and [[fm|the repo]].\n");
  assert.equal(card.name, "zorblat");
  assert.deepEqual(card.names, ["zorblat", "zee", "z-man"]);
  assert.equal(card.line, "Leads payments. Reviews [[fm]] and [[Zorblat]] and [[fm|the repo]].");
  assert.deepEqual(card.links, ["fm"]);
  assert.equal(cardOf("/m/x.md", "# Only a title").line, "Only a title");
});

test("a question carries the cards it names, by any of their names, and a line about each linked card", async () => {
  const { dir, memory } = await withCards();
  const found = await memory.around("what does Zee think about the release?");
  assert.match(found, /^From your memory:\n\n# Zorblat/);
  assert.match(found, /Linked to those:\n- \[\[fm\]\]: The frontend monorepo/);
  assert.doesNotMatch(found, /# Quixotl/);
  assert.equal(await memory.around("who's on call?"), "");
  assert.equal(await memory.around("zorblatty"), "");
  assert.match(await memory.around("is quixotl around"), /\[\[fm\]\]/);
  await rm(dir, { recursive: true });
});

test("the index is read right away and cut to size, and an empty memory has none", async () => {
  const { dir, memory, write } = await withCards();
  assert.match(memory.index(), /\[\[zorblat\]\]: payments lead/);
  await write("README.md", "x".repeat(3000));
  assert.equal(memory.index().length, 2000);
  assert.equal(createMemory({ dir: path.join(dir, "missing") }).index(), "");
  assert.equal(await createMemory({ dir: path.join(dir, "missing") }).around("zorblat"), "");
  await rm(dir, { recursive: true });
});

test("Felix sees which cards the AI saved, added or took out, but not the index", async () => {
  const { dir, memory, write } = await withCards();
  const before = await memory.snapshot();
  await write("people/new.md", "# New\n");
  await write("README.md", "changed");
  const later = new Date(Date.now() + 5000);
  await utimes(path.join(dir, "repos/fm.md"), later, later);
  await rm(path.join(dir, "people/lonely.md"));
  assert.deepEqual(await memory.changedSince(before), ["fm", "lonely", "new"]);
  await rm(dir, { recursive: true });
});

test("the memory rules keep secrets and live work data out", () => {
  assert.match(MEMORY_RULES, /Never save secrets/);
  assert.match(MEMORY_RULES, /under 2,000 characters/);
});
