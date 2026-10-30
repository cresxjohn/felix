// The work day in Felix's top bar: Start my day, then a clock with Take a break and End my day, and I'm back on a
// break. The buttons show on Home only; the clock shows on every page while the day runs, and on a break it turns
// into a resting "On a break" pill (the page itself never changes colour). The day itself lives on the server
// (/api/shift, data/shift.json), so a reload or restart keeps it; every window asks for it every few seconds and
// hears about a click in another window at once. Cards under the top bar ask before a message goes to Slack, offer
// it to copy while Slack isn't connected, and suggest ending the day when its hours are up.
// shell.js loads this on every page, after it draws the top bar with an empty <span id="shift">.
import { ATTENDANCE, clockText, hoursText, messageFor } from "/shift-clock.mjs";

const POLL_MS = 5000;
const HIDDEN_POLL_MS = 30000;
const POSTED_SHOW_MS = 8000;
const NOTE_SHOW_MS = 10 * 60e3;
const ERROR_SHOW_MS = 6000;
const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel("felix-shift") : null;
/** @type {import("../shift.mjs").View | null} */
let view = null;
let skew = 0;
let busy = false;
let pollTimer = 0;
let posted = { id: "", until: 0 };
let problem = { text: "", until: 0 };
const dismissed = new Set();
let menuOpen = false; // the clock's menu on Home: Take a break and End my day

/**
 * Escapes text for HTML.
 * @param {unknown} s
 * @returns {string}
 */
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * The time now on the server's clock, so every window counts the same minutes.
 * @returns {number}
 */
const now = () => Date.now() + skew;

/**
 * A time of day: "9:02 AM".
 * @param {number | string} at
 * @returns {string}
 */
