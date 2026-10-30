/**
 * How the home cards load and change: a skeleton shaped like a card's content while its first data loads, the
 * entrance that plays once when real content takes the skeleton's place, and optimistic changes.
 *
 * The entrance: each top-level row of the card's body (or each row of a block marked `data-rows`) fades in with a
 * small downward settle, top to bottom, a few dozen milliseconds apart. Only the first rows are staggered; the rest
 * come in together. It plays only when content replaces a skeleton, never on a refresh, a redraw after a setting or
 * a live update. A redraw while it plays carries on where it was (a negative delay), so nothing flickers. The timing
 * lives in CSS (`.entering .ent`, with `--i` and `--t`); this file only numbers the rows.
 *
 * A skeleton is `skeletonHtml(...)`: the whole body (`data-skeleton=""`), or one part of it that loads on its own
 * (`data-skeleton="rels"`), whose content then carries `data-part="rels"`.
 */

/** Milliseconds between one row's start and the next's. */
export const STAGGER_MS = 38;
/** One row's fade and settle. */
export const ENTER_MS = 260;
/** With reduced motion: one quick fade for everything, no movement. */
export const FADE_MS = 140;
/** Rows after this many come in together with the last staggered one. */
export const STAGGER_CAP = 8;

const px = (v) => (typeof v === "number" ? `${v}px` : v);

/**
 * Skeleton shapes. Each returns markup; sizes are pixels when numbers, else any CSS length ("60%").
 */
export const sk = {
  /** A line of text. */
  line: (w = "70%", h = 11) => `<i class="sk" style="width:${px(w)};height:${px(h)}"></i>`,
  /** A line that takes the rest of its row, like a title between a key and a status. */
  grow: (h = 11) => `<i class="sk sk-grow" style="height:${px(h)}"></i>`,
  /** A dot, a face or a round check. */
  circle: (d = 16) => `<i class="sk sk-circle" style="width:${px(d)};height:${px(d)}"></i>`,
  /** A big figure or a tile. */
  block: (w, h) => `<i class="sk sk-block" style="width:${px(w)};height:${px(h)}"></i>`,
  /** A chip, a status or a button. */
  pill: (w = 64, h = 22) => `<i class="sk sk-pill" style="width:${px(w)};height:${px(h)}"></i>`,
  /** Shapes side by side; `sk.fill` between them pushes the rest to the right. */
  row: (parts, { gap = 10, cls = "" } = {}) => `<div class="sk-row${cls ? ` ${cls}` : ""}" style="gap:${px(gap)}">${parts.join("")}</div>`,
  /** Shapes stacked. */
  col: (parts, { gap = 6, cls = "" } = {}) => `<div class="sk-col${cls ? ` ${cls}` : ""}" style="gap:${px(gap)}">${parts.join("")}</div>`,
  /** Free space in a row. */
  fill: `<span class="sk-fill"></span>`,
  /** A divider like the card's own. */
  sep: `<div class="sk-sep"></div>`,
  /** The card's foot: "Updated …" on the right. */
  foot: (w = 92) => `<div class="sk-foot"><i class="sk" style="width:${px(w)};height:10px"></i></div>`,
};

/**
 * A skeleton: the whole card body, or a named part that loads by itself.
 * @param {string} inner Shapes from `sk`.
 * @param {string} [part] The part's name, matching `data-part` on its real content.
 * @returns {string}
 */
export const skeletonHtml = (inner, part = "") => `<div class="sk-wrap" data-skeleton="${part}" role="status" aria-label="Loading">`
  + `<div class="sk-in" aria-hidden="true">${inner}</div></div>`;

const reduced = () => Boolean(globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches);

/**
 * How long an entrance of `rows` rows takes.
 * @param {number} rows
 * @param {boolean} [calm] Reduced motion.
 * @returns {number} Milliseconds.
 */
export function entranceMs(rows, calm = false) {
  if (calm) return FADE_MS;
  return Math.min(Math.max(rows - 1, 0), STAGGER_CAP) * STAGGER_MS + ENTER_MS;
}

/** Each body's entrances under way, by part ("" for the whole body). */
const bodies = new WeakMap();

const shown = (el) => el.getClientRects().length > 0;

/**
 * Numbers a root's rows for the entrance, `elapsed` milliseconds in.
 * @param {HTMLElement} root
 * @param {number} elapsed
 * @returns {number} How long the whole entrance takes.
 */
