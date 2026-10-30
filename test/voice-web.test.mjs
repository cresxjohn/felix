import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { MODEL_BASE, ORT_BASE, VOICES, createVoiceWeb, filesFor, upstreamOf } from "../voice-web.mjs";

/**
 * A fake fetch that answers every known address with a few bytes, and remembers what was asked.
 * @param {string[]} asked
 */
const fakeFetch = (asked) => async (url) => {
  asked.push(url);
  const body = new TextEncoder().encode(`bytes of ${url}`);
  return new Response(body, { status: 200, headers: { "content-length": String(body.length) } });
};

/**
 * A response that collects what's written to it.
 * @returns {PassThrough & { status?: number, headers?: object, text: () => string }}
 */
function fakeRes() {
  const res = new PassThrough();
  const chunks = [];
  res.on("data", (c) => chunks.push(c));
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers; res.headersSent = true; };
  res.text = () => Buffer.concat(chunks).toString();
  return res;
}

test("each size needs the shared files, its model, Felix's voices and the runtime, from the right places", () => {
  const files = filesFor("fp16");
  assert.ok(files.includes("hf/config.json") && files.includes("hf/onnx/model_fp16.onnx") && !files.includes("hf/onnx/model.onnx"));
  assert.equal(files.filter((f) => f.startsWith("hf/voices/")).length, VOICES.length);
  assert.equal(upstreamOf("hf/onnx/model_fp16.onnx"), `${MODEL_BASE}onnx/model_fp16.onnx`);
  assert.equal(upstreamOf("ort/ort-wasm-simd-threaded.jsep.wasm"), `${ORT_BASE}ort-wasm-simd-threaded.jsep.wasm`);
});

test("a file the Mac doesn't have is fetched once, kept and passed on; the next time it comes from the Mac", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-voice-web-"));
  try {
    const asked = [];
    const store = createVoiceWeb({ dir, fetchImpl: fakeFetch(asked) });
    const first = fakeRes();
    await store.serve("hf/config.json", first);
    await new Promise((r) => first.on("end", r).resume());
    assert.equal(first.status, 200);
    assert.equal(first.headers["X-Felix-From"], "internet");
    assert.equal(await readFile(path.join(dir, "hf/config.json"), "utf8"), `bytes of ${MODEL_BASE}config.json`);
    const second = fakeRes();
    await store.serve("hf/config.json", second);
    await new Promise((r) => second.on("end", r));
    assert.equal(second.headers["X-Felix-From"], "mac");
    assert.equal(second.text(), `bytes of ${MODEL_BASE}config.json`);
    assert.equal(asked.length, 1, "fetched from the internet only once");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("only Felix's voice files are served: anything else is refused without fetching", async () => {
  const asked = [];
  const store = createVoiceWeb({ dir: tmpdir(), fetchImpl: fakeFetch(asked) });
  for (const file of ["hf/../../etc/passwd", "hf/onnx/model_q4.onnx", "other/x.bin"]) {
    const res = fakeRes();
    await store.serve(file, res);
    assert.equal(res.status, 404, file);
  }
  assert.deepEqual(asked, []);
});

test("Download to the Mac fetches only what's missing, and says how far it got", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-voice-web-"));
  try {
    await mkdir(path.join(dir, "hf"), { recursive: true });
    await writeFile(path.join(dir, "hf/config.json"), "kept");
    const asked = [];
    const store = createVoiceWeb({ dir, fetchImpl: fakeFetch(asked) });
    const job = store.download("q8");
    assert.equal(store.download("q8"), job, "asking again while it runs gives the same download");
    while (job.running) await new Promise((r) => setTimeout(r, 5));
    assert.equal(job.error, null);
    assert.equal(job.done, filesFor("q8").length);
    assert.ok(!asked.includes(`${MODEL_BASE}config.json`), "a file already kept isn't fetched again");
    const { files } = await store.status();
    assert.ok(filesFor("q8").every((f) => files[f] !== null));
    assert.equal(files["hf/onnx/model.onnx"], null, "other sizes aren't fetched");
    assert.throws(() => store.download("q4"), /Pick fp32, fp16 or q8/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a compressed answer, which arrives larger than its stated size, isn't taken for a broken one", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-voice-web-"));
  try {
    const body = new TextEncoder().encode("unpacked bytes, more than the compressed size says");
    const fetchImpl = async () => new Response(body, { status: 200, headers: { "content-length": "10", "content-encoding": "br" } });
    const store = createVoiceWeb({ dir, fetchImpl });
    const job = store.download("q8");
    while (job.running) await new Promise((r) => setTimeout(r, 5));
    assert.equal(job.error, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