const timeOfDay = (at) => new Date(typeof at === "string" ? Date.parse(at) : at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

/**
 * The day's times right now, worked out here between the server's answers so the clock ticks every second.
 * @returns {{ elapsedMs: number, leftMs: number, onBreakMs: number, dueAt: number } | null}
 */
function times() {
  const t = view?.times;
  if (!t) return null;
  const since = now() - Date.parse(view.now);
  const running = view.shift.status === "working" || view.shift.status === "break";
  if (!running) return t;
  const onBreak = view.shift.status === "break";
  // On a break that pauses the countdown, the end moves later as the break goes on, so the time left holds.
  const paused = onBreak && view.prefs.breakPauses;
  return { elapsedMs: t.elapsedMs + since, leftMs: paused ? t.leftMs : t.leftMs - since, onBreakMs: onBreak ? t.onBreakMs + since : 0, dueAt: paused ? t.dueAt + since : t.dueAt };
}

/**
 * Whether Felix should be suggesting you end the day.
 * @returns {boolean}
 */
const reminderDue = () => Boolean(view?.reminder && now() >= Date.parse(view.reminder.at));

/**
 * The words that say where a step's message goes, for a button's tooltip.
 * @param {string} message
 * @param {string} [also] What else it does in Slack.
 * @returns {string}
 */
function postsText(message, also = "") {
  if (!view.prefs.slack) return `Slack posting is off in Settings, so nothing is posted.`;
  const where = `Posts "${message}" to ${ATTENDANCE.name} as you${also}`;
  return view.slack.connected ? `${where}, after you say yes.` : `${where}, once Slack is connected. Until then Felix offers the message to copy.`;
}

/**
 * Each button's label and tooltip, in your own wording from Settings.
 * @returns {Record<string, { label: string, title: string }>}
 */
function buttons() {
  const p = view.prefs;
  const day = hoursText(p.dayHours);
  const counts = p.breakPauses ? "The countdown waits until you're back." : `The countdown keeps running; breaks count toward your ${day}.`;
  return {
    start: { label: "Start my day", title: `${postsText(messageFor("start", p, new Date(now()).getHours()), " and sets you active in Slack")} Starts a ${p.dayHours}-hour countdown.` },
    break: { label: "Take a break", title: `${postsText(p.messages.break)} ${counts}` },
    back: { label: "I'm back", title: `${postsText(p.messages.back)} Ends your break.` },
    end: { label: "End my day", title: `${postsText(p.messages.bye, " and sets you away in Slack")} Stops the countdown.` },
  };
}

/**
 * A button that takes a step of the day.
 * @param {string} action
 * @param {string} [kind] "primary" or "rest" for the main step.
 * @returns {string}
 */
function stepButton(action, kind = "") {
  const b = buttons()[action];
  return `<button class="shift-btn${kind ? ` ${kind}` : ""}" type="button" data-act="${action}" title="${esc(b.title)}">${esc(b.label)}</button>`;
}

/**
 * The clock's tooltip: when the day started and when its hours are up.
 * @returns {string}
 */
function clockTitle() {
  const t = times();
  const started = `Started at ${timeOfDay(view.shift.startedAt)}.`;
  const rule = view.prefs.breakPauses ? "breaks pause the countdown" : "breaks count toward them";
  return `${started} Your ${hoursText(view.prefs.dayHours)} are up at ${timeOfDay(t.dueAt)}; ${rule}.`;
}

/**
 * The clock in the top bar while the day runs: time since you started and the countdown, or how long you've been
 * on a break. Off Home it links there; on Home, while you work, it opens a small menu with Take a break and End my
 * day, so the top bar keeps one pill instead of three controls.
 * @param {boolean} home
 * @returns {string}
 */
function clockHtml(home) {
  const resting = view.shift.status === "break";
  const menu = home && !resting;
  const tag = menu ? "button" : home ? "span" : "a";
  const attrs = menu ? ` type="button" data-menu aria-haspopup="menu" aria-expanded="${menuOpen}"` : home ? ` role="timer"` : ` href="/"`;
  const chevron = menu ? `<svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 9l6 6 6-6"/></svg>` : "";
  return `<${tag} class="shift-clock${resting ? " resting" : ""}"${attrs} title="${esc(clockTitle())}">`
    + `<span class="dot" aria-hidden="true"></span><span data-t="main"></span><span class="left" data-t="left"></span>${chevron}</${tag}>`;
}

/**
 * The clock's menu: Take a break and End my day, each with what it does.
 * @returns {string}
 */
function menuHtml() {
  const b = buttons();
  const item = (action, sub) => `<button class="shift-item" type="button" role="menuitem" data-act="${action}" title="${esc(b[action].title)}">${esc(b[action].label)}<span>${esc(sub)}</span></button>`;
  const counts = view.prefs.breakPauses ? "Pauses the countdown" : "The countdown keeps going";
  return `<div class="shift-menu" role="menu">${item("break", counts)}${item("end", "Stops the countdown")}</div>`;
}

/**
 * The top bar's part: what shows depends on the day, the page, and whether the feature is on.
 * @param {boolean} home
 * @returns {string}
 */
function slotHtml(home) {
  if (!view?.prefs.on) return "";
  const { status, endedAt } = view.shift;
  if (status === "working") return home ? `<span class="shift-wrap">${clockHtml(home)}${menuOpen ? menuHtml() : ""}</span>` : clockHtml(home);
  if (status === "break") return clockHtml(home) + (home ? stepButton("back", "rest") : "");
  if (!home) return "";
  const off = status === "ended" ? `Off work since ${timeOfDay(endedAt)}` : "Off work";
  return `<span class="work-only">${stepButton("start", "primary")}</span>`
    + `<span class="shift-clock off personal-only" title="${status === "ended" ? "Your work day has ended." : "Your work day hasn't started."}">${esc(off)}</span>`;
}

/**
 * Updates the clock's numbers in place, so a hovered button or its tooltip doesn't redraw every second.
 * @param {HTMLElement} slot
 */
function tickClock(slot) {
  const main = slot.querySelector('[data-t="main"]');
  const left = slot.querySelector('[data-t="left"]');
  const t = times();
  if (!main || !t) return;
  if (view.shift.status === "break") {
    main.textContent = "On a break";
    left.textContent = `· ${clockText(t.onBreakMs)}`;
    left.classList.remove("over");
    return;
  }
  main.textContent = clockText(t.elapsedMs);
  left.textContent = t.leftMs > 0 ? `· ${clockText(t.leftMs)} left` : `· ${clockText(-t.leftMs)} over`;
  left.classList.toggle("over", t.leftMs <= 0);
}

/**
 * The quoted message in a card, with what it is.
 * @param {string} text
 * @returns {string}
 */
const quote = (text) => `<blockquote class="shift-quote">${esc(text)}</blockquote>`;

/**
 * The card after a step about its Slack message: asking before it posts, or offering it to copy.
 * @returns {string}
 */
function noteHtml() {
  const note = view?.shift.note;
  if (!note || dismissed.has(note.id)) return "";
  const copy = `<button class="shift-btn" type="button" data-copy>Copy message</button>`;
  const close = `<button class="shift-btn quiet" type="button" data-dismiss="${esc(note.id)}">Dismiss</button>`;
  const recent = now() - Date.parse(note.at) < NOTE_SHOW_MS;
  const also = note.presence === "auto" ? " and sets you active in Slack" : note.presence === "away" ? " and sets you away in Slack" : "";
  if (note.slack === "pending") {
    return `<section class="shift-card" aria-label="Post to Slack?"><h3>Post to Slack?</h3>${quote(note.text)}`
      + `<p>Posts to ${esc(ATTENDANCE.name)} as you${also}.</p>`
      + `<div class="acts"><button class="shift-btn primary" type="button" data-post="yes">Post</button><button class="shift-btn" type="button" data-post="no">Don't post</button></div></section>`;
  }
  if (note.slack === "posted" && posted.id === note.id && now() < posted.until) {
    return `<section class="shift-card done" aria-label="Posted"><h3>Posted to ${esc(ATTENDANCE.name)}</h3>${quote(note.text)}<div class="acts">${close}</div></section>`;
  }
  if (!recent) return "";
  const heads = {
    off: ["Slack posting is off until Slack is connected", "Nothing was posted. Copy the message to post it yourself."],
    failed: ["Couldn't post to Slack", `${note.error || "Slack didn't take it."} Copy the message to post it yourself.`],
    expired: ["Not posted", "It waited over 15 minutes for a yes, so Felix dropped it. Copy it to post it yourself."],
  }[note.slack];
  if (!heads) return "";
  return `<section class="shift-card" aria-label="${esc(heads[0])}"><h3>${esc(heads[0])}</h3>${quote(note.text)}<p>${esc(heads[1])}</p>`
    + `<div class="acts">${copy}${close}</div></section>`;
}

/**
 * The gentle nudge when the day's hours are up, with End my day and "not yet".
 * @returns {string}
 */
function dueHtml() {
  if (!reminderDue()) return "";
  const hours = hoursText(view.prefs.dayHours);
  const snooze = view.prefs.snooze;
  const later = snooze >= 60 ? `${snooze / 60} hour${snooze === 60 ? "" : "s"}` : `${snooze} minutes`;
  return `<section class="shift-card due" aria-label="Your ${esc(hours)} are up"><h3>Your ${esc(hours)} are up</h3>`
    + `<p>You started at ${esc(timeOfDay(view.shift.startedAt))}. Nice work today. Time to call it a day?</p>`
    + `<div class="acts">${stepButton("end", "primary")}<button class="shift-btn" type="button" data-snooze>Not yet, remind me in ${esc(later)}</button></div></section>`;
}

/**
 * A short-lived card for a step that didn't work.
 * @returns {string}
 */
const problemHtml = () => (problem.text && now() < problem.until
  ? `<section class="shift-card" role="alert"><h3>That didn't work</h3><p>${esc(problem.text)}</p></section>` : "");

/**
 * The floating cards under the top bar, made once and kept placed below it.
 * @returns {HTMLElement}
 */
function popEl() {
  let pop = document.getElementById("shift-pop");
  if (!pop) {
    pop = Object.assign(document.createElement("div"), { id: "shift-pop", className: "shift-pop" });
    pop.setAttribute("aria-live", "polite");
    document.body.append(pop);
  }
  const bar = document.getElementById("topbar")?.getBoundingClientRect();
  pop.style.top = `${Math.max(8, (bar?.bottom ?? 60) + 8)}px`;
  return pop;
}

/**
 * Draws what changed: the top bar's part and the cards, each only when its content changes, and the clock's
 * numbers every time.
 */
function draw() {
  const slot = document.getElementById("shift");
  if (slot) {
    const html = slotHtml(slot.dataset.home === "1");
    if (slot.dataset.html !== html) {
      slot.innerHTML = html;
      slot.dataset.html = html;
    }
    tickClock(slot);
  }
  const cards = dueHtml() + noteHtml() + problemHtml();
  const pop = popEl();
  if (pop.dataset.html !== cards) {
    pop.innerHTML = cards;
    pop.dataset.html = cards;
  }
  pop.hidden = !cards;
  document.querySelectorAll("#shift button, #shift-pop button").forEach((b) => { b.disabled = busy; });
}

/**
 * Takes the server's answer as the day, and draws it.
 * @param {import("../shift.mjs").View} next
 */
function take(next) {
  view = next;
  skew = Date.parse(next.now) - Date.now();
  draw();
}

/**
 * Asks the server for the day, then asks again in a few seconds (less often while the window is hidden).
 * @returns {Promise<void>}
 */
async function load() {
  clearTimeout(pollTimer);
  try {
    take(await window.FelixShell.request("/api/shift"));
  } catch {
    // Keep showing the last state; the next poll tries again.
  }
  pollTimer = setTimeout(load, document.hidden ? HIDDEN_POLL_MS : POLL_MS);
}

/**
 * Sends a change to the server, draws the answer, and tells the other windows.
 * @param {object} body
 * @returns {Promise<void>}
 */
async function send(body) {
  if (busy) return;
  busy = true;
  draw();
  try {
    take(await window.FelixShell.request("/api/shift", body));
    if (body.action === "post" && view.shift.note?.slack === "posted") posted = { id: view.shift.note.id, until: now() + POSTED_SHOW_MS };
    channel?.postMessage("changed");
  } catch (e) {
    problem = { text: e.message, until: now() + ERROR_SHOW_MS };
  } finally {
    busy = false;
    draw();
  }
}

/**
 * Puts the last step's message on the clipboard, and says so on the button for a moment.
 * @param {HTMLButtonElement} button
 * @returns {Promise<void>}
 */
async function copyMessage(button) {
  const text = view?.shift.note?.text || "";
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const box = Object.assign(document.createElement("textarea"), { value: text });
    document.body.append(box);
    box.select();
    document.execCommand("copy");
    box.remove();
  }
  button.textContent = "Copied";
  setTimeout(() => { button.textContent = "Copy message"; }, 1500);
}

