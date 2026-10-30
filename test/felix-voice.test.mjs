import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { createEars, createVoice, heardText, macVoicesIn, oneByOne, promptFor, speakable } from "../felix-voice.mjs";

/**
 * A folder with empty stand-ins for the programs and model files, so they count as installed.
 * @param {string[]} names
 * @returns {Promise<Record<string, string>>}
 */
async function installed(names) {
  const dir = await mkdtemp(path.join(tmpdir(), "felix-voice-test-"));
  const files = Object.fromEntries(names.map((n) => [n, path.join(dir, n)]));
  await Promise.all(Object.values(files).map((f) => writeFile(f, "")));
  return files;
}

/**
 * A stand-in for execFile that records each run and answers with `answer(bin, args)`.
 * @param {(bin: string, args: string[]) => Promise<{ out?: string, err?: string }> | { out?: string, err?: string }} answer
 */
function fakeExec(answer) {
  const calls = [];
  const execFileImpl = (bin, args, _opts, cb) => {
    calls.push({ bin, args });
    Promise.resolve(answer(bin, args)).then(({ out = "", err }) => (err === undefined ? cb(null, out, "") : cb(new Error("exit 1"), "", err)));
  };
  return { execFileImpl, calls };
}

/**
 * The Mac's `say`, writing a WAV where it's told to.
 * @param {string} _bin
 * @param {string[]} args
 * @returns {Promise<{ out: string }>}
 */
const fakeSay = async (_bin, args) => {
  await writeFile(args[args.indexOf("-o") + 1], "SAY");
  return { out: "" };
};

/**
 * A stand-in for the Kokoro worker: it says it's ready (unless told not to) and answers each request line.
 * @param {{ ready?: boolean, reply?: (request: Record<string, unknown>) => Promise<object | null> | object | null }} [options]
 */
function fakeWorker({ ready = true, reply = async (r) => { if (r.out) await writeFile(String(r.out), "KOKORO"); return { ok: true }; } } = {}) {
  const spawned = [];
  const spawnImpl = (bin, args) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.killed = false;
    proc.kill = () => {
      proc.killed = true;
      proc.emit("exit", null);
    };
    proc.stdin = {
      write: async (line) => {
        const request = JSON.parse(line);
        const answer = await reply(request);
        if (answer) proc.stdout.write(`not json\n${JSON.stringify({ id: 9999 })}\n${JSON.stringify({ ...answer, id: request.id })}\n`);
      },
    };
    spawned.push({ bin, args, proc });
    if (ready) setImmediate(() => proc.stdout.write(`${JSON.stringify({ ready: true })}\n`));
    return proc;
  };
  return { spawnImpl, spawned };
}

/**
 * Waits until something is true, checking every few milliseconds.
 * @param {() => boolean} done
 * @returns {Promise<void>}
 */
async function until(done) {
  while (!done()) await new Promise((r) => setTimeout(r, 2));
}

/**
 * A voice with every Kokoro file in place, or some missing.
 * @param {object} [options]
 */
async function voiceWith({ missing = [], ...options } = {}) {
  const files = await installed(["python", "script", "model", "voices"].filter((n) => !missing.includes(n)));
  const at = (n) => files[n] || `/nowhere/${n}`;
  return createVoice({ python: at("python"), script: at("script"), modelFile: at("model"), voicesFile: at("voices"), ...options });
}

test("what whisper heard, without its noise notes", () => {
  assert.equal(heardText(" [BLANK_AUDIO]\n Who's on call (wind blowing) next? *cough* \n"), "Who's on call next?");
  assert.equal(heardText("[BLANK_AUDIO]"), "");
});

