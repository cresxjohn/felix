// Felix's voice made on this device, like the iPad: Kokoro running in the browser on this device's graphics chip,
// so the Mac doesn't have to make the speech. Its files are downloaded once into the caches Kokoro reads, from the
// Mac first (over your own network) and from the internet when the Mac can't hand them over. Settings shows how
// that's going, downloads, removes, and plays a test line.
// A page inside Felix's window (Settings, say) uses the window's own copy rather than loading a second model: two
// copies of the voice at once can be more than an iPad lets one app hold, and it closes the app.
window.FelixVoiceDevice = (window !== window.top && (() => { try { return window.top.FelixVoiceDevice; } catch { return null; } })()) || (() => {
  const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
  const HF = `https://huggingface.co/${MODEL_ID}/resolve/main/`;
  const ORT = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/";
  /** The model in each size: the full one for a graphics chip, half-size for one with 16-bit maths, compact without. */
  const MODELS = Object.freeze({
    fp32: { file: "onnx/model.onnx", mb: 326 },
    fp16: { file: "onnx/model_fp16.onnx", mb: 163 },
    q8: { file: "onnx/model_quantized.onnx", mb: 92 },
  });
  const COMMON = ["config.json", "tokenizer.json", "tokenizer_config.json"];
  /** Felix's voices: Kokoro's American male ones, as in Settings. */
  const VOICES = ["am_michael", "am_fenrir", "am_puck", "am_adam", "am_echo", "am_eric", "am_liam", "am_onyx", "am_santa"];
  const ORT_FILES = ["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"];
  // The caches Kokoro reads its model (transformers-cache) and voices (kokoro-voices) from, keyed by their internet
  // address, and Felix's own for the runtime's WebAssembly.
  const CACHE_MODEL = "transformers-cache";
  const CACHE_VOICES = "kokoro-voices";
  const CACHE_RUNTIME = "felix-voice-runtime";
  // How often a test line that's still going tells the Mac which step it's on.
  const STILL_MS = 20_000;
  // The longest one phrase may take to make here before this device's voice counts as stuck for the session.
  const SPEAK_MAX_MS = 20_000;
  // The first phrase, which also warms the graphics chip up, gets longer.
  const FIRST_MAX_MS = 120_000;
  const STUCK_KEY = "felix:voice-stuck-2";
  // Set while the voice loads and makes its first line, cleared once it has: still there when the app opens again
  // means loading it closed the app.
  const LOADING_KEY = "felix:voice-loading";

  /**
   * @typedef {{ name: string, cache: string, key: string, mac: string, type: string }} VoiceFile
   * @typedef {{ webgpu: boolean, f16: boolean, variant: keyof typeof MODELS, device: "webgpu" | "wasm", mb: number }} Plan
   * @typedef {{ running: boolean, file: string, from: "" | "mac" | "internet", got: number, total: number, done: number,
   *   count: number, error: string | null }} Job
   */

  /**
   * The files one size needs: where Kokoro looks for each, and where the Mac hands it out.
   * @param {keyof typeof MODELS} variant
   * @returns {VoiceFile[]}
   */
  const filesFor = (variant) => [
    ...[...COMMON, MODELS[variant].file].map((f) => ({ name: f, cache: CACHE_MODEL, key: HF + f, mac: `/voice-web/hf/${f}`, type: f.endsWith(".json") ? "application/json" : "application/octet-stream" })),
    ...VOICES.map((v) => ({ name: `voices/${v}.bin`, cache: CACHE_VOICES, key: `${HF}voices/${v}.bin`, mac: `/voice-web/hf/voices/${v}.bin`, type: "application/octet-stream" })),
    ...ORT_FILES.map((f) => ({ name: f, cache: CACHE_RUNTIME, key: ORT + f, mac: `/voice-web/ort/${f}`, type: f.endsWith(".mjs") ? "text/javascript" : "application/wasm" })),
  ];

  /** @type {Promise<Plan> | null} */
  let planned = null;

  /**
   * What this device can run: on a graphics chip (WebGPU) the full or half-size model, otherwise the compact one on
   * the processor, which is much slower.
   * @returns {Promise<Plan>}
   */
  function detect() {
    planned ||= (async () => {
      if (override) return { webgpu: override.device === "webgpu", f16: override.variant === "fp16", ...override, mb: MODELS[override.variant].mb, gpu: "" };
      const adapter = await navigator.gpu?.requestAdapter().catch(() => null);
      if (!adapter) return { webgpu: false, f16: false, variant: "q8", device: "wasm", mb: MODELS.q8.mb };
      const f16 = adapter.features.has("shader-f16");
      const variant = f16 ? "fp16" : "fp32";
      const gpu = [adapter.info?.vendor, adapter.info?.architecture, adapter.info?.description].filter(Boolean).join(" ");
      return { webgpu: true, f16, variant, device: "webgpu", mb: MODELS[variant].mb, gpu };
    })().then((plan) => { planNow = plan; return plan; });
    return planned;
  }

  /** The plan once known, for the quick checks that can't wait. @type {Plan | null} */
  let planNow = null;
  /** A model size and processor forced from outside (the voice lab), instead of what this device picks. */
  let override = null;

  /**
   * Which of this device's files are downloaded already.
   * @returns {Promise<{ plan: Plan, have: number, count: number, ready: boolean, missing: VoiceFile[] }>}
   */
  async function status() {
    const plan = await detect();
    const list = filesFor(plan.variant);
    const missing = [];
    for (const f of list) {
      const hit = await caches.open(f.cache).then((c) => c.match(f.key)).catch(() => null);
      if (!hit) missing.push(f);
    }
    readyNow = !missing.length;
    return { plan, have: list.length - missing.length, count: list.length, ready: !missing.length, missing };
  }

  /** Whether this device's copy was complete when last looked at: null until it has been. @type {boolean | null} */
  let readyNow = null;

  /** @type {Job | null} */
  let job = null;
  /** @type {Set<(job: Job) => void>} */
  const watchers = new Set();
  const tell = () => watchers.forEach((fn) => { try { fn({ ...job }); } catch {} });

  /**
   * Gets one file: from the Mac, or from the internet when the Mac can't hand it over, and keeps it where Kokoro
   * looks for it.
   * @param {VoiceFile} f
   * @returns {Promise<void>}
   */
  async function fetchOne(f) {
    try {
      const res = await fetch(f.mac, { cache: "no-store" });
      if (!res.ok) throw new Error(`the Mac answered ${res.status}`);
      job.from = "mac";
      await keep(f, res);
    } catch {
      job.from = "internet";
      job.got = 0;
      tell();
      const res = await fetch(f.key, { cache: "no-store" });
      if (!res.ok) throw new Error(`${f.name}: the internet answered ${res.status}`);
      await keep(f, res);
    }
  }

  /**
   * Saves a download where Kokoro looks for it, straight to storage as it arrives, counting it on the way: a file
   * held whole in memory first (163 MB for the model) can be more than an iPad lets the app hold. One that came
   * short is removed again.
   * @param {VoiceFile} f
   * @param {Response} res
   * @returns {Promise<void>}
   */
  async function keep(f, res) {
    // A compressed answer gives its compressed size, but arrives unpacked: then only a short one counts as broken.
    const total = res.headers.get("content-encoding") ? 0 : Number(res.headers.get("content-length")) || 0;
    let got = 0;
    Object.assign(job, { got, total });
    tell();
    const counted = res.body.pipeThrough(new TransformStream({
      transform(chunk, out) {
        got += chunk.length;
        job.got = got;
        tell();
        out.enqueue(chunk);
      },
    }));
    const cache = await caches.open(f.cache);
    const headers = { "Content-Type": f.type, ...(total ? { "Content-Length": String(total) } : {}) };
    await cache.put(f.key, new Response(counted, { headers }));
    if (total && got < total) {
      await cache.delete(f.key);
      throw new Error(`${f.name} came short: ${got} of ${total} bytes`);
    }
  }

  /**
   * Downloads whatever this device is still missing, one file at a time. Asking again while it runs gives the same
   * download. It asks the browser to keep the files, so they aren't cleared to make room.
   * @returns {Promise<void>}
   */
  async function download() {
    if (job?.running) return job.promise;
    const { missing } = await status();
    job = { running: true, file: "", from: "", got: 0, total: 0, done: 0, count: missing.length, error: null };
    job.promise = (async () => {
      await navigator.storage?.persist?.().catch(() => false);
      for (const f of missing) {
        Object.assign(job, { file: f.name, got: 0, total: 0 });
        tell();
        await fetchOne(f);
        job.done += 1;
        tell();
      }
    })().catch((e) => { job.error = e.message; }).finally(async () => {
      job.running = false;
      job.file = "";
      await status().catch(() => {});
      tell();
    });
    tell();
    return job.promise;
  }

  /**
   * Removes this device's copy of the voice files, and forgets the loaded voice.
   * @returns {Promise<void>}
   */
  async function remove() {
    tts = null;
    proven = false;
    readyNow = false;
    const keys = Object.values(MODELS).flatMap((m) => [...COMMON, m.file]).map((f) => HF + f);
    const model = await caches.open(CACHE_MODEL);
    await Promise.all(keys.map((k) => model.delete(k)));
    await Promise.all([caches.delete(CACHE_VOICES), caches.delete(CACHE_RUNTIME)]);
  }

  /** @type {any} Kokoro once loaded. */
  let tts = null;
  /** @type {Promise<any> | null} */
  let loading = null;

  /**
   * Loads Kokoro from this device's files: the runtime's WebAssembly from Felix's cache, the model and voices from
   * Kokoro's own.
   * @returns {Promise<any>}
   */
  function load() {
    if (tts) return Promise.resolve(tts);
    loading ||= (async () => {
      const plan = await detect();
      step("Loading Kokoro's code");
      const { KokoroTTS, env } = await import("/vendor/kokoro.web.js");
      step("Preparing the runtime");
      const runtime = await caches.open(CACHE_RUNTIME);
      const blobUrl = async (f) => {
        const hit = await runtime.match(ORT + f);
        return hit ? URL.createObjectURL(new Blob([await hit.arrayBuffer()], { type: f.endsWith(".mjs") ? "text/javascript" : "application/wasm" })) : `/voice-web/ort/${f}`;
      };
      env.wasmPaths = { mjs: await blobUrl(ORT_FILES[0]), wasm: await blobUrl(ORT_FILES[1]) };
      step(plan.webgpu ? "Loading the model onto the graphics chip" : "Loading the model");
      // Noted before the risky part: if loading the model closes the app, the next launch knows (see `crashed`).
      try { localStorage.setItem(LOADING_KEY, plan.variant); } catch {}
      tts = await KokoroTTS.from_pretrained(MODEL_ID, { dtype: plan.variant, device: plan.device });
      step("");
      return tts;
    })().catch((e) => {
      // An error isn't a crash: the note that loading is under way goes.
      try { localStorage.removeItem(LOADING_KEY); } catch {}
      report({ failed: now.name, error: String(e?.message || e) });
      step("");
      throw e;
    }).finally(() => { loading = null; });
    return loading;
  }

  /** The step loading or making is on, and when it started, for Settings to show while a test line runs. */
  const now = { name: "", at: 0 };
  /** How long each step took, for the report to the Mac. @type {Array<{ step: string, ms: number }>} */
  let steps = [];

  /**
   * Moves on to the next step, noting how long the last one took.
   * @param {string} name "" when done.
   */
  function step(name) {
    const t = performance.now();
    if (now.name) steps.push({ step: now.name, ms: Math.round(t - now.at) });
    Object.assign(now, { name, at: t });
  }

  /**
   * Tells the Mac how a load or test line went on this device, so a slow or stuck step can be found without
   * looking at the device: each step's time, the device and its graphics chip, and any error.
   * @param {Record<string, unknown>} extra
   */
  function report(extra) {
    detect().then((plan) => fetch("/api/voice-web/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ steps, plan, agent: navigator.userAgent, isolated: Boolean(window.crossOriginIsolated), ...extra }),
    })).catch(() => {});
  }

  /** Phrases made so far: the graphics chip makes one at a time, so each waits for the one before. */
  let queue = Promise.resolve();

  /**
   * One phrase read aloud, made on this device, after any already asked for, from its sounds as the Mac works them
   * out.
   * @param {string} text
   * @param {{ voice?: string, speed?: number, phonemes?: string }} [options] `phonemes`: the sounds, when already known.
   * @returns {Promise<{ blob: Blob, seconds: number }>}
   */
  function speak(text, { voice = "am_michael", speed = 1, phonemes = "" } = {}) {
    if (stuckAt) return Promise.reject(new Error("This device's voice got stuck; the Mac is making it."));
    // The phrase's sounds come from the Mac (asked for now, while an earlier phrase may still be being made): Kokoro's
    // own way of working them out gets stuck on an iPad, so only the model runs here.
    const sounds = phonemes ? Promise.resolve(phonemes) : soundsOf(text);
    sounds.catch(() => {});
    const made = queue.then(async () => {
      const kokoro = await load();
      const options = { voice: VOICES.includes(voice) ? voice : "am_michael", speed };
      const making = kokoro.generate_from_ids(kokoro.tokenizer(await sounds, { truncation: true }).input_ids, options);
      // A browser whose graphics chip never finishes (Safari, for some setups) would hold every reply: after a
      // while it's given up on for this session, and the Mac makes the voice instead.
      // The first phrase also warms the graphics chip up, which can take much longer than the rest.
      let timer;
      const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stuck")), proven ? SPEAK_MAX_MS : FIRST_MAX_MS); });
      try {
        const audio = await Promise.race([making, late]);
        proven = true;
        try { localStorage.removeItem(LOADING_KEY); } catch {}
        return { blob: audio.toBlob(), seconds: audio.audio.length / audio.sampling_rate };
      } catch (e) {
        if (e.message === "stuck") {
          stuckAt = Date.now();
          // Remembered on this device, so the next launch doesn't wait on it again; Settings can try again.
          markStuck("stuck");
          report({ stuck: true, text: text.slice(0, 80) });
          throw new Error("This device's voice got stuck; the Mac is making it.");
        }
        throw e;
      } finally {
        clearTimeout(timer);
      }
    });
    queue = made.catch(() => {});
    return made;
  }

  /**
   * A phrase's sounds (phonemes), worked out on the Mac, with its words shaped first (Names and words, numbers).
   * @param {string} text
   * @returns {Promise<string>}
   */
  async function soundsOf(text) {
    const res = await fetch("/api/felix/speakable", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, phonemes: true }),
    });
    if (!res.ok) throw new Error(`The Mac couldn't work out the sounds (${res.status}).`);
    const { phonemes } = await res.json();
    if (!phonemes) throw new Error("Nothing to say.");
    return phonemes;
  }

  /** When this device's voice got stuck making a phrase, so the Mac makes the rest; 0 while it works. */
  let stuckAt = 0;
  /** This device has made a phrase this session, so it's warm and can be trusted with a reply. */
  let proven = false;

  /**
   * The model size this device's voice got stuck with, and why ("stuck": a phrase never finished; "crashed": loading
   * it closed the app), if it did on an earlier launch.
   * @returns {{ variant: string, why: "stuck" | "crashed" } | null}
   */
  const storedStuck = () => {
    try {
      const raw = localStorage.getItem(STUCK_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };

  /**
   * Remembers on this device that its voice doesn't work here, so the next launch doesn't try it again (and, after a
   * crash, doesn't close the app again); Settings can try again.
   * @param {"stuck" | "crashed"} why
   * @param {string} [variant]
   */
  function markStuck(why, variant = planNow?.variant || "") {
    try {
      localStorage.setItem(STUCK_KEY, JSON.stringify({ variant, why }));
      localStorage.removeItem(LOADING_KEY);
    } catch {}
  }

  /**
   * Gets the voice ready ahead of the first reply, when this device's copy is downloaded: loads it and makes one
   * short throwaway phrase, since the first one on a graphics chip is always slow.
   * @returns {Promise<void>}
   */
  async function warm() {
    if (!(await status()).ready || tts) return;
    await speak("Hi.").catch(() => {});
  }

  /**
   * Makes a test line and says how long that took against how long it plays.
   * @param {string} text
   * @param {{ voice?: string, speed?: number }} [options]
   * @returns {Promise<{ blob: Blob, madeMs: number, playsMs: number, firstLoadMs: number }>}
   */
  async function test(text, options) {
    steps = [];
    const t0 = performance.now();
    // A step that never ends still reaches the Mac: every 20 seconds it says which one it's on.
    const given = Boolean(options?.phonemes);
    const still = setInterval(() => { if (now.name) report({ stillOn: now.name, forMs: Math.round(performance.now() - now.at), given }); }, STILL_MS);
    try {
      return await testing(text, options, t0);
    } finally {
      clearInterval(still);
    }
  }

  /**
   * The test line itself: load, then make one line.
   * @param {string} text
   * @param {{ voice?: string, speed?: number }} options
   * @param {number} t0 When the test started.
   * @returns {Promise<{ blob: Blob, madeMs: number, playsMs: number, firstLoadMs: number }>}
   */
  async function testing(text, options, t0) {
    await load();
    const t1 = performance.now();
    step("Making the line");
    try {
      const { blob, seconds } = await speak(text, options);
      step("");
      const result = { blob, madeMs: performance.now() - t1, playsMs: seconds * 1000, firstLoadMs: t1 - t0 };
      report({ madeMs: Math.round(result.madeMs), playsMs: Math.round(result.playsMs), given: Boolean(options?.phonemes) });
      return result;
    } catch (e) {
      report({ failed: now.name, error: String(e?.message || e) });
      step("");
      throw e;
    }
  }

  // Loading the voice last time never finished: it closed the app. Not tried again until Settings says so, and the
  // Mac hears of it.
  try {
    const crashed = localStorage.getItem(LOADING_KEY);
    if (crashed) {
      localStorage.removeItem(LOADING_KEY);
      markStuck("crashed", crashed);
      report({ crashed: true, variant: crashed });
    }
  } catch {}

  return {
    detect,
    status,
    download,
    remove,
    load,
    speak,
    test,
    /** How a download is going, as it changes. @param {(job: Job) => void} fn @returns {() => void} */
    watch: (fn) => { watchers.add(fn); return () => watchers.delete(fn); },
    job: () => (job ? { ...job } : null),
    /** Whether this device's copy was complete when last looked at (null before that). */
    ready: () => readyNow,
    /** Whether this device's voice got stuck this session, so the Mac makes it. */
    stuck: () => stuckAt > 0 || (Boolean(planNow) && storedStuck()?.variant === planNow.variant),
    /** Why this device's voice isn't used: "stuck" or "crashed", or null while it's fine. */
    stuckWhy: () => (stuckAt > 0 ? "stuck" : planNow && storedStuck()?.variant === planNow.variant ? storedStuck().why : null),
    /** Whether this device has made a phrase this session (warmed up and working). */
    proven: () => proven,
    /** Forgets that this device's voice got stuck, to try it again. */
    unstick: () => {
      stuckAt = 0;
      try {
        localStorage.removeItem(STUCK_KEY);
        localStorage.removeItem(LOADING_KEY);
      } catch {}
    },
    /** Forces a model size and processor, for trying setups (the voice lab). @param {{ variant: keyof typeof MODELS, device: "webgpu" | "wasm" }} o */
    configure: (o) => {
      override = o;
      planned = null;
      planNow = null;
    },
    warm,
    /** The step a load or test line is on, and for how long, or null between them. */
    step: () => (now.name ? { name: now.name, ms: performance.now() - now.at } : null),
    /** The files one size needs, as the Mac names them ("hf/config.json"). @param {keyof typeof MODELS} variant */
    macNames: (variant) => filesFor(variant).map((f) => f.mac.slice("/voice-web/".length)),
    MODELS,
  };
})();

// Whether this device has its copy is known from the start, so Auto can use it for the very first reply.
window.FelixVoiceDevice.status().catch(() => {});
