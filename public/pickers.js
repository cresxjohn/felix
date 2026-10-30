// Felix's date and time pickers. The browser's own pickers are drawn by macOS and ignore the page's look, so a date
// or time input gets a button in Felix's style and a small popover: a month grid with Today, Tomorrow and Clear for
// dates, and a list of times for times. The input stays the source of truth: picking sets its value and fires
// "input" and "change", so every handler keeps working. Call FelixPickers.sync(input) after setting a value in code.
window.FelixPickers = (() => {
  const ICONS = {
    date: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4"/></svg>`,
    time: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>`,
    prev: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 6-6 6 6 6"/></svg>`,
    next: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>`,
    prevYear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 6-6 6 6 6M18 6l-6 6 6 6"/></svg>`,
    nextYear: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 6 6 6-6 6M12 6l6 6-6 6"/></svg>`,
  };
  const STEP_MINUTES = 30;
  let open = null;

  /**
   * A day as YYYY-MM-DD.
   * @param {Date} d
   * @returns {string}
   */
  const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  /**
   * A YYYY-MM-DD day as a local date at noon (so time zones never shift it).
   * @param {string} day
   * @returns {Date}
   */
  const dayDate = (day) => new Date(`${day}T12:00:00`);

  /**
   * What the button says: the day or time, or the input's placeholder.
   * @param {HTMLInputElement} input
   * @returns {string}
   */
  function labelText(input) {
    if (!input.value) return input.dataset.empty || (input.type === "date" ? "No date" : "No time");
    if (input.type === "date") return dayDate(input.value).toLocaleDateString([], { weekday: "short", month: "short", day: "numeric", year: dayDate(input.value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" });
    const [h, m] = input.value.split(":").map(Number);
    return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }

  /**
   * Shows the input's value and disabled state on its button.
   * @param {HTMLInputElement & { _pickBtn?: HTMLButtonElement }} input
   */
  function sync(input) {
    const btn = input?._pickBtn;
    if (!btn) return;
    btn.querySelector(".pick-label").textContent = labelText(input);
    btn.classList.toggle("empty", !input.value);
    btn.disabled = input.disabled;
  }

  /**
   * Gives a date or time input its button, once.
   * @param {HTMLInputElement | null} input
   */
  function enhance(input) {
    if (!input || input._pickBtn || !["date", "time"].includes(input.type)) return;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn pick-btn";
    btn.setAttribute("aria-haspopup", "dialog");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-label", input.getAttribute("aria-label") || input.closest("label")?.querySelector("span")?.textContent || input.type);
    btn.innerHTML = `<span class="pick-label"></span>${ICONS[input.type]}`;
    input.classList.add("dd-native");
    input.tabIndex = -1;
    input.after(btn);
    input._pickBtn = btn;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (open?.input === input) return close();
      (input.type === "date" ? openDate : openTime)(input, btn);
    });
    input.addEventListener("change", () => sync(input));
    sync(input);
  }

  /**
   * Makes the popover beside its button. Inside a dialog it goes in the dialog, so it shows above it.
   * @param {HTMLButtonElement} btn
   * @param {string} cls
   * @returns {HTMLDivElement}
   */
  function popover(btn, cls) {
    close();
    const pop = document.createElement("div");
    pop.className = `dd-menu pick-pop ${cls}`;
    pop.setAttribute("role", "dialog");
    (btn.closest("dialog") || document.body).append(pop);
    pop.addEventListener("keydown", (e) => { if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close(true); } });
    btn.setAttribute("aria-expanded", "true");
    return pop;
  }

  /**
   * Puts the popover under its button, or above it when there's no room below.
   * @param {HTMLDivElement} pop
   * @param {HTMLButtonElement} btn
   */
  function place(pop, btn) {
    const r = btn.getBoundingClientRect();
    if (pop.classList.contains("pick-time")) pop.style.width = `${Math.max(150, Math.round(r.width))}px`;
    if (innerHeight - r.bottom >= pop.offsetHeight + 8) pop.style.top = `${Math.round(r.bottom + 4)}px`;
    else pop.style.top = `${Math.round(Math.max(8, r.top - pop.offsetHeight - 4))}px`;
    pop.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - pop.offsetWidth - 8)))}px`;
  }

  /**
   * Sets the input's value and tells its listeners.
   * @param {HTMLInputElement} input
   * @param {string} value
   */
  function set(input, value) {
    if (input.value !== value) {
      input.value = value;
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
    }
    sync(input);
  }

  /**
   * The month grid for a date input.
   * @param {HTMLInputElement} input
   * @param {HTMLButtonElement} btn
   */
  function openDate(input, btn) {
    const pop = popover(btn, "pick-date");
    const today = ymd(new Date());
    let shown = dayDate(input.value || today);
    shown.setDate(1);
    const draw = (focusDay) => {
      const first = new Date(shown);
      const start = new Date(first);
      start.setDate(1 - first.getDay());
      const days = Array.from({ length: 42 }, (_, i) => { const d = new Date(start); d.setDate(start.getDate() + i); return d; });
      const weeks = days.slice(35).every((d) => d.getMonth() !== first.getMonth()) ? days.slice(0, 35) : days;
      const heads = Array.from({ length: 7 }, (_, i) => new Date(2023, 0, 1 + i).toLocaleDateString([], { weekday: "narrow" }));
      // A year at a time too, for a birthday's February 29 or a trip months away.
      pop.innerHTML = `<div class="pick-head"><span><button type="button" class="pick-nav" data-move="-12" aria-label="Previous year">${ICONS.prevYear}</button>`
        + `<button type="button" class="pick-nav" data-move="-1" aria-label="Previous month">${ICONS.prev}</button></span>`
        + `<b>${first.toLocaleDateString([], { month: "long", year: "numeric" })}</b>`
        + `<span><button type="button" class="pick-nav" data-move="1" aria-label="Next month">${ICONS.next}</button>`
        + `<button type="button" class="pick-nav" data-move="12" aria-label="Next year">${ICONS.nextYear}</button></span></div>`
        + `<div class="pick-grid" role="grid">${heads.map((h) => `<span class="pick-wd">${h}</span>`).join("")}`
        + weeks.map((d) => {
          const day = ymd(d);
          const cls = [d.getMonth() !== first.getMonth() && "out", day === today && "today", day === input.value && "on"].filter(Boolean).join(" ");
          return `<button type="button" class="pick-day ${cls}" data-day="${day}" tabindex="-1" aria-label="${d.toDateString()}"${day === input.value ? ' aria-selected="true"' : ""}>${d.getDate()}</button>`;
        }).join("")
        + `</div><div class="pick-foot"><button type="button" data-day="${today}">Today</button><button type="button" data-day="${ymd(new Date(Date.now() + 86400e3))}">Tomorrow</button>`
        + `<span class="spacer"></span><button type="button" data-day="" class="quiet">Clear</button></div>`;
      const target = pop.querySelector(`.pick-day[data-day="${focusDay}"]`) || pop.querySelector(".pick-day.on") || pop.querySelector(".pick-day.today") || pop.querySelector(".pick-day:not(.out)");
      target.tabIndex = 0;
      target.focus({ preventScroll: true });
    };
    pop.addEventListener("click", (e) => {
      e.stopPropagation();
      const move = e.target.closest("[data-move]");
      if (move) {
        shown.setMonth(shown.getMonth() + Number(move.dataset.move));
        return draw();
      }
      const pick = e.target.closest("[data-day]");
      if (!pick) return;
      set(input, pick.dataset.day);
      close(true);
    });
    pop.addEventListener("keydown", (e) => {
      const cur = e.target.closest(".pick-day");
      const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[e.key];
      if (!cur || !step) return;
      e.preventDefault();
      const d = dayDate(cur.dataset.day);
      d.setDate(d.getDate() + step);
      if (d.getMonth() !== shown.getMonth() || d.getFullYear() !== shown.getFullYear()) { shown = new Date(d); shown.setDate(1); }
      draw(ymd(d));
    });
    draw();
    place(pop, btn);
    open = { pop, btn, input };
  }

  /**
   * The list of times for a time input, every half hour, scrolled to the current one.
   * @param {HTMLInputElement} input
   * @param {HTMLButtonElement} btn
   */
  function openTime(input, btn) {
    const pop = popover(btn, "pick-time");
    pop.setAttribute("role", "listbox");
    const times = Array.from({ length: (24 * 60) / STEP_MINUTES }, (_, i) => {
      const m = i * STEP_MINUTES;
      return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
    });
    if (input.value && !times.includes(input.value)) times.push(input.value), times.sort();
    const label = (t) => { const [h, m] = t.split(":").map(Number); return new Date(2000, 0, 1, h, m).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); };
    pop.innerHTML = `<button type="button" class="dd-item quiet" data-time="">No time</button>`
      + times.map((t) => `<button type="button" class="dd-item" role="option" data-time="${t}"${t === input.value ? ' aria-selected="true"' : ""}>${label(t)}</button>`).join("");
    pop.addEventListener("click", (e) => {
      e.stopPropagation();
      const item = e.target.closest("[data-time]");
      if (!item) return;
      set(input, item.dataset.time);
      close(true);
    });
    pop.addEventListener("keydown", (e) => {
      const items = [...pop.querySelectorAll("[data-time]")];
      const at = items.indexOf(document.activeElement);
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        items[Math.max(0, Math.min(items.length - 1, at + (e.key === "ArrowDown" ? 1 : -1)))]?.focus();
      }
    });
    place(pop, btn);
    open = { pop, btn, input };
    // The chosen time, or the next half hour from now, in view.
    const now = new Date();
    const soon = `${String(now.getHours()).padStart(2, "0")}:${now.getMinutes() < 30 ? "30" : "00"}`;
    const target = pop.querySelector('[aria-selected="true"]') || pop.querySelector(`[data-time="${soon}"]`) || pop.querySelector("[data-time]");
    target.scrollIntoView({ block: "center" });
    target.focus({ preventScroll: true });
  }

  /**
   * Closes the open popover, if any.
   * @param {boolean} [refocus] Give focus back to its button.
   */
  function close(refocus = false) {
    if (!open) return;
    open.pop.remove();
    open.btn.setAttribute("aria-expanded", "false");
    if (refocus) open.btn.focus();
    open = null;
  }

  document.addEventListener("click", (e) => { if (open && !open.pop.contains(e.target) && !open.btn.contains(e.target)) close(); });
  addEventListener("resize", () => close());

  return { enhance, sync, close, isOpen: () => Boolean(open) };
})();
