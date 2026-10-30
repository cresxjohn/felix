import { test } from "node:test";
import assert from "node:assert/strict";
import { bestMatch, createLyrics, lyricsFrom, parseLrc } from "../lyrics.mjs";

/**
 * A fetch that answers from a list of [match, response] pairs, in order, and records each call.
 * @param {Array<[string | RegExp, { status?: number, body?: unknown } | "offline"]>} routes
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const i = routes.findIndex(([m]) => (m instanceof RegExp ? m.test(url) : String(url).includes(m)));
    if (i < 0) throw new Error(`no route for ${url}`);
    const [[, r]] = routes.splice(i, 1);
    if (r === "offline") throw new TypeError("fetch failed");
    const status = r.status ?? 200;
    return { status, ok: status >= 200 && status < 300, json: async () => (r.body === undefined ? Promise.reject(new Error("no body")) : r.body) };
  };
  return { impl, calls };
}

const LRC = "[ar: Lady Gaga]\n[00:07.37]Mum-mum-mum-mah\n[00:11.45][01:02.5]Chorus line\n[00:20.00]\nno time here\n[1:05.123] Late line ";
const SONG = { track: "Poker Face", artist: "Lady Gaga", album: "The Fame", durationMs: 237400 };

test("parseLrc reads each timed line, in order, with lines that repeat at each of their times", () => {
  assert.deepEqual(parseLrc(LRC), [
    { ms: 7370, text: "Mum-mum-mum-mah" },
    { ms: 11450, text: "Chorus line" },
    { ms: 20000, text: "" },
    { ms: 62500, text: "Chorus line" },
    { ms: 65123, text: "Late line" },
  ]);
  assert.deepEqual(parseLrc("[offset:+500]\n[00:01.00]a\n[00:00.20]b\r\n[00:03]c"), [{ ms: 0, text: "b" }, { ms: 500, text: "a" }, { ms: 2500, text: "c" }]);
  assert.deepEqual(parseLrc("[offset:-250]\n[00:01:50]a"), [{ ms: 1750, text: "a" }]);
  assert.deepEqual(parseLrc(null), []);
  assert.deepEqual(parseLrc("just words"), []);
});

test("lyricsFrom says what was found: timed lines, plain words, or an instrumental", () => {
  assert.deepEqual(lyricsFrom(null), { found: false, instrumental: false, synced: null, plain: null });
  assert.deepEqual(lyricsFrom({ plainLyrics: "  la la \n" }), { found: true, instrumental: false, synced: null, plain: "la la" });
  assert.deepEqual(lyricsFrom({ instrumental: true, plainLyrics: "" }), { found: true, instrumental: true, synced: null, plain: null });
  assert.equal(lyricsFrom({ syncedLyrics: "[00:01.00]hi" }).synced.length, 1);
  assert.equal(lyricsFrom({ syncedLyrics: "", plainLyrics: null }).found, false);
});

test("bestMatch prefers timed lyrics of about the right length, then any with words", () => {
  const off = { duration: 300, syncedLyrics: "[00:01.00]a" };
  const timed = { duration: 236, syncedLyrics: "[00:01.00]b" };
  const plain = { duration: 238, plainLyrics: "c" };
  assert.equal(bestMatch([null, off, plain, timed], 237), timed);
  assert.equal(bestMatch([off, plain], 237), plain);
  assert.equal(bestMatch([off], 0), off);
  assert.equal(bestMatch([{ syncedLyrics: "[00:01.00]x" }], 237).syncedLyrics, "[00:01.00]x");
  assert.equal(bestMatch([{ duration: 237 }], 237), null);
  assert.equal(bestMatch("nope", 237), null);
});

test("lookup asks LRCLIB for the exact song with a Felix User-Agent, sends only the song, and keeps the answer", async () => {
  const net = fakeFetch([["/api/get?", { body: { syncedLyrics: LRC, plainLyrics: "words" } }]]);
  const lyrics = createLyrics({ fetchImpl: net.impl });
  const first = await lyrics.lookup(SONG);
  assert.equal(first.found, true);
  assert.equal(first.source, "LRCLIB");
  assert.equal(first.synced[0].text, "Mum-mum-mum-mah");
  assert.equal(await lyrics.lookup({ ...SONG }), first);
  assert.equal(net.calls.length, 1);
  const url = new URL(net.calls[0].url);
  assert.equal(url.origin + url.pathname, "https://lrclib.net/api/get");
  assert.deepEqual(Object.fromEntries(url.searchParams), { track_name: "Poker Face", artist_name: "Lady Gaga", album_name: "The Fame", duration: "237" });
  assert.match(net.calls[0].init.headers["User-Agent"], /^Felix\//);
  assert.ok(net.calls[0].init.signal instanceof AbortSignal);
});

test("lookup searches when the exact song isn't there, is busy, or has no album or length, and remembers a miss too", async () => {
  const net = fakeFetch([
    ["/api/get?", { status: 404 }], ["/api/search?", { body: [{ duration: 237, plainLyrics: "found by search" }] }],
    ["/api/get?", { status: 503, body: { message: "busy" } }], ["/api/search?", { body: [] }],
    ["/api/get?", { body: { syncedLyrics: "", plainLyrics: "" } }], ["/api/search?", { body: null }],
    ["/api/search?", { status: 404 }],
  ]);
  const lyrics = createLyrics({ fetchImpl: net.impl });
  assert.equal((await lyrics.lookup(SONG)).plain, "found by search");
  assert.deepEqual(await lyrics.lookup({ ...SONG, track: "Nothing Here" }), { found: false, instrumental: false, synced: null, plain: null, source: "LRCLIB" });
  assert.equal((await lyrics.lookup({ ...SONG, track: "Empty" })).found, false);
  assert.equal((await lyrics.lookup({ track: "No Album", artist: "A" })).found, false);
  assert.equal((await lyrics.lookup({ ...SONG, track: "Nothing Here" })).found, false);
  const asked = net.calls.map((c) => new URL(c.url).pathname);
  assert.deepEqual(asked, ["/api/get", "/api/search", "/api/get", "/api/search", "/api/get", "/api/search", "/api/search"]);
  assert.deepEqual(Object.fromEntries(new URL(net.calls[1].url).searchParams), { track_name: "Poker Face", artist_name: "Lady Gaga" });
});

test("lookup explains when LRCLIB can't be reached, and asks again next time", async () => {
  const net = fakeFetch([["/api/get?", "offline"], ["/api/search?", "offline"], ["/api/search?", { status: 500 }], ["/api/search?", { body: [{ plainLyrics: "back" }] }]]);
  const lyrics = createLyrics({ fetchImpl: net.impl, timeoutMs: 50 });
  await assert.rejects(lyrics.lookup(SONG), { code: "lyrics-unreachable", status: 502 });
  await assert.rejects(lyrics.lookup({ track: "Poker Face", artist: "Lady Gaga" }), (e) => e.code === "lyrics-unreachable" && /500/.test(e.message));
  assert.equal((await lyrics.lookup({ track: "Poker Face", artist: "Lady Gaga" })).plain, "back");
  await assert.rejects(lyrics.lookup({ track: "  " }), { code: "bad-track", status: 400 });
  await assert.rejects(lyrics.lookup(), { code: "bad-track" });
});

test("lookup keeps at most 300 songs, forgetting the oldest first", async () => {
  const routes = [];
  for (let i = 0; i < 302; i++) routes.push(["/api/search?", { body: [] }]);
  const net = fakeFetch(routes);
  const lyrics = createLyrics({ fetchImpl: net.impl });
  for (let i = 0; i < 301; i++) await lyrics.lookup({ track: `Song ${i}` });
  await lyrics.lookup({ track: "Song 300" });
  assert.equal(net.calls.length, 301);
  await lyrics.lookup({ track: "Song 0" });
  assert.equal(net.calls.length, 302);
});
