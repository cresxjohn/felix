/**
 * Felix's voice for other devices, like the iPad: the files Kokoro needs to run in a browser, kept on this Mac and
 * handed out from here, so a device downloads them over your own network instead of the internet. A file the Mac
 * doesn't have yet is fetched from where it lives (Hugging Face for the model and voices, jsDelivr for the
 * runtime's WebAssembly) the first time it's asked for, kept, and handed on at the same time. "Download to the Mac"
 * fetches a whole set ahead of time. Only the files listed here are ever fetched or served.
 */
import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { appendFile, mkdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";

export const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
export const MODEL_BASE = `https://huggingface.co/${MODEL_ID}/resolve/main/`;
/** The Transformers.js version kokoro-js 1.2.1 is built on; its WebAssembly has to match it. */
export const ORT_BASE = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1/dist/";

/** The model in each size a device may use: the full one for a GPU, half-size for a GPU with 16-bit maths, compact without. */
export const MODELS = Object.freeze({ fp32: "onnx/model.onnx", fp16: "onnx/model_fp16.onnx", q8: "onnx/model_quantized.onnx" });
const COMMON = ["config.json", "tokenizer.json", "tokenizer_config.json"];
/** Felix's voices: Kokoro's American male ones, as in Settings. */
export const VOICES = Object.freeze(["am_michael", "am_fenrir", "am_puck", "am_adam", "am_echo", "am_eric", "am_liam", "am_onyx", "am_santa"]);
export const ORT_FILES = Object.freeze(["ort-wasm-simd-threaded.jsep.mjs", "ort-wasm-simd-threaded.jsep.wasm"]);
/** The longest one device report is kept. */
const REPORT_MAX = 4000;

/**
 * The files one size needs, as `kind/path`: hf for Hugging Face, ort for the runtime.
 * @param {keyof typeof MODELS} variant
 * @returns {string[]}
 */
export const filesFor = (variant) => [
  ...COMMON.map((f) => `hf/${f}`),
  `hf/${MODELS[variant]}`,
  ...VOICES.map((v) => `hf/voices/${v}.bin`),
  ...ORT_FILES.map((f) => `ort/${f}`),
];

/** Every file this Mac may fetch and serve. */
const KNOWN = new Set(Object.keys(MODELS).flatMap((v) => filesFor(/** @type {keyof typeof MODELS} */ (v))));

/**
 * Where a file comes from on the internet.
 * @param {string} file `kind/path`
 * @returns {string}
 */
export const upstreamOf = (file) => (file.startsWith("ort/") ? ORT_BASE + file.slice(4) : MODEL_BASE + file.slice(3));

/**
 * The content type a file is served with.
 * @param {string} file
 * @returns {string}
 */
const typeOf = (file) => (file.endsWith(".json") ? "application/json" : file.endsWith(".mjs") ? "text/javascript"
  : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");

/**
 * @typedef {{ variant: string, running: boolean, file: string, got: number, total: number, done: number, count: number,
 *   error: string | null }} Job "Download to the Mac": which file it's on, how far, and how many of the set are done.
 */

/**
 * Creates the store.
 * @param {{ dir: string, fetchImpl?: typeof fetch }} options `dir` is where the files are kept.
 */
export function createVoiceWeb({ dir, fetchImpl = fetch }) {
  /** @type {Job | null} */
  let job = null;

  const local = (file) => path.join(dir, file);

  /**
   * The size of a file kept here, or null when it isn't.
   * @param {string} file
   * @returns {Promise<number | null>}
   */
  const sizeOf = (file) => stat(local(file)).then((s) => s.size, () => null);

  /**
   * Fetches a file from the internet into the store, handing each piece on to `out` as it comes when there is one.
   * It's written beside its place and moved there once whole, so a half-done file is never served.
   * @param {string} file
   * @param {{ out?: import("node:http").ServerResponse, onBytes?: (got: number, total: number) => void }} [to]
   * @returns {Promise<void>}
   */
  async function fetchInto(file, { out, onBytes } = {}) {
    const up = await fetchImpl(upstreamOf(file));
    if (!up.ok || !up.body) throw new Error(`${upstreamOf(file)} answered ${up.status}`);
    // A compressed answer gives its compressed size, but arrives unpacked: then the size can't be checked or shown.
    const total = up.headers.get("content-encoding") ? 0 : Number(up.headers.get("content-length")) || 0;
    await mkdir(path.dirname(local(file)), { recursive: true });
    const part = `${local(file)}.${process.pid}.${Date.now()}.part`;
    const sink = createWriteStream(part);
    out?.writeHead(200, { "Content-Type": typeOf(file), ...(total ? { "Content-Length": String(total) } : {}), "Cache-Control": "no-store", "X-Felix-From": "internet" });
    let got = 0;
    try {
      for await (const chunk of Readable.fromWeb(/** @type {any} */ (up.body))) {
        got += chunk.length;
        if (!sink.write(chunk)) await once(sink, "drain");
        if (out && !out.destroyed && !out.write(chunk)) await once(out, "drain");
        onBytes?.(got, total);
      }
      sink.end();
      await once(sink, "finish");
      if (total && got !== total) throw new Error(`${file} came short: ${got} of ${total} bytes`);
      await rename(part, local(file));
    } catch (e) {
      sink.destroy();
      await rm(part, { force: true });
      throw e;
    } finally {
      out?.end();
    }
  }

  /**
   * Hands a file to a device: the copy kept here, or else fetched now, kept, and handed on as it comes.
   * @param {string} file `kind/path`, like "hf/onnx/model_fp16.onnx"
   * @param {import("node:http").ServerResponse} res
   * @returns {Promise<void>}
   */
  async function serve(file, res) {
    if (!KNOWN.has(file)) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return void res.end("Not a voice file.");
    }
    const size = await sizeOf(file);
    if (size === null) {
      try {
        return await fetchInto(file, { out: res });
      } catch (e) {
        if (!res.headersSent) {
          res.writeHead(502, { "Content-Type": "text/plain" });
          res.end(`The Mac couldn't fetch it: ${e.message}`);
        }
        return;
      }
    }
    res.writeHead(200, { "Content-Type": typeOf(file), "Content-Length": String(size), "Cache-Control": "no-store", "X-Felix-From": "mac" });
    createReadStream(local(file)).pipe(res);
  }

  /**
   * Which files are kept here, with their sizes, and how "Download to the Mac" is going.
   * @returns {Promise<{ files: Record<string, number | null>, job: Job | null }>}
   */
  async function status() {
    const files = Object.fromEntries(await Promise.all([...KNOWN].map(async (f) => [f, await sizeOf(f)])));
    return { files, job };
  }

  /**
   * "Download to the Mac": fetches the files one size needs that aren't kept yet, one at a time. Asking again while
   * it runs does nothing; after a failure it starts over from the files still missing.
   * @param {keyof typeof MODELS} variant
   * @returns {Job}
   */
  function download(variant) {
    if (!MODELS[variant]) throw Object.assign(new Error("Pick fp32, fp16 or q8."), { status: 400 });
    if (job?.running) return job;
    const list = filesFor(variant);
    /** @type {Job} */
    const mine = { variant, running: true, file: "", got: 0, total: 0, done: 0, count: list.length, error: null };
    job = mine;
    (async () => {
      for (const file of list) {
        mine.file = file;
        mine.got = 0;
        mine.total = 0;
        if ((await sizeOf(file)) === null) {
          await fetchInto(file, { onBytes: (got, total) => { mine.got = got; mine.total = total; } });
        }
        mine.done += 1;
      }
      mine.file = "";
    })().catch((e) => { mine.error = e.message; }).finally(() => { mine.running = false; });
    return mine;
  }

  /**
   * Keeps a device's report of how loading or a test line went (each step's time, its graphics chip, any error), one
   * line each, so a slow or stuck step can be found later. Long text is cut.
   * @param {Record<string, unknown>} entry
   * @returns {Promise<void>}
   */
  async function report(entry) {
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry }).slice(0, REPORT_MAX);
    await appendFile(path.join(dir, "reports.jsonl"), `${line}\n`);
  }

  /**
   * Keeps a line a device made (the voice lab's), as a WAV under samples/, so how it sounds can be checked on the Mac.
   * @param {string} name What the device calls it, like "ipad-fp16"; only letters, digits and dashes are kept.
   * @param {string} wav The WAV, base64.
   * @returns {Promise<string>} The file's name.
   */
  async function sample(name, wav) {
    const bytes = Buffer.from(wav, "base64");
    if (!bytes.length || bytes.subarray(0, 4).toString() !== "RIFF") throw new Error("Not a WAV.");
    const file = `${new Date().toISOString().replace(/[:.]/g, "-")}-${name.replace(/[^a-z0-9-]/gi, "").slice(0, 40) || "line"}.wav`;
    await mkdir(path.join(dir, "samples"), { recursive: true });
    await writeFile(path.join(dir, "samples", file), bytes);
    return file;
  }

  return { serve, status, download, report, sample };
}
