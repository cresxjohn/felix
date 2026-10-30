// Felix's shell, the same on every page: the top bar, the Felix and music bar (the player is /music.js), and the
// settings every page reads.
// Each page has an empty <header class="topbar" id="topbar"> and <footer class="dock" id="dock">, and calls
// FelixShell.mount first. Opened in a window, a page arrives inside Felix's lasting outer page (host.html), which
// holds the bottom bar and the music so they carry on between pages; the page then draws only its own top bar.
// The outer page loads the next page in a second frame under the current one and swaps once it has drawn, and it
// keeps the window's history itself, since a frame's own history goes with the frame.
window.FelixShell = (() => {
  const SETTINGS_CACHE = "felix:settings";
  const FRAME_CLASS = "felix-page";
  const SWAP_TIMEOUT_MS = 5000;
  const host = window.frameElement?.classList.contains(FRAME_CLASS) ? window.parent : null;
  const frames = { current: null, pending: null, adopted: new WeakSet(), drag: [] };
  if (host) document.documentElement.classList.add("framed");
  // In the installed app (not with its title bar hidden), the window's own title bar is right above the top bar.
  const top = host || window;
  if (top.matchMedia("(display-mode: standalone)").matches || top.navigator.standalone === true) document.documentElement.classList.add("installed");
  // Dark or light from Settings, and the mode, before anything draws, so a page never flashes the wrong theme.
  queueMicrotask(() => {
    applyTheme();
    document.documentElement.dataset.mode ||= cachedSettings()?.mode || "work";
  });
  const BOOT_MIN_MS = 800;
  const BOOT_MAX_MS = 8000;
  const bootStart = performance.now();
  const line = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICONS = {
    refresh: `<svg class="glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"/></svg>`,
    install: line(`<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M5 21h14"/>`),
    // Settings: two sliders, as in the design.
    gear: line(`<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>`),
  };
  const MODES = [["personal", "Personal"], ["work", "Work"]];
  /**
   * Felix's mark (logo 2a, the buddy face with a wink), inline so its face, eye and smile take the theme's colours.
   * It also carries what his states need, hidden until a state class shows them (shell.css): two sound arcs that
   * breathe beside his face and a small round mouth while he listens, his other eye open, and a mouth that moves
   * while he talks.
   * @param {string} [size] "lg" for the bottom bar's size.
   * @returns {string}
   */
  const mark = (size = "") => `<svg class="mark${size ? ` ${size}` : ""}" viewBox="0 0 64 64" aria-hidden="true">`
    + `<path class="ring" d="M-3 22a36 36 0 0 0 0 20M67 22a36 36 0 0 1 0 20"/>`
    + `<g class="head"><circle class="face" cx="32" cy="32" r="28"/><g class="eyes"><rect class="eye" x="21" y="20" width="6.5" height="12.5" rx="3.25"/>`
    + `<rect class="eye eye2" x="36.5" y="20" width="6.5" height="12.5" rx="3.25"/><path class="wink" d="M36 28.5q3.5-5.5 7 0"/></g>`
    + `<path class="smile" d="M21.5 40c5.8 5.8 15.2 5.8 21 0"/><ellipse class="mouth" cx="32" cy="43" rx="7" ry="4.5"/><circle class="ohm" cx="32" cy="43" r="4"/></g></svg>`;
  const RING_PATH = "M18 1H26A9 9 0 0 1 35 10V26A9 9 0 0 1 26 35H10A9 9 0 0 1 1 26V10A9 9 0 0 1 10 1Z";

  /**
   * The last settings this browser saw, so a page draws in the right mode and layout before the server answers.
   * @returns {Record<string, unknown> | null}
   */
  function cachedSettings() {
    try { return JSON.parse(localStorage.getItem(SETTINGS_CACHE) || "null"); } catch { return null; }
  }

  /**
   * Keeps the settings the server answered with, for the next page load.
   * @param {Record<string, unknown>} settings
   * @returns {Record<string, unknown>}
   */
  function remember(settings) {
    try { localStorage.setItem(SETTINGS_CACHE, JSON.stringify(settings)); } catch {}
    applyTheme(settings);
    // Other pages hear of it through the storage event; this page, which wrote it, through this one.
    dispatchEvent(new CustomEvent("felix:settings"));
    return settings;
  }

  /**
   * Draws the page dark or light as Settings says, or as the Mac is when it says to match. The outer page and
   * its framed page follow together, since the bottom bar lives in the outer one.
   * @param {Record<string, unknown> | null} [settings]
   */
  function applyTheme(settings = cachedSettings()) {
    const theme = settings?.theme === "dark" || settings?.theme === "light" ? settings.theme : "";
    // A mode's own colour, when you picked one (theme.css works out every accent shade from it).
    const accents = { work: settings?.accentWork, personal: settings?.accentPersonal };
    for (const doc of [document, host?.document].filter(Boolean)) {
      const root = doc.documentElement;
      if (theme) root.dataset.theme = theme;
      else delete root.dataset.theme;
      for (const [mode, color] of Object.entries(accents)) {
        const picked = /^#[0-9a-f]{6}$/i.test(color || "");
        root.classList.toggle(`accent-${mode}`, picked);
        if (picked) root.style.setProperty(`--accent-${mode}`, color);
        else root.style.removeProperty(`--accent-${mode}`);
      }
    }
    syncTitlebar();
  }

  /**
   * A CSS colour as plain #rrggbb, as the title bar needs: a picked colour's background is a color-mix(), which only
   * the page itself can read, so it's drawn on a one-pixel canvas and read back.
   * @param {string} css
   * @returns {string}
   */
  function solidColor(css) {
    if (!css || /^#[0-9a-f]{6}$/i.test(css)) return css;
    const ctx = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
    if (!ctx) return "";
    ctx.fillStyle = css;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data;
    return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("")}`;
  }

  /**
   * Colours the window's title bar (the installed app's, and the browser's tab strip where it follows) the same as
   * the page, in the mode and theme showing now.
   */
  function syncTitlebar() {
    const doc = host?.document || document;
    const bg = solidColor((doc.body && getComputedStyle(doc.body).backgroundColor) || getComputedStyle(doc.documentElement).getPropertyValue("--bg").trim());
    if (!bg) return;
    const metas = [...doc.querySelectorAll('meta[name="theme-color"]')];
    if (!metas.length) metas.push(doc.head.appendChild(Object.assign(doc.createElement("meta"), { name: "theme-color" })));
    metas.forEach((m, i) => {
      if (i) return m.remove();
      m.removeAttribute("media");
      m.content = bg;
    });
  }

  /**
   * Sends JSON to the server and returns its answer.
   * @param {string} path
   * @param {object} [body] POSTed when given; a GET otherwise.
   * @returns {Promise<object>}
   * @throws {Error} with the server's message when it refuses or can't be reached.
   */
  async function request(path, body) {
    const init = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" };
    let res;
    try { res = await fetch(path, init); } catch { throw new Error("Can't reach the local server. Start it with ./prs start."); }
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(answer.error || `The server answered ${res.status}.`);
    return answer;
  }

  const loadSettings = async () => remember((await request("/api/settings")).settings);
  const saveSettings = async (patch) => remember((await request("/api/settings", { patch })).settings);
  const resetSettings = async (keys) => remember((await request("/api/settings/reset", keys ? { keys } : {})).settings);

  /**
   * The left side: Felix's name, linking home, then the page's own title when it isn't home.
   * @param {string | undefined} title
   * @param {string} afterTitle Extra markup right after the title.
   * @returns {string}
   */
  function brandHtml(title, afterTitle) {
    if (title) {
      return `<a class="brand" href="/" title="Felix home">${mark()}<span class="name">Felix</span></a>`
        + `<span class="crumb" aria-hidden="true">/</span><h1>${title}</h1>${afterTitle}`;
    }
    // Home: Felix's name with today's date under it, as one block.
    return `<a class="brand home" href="/" title="Felix home" aria-current="page">${mark()}`
      + `<span class="brand-text"><h1 class="name">Felix</h1><span class="today" id="today"></span><span class="clock" id="clock" aria-label="Time"></span></span></a>${afterTitle}`;
  }

  /**
   * The Personal and Work switch.
   * @returns {string}
   */
  const modesHtml = () => `<div class="modes segmented" role="group" aria-label="Mode">${MODES.map(([id, label]) => `<button type="button" data-mode="${id}" aria-pressed="false" title="Switch to ${label} mode">${label}</button>`).join("")}</div>`;

  /**
   * The top bar. The "Say “Hey Felix”" pill shows whether Felix listens for his phrase, and turns it on or off.
   * @param {{ title?: string, afterTitle?: string, status?: string, tools?: string, install?: boolean, refresh?: boolean, onMode?: Function }} options
   * @returns {string}
   */
  function topbarHtml({ title, afterTitle = "", status = "", tools = "", install = false, refresh = true, onMode }) {
    const installBtn = install
      ? `<button class="install" type="button" data-install hidden title="Install Felix as an app with its own window and Dock icon">${ICONS.install}Install app</button>`
      : "";
    const onSettings = location.pathname === "/settings";
    const refreshBtn = refresh
      ? `<button class="icon-btn refresh" id="refresh" type="button" title="Refresh (R). The ring fills until the next automatic refresh." aria-label="Refresh">`
        + `${ICONS.refresh}<svg class="ring" viewBox="0 0 36 36" aria-hidden="true"><path id="refresh-ring" d="${RING_PATH}" pathLength="100"/></svg></button>`
      : "";
    // Only Home shows today's date (under Felix's name); other pages keep their top bar for their own title and tools.
    return `${brandHtml(title, afterTitle)}${onMode ? modesHtml() : ""}<span class="spacer"></span>${status}`
      + `<button type="button" class="listen" id="wake-pill" data-state="off" aria-pressed="false"><span class="dot" aria-hidden="true"></span><span class="listen-text"></span></button>`
      // The work day (/shift.js draws it): its buttons and Off work on Home only, its clock on every page while it runs.
      + `<span class="shift" id="shift" data-home="${title ? "" : "1"}"></span>`
      + `${tools}${installBtn}`
      + `<a class="icon-btn" href="/settings" title="Settings" aria-label="Settings"${onSettings ? ` aria-current="page"` : ""}>${ICONS.gear}</a>`
      + refreshBtn;
  }

  /**
   * The bottom bar: the slots /felix.js draws Felix's chat in and /music.js draws the player in.
   * @returns {string}
   */
  function dockHtml() {
    return `<div class="felix" id="felix-chat" role="region" aria-label="Felix"></div>`
      + `<div class="music" id="music" role="region" aria-label="Music player"></div>`;
  }

  /**
   * Shows today's date in the top bar.
   */
  function renderToday() {
    roll(document.getElementById("today"), new Date().toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" }));
  }

  /**
   * Shows the time to the second next to the date.
   */
  function renderClock() {
    roll(document.getElementById("clock"), new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }));
  }

  /**
   * Writes text into the top bar like an odometer: each character that changed scrolls down, the new one coming in
   * from above and pushing the old one out below.
   * @param {HTMLElement | null} el
   * @param {string} text
   */
  function roll(el, text) {
    if (!el) return;
    const was = el.dataset.text || "";
    if (text === was) return;
    el.dataset.text = text;
    el.setAttribute("aria-label", text);
    const ch = (c) => (c === " " ? "&nbsp;" : c);
    el.innerHTML = [...text].map((c, i) => {
      const old = was[i];
      if (!was || c === old) return `<span class="ch" aria-hidden="true">${ch(c)}</span>`;
      return `<span class="ch roll" aria-hidden="true"><span class="reel"><span>${ch(c)}</span><span>${ch(old ?? " ")}</span></span></span>`;
    }).join("");
  }

  /**
   * Ticks the clock on each new second.
   */
  function startClock() {
    renderClock();
    setTimeout(startClock, 1000 - (Date.now() % 1000) + 5);
  }

  /**
   * Marks the mode on the page, which shows that mode's top bar items, and presses its switch button.
   * @param {string} mode "work" or "personal".
   */
  function setMode(mode) {
    document.documentElement.dataset.mode = mode;
    if (host) host.document.documentElement.dataset.mode = mode;
    syncTitlebar();
    document.querySelectorAll(".modes [data-mode]").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  }

  /**
   * Starts the refresh button's ring over: it fills clockwise until the page's next automatic refresh.
   * @param {number} [ms] How long until that refresh; leave out to keep the last one. 0 hides the ring.
   */
  function restartRing(ms) {
    const ring = document.getElementById("refresh-ring");
    if (!ring) return;
    if (ms !== undefined) document.getElementById("refresh").style.setProperty("--poll", `${ms}ms`);
    ring.parentElement.style.visibility = ms === 0 ? "hidden" : "";
    ring.style.animation = "none";
    ring.getBoundingClientRect();
    ring.style.animation = "";
  }

  /** What the pill says for each state of listening for the phrase, as its tooltip. */
  const WAKE_TIPS = {
    off: "Not listening for “{phrase}”. Click to start; the microphone stays on while this window is in view.",
    starting: "Turning the microphone on…",
    listening: "Listening for “{phrase}”. Only speech that starts with it reaches Felix; the rest is dropped. Click to stop.",
    hidden: "Listening for “{phrase}” while this window is in view. Click to stop.",
    elsewhere: "Another Felix window is listening for “{phrase}”. Click here to stop.",
    blocked: "Felix can't use the microphone. Allow it for this page (the icon in the address bar), then click to try again.",
    nomic: "No microphone found. Plug one in or pick one in Settings, then click to try again.",
    setup: "Hearing isn't set up on this Mac yet. Run ./prs voice once, then click to try again.",
  };

  /**
   * Text made safe to put in markup.
   * @param {unknown} v
   * @returns {string}
   */
  const escText = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const TICK = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;

  /** What the pill says while Felix is busy with you: listening, working out what you said, thinking or talking. */
  const MOOD_TEXT = { listening: "Listening…", hearing: "Working it out…", thinking: "Thinking…", talking: "Speaking…" };
  const QUIET_TEXT = { meeting: "Quiet: in a meeting", away: "Quiet: you're away", locked: "Quiet: screen locked" };

  /**
   * The top bar's pill: what Felix is doing right now (listening for his name, listening to you, thinking or
   * speaking), or that he's muted, paused or keeping quiet. A click opens a small menu: listen for his name, mute,
   * and pause for 30 minutes. The listening itself runs in Felix's lasting outer page (/felix-voice.js and felix.js).
   */
  function wireWakePill() {
    const pill = document.getElementById("wake-pill");
    const voice = window.FelixVoice;
    const buddy = window.FelixBuddy;
    if (!pill) return;
    /** @type {{ now: string, muted: boolean, pausedUntil: string, quiet: string | null }} */
    let mood = { now: "idle", muted: false, pausedUntil: "", quiet: null };
    const paint = () => {
      const prefs = cachedSettings() || {};
      const phrase = String(prefs.felixWake || "").trim() || `Hey ${prefs.felixName || "Felix"}`;
      const on = prefs.felixWakeOn === true && prefs.felixOn !== false;
      const status = on ? voice?.wakeState?.() || "starting" : "off";
      const paused = Date.parse(String(prefs.felixPausedUntil || "")) > Date.now();
      let state = status === "off" && on ? "starting" : status;
      let text = `Say “${phrase}”`;
      let tip = (WAKE_TIPS[state] || WAKE_TIPS.off).replace("{phrase}", phrase);
      if (MOOD_TEXT[mood.now]) [state, text, tip] = ["busy", MOOD_TEXT[mood.now], `${prefs.felixName || "Felix"} is ${MOOD_TEXT[mood.now].toLowerCase().replace("…", "")}.`];
      else if (prefs.felixMuted === true) [state, text, tip] = ["muted", "Muted", "Felix is muted: he doesn't speak or listen for his name. Click to unmute."];
      else if (paused) {
        const until = new Date(String(prefs.felixPausedUntil)).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
        [state, text, tip] = ["paused", `Paused until ${until}`, "Felix is paused. Click to resume now."];
      } else if (on && mood.quiet && QUIET_TEXT[mood.quiet]) [state, text, tip] = ["quiet", QUIET_TEXT[mood.quiet], "Felix keeps quiet and doesn't listen for his name until this ends. Hold to talk still works."];
      pill.dataset.state = state;
      pill.setAttribute("aria-pressed", String(on));
      pill.setAttribute("aria-haspopup", "menu");
      pill.querySelector(".listen-text").textContent = text;
      pill.title = tip;
    };
    paint();
    const stops = [voice?.watch?.((e) => { if (e.wake !== undefined) paint(); }), buddy?.watchMood?.((m) => { mood = m; paint(); })];
    addEventListener("pagehide", () => stops.forEach((stop) => stop?.()));
    addEventListener("storage", (e) => { if (e.key === SETTINGS_CACHE) paint(); });
    addEventListener("felix:settings", paint);
    pill.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleWakeMenu(pill, paint);
    });
  }

  /**
   * Opens or closes the pill's menu: listen for his name, mute or unmute, pause for 30 minutes or resume now.
   * @param {HTMLElement} pill
   * @param {() => void} paint Redraws the pill.
   */
  function toggleWakeMenu(pill, paint) {
    const open = document.getElementById("wake-menu");
    if (open) return open.remove();
    const prefs = cachedSettings() || {};
    const name = prefs.felixName || "Felix";
    const phrase = String(prefs.felixWake || "").trim() || `Hey ${name}`;
    const paused = Date.parse(String(prefs.felixPausedUntil || "")) > Date.now();
    const items = [
      { id: "wake", label: `Listen for “${phrase}”`, checked: prefs.felixWakeOn === true },
      { id: "mute", label: `Mute ${name}`, checked: prefs.felixMuted === true },
      { id: "pause", label: paused ? "Resume now" : "Pause for 30 minutes" },
    ];
    const menu = Object.assign(document.createElement("div"), { id: "wake-menu", className: "wake-menu" });
    menu.setAttribute("role", "menu");
    menu.innerHTML = items.map((i) => `<button type="button" role="${"checked" in i ? "menuitemcheckbox" : "menuitem"}" data-wake-item="${i.id}"`
      + `${"checked" in i ? ` aria-checked="${i.checked}"` : ""}><span class="tick" aria-hidden="true">${i.checked ? TICK : ""}</span>${escText(i.label)}</button>`).join("");
    const r = pill.getBoundingClientRect();
    Object.assign(menu.style, { top: `${r.bottom + 6}px`, left: `${Math.max(8, r.right - 220)}px` });
    document.body.append(menu);
    menu.querySelector("button")?.focus();
    const close = () => {
      menu.remove();
      removeEventListener("click", outside, true);
      removeEventListener("keydown", onKey, true);
    };
    const outside = (ev) => { if (!menu.contains(ev.target) && ev.target !== pill) close(); };
    const onKey = (ev) => { if (ev.key === "Escape") { close(); pill.focus(); } };
    addEventListener("click", outside, true);
    addEventListener("keydown", onKey, true);
    menu.addEventListener("click", async (ev) => {
      const item = ev.target.closest("[data-wake-item]")?.dataset.wakeItem;
      if (!item) return;
      close();
      const buddy = window.FelixBuddy;
      if (item === "wake") {
        await saveSettings({ felixWakeOn: prefs.felixWakeOn !== true }).catch(() => {});
        buddy?.syncWake?.();
      } else if (item === "mute") await buddy?.toggleMute?.();
      else await buddy?.pauseFor?.(paused ? 0 : 30);
      paint();
    });
  }

  /**
   * The hold-to-talk and mute keys from Settings, in this page: holding the talk key listens, letting go sends; the
   * mute key mutes or unmutes Felix.
   */
  function wireVoiceKeys() {
    const MUTE = { "shift-meta-m": "KeyM", "shift-meta-period": "Period" };
    addEventListener("keydown", (e) => {
      const prefs = cachedSettings() || {};
      const mute = MUTE[String(prefs.felixMuteKey || "")];
      if (mute && e.shiftKey && e.metaKey && e.code === mute) {
        e.preventDefault();
        window.FelixBuddy?.toggleMute?.();
        return;
      }
      if (prefs.felixPttKey && e.code === prefs.felixPttKey && !e.repeat) {
        e.preventDefault();
        window.FelixBuddy?.pushToTalk?.(true);
      }
    });
    addEventListener("keyup", (e) => {
      const key = (cachedSettings() || {}).felixPttKey;
      if (key && e.code === key) window.FelixBuddy?.pushToTalk?.(false);
    });
  }


  /**
   * Draws the top bar and the bottom bar, and keeps the date current.
   * @param {object} options
   * @param {number} [options.pollMs] How often the page refreshes itself, for the ring.
   * @param {string} [options.title] Names a page other than home.
   * @param {string} [options.afterTitle] The page's own markup after the title.
   * @param {string} [options.status] The page's own status line, first on the right side (like "Updated just now").
   * @param {string} [options.tools] The page's own markup before the settings and refresh buttons.
   * @param {boolean} [options.install] Show the Install app button while the browser offers it.
   * @param {boolean} [options.refresh] Show the refresh button (default true).
   * @param {string} [options.mode] The mode to show; the last saved one when left out.
   * @param {(mode: string) => void} [options.onMode] Handles the Personal and Work switch, which only shows when given
   *   (on the home page).
   */
  function mount(options) {
    document.getElementById("topbar").innerHTML = topbarHtml(options);
    if (!host) mountDock();
    setMode(options.mode || cachedSettings()?.mode || "work");
    if (options.pollMs) restartRing(options.pollMs);
    document.querySelector(".modes")?.addEventListener("click", (e) => {
      const mode = e.target.closest("[data-mode]")?.dataset.mode;
      if (mode && mode !== document.documentElement.dataset.mode) options.onMode(mode);
    });
    renderToday();
    setInterval(renderToday, 60e3);
    startClock();
    wireWakePill();
    wireVoiceKeys();
    // Clicks and keys in a framed page don't reach Felix's outer page, where his voice lives: pass them on.
    if (host) for (const type of ["pointerdown", "keydown"]) addEventListener(type, () => host.FelixVoice?.poke?.(), { capture: true });
    // The work day's part of the top bar, once per page.
    if (!document.querySelector('script[src="/shift.js"]')) document.head.append(Object.assign(document.createElement("script"), { type: "module", src: "/shift.js" }));
  }

  /**
   * Draws the bottom bar, Felix's chat and the music player.
   */
  function mountDock() {
    document.getElementById("dock").innerHTML = dockHtml();
    window.FelixBuddy?.mount(document.getElementById("felix-chat"));
    window.FelixMusic?.mount(document.getElementById("music"));
  }

  /**
   * Closes the bottom bar's panels, for a click or Escape inside a page.
   */
  function closePanels() {
    window.FelixMusic?.close();
    window.FelixBuddy?.close();
  }

  /**
   * An address as the address bar shows it, without the origin.
   * @param {Location | URL} where
   * @returns {string}
   */
  const pathOf = (where) => where.pathname + where.search + where.hash;

  /**
   * Which Felix page an address belongs to: every /prs view is one page.
   * @param {Location | URL} where
   * @returns {string}
   */
  const pageOf = (where) => where.pathname.split("/")[1];

  /**
   * Where a frame is, when it shows a Felix page.
   * @param {HTMLIFrameElement | null} frame
   * @returns {Location | null}
   */
  function frameLocation(frame) {
    try {
      const page = frame?.contentWindow?.location;
      return page?.origin === location.origin ? page : null;
    } catch {
      return null;
    }
  }

  /**
   * This window and the Felix pages in its frames, for news every page should hear.
   * @returns {Window[]}
   */
  const windows = () => [window, ...[...document.querySelectorAll(`iframe.${FRAME_CLASS}`)].map((f) => frameLocation(f) && f.contentWindow)].filter(Boolean);

  /**
   * A plain click on a link to another Felix page: no new tab or download asked for, and not an API address.
   * @param {MouseEvent} e
   * @returns {HTMLAnchorElement | null}
   */
  function felixLink(e) {
    const a = e.target.closest?.("a[href]");
    const plain = !e.defaultPrevented && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
    const felix = a && !a.target && !a.hasAttribute("download") && a.origin === location.origin && !a.pathname.startsWith("/api/");
    return plain && felix ? a : null;
  }

  /**
   * In the outer page: shows the current page's address and title as the window's own, so the address bar,
   * reloading and bookmarks work as before. Messages from a page still loading underneath are ignored.
   * @param {Window} [from] The page asking; the current one when left out.
   * @param {boolean} [push] Add a history entry rather than replace the current one.
   */
  function syncFrame(from, push = false) {
    const frame = frames.current;
    const page = frameLocation(frame);
    if (!page || (from && from !== frame.contentWindow)) return;
    const url = pathOf(page);
    if (url !== pathOf(location)) history[push ? "pushState" : "replaceState"](null, "", url);
    document.title = frame.contentDocument?.title || document.title;
  }

  /**
   * The installed app's title bar area while Felix draws in it (its title bar hidden), or null.
   * @returns {DOMRect | null}
   */
  function titlebarArea() {
    const overlay = navigator.windowControlsOverlay;
    return overlay?.visible ? overlay.getTitlebarAreaRect() : null;
  }

  /**
   * Lets a page's top bar sit in the title bar while it's hidden, clear of the window buttons on either side.
   * @param {Document} doc
   */
  function dressFrame(doc) {
    const area = titlebarArea();
    const root = doc.documentElement;
    root.classList.toggle("titlebar", Boolean(area));
    root.style.setProperty("--titlebar-left", `${area?.x ?? 0}px`);
    root.style.setProperty("--titlebar-right", `${area ? innerWidth - area.x - area.width : 0}px`);
  }

  /**
   * Sets a drag area's box, or hides it when the box has no room.
   * @param {HTMLElement} el
   * @param {{ left: number, top: number, width: number, height: number }} box
   */
  function placeBox(el, box) {
    el.hidden = box.width <= 0 || box.height <= 0;
    Object.assign(el.style, { left: `${box.left}px`, top: `${box.top}px`, width: `${box.width}px`, height: `${box.height}px` });
  }

  /**
   * In the outer page, while the title bar is hidden: lays the drag areas over the strip above the current page's
   * top bar and over its empty middle. Chrome only moves the window from the outer page, never from a frame.
   */
  function placeDragAreas() {
    const area = titlebarArea();
    const spacer = area && frameLocation(frames.current) ? frames.current.contentDocument?.querySelector("#topbar .spacer") : null;
    const [above, middle] = frames.drag;
    if (!above) return;
    if (!spacer) {
      above.hidden = middle.hidden = true;
      return;
    }
    const at = frames.current.getBoundingClientRect();
    const bar = spacer.parentElement.getBoundingClientRect();
    const gap = spacer.getBoundingClientRect();
    placeBox(above, { left: area.x, top: 0, width: area.width, height: at.top + bar.top });
    placeBox(middle, { left: at.left + gap.left, top: 0, width: gap.width, height: at.top + bar.bottom });
  }

  /**
   * In the outer page, while the title bar is hidden or shown again: moves every page's top bar and the drag areas.
   */
  function onTitlebar() {
    document.querySelectorAll(`iframe.${FRAME_CLASS}`).forEach((frame) => { if (frameLocation(frame)) dressFrame(frame.contentDocument); });
    placeDragAreas();
  }

  /**
   * Follows a newly shown page: its title, a click or Escape in it closing the playlist menu, and its top bar
   * moving or scrolling under the drag areas.
   * @param {HTMLIFrameElement} frame
   * @param {Document} doc
   */
  function watchFrame(frame, doc) {
    const title = doc.querySelector("title");
    if (title) new MutationObserver(() => syncFrame()).observe(title, { childList: true });
    doc.addEventListener("click", closePanels);
    doc.addEventListener("keydown", (e) => { if (e.key === "Escape") closePanels(); });
    const spacer = doc.querySelector("#topbar .spacer");
    if (spacer) new frame.contentWindow.ResizeObserver(placeDragAreas).observe(spacer);
    frame.contentWindow.addEventListener("scroll", placeDragAreas, { passive: true });
  }

  /**
   * In the outer page, once a page shows: follows it, refreshes its Install buttons, and gives it the keyboard.
   * @param {HTMLIFrameElement} frame
   */
  function adoptFrame(frame) {
    bootDone();
    syncFrame();
    placeDragAreas();
    const doc = frame.contentDocument;
    if (!doc || frames.adopted.has(doc)) return;
    frames.adopted.add(doc);
    watchFrame(frame, doc);
    window.FelixApp?.sync?.();
    frame.contentWindow.focus();
  }

  /**
   * Puts a loaded page in front: the page before it goes, and the window's address and history follow.
   * @param {HTMLIFrameElement} frame
   */
  function showFrame(frame) {
    const pending = frames.pending;
    if (pending?.frame !== frame) return;
    clearTimeout(pending.timer);
    frames.pending = null;
    frames.current?.remove();
    frames.current = frame;
    syncFrame(undefined, pending.push);
    adoptFrame(frame);
  }

  /**
   * Makes a frame for a Felix page, under any frame already showing.
   * @param {string} url
   * @returns {HTMLIFrameElement}
   */
  function newFrame(url) {
    const frame = document.createElement("iframe");
    frame.className = FRAME_CLASS;
    frame.title = "Felix page";
    frame.addEventListener("load", () => (frame === frames.current ? adoptFrame(frame) : showFrame(frame)));
    frame.src = url;
    document.getElementById("felix-pages").prepend(frame);
    return frame;
  }

  /**
   * Drops a page still loading underneath.
   */
  function cancelPending() {
    if (!frames.pending) return;
    clearTimeout(frames.pending.timer);
    frames.pending.frame.remove();
    frames.pending = null;
  }

  /**
   * In the outer page: opens a Felix page. It loads under the current one, which stays until the new page has
   * drawn (or a few seconds have passed), so moving between pages doesn't flash.
   * @param {string} url
   * @param {boolean} [push] Add a history entry; false when going back or forward.
   */
  function go(url, push = true) {
    cancelPending();
    const frame = newFrame(url);
    frames.pending = { frame, push, timer: setTimeout(() => showFrame(frame), SWAP_TIMEOUT_MS) };
  }

  /**
   * In the outer page: a page that has drawn says so, and comes to the front if it was loading underneath.
   * @param {Window} from
   */
  function frameReady(from) {
    if (frames.current?.contentWindow === from) bootDone();
    const frame = frames.pending?.frame;
    if (frame && frame.contentWindow === from) showFrame(frame);
  }

  /**
   * In the outer page: fades the loading screen out once the first page has drawn. It stays at least long enough
   * for its animation to read as one smooth moment, rather than a flash.
   */
  function bootDone() {
    const boot = document.getElementById("boot");
    if (!boot || boot.classList.contains("done")) return;
    setTimeout(() => {
      boot.classList.add("done");
      boot.addEventListener("transitionend", () => boot.remove(), { once: true });
      setTimeout(() => boot.remove(), 1000);
    }, Math.max(0, BOOT_MIN_MS - (performance.now() - bootStart)));
  }

  /**
   * In the outer page, on Back or Forward: another view of the current page (a /prs tab, a #section) is handled by
   * the page itself; anything else opens that page.
   */
  function onHistory() {
    cancelPending();
    const page = frameLocation(frames.current);
    if (!page || pageOf(page) !== pageOf(location)) return go(pathOf(location), false);
    const win = frames.current.contentWindow;
    if (page.pathname + page.search !== location.pathname + location.search) {
      win.history.replaceState(null, "", pathOf(location));
      win.dispatchEvent(new win.PopStateEvent("popstate"));
    } else if (page.hash !== location.hash) {
      page.replace(pathOf(location));
    }
  }

  /**
   * In the outer page: links in the bottom bar to Felix pages open in a frame, so the music keeps playing.
   * @param {MouseEvent} e
   */
  function keepInFrame(e) {
    const a = felixLink(e);
    if (!a) return;
    e.preventDefault();
    go(a.href);
  }

  /**
   * Draws Felix's lasting outer page: the bottom bar, the drag areas for when the installed app's title bar is
   * hidden, and the page the window opened at loading in a frame.
   */
  /**
   * Reloads Felix's whole window, the bottom bar and every page in it, and asks for a newer service worker on the
   * way. The menu at the top of the screen belongs to macOS, so this is how a hard reload is offered.
   */
  function hardReload() {
    navigator.serviceWorker?.getRegistration().then((reg) => reg?.update()).catch(() => {});
    window.top.location.reload();
  }

  /**
   * A plain reload (⌘R, Ctrl+R or F5) reloads only the page in Felix's window, so the bottom bar, and the music,
   * carry on. A hard reload (⇧⌘R or ⌥⌘R) reloads everything, as after an update; the music then picks up where it
   * was once Spotify's player reconnects. Felix handles both, since the installed app's window may not.
   * @param {KeyboardEvent} e
   */
  function softReload(e) {
    const key = e.key === "F5" || ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "r");
    if (!key) return;
    if (e.shiftKey || e.altKey) {
      e.preventDefault();
      return hardReload();
    }
    const page = host ? window : frames.current?.contentWindow;
    if (!page) return;
    e.preventDefault();
    page.location.reload();
  }

  function mountHost() {
    document.documentElement.dataset.mode = cachedSettings()?.mode || "work";
    wireVoiceKeys();
    addEventListener("keydown", softReload);
    syncTitlebar();
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", syncTitlebar);
    if (host) {
      document.getElementById("felix-pages")?.remove();
      document.getElementById("boot")?.remove();
      return;
    }
    setTimeout(bootDone, BOOT_MAX_MS);
    mountDock();
    frames.drag = [0, 1].map(() => document.body.appendChild(Object.assign(document.createElement("div"), { className: "drag-area", hidden: true })));
    document.addEventListener("click", keepInFrame);
    addEventListener("popstate", onHistory);
    addEventListener("resize", placeDragAreas);
    navigator.windowControlsOverlay?.addEventListener("geometrychange", onTitlebar);
    frames.current = newFrame(pathOf(location));
  }

  /**
   * In a framed page, on a link click: other sites open in a new tab, since most refuse to load in a frame; other
   * Felix pages open through the outer page; a #section of this page moves without a history entry of the frame's
   * own, which the outer page adds instead.
   * @param {MouseEvent} e
   */
  function onFrameClick(e) {
    const a = e.target.closest?.("a[href]");
    if (a && !a.target && a.origin !== location.origin) Object.assign(a, { target: "_blank", rel: "noopener" });
    if (!felixLink(e)) return;
    e.preventDefault();
    if (a.pathname !== location.pathname || a.search !== location.search || !a.hash) return host.FelixShell.go(a.href);
    if (a.hash === location.hash) return;
    location.replace(a.href);
    host.FelixShell.syncFrame(window, true);
  }

  /**
   * In a framed page: tells the outer page when it has drawn and each time its address changes. The page's own
   * history entries go to the outer page, so they outlast this frame.
   */
  function followFromFrame() {
    host.FelixShell?.dressFrame?.(document);
    addEventListener("keydown", softReload);
    const tell = () => host.FelixShell?.syncFrame(window);
    const replace = history.replaceState.bind(history);
    history.replaceState = (...args) => {
      replace(...args);
      tell();
    };
    history.pushState = (...args) => {
      replace(...args);
      host.FelixShell?.syncFrame(window, true);
    };
    addEventListener("popstate", tell);
    addEventListener("hashchange", tell);
    addEventListener("click", onFrameClick);
    const drawn = () => requestAnimationFrame(() => requestAnimationFrame(() => host.FelixShell?.frameReady(window)));
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", drawn);
    else drawn();
  }

  if (host) followFromFrame();

  const TOAST_ICONS = {
    ok: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    bad: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 7.5v6M12 17h.01"/></svg>`,
    info: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 11v6M12 7h.01"/></svg>`,
  };

  /**
   * Felix's toast: a short note at the bottom centre, just above the Felix bar, that fades away by itself. A framed
   * page hands it to the outer page, so every toast lands in the same place. A toast with the same `id` (or the same
   * words) takes the place of the one showing instead of stacking; at most three show at once.
   * @param {string} text Like "Saved".
   * @param {{ detail?: string, tone?: "ok" | "bad" | "info", ms?: number, id?: string }} [options] `detail` is a
   *   quieter second part; `id` names what it's about, like the setting it saved.
   */
  function toast(text, { detail = "", tone = "ok", ms = tone === "bad" ? 5000 : 2200, id = "" } = {}) {
    if (host?.FelixShell?.toast) return host.FelixShell.toast(text, { detail, tone, ms, id });
    let stack = document.querySelector(".toasts");
    if (!stack) {
      stack = Object.assign(document.createElement("div"), { className: "toasts" });
      stack.setAttribute("aria-live", "polite");
      document.body.append(stack);
    }
    const key = id || `${tone}|${text}|${detail}`;
    let el = [...stack.children].find((t) => t.dataset.key === key && !t.classList.contains("leaving"));
    if (el) {
      el.className = `toast ${tone}`;
      el.querySelector(".ic").innerHTML = TOAST_ICONS[tone] || TOAST_ICONS.ok;
      el.querySelector("b").textContent = text;
      if (!el.querySelector(".detail") && detail) el.querySelector("b").insertAdjacentHTML("afterend", "<span class=\"detail\"></span>");
      el.querySelector(".detail")?.replaceChildren(detail);
      void el.offsetWidth;
      el.classList.add("again");
    } else {
      el = document.createElement("div");
      el.className = `toast ${tone}`;
      el.dataset.key = key;
      el.setAttribute("role", tone === "bad" ? "alert" : "status");
      el.innerHTML = `<span class="ic">${TOAST_ICONS[tone] || TOAST_ICONS.ok}</span><b></b>${detail ? "<span class=\"detail\"></span>" : ""}`;
      el.querySelector("b").textContent = text;
      if (detail) el.querySelector(".detail").textContent = detail;
      stack.append(el);
      while (stack.children.length > 3) stack.firstElementChild.remove();
    }
    clearTimeout(el._timer);
    el._timer = setTimeout(() => {
      el.classList.add("leaving");
      el.addEventListener("animationend", () => el.remove(), { once: true });
      setTimeout(() => el.remove(), 400);
    }, ms);
  }

  /**
   * Felix's own "are you sure?" dialog, in place of the browser's. It opens over whatever is showing (even another
   * dialog), puts focus on Cancel so Enter never deletes by accident, and Esc or a click outside cancels.
   * @param {{ title: string, text?: string, confirm?: string, cancel?: string, danger?: boolean }} options
   * @returns {Promise<boolean>} True when you confirmed.
   */
  function confirmBox({ title, text = "", confirm = "OK", cancel = "Cancel", danger = false }) {
    return new Promise((resolve) => {
      const dlg = document.createElement("dialog");
      dlg.className = `felix-confirm${danger ? " danger" : ""}`;
      dlg.innerHTML = `<form method="dialog"><div class="fc-body">${danger ? `<span class="fc-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15M9.5 7V5a1.5 1.5 0 0 1 1.5-1.5h2A1.5 1.5 0 0 1 14.5 5v2M6.5 7l1 12a2 2 0 0 0 2 1.8h5a2 2 0 0 0 2-1.8l1-12"/></svg></span>` : ""}`
        + `<div class="fc-text"><b></b><p></p></div></div>`
        + `<div class="fc-foot"><button class="fc-btn" value="no"></button><button class="fc-btn primary" value="yes"></button></div></form>`;
      dlg.querySelector("b").textContent = title;
      dlg.querySelector("p").textContent = text;
      dlg.querySelector("p").hidden = !text;
      dlg.querySelector('[value="no"]').textContent = cancel;
      dlg.querySelector('[value="yes"]').textContent = confirm;
      dlg.setAttribute("aria-label", title);
      dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close("no"); });
      dlg.addEventListener("close", () => {
        resolve(dlg.returnValue === "yes");
        dlg.remove();
      });
      document.body.append(dlg);
      dlg.showModal();
      dlg.querySelector('[value="no"]').focus();
    });
  }

  return { SETTINGS_CACHE, mark, mount, mountHost, go, frameReady, syncFrame, dressFrame, windows, setMode, restartRing, hardReload, request, cachedSettings, loadSettings, saveSettings, resetSettings, toast, confirm: confirmBox };
})();
