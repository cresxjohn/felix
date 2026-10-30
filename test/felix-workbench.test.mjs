import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWorkbench, gitRunner, parseStatus } from "../felix-workbench.mjs";

/**
 * A pretend Felix repo with a committed file, a new one, an ignored one and an editor folder, and a workbench for it.
 * @returns {Promise<{ repo: string, dir: string, bench: ReturnType<typeof createWorkbench>, done: () => Promise<void> }>}
 */
async function withRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "felix-bench-"));
  const repo = path.join(root, "felix");
  const dir = path.join(root, "workbench");
  await mkdir(path.join(repo, "public"), { recursive: true });
  await mkdir(path.join(repo, "Untitled"), { recursive: true });
  const git = (...args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git("init", "-q");
  git("config", "user.email", "t@t");
  git("config", "user.name", "t");
  await writeFile(path.join(repo, ".gitignore"), "data/\n");
  await writeFile(path.join(repo, "server.mjs"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "start");
  await writeFile(path.join(repo, "public/home.html"), "<p>home</p>\n");
  await mkdir(path.join(repo, "data"), { recursive: true });
  await writeFile(path.join(repo, "data/secret.json"), "{}");
  await writeFile(path.join(repo, "Untitled/x.txt"), "editor");
  return { repo, dir, bench: createWorkbench({ repo, dir, skip: ["Untitled"] }), done: () => rm(root, { recursive: true, force: true }) };
}

test("the workbench is a copy of Felix, without its data or the editor's folder, with no changes of its own", async () => {
  const { repo, dir, bench, done } = await withRepo();
  assert.equal(await bench.sync(), true);
  assert.equal(await readFile(path.join(dir, "public/home.html"), "utf8"), "<p>home</p>\n");
  assert.equal(existsSync(path.join(dir, "data/secret.json")), false);
  assert.equal(existsSync(path.join(dir, "Untitled")), false);
  assert.equal(existsSync(bench.memory), true);
  assert.deepEqual(await bench.changes(), []);
  await writeFile(path.join(repo, "server.mjs"), "two\n");
  await rm(path.join(repo, "public/home.html"));
  assert.equal(await bench.sync(), true);
  assert.equal(await readFile(path.join(dir, "server.mjs"), "utf8"), "two\n");
  assert.equal(existsSync(path.join(dir, "public/home.html")), false);
  assert.equal(await bench.sync(), true);
  await done();
});

test("changes in the workbench stay there until applied, then reach Felix uncommitted; memory never does", async () => {
  const { repo, dir, bench, done } = await withRepo();
  await bench.sync();
  await writeFile(path.join(dir, "server.mjs"), "built by felix\n");
  await writeFile(path.join(dir, "widget.js"), "new\n");
  await writeFile(path.join(bench.memory, "README.md"), "remember\n");
  assert.deepEqual(await bench.changes(), [{ path: "server.mjs", status: "changed" }, { path: "widget.js", status: "added" }]);
  await writeFile(path.join(repo, "server.mjs"), "one\n");
  assert.equal(await bench.sync(), false);
  assert.match(await bench.diff(), /built by felix/);
  assert.deepEqual((await bench.apply()).map((c) => c.path), ["server.mjs", "widget.js"]);
  assert.equal(await readFile(path.join(repo, "server.mjs"), "utf8"), "built by felix\n");
  assert.equal(await readFile(path.join(repo, "widget.js"), "utf8"), "new\n");
  assert.equal(execFileSync("git", ["log", "--oneline"], { cwd: repo, encoding: "utf8" }).trim().split("\n").length, 1);
  assert.deepEqual(await bench.changes(), []);
  assert.deepEqual(await bench.apply(), []);
  assert.equal(await readFile(path.join(bench.memory, "README.md"), "utf8"), "remember\n");
  await done();
});

test("a patch that doesn't fit Felix changes nothing, and discarding drops the workbench's changes but keeps memory", async () => {
  const { repo, dir, bench, done } = await withRepo();
  await bench.sync();
  await writeFile(path.join(dir, "server.mjs"), "felix's version\n");
  await writeFile(path.join(repo, "server.mjs"), "your version\n");
  await assert.rejects(bench.apply());
  assert.equal(await readFile(path.join(repo, "server.mjs"), "utf8"), "your version\n");
  await writeFile(path.join(bench.memory, "card.md"), "# Card\n");
  await writeFile(path.join(dir, "scratch.txt"), "x");
  await bench.discard();
  assert.deepEqual(await bench.changes(), []);
  assert.equal(await readFile(path.join(dir, "server.mjs"), "utf8"), "one\n");
  assert.equal(existsSync(path.join(bench.memory, "card.md")), true);
  await done();
});

test("git's status reads as added, changed and deleted, and renames take two parts", () => {
  assert.deepEqual(parseStatus("?? a.js\0 M b.js\0 D c.js\0R  d.js\0old.js\0A  e.js\0"), [
    { path: "a.js", status: "added" }, { path: "b.js", status: "changed" }, { path: "c.js", status: "deleted" },
    { path: "d.js", status: "changed" }, { path: "e.js", status: "added" },
  ]);
});

test("git failures come back in git's own words", async () => {
  const git = gitRunner();
  await assert.rejects(git(tmpdir(), ["not-a-command"]), /not-a-command/);
  const quiet = gitRunner(() => {
    const proc = Object.assign(new EventEmitter(), { stdin: { end: () => {} } });
    setImmediate(() => proc.emit("close", 1));
    return proc;
  });
  await assert.rejects(quiet(tmpdir(), ["status"]), /git status failed/);
});
