// Felix's music in the bottom bar, the same on every page: a round orb beside Felix's pill, its ring filling as the
// song plays, that opens the player. The player shows the song (its cover, a progress bar you can click to jump,
// shuffle, repeat, volume and a heart to save it), and below it your library (Liked Songs and your playlists, each
// opening to its songs), a search box, what's up next, what you played recently and the song's lyrics (from LRCLIB,
// moving along as it plays). Spotify plays right here, in
// Spotify's own player for web pages (the Web Playback SDK), so no Spotify app is needed; it can also control
// Spotify playing on your phone. Until Spotify is signed in, the player says so, with a Sign in button that opens
// Spotify's login in a small window (Settings → Music uses the same one). The player lives in Felix's lasting outer
// page (shell.js), so moving between Felix pages doesn't stop the music; a page inside it uses that same player.
// Shell.js mounts it, and its styles are /music.css.
window.FelixMusic = (window.frameElement?.classList.contains("felix-page") && window.parent.FelixMusic) || (() => {
  const POLL_MS = 5000;
  const SPOTIFY_SDK = "https://sdk.scdn.co/spotify-player.js";
  const HERE_NAME = "Felix";
  const HERE_KEY = "felix-spotify-here";
  const NOTE_KEY = "felix-music-note";
  const HERE_START_MS = 15000;
  const RESUME_MS = 60e3;
  const SEARCH_MS = 300;
  const ADDED_MS = 1600;
  const LYRICS_EVERY_MS = 250;
  const LYRICS_LEAD_MS = 200;
  const URIS_MAX = 100;
  const REPEATS = ["off", "context", "track"];
  const LIKED = Object.freeze({ kind: "liked", name: "Liked Songs" });
  const SIGN_IN = { everyMs: 2000, tries: 150, width: 480, height: 720 };
  /** What each newer Spotify scope lets the player do, for the one note that asks you to sign in again. */
  const EXTRA_SAID = { "user-library-modify": "save songs", "user-read-recently-played": "see what you played recently" };
  const line = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const solid = (paths) => `<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">${paths}</svg>`;
  const REPEAT_PATH = `<path d="m17 2 4 4-4 4"/><path d="M3 11v-1a4 4 0 0 1 4-4h14"/><path d="m7 22-4-4 4-4"/><path d="M21 13v1a4 4 0 0 1-4 4H3"/>`;
  const HEART_PATH = `<path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/>`;
  const ICONS = {
    music: line(`<path d="M9 18V5l11-2v13"/><circle cx="6.5" cy="18" r="2.5"/><circle cx="17.5" cy="16" r="2.5"/>`),
    play: solid(`<path d="M8 5v14l11-7z"/>`),
    pause: solid(`<path d="M7 5h4v14H7zM13 5h4v14h-4z"/>`),
    next: solid(`<path d="M6 6v12l8.5-6zM16 6h2v12h-2z"/>`),
    previous: solid(`<path d="M18 6v12l-8.5-6zM6 6h2v12H6z"/>`),
    shuffle: line(`<path d="M16 3h5v5"/><path d="M4 20 21 3"/><path d="M21 16v5h-5"/><path d="m15 15 6 6"/><path d="M4 4l5 5"/>`),
    repeat: line(REPEAT_PATH),
    repeatOne: line(`${REPEAT_PATH}<path d="M11 10h1v4"/>`),
    heart: line(HEART_PATH),
    hearted: `<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true">${HEART_PATH}</svg>`,
    search: line(`<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>`),
    clear: line(`<path d="M18 6 6 18M6 6l12 12"/>`),
    queue: line(`<path d="M21 15V6"/><circle cx="18.5" cy="15.5" r="2.5"/><path d="M12 12H3M16 6H3M12 18H3"/>`),
    recent: line(`<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>`),
    back: line(`<path d="m15 18-6-6 6-6"/>`),
    add: line(`<path d="M11 12H3M16 6H3M16 18H3M18 9v6M21 12h-6"/>`),
    added: line(`<path d="M20 6 9 17l-5-5"/>`),
    volume: line(`<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M19 5a10 10 0 0 1 0 14"/>`),
    muted: line(`<path d="M11 5 6 9H2v6h4l5 4V5z"/><path d="m22 9-6 6M16 9l6 6"/>`),
    settings: line(`<path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/>`),
    liked: solid(HEART_PATH),
    lyrics: line(`<path d="M4 6h11M4 11h11M4 16h6"/><path d="M18 8v9"/><circle cx="16" cy="17" r="2"/>`),
  };

  const state = {
    el: null, sources: null, loadError: "", error: "", controlError: "", spotify: null, pollTimer: 0, signInWatch: 0, sdk: null,
    panel: null, nowKey: "", bodyKey: "",
    here: { player: null, deviceId: null, error: "", starting: false, volume: 0.7 },
    duck: { on: false, volume: null },
    // Where the player's lower half is: a tab (library, queue or recent), what's typed in search, and the lists
    // opened on top of it, the last one showing.
    view: { tab: "library", query: "", stack: [] },
    lib: null, lists: new Map(), search: null, queue: null, recent: null,
    saved: { uri: null, on: false }, added: new Set(), searchTimer: 0, searchSeq: 0, muteFrom: null, sliding: false,
    // The song's lyrics, the line showing now, and whether you scrolled them by hand (which pauses following along).
    lyrics: null, lyricsAt: -1, lyricsHold: false,
  };
  const DUCK_TO = 0.25;
  const RING = 2 * Math.PI * 28;

  /**
   * Escapes text for HTML.
   * @param {unknown} s
   * @returns {string}
   */
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  /**
   * Asks Felix's server, keeping the error's code (like "premium" or "scope") so the player can say what to do.
   * @param {string} path
   * @param {object} [body] Sent as a POST when given.
   * @returns {Promise<any>}
   * @throws {Error & { code: string }}
   */
  async function api(path, body) {
    const init = body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : { cache: "no-store" };
    let res;
    try {
      res = await fetch(path, init);
    } catch {
      throw Object.assign(new Error("Can't reach the local server. Start it with ./prs start."), { code: "offline" });
    }
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(answer.error || `The server answered ${res.status}.`), { code: answer.code || "error" });
    return answer;
  }

  /**
   * Whether Spotify is signed in.
   * @returns {boolean}
   */
  const signedIn = () => Boolean(state.sources?.spotify?.connected);

  /**
   * Whether the sign-in allows an extra, like saving songs ("save") or recently played ("recent").
   * @param {string} extra
   * @returns {boolean}
   */
  const can = (extra) => Boolean(state.sources?.spotify?.can?.[extra]);

  /**
   * Whether Settings → Music shows lyrics.
   * @returns {boolean}
   */
  const lyricsOn = () => FelixShell.cachedSettings?.()?.musicLyrics !== false;

  /**
   * How far into the song Spotify is, in milliseconds, counting the time since the last check.
   * @param {{ playing: boolean, progressMs: number, at: number, track: { durationMs: number } | null } | null} s
   * @returns {number}
   */
  function spotifyAt(s) {
    if (!s?.track?.durationMs) return 0;
    return Math.min(s.track.durationMs, s.progressMs + (s.playing ? Date.now() - s.at : 0));
  }

  /**
   * What Spotify's song has played so far, from 0 to 1.
   * @param {object | null} s
   * @returns {number}
   */
  const spotifyProgress = (s) => (s?.track?.durationMs ? spotifyAt(s) / s.track.durationMs : 0);

  /**
   * What the bar shows.
   * @returns {{ art: string | null, title: string, artists: string, playing: boolean, hasTrack: boolean }}
   */
  function spotifyView() {
    const s = state.spotify;
    if (!s?.track) return { art: null, title: "Nothing playing", artists: "Pick a song or a playlist", playing: false, hasTrack: false };
    return { art: s.track.art, title: s.track.title, artists: s.track.artists, playing: s.playing, hasTrack: true };
  }

  /**
   * The problem the player shows instead of the artist, if any: the last control's, the last check's, or, while
   * nothing plays, why Felix's own Spotify player can't play.
   * @param {{ hasTrack: boolean }} v
   * @returns {string}
   */
  const warning = (v) => state.controlError || state.error || (v.hasTrack ? "" : state.here.error);

  /**
   * A time like 1:42.
   * @param {number} ms
   * @returns {string}
   */
  const clock = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor((ms % 60000) / 1000)).padStart(2, "0")}`;

  /**
   * The orb in the bar: the song's state at a glance, and the ring filling as it plays. It opens the player.
   * @returns {string}
   */
  function orbHtml() {
    if (!signedIn()) {
      const checking = !state.sources && !state.loadError;
      const label = checking ? "Checking your music" : "Music isn't signed in. Show the player.";
      return `<button class="orb idle" type="button" data-music="panel" aria-label="${label}" title="${label}">${ICONS.music}</button>`;
    }
    const v = spotifyView();
    const warn = warning(v);
    if (!v.hasTrack) {
      const label = warn || "Nothing playing. Pick a playlist.";
      return `<button class="orb idle${warn ? " warn" : ""}" type="button" data-music="panel" aria-label="${esc(label)}" title="${esc(label)}">${ICONS.music}</button>`;
    }
    const label = `${v.title} by ${v.artists} ${v.playing ? "is playing" : "is paused"}. Show the player.`;
    return `<button class="orb${warn ? " warn" : ""}" type="button" data-music="panel" aria-label="${esc(label)}" title="${esc(`${v.title} · ${v.artists}`)}">`
      + `<svg class="ringp" viewBox="0 0 60 60" aria-hidden="true"><circle class="track" cx="30" cy="30" r="28"/><circle class="fill" cx="30" cy="30" r="28" stroke-dasharray="0 ${RING}"/></svg>`
      + `${v.playing ? ICONS.pause : ICONS.play}</button>`;
  }

  /**
   * A small round button with an icon, showing its state with a tint and a dot when it's on.
   * @param {string} act What it does (data-act).
   * @param {string} icon
   * @param {string} label
   * @param {{ on?: boolean, disabled?: boolean, extra?: string }} [o]
   * @returns {string}
   */
  function iconButton(act, icon, label, { on, disabled, extra = "" } = {}) {
    const pressed = on === undefined ? "" : ` aria-pressed="${on}"`;
    return `<button class="mx-icon${on ? " on" : ""}" type="button" data-act="${act}" data-k="${act}" aria-label="${esc(label)}" title="${esc(label)}"${pressed}${disabled ? " disabled" : ""}${extra}>${icon}</button>`;
  }

  /**
   * The sign-in card, shown in place of the player until Spotify is signed in.
   * @returns {string}
   */
  function signInHtml() {
    const checking = !state.sources && !state.loadError;
    const sub = checking ? "Checking your music…" : state.sources?.spotify?.error || state.loadError || "Not signed in to Spotify";
    return `<div class="mx-top"><span class="mx-art">${ICONS.music}</span><div class="mx-track"><b>Music</b><span>${esc(sub)}</span></div></div>`
      + (checking ? "" : `<button class="mx-primary" type="button" data-act="signin" data-k="signin" title="Opens Spotify's sign-in in a small window">Sign in to Spotify</button>`);
  }

  /**
   * The volume shown, from 0 to 100: Felix's own player's, or the device's.
   * @returns {number | null} Null when the device can't change its volume.
   */
  function volumeNow() {
    const d = state.spotify?.device;
    if (playsHere()) return Math.round(state.here.volume * 100);
    if (!d || d.supportsVolume === false || d.volume === null || d.volume === undefined) return null;
    return d.volume;
  }

  /**
   * The song playing: its cover, title and artist (and the heart), the progress bar, the controls and the volume.
   * @returns {string}
   */
  function nowHtml() {
    const v = spotifyView();
    const s = state.spotify;
    const warn = warning(v);
    const art = v.art ? `<img src="${esc(v.art)}" alt="">` : ICONS.music;
    const sub = warn ? `<span class="warn">${esc(warn)}</span>` : `<span>${esc(v.artists)}</span>`;
    const liked = v.hasTrack && state.saved.uri === s.track.uri && state.saved.on;
    const heart = v.hasTrack && can("save") && s.track.uri?.startsWith("spotify:track:")
      ? iconButton("save", liked ? ICONS.hearted : ICONS.heart, liked ? "Remove from Liked Songs" : "Save to Liked Songs", { on: liked })
      : "";
    const duration = v.hasTrack ? s.track.durationMs : 0;
    const seek = v.hasTrack
      ? `<div class="mx-seek"><span data-at>0:00</span><div class="mx-rail" role="slider" tabindex="0" data-k="seek" aria-label="Song position" aria-valuemin="0" aria-valuemax="${Math.round(duration / 1000)}"><i></i></div><span>${clock(duration)}</span></div>`
      : "";
    const repeat = s?.repeat || "off";
    const repeatLabel = { off: "Repeat", context: "Repeating all. Repeat this song", track: "Repeating this song. Turn repeat off" }[repeat];
    const toggle = v.playing ? ["pause", "Pause"] : ["play", v.hasTrack ? "Play" : "Pick something to play"];
    const ctl = `<div class="mx-ctl">`
      + iconButton("shuffle", ICONS.shuffle, s?.shuffle ? "Shuffle is on. Turn it off" : "Shuffle", { on: Boolean(s?.shuffle), disabled: !v.hasTrack })
      + iconButton("previous", ICONS.previous, "Previous", { disabled: !v.hasTrack })
      + `<button class="mx-play" type="button" data-act="toggle" data-k="toggle" aria-label="${toggle[1]}" title="${toggle[1]}">${ICONS[toggle[0]]}</button>`
      + iconButton("next", ICONS.next, "Next", { disabled: !v.hasTrack })
      + iconButton("repeat", repeat === "track" ? ICONS.repeatOne : ICONS.repeat, repeatLabel, { on: repeat !== "off", disabled: !v.hasTrack })
      + `</div>`;
    const volume = volumeNow();
    const vol = volume === null ? "" : `<div class="mx-vol">`
      + iconButton("mute", volume ? ICONS.volume : ICONS.muted, volume ? "Mute" : "Unmute")
      + `<input class="mx-range" type="range" min="0" max="100" step="1" value="${volume}" data-k="volume" aria-label="Volume" style="--fill:${volume}%">`
      + `${s?.device?.name ? `<span class="mx-device" title="Playing on ${esc(s.device.name)}">${esc(s.device.name)}</span>` : ""}</div>`;
    const showing = state.view.tab === "lyrics" && !state.view.query && !state.view.stack.length;
    const words = v.hasTrack && lyricsOn() ? iconButton("tab-lyrics", ICONS.lyrics, showing ? "Hide lyrics" : "Lyrics", { on: showing }) : "";
    return `<div class="mx-top"><span class="mx-art">${art}</span><div class="mx-track"><b title="${esc(v.title)}">${esc(v.title)}</b>${sub}</div>${words}${heart}</div>`
      + seek + ctl + vol;
  }

  /**
   * The one note, until you close it, that a newer sign-in would let the player do more.
   * @returns {string}
   */
  function noteHtml() {
    const missing = state.sources?.spotify?.missing || [];
    const said = missing.map((scope) => EXTRA_SAID[scope]).filter(Boolean);
    if (!said.length || readNote() === missing.join(" ")) return "";
    return `<div class="mx-note"><span>Sign in to Spotify again to ${esc(said.join(" and "))}.</span>`
      + `<button class="mx-link" type="button" data-act="signin">Sign in</button>`
      + `<button class="mx-icon mx-small" type="button" data-act="note-off" aria-label="Dismiss" title="Dismiss">${ICONS.clear}</button></div>`;
  }

  /**
   * Which note you closed, if any.
   * @returns {string | null}
   */
  function readNote() {
    try { return localStorage.getItem(NOTE_KEY); } catch { return null; }
  }

  /**
   * The search box and the tabs under the song: Up next and Recently played (Library is what shows when neither is
   * picked), and a link to the music settings.
   * @returns {string}
   */
  function navHtml() {
    const { tab, query } = state.view;
    return `<div class="mx-nav"><label class="mx-search">${ICONS.search}`
      + `<input type="search" placeholder="Search Spotify" aria-label="Search Spotify" autocomplete="off" spellcheck="false" value="${esc(query)}" data-k="search">`
      + `<button class="mx-icon mx-small" type="button" data-act="clear" aria-label="Clear search" title="Clear search"${query ? "" : " hidden"}>${ICONS.clear}</button></label>`
      + iconButton("tab-queue", ICONS.queue, "Up next", { on: tab === "queue" && !query })
      + (can("recent") ? iconButton("tab-recent", ICONS.recent, "Recently played", { on: tab === "recent" && !query }) : "")
      + `<a class="mx-icon" href="/settings#music" aria-label="Music settings" title="Music settings">${ICONS.settings}</a></div>`;
  }

  /**
   * A few grey rows while a list loads.
   * @param {number} [n]
   * @returns {string}
   */
  const loadingHtml = (n = 5) => `<div class="mx-skel" role="status" aria-label="Loading">${"<div><i></i><span><b></b><b></b></span></div>".repeat(n)}</div>`;

  /**
   * Why a list couldn't load, with what to do about it.
   * @param {{ error: string, code?: string }} failed
   * @param {string} retry The data-act of the Try again button.
   * @returns {string}
   */
  function errorHtml(failed, retry) {
    const signInAgain = ["scope", "expired", "not-connected", "sign-in-again"].includes(failed.code);
    const act = signInAgain ? `<button class="mx-link" type="button" data-act="signin">Sign in again</button>`
      : ["premium", "unavailable", "not-found"].includes(failed.code) ? "" : `<button class="mx-link" type="button" data-act="${retry}">Try again</button>`;
    return `<div class="mx-empty warn"><span>${esc(failed.error)}</span>${act}</div>`;
  }

  /**
   * A quiet line for an empty list.
   * @param {string} text
   * @returns {string}
   */
  const emptyHtml = (text) => `<div class="mx-empty">${esc(text)}</div>`;

  /**
   * A cover picture, or a plain tile with an icon.
   * @param {string | null} image
   * @param {string} [cls]
   * @param {string} [icon]
   * @returns {string}
   */
  const coverHtml = (image, cls = "", icon = ICONS.music) => (image ? `<img class="mx-cover ${cls}" src="${esc(image)}" alt="" loading="lazy">` : `<span class="mx-cover ${cls}">${icon}</span>`);

  /**
   * One song in a list. Clicking it plays it (from there on in its list); the button beside it adds it to Up next.
   * @param {object} t
   * @param {number} i Its place in the list showing.
   * @param {{ art?: string | null, number?: boolean, still?: boolean }} [o] `art` is the cover to use when the song
   *   has none; `number` shows its place instead of a cover; `still` makes a row you can't click (Up next).
   * @returns {string}
   */
  function trackHtml(t, i, { art = null, number = false, still = false } = {}) {
    const now = state.spotify?.track?.uri === t.uri;
    const lead = number ? `<span class="mx-num">${i + 1}</span>` : coverHtml(t.art || art);
    const body = `${lead}<span class="mx-name"><b>${esc(t.title)}</b><span>${esc(t.artists)}</span></span><span class="mx-dur">${t.durationMs ? clock(t.durationMs) : ""}</span>`;
    const cls = `mx-row${now ? " is-now" : ""}${t.playable ? "" : " off"}`;
    if (still) return `<div class="${cls}" data-uri="${esc(t.uri)}"><div class="mx-item">${body}</div></div>`;
    const added = state.added.has(t.uri);
    return `<div class="${cls}" data-uri="${esc(t.uri)}"><button class="mx-item" type="button" data-act="play-track" data-i="${i}" data-k="t${i}"${t.playable ? "" : " disabled"}>${body}</button>`
      + (t.playable && t.uri.startsWith("spotify:track:") ? `<button class="mx-icon mx-small mx-add${added ? " on" : ""}" type="button" data-act="queue" data-uri="${esc(t.uri)}" aria-label="${added ? "Added to queue" : "Add to queue"}" title="${added ? "Added to queue" : "Add to queue"}">${added ? ICONS.added : ICONS.add}</button>` : "")
      + `</div>`;
  }

  /**
   * One list you can open: a playlist, an album, an artist or Liked Songs. The button beside it plays it.
   * @param {{ kind: string, id?: string, name: string, image?: string | null, uri?: string, sub?: string }} l
   * @returns {string}
   */
  function openableHtml(l) {
    const data = Object.entries({ kind: l.kind, id: l.id || "", name: l.name, image: l.image || "", uri: l.uri || "", sub: l.sub || "" })
      .map(([k, val]) => ` data-${k}="${esc(val)}"`).join("");
    const now = l.uri && state.spotify?.context === l.uri;
    const icon = l.kind === "liked" ? ICONS.liked : ICONS.music;
    return `<div class="mx-row${now ? " is-now" : ""}" data-ctx="${esc(l.uri || "")}"><button class="mx-item" type="button" data-act="open"${data} data-k="o${esc(l.kind)}${esc(l.id || "")}">`
      + `${coverHtml(l.image, `${l.kind === "artist" ? "round" : ""}${l.kind === "liked" ? " liked" : ""}`, icon)}<span class="mx-name"><b>${esc(l.name)}</b>${l.sub ? `<span>${esc(l.sub)}</span>` : ""}</span></button>`
      + `<button class="mx-icon mx-small mx-add" type="button" data-act="play-open"${data} aria-label="Play ${esc(l.name)}" title="Play">${ICONS.play}</button></div>`;
  }

  /**
   * "12 songs", or "1 song".
   * @param {number} n
   * @returns {string}
   */
  const songs = (n) => `${n} ${n === 1 ? "song" : "songs"}`;

  /**
   * The key a list is kept under.
   * @param {{ kind: string, id?: string, name?: string }} l
   * @returns {string}
   */
  const listKey = (l) => `${l.kind}:${l.id || l.name || ""}`;

  /**
   * The library: Liked Songs first, then your playlists.
   * @returns {string}
   */
  function libraryHtml() {
    const lib = state.lib;
    if (!lib || lib.loading) return loadingHtml(6);
    if (lib.error) return errorHtml(lib, "retry-lib");
    const liked = state.lists.get(listKey(LIKED));
    const likedRow = openableHtml({ kind: "liked", name: "Liked Songs", sub: liked?.total ? songs(liked.total) : "" });
    const lists = lib.items.map((p) => openableHtml({ kind: "playlist", id: p.id, name: p.name, image: p.image, uri: p.uri, sub: songs(p.count) }));
    return `<div class="mx-list">${likedRow}${lists.join("")}</div>${lib.items.length ? "" : emptyHtml("No playlists yet.")}`;
  }

  /**
   * An opened list: its header with a back button and Play, then its songs, loading more as you scroll.
   * @param {{ kind: string, id?: string, name: string, image?: string, uri?: string, sub?: string }} open
   * @returns {string}
   */
  function listHtml(open) {
    const l = state.lists.get(listKey(open));
    const total = l?.total ? songs(l.total) : open.sub;
    const head = `<div class="mx-head">${iconButton("back", ICONS.back, "Back")}`
      + `${coverHtml(open.image || null, `${open.kind === "artist" ? "round" : ""}${open.kind === "liked" ? " liked" : ""}`, open.kind === "liked" ? ICONS.liked : ICONS.music)}`
      + `<span class="mx-name"><b title="${esc(open.name)}">${esc(open.name)}</b>${total ? `<span>${esc(total)}</span>` : ""}</span>`
      + `<button class="mx-play small" type="button" data-act="play-all" data-k="play-all" aria-label="Play ${esc(open.name)}" title="Play"${l?.tracks?.length || open.uri ? "" : " disabled"}>${ICONS.play}</button></div>`;
    let body;
    if (!l || (l.loading && !l.tracks)) body = loadingHtml();
    else if (l.error && !l.tracks) body = errorHtml(l, "retry-list");
    else if (!l.tracks.length) body = emptyHtml(open.kind === "artist" ? "No songs found for this artist." : "Nothing in here yet.");
    else {
      const rows = l.tracks.map((t, i) => trackHtml(t, i, { art: open.kind === "album" ? null : open.image || null, number: open.kind === "album" }));
      const more = l.loading ? loadingHtml(2) : l.error ? errorHtml(l, "retry-list") : "";
      body = `<div class="mx-list">${rows.join("")}</div>${more}`;
    }
    return head + body;
  }

  /**
   * Search results, grouped: songs, then artists, albums and playlists.
   * @returns {string}
   */
  function searchHtml() {
    const s = state.search;
    if (!s || s.loading) return loadingHtml();
    if (s.error) return errorHtml(s, "retry-search");
    const r = s.results;
    const groups = [
      ["Songs", r.tracks.map((t, i) => trackHtml(t, i))],
      ["Artists", r.artists.map((a) => openableHtml({ kind: "artist", id: a.id, name: a.name, image: a.image, uri: a.uri, sub: "Artist" }))],
      ["Albums", r.albums.map((a) => openableHtml({ kind: "album", id: a.id, name: a.name, image: a.image, uri: a.uri, sub: a.artists }))],
      ["Playlists", r.playlists.map((p) => openableHtml({ kind: "playlist", id: p.id, name: p.name, image: p.image, uri: p.uri, sub: p.owner ? `By ${p.owner}` : songs(p.count) }))],
    ].filter(([, rows]) => rows.length);
    if (!groups.length) return emptyHtml(`Nothing on Spotify for "${s.q}".`);
    return groups.map(([title, rows]) => `<h3 class="mx-label">${title}</h3><div class="mx-list">${rows.join("")}</div>`).join("");
  }

  /**
   * What plays now and what's up next.
   * @returns {string}
   */
  function queueHtml() {
    const q = state.queue;
    if (!q || (q.loading && !q.current)) return loadingHtml(4);
    if (q.error) return errorHtml(q, "retry-queue");
    if (!q.current) return emptyHtml("Play something to see what's up next.");
    const next = q.queue.length ? `<div class="mx-list">${q.queue.map((t, i) => trackHtml(t, i, { still: true })).join("")}</div>` : emptyHtml("Nothing up next.");
    return `<h3 class="mx-label">Now playing</h3><div class="mx-list">${trackHtml(q.current, 0, { still: true })}</div><h3 class="mx-label">Up next</h3>${next}`;
  }

  /**
   * The songs you played last.
   * @returns {string}
   */
  function recentHtml() {
    const r = state.recent;
    if (!r || r.loading) return loadingHtml();
    if (r.error) return errorHtml(r, "retry-recent");
    if (!r.tracks.length) return emptyHtml("Nothing played lately.");
    return `<div class="mx-list">${r.tracks.map((t, i) => trackHtml(t, i)).join("")}</div>`;
  }

  /**
   * The song's lyrics: timed lines that light up as it plays (click one to jump there), or plain words that just
   * scroll, or why there are none. LRCLIB gets a small credit under them.
   * @returns {string}
   */
  function lyricsHtml() {
    const t = state.spotify?.track;
    if (!t) return emptyHtml("Play something to see its lyrics.");
    const l = state.lyrics;
    if (!l || l.uri !== t.uri || l.loading) return `<div class="mx-skel mx-skel-ly" role="status" aria-label="Loading lyrics"><b></b><b></b><b></b><b></b><b></b></div>`;
    if (l.error) return errorHtml(l, "retry-lyrics");
    const credit = `<p class="mx-credit">Lyrics from LRCLIB</p>`;
    const d = l.data;
    if (d.synced) {
      const at = state.lyricsAt;
      const lines = d.synced.map((x, i) => `<button class="mx-ly${i < at ? " past" : i === at ? " now" : ""}" type="button" data-act="lyric" data-i="${i}" data-k="ly${i}">${x.text ? esc(x.text) : "♪"}</button>`);
      return `<div class="mx-lyrics">${lines.join("")}</div><button class="mx-chip" type="button" data-act="lyrics-now"${state.lyricsHold ? "" : " hidden"}>Back to now</button>${credit}`;
    }
    if (d.plain) return `<p class="mx-label">Not synced</p><div class="mx-plain">${esc(d.plain)}</div>${credit}`;
    return emptyHtml(d.instrumental ? "This one's instrumental." : "No lyrics found for this song.") + credit;
  }

  /**
   * What the lower half shows now, as a key that changes when it should start again at the top.
   * @returns {{ key: string, html: () => string }}
   */
  function bodyView() {
    const { tab, query, stack } = state.view;
    const open = stack.at(-1);
    if (open) return { key: `list:${listKey(open)}`, html: () => listHtml(open) };
    if (query) return { key: "search", html: searchHtml };
    if (tab === "queue") return { key: "queue", html: queueHtml };
    if (tab === "recent" && can("recent")) return { key: "recent", html: recentHtml };
    if (tab === "lyrics" && lyricsOn()) return { key: `lyrics:${state.spotify?.track?.uri || ""}`, html: lyricsHtml };
    return { key: "library", html: libraryHtml };
  }

  /**
   * Draws a part of the player again, keeping the focused control focused.
   * @param {HTMLElement | null} part
   * @param {string} html
   */
  function redraw(part, html) {
    if (!part) return;
    const focused = part.contains(document.activeElement) ? document.activeElement.dataset.k : null;
    part.innerHTML = html;
    if (focused) part.querySelector(`[data-k="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  }

  /**
   * Draws the song half of the player, when what it shows changed.
   */
  function renderNow() {
    const part = state.panel?.querySelector(".mx-now");
    if (!part) return;
    const html = signedIn() ? nowHtml() : signInHtml();
    if (html === state.nowKey) return;
    if (state.sliding) return;
    state.nowKey = html;
    redraw(part, html);
    tick();
  }

  /**
   * Draws the lower half: the library, a list, search results, up next or recently played. It keeps its place when
   * the same view draws again, and starts at the top for a new one.
   */
  function renderBody() {
    const part = state.panel?.querySelector(".mx-body");
    if (!part) return;
    const view = bodyView();
    const top = view.key === state.bodyKey ? part.scrollTop : 0;
    state.bodyKey = view.key;
    redraw(part, view.html());
    part.scrollTop = top;
  }

  /**
   * Draws the search box's clear button and the tabs' state, without touching what's typed.
   */
  function renderNav() {
    const nav = state.panel?.querySelector(".mx-nav");
    if (!nav) return;
    const { tab, query } = state.view;
    nav.querySelector('[data-act="clear"]').hidden = !query;
    for (const [act, on] of [["tab-queue", tab === "queue" && !query], ["tab-recent", tab === "recent" && !query]]) {
      const b = nav.querySelector(`[data-act="${act}"]`);
      b?.classList.toggle("on", on);
      b?.setAttribute("aria-pressed", String(on));
    }
  }

  /**
   * Draws the whole player: the sign-in alone, or the song, the note, the search box and the lower half.
   */
  function renderPanel() {
    const p = state.panel;
    if (!p) return;
    const full = signedIn();
    if (p.classList.contains("full") !== full || !p.firstChild) {
      p.classList.toggle("full", full);
      p.innerHTML = `<section class="mx-now"></section>${full ? `<div class="mx-notes"></div>${navHtml()}<div class="mx-body"></div>` : ""}`;
      state.nowKey = "";
      state.bodyKey = "";
    }
    renderNow();
    if (!full) return;
    redraw(p.querySelector(".mx-notes"), noteHtml());
    renderNav();
    renderBody();
  }

  /**
   * Draws the orb, and the player when it's open.
   */
  function render() {
    if (!state.el) return;
    state.el.classList.toggle("unset", !signedIn());
    state.el.classList.toggle("ducked", state.duck.on);
    state.el.innerHTML = orbHtml();
    tick();
    if (state.panel) {
      renderNow();
      markNow();
    }
  }

  /**
   * Marks the song and the list playing now in the lower half, without drawing it again.
   */
  function markNow() {
    const uri = state.spotify?.track?.uri;
    const ctx = state.spotify?.context;
    for (const row of state.panel?.querySelectorAll(".mx-body .mx-row") || []) {
      row.classList.toggle("is-now", Boolean((row.dataset.uri && row.dataset.uri === uri) || (row.dataset.ctx && row.dataset.ctx === ctx)));
    }
  }

  /**
   * Moves the ring, the progress bar and its time along between checks.
   */
  function tick() {
    const p = spotifyProgress(state.spotify);
    state.el?.querySelector(".ringp .fill")?.setAttribute("stroke-dasharray", `${(p * RING).toFixed(1)} ${RING}`);
    const rail = state.panel?.querySelector(".mx-rail");
    if (!rail) return;
    rail.style.setProperty("--at", `${(p * 100).toFixed(2)}%`);
    const at = spotifyAt(state.spotify);
    rail.setAttribute("aria-valuenow", String(Math.round(at / 1000)));
    rail.setAttribute("aria-valuetext", `${clock(at)} of ${clock(state.spotify?.track?.durationMs || 0)}`);
    const shown = state.panel.querySelector("[data-at]");
    if (shown) shown.textContent = clock(at);
  }

  /**
   * Asks the server what Spotify is playing, and checks again in a few seconds while the window is in view.
   */
  async function pollSpotify() {
    clearTimeout(state.pollTimer);
    if (!signedIn() || document.hidden) return;
    try {
      state.spotify = { ...(await api("/api/music/spotify/now")), at: Date.now() };
      state.error = "";
      if (state.spotify.playing) state.controlError = "";
    } catch (e) {
      state.error = e.message;
    }
    songChanged();
    render();
    state.pollTimer = setTimeout(pollSpotify, POLL_MS);
  }

  /**
   * When the song changes, checks whether it's in your Liked Songs (for the heart), and refreshes Up next.
   */
  function songChanged() {
    const uri = state.spotify?.track?.uri || null;
    if (uri === state.saved.uri) return;
    state.saved = { uri, on: false };
    if (state.view.tab === "queue" && state.panel) loadQueue();
    if (state.view.tab === "lyrics" && state.panel) loadLyrics();
    if (!uri || !can("save") || !uri.startsWith("spotify:track:")) return;
    api(`/api/music/spotify/saved?${new URLSearchParams({ uri })}`).then(({ saved }) => {
      if (state.saved.uri !== uri) return;
      state.saved.on = saved;
      renderNow();
    }, () => {});
  }

  /**
   * Loads whether Spotify is signed in, starts Felix's own Spotify player, then checks what's playing.
   */
  async function load() {
    try {
      state.sources = (await api("/api/music")).sources;
      state.loadError = "";
    } catch (e) {
      state.loadError = e.message;
    }
    if (state.sources?.spotify?.outdated) state.here.error = "Sign in to Spotify again in Settings → Music so Felix can play music itself.";
    announce();
    render();
    if (state.panel) renderPanel();
    startHere();
    pollSpotify();
  }

  /**
   * Tells every Felix page in this window the latest sign-in, as a "felix:music" event, so Settings follows it.
   */
  function announce() {
    for (const w of FelixShell.windows()) w.dispatchEvent(new w.CustomEvent("felix:music", { detail: state.sources }));
  }

  /**
   * Checks the sign-in every few seconds while its window is open, until it's done or failed. Spotify's login
   * page cuts the window off from Felix, so Felix can't tell when it closes.
   * @param {string} id
   */
  function watchSignIn(id) {
    clearInterval(state.signInWatch);
    const before = state.sources?.[id]?.error;
    let tries = 0;
    state.signInWatch = setInterval(async () => {
      await load();
      const s = state.sources?.[id];
      if ((s?.connected && !s.outdated && !s.missing?.length) || (s?.error && s.error !== before) || ++tries >= SIGN_IN.tries) clearInterval(state.signInWatch);
    }, SIGN_IN.everyMs);
  }

  /**
   * Opens a source's sign-in in a small window in the middle of this one, or in the whole window when the browser
   * blocks windows.
   * @param {string} [id]
   */
  function signIn(id = "spotify") {
    const { width, height } = SIGN_IN;
    const left = Math.round(screenX + (outerWidth - width) / 2);
    const top = Math.round(screenY + (outerHeight - height) / 2);
    const w = window.open(`/api/music/connect/${id}?popup=1`, `felix-sign-in-${id}`, `popup,width=${width},height=${height},left=${left},top=${top}`);
    if (!w) {
      window.top.location.href = `/api/music/connect/${id}`;
      return;
    }
    w.focus();
    watchSignIn(id);
  }

  /**
   * Sends one control to Spotify and checks what's playing just after. A failure stays in the player until the
   * next control or until music plays.
   * @param {string} action
   * @param {object} [extra]
   * @returns {Promise<boolean>} Whether Spotify took it.
   */
  async function spotifyControl(action, extra = {}) {
    state.controlError = "";
    let ok = true;
    try {
      await api("/api/music/spotify", { action, ...extra });
    } catch (e) {
      ok = false;
      state.controlError = state.here.deviceId || e.code === "scope" ? e.message : state.here.error || e.message;
      render();
    }
    setTimeout(pollSpotify, 700);
    return ok;
  }

  /**
   * Whether Spotify is playing in Felix's own player.
   * @returns {boolean}
   */
  const playsHere = () => Boolean(state.here.deviceId) && state.spotify?.device?.id === state.here.deviceId;

  /**
   * The device a control goes to: Felix's own player when it's the one playing, else whichever is active.
   * @returns {string | undefined}
   */
  const target = () => (playsHere() ? state.here.deviceId : undefined);

  /**
   * Plays or pauses, skips forward or back, in Felix's own Spotify player.
   * @param {"toggle" | "next" | "previous"} action
   */
  function hereControl(action) {
    const p = state.here.player;
    if (action === "next") p.nextTrack();
    else if (action === "previous") p.previousTrack();
    else p.togglePlay();
  }

  /**
   * Plays or pauses, skips forward or back. Spotify plays in Felix when nothing else is playing it.
   * @param {"toggle" | "next" | "previous"} action
   */
  function control(action) {
    const view = spotifyView();
    if (action === "toggle" && !view.hasTrack) return showLibrary();
    state.here.player?.activateElement?.();
    if (playsHere()) return hereControl(action);
    if (action === "toggle" && state.spotify) state.spotify = { ...state.spotify, playing: !view.playing, progressMs: spotifyAt(state.spotify), at: Date.now() };
    render();
    const device = state.spotify?.device ? undefined : state.here.deviceId || undefined;
    spotifyControl(action === "toggle" ? (view.playing ? "pause" : "play") : action, action === "toggle" ? { device } : {});
  }

  /**
   * Changes what's playing locally at once, so the player answers before Spotify does.
   * @param {object} patch
   */
  function optimistic(patch) {
    if (!state.spotify) return;
    state.spotify = { ...state.spotify, ...patch };
    render();
  }

  /**
   * Turns shuffle on or off.
   * @param {boolean} on
   */
  function setShuffle(on) {
    optimistic({ shuffle: on });
    spotifyControl("shuffle", { on, device: target() });
  }

  /**
   * Sets repeat: off, the whole list ("context") or this song ("track").
   * @param {string} mode
   */
  function setRepeat(mode) {
    optimistic({ repeat: mode });
    spotifyControl("repeat", { mode, device: target() });
  }

  /**
   * Jumps to a place in the song.
   * @param {number} ms
   */
  function seekTo(ms) {
    const s = state.spotify;
    if (!s?.track) return;
    const positionMs = Math.round(Math.max(0, Math.min(s.track.durationMs - 1000, ms)));
    optimistic({ progressMs: positionMs, at: Date.now() });
    tick();
    if (playsHere()) state.here.player.seek(positionMs);
    else spotifyControl("seek", { positionMs, device: target() });
  }

  /**
   * How many seconds the arrow keys jump, from Settings → Music.
   * @returns {number}
   */
  const seekStep = () => (Number(FelixShell.cachedSettings?.()?.musicSeekSeconds) || 10) * 1000;

  /**
   * Sets the volume, from 0 to 100: straight away in Felix's own player, else on the device playing. While Felix
   * talks, the new volume is where it comes back up to.
   * @param {number} volume
   * @param {boolean} [send] Whether to tell a device other than Felix's (once the slider is let go).
   */
  async function setVolume(volume, send = true) {
    const v = Math.max(0, Math.min(100, Math.round(volume)));
    if (playsHere()) {
      state.here.volume = v / 100;
      if (state.duck.on && state.duck.volume !== null) state.duck.volume = v / 100;
      await state.here.player.setVolume(state.duck.on ? (v / 100) * DUCK_TO : v / 100);
      return;
    }
    if (state.spotify?.device) state.spotify.device = { ...state.spotify.device, volume: v };
    if (send) spotifyControl("volume", { volume: v });
  }

  /**
   * Saves the song playing to your Liked Songs, or takes it out.
   */
  async function toggleSaved() {
    const uri = state.spotify?.track?.uri;
    if (!uri) return;
    const on = !(state.saved.uri === uri && state.saved.on);
    state.saved = { uri, on };
    renderNow();
    if (!(await spotifyControl("save", { uri, on })) && state.saved.uri === uri) {
      state.saved.on = !on;
      renderNow();
    }
  }

  /**
   * Plays, pauses, skips, shuffles, repeats or finds something to play, because Felix was asked to. Play or pause
   * does nothing when the music already is.
   * @param {"play" | "pause" | "next" | "previous" | { action: string, on?: boolean, mode?: string, query?: string, kind?: string }} action
   */
  function command(action) {
    if (action && typeof action === "object") return commandWith(action);
    if (action === "next" || action === "previous") return control(action);
    if ((action === "play") !== spotifyView().playing) control("toggle");
  }

  /**
   * The commands with more to them: shuffle, repeat, search, and finding something by name to play.
   * @param {{ action: string, on?: boolean, mode?: string, query?: string, kind?: string }} c
   */
  function commandWith(c) {
    if (c.action === "shuffle") return setShuffle(Boolean(c.on));
    if (c.action === "repeat") return setRepeat(REPEATS.includes(c.mode) ? c.mode : "context");
    if (c.action === "search") return showSearch(c.query || "");
    if (c.action === "find") return playFound(c.query || "", c.kind || "any");
  }

  /**
   * Plays what you named: one of your playlists, Liked Songs, or Spotify's top song for it. When Spotify has
   * nothing, the player opens on a search for it, so you can see why.
   * @param {string} query
   * @param {string} kind
   */
  async function playFound(query, kind) {
    state.here.player?.activateElement?.();
    let found;
    try {
      found = await api(`/api/music/spotify/find?${new URLSearchParams({ q: query, kind })}`);
    } catch (e) {
      if (e.code === "not-found") return showSearch(query);
      state.controlError = e.message;
      return render();
    }
    if (found.type === "liked") {
      const liked = await loadList(LIKED);
      if (liked?.tracks?.length) playTracks(liked.tracks, 0);
      return;
    }
    playWhat(found.type === "track" ? { uris: [found.uri] } : { uri: found.uri });
  }

  /**
   * Starts playing, in Felix's own player when it's ready.
   * @param {{ uri?: string, uris?: string[], offset?: number | string }} what
   */
  function playWhat(what) {
    state.here.player?.activateElement?.();
    spotifyControl("play", { ...what, device: state.here.deviceId || undefined });
  }

  /**
   * Plays songs from a list that has no Spotify address of its own (Liked Songs, an artist's songs, search results,
   * recently played), starting at one of them. Spotify takes up to 100 songs at a time.
   * @param {object[]} tracks
   * @param {number} i
   */
  function playTracks(tracks, i) {
    const playable = tracks.filter((t) => t.playable);
    const at = Math.max(0, playable.indexOf(tracks[i]));
    const from = at < URIS_MAX ? 0 : at;
    playWhat({ uris: playable.slice(from, from + URIS_MAX).map((t) => t.uri), offset: at - from });
  }

  /**
   * The songs showing in the lower half now.
   * @returns {object[]}
   */
  function tracksShowing() {
    const open = state.view.stack.at(-1);
    if (open) return state.lists.get(listKey(open))?.tracks || [];
    if (state.view.query) return state.search?.results?.tracks || [];
    if (state.view.tab === "recent") return state.recent?.tracks || [];
    return [];
  }

  /**
   * Plays a song from the list showing: a playlist or album plays on from it, anything else plays its songs.
   * @param {number} i
   */
  function playTrack(i) {
    const open = state.view.stack.at(-1);
    const tracks = tracksShowing();
    const t = tracks[i];
    if (!t) return;
    if (open && (open.kind === "playlist" || open.kind === "album") && open.uri) return playWhat({ uri: open.uri, offset: t.uri });
    playTracks(tracks, i);
  }

  /**
   * Plays a list from its start: a playlist, album or artist by its address, Liked Songs by its songs.
   * @param {{ kind: string, id?: string, name: string, uri?: string }} l
   */
  async function playList(l) {
    if (l.uri) return playWhat({ uri: l.uri });
    const loaded = await loadList(l);
    if (loaded?.tracks?.length) playTracks(loaded.tracks, 0);
  }

  /**
   * Adds a song to Up next, with a check on its button for a moment.
   * @param {string} uri
   */
  async function addToQueue(uri) {
    if (!state.spotify?.track) {
      state.controlError = "Play something first, then add songs to Up next.";
      return render();
    }
    state.added.add(uri);
    renderBody();
    const ok = await spotifyControl("queue", { uri, device: target() });
    setTimeout(() => {
      state.added.delete(uri);
      renderBody();
    }, ok ? ADDED_MS : 0);
    if (ok && state.view.tab === "queue") loadQueue();
  }

  /**
   * Loads your playlists for the library once, and the first page of Liked Songs beside them.
   * @param {boolean} [again] Load them again even if they're here.
   */
  async function loadLibrary(again = false) {
    if (state.lib?.items && !again) return;
    state.lib = { loading: true };
    renderBody();
    loadList(LIKED);
    try {
      state.lib = { items: (await api("/api/music/playlists?source=spotify")).playlists };
    } catch (e) {
      state.lib = { error: e.message, code: e.code };
    }
    renderBody();
  }

  /**
   * Loads the next page of a list's songs (the first, when none are here yet). Each list is kept, so going back
   * to it is instant.
   * @param {{ kind: string, id?: string, name?: string }} l
   * @returns {Promise<object | undefined>} The list as kept.
   */
  async function loadList(l) {
    const key = listKey(l);
    const had = state.lists.get(key);
    if (had?.loading || (had?.tracks && had.next === null && !had.error)) return had;
    const offset = had?.tracks ? had.next : 0;
    state.lists.set(key, { ...had, loading: true, error: "" });
    renderBody();
    const params = new URLSearchParams({ kind: l.kind, id: l.id || "", name: l.name || "", offset: String(offset) });
    try {
      const page = await api(`/api/music/spotify/list?${params}`);
      state.lists.set(key, { tracks: [...(had?.tracks || []), ...page.tracks], total: page.total, next: page.next });
    } catch (e) {
      state.lists.set(key, { ...had, loading: false, error: e.message, code: e.code });
    }
    renderBody();
    return state.lists.get(key);
  }

  /**
   * Loads Up next.
   */
  async function loadQueue() {
    state.queue = { ...state.queue, loading: true, error: "" };
    renderBody();
    try {
      state.queue = await api("/api/music/spotify/queue");
    } catch (e) {
      state.queue = { error: e.message, code: e.code };
    }
    renderBody();
  }

  /**
   * Loads what you played recently.
   */
  async function loadRecent() {
    state.recent = { loading: true };
    renderBody();
    try {
      state.recent = await api("/api/music/spotify/recent");
    } catch (e) {
      state.recent = { error: e.message, code: e.code };
    }
    renderBody();
  }

  /**
   * Loads the lyrics of the song playing, once for each song. Only its title, first artist, album and length go
   * to the server (and on to LRCLIB).
   * @param {boolean} [again] Ask again even if they're here.
   */
  async function loadLyrics(again = false) {
    const t = state.spotify?.track;
    if (!t || !lyricsOn() || (!again && state.lyrics?.uri === t.uri && !state.lyrics.error)) return;
    const uri = t.uri;
    state.lyrics = { uri, loading: true };
    state.lyricsAt = -1;
    state.lyricsHold = false;
    renderBody();
    const song = { track: t.title, artist: (t.artists || "").split(", ")[0], album: t.album || "", durationMs: String(t.durationMs || 0) };
    let next;
    try {
      next = { uri, data: await api(`/api/music/lyrics?${new URLSearchParams(song)}`) };
    } catch (e) {
      next = { uri, error: e.message, code: e.code };
    }
    if (state.spotify?.track?.uri !== uri) return;
    state.lyrics = next;
    renderBody();
    followLyrics(true);
  }

  /**
   * Lights up the line being sung, dims the ones before it, and keeps it in view, unless you scrolled by hand.
   * @param {boolean} [jump] Go straight there instead of scrolling smoothly, as when the lyrics first show.
   */
  function followLyrics(jump = false) {
    const box = state.panel?.querySelector(".mx-lyrics");
    const lines = state.lyrics?.data?.synced;
    if (!box || !lines || state.lyrics.uri !== state.spotify?.track?.uri) return;
    const at = spotifyAt(state.spotify) + LYRICS_LEAD_MS;
    const i = lines.findLastIndex((l) => l.ms <= at);
    if (i === state.lyricsAt && !jump) return;
    state.lyricsAt = i;
    [...box.children].forEach((b, n) => {
      b.classList.toggle("past", n < i);
      b.classList.toggle("now", n === i);
    });
    if (!state.lyricsHold) scrollToLine(Math.max(0, i), jump);
  }

  /**
   * Scrolls the lyrics so a line sits a little above the middle.
   * @param {number} i
   * @param {boolean} jump
   */
  function scrollToLine(i, jump) {
    const body = state.panel?.querySelector(".mx-body");
    const line = body?.querySelector(`.mx-ly[data-i="${i}"]`);
    if (!line) return;
    const top = body.scrollTop + line.getBoundingClientRect().top - body.getBoundingClientRect().top - body.clientHeight * 0.38;
    body.scrollTo({ top: Math.max(0, top), behavior: jump || matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  /**
   * Stops following along when you scroll the lyrics yourself, and offers to go back.
   * @param {Event} e
   */
  function onManualScroll(e) {
    if (!state.bodyKey.startsWith("lyrics:") || !e.target.closest?.(".mx-body") || state.lyricsHold) return;
    state.lyricsHold = true;
    const chip = state.panel?.querySelector(".mx-chip");
    if (chip) chip.hidden = false;
  }

  /**
   * Follows the song again after you scrolled by hand.
   */
  function lyricsNow() {
    state.lyricsHold = false;
    const chip = state.panel?.querySelector(".mx-chip");
    if (chip) chip.hidden = true;
    scrollToLine(Math.max(0, state.lyricsAt), false);
  }

  /**
   * Searches Spotify for what's typed, a moment after you stop typing. An older answer that comes late is dropped.
   * @param {string} query
   * @param {boolean} [now] Search straight away.
   */
  function searchFor(query, now = false) {
    clearTimeout(state.searchTimer);
    const q = query.trim();
    state.view.query = q;
    state.view.stack = [];
    renderNav();
    renderNow();
    if (!q) {
      state.search = null;
      return renderBody();
    }
    if (state.search?.q === q && !state.search.error) return renderBody();
    state.search = { q, loading: true };
    renderBody();
    const seq = ++state.searchSeq;
    state.searchTimer = setTimeout(async () => {
      let next;
      try {
        next = { q, results: await api(`/api/music/spotify/search?${new URLSearchParams({ q })}`) };
      } catch (e) {
        next = { q, error: e.message, code: e.code };
      }
      if (seq !== state.searchSeq) return;
      state.search = next;
      renderBody();
    }, now ? 0 : SEARCH_MS);
  }

  /**
   * Opens a list on top of what's showing.
   * @param {{ kind: string, id?: string, name: string, image?: string, uri?: string, sub?: string }} l
   */
  function openList(l) {
    state.view.stack.push(l);
    renderBody();
    renderNow();
    loadList(l);
  }

  /**
   * Goes back from an opened list.
   */
  function back() {
    state.view.stack.pop();
    renderBody();
    renderNow();
  }

  /**
   * Shows a tab: Up next, Recently played or Lyrics, or the library when it's already showing.
   * @param {"queue" | "recent" | "lyrics"} tab
   */
  function showTab(tab) {
    const same = state.view.tab === tab && !state.view.query && !state.view.stack.length;
    state.view = { tab: same ? "library" : tab, query: "", stack: [] };
    const input = state.panel?.querySelector(".mx-search input");
    if (input) input.value = "";
    renderNav();
    renderBody();
    renderNow();
    if (state.view.tab === "queue") loadQueue();
    else if (state.view.tab === "recent") loadRecent();
    else if (state.view.tab === "lyrics") loadLyrics();
    else loadLibrary();
  }

  /**
   * Opens the player on the library, as when there's nothing playing yet.
   */
  function showLibrary() {
    state.view = { tab: "library", query: state.view.query, stack: [] };
    if (!state.panel) openPanel(true);
    else renderPanel();
    state.panel?.querySelector(".mx-search input")?.focus();
  }

  /**
   * Opens the player on a search.
   * @param {string} query
   */
  function showSearch(query) {
    if (!state.panel) openPanel(true);
    const input = state.panel?.querySelector(".mx-search input");
    if (!input) return;
    input.value = query;
    searchFor(query, true);
  }

  /**
   * Puts the player just above the orb, its right edge in line with the orb's (or 8 pixels in from the window's).
   */
  function place() {
    if (!state.panel || !state.el) return;
    const r = state.el.getBoundingClientRect();
    state.panel.style.right = `${Math.max(8, innerWidth - r.right)}px`;
    state.panel.style.bottom = `${innerHeight - r.top + 8}px`;
  }

  /**
   * Opens the player above the orb.
   * @param {boolean} [keep] Keep it open when it already is.
   */
  function openPanel(keep = false) {
    if (state.panel && !keep) return closePanel();
    if (state.panel) return;
    state.panel = Object.assign(document.createElement("div"), { className: "music-panel mx", tabIndex: -1 });
    state.panel.setAttribute("role", "dialog");
    state.panel.setAttribute("aria-label", "Music player");
    place();
    state.panel.addEventListener("click", onPanelClick);
    state.panel.addEventListener("input", onPanelInput);
    state.panel.addEventListener("change", onPanelChange);
    state.panel.addEventListener("keydown", onPanelKey);
    state.panel.addEventListener("pointerdown", onPanelPointer);
    state.panel.addEventListener("scroll", onBodyScroll, { capture: true, passive: true });
    state.panel.addEventListener("wheel", onManualScroll, { passive: true });
    state.panel.addEventListener("touchmove", onManualScroll, { passive: true });
    document.body.append(state.panel);
    renderPanel();
    state.panel.focus({ preventScroll: true });
    if (!signedIn()) return;
    if (state.view.tab === "queue") loadQueue();
    else if (state.view.tab === "recent" && can("recent")) loadRecent();
    loadLibrary();
    songChanged();
  }

  /**
   * Closes the player. What it showed stays, so it opens where you left it.
   * @param {boolean} [refocus] Put the focus back on the orb.
   */
  function closePanel(refocus = false) {
    clearTimeout(state.searchTimer);
    state.panel?.remove();
    state.panel = null;
    state.nowKey = "";
    state.bodyKey = "";
    if (refocus) state.el?.querySelector(".orb")?.focus();
  }

  /**
   * The list to open or play, from a row's data.
   * @param {DOMStringMap} d
   * @returns {{ kind: string, id: string, name: string, image: string, uri: string, sub: string }}
   */
  const openFrom = (d) => ({ kind: d.kind, id: d.id, name: d.name, image: d.image, uri: d.uri, sub: d.sub });

  /** What each button in the player does, by its data-act. */
  const ACTS = {
    signin: () => signIn(),
    toggle: () => control("toggle"),
    next: () => control("next"),
    previous: () => control("previous"),
    shuffle: () => setShuffle(!state.spotify?.shuffle),
    repeat: () => setRepeat(REPEATS[(REPEATS.indexOf(state.spotify?.repeat || "off") + 1) % REPEATS.length]),
    save: toggleSaved,
    mute: () => {
      const v = volumeNow() ?? 0;
      state.muteFrom = v ? v : state.muteFrom;
      setVolume(v ? 0 : state.muteFrom || 50);
      renderNow();
    },
    "note-off": () => {
      try { localStorage.setItem(NOTE_KEY, (state.sources?.spotify?.missing || []).join(" ")); } catch {}
      redraw(state.panel.querySelector(".mx-notes"), "");
    },
    clear: () => {
      const input = state.panel.querySelector(".mx-search input");
      input.value = "";
      input.focus();
      searchFor("");
    },
    "tab-queue": () => showTab("queue"),
    "tab-recent": () => showTab("recent"),
    "tab-lyrics": () => showTab("lyrics"),
    lyric: (b) => {
      lyricsNow();
      seekTo(state.lyrics?.data?.synced?.[Number(b.dataset.i)]?.ms ?? 0);
    },
    "lyrics-now": lyricsNow,
    "retry-lyrics": () => loadLyrics(true),
    open: (b) => openList(openFrom(b.dataset)),
    "play-open": (b) => playList(openFrom(b.dataset)),
    back,
    "play-all": () => playList(state.view.stack.at(-1)),
    "play-track": (b) => playTrack(Number(b.dataset.i)),
    queue: (b) => addToQueue(b.dataset.uri),
    "retry-lib": () => loadLibrary(true),
    "retry-list": () => loadList(state.view.stack.at(-1)),
    "retry-search": () => {
      state.search = null;
      searchFor(state.view.query, true);
    },
    "retry-queue": loadQueue,
    "retry-recent": loadRecent,
  };

  /**
   * Handles a click in the player.
   * @param {MouseEvent} e
   */
  function onPanelClick(e) {
    if (e.target.closest("a[href]")) return closePanel();
    const b = e.target.closest("[data-act]");
    if (!b || b.disabled || !Object.hasOwn(ACTS, b.dataset.act)) return;
    e.stopPropagation();
    ACTS[b.dataset.act](b);
  }

  /**
   * Jumps in the song where the progress bar is pressed.
   * @param {PointerEvent} e
   */
  function onPanelPointer(e) {
    if (e.target.classList?.contains("mx-body")) onManualScroll(e);
    const rail = e.target.closest(".mx-rail");
    if (!rail || !state.spotify?.track) return;
    const r = rail.getBoundingClientRect();
    seekTo(((e.clientX - r.left) / r.width) * state.spotify.track.durationMs);
  }

  /**
   * Follows typing in the search box, and the volume slider as it moves.
   * @param {InputEvent} e
   */
  function onPanelInput(e) {
    if (e.target.matches(".mx-search input")) return searchFor(e.target.value);
    if (!e.target.matches(".mx-range")) return;
    state.sliding = true;
    e.target.style.setProperty("--fill", `${e.target.value}%`);
    if (playsHere()) setVolume(Number(e.target.value));
  }

  /**
   * Sends the volume once the slider is let go.
   * @param {Event} e
   */
  function onPanelChange(e) {
    if (!e.target.matches(".mx-range")) return;
    state.sliding = false;
    setVolume(Number(e.target.value), true);
    renderNow();
  }

  /**
   * Moves the focus to the next or previous row in the lower half.
   * @param {1 | -1} step
   */
  function moveRow(step) {
    const rows = [...state.panel.querySelectorAll(".mx-body .mx-item:not([disabled]), .mx-body .mx-ly, .mx-body [data-act='back'], .mx-body [data-act^='retry'], .mx-body [data-act='signin']")];
    if (!rows.length) return;
    const at = rows.indexOf(document.activeElement);
    rows[at < 0 ? (step > 0 ? 0 : rows.length - 1) : Math.max(0, Math.min(rows.length - 1, at + step))].focus();
  }

  /**
   * The player's keys: Space plays or pauses, ← and → jump back and on in the song (with Shift, the previous or next
   * song), ↑ and ↓ move between rows, and Escape closes the player. Typing in the search box and the volume slider
   * keep their own keys, and Space still presses a focused button.
   * @param {KeyboardEvent} e
   */
  function onPanelKey(e) {
    const t = e.target;
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      return closePanel(true);
    }
    if (!signedIn() || e.metaKey || e.ctrlKey || e.altKey) return;
    const typing = t.matches("input[type=search], input[type=text], textarea");
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (t.matches(".mx-range")) return;
      e.preventDefault();
      return moveRow(e.key === "ArrowDown" ? 1 : -1);
    }
    if (typing || t.matches(".mx-range")) return;
    if (e.key === " " && !t.matches("button, a")) {
      e.preventDefault();
      return control("toggle");
    }
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
      e.preventDefault();
      const forward = e.key === "ArrowRight";
      if (e.shiftKey) return control(forward ? "next" : "previous");
      seekTo(spotifyAt(state.spotify) + (forward ? seekStep() : -seekStep()));
    }
  }

  /**
   * Loads the next page of an opened list as you near its end.
   * @param {Event} e
   */
  function onBodyScroll(e) {
    const part = e.target;
    const open = state.view.stack.at(-1);
    if (!open || !part.classList?.contains("mx-body") || part.scrollTop + part.clientHeight < part.scrollHeight - 240) return;
    const l = state.lists.get(listKey(open));
    if (l?.tracks && l.next !== null && !l.loading && !l.error) loadList(open);
  }

  /**
   * Turns music playing in Felix down while Felix talks, and back up after. Music on another device is left alone.
   * A quick down-and-up still ends at the volume it started at.
   * @param {boolean} on
   * @returns {Promise<void>}
   */
  async function duck(on) {
    state.duck.on = on;
    state.el?.classList.toggle("ducked", on);
    const player = state.here.player;
    if (!player || !playsHere()) return;
    if (on && state.duck.volume === null) state.duck.volume = player.getVolume();
    if (state.duck.volume === null) return;
    const volume = await state.duck.volume;
    await player.setVolume(state.duck.on ? volume * DUCK_TO : volume);
    if (!state.duck.on) state.duck.volume = null;
  }

  /**
   * Loads Spotify's player script once.
   * @returns {Promise<void>}
   */
  function spotifySdk() {
    if (window.Spotify?.Player) return Promise.resolve();
    state.sdk ||= new Promise((resolve, reject) => {
      window.onSpotifyWebPlaybackSDKReady = resolve;
      const script = Object.assign(document.createElement("script"), { src: SPOTIFY_SDK, async: true });
      script.onerror = () => { state.sdk = null; reject(new Error("Couldn't load Spotify's player.")); };
      document.head.append(script);
    });
    return state.sdk;
  }

  /**
   * Says why Felix's own Spotify player can't play, and stops counting on it.
   * @param {string} message
   */
  function hereFailed(message) {
    state.here.error = message;
    state.here.deviceId = null;
    render();
  }

  /**
   * A token for Felix's own Spotify player, from the server.
   * @returns {Promise<string>}
   */
  async function hereToken() {
    try {
      return (await api("/api/music/spotify/token", {})).token;
    } catch (e) {
      hereFailed(e.message);
      throw e;
    }
  }

  /**
   * The small Spotify picture closest to 300 pixels.
   * @param {Array<{ url: string, width?: number | null }> | undefined} images
   * @returns {string | null}
   */
  const pickArt = (images = []) => (images.find((i) => (i.width ?? 0) <= 300) || images[0])?.url || null;

  /**
   * What Felix's own Spotify player is playing, in the shape the server sends.
   * @param {object} s The Web Playback SDK's state.
   * @returns {object}
   */
  function fromHere(s) {
    const t = s.track_window?.current_track;
    const track = t ? {
      id: t.id ?? null, uri: t.uri, title: t.name, artists: (t.artists || []).map((a) => a.name).join(", "), album: t.album?.name || null, art: pickArt(t.album?.images),
      durationMs: t.duration_ms || s.duration || 0, playable: true, url: null,
    } : null;
    return {
      playing: !s.paused, progressMs: s.position || 0, at: Date.now(), shuffle: Boolean(s.shuffle), repeat: REPEATS[s.repeat_mode] || "off",
      context: s.context?.uri || null, track, device: { id: state.here.deviceId, name: HERE_NAME, volume: Math.round(state.here.volume * 100), supportsVolume: true },
    };
  }

  /**
   * Keeps the bar in step with Felix's own Spotify player; when it lets go, asks the server where music went.
   * @param {object | null} s
   */
  function hereChanged(s) {
    if (!s) return pollSpotify();
    state.spotify = fromHere(s);
    if (state.spotify.playing) state.controlError = "";
    songChanged();
    render();
  }

  /**
   * Carries on music that played in Felix before the window reloaded.
   */
  function resumeHere() {
    const left = JSON.parse(sessionStorage.getItem(HERE_KEY) || "null");
    sessionStorage.removeItem(HERE_KEY);
    if (left?.playing && Date.now() - left.at < RESUME_MS) spotifyControl("transfer", { device: state.here.deviceId, play: true });
  }

  /**
   * Notes, when the window reloads or leaves Felix, whether music played in Felix, so it carries on after.
   */
  function rememberHere() {
    if (playsHere()) sessionStorage.setItem(HERE_KEY, JSON.stringify({ at: Date.now(), playing: Boolean(state.spotify?.playing) }));
  }

  /**
   * Felix's own Spotify player, listening for each thing it can say.
   * @returns {object}
   */
  function herePlayer() {
    const player = new window.Spotify.Player({ name: HERE_NAME, volume: state.here.volume, getOAuthToken: (cb) => hereToken().then(cb, () => {}) });
    const fail = (text) => () => hereFailed(text);
    player.addListener("ready", ({ device_id: id }) => {
      state.here.deviceId = id;
      state.here.error = "";
      resumeHere();
      render();
    });
    player.addListener("not_ready", () => { state.here.deviceId = null; });
    player.addListener("initialization_error", fail("This browser can't play Spotify. Open Felix in Chrome."));
    player.addListener("authentication_error", fail("Sign in to Spotify again in Settings → Music."));
    player.addListener("account_error", fail("Playing in Felix needs Spotify Premium."));
    player.addListener("playback_error", ({ message }) => { state.controlError = `Spotify couldn't play that: ${message}`; render(); });
    player.addListener("autoplay_failed", () => { state.controlError = "Press play to carry on."; render(); });
    player.addListener("player_state_changed", hereChanged);
    return player;
  }

  /**
   * Starts Felix's own Spotify player once, when Spotify is signed in and allows it.
   */
  async function startHere() {
    const s = state.sources?.spotify;
    if (state.here.player || state.here.starting || !s?.connected || s.outdated) return;
    state.here.starting = true;
    try {
      await spotifySdk();
      state.here.player = herePlayer();
      state.here.player.connect();
      setTimeout(() => { if (!state.here.deviceId && !state.here.error) hereFailed("Spotify's player in Felix didn't start. Reload the page to try again."); }, HERE_START_MS);
    } catch (e) {
      hereFailed(e.message);
    }
    state.here.starting = false;
  }

  /**
   * Handles a click on the bar: the orb opens or closes the player.
   * @param {MouseEvent} e
   */
  function onClick(e) {
    const b = e.target.closest("[data-music]");
    if (!b) return;
    e.stopPropagation();
    if (b.dataset.music === "panel") openPanel();
  }

  /**
   * Adds the player's styles to the page, once.
   */
  function addStyles() {
    if (document.querySelector('link[href="/music.css"]')) return;
    document.head.append(Object.assign(document.createElement("link"), { rel: "stylesheet", href: "/music.css" }));
  }

  /**
   * Draws the player in the bar and keeps it current.
   * @param {HTMLElement | null} el The bar's music slot.
   */
  function mount(el) {
    if (!el) return;
    state.el = el;
    addStyles();
    el.addEventListener("click", onClick);
    render();
    load();
    setInterval(tick, 1000);
    setInterval(() => { if (state.bodyKey.startsWith("lyrics:")) followLyrics(); }, LYRICS_EVERY_MS);
    // Settings → Music saves in another page of this window; a change there (like turning lyrics off) shows here.
    addEventListener("storage", (e) => { if (e.key === FelixShell.SETTINGS_CACHE && state.panel) { state.nowKey = ""; renderPanel(); } });
    document.addEventListener("click", (e) => { if (state.panel && !state.panel.contains(e.target) && e.target.isConnected) closePanel(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.panel) closePanel(); });
    document.addEventListener("visibilitychange", pollSpotify);
    addEventListener("pagehide", rememberHere);
    addEventListener("resize", place);
  }

  return { mount, reload: load, close: closePanel, signIn, command, duck };
})();