function mark(root, elapsed) {
  for (const el of root.querySelectorAll(".ent")) el.classList.remove("ent");
  const rows = [];
  for (const el of root.children) {
    if (!shown(el)) continue;
    if (el.hasAttribute("data-rows")) rows.push(...[...el.children].filter(shown));
    else rows.push(el);
  }
  rows.forEach((el, i) => {
    el.classList.add("ent");
    el.style.setProperty("--i", String(Math.min(i, STAGGER_CAP)));
  });
  root.style.setProperty("--t", `${Math.round(elapsed)}ms`);
  root.classList.add("entering");
  return entranceMs(rows.length, reduced());
}

const partRoot = (body, key) => (key ? body.querySelector(`[data-part="${CSS.escape(key)}"]`) : body);
const skeletonKeys = (body) => new Set([...body.querySelectorAll("[data-skeleton]")].map((el) => el.dataset.skeleton));

/**
 * The state kept for a body, with the listener that ends an entrance once its last row is in.
 * @param {HTMLElement} body
 */
function stateOf(body) {
  let st = bodies.get(body);
  if (st) return st;
  st = { parts: new Map(), skeleton: "" };
  bodies.set(body, st);
  body.addEventListener("animationend", (e) => {
    if (e.animationName !== "card-enter" && e.animationName !== "card-fade") return;
    const now = performance.now();
    for (const [key, part] of st.parts) {
      if (now - part.at < part.ms - 40) continue;
      st.parts.delete(key);
      partRoot(body, key)?.classList.remove("entering");
    }
  });
  return st;
}

/**
 * Draws a card body. When it replaces a skeleton (the whole body's, or a part's), that content comes in from top
 * to bottom; any other draw just shows the content.
 * @param {HTMLElement | null} body
 * @param {string} html
 */
export function paint(body, html) {
  if (!body) return;
  const st = stateOf(body);
  // The same skeleton again (a load starting with nothing to show yet) is left alone, so its pulse runs on.
  if (st.skeleton && st.skeleton === html && body.querySelector(":scope > [data-skeleton]")) return;
  const before = skeletonKeys(body);
  body.innerHTML = html;
  const after = skeletonKeys(body);
  st.skeleton = after.has("") ? html : "";
  const now = performance.now();
  for (const key of before) if (!after.has(key)) st.parts.set(key, { at: now, ms: Infinity });
  for (const [key, part] of st.parts) {
    const root = partRoot(body, key);
    const elapsed = now - part.at;
    if (!root || elapsed >= part.ms) {
      st.parts.delete(key);
      root?.classList.remove("entering");
      continue;
    }
    part.ms = mark(root, elapsed);
  }
  if (!st.parts.has("")) body.classList.remove("entering");
}

/**
 * Numbers a body's rows again while its entrance plays, for a card that fills parts of itself in after drawing
 * (the Journal's prompt and faces), so those come in with the rest. Does nothing once the entrance is over.
 * @param {HTMLElement | null} body
 */
export function settle(body) {
  const st = body && bodies.get(body);
  if (!st) return;
  const now = performance.now();
  for (const [key, part] of st.parts) {
    const root = partRoot(body, key);
    if (root && now - part.at < part.ms) part.ms = mark(root, now - part.at);
  }
}

/** Changes on their way to the server, by key, so a second tap on the same thing is ignored. */
const pending = new Set();

/**
 * Whether a change with this key is on its way.
 * @param {string} key
 * @returns {boolean}
 */
export const isPending = (key) => pending.has(key);

/**
 * An optimistic change: shows it at once, sends it, and on failure puts the card back and says so. A second change
 * with the same key while the first is on its way is ignored.
 * @template T
 * @param {{
 *   key: string,
 *   apply: () => (() => void) | void,
 *   send: () => Promise<T>,
 *   fail: string | ((e: Error) => string),
 *   toast?: (text: string, detail: string) => void,
 * }} change `apply` changes the card's data, redraws, and returns how to undo that; `fail` is the plain words for
 *   the toast, like "Couldn't tick Milk"; `toast` defaults to Felix's own.
 * @returns {Promise<{ ok: true, value: T } | { ok: false, error?: Error, skipped?: true }>}
 */
export async function optimistic({ key, apply, send, fail, toast }) {
  if (pending.has(key)) return { ok: false, skipped: true };
  pending.add(key);
  let undo;
  try {
    undo = apply();
    return { ok: true, value: await send() };
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e));
    try { undo?.(); } catch {}
    const text = typeof fail === "function" ? fail(error) : fail;
    const say = toast || ((t, detail) => globalThis.FelixShell?.toast(t, { tone: "bad", detail }));
    say(text, error.message);
    return { ok: false, error };
  } finally {
    pending.delete(key);
  }
}
