/**
 * Felix's ears and voice, both on this Mac and free. Hearing: the recording from the page is turned into
 * 16 kHz WAV by ffmpeg and written out as text by whisper.cpp. Speaking: Kokoro, kept running in a small Python
 * worker (voice/kokoro_worker.py), turns each sentence into a WAV; the Mac's own `say` stands in when Kokoro
 * isn't set up or fails. No audio leaves the Mac, and recordings are deleted as soon as they're read.
 */
import { execFile as nodeExecFile, spawn as nodeSpawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const HEAR_MS = 30_000;
const SPEAK_MS = 30_000;
const IDLE_MS = 15 * 60_000;
const RETRY_MS = 60_000;
const TEXT_MAX = 600;
const AUDIO_TYPES = { "audio/webm": "webm", "audio/ogg": "ogg", "audio/mp4": "m4a", "audio/wav": "wav" };
const VOCABULARY = "Felix, fm, bm, PR, PRs, Datadog, on call, merge, review, Spotify, Claude, Cursor, Jira, Slack.";
const NOISE = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;
const SAY_WORDS_PER_MINUTE = 185;
const PROMPT_CHARS = 600;
// The Mac's novelty voices (singing, whispering, robots), left out of the voice list.
const NOVELTY = new Set(["Albert", "Bad News", "Bahh", "Bells", "Boing", "Bubbles", "Cellos", "Good News", "Jester", "Organ", "Superstar", "Trinoids", "Whisper", "Wobble", "Zarvox", "Fred", "Junior", "Ralph", "Kathy"]);

/**
 * The Mac's English voices from `say -v '?'`, without the novelty ones: each one's name and language.
 * @param {string} out What `say -v '?'` printed.
 * @returns {Array<{ name: string, lang: string }>}
 */
export function macVoicesIn(out) {
  return String(out).split("\n").map((l) => /^(.+?)\s{2,}(en_[A-Z]{2})\s+#/.exec(l)).filter(Boolean)
    .map((m) => ({ name: m[1].trim(), lang: m[2] })).filter((v) => !NOVELTY.has(v.name.replace(/ \(.+\)$/, "")));
}

/**
 * Runs a program and returns what it printed.
 * @param {typeof nodeExecFile} execFileImpl
 * @param {string} bin
 * @param {string[]} args
 * @param {number} timeout
 * @returns {Promise<string>}
 */
function run(execFileImpl, bin, args, timeout) {
  return new Promise((resolve, reject) => {
    execFileImpl(bin, args, { timeout, maxBuffer: 1 << 20 }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim().split("\n").pop() || "It failed."));
      else resolve(String(stdout));
    });
  });
}

/**
 * Runs a job in a fresh temporary folder, removed afterwards.
 * @template T
 * @param {(dir: string) => Promise<T>} job
 * @returns {Promise<T>}
 */
