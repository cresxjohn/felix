import { test } from "node:test";
import assert from "node:assert/strict";
import { LEVELS, createClipper, levelOf, wavFrom } from "../public/felix-wake-clips.mjs";

const RATE = 48000;
const CHUNK = 2048;
const CHUNK_MS = (CHUNK / RATE) * 1000;

/**
 * A chunk of sound at a level: a sine wave whose loudness (RMS) is `level`.
 * @param {number} level
 * @returns {Float32Array}
 */
const tone = (level) => Float32Array.from({ length: CHUNK }, (_, i) => Math.SQRT2 * level * Math.sin(i / 7));

/**
 * Feeds the clipper a stretch of sound.
 * @param {ReturnType<typeof createClipper>} clipper
 * @param {number} level
 * @param {number} ms
 */
const feed = (clipper, level, ms) => {
  for (let t = 0; t < ms; t += CHUNK_MS) clipper.push(tone(level));
};

/**
 * The length of a WAV's sound, in milliseconds, from its data size.
 * @param {Uint8Array} wav
 * @returns {number}
 */
const wavMs = (wav) => (new DataView(wav.buffer).getUint32(40, true) / 2 / 16000) * 1000;

test("loudness is the root mean square of the samples", () => {
  assert.ok(Math.abs(levelOf(tone(0.1)) - 0.1) < 0.005);
  assert.equal(levelOf(new Float32Array(0)), 0);
});

test("clips are 16 kHz 16-bit mono WAV that whisper reads directly", () => {
  const wav = wavFrom(Float32Array.from({ length: 4800 }, (_, i) => [0.9, -0.9, 0][i % 3]), 48000);
  const view = new DataView(wav.buffer);
  const text = (at) => String.fromCharCode(...wav.slice(at, at + 4));
  assert.deepEqual([text(0), text(8), text(12), text(36)], ["RIFF", "WAVE", "fmt ", "data"]);
  assert.deepEqual([view.getUint16(20, true), view.getUint16(22, true), view.getUint32(24, true), view.getUint16(34, true)], [1, 1, 16000, 16]);
  assert.equal(view.getUint32(40, true), 1600 * 2);
  assert.equal(wav.length, 44 + 3200);
  assert.equal(view.getInt16(44, true), 0, "averaged, so an alternating signal comes out flat");
  const loud = wavFrom(Float32Array.of(5, 5, 5, -5, -5, -5), 48000);
  assert.deepEqual([new DataView(loud.buffer).getInt16(44, true), new DataView(loud.buffer).getInt16(46, true)], [0x7fff, -0x8000]);
});

test("quiet makes no clip; speech makes one clip with the moment before it", () => {
  const clips = [];
  const clipper = createClipper({ rate: RATE, onClip: (w) => clips.push(w) });
  feed(clipper, 0.002, 2000);
  assert.equal(clips.length, 0);
  assert.equal(clipper.speaking(), false);
  feed(clipper, 0.1, 1200);
  assert.equal(clipper.speaking(), true);
  feed(clipper, 0.002, 900);
  assert.equal(clips.length, 1);
  const ms = wavMs(clips[0]);
  assert.ok(ms > 1200 + 400 && ms < 1200 + 400 + 900, `clip was ${ms} ms`);
});

test("a click or a bump too short to be speech is dropped", () => {
  const clips = [];
  const clipper = createClipper({ rate: RATE, onClip: (w) => clips.push(w) });
  feed(clipper, 0.002, 500);
  feed(clipper, 0.2, 2 * CHUNK_MS);
  feed(clipper, 0.002, 1000);
  assert.equal(clips.length, 0);
});

test("one long stretch of talk is cut at the longest a clip may be", () => {
  const clips = [];
  const clipper = createClipper({ rate: RATE, onClip: (w) => clips.push(w), maxMs: 3000 });
  feed(clipper, 0.2, 3500);
  assert.equal(clips.length, 1);
  assert.ok(wavMs(clips[0]) <= 3100);
});

test("sensitivity sets how loud speech must be", () => {
  const heard = (sensitivity, level) => {
    const clips = [];
    const clipper = createClipper({ rate: RATE, sensitivity, onClip: (w) => clips.push(w) });
    feed(clipper, 0.001, 500);
    feed(clipper, level, 800);
    feed(clipper, 0.001, 900);
    return clips.length;
  };
  assert.deepEqual([heard("high", 0.012), heard("normal", 0.012), heard("low", 0.012)], [1, 0, 0]);
  assert.equal(heard("low", 0.05), 1);
  assert.equal(heard("odd", 0.012), 0);
  assert.ok(LEVELS.high < LEVELS.normal && LEVELS.normal < LEVELS.low);
});

test("a steady fan is learned as the room's quiet, and speech over it still makes a clip", () => {
  const clips = [];
  const clipper = createClipper({ rate: RATE, onClip: (w) => clips.push(w), maxMs: 2000 });
  feed(clipper, 0.03, 12_000);
  const fanClips = clips.length;
  assert.ok(fanClips <= 1, "at most the first moment of the fan, before it's learned");
  assert.ok(clipper.floor() > 0.02);
  feed(clipper, 0.03, 3000);
  assert.equal(clips.length, fanClips, "once learned, the fan makes no more clips");
  feed(clipper, 0.3, 1000);
  feed(clipper, 0.03, 900);
  assert.equal(clips.length, fanClips + 1);
});

test("reset drops the clip in progress, as when Felix starts talking", () => {
  const clips = [];
  const clipper = createClipper({ rate: RATE, onClip: (w) => clips.push(w) });
  feed(clipper, 0.1, 600);
  clipper.reset();
  feed(clipper, 0.002, 1000);
  assert.equal(clips.length, 0);
});
