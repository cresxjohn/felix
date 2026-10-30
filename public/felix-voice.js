/**
 * Felix's ears and voice in the page. Listening records the microphone until you stop talking, then the server's
 * whisper.cpp writes out what was said. Speaking reads a reply one sentence at a time, fetching the next while the
 * current one plays, and turns the music down meanwhile. Felix lives in the lasting outer page; a page inside it
 * uses the outer page's voice.
 */
window.FelixVoice = (window.frameElement?.classList.contains("felix-page") && window.parent.FelixVoice) || (() => {
  const TYPES = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"];
  const TICK_MS = 50;
  const FLOOR_MS = 300;
  const SILENCE_MS = 1200;
  const WAIT_MS = 7000;
  const MAX_MS = 20_000;
  // While you talk, what you've said so far is worked out about this often, for your words to show as you go.
  const PARTIAL_MS = 1100;
  // Each guess works out the whole recording so far, so it gets slower as you go: guesses wait at least twice as
  // long as the last one took, and stop after this long (the full transcript still comes at the end).
  const PARTIAL_MAX_MS = 30_000;
  const LEVEL_MIN = 0.012;
  const LEVEL_MAX = 0.04;
  const OVER_FLOOR = 2.5;
  const LONG_SENTENCE = 60;
  const SHORT_PHRASE = 18;
  const FIRST_PHRASE = 32;
  const FIRST_MIN = 8;
  const JOINING_WORD = /\s(?=(and|but|so|from|on|with|for|to|in|at|because|which|that|while|until|after|before)\s)/i;
  const AHEAD = 3;
  // The most text one piece read aloud grows to while it waits its turn.
  const CHUNK_MAX = 220;
  // How loud he keeps talking, from 0 to 1, while it's worked out whether you're cutting in.
  const DUCK_TO = 0.2;
  // How long after the window opens the device voice warms up, leaving the page's own start alone.
  const DEVICE_WARM_MS = 4000;
  // A twentieth of a second of silence, as a WAV, for unlocking the player on an iPad.
  const SILENCE = "data:audio/wav;base64,UklGRkQDAABXQVZFZm10IBAAAAABAAEAQB8AAIA+AAACABAAZGF0YSADAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
  const CLIPS_KEEP = 30;
  const FADE_MS = 150;
  const WAKE_COOLDOWN_MS = 700;
  const WAKE_RETRY_MS = 4000;
  const WAKE_CHUNK = 2048;
  // Hands the page the microphone's sound in chunks of about 40 ms, for the clip cutter in /felix-wake-clips.mjs.
  const WAKE_WORKLET = `class FelixChunks extends AudioWorkletProcessor {
    constructor() { super(); this.buf = new Float32Array(${WAKE_CHUNK}); this.n = 0; }
    process(inputs) {
      const ch = inputs[0] && inputs[0][0];
      if (ch) for (let i = 0; i < ch.length; i++) {
        this.buf[this.n++] = ch[i];
        if (this.n === this.buf.length) { this.port.postMessage(this.buf.slice()); this.n = 0; }
      }
      return true;
    }
  }
  registerProcessor("felix-chunks", FelixChunks);`;
  const OFFLINE = "Can't reach the local server. Start it with ./prs start.";

  const state = {
    /** @type {MediaRecorder | null} */ rec: null,
    discard: false,
    /** @type {HTMLAudioElement | null} */ audio: null,
    /** @type {(() => void) | null} */ endPlay: null,
    /** @type {(() => void) | null} */ wake: null,
    turn: 0,
    /** A listen was stopped while its microphone was still opening. */ cancel: false,
    /** The microphone has opened in this window before, so cutting in may use it. */ micOk: false,
  };
  /** Progress lines already made into audio, by voice, speed and text, so a line said again plays at once. */
  const clips = new Map();

  /**
   * Whether this browser can record here: it needs a microphone API, a recorder, and a secure page
   * (localhost, or the tailnet https address).
   * @returns {boolean}
   */
  /** @type {Set<(e: { level?: number, saying?: string | null, wake?: string }) => void>} */
  const watchers = new Set();

  /**
   * Tells whoever's watching (the bottom bar) the microphone's level while it records, and the phrase Felix is
   * saying while he talks (null once he stops), so his face and the bar can move with the voice, and how listening
   * for the wake phrase is going, for the top bar's pill.
   * @param {{ level?: number, saying?: string | null, wake?: string }} e
   */
  const tell = (e) => watchers.forEach((fn) => { try { fn(e); } catch {} });

  /**
   * Starts watching the voice; returns how to stop.
   * @param {(e: { level?: number, saying?: string | null, wake?: string }) => void} fn
   * @returns {() => void}
   */
  const watch = (fn) => {
    watchers.add(fn);
    return () => watchers.delete(fn);
  };

  const supported = () => Boolean(window.isSecureContext && navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  /**
   * How the microphone opens: with echo cancelling, so Felix's own voice is taken out, on the microphone picked in
   * Settings when it's still there.
   * @returns {MediaTrackConstraints}
   */
  function micConstraints() {
    const id = window.FelixShell?.cachedSettings?.()?.felixMic;
    return { echoCancellation: true, noiseSuppression: true, autoGainControl: true, ...(id ? { deviceId: { ideal: id } } : {}) };
  }

  /**
   * A plain reason the microphone couldn't start.
   * @param {Error} e
   * @returns {string}
   */
  function micProblem(e) {
    if (e.name === "NotAllowedError") return "I can't hear you yet: allow the microphone for this page (the icon in the address bar), then try again.";
    if (e.name === "NotFoundError") return "I can't find a microphone. Plug one in, then try again.";
    return `The microphone didn't start: ${e.message}`;
  }

  /**
   * How loud the microphone is right now, from 0 to 1.
   * @param {AnalyserNode} analyser
   * @param {Float32Array} samples
   * @returns {number}
   */
  function levelOf(analyser, samples) {
    analyser.getFloatTimeDomainData(samples);
    let sum = 0;
    for (const v of samples) sum += v * v;
    return Math.sqrt(sum / samples.length);
  }

  /**
   * Watches the microphone's level: it learns the room's quiet from the first moment, then stops the recording a
   * little after you finish talking, when nothing is said for a while, or when it runs too long.
   * @param {AnalyserNode} analyser
   * @param {() => void} stop
   * @param {number} [waitMs] How long to wait for you to start talking.
   * @param {number} [silenceMs] How long a pause ends what you're saying.
   * @param {number} [maxMs] The longest one recording runs.
   * @returns {{ timer: ReturnType<typeof setInterval>, heard: () => boolean }}
   */
  function watchSilence(analyser, stop, waitMs = WAIT_MS, silenceMs = SILENCE_MS, maxMs = MAX_MS) {
    const samples = new Float32Array(analyser.fftSize);
    const started = performance.now();
    let floor = 0;
    let heard = false;
    let lastLoud = started;
    const timer = setInterval(() => {
      const t = performance.now();
      const level = levelOf(analyser, samples);
      tell({ level: Math.min(1, level / LEVEL_MAX) });
      if (t - started < FLOOR_MS) {
        floor = Math.max(floor, level);
        return;
      }
      if (level > Math.min(LEVEL_MAX, Math.max(LEVEL_MIN, floor * OVER_FLOOR))) {
        heard = true;
        lastLoud = t;
      }
      if ((heard && t - lastLoud > silenceMs) || (!heard && t - started > waitMs) || t - started > maxMs) stop();
    }, TICK_MS);
    return { timer, heard: () => heard };
  }

  /**
   * Records until you stop talking, or until stopListening. With nothing said for `waitMs`, it stops on its own.
   * `silenceMs` is how long a pause ends what you're saying, `maxMs` the longest it runs, and `keepSpeaking` lets
   * Felix go on talking meanwhile. `onPartial` gets what you've said so far, about every second while you talk.
   * @param {{ waitMs?: number, silenceMs?: number, maxMs?: number, keepSpeaking?: boolean, onPartial?: (text: string) => void }} [opts]
   * @returns {Promise<{ blob: Blob, heard: boolean }>} `heard` is false when nothing was said, or it was cancelled.
   * @throws {Error} when the microphone can't start.
   */
  async function listen({ waitMs = WAIT_MS, silenceMs = SILENCE_MS, maxMs = MAX_MS, keepSpeaking = false, onPartial } = {}) {
    if (!keepSpeaking) stopSpeaking();
    state.cancel = false;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() })
      .catch((e) => { throw new Error(micProblem(e)); });
    state.micOk = true;
    // Stopped while the microphone was still opening: it closes again, and nothing was said.
    if (state.cancel) {
      stream.getTracks().forEach((t) => t.stop());
      return { blob: new Blob(), heard: false };
    }
    const type = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || "";
    const rec = new MediaRecorder(stream, type ? { mimeType: type } : {});
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    const ctx = new AudioContext();
    const analyser = Object.assign(ctx.createAnalyser(), { fftSize: 1024 });
    ctx.createMediaStreamSource(stream).connect(analyser);
    const watch = watchSilence(analyser, () => { if (rec.state === "recording") rec.stop(); }, waitMs, silenceMs, maxMs);
    state.rec = rec;
    state.discard = false;
    // Your words so far: the recording up to now, worked out one at a time, never after it stops.
    let guessing = false;
    let nextGuess = 0;
    const began = performance.now();
    const partials = onPartial ? setInterval(async () => {
      const t = performance.now();
      if (guessing || t < nextGuess || t - began > PARTIAL_MAX_MS || !watch.heard() || !chunks.length || rec.state !== "recording") return;
      guessing = true;
      try {
        const text = await hear(new Blob(chunks, { type: rec.mimeType || type }));
        if (rec.state === "recording") onPartial(text);
      } catch {
        // A guess that fails just waits for the next one.
      } finally {
        guessing = false;
        nextGuess = performance.now() + 2 * (performance.now() - t);
      }
    }, PARTIAL_MS) : 0;
    return new Promise((resolve) => {
      rec.onstop = () => {
        clearInterval(partials);
        clearInterval(watch.timer);
        tell({ level: 0 });
        stream.getTracks().forEach((t) => t.stop());
        ctx.close();
        state.rec = null;
        resolve({ blob: new Blob(chunks, { type: rec.mimeType || type }), heard: watch.heard() && !state.discard });
      };
      rec.start(250);
    });
  }

  /**
   * Stops recording now.
   * @param {boolean} [keep] Keep what was said (true), or drop it as if nothing was.
   */
  function stopListening(keep = true) {
    if (!state.rec || state.rec.state !== "recording") {
      state.cancel = true;
      return;
    }
    state.discard = !keep;
    state.rec.stop();
  }

  /**
   * Sends JSON to a Felix route.
   * @param {string} url
   * @param {object} body
   * @returns {Promise<Response>}
   */
  async function post(url, body) {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
      .catch(() => { throw new Error(OFFLINE); });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `The server answered ${res.status}.`);
    return res;
  }

  /**
   * A recording as base64, for sending as JSON.
   * @param {Blob} blob
   * @returns {Promise<string>}
   */
  function toBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
      reader.onerror = () => reject(new Error("Couldn't read the recording."));
      reader.readAsDataURL(blob);
    });
  }

  /**
   * What was said in a recording, written out on this Mac.
   * @param {Blob} blob
   * @returns {Promise<string>} Empty when nothing could be made out.
   */
  async function hear(blob) {
    const res = await post("/api/felix/hear", { audio: await toBase64(blob), type: blob.type });
    return String((await res.json()).text || "");
  }

  /**
   * Whether hearing is set up on the server, and which engine speaks.
   * @returns {Promise<{ hear: boolean, speak: string }>}
   */
  async function status() {
    const res = await fetch("/api/felix/voice").catch(() => { throw new Error(OFFLINE); });
    return res.json();
  }

  /**
   * A long sentence cut at its commas, semicolons and dashes, since Kokoro takes about as long to make a piece
   * as it takes to play, so a short first piece starts Felix talking sooner. Pieces too short to sound natural
   * join the one before.
   * @param {string} sentence
   * @returns {string[]}
   */
  function phrases(sentence) {
    if (sentence.length <= LONG_SENTENCE) return [sentence];
    return sentence.split(/(?<=[,;:—–])\s+|\s+(?=[—–])/).reduce((out, piece) => {
      if (out.length && (piece.length < SHORT_PHRASE || out.at(-1).length < SHORT_PHRASE)) out[out.length - 1] += ` ${piece}`;
      else out.push(piece);
      return out;
    }, []);
  }

  /**
   * A reply cut into sentences, and long ones into phrases, so the first can play while the rest are made. A
   * dot inside a number or a name doesn't end a sentence; only one followed by a space does.
   * @param {string} text
   * @returns {string[]}
   */
  const sentences = (text) => String(text).split(/(?<=[.!?]["')\]]*)\s+|\n+/).map((s) => s.trim()).filter(Boolean).flatMap(phrases);

  /**
   * One sentence read aloud, as audio.
   * @param {string} text
   * @returns {Promise<Blob>}
   */
  function fetchAudio(text) {
    const audio = onDevice() ? fromDevice(text).catch(() => fromMac(text)) : fromMac(text);
    audio.catch(() => {});
    return audio;
  }

  /**
   * One sentence made on the Mac.
   * @param {string} text
   * @returns {Promise<Blob>}
   */
  const fromMac = (text) => post("/api/felix/speak", { text }).then((res) => res.blob());

  /**
   * One sentence made on this device: the Mac shapes its words (Names and words, PR numbers, dates) and works out
   * their sounds, and Kokoro on this device's graphics chip says them.
   * @param {string} text
   * @returns {Promise<Blob>}
   */
  async function fromDevice(text) {
    const device = window.FelixVoiceDevice;
    if (device?.ready() !== true) throw new Error("This device's voice isn't downloaded.");
    const prefs = window.FelixShell?.cachedSettings?.() || {};
    return (await device.speak(text, { voice: String(prefs.felixVoice || ""), speed: Number(prefs.felixSpeed) || 1 })).blob;
  }

  /**
   * Whether this device makes Felix's voice, as Settings say: Auto once its copy is downloaded, This device always
   * (the Mac stands in when it can't), never with The Mac or the Mac's own voices.
   * @returns {boolean}
   */
  function onDevice() {
    const prefs = window.FelixShell?.cachedSettings?.() || {};
    const where = prefs.felixVoiceWhere || "auto";
    if (!window.FelixVoiceDevice || where === "mac" || prefs.felixVoiceEngine === "mac" || window.FelixVoiceDevice.stuck()) return false;
    // Auto trusts the device only once it has made a phrase this session (the warm-up at launch), so a slow or broken
    // first start never holds up a reply; until then the Mac makes it.
    return where === "device" || (window.FelixVoiceDevice.ready() === true && window.FelixVoiceDevice.proven());
  }

  /**
   * A progress line read aloud, made once and kept, since the same few lines come back often. A failed one isn't
   * kept, so it's tried again next time.
   * @param {string} text
   * @returns {Promise<Blob>}
   */
  function clip(text) {
    const prefs = window.FelixShell?.cachedSettings?.() || {};
    const key = [onDevice(), prefs.felixVoiceEngine, prefs.felixVoice, prefs.felixMacVoice, prefs.felixSpeed, prefs.felixWords, text].join("|");
    if (!clips.has(key)) {
      const audio = fetchAudio(text);
      audio.catch(() => clips.delete(key));
      clips.set(key, audio);
      if (clips.size > CLIPS_KEEP) clips.delete(clips.keys().next().value);
    }
    return clips.get(key);
  }

  /**
   * Fades out the audio playing now over a moment, then ends it.
   * @param {HTMLAudioElement | null} audio
   * @returns {Promise<void>}
   */
  function fadeOut(audio) {
    return new Promise((resolve) => {
      if (!audio || state.audio !== audio) return resolve();
      const start = performance.now();
      const from = audio.volume;
      const step = () => {
        const left = 1 - (performance.now() - start) / FADE_MS;
        if (left <= 0 || state.audio !== audio) {
          if (state.audio === audio) {
            audio.pause();
            state.endPlay?.();
          }
          return resolve();
        }
        audio.volume = Math.max(0, from * left);
        setTimeout(step, 16);
      };
      step();
    });
  }

  /**
   * Plays a sentence, until it ends or speaking is stopped. Every sentence plays through the page's one player,
   * which your first tap or key press unlocked (see `unlock`): an iPad only lets a page make sound from a player that
   * started during a tap, and a sentence is ready only later.
   * @param {Blob} blob
   * @returns {Promise<void>}
   */
  function play(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const audio = player;
      let over = false;
      const done = () => {
        if (over) return;
        over = true;
        audio.onended = null;
        audio.onerror = null;
        URL.revokeObjectURL(url);
        if (state.endPlay === done) {
          state.audio = null;
          state.endPlay = null;
        }
        resolve();
      };
      audio.onended = done;
      audio.onerror = done;
      // Still turned down for you cutting in, the next phrase starts quiet too.
      audio.volume = barge.ducked ? DUCK_TO : 1;
      audio.src = url;
      state.audio = audio;
      state.endPlay = done;
      audio.play().catch(done);
    });
  }

  /** The page's one audio player for Felix's voice. */
  const player = new Audio();
  player.preload = "auto";
  let unlocked = false;

  /**
   * Plays a moment of silence on the page's player during a tap or key press, once: an iPad then lets that player
   * make sound later, when a reply is ready, which it otherwise blocks without a word.
   */
  function unlock() {
    if (unlocked || state.audio) return;
    player.src = SILENCE;
    player.play()?.then(() => {
      unlocked = true;
      player.pause();
    }, () => {});
  }

  /**
   * Where a long first phrase can be cut: after its first comma or dash, or else before a joining word like
   * "from" or "and", a few words in.
   * @param {string} head
   * @returns {number} The cut's position, or -1 when there's none.
   */
  function firstCut(head) {
    const mark = head.slice(FIRST_MIN).search(/[,;:—–]\s/);
    if (mark >= 0) return FIRST_MIN + mark + 1;
    const word = head.slice(SHORT_PHRASE, FIRST_PHRASE + SHORT_PHRASE).search(JOINING_WORD);
    return word >= 0 ? SHORT_PHRASE + word : -1;
  }

  /**
   * The first phrase of a reply cut short when it's long, so Felix starts talking sooner.
   * @param {string[]} parts
   * @returns {string[]}
   */
  function quickStart(parts) {
    const [head, ...rest] = parts;
    if (!head || head.length <= FIRST_PHRASE) return parts;
    const at = firstCut(head);
    if (at < 0) return parts;
    return [head.slice(0, at).trim(), head.slice(at).trim(), ...rest];
  }

  /**
   * Text with its spacing evened out, to tell whether a finished reply starts with what was already read.
   * @param {string} text
   * @returns {string}
   */
  const even = (text) => String(text).replace(/\s+/g, " ").trim();

  /**
   * Reads a reply aloud while it's still arriving. Each piece added is cut into phrases, made into audio as soon
   * as it comes (a couple ahead of the one playing), and played in order with the music turned down. Before any
   * of the reply has come, `say` speaks a progress line ("Hold on, checking GitHub"); the reply's first phrase
   * fades it out.
   * @returns {{ add: (text: string) => void, end: (text: string) => Promise<boolean>, say: (line: string) => Promise<void> }}
   *   end gets the whole reply, reads whatever of it wasn't added yet, and resolves true when it was read to the end.
   */
  function begin() {
    stopSpeaking();
    const turn = ++state.turn;
    const live = () => turn === state.turn;
    const parts = [];
    let given = "";
    let closed = false;
    let playing = 0;
    let done = null;
    /** @type {{ audio: HTMLAudioElement | null, done: Promise<void> } | null} The progress line being said. */
    let aside = null;

    // Kokoro makes one piece at a time, so one is asked for at a time: while it's made, text that comes in joins
    // the next piece instead of queueing as many small ones (each has its own start-up cost).
    let making = false;
    const request = (i) => {
      making = true;
      parts[i].audio = fetchAudio(parts[i].text);
      parts[i].audio.catch(() => null).finally(() => {
        making = false;
        fetchAhead();
      });
    };
    const fetchAhead = () => {
      if (making || !live()) return;
      const next = parts.findIndex((p, i) => i >= playing && !p.audio);
      if (next >= 0 && next < playing + AHEAD) request(next);
    };
    const add = (text) => {
      if (!live() || closed || !even(text)) return;
      given += ` ${text}`;
      const next = sentences(text);
      for (const piece of parts.length ? next : quickStart(next)) {
        const last = parts.at(-1);
        // The first piece stays short so he starts talking soon; later ones grow while they wait their turn.
        if (last && parts.length > 1 && !last.audio && last.text.length + piece.length < CHUNK_MAX) last.text += ` ${piece}`;
        else parts.push({ text: piece, audio: null });
      }
      fetchAhead();
      state.wake?.();
    };
    const waitForMore = () => new Promise((resolve) => { state.wake = resolve; });
    const quiet = () => live() && !closed && !parts.length;
    const say = async (line) => {
      if (!quiet() || aside) return;
      const blob = await clip(line).catch(() => null);
      if (!blob || !quiet() || aside) return;
      window.FelixMusic?.duck?.(true);
      tell({ saying: line });
      const done = play(blob);
      aside = { audio: state.audio, done };
      await done;
      aside = null;
      if (!quiet()) return;
      window.FelixMusic?.duck?.(false);
      tell({ saying: null });
    };
    const run = async () => {
      while (live()) {
        if (playing >= parts.length) {
          if (closed) return playing > 0;
          await waitForMore();
          continue;
        }
        fetchAhead();
        // Its turn has come: asked for now if it wasn't yet.
        if (!parts[playing].audio) request(playing);
        const blob = await parts[playing].audio.catch(() => null);
        if (!live()) return false;
        if (aside) {
          const cut = aside;
          await fadeOut(cut.audio);
          await cut.done;
        }
        if (blob) {
          window.FelixMusic?.duck?.(true);
          tell({ saying: parts[playing].text });
          barge.saying = parts[playing].text;
          bargeStart();
          await play(blob);
        }
        playing++;
      }
      return false;
    };
    const finished = run().finally(() => {
      bargeStop();
      if (!live()) return;
      window.FelixMusic?.duck?.(false);
      tell({ saying: null });
    });
    const end = (text) => {
      const said = even(given);
      const whole = even(text);
      if (!said) add(whole);
      else if (whole.startsWith(said)) add(whole.slice(said.length));
      closed = true;
      state.wake?.();
      done ||= finished;
      return done;
    };
    return { add, end, say };
  }

  /**
   * Reads a whole reply aloud, a phrase at a time, with the music turned down.
   * @param {string} text
   * @returns {Promise<boolean>} True when it was read to the end, false when stopped or it failed.
   */
  const speak = (text) => begin().end(text);

  /**
   * Stops reading aloud, and brings the music back up.
   */
  function stopSpeaking() {
    bargeStop();
    state.turn++;
    state.audio?.pause();
    state.endPlay?.();
    state.wake?.();
    state.wake = null;
    window.FelixMusic?.duck?.(false);
    tell({ saying: null });
  }

  /**
   * Listening for the wake phrase. While it's on and the window is in view, the microphone stays open and its sound
   * goes through the clip cutter; each clip of speech is sent to the server's whisper only, which answers with
   * whether it starts with the phrase and nothing else. It pauses while Felix talks (and a moment after), while the
   * mic button records, while `paused` says so, and while the window is hidden, when the microphone closes. With
   * two Felix windows in view, the one used last listens.
   */
  const wake = {
    on: false,
    status: "off",
    /** @type {{ sensitivity: string, paused: () => boolean, onWake: (rest: string) => void } | null} */ opts: null,
    /** @type {{ stream: MediaStream, ctx: AudioContext, mic: string, sensitivity: string, clipper: { push: Function, reset: Function } } | null} */ live: null,
    opening: false,
    sending: false,
    /** @type {Uint8Array | null} */ queued: null,
    quietUntil: 0,
    yielded: false,
    /** @type {ReturnType<typeof setTimeout> | undefined} The next try while the server's restarting. */ retry: undefined,
    /** A blocked microphone gets one more try on a click or key press. */ retriedBlocked: false,
    id: Math.random().toString(36).slice(2),
    channel: "BroadcastChannel" in window ? new BroadcastChannel("felix-wake") : null,
  };

  /**
   * Tells the top bar's pill (and anyone watching) how listening for the phrase is going: "off", "listening",
   * "starting", "blocked" (no microphone permission), "nomic", "setup" (hearing isn't set up), "elsewhere" (another
   * Felix window listens) or "hidden".
   * @param {string} status
   */
  function wakeStatus(status) {
    if (wake.status === status) return;
    wake.status = status;
    tell({ wake: status });
  }

  /**
   * Closes the microphone and drops any clip in progress.
   */
  function wakeClose() {
    const live = wake.live;
    wake.live = null;
    wake.queued = null;
    live?.stream.getTracks().forEach((t) => t.stop());
    live?.ctx.close().catch(() => {});
  }

  /**
   * Opens the microphone for the phrase, with the clip cutter on its sound.
   * @returns {Promise<void>}
   */
  async function wakeOpen() {
    /** @type {MediaStream | undefined} */ let stream;
    /** @type {AudioContext | undefined} */ let ctx;
    wake.opening = true;
    wakeStatus("starting");
    try {
      // Felix restarting (the server's down for a moment): try again shortly, rather than give up on voice.
      const ready = await status().catch(() => null);
      if (!ready) {
        clearTimeout(wake.retry);
        wake.retry = setTimeout(wakeSync, WAKE_RETRY_MS);
        return;
      }
      if (!ready.hear) return wakeStatus("setup");
      const kit = await import("/felix-wake-clips.mjs");
      const constraints = micConstraints();
      stream = await navigator.mediaDevices.getUserMedia({ audio: constraints });
      state.micOk = true;
      if (!wantWake()) {
        stream.getTracks().forEach((t) => t.stop());
        return wakeSync();
      }
      ctx = new AudioContext();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WAKE_WORKLET], { type: "text/javascript" })));
      const node = new AudioWorkletNode(ctx, "felix-chunks");
      ctx.createMediaStreamSource(stream).connect(node);
      const sensitivity = wake.opts?.sensitivity || "normal";
      const clipper = kit.createClipper({ rate: ctx.sampleRate, sensitivity, onClip: sendWakeClip });
      wake.live = { stream, ctx, mic: String(constraints.deviceId?.ideal || ""), sensitivity, clipper };
      node.port.onmessage = (e) => onWakeChunk(e.data);
      wake.channel?.postMessage({ claim: wake.id });
      wake.retriedBlocked = false;
      wakeStatus("listening");
    } catch (e) {
      // Whatever opened before the failure closes again, so a retry doesn't leave a second microphone on.
      stream?.getTracks().forEach((t) => t.stop());
      ctx?.close().catch(() => {});
      wakeStatus(e?.name === "NotAllowedError" || e?.name === "SecurityError" ? "blocked" : "nomic");
    } finally {
      wake.opening = false;
    }
  }

  /**
   * Whether the microphone should be open for the phrase right now.
   * @returns {boolean}
   */
  const wantWake = () => wake.on && !document.hidden && !wake.yielded && supported();

  /**
   * Opens or closes the microphone to match: on, in view, and not left to another window. A changed microphone
   * or sensitivity opens it again with the new one.
   */
  function wakeSync() {
    if (!wantWake()) {
      wakeClose();
      return wakeStatus(!wake.on ? "off" : wake.yielded ? "elsewhere" : document.hidden ? "hidden" : "nomic");
    }
    const live = wake.live;
    // Chrome may start the sound suspended until the window gets a click; any later call (the pill's) wakes it.
    if (live?.ctx.state === "suspended") live.ctx.resume().catch(() => {});
    const mic = String(micConstraints().deviceId?.ideal || "");
    if (live && (live.mic !== mic || live.sensitivity !== (wake.opts?.sensitivity || "normal"))) wakeClose();
    if (!wake.live && !wake.opening && !["blocked", "setup"].includes(wake.status)) wakeOpen();
  }

  /**
   * Takes one chunk of the microphone's sound: cut into clips, unless Felix is talking, the mic button is
   * recording, or Felix is busy, when it's thrown away.
   * @param {Float32Array} samples
   */
  function onWakeChunk(samples) {
    const live = wake.live;
    if (!live) return;
    const now = performance.now();
    if (state.audio) wake.quietUntil = now + WAKE_COOLDOWN_MS;
    // While Felix talks, the open microphone listens for you cutting in instead.
    if (state.audio && barge.shared) barge.clipper?.push(samples);
    if (state.audio || state.rec || now < wake.quietUntil || wake.opts?.paused()) return live.clipper.reset();
    live.clipper.push(samples);
  }

  /**
   * Sends a clip of speech to whisper on this Mac, asking only whether it starts with the phrase. One clip goes
   * at a time; the newest one waiting goes next. When the phrase came alone and you went on talking, the clip
   * after it is your question.
   * @param {Uint8Array} wav
   * @returns {Promise<void>}
   */
  async function sendWakeClip(wav) {
    if (wake.sending) {
      wake.queued = wav;
      return;
    }
    wake.sending = true;
    try {
      const audio = await toBase64(new Blob([wav], { type: "audio/wav" }));
      const reply = await (await post("/api/felix/hear", { audio, type: "audio/wav", wake: true })).json();
      if (!reply.woke || !wake.live) return;
      const next = wake.queued;
      wake.queued = null;
      const rest = reply.rest || (next ? await hear(new Blob([next], { type: "audio/wav" })).catch(() => "") : "");
      wake.opts?.onWake(String(rest || ""));
    } catch {
      // A clip that couldn't be heard is just dropped; the next one is tried as usual.
    } finally {
      wake.sending = false;
      const next = wake.queued;
      wake.queued = null;
      if (next && wake.live) sendWakeClip(next);
    }
  }

  /**
   * Starts listening for the phrase, or takes new settings while it listens.
   * @param {{ sensitivity: string, paused: () => boolean, onWake: (rest: string) => void }} opts
   */
  function wakeStart(opts) {
    // Only turning it on, or a new sensitivity, tries a blocked or unset microphone again: the regular resync every
    // half minute mustn't ask Safari for the microphone again and again.
    const fresh = !wake.on || wake.opts?.sensitivity !== opts?.sensitivity;
    wake.on = true;
    wake.opts = opts;
    if (fresh && (wake.status === "blocked" || wake.status === "setup")) wake.status = "starting";
    wakeSync();
  }

  /**
   * Stops listening for the phrase and closes the microphone.
   */
  function wakeStop() {
    wake.on = false;
    wake.channel?.postMessage({ release: wake.id });
    wakeSync();
  }

  /**
   * A soft two-note chime, to say Felix heard his name and is listening.
   * @returns {Promise<void>}
   */
  async function chime() {
    const own = !wake.live;
    const ctx = wake.live?.ctx || new AudioContext();
    await ctx.resume().catch(() => {});
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    const t = ctx.currentTime;
    gain.gain.setValueAtTime(0, t);
    [[660, 0], [880, 0.12]].forEach(([hz, at]) => {
      const tone = ctx.createOscillator();
      tone.type = "sine";
      tone.frequency.value = hz;
      tone.connect(gain);
      gain.gain.linearRampToValueAtTime(0.08, t + at + 0.02);
      gain.gain.linearRampToValueAtTime(0, t + at + 0.11);
      tone.start(t + at);
      tone.stop(t + at + 0.12);
    });
    await new Promise((resolve) => setTimeout(resolve, 260));
    if (own) ctx.close().catch(() => {});
  }

  document.addEventListener("visibilitychange", () => {
    // Coming into view makes this the window that listens; going out of view hands it to another one in view.
    if (!document.hidden && wake.on) wake.channel?.postMessage({ claim: wake.id });
    if (document.hidden) wake.channel?.postMessage({ release: wake.id });
    if (!document.hidden) wake.yielded = false;
    // Back in view, voice that wasn't set up is checked again (./prs voice may have run meanwhile).
    if (!document.hidden && wake.status === "setup") wake.status = "";
    wakeSync();
  });
  /**
   * A click or key press anywhere in Felix's window, this page or a page in its frame: wakes sound the browser
   * started suspended, and gives a microphone Safari blocked (until you touched the window) one more try.
   */
  function poke() {
    unlock();
    if (wake.live?.ctx.state === "suspended") wake.live.ctx.resume().catch(() => {});
    if (wake.status === "blocked" && !wake.retriedBlocked && wantWake()) {
      wake.retriedBlocked = true;
      wake.status = "";
      wakeSync();
    }
  }
  for (const type of ["pointerdown", "keydown"]) addEventListener(type, poke, { capture: true });
  // In Felix's window (not a page inside it), the device voice warms up soon after it opens, so the first reply
  // doesn't wait on the graphics chip's slow first phrase.
  if (window === window.top) {
    setTimeout(() => {
      const prefs = window.FelixShell?.cachedSettings?.() || {};
      const where = prefs.felixVoiceWhere || "auto";
      const kokoro = prefs.felixVoiceEngine !== "mac" && where !== "mac" && !window.FelixVoiceDevice?.stuck();
      if (prefs.felixOn !== false && prefs.felixTalk !== "never" && kokoro) window.FelixVoiceDevice?.warm().catch(() => {});
    }, DEVICE_WARM_MS);
  }
  addEventListener("focus", () => {
    if (!wake.on || !wake.yielded) return;
    wake.yielded = false;
    wake.channel?.postMessage({ claim: wake.id });
    wakeSync();
  });
  if (wake.channel) {
    wake.channel.onmessage = (e) => {
      if (e.data?.claim && e.data.claim !== wake.id && wake.on) {
        wake.yielded = true;
        wakeSync();
      }
      if (e.data?.release && e.data.release !== wake.id && wake.yielded) {
        wake.yielded = false;
        wakeSync();
      }
    };
  }

  /**
   * Cutting in while Felix talks (barge-in). While a reply plays, the microphone listens with a higher bar for
   * speech (his own voice is taken out by echo cancelling); each bit of speech goes to whisper on this Mac, which
   * says only whether to ignore it (his own voice, a cough), stop, or stop and take it as your next question. It uses
   * the wake phrase's microphone when that's open, and otherwise opens one only if this page may already use it.
   */
  const barge = {
    on: false,
    shared: false,
    saying: "",
    sending: false,
    /** His voice is turned down while it's worked out whether you're cutting in. */ ducked: false,
    /** @type {{ push: (s: Float32Array) => void } | null} */ clipper: null,
    /** @type {{ stream: MediaStream, ctx: AudioContext } | null} */ own: null,
    /** @type {((rest: string) => void) | null} */ onAsk: null,
  };

  /**
   * Whether cutting in is on in Settings, and the page may already use the microphone (it never asks while he talks).
   * @returns {Promise<boolean>}
   */
  async function mayBarge() {
    if (window.FelixShell?.cachedSettings?.()?.felixBargeIn === false || !supported()) return false;
    // A microphone already opened in this window answers it: Safari may still call a session's grant "prompt".
    if (wake.live || state.micOk) return true;
    const status = await navigator.permissions?.query({ name: "microphone" }).catch(() => null);
    return status?.state === "granted";
  }

  /**
   * Starts listening for you cutting in, once per reply.
   * @returns {Promise<void>}
   */
  async function bargeStart() {
    if (barge.on) return;
    barge.on = true;
    if (!(await mayBarge()) || !barge.on) return;
    const kit = await import("/felix-wake-clips.mjs");
    const onClip = (wav) => { sendBarge(wav); };
    // The moment you start talking over him, his voice drops, so you're heard; it comes back if it was nothing.
    const hooks = { onClip, onStart: () => duck(true), onDrop: () => { if (!barge.sending) duck(false); } };
    if (wake.live) {
      barge.shared = true;
      barge.clipper = kit.createClipper({ rate: wake.live.ctx.sampleRate, sensitivity: "low", minMs: 300, quietMs: 500, ...hooks });
      return;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      const ctx = new AudioContext();
      await ctx.audioWorklet.addModule(URL.createObjectURL(new Blob([WAKE_WORKLET], { type: "text/javascript" })));
      const node = new AudioWorkletNode(ctx, "felix-chunks");
      ctx.createMediaStreamSource(stream).connect(node);
      if (!barge.on) {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        return;
      }
      barge.own = { stream, ctx };
      barge.clipper = kit.createClipper({ rate: ctx.sampleRate, sensitivity: "low", minMs: 300, quietMs: 500, ...hooks });
      node.port.onmessage = (e) => { if (state.audio) barge.clipper?.push(e.data); };
    } catch {
      // No microphone right now: Felix just can't be cut off by voice; Stop talking still works.
    }
  }

  /**
   * Stops listening for you cutting in, and closes the microphone it opened.
   */
  function bargeStop() {
    barge.on = false;
    barge.ducked = false;
    barge.shared = false;
    barge.clipper = null;
    const own = barge.own;
    barge.own = null;
    own?.stream.getTracks().forEach((t) => t.stop());
    own?.ctx.close().catch(() => {});
  }

  /**
   * Sends speech heard while Felix talks to whisper, and stops him when it's you cutting in.
   * @param {Uint8Array} wav
   * @returns {Promise<void>}
   */
  async function sendBarge(wav) {
    if (barge.sending || !state.audio) return;
    barge.sending = true;
    let stopped = false;
    try {
      const audio = await toBase64(new Blob([wav], { type: "audio/wav" }));
      const reply = await (await post("/api/felix/hear", { audio, type: "audio/wav", barge: true, saying: barge.saying })).json();
      if (reply.action === "stop" || reply.action === "ask") {
        stopped = true;
        stopSpeaking();
      }
      if (reply.action === "ask" && reply.rest) barge.onAsk?.(String(reply.rest));
    } catch {
      // A clip that couldn't be heard doesn't stop him.
    } finally {
      barge.sending = false;
      if (!stopped) duck(false);
    }
  }

  /**
   * Turns his voice down while you might be cutting in, or back up.
   * @param {boolean} down
   */
  function duck(down) {
    barge.ducked = down;
    if (state.audio) state.audio.volume = down ? DUCK_TO : 1;
  }

  return {
    /** What to do with a question you said while cutting in. @param {(rest: string) => void} fn */
    onBarge: (fn) => { barge.onAsk = fn; },
    supported,
    listen,
    stopListening,
    listening: () => Boolean(state.rec),
    hear,
    status,
    sentences,
    begin,
    speak,
    stopSpeaking,
    speaking: () => Boolean(state.audio),
    watch,
    wakeStart,
    wakeStop,
    wakeState: () => wake.status,
    poke,
    chime,
    /** Plays audio made elsewhere (a test line) through the page's unlocked player. @param {Blob} blob */
    playBlob: play,
  };
})();
