import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createWatchers, firedText, parseWatch, watcherText } from "../felix-watch.mjs";

const prs = (over = {}) => ({
  yourPrs: [{ ref: "fm#1", checks: "pending", failingChecks: [], readyToMerge: false, approvedBy: [], ...over }],
  waitingOnYourReview: [{ ref: "bm#2", checks: "passing", approvedBy: ["brian.cruz"] }],
  reviewedEarlier: [],
});

test("what a 'tell me when' asks for: checks passing or failing, an approval (by someone), or ready to merge", () => {
  assert.deepEqual(parseWatch("ci passes on fm#123"), { kind: "checks-pass", who: null, ref: "fm#123" });
  assert.deepEqual(parseWatch("the checks are green on BM 7"), { kind: "checks-pass", who: null, ref: "bm#7" });
  assert.deepEqual(parseWatch("the build fails"), { kind: "checks-fail", who: null, ref: null });
  assert.deepEqual(parseWatch("brian approves it"), { kind: "approved", who: "brian", ref: null });
  assert.deepEqual(parseWatch("someone approves fm#9"), { kind: "approved", who: null, ref: "fm#9" });
  assert.deepEqual(parseWatch("fm#9 gets approved"), { kind: "approved", who: null, ref: "fm#9" });
  assert.deepEqual(parseWatch("it's ready to merge"), { kind: "ready", who: null, ref: null });
  assert.equal(parseWatch("the weather changes"), null);
  assert.equal(parseWatch(undefined), null);
});

test("a watcher comes true from the Open PRs data, and a PR that's gone ends its watcher too", () => {
  const w = (kind, extra = {}) => ({ id: "w", ref: "fm#1", kind, at: "", ...extra });
  assert.equal(firedText(w("checks-pass"), prs()), null);
  assert.equal(firedText(w("checks-pass"), prs({ checks: "passing" })), "Checks passed on fm#1.");
  assert.equal(firedText(w("checks-fail"), prs({ checks: "failing", failingChecks: ["lint", "e2e"] })), "Checks are failing on fm#1: lint, e2e.");
  assert.equal(firedText(w("checks-fail"), prs({ checks: "failing" })), "Checks are failing on fm#1.");
  assert.equal(firedText(w("ready"), prs({ readyToMerge: true })), "fm#1 is ready to merge.");
  assert.equal(firedText({ ...w("approved", { who: "brian" }), ref: "bm#2" }, prs()), "brian.cruz approved bm#2.");
  assert.equal(firedText({ ...w("approved", { who: "anna" }), ref: "bm#2" }, prs()), null);
  assert.equal(firedText({ ...w("approved"), ref: "bm#2" }, prs()), "brian.cruz approved bm#2.");
  assert.match(firedText({ ...w("ready"), ref: "fm#404" }, prs()), /isn't in your open PRs anymore/);
  assert.equal(firedText(w("ready"), {}), "fm#1 isn't in your open PRs anymore, so I stopped watching it. It may have merged or closed.");
});

test("watchers read the way you'd say them", () => {
  assert.equal(watcherText({ ref: "fm#1", kind: "checks-pass" }), "checks passing on fm#1");
  assert.equal(watcherText({ ref: "fm#1", kind: "checks-fail" }), "checks failing on fm#1");
  assert.equal(watcherText({ ref: "fm#1", kind: "ready" }), "ready to merge on fm#1");
  assert.equal(watcherText({ ref: "fm#1", kind: "approved", who: "brian" }), "Brian's approval on fm#1");
  assert.equal(watcherText({ ref: "fm#1", kind: "approved", who: null }), "an approval on fm#1");
});

test("the store adds (once), checks, tells what came true once, and cancels one PR's or all", async () => {
  const writes = [];
  const store = createWatchers({ file: "w.json", now: () => Date.parse("2026-10-30T02:00:00Z"), read: async () => "{}", write: async (_f, t) => { writes.push(t); } });
  const a = await store.add({ ref: "fm#1", kind: "checks-pass" });
  assert.equal(a.at, "2026-10-30T02:00:00.000Z");
  assert.equal((await store.add({ ref: "fm#1", kind: "checks-pass" })).id, a.id, "the same watcher isn't added twice");
  await store.add({ ref: "bm#2", kind: "approved", who: "anna" });
  assert.equal((await store.all()).length, 2);
  assert.deepEqual(await store.check(prs()), []);
  const fired = await store.check(prs({ checks: "passing" }));
  assert.deepEqual(fired.map((f) => f.text), ["Checks passed on fm#1."]);
  assert.deepEqual(store.takeFired().map((f) => f.ref), ["fm#1"]);
  assert.deepEqual(store.takeFired(), []);
  assert.equal((await store.all()).length, 1);
  assert.equal(await store.cancel("fm#9"), 0);
  assert.equal(await store.cancel(null), 1);
  assert.deepEqual(await store.all(), []);
  assert.ok(writes.length >= 3);
});

test("watchers are saved to disk and survive a restart", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-watch-"));
  const file = path.join(dir, "watchers.json");
  await createWatchers({ file }).add({ ref: "fm#1", kind: "ready" });
  assert.equal((await createWatchers({ file }).all())[0].ref, "fm#1");
  await rm(dir, { recursive: true, force: true });
});

test("'it's approved' and 'there's an approval' name nobody", () => {
  assert.deepEqual(parseWatch("it's approved"), { kind: "approved", who: null, ref: null });
  assert.deepEqual(parseWatch("there's an approval on fm#3"), { kind: "approved", who: null, ref: "fm#3" });
});