/**
 * Handles the buttons in the top bar's part and the cards.
 * @param {MouseEvent} e
 */
function onClick(e) {
  const b = e.target.closest?.("#shift button, #shift-pop button");
  if (menuOpen && !b?.hasAttribute("data-menu")) {
    menuOpen = false;
    draw();
  }
  if (!b || b.disabled) return;
  if (b.hasAttribute("data-menu")) {
    menuOpen = !menuOpen;
    draw();
  } else if (b.dataset.act) send({ action: b.dataset.act });
  else if (b.dataset.post) send({ action: b.dataset.post === "yes" ? "post" : "skip", id: view.shift.note?.id });
  else if (b.hasAttribute("data-snooze")) send({ action: "snooze" });
  else if (b.hasAttribute("data-copy")) copyMessage(b);
  else if (b.dataset.dismiss) {
    dismissed.add(b.dataset.dismiss);
    posted = { id: "", until: 0 };
    draw();
  }
}

document.addEventListener("click", onClick);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && menuOpen) {
    menuOpen = false;
    draw();
  }
});
document.addEventListener("visibilitychange", () => { if (!document.hidden) load(); });
addEventListener("focus", load);
addEventListener("resize", () => popEl());
channel?.addEventListener("message", load);
setInterval(() => { if (view) draw(); }, 1000);
load();
