import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { GROUPS } from "../public/settings-schema.mjs";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
/**
 * Runs a browser script from public/ and returns the global it sets on window.
 * @param {string} file
 * @param {string} name
 * @returns {object}
 */
function loadGlobal(file, name) {
  const sandbox = { window: {} };
  vm.runInNewContext(readFileSync(path.join(PUBLIC, file), "utf8"), sandbox);
  return sandbox.window[name];
}

const { COLUMNS, LAYOUTS, placementStyle, rowCount } = loadGlobal("layout.js", "FelixLayout");
const { CARDS } = loadGlobal("cards.js", "FelixCards");
const MODES = Object.entries(LAYOUTS);

/**
 * Every grid cell a card covers, as "column,row".
 * @param {{ x: number, y: number, w: number, h: number }} spot
 * @returns {string[]}
 */
function cells({ x, y, w, h }) {
  return Array.from({ length: w * h }, (_, i) => `${x + (i % w)},${y + Math.floor(i / w)}`);
}

/**
 * A layout as { id: [x, y, w, h] }, for comparing with a mock-up.
 * @param {ReadonlyArray<{ id: string, x: number, y: number, w: number, h: number }>} layout
 * @returns {Record<string, number[]>}
 */
const spots = (layout) => Object.fromEntries(layout.map((s) => [s.id, [s.x, s.y, s.w, s.h]]));

test("the grid has 12 columns and a layout for both modes", () => {
  assert.equal(COLUMNS, 12);
  assert.deepEqual(Object.keys(LAYOUTS).sort(), ["personal", "work"]);
});

for (const [mode, layout] of MODES) {
  test(`${mode}: every card sits inside the columns with whole sizes`, () => {
    for (const s of layout) {
      for (const n of [s.x, s.y, s.w, s.h]) assert.ok(Number.isInteger(n) && n >= 1, `${s.id}: ${n}`);
      assert.ok(s.x + s.w - 1 <= COLUMNS, `${s.id} runs past column ${COLUMNS}`);
    }
  });

  test(`${mode}: card ids are unique and no two cards overlap`, () => {
    assert.equal(new Set(layout.map((s) => s.id)).size, layout.length);
    const seen = new Map();
    for (const s of layout) {
      for (const c of cells(s)) {
        assert.ok(!seen.has(c), `${s.id} overlaps ${seen.get(c)} at ${c}`);
        seen.set(c, s.id);
      }
    }
  });

  test(`${mode}: the layout leaves no gaps`, () => {
    const covered = layout.reduce((n, s) => n + s.w * s.h, 0);
    assert.equal(covered, COLUMNS * rowCount(layout));
  });
}

test("the work layout follows the Work mock-up", () => {
  assert.deepEqual(spots(LAYOUTS.work), {
    ic: [1, 1, 3, 1], jira: [4, 1, 3, 1], prs: [7, 1, 3, 1], ai: [10, 1, 3, 1],
    cal: [1, 2, 3, 1], ooo: [1, 3, 3, 1], slack: [4, 2, 3, 2], tasks: [7, 2, 6, 2],
  });
});

test("the personal layout follows the Personal mock-up", () => {
  assert.deepEqual(spots(LAYOUTS.personal), {
    myday: [1, 1, 3, 1], buddy: [4, 1, 3, 1], dates: [7, 1, 3, 1], timeoff: [10, 1, 3, 1],
    habits: [1, 2, 3, 1], bills: [1, 3, 3, 1], ptasks: [4, 2, 6, 2], lists: [10, 2, 3, 1], journal: [10, 3, 3, 1],
  });
});

test("rowCount counts the rows a layout reaches", () => {
  assert.equal(rowCount(LAYOUTS.work), 3);
  assert.equal(rowCount([{ y: 1, h: 1 }, { y: 2, h: 3 }]), 4);
});

test("placementStyle gives the wide spot and a medium width of twice the columns, at most the row", () => {
  assert.equal(placementStyle({ x: 4, y: 2, w: 3, h: 2 }), "--x:4;--y:2;--w:3;--h:2;--wm:6");
  assert.equal(placementStyle({ x: 7, y: 2, w: 6, h: 2 }), "--x:7;--y:2;--w:6;--h:2;--wm:12");
  assert.equal(placementStyle({ x: 1, y: 1, w: 12, h: 1 }), "--x:1;--y:1;--w:12;--h:1;--wm:12");
});

test("cards.js defines a card for every spot in both layouts, and every card to come has an example", () => {
  for (const [, layout] of MODES) {
    for (const s of layout) {
      const card = CARDS[s.id];
      assert.ok(card?.title && card.icon, `no card for ${s.id}`);
      if (card.soon) for (const k of ["about", "needs", "preview"]) assert.ok(card.soon[k], `${s.id} has no ${k}`);
    }
  }
});

test("Felix's check-ins and Tasks are the live personal cards, so personal mode loads only those", () => {
  assert.equal(LAYOUTS.personal.filter((s) => !CARDS[s.id].soon).map((s) => s.id).sort().join(", "), "buddy, ptasks");
});

test("every live card has its own group in Settings (both Tasks cards share one, and Felix's is Felix as a friend)", () => {
  const groups = new Set(GROUPS.map((g) => g.id));
  const shared = { ptasks: "tasks", buddy: "friend" };
  for (const [, layout] of MODES) {
    for (const s of layout.filter((x) => !CARDS[x.id].soon)) {
      const id = shared[s.id] || s.id;
      assert.ok(groups.has(id), `no Settings group for ${s.id}`);
    }
  }
});
