// Where each home card sits on the 12-column grid, for each mode. One list, so the page and its tests agree.
window.FelixLayout = (() => {
  const COLUMNS = 12;

  /**
   * Each mode's default card spots: column x and row y (both from 1), w columns wide and h rows tall.
   * Listed in reading order, which is also the order on medium and narrow windows.
   * @type {Readonly<Record<"work" | "personal", ReadonlyArray<{ id: string, x: number, y: number, w: number, h: number }>>>}
   */
  const LAYOUTS = Object.freeze({
    work: Object.freeze([
      { id: "ic", x: 1, y: 1, w: 3, h: 1 },
      { id: "jira", x: 4, y: 1, w: 3, h: 1 },
      { id: "prs", x: 7, y: 1, w: 3, h: 1 },
      { id: "ai", x: 10, y: 1, w: 3, h: 1 },
      { id: "cal", x: 1, y: 2, w: 3, h: 1 },
      { id: "slack", x: 4, y: 2, w: 3, h: 2 },
      { id: "ooo", x: 1, y: 3, w: 3, h: 1 },
      { id: "tasks", x: 7, y: 2, w: 6, h: 2 },
    ]),
    personal: Object.freeze([
      { id: "myday", x: 1, y: 1, w: 3, h: 1 },
      { id: "buddy", x: 4, y: 1, w: 3, h: 1 },
      { id: "dates", x: 7, y: 1, w: 3, h: 1 },
      { id: "timeoff", x: 10, y: 1, w: 3, h: 1 },
      { id: "habits", x: 1, y: 2, w: 3, h: 1 },
      { id: "ptasks", x: 4, y: 2, w: 6, h: 2 },
      { id: "lists", x: 10, y: 2, w: 3, h: 1 },
      { id: "bills", x: 1, y: 3, w: 3, h: 1 },
      { id: "journal", x: 10, y: 3, w: 3, h: 1 },
    ]),
  });

  /**
   * The CSS variables that place a card: its spot on a wide window, and on a medium one twice its width,
   * at most the whole row.
   * @param {{ x: number, y: number, w: number, h: number }} spot
   * @returns {string} A value for the card's style attribute.
   */
  function placementStyle({ x, y, w, h }) {
    return `--x:${x};--y:${y};--w:${w};--h:${h};--wm:${Math.min(COLUMNS, w * 2)}`;
  }

  /**
   * How many rows a layout uses, so Fit to screen can share the window's height between them.
   * @param {ReadonlyArray<{ y: number, h: number }>} layout
   * @returns {number}
   */
  function rowCount(layout) {
    return Math.max(...layout.map((s) => s.y + s.h - 1));
  }

  return { COLUMNS, LAYOUTS, placementStyle, rowCount };
})();
