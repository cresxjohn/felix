/**
 * Song lyrics for the music player, from LRCLIB (lrclib.net), a free lyrics library that needs no key. Spotify's own
 * lyrics aren't in its public Web API. Felix sends LRCLIB only the song's title, artist, album and length, nothing
 * about you, and keeps each answer for the rest of the run, so a song's lyrics are asked for once.
 */
import { codedError } from "./keychain.mjs";

const LRCLIB = "https://lrclib.net/api";
const USER_AGENT = "Felix/1.0 (a personal desktop music player; lyrics view)";
const TIMEOUT_MS = 4000;
const CACHE_MAX = 300;
const DURATION_SLACK_S = 3;
const TEXT_MAX = 300;

/**
 * An error the server answers with its status.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string, status: number }}
 */
const failure = (status, code, message) => Object.assign(codedError(code, message), { status });

/**
 * Timed lyrics (LRC) as lines, each with the moment it starts. A line with several times shows at each of them;
 * an [offset:] tag shifts every line; tags like [ar:] and lines with no time are dropped.
 * @param {string | null | undefined} lrc
 * @returns {Array<{ ms: number, text: string }>} In time order. A line with no words is a pause in the singing.
 */
export function parseLrc(lrc) {
  const lines = [];
  let offset = 0;
  for (const raw of String(lrc ?? "").split(/\r?\n/)) {
    const shift = /^\[offset:\s*([+-]?\d+)\s*\]/i.exec(raw.trim());
    if (shift) offset = Number(shift[1]);
    const times = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)];
    if (!times.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, "").trim();
    for (const [, m, s, frac = "0"] of times) {
      lines.push({ ms: Number(m) * 60000 + Number(s) * 1000 + Math.round(Number(`0.${frac}`) * 1000), text });
    }
  }
  return lines.map((l) => ({ ms: Math.max(0, l.ms - offset), text: l.text })).sort((a, b) => a.ms - b.ms);
}

/**
 * What the player shows from one LRCLIB record.
 * @param {{ syncedLyrics?: string | null, plainLyrics?: string | null, instrumental?: boolean } | null} r
 * @returns {{ found: boolean, instrumental: boolean, synced: Array<{ ms: number, text: string }> | null, plain: string | null }}
 */
export function lyricsFrom(r) {
  const synced = parseLrc(r?.syncedLyrics);
  const plain = r?.plainLyrics?.trim() || null;
  const instrumental = Boolean(r?.instrumental);
  return { found: Boolean(r) && (instrumental || synced.length > 0 || Boolean(plain)), instrumental, synced: synced.length ? synced : null, plain };
}

/**
 * The best search result: one with timed lyrics and about the right length first, then any with words.
 * @param {object[]} results
 * @param {number} seconds The song's length, or 0 when unknown.
 * @returns {object | null}
 */
export function bestMatch(results, seconds) {
  const fits = (r) => !seconds || !r.duration || Math.abs(r.duration - seconds) <= DURATION_SLACK_S;
  const list = (Array.isArray(results) ? results : []).filter(Boolean);
  return list.find((r) => r.syncedLyrics && fits(r)) || list.find((r) => (r.plainLyrics || r.instrumental) && fits(r)) || null;
}

/**
 * Builds the lyrics service.
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [deps]
 */
export function createLyrics({ fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}) {
  const cache = new Map();

  /**
   * Asks LRCLIB, giving up after a few seconds.
   * @param {string} path With its query.
   * @returns {Promise<{ status: number, body: any }>}
   * @throws {Error} 502 "lyrics-unreachable" when LRCLIB can't be reached or answers with an error.
   */
  async function ask(path) {
    let res;
    try {
      res = await fetchImpl(`${LRCLIB}${path}`, { headers: { "User-Agent": USER_AGENT, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw failure(502, "lyrics-unreachable", "Couldn't reach the lyrics library. Try again in a moment.");
    }
    if (res.status === 404) return { status: 404, body: null };
    if (!res.ok) throw failure(502, "lyrics-unreachable", `The lyrics library answered ${res.status}. Try again in a moment.`);
    return { status: res.status, body: await res.json().catch(() => null) };
  }

  /**
   * A song's lyrics: the exact match for its title, artist, album and length, else the best search result.
   * Each answer, found or not, is kept for the rest of the run.
   * @param {{ track?: unknown, artist?: unknown, album?: unknown, durationMs?: unknown }} song
   * @returns {Promise<ReturnType<typeof lyricsFrom> & { source: string }>}
   * @throws {Error} 400 without a title.
   */
  async function lookup({ track, artist, album, durationMs } = {}) {
    const clean = (s) => String(s ?? "").trim().slice(0, TEXT_MAX);
    const song = { track: clean(track), artist: clean(artist), album: clean(album), seconds: Math.max(0, Math.round(Number(durationMs) / 1000) || 0) };
    if (!song.track) throw failure(400, "bad-track", "Say which song.");
    const key = JSON.stringify(song);
    if (cache.has(key)) return cache.get(key);
    const query = { track_name: song.track, artist_name: song.artist };
    // The exact lookup needs the album and length. LRCLIB sometimes answers it with "busy" for a song it doesn't
    // have, so any failure there falls back to a search.
    const exact = song.album && song.seconds
      ? await ask(`/get?${new URLSearchParams({ ...query, album_name: song.album, duration: String(song.seconds) })}`).catch(() => null)
      : null;
    let record = exact?.body && lyricsFrom(exact.body).found ? exact.body : null;
    if (!record) record = bestMatch((await ask(`/search?${new URLSearchParams(query)}`)).body, song.seconds);
    const answer = { ...lyricsFrom(record), source: "LRCLIB" };
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(key, answer);
    return answer;
  }

  return { lookup };
}