test("text is read aloud the way a person would say it", () => {
  assert.equal(speakable("Review fm#12247 · see https://github.com/x/y/pull/1 now"), "Review F M 1 2 2 4 7, see now");
  assert.equal(speakable("bm 88 and BM#9"), "B M 8 8 and B M 9");
  assert.equal(speakable("Your PR and 2 PRs, the IC, and AI usage"), "Your P R and 2 P Rs, the I C, and A I usage");
  assert.equal(speakable("Ticket #4"), "Ticket number 4");
  assert.equal(speakable("x".repeat(700)).length, 600);
  assert.equal(speakable("It's at 22:00, or 09:30, or 0:15, not 10:30 PM."), "It's at 10 PM, or 9:30 AM, or 12:15 AM, not 10:30 P M.".replace(" P M", " PM"));
  assert.equal(speakable("Merged on 2026-10-29, not 2026-13-01."), "Merged on October 29, not 2026-13-01.");
  assert.equal(speakable("- **fm#880** is `red`\n2. bm#7"), "F M 8 8 0 is red B M 7");
  assert.deepEqual([oneByOne("12247"), oneByOne("880"), oneByOne("7")], ["1 2 2 4 7", "8 8 0", "7"]);
  // Ticket numbers too, one digit at a time, with Names and words still shaping the key.
  assert.equal(speakable("PMHUB-32975 is in progress", [{ word: "PMHUB", sayAs: "P M hub" }]), "P M hub 3 2 9 7 5 is in progress");
});

test("hearing turns the recording into 16 kHz WAV, then whisper writes it out", async () => {
  const f = await installed(["whisper", "ffmpeg", "model"]);
  const { execFileImpl, calls } = fakeExec((bin) => ({ out: bin === f.whisper ? " [BLANK_AUDIO] merge BM 14132\n" : "" }));
  const ears = createEars({ whisperBin: f.whisper, ffmpegBin: f.ffmpeg, modelFile: f.model, execFileImpl });
  assert.equal(ears.ready(), true);
  assert.equal(await ears.hear(Buffer.from("opus"), "audio/webm;codecs=opus"), "merge BM 14132");
  assert.deepEqual(calls.map((c) => c.bin), [f.ffmpeg, f.whisper]);
  const [ffmpeg, whisper] = calls.map((c) => c.args);
  assert.match(ffmpeg.join(" "), /-i \S+rec\.webm -ar 16000 -ac 1 -c:a pcm_s16le \S+in\.wav$/);
  assert.deepEqual(whisper.slice(0, 2), ["-m", f.model]);
  assert.ok(whisper.includes("-nt") && whisper.includes("-np") && whisper.includes("--prompt"));
  assert.equal(existsSync(path.dirname(ffmpeg[ffmpeg.indexOf("-i") + 1])), false);
});

