import { test } from "node:test";
import assert from "node:assert/strict";
import { createCache } from "../felix-cache.mjs";

/**
 * A cache over a counting loader, on a clock the test moves.
 * @param {object} [options]
 */
function counted(options = {}) {
  let clock = 1_000_000;
  const loads = [];
  const cache = createCache({
    load: async (arg) => {
      loads.push(arg);
      if (arg?.fail) throw new Error("GitHub is down");
      return { n: loads.length, arg };
    },
    freshMs: 60_000,
    staleMs: 300_000,
    now: () => clock,
    ...options,
  });
  return { cache, loads, later: (ms) => { clock += ms; } };
}

test("fresh data comes from the cache, stamped with when it was loaded", async () => {
  const { cache, loads, later } = counted();
  const first = await cache.get();
  assert.equal(first.fetchedAt, new Date(1_000_000).toISOString());
  later(59_000);
  assert.equal(await cache.get(), first);
  assert.equal(loads.length, 1);
});

test("older data comes back at once while a new copy loads, and too old waits for one", async () => {
  const { cache, loads, later } = counted();
  await cache.get();
  later(61_000);
  assert.equal((await cache.get()).n, 1);
  await new Promise((r) => setImmediate(r));
  assert.equal(loads.length, 2);
  assert.equal((await cache.get()).n, 2);
  later(301_000);
  assert.equal((await cache.get()).n, 3);
});

test("loads asked for together share one request, and a refresh always loads", async () => {
  const { cache, loads } = counted();
  const [a, b] = await Promise.all([cache.get(), cache.refresh()]);
  assert.equal(a, b);
  assert.equal(loads.length, 1);
  assert.equal((await cache.refresh()).n, 2);
});

test("each key has its own copy, and only the latest few keys are kept", async () => {
  const { cache, loads } = counted({ key: (arg) => `${arg.repo}#${arg.number}` });
  await cache.get({ repo: "fm", number: 1 });
  await cache.get({ repo: "bm", number: 1 });
  await cache.get({ repo: "fm", number: 1 });
  assert.equal(loads.length, 2);
  for (let i = 2; i < 60; i++) await cache.get({ repo: "fm", number: i });
  assert.equal(loads.length, 60);
  await cache.get({ repo: "fm", number: 1 });
  assert.equal(loads.length, 61);
});

test("a failed load isn't kept, so the next ask tries again", async () => {
  const { cache, loads } = counted();
  await assert.rejects(cache.get({ fail: true }), /down/);
  await assert.rejects(cache.get({ fail: true }), /down/);
  assert.equal(loads.length, 2);
});

test("when a reload behind older data fails, the older data is still there", async () => {
  let clock = 0;
  let fail = false;
  const cache = createCache({ load: async () => { if (fail) throw new Error("down"); return { ok: true }; }, freshMs: 10, staleMs: 100, now: () => clock });
  const first = await cache.get();
  fail = true;
  clock = 50;
  assert.equal(await cache.get(), first);
  await new Promise((r) => setImmediate(r));
  assert.equal(await cache.get(), first);
});

test("data that isn't a plain object, or already says when it was read, is kept as is", async () => {
  for (const value of [[1, 2], "text", null, { fetchedAt: "2026-10-29T00:00:00Z", x: 1 }]) {
    const cache = createCache({ load: async () => value, freshMs: 1000, staleMs: 2000 });
    assert.deepEqual(await cache.get(), value);
  }
});
