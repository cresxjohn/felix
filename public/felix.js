/**
 * Felix's chat in the bottom bar: type a question or a command, or click the mic and say it, and the answer shows
 * in a panel above the bar with the sources it came from, read aloud when Settings say so. Felix lives in the
 * lasting outer page, so the conversation carries on between pages; a page inside it uses the outer page's Felix.
 */
window.FelixBuddy = (window.frameElement?.classList.contains("felix-page") && window.parent.FelixBuddy) || (() => {
  const KEEP = 30;
  const WARM_EVERY_MS = 5 * 60_000;
  const RELOAD_AFTER_MS = 5000;
  const WATCH_EVERY_MS = 30_000;
  // How long after the chat opens a click can't close it: the click that opened it is still landing.
  const OPEN_GRACE_MS = 400;
  // All ears in the chat: how long one listen waits for you to start talking before it starts again, and the short
  // pause between listens.
  const EARS_WAIT_MS = 60_000;
  const EARS_REST_MS = 350;
  // All ears, a pause has to be longer before what you said counts as done, and a thought that trails off on a
  // joining word ("and", "so", "um") waits a little more for the rest.
  const EARS_SILENCE_MS = 1800;
  const EARS_MORE_MS = 8000;
  const EARS_MAX_MS = 60_000;
  // After you cut in, how long Felix waits for the rest of your sentence.
  const BARGE_MORE_MS = 2500;
  // Bubbles fade this long after the conversation goes quiet; Felix keeps listening.
  const BUBBLE_FADE_MS = 15_000;
  // A conversation without the full chat ends after this long with nothing said or done, and the mic closes.
  const CONVO_IDLE_MS = 2 * 60_000;
  // Heard text sharing this much with what Felix just said aloud is his own voice, not yours.
  const ECHO_SHARE = 0.7;
  // A hidden conversation's unspoken reply shows this long, cut to this many letters.
  const FLASH_MS = 12_000;
  const FLASH_CHARS = 280;
  // The longest one hold of the talk key records.
  const PTT_MAX_MS = 60_000;
  const TRAILING = /(^|\s)(and|but|so|or|because|cause|um+|uh+|er+|also|plus)[\s,.…-]*$/i;
  // What speech-to-text makes up from a quiet room or a cough; heard while all ears, it's dropped.
  // What speech-to-text makes up from a quiet room or a cough ("you", "Mm, mm, mm", "Thanks for watching"): a line
  // made only of fillers is dropped while Felix listens.
  const FILLERS = new Set(["you", "uh", "um", "hm", "m", "mhm", "ah", "oh", "er", "eh"]);
  const isNoise = (text) => {
    const words = String(text).toLowerCase().match(/[a-z']+/g) || [];
    return !words.length || /^thanks? (you )?for watching/.test(words.join(" ")) || words.every((w) => FILLERS.has(w.replace(/(.)\1+/g, "$1")));
  };
  // A bare "thank you" is what speech-to-text most often makes up from a quiet room: it doesn't end listening.
  const BARE_THANKS = /^(ok(ay)?,? )?(thanks|thank you)( so much)?[.!]*$/i;
  const APPLY_TOLD = "felix:apply-told";
  const APPLY_TELL_MS = 10 * 60_000;
  const OFFLINE = "Can't reach the local server. Start it with ./prs start.";
  const STOPPED = "Stopped. Ask again whenever you like.";
  const YES = /^(yes|yeah|yep|yup|sure|ok(ay)?|do it|go ahead|go for it|confirm|please do)\b/i;
  const NO = /^(no|nope|nah|cancel|stop|don'?t|never ?mind|not now)\b/i;
  const VOICE_STEPS = { listening: "Listening. Just talk; I'll stop when you do", hearing: "Working out what you said" };
  const ICONS = {
    send: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m13 6 6 6-6 6"/></svg>`,
    mic: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>`,
    close: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg>`,
    stop: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2"/></svg>`,
    up: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5M6 11l6-6 6 6"/></svg>`,
    check: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`,
    expand: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 4h6v6M10 20H4v-6M20 4l-7 7M4 20l7-7"/></svg>`,
    caret: `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M9 6.5v11l8-5.5z"/></svg>`,
    collapse: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>`,
    square: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`,
    down: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 14V3M10 15l-1 5a2 2 0 0 0 2 2l4-7V3H6.5a2 2 0 0 0-2 1.6l-1.4 7A2 2 0 0 0 5 14h5z"/></svg>`,
  };
  // How each voice bar moves with the level, so the wave peaks in the middle.
  const WAVE = [0.45, 0.7, 0.9, 1, 0.9, 0.7, 0.45];
  const FACE = { idle: "", listening: "listening", hearing: "thinking", thinking: "thinking", talking: "talking" };
  // How Felix's colours turn round his pill, in degrees a second: a quick burst when he becomes active (backwards
  // when he stops), easing into a slow turn while he's active, or to a stop at rest.
  const SPIN = { active: 90, burst: 1080, rampMs: 180, easeS: 0.45 };
  const spin = { angle: 0, vel: 0, dir: 1, boostUntil: 0, active: false, frame: 0, last: 0 };

  /**
   * @typedef {{ label: string, link: string | null }} Chip
   * @typedef {{ id: string, title: string, detail: string }} AllowCard A change Felix's AI wants to make, waiting for a click or a typed yes.
   * @typedef {{ path: string, status: string }} Change
   * @typedef {{ who: "you" | "felix", text: string, chips?: Chip[], by?: string, confirm?: { id: string, label: string }, error?: boolean,
   *   allow?: AllowCard, changes?: Change[], shot?: string, note?: string, steps?: string[], tests?: { ok: boolean, tail: string } }} Message
   *   `note` is a small line under one of your messages; `shot` is the address of a picture of the page the changes
   *   touch; `tests` is how Felix's own test run in the workbench went.
   */
  const state = {
    /** @type {HTMLElement | null} */ el: null,
    /** @type {HTMLElement | null} */ panel: null,
    /** @type {HTMLElement | null} */ scrim: null,
    /** @type {HTMLElement | null} */ say: null,
    /** The phrase Felix is saying aloud right now, or null. */ saying: /** @type {string | null} */ (null),
    /** The steps of the answer in progress, as the server names them. */ steps: /** @type {string[]} */ ([]),
    /** When the answer in progress started, for its timer. */ startedAt: 0,
    /** Which folded step lines are open: a message's key, or "live" for the answer in progress. */ openSteps: new Set(),
    /** The last key given to a message. */ keys: 0,
    /** What you're saying so far, while Felix listens. */ partial: "",
    /** A conversation is on without the full chat: Felix listens, and bubbles show it (when Settings say so). */ convo: false,
    /** You opened the full chat from the bubbles. */ wantPanel: false,
    /** The first half of a thought that trailed off, shown while Felix listens for the rest. */ partialLead: "",
    /** What Felix said aloud lately, so his own voice coming back through the mic isn't taken as yours. */ recentSaid: /** @type {string[]} */ ([]),
    /** You closed the chat while he worked: it stays closed until you come back to it. */ collapsed: false,
    /** What you said cutting in while he talked, waiting for the rest of your sentence. */ bargeLead: "",
    /** @type {AbortController | null} */ abort: null,
    /** @type {Message[]} */ messages: [],
    /** @type {string[]} */ asked: [],
    recall: -1,
    step: "",
    busy: false,
    /** Questions waiting for the one in progress, and whether you said them. @type {Array<{ text: string, spoken: boolean }>} */ next: [],
    warmedAt: 0,
    /** @type {"" | "listening" | "hearing"} */ voice: "",
    /** Why Felix should keep quiet right now, from the server: "locked", "away", "meeting", or null. */ quiet: /** @type {string | null} */ (null),
    voiceChecked: false,
    /** @type {{ add: (text: string) => void, end: (text: string) => Promise<boolean>, say: (line: string) => Promise<void> } | null} */ speech: null,
    /** The progress lines of the answer in progress, while they may still be said. */
    progress: /** @type {{ step: (step: string) => void, stop: () => void } | null} */ (null),
    /** /felix-progress.mjs once loaded, which makes the progress lines. */
    progressKit: /** @type {typeof import("./felix-progress.mjs") | null} */ (null),
    stream: { target: "", shown: 0, frame: 0, /** @type {(() => void) | null} */ done: null },
  };
  const TYPE_FRAMES = 14;
  const TYPE_MIN = 2;

  /**
   * Text made safe to put in markup.
   * @param {unknown} s
   * @returns {string}
   */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /**
   * Whether Felix is turned on in Settings.
   * @returns {boolean}
   */
  const isOn = () => window.FelixShell?.cachedSettings()?.felixOn !== false;

  /**
   * What your buddy is called, as set in Settings.
   * @returns {string}
   */
  const who = () => String(window.FelixShell?.cachedSettings()?.felixName || "Felix");

  /**
   * The bar's Felix strip: the chat box, or a note when Felix is off.
   * @returns {string}
   */
  function stripHtml() {
    if (!isOn()) {
      return `${window.FelixShell.mark("lg")}<div class="text"><strong>${esc(who())} is off</strong><span>Turn it on in <a href="/settings#felix">Settings</a>.</span></div>`;
    }
    return rowHtml(false);
  }

  /**
   * Felix's row: his face, the ask box, and what shows instead of it while he listens or talks. It's the pill in
   * the bar and, while the chat is open, the reply row at the chat's foot (the pill grown into the chat).
   * @param {boolean} inPanel
   * @returns {string}
   */
  function rowHtml(inPanel) {
    const name = esc(who());
    const hint = inPanel ? "Ask a follow-up…" : `Ask ${name}, like “who's on call?” or “show my PRs with conflicts”`;
    return `${window.FelixShell.mark("lg")}`
      + `<form class="ask" data-felix="form"><input type="text" name="q" autocomplete="off" spellcheck="false" maxlength="2000" aria-label="Ask ${name}" placeholder="${hint}">`
      // In the chat, the mic sits right beside send; in the bar it stands after the box.
      + `${inPanel ? micHtml() : ""}<button class="round${inPanel ? " solid" : ""}" type="submit" aria-label="Send" title="Send (Enter)">${inPanel ? ICONS.up : ICONS.send}</button></form>`
      + `<div class="pill-live" aria-live="polite"><span class="cap"><b data-felix="cap">Listening…</b><span data-felix="sub">Just talk; I'll stop when you do.</span></span>`
      + `<span class="wave" aria-hidden="true">${WAVE.map(() => "<i></i>").join("")}</span></div>`
      + `<div class="pill-talk"><span class="cap"><b>${name} is talking</b><span>The music is turned down</span></span>`
      + `<button class="hush" type="button" data-felix="hush">Stop talking</button></div>`
      + (inPanel ? "" : micHtml());
  }

  /**
   * The mic button: lit while listening, and turned off where the browser can't record.
   * @returns {string}
   */
  function micHtml() {
    if (!window.FelixVoice?.supported()) {
      return `<button class="round mic off" type="button" aria-label="Talk to Felix" aria-disabled="true" title="Talking needs localhost or the tailnet https address">${ICONS.mic}</button>`;
    }
    const live = state.voice === "listening";
    return `<button class="round mic${state.voice ? " live" : ""}" type="button" data-felix="mic" aria-pressed="${live}" `
      + `aria-label="${live ? "Stop listening" : "Talk to Felix"}" title="${live ? "Stop listening" : "Talk to Felix"}">${live ? ICONS.stop : ICONS.mic}</button>`;
  }

  /**
   * What Felix is doing, for his face and the pill: listening, working out what you said, talking, thinking, or
   * nothing.
   * @returns {"idle" | "listening" | "hearing" | "talking" | "thinking"}
   */
  function mood() {
    // Listening in the background while he works, his face shows the work.
    if (state.ears && state.busy && state.voice === "listening") return "thinking";
    if (state.voice === "listening" || state.voice === "hearing") return state.voice;
    if (state.saying) return "talking";
    return state.busy ? "thinking" : "idle";
  }

  /**
   * Shows Felix's state on his face (every copy of it, in the pill and the chat), on the pill, and in the speech
   * bubble above the pill while he talks with the chat closed.
   */
  function paint() {
    const now = mood();
    for (const row of rows()) {
      // All ears, the chat's own row keeps its box so you can still type; its mic and face show he's listening.
      const ears = Boolean(state.ears) && now === "listening" && (row.classList.contains("fp-reply") || !state.panel);
      for (const m of ["listening", "hearing", "talking", "thinking"]) row.classList.toggle(`is-${m}`, now === m && !ears);
      row.classList.toggle("is-ears", ears);
      const cap = row.querySelector("[data-felix='cap']");
      const sub = row.querySelector("[data-felix='sub']");
      if (cap) cap.textContent = now === "hearing" ? "Working out what you said…" : state.ears ? "I'm all ears" : state.followUp ? "Your turn…" : "Listening…";
      if (sub) sub.textContent = now === "hearing" ? "One moment" : state.ears ? "Just talk, about anything. Or type." : state.followUp ? "Keep talking, or stay quiet to finish." : "Just talk; I'll stop when you do.";
      const face = row.querySelector(".mark");
      face?.classList.remove("listening", "thinking", "talking");
      if (FACE[now]) face?.classList.add(FACE[now]);
    }
    const reply = state.panel?.querySelector(".fp-reply input");
    if (reply) reply.placeholder = state.busy ? `Add to what ${who()} is doing…` : state.ears && now === "listening" ? "I'm all ears. Talk, or type…" : "Ask a follow-up…";
    // Without the full chat, the bar's own box is where you type.
    const pill = state.el?.querySelector("input[name='q']");
    const own = !state.panel && state.convo && (state.busy || (state.ears && now === "listening"));
    if (pill && own) {
      pill.dataset.hold = "1";
      pill.placeholder = state.busy ? `Add to what ${who()} is doing…` : "I'm all ears. Talk, or type…";
    } else if (pill?.dataset.hold) {
      // Handed back to the rotating ideas, which type the next one in.
      delete pill.dataset.hold;
      pill.placeholder = "";
    }
    lit();
    // His words show in the talking bubble only when nothing else shows the conversation.
    const style = chatStyle();
    // With the conversation hidden, a reply that isn't read aloud shows here for a moment, so it's never lost.
    sayBubble((now === "talking" && !state.panel && !state.bubbles && style !== "hidden" ? state.saying : null) || state.flash || null);
    if (state.bubbles) style === "bubbles" ? drawBubbles() : clearBubbles();
    tellMood();
  }

  /**
   * Shows a reply in the speech bubble for a while: for the hidden conversation, when it isn't read aloud.
   * @param {string} text
   */
  function flash(text) {
    state.flash = text.length > FLASH_CHARS ? `${text.slice(0, FLASH_CHARS).trimEnd()}…` : text;
    clearTimeout(state.flashTimer);
    state.flashTimer = setTimeout(() => { state.flash = ""; paint(); }, FLASH_MS);
    paint();
  }

  /**
   * The speech bubble above the pill: what Felix is saying aloud, a phrase at a time.
   * @param {string | null} text
   */
  function sayBubble(text) {
    if (!text) {
      state.say?.classList.remove("on");
      return;
    }
    if (!state.say) {
      state.say = Object.assign(document.createElement("div"), { className: "felix-say" });
      state.say.setAttribute("aria-hidden", "true");
      document.body.append(state.say);
    }
    state.say.textContent = text;
    const r = state.el.getBoundingClientRect();
    Object.assign(state.say.style, { left: `${r.left + 24}px`, maxWidth: `${Math.max(240, r.width - 48)}px`, bottom: `${innerHeight - r.top + 10}px` });
    state.say.classList.add("on");
  }

  /**
   * Moves the voice bars with how loud you are, while Felix listens.
   * @param {number} level From 0 to 1.
   */
  function wave(level) {
    for (const row of rows()) {
      row.querySelectorAll(".wave i").forEach((b, i) => { b.style.height = `${Math.round(5 + level * 22 * WAVE[i] * (0.8 + Math.random() * 0.4))}px`; });
    }
  }

  /**
   * Felix's rows on screen: the pill, and the chat's reply row while it's open.
   * @returns {HTMLElement[]}
   */
  const rows = () => [state.el, state.panel?.querySelector(".fp-reply")].filter(Boolean);

  /** Felix's working sign: three dots in his AI colour, bouncing in turn. */
  const SPINNER = `<span class="dots" aria-hidden="true"><i></i><i></i><i></i></span>`;

  /**
   * How long something took, the short way: 12s, or 5m 22s.
   * @param {number} ms
   * @returns {string}
   */
  function took(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
  }

  /**
   * What Felix did for an answer, folded into one line: the step he's on (or how many he took), how long, and a
   * caret that opens the full list.
   * @param {{ key: string, text: string, ms?: number, steps: string[], live?: boolean, by?: string }} work The
   *   model at work, when known, shows at the right.
   * @returns {string}
   */
  function workHtml({ key, text, ms, steps, live = false, by = "" }) {
    const open = state.openSteps.has(key);
    const caret = steps.length ? `<span class="work-caret">${ICONS.caret}</span>` : "";
    const time = ms === undefined ? "" : `<span class="work-time"${live ? " data-felix-time" : ""}>${took(ms)}</span>`;
    const button = `<button type="button" class="work${live ? " live" : ""}${open ? " open" : ""}" data-felix="steps" data-key="${esc(key)}"`
      + `${steps.length ? ` aria-expanded="${open}"` : " disabled"}>${live ? SPINNER : ""}<span class="work-text">${esc(text)}</span>${time}${caret}</button>`;
    const model = by ? `<span class="work-by" title="The model working on it">${esc(by)}</span>` : "";
    const list = open && steps.length ? `<ol class="work-list">${steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>` : "";
    return `<div class="work-line">${button}${model}</div>${list}`;
  }

  /**
   * The steps an answer took, as one folded line under it.
   * @param {Message} m
   * @returns {string}
   */
  function stepsHtml(m) {
    const steps = m.steps || [];
    if (!steps.length) return "";
    const text = steps.length === 1 ? steps[0] : `${steps.length} steps`;
    return workHtml({ key: String(m.key), text, ms: m.took, steps });
  }

  /**
   * One message in the conversation.
   * @param {Message} m
   * @returns {string}
   */
  function messageHtml(m) {
    // A thumbs-down saves the answer to Felix's test set, so a wrong one gets fixed and stays fixed.
    const down = m.who === "felix" && m.id && !m.marked
      ? `<button type="button" class="ctl down" data-felix="wrong" data-id="${esc(m.id)}" aria-label="That's wrong" title="That's wrong: save it to Felix's test set">${ICONS.down}</button>` : "";
    const by = (m.by ? `<span class="by" title="Who answered">${esc(m.by)}</span>` : "") + down;
    const chips = by + (m.chips || []).map((c) => (c.link
      ? `<a class="chip" href="${esc(c.link)}"${c.link.startsWith("/") ? "" : ` target="_blank" rel="noopener"`}>${esc(c.label)}</a>`
      : `<span class="chip">${esc(c.label)}</span>`)).join("");
    const confirm = m.confirm
      ? `<div class="confirm"><button type="button" class="yes" data-felix="yes" data-id="${esc(m.confirm.id)}">${esc(m.confirm.label)}</button>`
        + `<button type="button" data-felix="no" data-id="${esc(m.confirm.id)}">Cancel</button></div>`
      : "";
    const note = m.note ? `<span class="note">${m.note.startsWith("Added") ? ICONS.check : ""}${esc(m.note)}</span>` : "";
    return `${stepsHtml(m)}<div class="msg ${m.who}${m.error ? " warn" : ""}${m.changes?.length ? " wide" : ""}"><p>${esc(m.text)}</p>${note}${allowHtml(m.allow)}${changesHtml(m.changes, m.shot, m.tests)}`
      + `${chips ? `<div class="chips">${chips}</div>` : ""}${confirm}</div>`;
  }

  /**
   * A change the AI wants to make: exactly what will run, with Allow and Don't allow.
   * @param {AllowCard | undefined} card
   * @returns {string}
   */
  function allowHtml(card) {
    if (!card) return "";
    return `<div class="allow"><pre class="detail">${esc(card.detail)}</pre><div class="confirm">`
      + `<button type="button" class="yes" data-felix="allow" data-id="${esc(card.id)}">Allow</button>`
      + `<button type="button" data-felix="deny" data-id="${esc(card.id)}">Don't allow</button></div></div>`;
  }

  /**
   * What Felix changed in its workbench, with Apply to Felix, See the code and Discard. A change to a page shows
   * as a picture of that page; one that doesn't touch a page says so, without listing files. Below it, how his
   * tests went there; Apply shows only when they passed.
   * @param {Change[] | undefined} changes
   * @param {string} [shot]
   * @param {{ ok: boolean, tail: string }} [tests]
   * @returns {string}
   */
  function changesHtml(changes, shot, tests) {
    if (!changes?.length) return "";
    // Apply is offered only once Felix's own test run in the workbench passed; a failing run shows why instead.
    const failed = tests && !tests.ok;
    const testLine = !tests ? "" : tests.ok
      ? `<p class="wb-tests ok">${ICONS.check}Tests pass in my workbench</p>`
      : `<p class="wb-tests bad">Tests fail in my workbench, so it isn't ready to apply. Ask me to fix it.</p><pre class="detail">${esc(tests.tail)}</pre>`;
    const count = `${changes.length} file${changes.length === 1 ? "" : "s"}`;
    const view = shot
      ? `<a class="shot" href="${esc(shot)}" target="_blank" rel="noopener" title="Open the picture" data-state="loading">`
        + `<img src="${esc(shot)}" alt="Felix with these changes" onload="this.parentElement.dataset.state='ready'"`
        + ` onerror="this.parentElement.dataset.state='failed'"><span class="shot-note">Taking a picture of the change…</span>`
        + `<span class="shot-failed">Couldn't take a picture. Changed ${esc(count)}.</span></a>`
      : `<p class="changed">Changed ${esc(count)}, with nothing new to see on screen.</p>`;
    return `<div class="wb"><div class="wb-shot">${view}</div>${testLine}<div class="wb-f">`
      + (failed ? "" : `<button type="button" class="yes" data-felix="apply">Apply to Felix</button>`)
      + `<a class="chip" href="/api/felix/diff" target="_blank" rel="noopener">See the code</a>`
      + `<button type="button" class="ghost" data-felix="discard">Discard</button></div></div>`;
  }

  /**
   * The address of a picture of the changes, when they touch a page. It names the reply, so the picture is
   * fetched once and stays the same as the panel redraws.
   * @param {Change[] | undefined} changes
   * @returns {string | undefined}
   */
  const shotFor = (changes) => (changes?.some((c) => c.path.startsWith("public/") && c.status !== "deleted")
    ? `/api/felix/preview.png?v=${Date.now()}` : undefined);

  /**
   * The conversation panel's markup.
   * @returns {string}
   */
  function panelHtml() {
    const s = state.stream;
    // All ears in the chat, the waiting isn't a step: the head says so, and the list stays as it is.
    const ears = state.ears && state.voice === "listening";
    const heard = state.voice && !ears ? VOICE_STEPS[state.voice] : "";
    const doing = heard || (state.busy && !s.target && (state.step || "Looking into it"));
    const done = state.busy ? state.steps.filter((t) => t !== state.step) : [];
    const step = !doing ? ""
      : heard ? `<div class="step voice">${SPINNER}<span>${esc(doing)}…</span></div>`
      : workHtml({ key: "live", text: `${doing}…`, ms: Date.now() - state.startedAt, steps: done, live: true, by: state.liveBy });
    const live = state.partial ? `<div class="msg you live"><p>${esc(state.partial)}</p></div>` : "";
    const typing = s.target ? `<div class="msg felix typing"><p>${esc(s.target.slice(0, s.shown))}</p></div>` : "";
    const empty = state.messages.length || doing ? "" : `<p class="fp-empty">Ask about on-call, your PRs, releases or AI usage. Try “help”, or click the mic and say it.</p>`;
    const status = doing ? `${doing}` : ears ? "All ears" : state.messages.findLast((m) => m.by)?.by || "Your buddy";
    const stop = state.busy ? `<button type="button" class="stop" data-felix="stop">${ICONS.square}Stop</button>` : "";
    return {
      head: `<b>${esc(who())}</b><span class="status">${esc(status)}</span><span class="spacer"></span>${stop}`
        + `<button type="button" class="ctl" data-felix="close" aria-label="Collapse" title="Collapse (Esc)">${ICONS.collapse}</button>`,
      list: `${empty}${state.messages.map(messageHtml).join("")}${live}${typing}${step}`,
    };
  }

  /**
   * Puts the panel just above the Felix strip, as wide as it.
   */
  function place() {
    if (!state.panel || !state.el) return;
    const r = state.el.getBoundingClientRect();
    Object.assign(state.panel.style, { left: `${r.left}px`, width: `${r.width}px`, bottom: `${innerHeight - r.bottom}px` });
  }

  /**
   * How the conversation shows, as Settings say: nothing at all, bubbles above the bar, or the full chat.
   * @returns {"hidden" | "bubbles" | "panel"}
   */
  function chatStyle() {
    const v = window.FelixShell?.cachedSettings()?.felixChatStyle;
    return v === "hidden" || v === "panel" ? v : "bubbles";
  }

  /**
   * Whether the latest messages need the full chat: a card to answer, or changes to apply.
   * @returns {boolean}
   */
  const needsPanel = () => Boolean(waitingCard()) || state.messages.slice(-3).some((m) => m.confirm || m.changes?.length);

  /**
   * The conversation without the full chat: it starts (and Felix starts listening) the first time, and shows as
   * bubbles above the bar, or not at all.
   */
  function renderBare() {
    if (!state.convo) {
      state.convo = true;
      state.openedAt = performance.now();
      touchConvo();
      armEars();
    }
    if (chatStyle() === "bubbles") drawBubbles();
    else clearBubbles();
    paint();
  }

  /**
   * Keeps a conversation going: two minutes with nothing said or done ends it and the mic closes. Without the full
   * chat the conversation closes; the full chat stays open but stops listening (the mic button starts it again).
   * Felix working or talking doesn't count as quiet.
   */
  function touchConvo() {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(function idle() {
      if (!state.convo && !state.panel) return;
      if (state.busy || state.saying || state.partial) return void (state.idleTimer = setTimeout(idle, CONVO_IDLE_MS));
      if (!state.panel) return close();
      state.earsOff = true;
      earsStop();
      paint();
    }, CONVO_IDLE_MS);
  }

  /**
   * The latest exchange as bubbles above the bar: what you said (live as you speak) on the right, and Felix on the
   * left: what he's doing, his reply as it comes in, or his last answer. They fade once things go quiet.
   */
  function drawBubbles() {
    if (!state.el) return;
    if (!state.bubbles) {
      state.bubbles = Object.assign(document.createElement("div"), { className: "felix-bubbles" });
      state.bubbles.setAttribute("aria-live", "polite");
      state.bubbles.addEventListener("click", onPanelClick);
      document.body.append(state.bubbles);
    }
    const lastYou = state.messages.findLastIndex((m) => m.who === "you");
    const after = state.messages.slice(lastYou + 1).filter((m) => m.who === "felix");
    const s = state.stream;
    const you = lastYou >= 0 ? state.messages[lastYou].text : "";
    let felix = "";
    if (s.target) felix = `<p>${esc(s.target.slice(0, s.shown))}</p>`;
    else if (state.busy) {
      const done = state.steps.filter((t) => t !== state.step);
      felix = workHtml({ key: "live", text: `${state.step || "Looking into it"}…`, ms: Date.now() - state.startedAt, steps: done, live: true, by: state.liveBy });
    } else if (after.length) felix = `<p>${esc(after.at(-1).text)}</p>`;
    const open = `<button type="button" class="bub-open" data-felix="open" title="Open the full chat" aria-label="Open the full chat">${ICONS.expand}</button>`;
    const youHtml = (text, live = false) => (text ? `<div class="bub you${live ? " live" : ""}"><p>${esc(text)}</p></div>` : "");
    const felixHtml = felix ? `<div class="bub felix${state.busy && !s.target ? " working" : ""}">${felix}${open}</div>` : "";
    // In the order it was said: your question and his answer; while you talk again, his answer (or what he's
    // doing) and then your words so far.
    patchBubbles(state.partial ? [felixHtml, youHtml(state.partial, true)] : [youHtml(you), felixHtml]);
    const r = state.el.getBoundingClientRect();
    Object.assign(state.bubbles.style, { left: `${r.left + 12}px`, width: `${Math.max(240, r.width - 24)}px`, bottom: `${innerHeight - r.top + 10}px` });
    // Quiet for a while, the bubbles fade; anything new brings them back.
    const quiet = !state.busy && !state.partial && !state.saying && !s.target && state.voice !== "hearing";
    state.bubbles.classList.remove("faded");
    clearTimeout(state.fadeTimer);
    if (quiet) state.fadeTimer = setTimeout(() => state.bubbles?.classList.add("faded"), BUBBLE_FADE_MS);
  }

  /**
   * Updates the bubbles in place: one that keeps its kind keeps its element (so it doesn't fade in again on every
   * letter typed), and only what changed is written.
   * @param {string[]} parts Each bubble's markup, "" for none.
   */
  function patchBubbles(parts) {
    const want = parts.filter(Boolean).map((html) => {
      const t = document.createElement("template");
      t.innerHTML = html;
      return /** @type {HTMLElement} */ (t.content.firstElementChild);
    });
    const have = [...state.bubbles.children];
    want.forEach((next, i) => {
      const cur = have[i];
      if (cur && cur.className.replace(/ live| working/g, "") === next.className.replace(/ live| working/g, "")) {
        if (cur.className !== next.className) cur.className = next.className;
        if (cur.innerHTML !== next.innerHTML) cur.innerHTML = next.innerHTML;
      } else if (cur) cur.replaceWith(next);
      else state.bubbles.append(next);
    });
    have.slice(want.length).forEach((el) => el.remove());
  }

  /**
   * Takes the bubbles away.
   */
  function clearBubbles() {
    clearTimeout(state.fadeTimer);
    state.bubbles?.remove();
    state.bubbles = null;
  }

  /**
   * Draws the conversation, opening the panel when it isn't open, and scrolls to the newest message.
   * @param {{ keepScroll?: boolean }} [opts] Keep the scroll where it is, as when a step line opens.
   */
  function renderPanel({ keepScroll = false } = {}) {
    // Closed while he works, it stays closed (his answer waits in it) unless a card needs you.
    if (state.collapsed && !state.panel && !state.convo && !needsPanel()) return paint();
    state.collapsed = false;
    // Without the full chat (Settings), it shows as bubbles or not at all, until a card needs it or you open it.
    if (!state.panel && chatStyle() !== "panel" && !state.wantPanel && !needsPanel()) return renderBare();
    clearBubbles();
    state.convo = true;
    if (!state.scrim) {
      state.scrim = Object.assign(document.createElement("div"), { className: "felix-scrim" });
      document.body.append(state.scrim);
    }
    lit();
    if (!state.panel) {
      state.panel = Object.assign(document.createElement("div"), { className: "felix-panel" });
      state.panel.setAttribute("role", "dialog");
      state.panel.setAttribute("aria-label", "Felix");
      state.panel.innerHTML = `<div class="fp-head"></div><div class="fp-list" aria-live="polite"></div><div class="fp-reply felixrow">${rowHtml(true)}</div>`;
      state.panel.addEventListener("click", onPanelClick);
      wireRow(state.panel.querySelector(".fp-reply"));
      document.body.append(state.panel);
      state.openedAt = performance.now();
      touchConvo();
      // Typing pauses the listening; an emptied box picks it up again.
      const box = state.panel.querySelector(".fp-reply input");
      box?.addEventListener("input", () => (box.value ? earsStop() : armEars()));
      armEars();
      const typed = state.el?.querySelector("input[name='q']");
      const reply = state.panel.querySelector(".fp-reply input");
      if (typed?.value) [reply.value, typed.value] = [typed.value, ""];
      if (document.activeElement === typed || state.el?.contains(document.activeElement)) reply.focus();
    }
    const html = panelHtml();
    state.panel.querySelector(".fp-head").innerHTML = html.head;
    state.panel.querySelector(".fp-list").innerHTML = html.list;
    place();
    paint();
    const list = state.panel.querySelector(".fp-list");
    if (!keepScroll) list.scrollTop = list.scrollHeight;
  }

  /**
   * Closes the conversation panel. The conversation is kept for next time.
   */
  function close() {
    clearTimeout(state.idleTimer);
    earsStop();
    state.earsOff = false;
    state.collapsed = state.busy;
    state.convo = false;
    state.wantPanel = false;
    clearBubbles();
    const reply = state.panel?.querySelector(".fp-reply input");
    const typed = state.el?.querySelector("input[name='q']");
    if (reply?.value && typed) typed.value = reply.value;
    state.panel?.remove();
    state.panel = null;
    state.scrim?.remove();
    state.scrim = null;
    paint();
  }

  /**
   * Lights Felix's pill while the chat is open or he's listening, and keeps it above the dimmed page.
   */
  function lit() {
    const on = Boolean(state.panel || state.scrim || state.convo || state.voice || state.saying);
    state.el?.classList.toggle("on", on);
    spinFor(on || Boolean(state.el?.matches(":focus-within")));
    state.el?.classList.toggle("open", Boolean(state.panel));
    document.body.classList.toggle("felix-open", Boolean(state.panel));
  }

  /**
   * Starts the colours' burst when Felix becomes active (or stops being), and lets them ease into their steady turn.
   * @param {boolean} active
   */
  function spinFor(active) {
    if (active === spin.active) return;
    spin.active = active;
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    spin.dir = active ? 1 : -1;
    spin.boostUntil = performance.now() + SPIN.rampMs;
    if (spin.frame) return;
    spin.last = performance.now();
    spin.frame = requestAnimationFrame(turn);
  }

  /**
   * One frame of the colours' turn: the speed eases toward its aim (fast during the burst, slow while active, none at
   * rest), and the pill and its glow take the new angle.
   * @param {number} now
   */
  function turn(now) {
    const dt = Math.min(0.05, (now - spin.last) / 1000);
    spin.last = now;
    const burst = now < spin.boostUntil;
    const aim = burst ? spin.dir * SPIN.burst : spin.active ? SPIN.active : 0;
    spin.vel += (aim - spin.vel) * (1 - Math.exp(-dt / (burst ? 0.08 : SPIN.easeS)));
    spin.angle = (spin.angle + spin.vel * dt + 360) % 360;
    state.el?.style.setProperty("--felix-turn", `${spin.angle.toFixed(1)}deg`);
    if (!spin.active && !burst && Math.abs(spin.vel) < 1) {
      spin.vel = 0;
      spin.frame = 0;
      return;
    }
    spin.frame = requestAnimationFrame(turn);
  }

  /**
   * Adds a message, keeping only the latest few.
   * @param {Message} m
   */
  function add(m) {
    m.key ??= ++state.keys;
    touchConvo();
    state.messages = [...state.messages, m].slice(-KEEP);
  }

  /**
   * Opens a Felix page: in the outer page's frame when there is one, else as a normal page load.
   * @param {string} route
   */
  function open(route) {
    if (document.getElementById("felix-pages")) window.FelixShell.go(route);
    else location.assign(route);
  }

  /**
   * Does what an answer asks of the page: open a page, change settings, or control the music.
   * @param {{ navigate?: string, settings?: Record<string, unknown>, music?: string }} answer
   * @returns {Promise<void>}
   */
  async function carryOut(answer) {
    if (answer.navigate) open(answer.navigate);
    if (answer.music) window.FelixMusic?.command(answer.music);
    // A task Felix added or ticked off: the Tasks card on Home loads again.
    if (answer.tasks) new BroadcastChannel("felix-tasks").postMessage("changed");
    if (answer.settings) {
      try {
        await window.FelixShell.saveSettings(answer.settings);
      } catch (e) {
        add({ who: "felix", text: `I couldn't change that setting: ${e.message}`, error: true });
      }
    }
  }

  /**
   * Shows more of the reply being typed, without redrawing the rest of the panel.
   */
  function paintTyping() {
    if (!state.panel) return void (state.bubbles && drawBubbles());
    const p = state.panel.querySelector(".msg.typing p");
    if (!p) return renderPanel();
    p.textContent = state.stream.target.slice(0, state.stream.shown);
    const list = state.panel.querySelector(".fp-list");
    list.scrollTop = list.scrollHeight;
  }

  /**
   * Types the reply out a few letters a frame, faster when it's further behind, so it keeps up with the AI.
   * A hidden window skips straight to the end.
   */
  function typeOn() {
    const s = state.stream;
    if (s.frame) return;
    if (document.hidden) s.shown = s.target.length;
    if (s.shown >= s.target.length) {
      paintTyping();
      s.done?.();
      s.done = null;
      return;
    }
    s.frame = requestAnimationFrame(() => {
      s.frame = 0;
      s.shown = Math.min(s.target.length, s.shown + Math.max(TYPE_MIN, Math.ceil((s.target.length - s.shown) / TYPE_FRAMES)));
      paintTyping();
      typeOn();
    });
  }

  /**
   * Adds a checked piece of the reply as it streams in; null takes back what was shown, for a second try.
   * @param {string | null} piece
   */
  function streamText(piece) {
    const s = state.stream;
    if (piece === null) {
      Object.assign(s, { target: "", shown: 0 });
      return renderPanel();
    }
    const first = !s.target;
    s.target += piece;
    if (first) renderPanel();
    typeOn();
  }

  /**
   * Finishes typing the final reply: carries on from what's shown when it starts the same way, else starts over.
   * @param {string} text
   * @returns {Promise<void>}
   */
  function typeOut(text) {
    const s = state.stream;
    if (!text.startsWith(s.target.slice(0, s.shown))) s.shown = 0;
    const first = !s.target;
    s.target = text;
    if (first) renderPanel();
    return new Promise((resolve) => {
      s.done = resolve;
      typeOn();
    });
  }

  /**
   * Stops typing and forgets the reply being typed.
   */
  function endTyping() {
    cancelAnimationFrame(state.stream.frame);
    state.stream.done?.();
    state.stream = { target: "", shown: 0, frame: 0, done: null };
  }

  /**
   * Reads the server's answer as it comes: progress lines first, then the answer.
   * @param {Response} res
   * @param {(line: { step?: string, answer?: object, error?: string }) => void} onLine
   * @returns {Promise<void>}
   */
  async function readLines(res, onLine) {
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buffer = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += value;
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      lines.filter((l) => l.trim()).forEach((l) => onLine(JSON.parse(l)));
    }
    if (buffer.trim()) onLine(JSON.parse(buffer));
  }

  /**
   * Felix's answer to a question, as the server streams it, showing each step it takes on the way.
   * @param {string} text
   * @returns {Promise<{ text: string, chips?: Chip[], by?: string, confirm?: { id: string, label: string } }>}
   */
  async function fetchAnswer(text) {
    state.abort = new AbortController();
    const res = await fetch("/api/felix/ask", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text }), signal: state.abort.signal })
      .catch((e) => { throw new Error(e.name === "AbortError" ? STOPPED : OFFLINE); });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The server answered ${res.status}.`);
    let answer = null;
    await readLines(res, (line) => {
      if (line.by) {
        state.liveBy = line.by;
        renderPanel();
      }
      if (line.step) {
        state.progress?.step(line.step);
        state.step = line.step;
        if (line.step !== "Looking into it" && state.steps.at(-1) !== line.step) state.steps.push(line.step);
        renderPanel();
      }
      if (typeof line.text === "string") {
        stopProgress();
        streamText(line.text);
        state.speech?.add(line.text);
      }
      if (line.reset) {
        streamText(null);
        if (state.speech) state.speech = window.FelixVoice.begin();
      }
      if (line.ask) {
        stopProgress();
        add({ who: "felix", text: line.ask.title, allow: line.ask });
        renderPanel();
      }
      if (line.error) throw new Error(line.error);
      if (line.answer) answer = line.answer;
    });
    if (!answer) throw new Error("Felix didn't answer.");
    return answer;
  }

  /**
   * Runs one exchange with the server while showing Felix as busy, then shows the reply (or what went wrong).
   * When it's read aloud, Felix starts talking as the first checked sentence streams in, and reads the rest as
   * soon as the answer arrives, without waiting for the typing to finish.
   * @param {string} step What Felix shows it's doing at first.
   * @param {boolean} spoken Whether you said it rather than typed it.
   * @param {() => Promise<Message & { navigate?: string, settings?: Record<string, unknown>, music?: string }>} exchange
   * @returns {Promise<void>}
   */
  async function converse(step, spoken, exchange) {
    earsStop();
    window.FelixVoice?.stopSpeaking();
    state.speech = aloud(spoken) ? window.FelixVoice.begin() : null;
    startProgress(step);
    state.busy = true;
    state.steps = [];
    state.abort = null;
    state.startedAt = Date.now();
    state.liveBy = "";
    state.openSteps.delete("live");
    // The working line's timer counts up each second, without redrawing the chat.
    clearInterval(state.ticker);
    state.ticker = setInterval(() => {
      const time = (state.panel || state.bubbles)?.querySelector("[data-felix-time]");
      if (time) time.textContent = took(Date.now() - state.startedAt);
    }, 1000);
    paint();
    state.step = step;
    renderPanel();
    // The chat stays all ears while he works: what you say meanwhile is added to what he's doing.
    armEars();
    let reply;
    let read = null;
    try {
      const answer = await exchange();
      stopProgress();
      read = state.speech?.end(answer.text);
      await typeOut(answer.text);
      endTyping();
      reply = { who: "felix", id: answer.id, text: answer.text, chips: answer.chips, by: answer.by, confirm: answer.confirm, changes: answer.changes, shot: shotFor(answer.changes),
        tests: answer.tests, steps: state.steps, took: Date.now() - state.startedAt };
      if (answer.restarting) setTimeout(() => location.reload(), RELOAD_AFTER_MS);
      add(reply);
      await carryOut(answer);
    } catch (e) {
      stopProgress();
      endTyping();
      const stopped = Boolean(state.abort?.signal.aborted);
      const ms = Date.now() - state.startedAt;
      reply = stopped ? { who: "felix", text: STOPPED, steps: state.steps, took: ms } : { who: "felix", text: e.message, error: true, steps: state.steps, took: ms };
      read = stopped ? null : state.speech?.end(e.message);
      add(reply);
    }
    state.steps = [];
    state.abort = null;
    clearInterval(state.ticker);
    // An open working line stays open as the answer's own line.
    if (state.openSteps.delete("live")) state.openSteps.add(String(reply.key));
    state.messages = state.messages.map((m) => (m.allow ? { ...m, text: `${m.allow.title} Not allowed.`, allow: undefined } : m));
    state.busy = false;
    paint();
    renderPanel();
    if (chatStyle() === "hidden" && !state.panel && !read && reply?.text) flash(reply.text);
    const queued = state.next.shift();
    if (queued) return converse("", queued.spoken, () => fetchAnswer(queued.text));
    await listenAfter(read, reply, spoken);
    armEars();
  }

  /**
   * Starts the progress lines for an answer that's read aloud, when Settings have them on: after a moment with no
   * answer, Felix says what he's doing, then gives an update every few seconds.
   * @param {string} step What Felix is doing at first.
   */
  function startProgress(step) {
    stopProgress();
    const prefs = window.FelixShell?.cachedSettings() || {};
    const kit = state.progressKit;
    const speech = state.speech;
    if (!speech || !kit || prefs.felixProgress === false) return;
    state.progress = kit.createProgress({
      delayMs: Number(prefs.felixProgressDelay || 1.5) * 1000,
      everyMs: Number(prefs.felixProgressEvery ?? 0) * 1000,
      phrases: kit.phraseList(prefs.felixProgressPhrases),
      say: (line) => speech.say(line),
    });
    state.progress.step(step);
  }

  /**
   * Ends the progress lines: the answer is here, a card waits for you, or you stopped Felix.
   */
  function stopProgress() {
    state.progress?.stop();
    state.progress = null;
  }

  /**
   * Sends a message while Felix is working, without stopping him: his AI takes it in between steps and carries
   * on with it in mind. When nothing can take it yet (he's still checking his sources, say), it's asked next.
   * @param {string} text
   * @returns {Promise<void>}
   */
  async function steer(text, { spoken = false } = {}) {
    const mine = { who: /** @type {const} */ ("you"), text, note: "Adding to what Felix is doing" };
    add(mine);
    renderPanel();
    const taken = await window.FelixShell.request("/api/felix/steer", { text }).then((r) => r.ok === true, () => false);
    if (!taken && !state.busy) {
      delete mine.note;
      return converse("", spoken, () => fetchAnswer(text));
    }
    if (!taken) state.next.push({ text, spoken });
    mine.note = taken ? "Added to what Felix is doing" : "Felix will answer this next";
    renderPanel();
  }

  /**
   * Sends a question to Felix and shows the answer.
   * @param {string} text
   * @param {{ spoken?: boolean }} [options]
   * @returns {Promise<void>}
   */
  function ask(text, { spoken = false } = {}) {
    add({ who: "you", text });
    return converse("", spoken, () => fetchAnswer(text));
  }

  /**
   * Says yes or no to a merge or review Felix asked about.
   * @param {string} id
   * @param {boolean} yes
   * @param {{ spoken?: boolean }} [options]
   * @returns {Promise<void>}
   */
  function answerConfirm(id, yes, { spoken = false } = {}) {
    state.messages = state.messages.map((m) => (m.confirm?.id === id ? { ...m, confirm: undefined } : m));
    return converse(yes ? "On it" : "", spoken, () => window.FelixShell.request("/api/felix/confirm", { id, yes }));
  }

  /**
   * Allows (or not) a change Felix's AI wants to make, while it waits. The card then says what you chose.
   * @param {string} id
   * @param {boolean} yes
   * @param {{ spoken?: boolean }} [options] A spoken yes doesn't count for a change; Felix says so.
   * @returns {Promise<void>}
   */
  async function answerAllow(id, yes, { spoken = false } = {}) {
    try {
      const result = await window.FelixShell.request("/api/felix/allow", { id, yes, spoken });
      if (result.ok) {
        state.messages = state.messages.map((m) => (m.allow?.id === id ? { ...m, text: `${m.allow.title} ${result.text}`, allow: undefined } : m));
      } else {
        add({ who: "felix", text: result.text, error: !spoken });
      }
    } catch (e) {
      add({ who: "felix", text: e.message, error: true });
    }
    renderPanel();
  }

  /**
   * Applies the workbench's changes to Felix, or drops them. After applying, Felix restarts, so the page reloads
   * once it's back.
   * @param {"apply" | "discard"} what
   * @returns {Promise<void>}
   */
  function workbench(what) {
    state.messages = state.messages.map((m) => (m.changes ? { ...m, changes: undefined } : m));
    return converse(what === "apply" ? "Testing and applying" : "Discarding", false, async () => {
      const result = await window.FelixShell.request(`/api/felix/${what}`, {});
      if (!result.ok) throw new Error(result.text);
      if (what === "apply") setTimeout(() => location.reload(), RELOAD_AFTER_MS);
      return { text: result.text };
    });
  }

  /**
   * The change card still waiting for your answer, if there is one.
   * @returns {AllowCard | undefined}
   */
  const waitingCard = () => state.messages.findLast((m) => m.allow)?.allow;

  /**
   * Whether a reply is read aloud: always, never, or only when you talked to Felix, as Settings say.
   * @param {boolean} spoken
   * @returns {boolean}
   */
  function aloud(spoken) {
    const talk = window.FelixShell?.cachedSettings()?.felixTalk || "voice";
    // Muted or paused, nothing is read aloud; when you talked to him yourself, he answers aloud even in a meeting.
    return Boolean(window.FelixVoice) && !silenced() && (talk === "always" || (talk === "voice" && spoken));
  }

  /**
   * Waits for a reply to be read aloud, then, when you talked, listens for what you say next, so a conversation goes
   * on hands-free: a soft chime, then he listens, and a few quiet seconds end it. A yes-or-no question always waits
   * for your answer. It doesn't carry on when Settings turn it off, after "that's all" or "bye", after an error,
   * while muted, or with the window hidden.
   * @param {Promise<boolean> | null | undefined} read
   * @param {Message} reply
   * @param {boolean} spoken
   * @returns {Promise<void>}
   */
  async function listenAfter(read, reply, spoken) {
    const finished = read ? await read : false;
    const ending = state.ending;
    state.ending = false;
    if (ending && spoken) state.earsOff = true;
    if (!finished || !spoken || state.busy || state.voice) return;
    // With the chat all ears, its own listening picks up from here.
    if (earsWanted()) return;
    if (reply.confirm) return talk();
    const prefs = window.FelixShell?.cachedSettings() || {};
    if (prefs.felixKeepListening === false || ending || reply.error || document.hidden || silenced()) return;
    if (prefs.felixReplyChime !== false) await window.FelixVoice.chime?.().catch(() => {});
    if (state.busy || state.voice) return;
    return talk({ followUp: true, waitMs: Number(prefs.felixReplyWait || 7) * 1000 });
  }

  /** What you'd say to end a spoken conversation: Felix answers it, then stops listening. */
  const ENDING = /^(that'?s (all|it)|that is all|thanks?,? (that'?s|that is) (all|it)|no,? (that'?s|that is) (all|it)|(ok(ay)?,? )?(thanks|thank you)( so much)?|bye|goodbye|good ?night|see you|talk (to you )?later|never ?mind|stop listening|i'?m (done|good)|we'?re done)[.!]*$/i;

  /**
   * Shows what Felix is doing with your voice, keeping what's typed in the chat box.
   * @param {"" | "listening" | "hearing"} voice
   */
  function setVoice(voice) {
    state.voice = voice;
    for (const row of rows()) row.querySelectorAll(".mic").forEach((mic) => { mic.outerHTML = micHtml(); });
    wireMic();
    if (voice !== "listening") wave(0);
    paint();
    // Only a chat that's showing is redrawn: closing it stops the listening, and that mustn't open it again. Talking
    // from the bar with the chat closed (not all ears) still opens it.
    if (state.panel || state.convo) renderPanel();
    else if (voice && !state.ears && state.messages.length) renderPanel();
  }

  /**
   * Shows what you're saying so far, in your bubble or in the chat.
   */
  function showPartial() {
    if (state.panel) renderPanel();
    else if (state.bubbles) drawBubbles();
  }

  /**
   * Listens until you stop talking, and writes out what you said.
   * @param {{ followUp?: boolean, waitMs?: number, silenceMs?: number, maxMs?: number, keepSpeaking?: boolean }} [opts]
   * @returns {Promise<string | null>} Null when nothing was said or it was cancelled; "" when it couldn't be made out.
   */
  async function listenAndHear({ followUp = false, waitMs, silenceMs, maxMs, keepSpeaking } = {}) {
    state.followUp = followUp;
    setVoice("listening");
    try {
      const opts = Object.fromEntries(Object.entries({ waitMs, silenceMs, maxMs, keepSpeaking }).filter(([, v]) => v !== undefined));
      // Your words show as you say them, worked out on this Mac every second or so.
      opts.onPartial = (text) => {
        if (state.voice !== "listening" || !text.trim() || isNoise(text)) return;
        state.partial = [state.partialLead, text.trim()].filter(Boolean).join(" ");
        touchConvo();
        showPartial();
      };
      const { blob, heard } = await window.FelixVoice.listen(opts);
      if (!heard) return null;
      setVoice("hearing");
      return await window.FelixVoice.hear(blob);
    } finally {
      state.followUp = false;
      state.partial = state.partialLead;
      setVoice("");
    }
  }

  /**
   * Takes what you said: a yes or no when Felix just asked one, otherwise a question.
   * @param {string} text
   * @returns {Promise<void>}
   */
  function onHeard(text) {
    state.ending = ENDING.test(text.trim());
    const card = waitingCard();
    if (card && YES.test(text)) {
      add({ who: "you", text });
      return answerAllow(card.id, true, { spoken: true });
    }
    const asking = state.messages.at(-1)?.confirm;
    if (asking && YES.test(text)) {
      add({ who: "you", text });
      return answerConfirm(asking.id, true, { spoken: true });
    }
    if (asking && NO.test(text)) {
      add({ who: "you", text });
      return answerConfirm(asking.id, false, { spoken: true });
    }
    if (card && NO.test(text)) {
      add({ who: "you", text });
      return answerAllow(card.id, false, { spoken: true });
    }
    // While he works, anything else is added to what he's doing, never a second answer on top.
    if (state.busy) return steer(text, { spoken: true });
    return ask(text, { spoken: true });
  }

  /**
   * Whether the open chat should be listening: Settings have it on, you haven't turned it off for this chat, the
   * window is in front, and Felix isn't muted or paused.
   * @returns {boolean}
   */
  function earsWanted() {
    const prefs = window.FelixShell?.cachedSettings() || {};
    return Boolean(state.panel || state.convo) && !state.earsOff && isOn() && prefs.felixChatEars !== false && Boolean(window.FelixVoice?.supported())
      && !document.hidden && !silenced();
  }

  /**
   * Listens again in a moment, when the chat should be all ears.
   */
  function armEars() {
    clearTimeout(state.earsTimer);
    state.earsTimer = setTimeout(earsTurn, EARS_REST_MS);
  }

  /**
   * One listen while the chat is open: nothing said starts it again, what you say gets an answer, and then it
   * listens again. It waits while Felix works or talks, and while you're typing.
   * @returns {Promise<void>}
   */
  async function earsTurn() {
    const typing = (state.panel?.querySelector(".fp-reply input") || state.el?.querySelector("input[name='q']"))?.value;
    // While he talks, his cut-in listening hears you instead; this picks up again when he's done.
    if (!earsWanted() || state.voice || typing || window.FelixVoice.speaking?.()) return;
    if (!state.voiceChecked) {
      const ready = await window.FelixVoice.status().catch(() => ({ hear: false }));
      if (!ready.hear) {
        state.earsOff = true;
        return;
      }
      state.voiceChecked = true;
      if (!earsWanted() || state.voice) return;
    }
    let text = null;
    const lead = state.bargeLead;
    state.bargeLead = "";
    state.ears = true;
    try {
      if (lead) {
        // You cut in: what you said shows at once, and a moment more catches the rest of your sentence.
        state.partialLead = lead;
        state.partial = lead;
        showPartial();
        const more = await listenAndHear({ waitMs: BARGE_MORE_MS, silenceMs: EARS_SILENCE_MS, maxMs: EARS_MAX_MS, keepSpeaking: true });
        text = more ? `${lead} ${more.trim()}` : lead;
      } else text = await listenAndHear({ waitMs: EARS_WAIT_MS, silenceMs: EARS_SILENCE_MS, maxMs: EARS_MAX_MS, keepSpeaking: true });
      // Trailing off ("…and", "so um") isn't the end: listen a little more and put the two together, keeping the
      // first half on screen meanwhile.
      while (text && !isNoise(text) && TRAILING.test(text.trim()) && earsWanted()) {
        state.ears = true;
        state.partialLead = text.trim();
        const more = await listenAndHear({ waitMs: EARS_MORE_MS, silenceMs: EARS_SILENCE_MS, maxMs: EARS_MAX_MS, keepSpeaking: true });
        if (!more) break;
        text = `${text.trim()} ${more.trim()}`;
      }
    } catch (e) {
      // No microphone (or no permission): stop listening for this chat, and say why once, not every time it opens.
      state.earsOff = true;
      if (state.earsProblem === e.message) return;
      state.earsProblem = e.message;
      add({ who: "felix", text: e.message, error: true });
      return renderPanel();
    } finally {
      state.ears = false;
      state.partialLead = "";
      state.partial = "";
    }
    // Closed while he was working out what you said: it's dropped, and the mic stays off.
    if (!earsWanted()) return;
    if (text && !isNoise(text) && !echoOf(text)) {
      // "That's all" or "bye" gets its answer, then the chat stops listening until you open it again.
      const ending = ENDING.test(text.trim()) && !BARE_THANKS.test(text.trim());
      await onHeard(text);
      if (ending) state.earsOff = true;
    }
    armEars();
  }

  /**
   * Whether what was heard is Felix's own voice coming back through the mic: most of its words are in something he
   * said aloud just now.
   * @param {string} text
   * @returns {boolean}
   */
  function echoOf(text) {
    const words = text.toLowerCase().match(/[a-z0-9']+/g) || [];
    if (!words.length) return false;
    return state.recentSaid.some((line) => {
      const said = new Set(line.toLowerCase().match(/[a-z0-9']+/g) || []);
      return words.filter((w) => said.has(w)).length / words.length >= ECHO_SHARE;
    });
  }

  /**
   * Stops the chat's listening, dropping anything half said.
   */
  function earsStop() {
    clearTimeout(state.earsTimer);
    if (state.ears && state.voice === "listening") window.FelixVoice.stopListening(false);
  }

  /**
   * One spoken turn: listen, write it out, then answer it. A follow-up turn (after he answered you) ends quietly when
   * you say nothing.
   * @param {{ followUp?: boolean, waitMs?: number, silenceMs?: number, maxMs?: number }} [opts]
   * @returns {Promise<void>}
   */
  async function talk(opts = {}) {
    try {
      const text = await listenAndHear(opts);
      if (text === null) return;
      if (!text) {
        add({ who: "felix", text: "Sorry, I didn't catch that. Try again?", error: true });
        return renderPanel();
      }
      await onHeard(text);
    } catch (e) {
      add({ who: "felix", text: e.message, error: true });
      renderPanel();
    }
  }

  /**
   * The mic button: starts listening, stops early when clicked again, and cuts Felix off mid-sentence.
   * @returns {Promise<void>}
   */
  async function onMic() {
    if (state.voice === "listening" && state.ears) {
      state.earsOff = true;
      return window.FelixVoice.stopListening();
    }
    if (state.voice === "listening") return window.FelixVoice.stopListening();
    if (state.voice || state.busy) return;
    state.earsOff = false;
    touchConvo();
    window.FelixVoice.stopSpeaking();
    warm();
    if (!state.voiceChecked) {
      const ready = await window.FelixVoice.status().catch(() => ({ hear: false }));
      if (!ready.hear) {
        add({ who: "felix", text: "Talking isn't set up on this Mac yet. Run ./prs voice once, then try again.", error: true });
        return renderPanel();
      }
      state.voiceChecked = true;
    }
    await talk();
  }

  /**
   * Starts Felix's AI ahead of a question, at most every few minutes.
   */
  function warm() {
    if (Date.now() - state.warmedAt < WARM_EVERY_MS) return;
    state.warmedAt = Date.now();
    window.FelixShell.request("/api/felix/warm", {}).catch(() => {});
  }

  /**
   * Keeps Felix's AI sessions open while the app is open and in view, so a question never waits for one to
   * start; once the app is closed, they close on their own when idle.
   */
  function keepWarm() {
    if (isOn() && document.visibilityState === "visible") warm();
  }

  /**
   * Handles a click in the conversation panel: close, or answer a confirm.
   * @param {MouseEvent} e
   */
  function onPanelClick(e) {
    const b = e.target.closest("[data-felix]");
    if (b?.dataset.felix === "close") return close();
    if (b?.dataset.felix === "open") {
      state.wantPanel = true;
      return renderPanel();
    }
    if (b?.dataset.felix === "steps") {
      const key = b.dataset.key;
      if (!state.openSteps.delete(key)) state.openSteps.add(key);
      return renderPanel({ keepScroll: true });
    }
    if (b?.dataset.felix === "wrong") return markWrong(b.dataset.id);
    if (b?.dataset.felix === "stop") return stop();
    if (b?.dataset.felix === "yes" || b?.dataset.felix === "no") return answerConfirm(b.dataset.id, b.dataset.felix === "yes");
    if (b?.dataset.felix === "allow" || b?.dataset.felix === "deny") return answerAllow(b.dataset.id, b.dataset.felix === "allow");
    if (b?.dataset.felix === "apply" || b?.dataset.felix === "discard") return state.busy ? undefined : workbench(b.dataset.felix);
    const chip = e.target.closest("a.chip[href^='/']");
    if (chip) {
      e.preventDefault();
      open(chip.getAttribute("href"));
    }
  }

  /**
   * Sends what's typed in the chat box.
   * @param {SubmitEvent} e
   */
  function onSubmit(e) {
    e.preventDefault();
    const input = e.target.elements.q;
    const text = input.value.trim();
    const card = waitingCard();
    if (text && card && (YES.test(text) || NO.test(text))) {
      input.value = "";
      add({ who: "you", text });
      return answerAllow(card.id, YES.test(text));
    }
    if (!text) return;
    input.value = "";
    state.asked = [text, ...state.asked.filter((t) => t !== text)].slice(0, KEEP);
    state.recall = -1;
    if (state.busy) return void steer(text);
    ask(text);
  }

  /**
   * Enter sends; arrow up and down in the chat box bring back earlier questions; Escape hushes Felix and closes
   * the panel.
   * @param {KeyboardEvent} e
   */
  function onKey(e) {
    if (e.key === "Escape") {
      hush();
      return close();
    }
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      return e.target.form.requestSubmit();
    }
    if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
    const next = Math.max(-1, Math.min(state.asked.length - 1, state.recall + (e.key === "ArrowUp" ? 1 : -1)));
    if (next === state.recall) return;
    e.preventDefault();
    state.recall = next;
    e.target.value = next < 0 ? "" : state.asked[next];
  }

  /**
   * Wires the mic button, when it's one that works.
   */
  function wireMic() {
    for (const row of rows()) {
      for (const mic of row.querySelectorAll("[data-felix='mic']")) {
        if (mic.dataset.wired) continue;
        mic.dataset.wired = "1";
        mic.addEventListener("click", onMic);
      }
    }
  }

  /**
   * Stops Felix talking, ends his progress lines, and drops anything it's still listening to.
   */
  function hush() {
    stopProgress();
    window.FelixVoice?.stopSpeaking();
    window.FelixVoice?.stopListening(false);
  }

  /**
   * Listens for the wake phrase when Settings say so, or stops. Felix doesn't listen for it while he's busy or
   * already listening to you; felix-voice.js also pauses it while he talks and while the window is hidden.
   */
  function syncWake() {
    const prefs = window.FelixShell?.cachedSettings() || {};
    const voice = window.FelixVoice;
    if (!voice?.wakeStart) return;
    // Muted, paused, or a quiet time (screen locked, away, a meeting): he doesn't listen for his name.
    if (!isOn() || prefs.felixWakeOn !== true || silenced() || state.quiet) return voice.wakeStop();
    voice.wakeStart({ sensitivity: String(prefs.felixWakeLevel || "normal"), paused: () => state.busy || Boolean(state.voice), onWake });
  }

  /**
   * Felix heard his phrase. What you said after it in the same breath is your question (or your yes to what he
   * asked); the phrase alone gets a soft chime, and he listens the way the mic button does.
   * @param {string} rest
   * @returns {Promise<void>}
   */
  async function onWake(rest) {
    if (state.busy || state.voice) return;
    if (rest) return onHeard(rest);
    await window.FelixVoice.chime().catch(() => {});
    if (!state.busy && !state.voice) await talk();
  }

  /**
   * Draws the Felix strip and wires its chat box.
   */
  function render() {
    if (!state.el) return;
    syncWake();
    state.el.innerHTML = stripHtml();
    const form = state.el.querySelector("[data-felix='form']");
    if (!form) {
      hush();
      return close();
    }
    wireMic();
    wireRow(state.el);
    form.q.addEventListener("focus", () => {
      warm();
      if (state.messages.length || chatStyle() !== "panel") renderPanel();
    });
    // Without the full chat, typing in the bar pauses the listening, and an emptied box picks it up again.
    form.q.addEventListener("input", () => {
      if (!state.convo || state.panel) return;
      if (form.q.value) earsStop();
      else armEars();
    });
    paint();
  }

  /**
   * Wires one of Felix's rows (the pill, or the chat's reply row): sending, the keys, and Stop talking.
   * @param {HTMLElement | null} row
   */
  function wireRow(row) {
    const form = row?.querySelector("[data-felix='form']");
    if (!form) return;
    form.addEventListener("submit", onSubmit);
    form.q.addEventListener("keydown", onKey);
    row.querySelector("[data-felix='hush']")?.addEventListener("click", hush);
    wireMic();
  }

  /**
   * Stops the answer in progress: Felix stops talking, and the answer is dropped when it arrives.
   */
  function stop() {
    hush();
    state.abort?.abort();
  }

  /**
   * Tells you how Felix's last change to himself went, once, after the page reloads: he came back healthy, or he
   * didn't and the change was put back. While the restart guard is still checking, it asks again for a while.
   * @param {number} [tries]
   * @returns {Promise<void>}
   */
  async function tellApply(tries = 20) {
    const last = (await fetch("/api/felix/apply-status").then((r) => r.json(), () => ({}))).last;
    if (!last) return;
    if (["restarting", "undoing"].includes(last.state)) {
      if (tries > 0) setTimeout(() => tellApply(tries - 1), 3000);
      return;
    }
    const key = `${last.state}|${last.checkedAt || last.at}`;
    let told = "";
    try { told = localStorage.getItem(APPLY_TOLD) || ""; } catch {}
    if (told === key || !last.checkedAt || Date.now() - Date.parse(last.checkedAt) > APPLY_TELL_MS) return;
    try { localStorage.setItem(APPLY_TOLD, key); } catch {}
    const files = last.files?.length === 1 ? "1 file" : `${last.files?.length || 0} files`;
    const said = {
      ok: `I'm back, with my change applied (${files}). Everything answered fine after the restart. Say "undo the last apply" to put it back.`,
      undone: "I'm back, with my last change put back.",
      "rolled-back": `${last.why || "I didn't come back healthy after the change"} Nothing of it is left in your Felix; it's still in my workbench if you want me to fix it.`,
      broken: `Something's wrong: ${last.why || "Felix didn't come back healthy."} Check ./prs logs.`,
    }[last.state];
    if (!said) return;
    add({ who: "felix", text: said, error: last.state === "broken" || last.state === "rolled-back" });
    renderPanel();
  }

  /**
   * Draws Felix in the bar's Felix slot and keeps it in step with Settings.
   * @param {HTMLElement | null} el
   */
  function mount(el) {
    if (!el) return;
    state.el = el;
    el.classList.add("felixrow");
    import("/felix-progress.mjs").then((kit) => { state.progressKit = kit; }, () => {});
    el.addEventListener("focusin", lit);
    el.addEventListener("focusout", () => setTimeout(lit));
    render();
    tellApply();
    // Felix's face and the pill follow his voice: the bars move with yours, and his mouth with his.
    window.FelixVoice?.watch?.((e) => {
      if (e.level !== undefined && state.voice === "listening") wave(e.level);
      if (e.saying !== undefined) {
        state.saying = e.saying;
        // When he starts talking, the chat's own listen hands over to his cut-in listening (keeping anything you'd
        // already said), and it picks up again the moment he stops.
        if (e.saying) state.recentSaid = [...state.recentSaid, e.saying].slice(-6);
        // A progress line ("one moment, checking GitHub") doesn't interrupt your listening; a reply does.
        if (e.saying && !e.aside && state.ears && state.voice === "listening") window.FelixVoice.stopListening(true);
        if (!e.saying) armEars();
        paint();
      }
    });
    keepWarm();
    setInterval(keepWarm, WARM_EVERY_MS);
    setInterval(checkNews, WATCH_EVERY_MS);
    // Saying something while he talks: "stop" just stops him; more than that is your next question.
    // In a conversation, what you said cutting in carries on into the listening: say the rest and it's one question.
    window.FelixVoice?.onBarge?.((rest) => {
      if (earsWanted()) {
        state.bargeLead = rest;
        return armEars();
      }
      if (state.busy) steer(rest, { spoken: true });
      else ask(rest, { spoken: true });
    });
    document.addEventListener("visibilitychange", keepWarm);
    // The chat stops listening while the window is hidden, and picks up again when you're back.
    document.addEventListener("visibilitychange", () => (document.hidden ? earsStop() : armEars()));
    // A click outside the chat closes it. "Outside" is judged where the press began: opening the chat from the bar
    // puts the chat under the pointer before the button comes up, and that click must not close it again. The click
    // that opened it never closes it either, however the browser reports where it landed.
    let pressedInside = false;
    document.addEventListener("pointerdown", (e) => {
      const path = e.composedPath();
      pressedInside = Boolean((state.panel && path.includes(state.panel)) || path.includes(el));
    }, true);
    document.addEventListener("click", (e) => {
      const path = e.composedPath();
      const justOpened = performance.now() - (state.openedAt || 0) < OPEN_GRACE_MS;
      if (state.panel && !pressedInside && !justOpened && !path.includes(state.panel) && !path.includes(el)) close();
    });
    // Anywhere on the bar that isn't a button, Felix's face included, puts you in the box, which opens the chat. A
    // box that already has the cursor gets no new focus event, so the chat opens from here then.
    el.addEventListener("click", (e) => {
      if (e.target.closest("button, a")) return;
      const q = el.querySelector("input[name='q']");
      if (!q) return;
      if (document.activeElement !== q) return q.focus();
      if (!state.panel && !state.convo && (state.messages.length || chatStyle() !== "panel")) renderPanel();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      hush();
      close();
    });
    addEventListener("resize", () => {
      place();
      if (state.bubbles) drawBubbles();
    });
    // Settings changed: in another window (storage), or in this one, like "mute yourself" said to Felix
    // (felix:settings). Only a real change redraws the bar, so what you're typing isn't lost.
    let seen = JSON.stringify(window.FelixShell.cachedSettings() || {});
    const onSettings = () => {
      const now = JSON.stringify(window.FelixShell.cachedSettings() || {});
      if (now === seen) return;
      seen = now;
      render();
    };
    addEventListener("storage", (e) => { if (e.key === window.FelixShell.SETTINGS_CACHE) onSettings(); });
    addEventListener("felix:settings", onSettings);
    // Chrome and the Safari app keep their own copies: coming back into view, and every half minute, the server's
    // settings are read again, so a mute or pause made in one reaches the other.
    const refetch = () => { if (!document.hidden) window.FelixShell.loadSettings?.().catch(() => {}); };
    document.addEventListener("visibilitychange", refetch);
    setInterval(refetch, WATCH_EVERY_MS);
  }

  /**
   * Saves an answer to Felix's test set after a thumbs-down, and says so under it.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function markWrong(id) {
    const ok = await window.FelixShell.request("/api/felix/wrong", { id }).then((r) => r.ok === true, () => false);
    state.messages = state.messages.map((m) => (m.id === id ? { ...m, marked: true, note: ok ? "Saved to Felix's test set" : "Couldn't save that one" } : m));
    renderPanel();
  }

  /**
   * Tells you what Felix has on his own: a watcher that came true, a review or fix that's ready, a break nudge. It
   * shows in the chat (and as a toast when the chat is closed), and he says it aloud unless replies are never read
   * aloud, he's muted or paused, or he should stay quiet (screen locked, you're away, a meeting). Only while the
   * window is in view, so nothing is missed.
   * @returns {Promise<void>}
   */
  async function checkNews() {
    if (!isOn() || document.visibilityState !== "visible" || state.busy) return;
    const res = await fetch("/api/felix/news").then((r) => r.json(), () => null);
    state.quiet = res?.quiet || null;
    syncWake();
    if (!res?.items?.length) return;
    const notes = { watch: "From a watcher", review: "Speaking up on my own", fix: "Speaking up on my own", care: "A gentle nudge", job: "Getting back to you" };
    for (const n of res.items) add({ who: "felix", text: n.text, note: notes[n.kind] || "" });
    if (state.panel) renderPanel();
    else window.FelixShell?.toast?.(res.items[0].text, { detail: res.items.length > 1 ? `And ${res.items.length - 1} more in the chat` : "", tone: "ok" });
    const talk = window.FelixShell?.cachedSettings()?.felixTalk || "voice";
    if (talk !== "never" && !silenced() && !state.quiet) window.FelixVoice?.speak(res.items.map((n) => n.text).join(" "));
  }

  /**
   * Whether Felix is muted, or paused for a while, as set from the top bar or Settings.
   * @returns {boolean}
   */
  function silenced() {
    const prefs = window.FelixShell?.cachedSettings() || {};
    return prefs.felixMuted === true || Date.parse(String(prefs.felixPausedUntil || "")) > Date.now();
  }

  /**
   * Mutes or unmutes Felix: muted, he doesn't speak or listen for his name.
   * @returns {Promise<void>}
   */
  async function toggleMute() {
    const muted = !(window.FelixShell?.cachedSettings()?.felixMuted === true);
    if (muted) hush();
    await window.FelixShell.saveSettings({ felixMuted: muted, felixPausedUntil: "" }).catch(() => {});
    window.FelixShell?.toast?.(muted ? `${who()} is muted` : `${who()} is back`, { detail: muted ? "He won't speak or listen for his name. Typing still works." : "" });
    syncWake();
    tellMood();
  }

  /**
   * Pauses Felix for a while (no speaking, no listening for his name), or ends a pause with 0.
   * @param {number} minutes
   * @returns {Promise<void>}
   */
  async function pauseFor(minutes) {
    const until = minutes ? new Date(Date.now() + minutes * 60_000).toISOString() : "";
    if (minutes) hush();
    await window.FelixShell.saveSettings({ felixPausedUntil: until, felixMuted: false }).catch(() => {});
    syncWake();
    tellMood();
  }

  /**
   * Hold-to-talk: the key going down starts listening, and letting go sends what you said.
   * @param {boolean} down
   */
  function pushToTalk(down) {
    if (!isOn() || !window.FelixVoice?.supported()) return;
    if (down && !state.voice && !state.busy) {
      window.FelixVoice.stopSpeaking();
      // Held, it listens through pauses: only letting go of the key (or a minute) ends it.
      talk({ waitMs: Infinity, silenceMs: Infinity, maxMs: PTT_MAX_MS });
    } else if (!down && state.voice === "listening") window.FelixVoice.stopListening(true);
  }

  /** @type {Set<(mood: { now: string, muted: boolean, pausedUntil: string, quiet: string | null }) => void>} */
  const moodWatchers = new Set();

  /**
   * Tells the top bar's pill what Felix is doing: listening, working out what you said, thinking, talking or idle,
   * and whether he's muted, paused or keeping quiet.
   */
  function tellMood() {
    const prefs = window.FelixShell?.cachedSettings() || {};
    const paused = Date.parse(String(prefs.felixPausedUntil || "")) > Date.now() ? String(prefs.felixPausedUntil) : "";
    const m = { now: mood(), muted: prefs.felixMuted === true, pausedUntil: paused, quiet: state.quiet || null };
    moodWatchers.forEach((fn) => { try { fn(m); } catch {} });
    // When a pause runs out, the pill says so and listening for his name comes back, right on time.
    clearTimeout(state.pauseTimer);
    if (paused) state.pauseTimer = setTimeout(() => { tellMood(); syncWake(); }, Date.parse(paused) - Date.now() + 500);
  }

  /**
   * Starts watching Felix's state; returns how to stop.
   * @param {(mood: { now: string, muted: boolean, pausedUntil: string, quiet: string | null }) => void} fn
   * @returns {() => void}
   */
  function watchMood(fn) {
    moodWatchers.add(fn);
    tellMood();
    return () => moodWatchers.delete(fn);
  }

  /**
   * Starts a check-in from the Felix card: Felix asks his question in the chat, and the reply box waits for your
   * answer. The check-in is marked done, so it isn't asked again.
   * @param {{ id: string, text: string }} checkin
   * @returns {Promise<void>}
   */
  async function checkIn({ id, text }) {
    add({ who: "felix", text });
    renderPanel();
    state.panel?.querySelector(".fp-reply input")?.focus();
    await window.FelixShell.request("/api/felix/checkins/done", { id }).catch(() => {});
  }

  return { mount, close, ask, syncWake, checkIn, toggleMute, pauseFor, pushToTalk, watchMood };
})();
