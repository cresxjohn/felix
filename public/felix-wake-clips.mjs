/**
 * The page's side of listening for "Hey Felix": the microphone's sound comes in small chunks, and only when someone
 * speaks is a short clip cut out (with a moment before, so the first word isn't clipped) and handed on, as WAV, to
 * be written out by whisper on this Mac. Quiet, a cough or a bump never makes a clip. The room's quiet is learned as
 * it goes, so a fan or the air conditioner doesn't count as speech. The page loads this; the tests load it too.
 */

/** How loud speech must be at each sensitivity, before the room's own noise is taken into account. */
export const LEVELS = Object.freeze({ high: 0.008, normal: 0.015, low: 0.028 });
const OVER_FLOOR = 2.5;
// The room's quiet rises slowly (a steady fan is learned in a few seconds, a sentence barely moves it) and falls fast.
const FLOOR_RISE = 0.01;
const FLOOR_FALL = 0.2;
const START_CHUNKS = 2;
const WAV_RATE = 16000;

/**
 * How loud a chunk of sound is, from 0 to 1.
 * @param {Float32Array} samples
 * @returns {number}
 */
export function levelOf(samples) {
  let sum = 0;
  for (const v of samples) sum += v * v;
  return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

/**
 * Sound as a 16 kHz, 16-bit mono WAV file, which whisper reads directly.
 * @param {Float32Array} samples
 * @param {number} rate The rate the samples were taken at.
 * @returns {Uint8Array}
 */
export function wavFrom(samples, rate) {
  const step = rate / WAV_RATE;
  const count = Math.floor(samples.length / step);
  const out = new DataView(new ArrayBuffer(44 + count * 2));
  const text = (at, s) => [...s].forEach((c, i) => out.setUint8(at + i, c.charCodeAt(0)));
  text(0, "RIFF");
  out.setUint32(4, 36 + count * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  out.setUint32(16, 16, true);
  out.setUint16(20, 1, true);
  out.setUint16(22, 1, true);
  out.setUint32(24, WAV_RATE, true);
  out.setUint32(28, WAV_RATE * 2, true);
  out.setUint16(32, 2, true);
  out.setUint16(34, 16, true);
  text(36, "data");
  out.setUint32(40, count * 2, true);
  for (let i = 0; i < count; i++) {
    // Each output sample is the average of the samples it stands for, which keeps higher sounds from folding down.
    const from = Math.floor(i * step);
    const to = Math.max(from + 1, Math.floor((i + 1) * step));
    let sum = 0;
    for (let j = from; j < to; j++) sum += samples[j];
    const v = Math.max(-1, Math.min(1, sum / (to - from)));
    out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
  }
  return new Uint8Array(out.buffer);
}

/**
 * Joins chunks of sound into one.
 * @param {Float32Array[]} chunks
 * @returns {Float32Array}
 */
function joined(chunks) {
  const all = new Float32Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.length;
  }
  return all;
}

/**
 * @typedef {{ push: (samples: Float32Array) => void, reset: () => void, floor: () => number, speaking: () => boolean }} Clipper
 */

/**
 * Cuts clips of speech out of the microphone's sound. Speech starts when two chunks in a row are louder than the
 * sensitivity's level (or the room's quiet times 2.5, whichever is higher), and the clip keeps the moment before
 * it. It ends after a stretch of quiet, or at its longest. One with too little speech in it is dropped. Steady
 * noise raises the room's quiet until it no longer counts as speech. `onStart` hears the moment speech starts,
 * and `onDrop` that a started clip had too little speech to keep.
 * @param {{ rate: number, sensitivity?: string, onClip: (wav: Uint8Array) => void, onStart?: () => void, onDrop?: () => void,
 *   beforeMs?: number, quietMs?: number, maxMs?: number, minMs?: number }} options
 * @returns {Clipper}
 */
export function createClipper({ rate, sensitivity = "normal", onClip, onStart, onDrop, beforeMs = 400, quietMs = 700, maxMs = 8000, minMs = 250 }) {
  const base = LEVELS[sensitivity] || LEVELS.normal;
  let floor = base / OVER_FLOOR;
  let before = [];
  let clip = null;
  let loudRun = 0;

  const ms = (chunks) => (chunks.reduce((n, c) => n + c.length, 0) / rate) * 1000;

  /**
   * Hands on the clip in progress when it has enough speech in it, and starts listening afresh.
   */
  function finish() {
    const done = clip;
    clip = null;
    loudRun = 0;
    before = [];
    if (done && done.loudMs >= minMs) onClip(wavFrom(joined(done.chunks), rate));
    else if (done) onDrop?.();
  }

  return {
    push(samples) {
      const level = levelOf(samples);
      const loud = level > Math.max(base, floor * OVER_FLOOR);
      const len = (samples.length / rate) * 1000;
      floor += (level - floor) * (level > floor ? FLOOR_RISE : FLOOR_FALL);
      if (!clip) {
        before.push(samples);
        while (before.length > 1 && ms(before.slice(1)) >= beforeMs) before.shift();
        loudRun = loud ? loudRun + 1 : 0;
        if (loudRun >= START_CHUNKS) {
          clip = { chunks: [...before], loudMs: len * loudRun, quietMs: 0 };
          onStart?.();
        }
        return;
      }
      clip.chunks.push(samples);
      if (loud) {
        clip.loudMs += len;
        clip.quietMs = 0;
      } else {
        clip.quietMs += len;
      }
      if (clip.quietMs >= quietMs || ms(clip.chunks) >= maxMs) finish();
    },
    /** Drops anything in progress, as when Felix starts talking. */
    reset() {
      clip = null;
      loudRun = 0;
      before = [];
    },
    /** The room's quiet, as learned so far. @returns {number} */
    floor: () => floor,
    /** Whether a clip is being cut right now. @returns {boolean} */
    speaking: () => Boolean(clip),
  };
}