async function inTempDir(job) {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-voice-"));
  try {
    return await job(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * What whisper.cpp heard, without its noise notes like "[BLANK_AUDIO]" or "(wind blowing)".
 * @param {string} raw
 * @returns {string}
 */
export const heardText = (raw) => raw.replace(NOISE, " ").replace(/\s+/g, " ").trim();

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * A number said one digit at a time, the way you asked PR and ticket numbers to be read: 12293 as "1 2 2 9 3".
 * @param {string} digits
 * @returns {string}
 */
export const oneByOne = (digits) => digits.split("").join(" ");

/**
 * A 24-hour time the way people say it: "22:00" as "10 PM", "09:30" as "9:30 AM".
 * @param {string} hour
 * @param {string} minute
 * @returns {string}
 */
function clockTime(hour, minute) {
  const h = Number(hour);
  return `${h % 12 || 12}${minute === "00" ? "" : `:${minute}`} ${h < 12 ? "AM" : "PM"}`;
}

/**
 * Text as it should be read aloud: "fm#12247" as "F M 1 2 2 4 7" and "PMHUB-32975" as "PMHUB 3 2 9 7 5" (one digit
 * at a time), "PRs" as "P Rs", "22:00" as "10 PM", "2026-10-29" as "October 29", and no links, markdown or dots
 * between chips. Words from your dictionary are said the way it says ("PMHUB" as "P M hub").
 * @param {string} text
 * @param {Array<{ word: string, sayAs: string }>} [sayAs]
 * @returns {string}
 */
export function speakable(text, sayAs = []) {
  // Ticket numbers, like PR numbers, are read one digit at a time ("PMHUB 3 2 9 7 5"), before Names and words
  // change how the key itself is said.
  const keyed = String(text).replace(/\b([A-Z][A-Z0-9]{1,9})-(\d{1,7})\b/g, (_, key, n) => `${key} ${oneByOne(n)}`);
  const said = sayAs.reduce((t, { word, sayAs: as }) => t.replace(new RegExp(`\\b${word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi"), as), keyed);
  return said
    .replace(/https?:\/\/\S+/g, "")
    .replace(/`+|\*\*|__/g, "").replace(/(^|\n)\s*(?:[-*•]|\d+[.)])\s+/g, "$1")
    .replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (whole, _y, m, d) => (MONTHS[Number(m) - 1] ? `${MONTHS[Number(m) - 1]} ${Number(d)}` : whole))
    .replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b(?!\s*[ap]\.?m)/gi, (_, h, m) => clockTime(h, m))
    .replace(/\b(fm|bm)\s?#?\s?(\d+)/gi, (_, repo, n) => `${repo.toUpperCase().split("").join(" ")} ${oneByOne(n)}`)
    .replace(/\bPRs\b/g, "P Rs").replace(/\bPR\b/g, "P R").replace(/\bIC\b/g, "I C").replace(/\bAI\b/g, "A I")
    .replace(/\s·\s/g, ", ").replace(/#/g, " number ").replace(/\s+/g, " ").trim().slice(0, TEXT_MAX);
}

/**
 * What whisper is told to expect: Felix's name when it isn't Felix, the words from your dictionary (team names, ticket
 * keys, terms), then the usual ones, kept short, since whisper only reads the start of a long prompt.
 * @param {string} name
 * @param {string[]} words
 * @returns {string}
 */
export function promptFor(name, words = []) {
  const own = [name && name !== "Felix" ? name : "", ...words].filter(Boolean).join(", ");
  return (own ? `${own}, ${VOCABULARY}` : VOCABULARY).slice(0, PROMPT_CHARS);
}

/**
 * Felix's ears: whisper.cpp over a recording from the page.
 * @param {{ whisperBin: string, modelFile: string, ffmpegBin: string, execFileImpl?: typeof nodeExecFile }} options
 */
export function createEars({ whisperBin, modelFile, ffmpegBin, execFileImpl = nodeExecFile }) {
  /**
   * Whether whisper.cpp and its model are installed.
   * @returns {boolean}
   */
  const ready = () => existsSync(whisperBin) && existsSync(modelFile) && existsSync(ffmpegBin);

  /**
   * What was said in a recording.
   * @param {Buffer} audio
   * @param {string} type The recording's MIME type, like "audio/webm;codecs=opus".
   * @param {string} [name] Felix's name when it isn't Felix, so whisper expects to hear it.
   * @returns {Promise<string>}
   * @throws {Error} when hearing isn't set up, the type isn't known, or a step fails.
   */
  async function hear(audio, type, name = "", words = []) {
    const ext = AUDIO_TYPES[String(type).split(";")[0]];
    if (!ext) throw Object.assign(new Error("That isn't a recording Felix can read."), { status: 400 });
    if (!ready()) throw Object.assign(new Error("Talking isn't set up yet. Run ./prs voice."), { status: 503 });
    return inTempDir(async (dir) => {
      // Named apart from the output, since a WAV recording would otherwise be both ffmpeg's input and its output.
      const input = path.join(dir, `rec.${ext}`);
      const wav = path.join(dir, "in.wav");
      await writeFile(input, audio);
      await run(execFileImpl, ffmpegBin, ["-loglevel", "error", "-y", "-i", input, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav], HEAR_MS);
      const out = await run(execFileImpl, whisperBin, ["-m", modelFile, "-f", wav, "-l", "en", "-nt", "-np", "--prompt", promptFor(name, words)], HEAR_MS);
      return heardText(out);
    });
  }

  return { ready, hear };
}

/**
 * @typedef {{ resolve: (reply: { ok?: boolean, error?: string, voices?: string[] }) => void, timer: ReturnType<typeof setTimeout> }} Waiting
 */

/**
 * Felix's voice: Kokoro in a warm worker, with the Mac's `say` as the backup. The worker ends after a quiet
 * spell to free its memory, and after it fails to start, Kokoro isn't tried again for a minute, so a model still
 * downloading doesn't slow every sentence.
 * @param {{ python: string, script: string, modelFile: string, voicesFile: string, sayBin?: string,
 *   spawnImpl?: typeof nodeSpawn, execFileImpl?: typeof nodeExecFile, speakMs?: number, idleMs?: number,
 *   retryMs?: number, now?: () => number }} options
 */
export function createVoice({ python, script, modelFile, voicesFile, sayBin = "/usr/bin/say", spawnImpl = nodeSpawn,
  execFileImpl = nodeExecFile, speakMs = SPEAK_MS, idleMs = IDLE_MS, retryMs = RETRY_MS, now = Date.now }) {
  /** @type {{ proc: import("node:child_process").ChildProcess, buffer: string, ready: Promise<boolean>, started: boolean } | null} */
  let worker = null;
  /** @type {Map<number, Waiting>} */
  const waiting = new Map();
  let nextId = 1;
  let failedAt = -Infinity;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let idleTimer;

  /**
   * Whether Kokoro and its files are installed.
   * @returns {boolean}
   */
  const kokoroReady = () => [python, script, modelFile, voicesFile].every((f) => existsSync(f));

  /**
   * Ends the worker; anything still waiting gets the reason.
   * @param {string} reason
   */
  function stop(reason) {
    clearTimeout(idleTimer);
    if (!worker) return;
    const { proc } = worker;
    worker = null;
    for (const [id, w] of waiting) {
      clearTimeout(w.timer);
      w.resolve({ error: reason });
      waiting.delete(id);
    }
    proc.kill();
  }

  /**
   * Reads one line the worker wrote.
   * @param {string} line
   * @param {(ok: boolean) => void} onReady
   */
  function onLine(line, onReady) {
    let reply;
    try {
      reply = JSON.parse(line);
    } catch {
      return;
    }
    if (reply.ready) return onReady(true);
    const w = waiting.get(reply.id);
    if (!w) return;
    clearTimeout(w.timer);
    waiting.delete(reply.id);
    w.resolve(reply);
  }

  /**
   * Starts the worker, or returns the running one, once Kokoro has loaded.
   * @returns {Promise<boolean>} False when it couldn't start.
   */
  function start() {
    if (worker) return worker.ready;
    if (now() - failedAt < retryMs) return Promise.resolve(false);
    const proc = spawnImpl(python, [script, modelFile, voicesFile], { stdio: ["pipe", "pipe", "ignore"] });
    /** @type {(ok: boolean) => void} */
    let onReady = () => {};
    const ready = new Promise((resolve) => { onReady = resolve; });
    const me = { proc, buffer: "", ready, started: false };
    worker = me;
    const started = (ok) => {
      me.started ||= ok;
      onReady(ok);
    };
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk) => {
      me.buffer += chunk;
      const lines = me.buffer.split("\n");
      me.buffer = lines.pop() || "";
      for (const line of lines) if (line.trim()) onLine(line, started);
    });
    const gone = (reason) => {
      if (!me.started) failedAt = now();
      onReady(false);
      if (worker === me) stop(reason);
    };
    proc.on("error", (err) => gone(`Kokoro couldn't start: ${err.message}`));
    proc.on("exit", () => gone("Kokoro stopped"));
    return ready;
  }

  /**
   * Sends the worker one request.
   * @param {object} request
   * @returns {Promise<{ ok?: boolean, error?: string, voices?: string[] }>}
   */
  async function ask(request) {
    if (!kokoroReady()) return { error: "Kokoro isn't set up" };
    if (!(await start()) || !worker) return { error: "Kokoro couldn't start" };
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => stop("Kokoro rested"), idleMs);
    idleTimer.unref?.();
    const id = nextId++;
    const proc = worker.proc;
    return new Promise((resolve) => {
      const timer = setTimeout(() => stop("Kokoro took too long"), speakMs);
      waiting.set(id, { resolve, timer });
      proc.stdin?.write(`${JSON.stringify({ ...request, id })}\n`);
    });
  }

  /**
   * Speaks with the Mac's own voice into a WAV.
   * @param {string} text
   * @param {number} speed
   * @param {string} file
   * @returns {Promise<void>}
   */
  const sayInto = (text, speed, file, macVoice = "") => run(execFileImpl, sayBin,
    [...(macVoice ? ["-v", macVoice] : []), "-r", String(Math.round(SAY_WORDS_PER_MINUTE * speed)), "-o", file, "--file-format=WAVE", "--data-format=LEI16@22050", text], speakMs).then(() => {});

  /**
   * A sentence read aloud, as WAV audio.
   * @param {string} text
   * @param {{ voice?: string, speed?: number, engine?: "kokoro" | "mac", macVoice?: string, sayAs?: Array<{ word: string, sayAs: string }> }} [options]
   *   `engine` "mac" speaks with the Mac's own voice `macVoice` instead of Kokoro.
   * @returns {Promise<{ audio: Buffer, engine: "kokoro" | "say" }>}
   */
  async function speak(text, { voice = "am_michael", speed = 1, engine = "kokoro", macVoice = "", sayAs = [] } = {}) {
    const said = speakable(text, sayAs);
    if (!said) throw Object.assign(new Error("Nothing to say."), { status: 400 });
    return inTempDir(async (dir) => {
      const file = path.join(dir, "out.wav");
      if (engine === "mac") {
        await sayInto(said, speed, file, macVoice);
        return { audio: await readFile(file), engine: "say" };
      }
      const reply = await ask({ text: said, voice, speed, out: file });
      if (reply.ok) return { audio: await readFile(file), engine: "kokoro" };
      await sayInto(said, speed, file);
      return { audio: await readFile(file), engine: "say" };
    });
  }

  /**
   * The Kokoro voices installed, or none when Kokoro isn't set up. Read once, then kept.
   * @returns {Promise<string[]>}
   */
  async function voices() {
    // The list doesn't change, so once known it's kept: opening Settings again doesn't start Kokoro just for it.
    if (known.length) return known;
    const reply = await ask({ voices: true });
    known = reply.voices || [];
    return known;
  }
  /** @type {string[]} The Kokoro voices, once read. */
  let known = [];

  /**
   * A phrase's sounds (phonemes), for a device that makes Felix's voice itself from them: an iPad's own way of
   * working them out gets stuck, so the Mac's does it. Quick, and it doesn't need the model.
   * @param {string} text Already shaped for speaking (`speakable`).
   * @param {string} [voice]
   * @returns {Promise<string>}
   */
  async function phonemes(text, voice = "am_michael") {
    const reply = await ask({ phonemize: text, voice });
    if (reply.error || typeof reply.phonemes !== "string") throw new Error(reply.error || "Kokoro gave no sounds.");
    return reply.phonemes;
  }

  /**
   * The Mac's own English voices, for the voice list in Settings.
   * @returns {Promise<Array<{ name: string, lang: string }>>}
   */
  const macVoices = () => run(execFileImpl, sayBin, ["-v", "?"], speakMs).then(macVoicesIn, () => []);

  return {
    speak,
    voices,
    macVoices,
    ready: kokoroReady,
    /** Loads Kokoro ahead of the first sentence. */
    warm: () => { if (kokoroReady()) ask({ warm: true }).catch(() => {}); },
    phonemes,
    /** Ends the worker. */
    close: () => stop("Felix closed"),
  };
}
