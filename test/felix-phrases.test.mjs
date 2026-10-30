import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { COMMAND_PHRASES, createPhrases } from "../felix-phrases.mjs";
import { matchCommand } from "../felix-commands.mjs";

test("every command the AI may map a phrase to is one Felix runs locally", () => {
  for (const c of COMMAND_PHRASES) assert.ok(matchCommand(c), c);
});

test("a learned phrase runs its command, by the same matcher, and can be replaced or removed", async () => {
  const writes = [];
  const phrases = createPhrases({ file: "p.json", now: () => Date.parse("2026-10-30T02:00:00Z"), read: async () => { throw new Error("none"); }, write: async (_f, t) => { writes.push(t); } });
  assert.deepEqual(await phrases.all(), []);
  assert.equal(await phrases.learn("I'm heading out", "end my day"), true);
  assert.equal(await phrases.commandFor("Hey Felix, I'm heading out!"), "end my day");
  assert.equal(await phrases.commandFor("Max, I'm heading out", "Max"), "end my day");
  assert.equal(await phrases.commandFor("heading somewhere"), null);
  assert.equal(await phrases.learn("I'm heading out", "take a break"), true);
  assert.equal(await phrases.commandFor("i'm heading out"), "take a break");
  assert.equal((await phrases.all()).length, 1);
  assert.equal(await phrases.learn("do the thing", "delete everything"), false, "only Felix's own commands");
  assert.equal(await phrases.learn("   ", "end my day"), false);
  assert.equal(JSON.parse(writes.at(-1)).phrases[0].at, "2026-10-30T02:00:00.000Z");
  assert.equal(await phrases.remove("I'm heading out."), true);
  assert.equal(await phrases.remove("nope"), false);
  assert.deepEqual(await phrases.all(), []);
});

test("learned phrases are saved to disk and read back", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-phrases-"));
  const file = path.join(dir, "phrases.json");
  await createPhrases({ file }).learn("brb", "take a break");
  assert.equal(await createPhrases({ file }).commandFor("brb"), "take a break");
  await rm(dir, { recursive: true, force: true });
});