test("hearing says plainly when it can't: unknown recording, not set up, or a step failing", async () => {
  const f = await installed(["whisper", "ffmpeg", "model"]);
  const failing = createEars({ whisperBin: f.whisper, ffmpegBin: f.ffmpeg, modelFile: f.model, execFileImpl: fakeExec(() => ({ err: "ffmpeg: noise\nInvalid data found" })).execFileImpl });
  await assert.rejects(failing.hear(Buffer.from("x"), "video/mp4"), { status: 400, message: /isn't a recording/ });
  await assert.rejects(failing.hear(Buffer.from("x"), "audio/ogg"), { message: "Invalid data found" });
  const missing = createEars({ whisperBin: "/nowhere/whisper", ffmpegBin: f.ffmpeg, modelFile: f.model });
  assert.equal(missing.ready(), false);
  await assert.rejects(missing.hear(Buffer.from("x"), "audio/wav"), { status: 503, message: /\.\/prs voice/ });
  const silent = createEars({ whisperBin: f.whisper, ffmpegBin: f.ffmpeg, modelFile: f.model, execFileImpl: fakeExec(() => ({ err: "" })).execFileImpl });
  await assert.rejects(silent.hear(Buffer.from("x"), "audio/mp4"), { message: "exit 1" });
});

test("Kokoro reads a sentence aloud in the warm worker, asked for the voice and speed", async () => {
  const worker = fakeWorker();
  const voice = await voiceWith({ spawnImpl: worker.spawnImpl });
  assert.equal(voice.ready(), true);
  const first = await voice.speak("Hi fm#1.", { voice: "bm_george", speed: 1.15 });
  assert.deepEqual({ engine: first.engine, audio: String(first.audio) }, { engine: "kokoro", audio: "KOKORO" });
  await voice.speak("Again.");
  assert.equal(worker.spawned.length, 1);
  const [, model, voicesFile] = worker.spawned[0].args;
  assert.ok(model.endsWith("model") && voicesFile.endsWith("voices"));
  voice.close();
  assert.equal(worker.spawned[0].proc.killed, true);
  await assert.rejects(voice.speak("  "), { status: 400 });
});

test("the request Kokoro gets carries the spoken text, voice, speed and output file", async () => {
  const requests = [];
  const worker = fakeWorker({ reply: async (r) => { requests.push(r); await writeFile(String(r.out), "K"); return { ok: true }; } });
  const voice = await voiceWith({ spawnImpl: worker.spawnImpl });
  await voice.speak("Your PR", { voice: "af_bella", speed: 0.9 });
  assert.deepEqual({ ...requests[0], out: path.basename(String(requests[0].out)) }, { text: "Your P R", voice: "af_bella", speed: 0.9, out: "out.wav", id: 1 });
  voice.close();
});

test("the Mac's voice stands in when Kokoro isn't set up, fails, or stops", async () => {
  const say = fakeExec(fakeSay);
  const notSetUp = await voiceWith({ missing: ["voices"], execFileImpl: say.execFileImpl, spawnImpl: () => assert.fail("no worker") });
  assert.equal(notSetUp.ready(), false);
  const spoken = await notSetUp.speak("Hello there.", { speed: 1.3 });
  assert.deepEqual({ engine: spoken.engine, audio: String(spoken.audio) }, { engine: "say", audio: "SAY" });
  assert.deepEqual(say.calls[0].args.slice(0, 2), ["-r", "241"]);
  assert.deepEqual(await notSetUp.voices(), []);

  const refusing = await voiceWith({ execFileImpl: say.execFileImpl, spawnImpl: fakeWorker({ reply: () => ({ error: "bad voice" }) }).spawnImpl });
  assert.equal((await refusing.speak("Hi.")).engine, "say");
  refusing.close();

  const dying = fakeWorker({ reply: () => null });
  const stops = await voiceWith({ execFileImpl: say.execFileImpl, spawnImpl: dying.spawnImpl });
  const pending = stops.speak("Hi.");
  await until(() => dying.spawned.length > 0);
  dying.spawned[0].proc.emit("exit", 1);
  assert.equal((await pending).engine, "say");
});

test("a worker that never answers is stopped, and the Mac's voice reads it instead", async () => {
  const worker = fakeWorker({ reply: () => null });
  const voice = await voiceWith({ execFileImpl: fakeExec(fakeSay).execFileImpl, spawnImpl: worker.spawnImpl, speakMs: 30 });
  assert.equal((await voice.speak("Hi.")).engine, "say");
  assert.equal(worker.spawned[0].proc.killed, true);
});

test("after Kokoro fails to start, it isn't tried again for a while", async () => {
  let clock = 0;
  const worker = fakeWorker({ ready: false });
  const voice = await voiceWith({ execFileImpl: fakeExec(fakeSay).execFileImpl, spawnImpl: worker.spawnImpl, now: () => clock, retryMs: 1000 });
  const first = voice.speak("Hi.");
  await until(() => worker.spawned.length > 0);
  worker.spawned[0].proc.emit("error", new Error("no python"));
  assert.equal((await first).engine, "say");
  assert.equal((await voice.speak("Again.")).engine, "say");
  assert.equal(worker.spawned.length, 1);
  clock = 5000;
  voice.warm();
  assert.equal(worker.spawned.length, 2);
  voice.close();
});

test("the worker rests after a quiet spell, and warming starts it only when Kokoro is set up", async () => {
  const worker = fakeWorker();
  const voice = await voiceWith({ spawnImpl: worker.spawnImpl, idleMs: 20 });
  voice.warm();
  voice.warm();
  assert.equal(worker.spawned.length, 1);
  assert.deepEqual(await voice.voices(), []);
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(worker.spawned[0].proc.killed, true);

  const listing = await voiceWith({ spawnImpl: fakeWorker({ reply: () => ({ voices: ["af_heart", "bm_george"] }) }).spawnImpl });
  assert.deepEqual(await listing.voices(), ["af_heart", "bm_george"]);
  listing.close();
  listing.close();

  const unset = await voiceWith({ missing: ["model"], spawnImpl: () => assert.fail("no worker") });
  unset.warm();
});

test("whisper is told Felix's name when he's been renamed, so it expects to hear it", async () => {
  const f = await installed(["whisper", "ffmpeg", "model"]);
  const { execFileImpl, calls } = fakeExec(() => ({ out: "hey max" }));
  const ears = createEars({ whisperBin: f.whisper, ffmpegBin: f.ffmpeg, modelFile: f.model, execFileImpl });
  await ears.hear(Buffer.from("wav"), "audio/wav", "Max");
  await ears.hear(Buffer.from("wav"), "audio/wav", "Felix");
  const ffmpeg = calls.find((c) => c.bin === f.ffmpeg).args;
  assert.notEqual(ffmpeg[ffmpeg.indexOf("-i") + 1], ffmpeg.at(-1), "a WAV recording isn't also the output");
  const prompts = calls.filter((c) => c.bin === f.whisper).map((c) => c.args[c.args.indexOf("--prompt") + 1]);
  assert.match(prompts[0], /^Max, Felix, fm/);
  assert.match(prompts[1], /^Felix, fm/);
});

test("the Mac's English voices are listed without the novelty ones", () => {
  const out = "Daniel              en_GB    # Hello! My name is Daniel.\nBad News            en_US    # Hello!\nFlo (English (US))  en_US    # Hello!\nAmélie              fr_CA    # Bonjour!\nZarvox              en_US    # Hello!\n";
  assert.deepEqual(macVoicesIn(out), [{ name: "Daniel", lang: "en_GB" }, { name: "Flo (English (US))", lang: "en_US" }]);
});

test("Felix can speak with one of the Mac's own voices, and lists them", async () => {
  const { execFileImpl, calls } = fakeExec((bin, args) => (args.includes("?") ? { out: "Karen               en_AU    # Hello!\n" } : fakeSay(bin, args)));
  const voice = await voiceWith({ execFileImpl, sayBin: "/usr/bin/say" });
  const { audio, engine } = await voice.speak("Hi there", { engine: "mac", macVoice: "Karen", speed: 1 });
  assert.deepEqual([String(audio), engine], ["SAY", "say"]);
  assert.deepEqual(calls[0].args.slice(0, 2), ["-v", "Karen"]);
  await voice.speak("Hi", { engine: "mac" });
  assert.equal(calls[1].args.includes("-v"), false, "the Mac's default voice");
  assert.deepEqual(await voice.macVoices(), [{ name: "Karen", lang: "en_AU" }]);
  const broken = await voiceWith({ execFileImpl: (bin, args, opts, cb) => cb(new Error("no say"), "", "no say"), sayBin: "/usr/bin/say" });
  assert.deepEqual(await broken.macVoices(), []);
  voice.close();
  broken.close();
});

test("words from your dictionary are said your way, and whisper expects your words first", () => {
  assert.equal(speakable("PMHUB-12 is next", [{ word: "PMHUB", sayAs: "P M hub" }]), "P M hub 1 2 is next");
  assert.equal(speakable("a.b and ab", [{ word: "a.b", sayAs: "A dot B" }]), "A dot B and ab");
  assert.match(promptFor("Max", ["Sonito", "Jamsed"]), /^Max, Sonito, Jamsed, Felix, fm/);
  assert.match(promptFor("Felix", []), /^Felix, fm/);
  assert.ok(promptFor("", Array.from({ length: 200 }, (_, i) => `Word${i}`)).length <= 600);
});
