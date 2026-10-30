import { test } from "node:test";
import assert from "node:assert/strict";
import { ENTER_MS, FADE_MS, STAGGER_CAP, STAGGER_MS, entranceMs, optimistic, sk, skeletonHtml } from "../public/card-load.mjs";

test("a skeleton is marked for the entrance, says it's loading, and hides its shapes from screen readers", () => {
  const whole = skeletonHtml(sk.line(40));
  assert.match(whole, /data-skeleton=""/);
  assert.match(whole, /role="status" aria-label="Loading"/);
  assert.match(whole, /aria-hidden="true"/);
  assert.match(skeletonHtml(sk.line(40), "rels"), /data-skeleton="rels"/);
});

test("skeleton shapes take pixels as numbers and any CSS length as text", () => {
  assert.match(sk.line(40, 10), /width:40px;height:10px/);
  assert.match(sk.line("60%"), /width:60%;height:11px/);
  assert.match(sk.circle(8), /sk-circle" style="width:8px;height:8px/);
  assert.match(sk.pill(), /sk-pill/);
  assert.match(sk.row([sk.circle(8), sk.fill], { gap: 8, cls: "x" }), /^<div class="sk-row x" style="gap:8px">/);
});

test("the entrance staggers only the first rows, so a long list doesn't take long", () => {
  assert.equal(entranceMs(1), ENTER_MS);
  assert.equal(entranceMs(3), 2 * STAGGER_MS + ENTER_MS);
  assert.equal(entranceMs(40), STAGGER_CAP * STAGGER_MS + ENTER_MS);
  assert.ok(entranceMs(40) < 700);
  assert.equal(entranceMs(40, true), FADE_MS);
});

test("an optimistic change shows at once and stays when the server agrees", async () => {
  const card = { ticked: false };
  const said = [];
  let sent;
  const done = optimistic({
    key: "a",
    apply: () => { card.ticked = true; return () => { card.ticked = false; }; },
    send: () => new Promise((resolve) => { sent = resolve; }),
    fail: "Couldn't tick it",
    toast: (t) => said.push(t),
  });
  assert.equal(card.ticked, true, "shown before the server answers");
  sent({ saved: true });
  assert.deepEqual(await done, { ok: true, value: { saved: true } });
  assert.equal(card.ticked, true);
  assert.deepEqual(said, []);
});

test("an optimistic change is put back with a plain note when the server says no", async () => {
  const card = { ticked: false };
  const said = [];
  const done = await optimistic({
    key: "b",
    apply: () => { card.ticked = true; return () => { card.ticked = false; }; },
    send: async () => { throw new Error("The server answered 500."); },
    fail: (e) => `Couldn't tick it (${e.message.length})`,
    toast: (t, detail) => said.push([t, detail]),
  });
  assert.equal(done.ok, false);
  assert.equal(card.ticked, false);
  assert.deepEqual(said, [["Couldn't tick it (24)", "The server answered 500."]]);
});

test("a second tap on the same thing while the first is on its way is ignored", async () => {
  let sends = 0;
  let finish;
  const change = () => optimistic({ key: "c", apply: () => {}, send: () => { sends++; return new Promise((r) => { finish = r; }); }, fail: "", toast: () => {} });
  const first = change();
  assert.deepEqual(await change(), { ok: false, skipped: true });
  finish();
  await first;
  assert.equal(sends, 1);
  change();
  assert.equal(sends, 2, "free again once the first is done");
  finish();
});
