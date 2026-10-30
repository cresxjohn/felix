// Ideas for what to ask Felix, typed into the empty chat box's placeholder one at a time: each types in, stays a
// moment, then backspaces out for the next. Work and Personal each have their own, and each is something Felix can
// already do. They stop while you type, while the box has your text, and while the window is hidden; with reduced
// motion they swap without the typing.
(() => {
  const HINTS = {
    work: [
      "who's on call?",
      "show my PRs with conflicts",
      "when is my next shift?",
      "what's waiting on my review?",
      "did my PR reach prod?",
      "how much Claude usage is left?",
      "what's in the current release?",
      "open the releases tab",
    ],
    personal: [
      "play something calm",
      "skip this song",
      "I had a long day",
      "help me plan my weekend",
      "what can you do?",
      "switch to Work",
    ],
  };
  /**
   * The start of each hint, with Felix's name as set in Settings: "Ask Felix, like “".
   * @returns {string}
   */
  const lead = () => `Ask ${window.FelixShell?.cachedSettings()?.felixName || "Felix"}, like “`;
  const TAIL = "”";
  const TYPE_MS = 45;
  const ERASE_MS = 22;
  const HOLD_MS = 2600;
  const GAP_MS = 350;
  const STILL_MS = 4000;

  const state = { mode: "", list: [], at: 0, shown: 0, phase: "type", timer: 0 };

  /**
   * The empty pill's chat box, if it's on screen.
   * @returns {HTMLInputElement | null}
   */
  const box = () => document.querySelector(".dock .felix input[name='q']");

  /** @returns {boolean} */
  const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

  /**
   * The ideas for the mode on screen, starting at a random one so the first idea varies.
   * @returns {string[]}
   */
  function ideas() {
    const mode = document.documentElement.dataset.mode === "personal" ? "personal" : "work";
    if (mode !== state.mode) {
      state.mode = mode;
      state.list = HINTS[mode];
      state.at = Math.floor(Math.random() * state.list.length);
      state.shown = 0;
      state.phase = "type";
    }
    return state.list;
  }

  /**
   * Puts the current amount of the idea in the placeholder.
   * @param {HTMLInputElement} input
   * @param {string} idea
   */
  function show(input, idea) {
    input.placeholder = `${lead()}${idea.slice(0, state.shown)}${state.shown ? TAIL : ""}`;
  }

  /**
   * One step: type a letter, hold, erase a letter, or move on to the next idea. Waits while you're typing, the
   * window is hidden, or Felix holds the box's placeholder.
   */
  function step() {
    const input = box();
    const list = ideas();
    const idea = list[state.at % list.length];
    // Felix holds the placeholder while a conversation is on ("I'm all ears…"); the ideas wait.
    if (!input || document.hidden || input.value || input.dataset.hold) return later(600);
    if (reduced()) {
      state.shown = idea.length;
      show(input, idea);
      state.at += 1;
      return later(STILL_MS);
    }
    if (state.phase === "type") {
      state.shown = Math.min(idea.length, state.shown + 1);
      show(input, idea);
      if (state.shown < idea.length) return later(TYPE_MS + Math.random() * 40);
      state.phase = "erase";
      return later(HOLD_MS);
    }
    state.shown = Math.max(0, state.shown - 1);
    show(input, idea);
    if (state.shown > 0) return later(ERASE_MS);
    state.phase = "type";
    state.at += 1;
    return later(GAP_MS);
  }

  /**
   * Runs the next step after a while.
   * @param {number} ms
   */
  function later(ms) {
    clearTimeout(state.timer);
    state.timer = setTimeout(step, ms);
  }

  // A mode switch starts the new mode's ideas at once.
  new MutationObserver(() => {
    if ((document.documentElement.dataset.mode === "personal" ? "personal" : "work") !== state.mode) later(0);
  }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
  document.addEventListener("visibilitychange", () => { if (!document.hidden) later(300); });
  later(800);
})();
