// Drag to reorder by touch. A mouse drags rows with the browser's own drag and drop, but iPad Safari doesn't start that
// from a finger, so this lets you press and hold a row (about a third of a second, without moving) and then slide it.
// A quick swipe still scrolls, and a tap still taps. The row lifts while you hold it, moves among its siblings as you
// slide, and the page is told where it landed. Only touch and pen go through here; a mouse keeps the drag it has.
window.FelixReorder = (() => {
  const HOLD_MS = 350;
  const SLOP = 8;
  const EDGE = 48;

  /**
   * The nearest box that scrolls up and down, for scrolling while a row is held near its edge.
   * @param {Element} el
   * @returns {Element}
   */
  function scroller(el) {
    for (let p = el.parentElement; p; p = p.parentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === "auto" || oy === "scroll") && p.scrollHeight > p.clientHeight) return p;
    }
    return document.scrollingElement || document.documentElement;
  }

  /**
   * Lets the rows inside `root` be reordered by touch.
   * @param {Element} root Where to listen; rows are found inside it as they come and go.
   * @param {{ rows: string, onDrop: (row: HTMLElement) => void }} options `rows` is a selector for the rows that may
   *   move (each moves among siblings that match it); `onDrop` runs when a row lands somewhere new.
   */
  function attach(root, { rows, onDrop }) {
    let press = null;
    let drag = null;

    /** Ends a press or a drag, and puts back what holding changed. */
    const reset = () => {
      if (press) { clearTimeout(press.timer); if (press.row) press.row.draggable = press.draggable; }
      if (drag) drag.row.classList.remove("lifted");
      press = null;
      drag = null;
    };

    root.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse" || !e.isPrimary) return;
      const row = e.target.closest?.(rows);
      if (!row || !root.contains(row)) return;
      reset();
      // While held by a finger the row isn't a browser drag source, so the two drags never start together.
      press = { row, x: e.clientX, y: e.clientY, id: e.pointerId, draggable: row.draggable };
      row.draggable = false;
      press.timer = setTimeout(() => {
        if (!press) return;
        drag = { row, start: [...row.parentElement.children].indexOf(row), y: press.y, box: scroller(row) };
        row.classList.add("lifted");
        navigator.vibrate?.(10);
      }, HOLD_MS);
    });

    root.addEventListener("pointermove", (e) => {
      if (!press || e.pointerId !== press.id) return;
      if (!drag) {
        // Moving before the hold is a scroll or a swipe: let it be.
        if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > SLOP) reset();
        return;
      }
      e.preventDefault();
      drag.y = e.clientY;
      const over = document.elementFromPoint(e.clientX, e.clientY)?.closest?.(rows);
      const { row } = drag;
      if (over && over !== row && over.parentElement === row.parentElement) {
        const r = over.getBoundingClientRect();
        row.parentElement.insertBefore(row, e.clientY < r.top + r.height / 2 ? over : over.nextSibling);
      }
      // Near the top or bottom of the scrolling box, scroll it so a long list can be reached.
      const b = drag.box === document.scrollingElement ? { top: 0, bottom: innerHeight } : drag.box.getBoundingClientRect();
      if (e.clientY < b.top + EDGE) drag.box.scrollBy(0, -12);
      else if (e.clientY > b.bottom - EDGE) drag.box.scrollBy(0, 12);
    });

    // Once a row is lifted the finger moves it, not the page.
    root.addEventListener("touchmove", (e) => { if (drag) e.preventDefault(); }, { passive: false });
    // A long press would otherwise open the text menu on iPad.
    root.addEventListener("contextmenu", (e) => { if (press || drag) e.preventDefault(); });

    const finish = (e) => {
      if (!press || e.pointerId !== press.id) return;
      const done = drag;
      reset();
      if (!done) return;
      // The tap that ends a hold isn't a click on the row.
      const swallow = (ev) => { ev.stopPropagation(); ev.preventDefault(); };
      root.addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => root.removeEventListener("click", swallow, { capture: true }), 400);
      // Saved even when the browser cut the drag short, so the order shown is the order kept.
      if (done.row.parentElement && [...done.row.parentElement.children].indexOf(done.row) !== done.start) onDrop(done.row);
    };
    root.addEventListener("pointerup", finish);
    root.addEventListener("pointercancel", finish);
  }

  return { attach, HOLD_MS };
})();
