// Felix's dropdowns. The native <select> menu is drawn by macOS and ignores the page's look, so each select gets a
// button and a menu in Felix's style. The select stays the source of truth: choosing an item sets its value and
// fires "change", so every existing handler keeps working. Call FelixDropdown.sync(select) after changing a select's
// value or disabled state in code.
window.FelixDropdown = (() => {
  const ICONS = {
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 5 5 9-10"/></svg>`,
    chevron: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`,
  };
  const SEARCH_FROM = 12;
  let open = null;
  let openedAt = 0;

  /**
   * Escapes text for HTML.
   * @param {unknown} s
   * @returns {string}
   */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Shows a select's current choice and disabled state on its button.
   * @param {HTMLSelectElement & { _ddSync?: () => void }} sel
   */
  function sync(sel) {
    sel?._ddSync?.();
  }

  /**
   * Gives a select its button, once.
   * @param {HTMLSelectElement | null} sel
   */
  function enhance(sel) {
    if (!sel || sel.dataset.dd) return;
    sel.dataset.dd = "1";
    sel.classList.add("dd-native");
    sel.tabIndex = -1;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "dd-btn";
    btn.id = `${sel.id}-dd`;
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    sel.after(btn);
    sel._ddSync = () => syncButton(sel, btn);
    sel._ddSync();
    sel.addEventListener("change", sel._ddSync);
    sel.labels?.forEach((label) => label.addEventListener("click", (e) => { e.preventDefault(); btn.focus(); }));
    btn.addEventListener("click", (e) => { e.stopPropagation(); if (open?.sel === sel) close(); else openMenu(sel, btn); });
    btn.addEventListener("keydown", (e) => {
      if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); e.stopPropagation(); openMenu(sel, btn); }
    });
  }

  /**
   * A select's label text, leaving out the select and button a wrapping label holds.
   * @param {HTMLSelectElement} sel
   * @returns {string}
   */
  function labelText(sel) {
    const label = sel.labels?.[0]?.cloneNode(true);
    if (!label) return "";
    label.querySelectorAll("select, button").forEach((n) => n.remove());
    return label.textContent.trim();
  }

  /**
   * Draws a select's choice on its button, named after the select's label for screen readers.
   * @param {HTMLSelectElement} sel
   * @param {HTMLButtonElement} btn
   */
  function syncButton(sel, btn) {
    const text = sel.selectedOptions[0]?.textContent || "";
    const label = labelText(sel);
    btn.innerHTML = `<span>${esc(text)}</span>${ICONS.chevron}`;
    btn.disabled = sel.disabled;
    if (label) btn.setAttribute("aria-label", `${label}: ${text}`);
  }

  /**
   * One menu item for an option.
   * @param {HTMLOptionElement} o
   * @returns {HTMLDivElement}
   */
  function itemFor(o) {
    const item = document.createElement("div");
    item.className = "dd-item";
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(o.selected));
    item.tabIndex = -1;
    item.dataset.value = o.value;
    item.innerHTML = `<span class="dd-check">${o.selected ? ICONS.check : ""}</span><span>${esc(o.textContent)}</span>`;
    item.addEventListener("click", (e) => { e.stopPropagation(); choose(o.value); });
    return item;
  }

  /**
   * The search box on top of a long menu, which filters its items as you type.
   * @param {HTMLDivElement} menu
   * @param {HTMLDivElement} none Shown when nothing matches.
   * @returns {HTMLInputElement}
   */
  function searchFor(menu, none) {
    const search = document.createElement("input");
    search.type = "search";
    search.className = "dd-search";
    search.placeholder = "Search";
    search.setAttribute("aria-label", "Search the list");
    search.addEventListener("click", (e) => e.stopPropagation());
    search.addEventListener("input", () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      let shown = 0;
      for (const item of menu.querySelectorAll(".dd-item")) {
        item.hidden = !words.every((w) => `${item.textContent} ${item.dataset.value}`.toLowerCase().includes(w));
        shown += item.hidden ? 0 : 1;
      }
      none.hidden = shown > 0;
    });
    return search;
  }

  /**
   * Moves focus within the menu, or picks or closes, for one key press on an item.
   * @param {KeyboardEvent} e
   * @param {HTMLElement[]} items The items that are showing.
   * @param {HTMLInputElement | null} search
   */
  function itemKey(e, items, search) {
    const at = items.indexOf(document.activeElement);
    const focus = (i) => items.at(i)?.focus({ preventScroll: true });
    const keys = {
      ArrowDown: () => focus(Math.min(at + 1, items.length - 1)),
      ArrowUp: () => (at <= 0 && search ? search.focus() : focus(Math.max(at - 1, 0))),
      Home: () => focus(0),
      End: () => focus(-1),
      Enter: () => at >= 0 && choose(items.at(at).dataset.value),
      " ": () => at >= 0 && choose(items.at(at).dataset.value),
    };
    if (keys[e.key]) { e.preventDefault(); keys[e.key](); }
  }

  /**
   * Handles a key in the search box: typing filters, Down moves into the list, Enter picks the first match.
   * @param {KeyboardEvent} e
   * @param {HTMLElement[]} items The items that are showing.
   */
  function searchKey(e, items) {
    if (e.key === "ArrowDown") { e.preventDefault(); items.at(0)?.focus({ preventScroll: true }); }
    else if (e.key === "Enter") { e.preventDefault(); if (items.length) choose(items[0].dataset.value); }
  }

  /**
   * Keeps the menu's keys with the menu, so Escape here doesn't also close a panel behind it.
   * @param {KeyboardEvent} e
   * @param {HTMLDivElement} menu
   * @param {HTMLInputElement | null} search
   */
  function menuKey(e, menu, search) {
    if (e.key !== "Tab") e.stopPropagation();
    if (e.key === "Tab") return close();
    if (e.key === "Escape") { e.preventDefault(); const btn = open?.btn; close(); return btn?.focus(); }
    const items = [...menu.querySelectorAll(".dd-item:not([hidden])")];
    if (e.target === search) searchKey(e, items);
    else itemKey(e, items, search);
  }

  /**
   * Places the menu under its button, or above it when there's no room, inside the window.
   * @param {HTMLDivElement} menu
   * @param {HTMLButtonElement} btn
   * @param {boolean} fixedWidth Keeps the width while a search filters the list.
   */
  function place(menu, btn, fixedWidth) {
    const r = btn.getBoundingClientRect();
    menu.style.minWidth = `${Math.round(r.width)}px`;
    if (fixedWidth) menu.style.width = `${menu.offsetWidth}px`;
    if (innerHeight - r.bottom >= menu.offsetHeight + 8) menu.style.top = `${Math.round(r.bottom + 4)}px`;
    else menu.style.bottom = `${Math.round(innerHeight - r.top + 4)}px`;
    menu.style.left = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - menu.offsetWidth - 8)))}px`;
  }

  /**
   * Opens a select's menu with its current choice in focus.
   * @param {HTMLSelectElement} sel
   * @param {HTMLButtonElement} btn
   */
  function openMenu(sel, btn) {
    close();
    const menu = document.createElement("div");
    menu.className = "dd-menu";
    menu.setAttribute("role", "listbox");
    const none = Object.assign(document.createElement("div"), { className: "dd-none", textContent: "No matches", hidden: true });
    const search = sel.options.length > SEARCH_FROM ? searchFor(menu, none) : null;
    menu.append(...[search, ...[...sel.options].map(itemFor), search && none].filter(Boolean));
    menu.addEventListener("keydown", (e) => menuKey(e, menu, search));
    // Inside a dialog the menu goes in the dialog, so it shows above it rather than behind.
    (sel.closest("dialog") || document.body).append(menu);
    place(menu, btn, Boolean(search));
    open = { menu, btn, sel };
    btn.setAttribute("aria-expanded", "true");
    openedAt = Date.now();
    const current = menu.querySelector('[aria-selected="true"]');
    current?.scrollIntoView({ block: "nearest" });
    (search || current || menu.firstElementChild)?.focus({ preventScroll: true });
  }

  /**
   * Picks a value for the open select, tells its listeners when it changed, and gives focus back to its button.
   * @param {string} value
   */
  function choose(value) {
    const sel = open?.sel;
    const btnId = open?.btn.id;
    close();
    if (!sel) return;
    if (sel.value !== value) { sel.value = value; sel.dispatchEvent(new Event("change", { bubbles: true })); }
    sync(sel);
    document.getElementById(btnId)?.focus();
  }

  /**
   * Closes the open menu, if any.
   */
  function close() {
    open?.menu.remove();
    open?.btn.setAttribute("aria-expanded", "false");
    open = null;
  }

  /**
   * Whether a menu is open, so a page's own keys can leave it alone.
   * @returns {boolean}
   */
  const isOpen = () => Boolean(open);

  document.addEventListener("click", (e) => { if (open && !open.menu.contains(e.target)) close(); });
  addEventListener("resize", close);
  document.addEventListener("scroll", (e) => { if (open && !open.menu.contains(e.target) && Date.now() - openedAt > 250) close(); }, true);

  return { ICONS, enhance, sync, isOpen, close };
})();
