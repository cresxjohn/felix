import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { SOURCES, createMusic, playlistNamed, spotifyNowPlaying, trackRow } from "../music.mjs";
import { deleteKeychain, writeKeychain } from "../keychain.mjs";

/**
 * A Keychain in memory.
 * @param {Record<string, string>} [start] "service/account" to secret.
 */
function fakeSecrets(start = {}) {
  const items = new Map(Object.entries(start));
  return {
    items,
    read: async (service, account) => items.get(`${service}/${account}`) ?? null,
    write: async (service, account, secret) => { items.set(`${service}/${account}`, secret); },
    remove: async (service, account) => { items.delete(`${service}/${account}`); },
  };
}

/**
 * A fetch that answers from a list of [match, response] pairs, in order, and records each call.
 * @param {Array<[string | RegExp, { status?: number, body?: unknown }]>} routes
 */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const i = routes.findIndex(([m]) => (m instanceof RegExp ? m.test(url) : String(url).includes(m)));
    if (i < 0) throw new Error(`no route for ${url}`);
    const [[, r]] = routes.splice(i, 1);
    const status = r.status ?? 200;
    const headers = new Map(Object.entries(r.headers || {}));
    return { status, ok: status >= 200 && status < 300, headers, json: async () => r.body ?? {} };
  };
  return { impl, calls };
}

const SPOTIFY = "cmd-center-spotify";
const signedIn = () => fakeSecrets({ [`${SPOTIFY}/refresh-token`]: "refresh-1" });
const TOKEN = ["accounts.spotify.com/api/token", { body: { access_token: "access-1", expires_in: 3600 } }];

/**
 * The music service with fakes.
 * @param {{ secrets?: ReturnType<typeof fakeSecrets>, routes?: Array<[string | RegExp, object]>, clock?: { t: number } }} [o]
 */
function setup({ secrets = fakeSecrets(), routes = [], clock = { t: 1_000_000 } } = {}) {
  const net = fakeFetch(routes);
  let n = 0;
  const music = createMusic({
    redirectBase: "http://127.0.0.1:4777", fetchImpl: net.impl, secrets, now: () => clock.t,
    random: (size) => Buffer.alloc(size, ++n),
  });
  return { music, secrets, net, clock };
}

test("spotifyNowPlaying turns Spotify's playback state into what the player shows", () => {
  assert.deepEqual(spotifyNowPlaying(null), { playing: false, progressMs: 0, shuffle: false, repeat: "off", context: null, track: null, device: null });
  const now = spotifyNowPlaying({
    is_playing: true, progress_ms: 5000, device: { name: "MacBook", volume_percent: 40 }, shuffle_state: true, repeat_state: "track",
    context: { uri: "spotify:playlist:p1" },
    item: { id: "t1", uri: "spotify:track:t1", name: "Song", duration_ms: 200000, artists: [{ name: "A" }, { name: "B" }], external_urls: { spotify: "https://open.spotify.com/x" },
      album: { name: "The Fame", images: [{ url: "big", width: 640 }, { url: "mid", width: 300 }, { url: "small", width: 64 }] } },
  });
  assert.deepEqual(now, { playing: true, progressMs: 5000, shuffle: true, repeat: "track", context: "spotify:playlist:p1",
    device: { id: null, name: "MacBook", volume: 40, supportsVolume: true },
    track: { id: "t1", uri: "spotify:track:t1", title: "Song", artists: "A, B", art: "mid", durationMs: 200000, playable: true, album: "The Fame", url: "https://open.spotify.com/x" } });
  assert.equal(spotifyNowPlaying({ repeat_state: "sideways", device: { name: "Phone", supports_volume: false } }).repeat, "off");
  assert.equal(spotifyNowPlaying({ device: { name: "Phone", supports_volume: false } }).device.supportsVolume, false);
  const episode = spotifyNowPlaying({ is_playing: false, item: { name: "Ep", show: { name: "Pod" }, images: [{ url: "only" }] }, device: { name: "Phone" } });
  assert.equal(episode.track.artists, "Pod");
  assert.equal(episode.track.art, "only");
  assert.equal(episode.track.durationMs, 0);
  assert.equal(episode.track.album, null);
  assert.equal(episode.device.volume, null);
  assert.equal(spotifyNowPlaying({ item: { name: "x", artists: [] } }).track.art, null);
});

test("status says Spotify isn't signed in until a sign-in is saved", async () => {
  assert.deepEqual(await setup().music.status(), {
    spotify: { name: "Spotify", connected: false, outdated: false, account: null, error: null, can: { save: false, recent: false }, missing: [] },
  });
});

test("status names the signed-in account, asks once, and tries a failed ask again after a minute", async () => {
  const { music, net, clock } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["api.spotify.com/v1/me", { status: 500 }], ["api.spotify.com/v1/me", { body: { display_name: "Cres", id: "cres1" } }]],
  });
  const first = await music.status();
  assert.equal(first.spotify.connected, true);
  assert.equal(first.spotify.account, null);
  assert.equal((await music.status()).spotify.account, null);
  clock.t += 61e3;
  assert.equal((await music.status()).spotify.account, "Cres");
  assert.equal((await music.status()).spotify.account, "Cres");
  assert.equal(net.calls.filter((c) => c.url.endsWith("/v1/me")).length, 2);
});

test("an account without a display name shows its id, and a network failure shows no name", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN, ["api.spotify.com/v1/me", { body: { id: "cres1" } }]] });
  assert.equal((await music.status()).spotify.account, "cres1");
  const offline = setup({ secrets: signedIn(), routes: [TOKEN] });
  assert.equal((await offline.music.status()).spotify.account, null);
  const unnamed = setup({ secrets: signedIn(), routes: [TOKEN, ["api.spotify.com/v1/me", { body: {} }]] });
  assert.equal((await unnamed.music.status()).spotify.account, null);
});

test("a sign-in from before Felix could play music itself is outdated, and gets no token for the page's player", async () => {
  const old = ["accounts.spotify.com/api/token", { body: { access_token: "a-old", expires_in: 3600, scope: "user-read-playback-state playlist-read-private" } }];
  const { music } = setup({ secrets: signedIn(), routes: [old, ["api.spotify.com/v1/me", { body: { id: "cres1" } }]] });
  assert.equal((await music.status()).spotify.outdated, true);
  await assert.rejects(music.spotifyToken(), { status: 409, code: "sign-in-again" });
  const everything = ["accounts.spotify.com/api/token", { body: { access_token: "a-new", expires_in: 3600, scope: SOURCES.spotify.scopes.join(" ") } }];
  const fresh = setup({ secrets: signedIn(), routes: [everything] });
  assert.equal(await fresh.music.spotifyToken(), "a-new");
  const unknown = setup({ secrets: signedIn(), routes: [TOKEN] });
  assert.equal(await unknown.music.spotifyToken(), "access-1");
});

test("a failed sign-in's reason shows in status until the next sign-in starts", async () => {
  const { music } = setup();
  const state = new URL(music.connectUrl("spotify", "/back")).searchParams.get("state");
  await assert.rejects(music.finish("spotify", { error: "access_denied", state }));
  assert.equal((await music.status()).spotify.error, "The Spotify sign-in was cancelled.");
  await assert.rejects(music.finish("spotify", { code: "c", state: "never-started" }), (e) => e.code === "stale" && e.returnTo === undefined);
  assert.match((await music.status()).spotify.error, /took too long/);
  music.connectUrl("spotify", "/back");
  assert.equal((await music.status()).spotify.error, null);
});

test("connectUrl builds a PKCE sign-in with Felix's own Spotify app and the right scopes", () => {
  const { music } = setup();
  assert.throws(() => music.connectUrl("nope", "/settings"), { status: 400, code: "bad-source" });
  const url = new URL(music.connectUrl("spotify", "http://localhost:4777/settings"));
  assert.equal(url.origin + url.pathname, "https://accounts.spotify.com/authorize");
  const q = url.searchParams;
  assert.equal(q.get("client_id"), "c934c3cf5cbf4f68ac4f2c50aa608c13");
  assert.equal(q.get("redirect_uri"), "http://127.0.0.1:4777/api/music/callback/spotify");
  assert.equal(q.get("scope"), SOURCES.spotify.scopes.join(" "));
  assert.match(q.get("scope"), /\bstreaming\b/);
  assert.equal(q.get("code_challenge_method"), "S256");
  assert.equal(q.get("code_challenge"), createHash("sha256").update(Buffer.alloc(32, 1).toString("base64url")).digest("base64url"));
});

test("finish swaps the code for tokens, keeps the sign-in, and refuses stale or cancelled sign-ins", async () => {
  const { music, secrets, net, clock } = setup({
    routes: [["accounts.spotify.com/api/token", { body: { access_token: "a", refresh_token: "r-new", expires_in: 3600 } }]],
  });
  const state = new URL(music.connectUrl("spotify", "http://localhost:4777/settings")).searchParams.get("state");
  assert.equal(await music.finish("spotify", { code: "c0de", state }), "http://localhost:4777/settings");
  assert.equal(secrets.items.get(`${SPOTIFY}/refresh-token`), "r-new");
  const sent = new URLSearchParams(net.calls[0].init.body);
  assert.equal(sent.get("grant_type"), "authorization_code");
  assert.equal(sent.get("client_id"), SOURCES.spotify.clientId);
  assert.equal(sent.get("code_verifier"), Buffer.alloc(32, 1).toString("base64url"));
  assert.equal(sent.has("client_secret"), false);
  await assert.rejects(music.finish("spotify", { code: "c0de", state }), { code: "stale" });
  const cancelled = new URL(music.connectUrl("spotify", "/back")).searchParams.get("state");
  await assert.rejects(music.finish("spotify", { error: "access_denied", state: cancelled }), (e) => e.code === "denied" && e.returnTo === "/back");
  const old = new URL(music.connectUrl("spotify", "/back")).searchParams.get("state");
  clock.t += 11 * 60e3;
  await assert.rejects(music.finish("spotify", { code: "x", state: old }), { code: "stale" });
  music.connectUrl("spotify", "/back");
});

test("a refused code exchange explains itself and keeps where to go back", async () => {
  const { music } = setup({
    routes: [["accounts.spotify.com/api/token", { status: 400, body: { error: "invalid_grant" } }]],
  });
  const state = new URL(music.connectUrl("spotify", "/settings")).searchParams.get("state");
  await assert.rejects(music.finish("spotify", { code: "c", state }), (e) => /invalid_grant/.test(e.message) && e.returnTo === "/settings");
});

test("spotifyNow renews the access token once, and says nothing plays on a 204", async () => {
  const { music, net } = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/player?", { status: 204 }], ["/me/player?", { body: { is_playing: true, item: { name: "S", artists: [] } } }]] });
  assert.equal((await music.spotifyNow()).track, null);
  assert.equal((await music.spotifyNow()).track.title, "S");
  assert.equal(net.calls.filter((c) => c.url.includes("api/token")).length, 1);
  assert.equal(net.calls[1].init.headers.Authorization, "Bearer access-1");
});

test("an expired sign-in signs the source out and says to connect again", async () => {
  const { music, secrets } = setup({ secrets: signedIn(), routes: [["api/token", { status: 400, body: { error: "invalid_grant" } }]] });
  await assert.rejects(music.spotifyNow(), { code: "expired", status: 401 });
  assert.equal(secrets.items.has(`${SPOTIFY}/refresh-token`), false);
  await assert.rejects(music.spotifyNow(), { code: "not-connected", status: 409 });
});

test("Spotify's refusals become plain explanations", async () => {
  const cases = [
    [{ status: 403, body: { error: { reason: "PREMIUM_REQUIRED" } } }, "premium"],
    [{ status: 404 }, "no-device"],
    [{ status: 429 }, "rate-limited"],
    [{ status: 500 }, "http"],
    [{ status: 401 }, "http"],
  ];
  for (const [answer, code] of cases) {
    const { music } = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/player?", answer]] });
    await assert.rejects(music.spotifyNow(), { code });
  }
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN] });
  await assert.rejects(music.spotifyNow(), { code: "network" });
});

test("spotifyControl sends each action, and play finds a device when none is active", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/pause", { status: 204 }], ["/me/player/next", { status: 204 }], ["/me/player/volume", { status: 204 }],
      ["/me/player/play", { status: 404 }], ["/me/player/devices", { body: { devices: [{ id: "phone", type: "Smartphone" }, { id: "mac", type: "Computer" }] } }],
      ["/me/player/play?device_id=mac", { status: 204 }]],
  });
  await music.spotifyControl({ action: "pause" });
  await music.spotifyControl({ action: "next" });
  await music.spotifyControl({ action: "volume", volume: 55 });
  await music.spotifyControl({ action: "play", uri: "spotify:playlist:abc" });
  const urls = net.calls.map((c) => c.url.replace("https://api.spotify.com/v1", ""));
  assert.deepEqual(urls.slice(1), ["/me/player/pause", "/me/player/next", "/me/player/volume?volume_percent=55", "/me/player/play", "/me/player/devices", "/me/player/play?device_id=mac"]);
  assert.equal(net.calls.at(-1).init.body, JSON.stringify({ context_uri: "spotify:playlist:abc" }));
  assert.equal(net.calls.at(-1).init.headers["Content-Type"], "application/json");
});

test("spotifyControl refuses bad actions and values, and explains when no device can play", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/player/play", { status: 404 }], ["/me/player/devices", { status: 500 }], ["/me/player/previous", { status: 403 }]] });
  await assert.rejects(music.spotifyControl({ action: "dance" }), { code: "bad-action" });
  await assert.rejects(music.spotifyControl({ action: "volume", volume: 120 }), { code: "bad-volume" });
  await assert.rejects(music.spotifyControl({ action: "play", uri: "https://evil" }), { code: "bad-uri" });
  await assert.rejects(music.spotifyControl({ action: "play" }), { code: "no-device" });
  await assert.rejects(music.spotifyControl({ action: "previous" }), { code: "premium" });
  await assert.rejects(music.spotifyControl(), { code: "bad-action" });
});

test("play goes straight to Felix's own player when asked, and transfer moves playback there", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/play?device_id=felix-1", { status: 404 }], ["/me/player/play?device_id=felix-1", { status: 204 }], [/\/me\/player$/, { status: 204 }], [/\/me\/player$/, { status: 502 }]],
  });
  await assert.rejects(music.spotifyControl({ action: "play", uri: "spotify:playlist:abc", device: "felix-1" }), { code: "no-device" });
  await music.spotifyControl({ action: "play", device: "felix-1" });
  await music.spotifyControl({ action: "transfer", device: "felix-1", play: true });
  assert.equal(net.calls.at(-1).init.method, "PUT");
  assert.equal(net.calls.at(-1).init.body, JSON.stringify({ device_ids: ["felix-1"], play: true }));
  await assert.rejects(music.spotifyControl({ action: "transfer", device: "felix-1" }), { code: "http" });
  await assert.rejects(music.spotifyControl({ action: "transfer" }), { code: "bad-device" });
  await assert.rejects(music.spotifyControl({ action: "play", device: "bad device!" }), { code: "bad-device" });
  assert.equal(net.calls.filter((c) => c.url.includes("/devices")).length, 0);
});

test("playlists lists your Spotify playlists, under either name Spotify gives the track count", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/playlists", { body: { items: [null, { id: "p1", name: "Focus", images: [{ url: "i", width: 300 }], items: { total: 12 }, uri: "spotify:playlist:p1" }, { id: "p2", name: "Empty", uri: "spotify:playlist:p2" }, { id: "p3", name: "Old", tracks: { total: 4 }, uri: "spotify:playlist:p3" }] } }]],
  });
  assert.deepEqual(await music.playlists("spotify"), [
    { id: "p1", name: "Focus", image: "i", count: 12, uri: "spotify:playlist:p1" },
    { id: "p2", name: "Empty", image: null, count: 0, uri: "spotify:playlist:p2" },
    { id: "p3", name: "Old", image: null, count: 4, uri: "spotify:playlist:p3" },
  ]);
  assert.equal(new URLSearchParams(net.calls[0].init.body).has("client_secret"), false);
  await assert.rejects(music.playlists("youtube"), { code: "bad-source" });
});

test("playlist failures explain themselves", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/playlists", { status: 500 }]] });
  await assert.rejects(music.playlists("spotify"), { code: "http" });
});

test("disconnect forgets the sign-in", async () => {
  const { music, secrets } = setup({ secrets: signedIn() });
  await music.disconnect("spotify");
  assert.equal(secrets.items.has(`${SPOTIFY}/refresh-token`), false);
  assert.equal((await music.status()).spotify.connected, false);
  await assert.rejects(music.disconnect("x"), { code: "bad-source" });
});

/**
 * A stand-in for `security -i` that records what it was sent and answers with an exit code and error text.
 * @param {number} code
 * @param {string} [stderr]
 */
function fakeSpawn(code, stderr = "") {
  const sent = [];
  const spawnImpl = (cmd, args) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: (text) => { sent.push({ cmd, args, text }); setImmediate(() => { if (stderr) child.stderr.emit("data", stderr); child.emit("close", code); }); } };
    return child;
  };
  return { spawnImpl, sent };
}

test("writeKeychain sends the secret on stdin, never as an argument", async () => {
  const fake = fakeSpawn(0);
  await writeKeychain("cmd-center-spotify", "refresh-token", "AQD-abc_123/x=", fake);
  assert.deepEqual(fake.sent[0].args, ["-i"]);
  assert.equal(fake.sent[0].text, `add-generic-password -U -s "cmd-center-spotify" -a "refresh-token" -w "AQD-abc_123/x="\n`);
  await assert.rejects(writeKeychain("s", "a", `bad" value`, fake), /characters/);
  await assert.rejects(writeKeychain("s", "a", "ok", fakeSpawn(0, "security: SecKeychainItemCreate failed")), /Couldn't save/);
  await assert.rejects(writeKeychain("s", "a", "ok", fakeSpawn(1)), /Couldn't save/);
});

test("deleteKeychain is fine when the item isn't there, and fails otherwise", async () => {
  await deleteKeychain("s", "a", fakeSpawn(0));
  await deleteKeychain("s", "a", fakeSpawn(0, "The specified item could not be found in the keychain."));
  await assert.rejects(deleteKeychain("s", "a", fakeSpawn(0, "denied")), /Couldn't remove/);
});

const API = "https://api.spotify.com/v1";
/**
 * The paths Spotify was asked for, without the API's address.
 * @param {ReturnType<typeof fakeFetch>} net
 */
const paths = (net) => net.calls.filter((c) => c.url.startsWith(API)).map((c) => c.url.slice(API.length));
const song = (id, extra = {}) => ({ id, uri: `spotify:track:${id}`, name: `Song ${id}`, duration_ms: 1000, artists: [{ name: "A" }], ...extra });

test("trackRow lists a song, an episode, a local file and a song with no picture of its own", () => {
  assert.deepEqual(trackRow(song("a", { album: { images: [{ url: "pic", width: 64 }] } })),
    { id: "a", uri: "spotify:track:a", title: "Song a", artists: "A", art: "pic", durationMs: 1000, playable: true });
  assert.equal(trackRow({ uri: "spotify:episode:e", name: "Ep", show: { name: "Pod" } }, "fallback").art, "fallback");
  assert.equal(trackRow({ uri: "spotify:episode:e", name: "Ep", show: { name: "Pod" } }).id, null);
  assert.equal(trackRow(song("b", { is_local: true })).playable, false);
  assert.equal(trackRow(song("c", { is_playable: false })).playable, false);
});

test("playlistNamed finds the same name, or, when loose, one that starts with or holds the words", () => {
  const lists = [{ name: "Deep Focus" }, { name: "Focus Flow" }, { name: "Chill" }];
  assert.equal(playlistNamed(lists, "CHILL!", false).name, "Chill");
  assert.equal(playlistNamed(lists, "focus", false), undefined);
  assert.equal(playlistNamed(lists, "focus", true).name, "Focus Flow");
  assert.equal(playlistNamed([{ name: "Deep Focus" }], "focus", true).name, "Deep Focus");
  assert.equal(playlistNamed(lists, "jazz", true), undefined);
});

test("a sign-in from before saving songs and recently played still plays, and says which extras need a new sign-in", async () => {
  const older = ["accounts.spotify.com/api/token", { body: { access_token: "a", expires_in: 3600, scope: SOURCES.spotify.needs.join(" ") } }];
  const { music } = setup({ secrets: signedIn(), routes: [older, ["/v1/me", { body: { id: "cres1" } }]] });
  const s = (await music.status()).spotify;
  assert.equal(s.outdated, false);
  assert.deepEqual(s.can, { save: false, recent: false });
  assert.deepEqual(s.missing, ["user-library-modify", "user-read-recently-played"]);
  assert.equal(await music.spotifyToken(), "a");
  const all = ["accounts.spotify.com/api/token", { body: { access_token: "b", expires_in: 3600, scope: SOURCES.spotify.scopes.join(" ") } }];
  const fresh = setup({ secrets: signedIn(), routes: [all, ["/v1/me", { body: { id: "cres1" } }]] });
  const f = (await fresh.music.status()).spotify;
  assert.deepEqual([f.can, f.missing], [{ save: true, recent: true }, []]);
  assert.ok(SOURCES.spotify.scopes.includes("user-library-modify") && SOURCES.spotify.scopes.includes("user-read-recently-played"));
});

test("a missing scope says to sign in again, a rate limit says how long to wait, and list refusals are about the list", async () => {
  const { music } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/recently-played", { status: 403, body: { error: { status: 403, message: "Insufficient client scope" } } }],
      ["/me/player?", { status: 429, headers: { "retry-after": "7" } }], ["/me/player?", { status: 429, headers: { "retry-after": "999" } }],
      ["/playlists/p1/items", { status: 403, body: { error: { message: "Forbidden" } } }], ["/albums/a1/tracks", { status: 404 }]],
  });
  await assert.rejects(music.spotifyRecent(), { code: "scope", status: 403 });
  await assert.rejects(music.spotifyNow(), (e) => e.code === "rate-limited" && /7 seconds/.test(e.message));
  await assert.rejects(music.spotifyNow(), (e) => e.code === "rate-limited" && /a minute/.test(e.message));
  await assert.rejects(music.spotifyTracks({ kind: "playlist", id: "p1" }), { code: "unavailable" });
  await assert.rejects(music.spotifyTracks({ kind: "album", id: "a1" }), { code: "not-found" });
});

test("spotifyControl shuffles, repeats, seeks and queues, on Felix's own player when asked", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/shuffle", { status: 204 }], ["/me/player/repeat", { status: 204 }], ["/me/player/seek", { status: 204 }],
      ["/me/player/queue", { status: 204 }], ["/me/player/shuffle", { status: 404 }]],
  });
  await music.spotifyControl({ action: "shuffle", on: true, device: "felix-1" });
  await music.spotifyControl({ action: "repeat", mode: "track" });
  await music.spotifyControl({ action: "seek", positionMs: 61000, device: "felix-1" });
  await music.spotifyControl({ action: "queue", uri: "spotify:track:abc" });
  await assert.rejects(music.spotifyControl({ action: "shuffle", on: false }), { code: "no-device" });
  assert.deepEqual(paths(net), [
    "/me/player/shuffle?state=true&device_id=felix-1", "/me/player/repeat?state=track", "/me/player/seek?position_ms=61000&device_id=felix-1",
    "/me/player/queue?uri=spotify%3Atrack%3Aabc", "/me/player/shuffle?state=false",
  ]);
  assert.deepEqual(net.calls.slice(1).map((c) => c.init.method), ["PUT", "PUT", "PUT", "POST", "PUT"]);
});

test("spotifyControl refuses a bad repeat, place in the song or song to queue", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN] });
  await assert.rejects(music.spotifyControl({ action: "repeat", mode: "forever" }), { code: "bad-repeat" });
  await assert.rejects(music.spotifyControl({ action: "seek", positionMs: -1 }), { code: "bad-position" });
  await assert.rejects(music.spotifyControl({ action: "seek", positionMs: "12" }), { code: "bad-position" });
  await assert.rejects(music.spotifyControl({ action: "queue", uri: "spotify:playlist:p" }), { code: "bad-uri" });
  await assert.rejects(music.spotifyControl({ action: "save", uri: "nope", on: true }), { code: "bad-uri" });
});

test("play starts a playlist at a song, or a list of songs at a place in it", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/play", { status: 204 }], ["/me/player/play", { status: 204 }], ["/me/player/play", { status: 204 }]],
  });
  await music.spotifyControl({ action: "play", uri: "spotify:playlist:p1", offset: "spotify:track:t2", device: "felix-1" });
  await music.spotifyControl({ action: "play", uris: ["spotify:track:a", "spotify:episode:b"], offset: 1 });
  await music.spotifyControl({ action: "play", uri: "spotify:artist:x" });
  const bodies = net.calls.slice(1).map((c) => JSON.parse(c.init.body));
  assert.deepEqual(bodies, [
    { context_uri: "spotify:playlist:p1", offset: { uri: "spotify:track:t2" } },
    { uris: ["spotify:track:a", "spotify:episode:b"], offset: { position: 1 } },
    { context_uri: "spotify:artist:x" },
  ]);
  assert.match(net.calls[1].url, /device_id=felix-1$/);
});

test("play refuses songs that aren't songs, too many of them, or a bad place to start", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN] });
  await assert.rejects(music.spotifyControl({ action: "play", uris: [] }), { code: "bad-uri" });
  await assert.rejects(music.spotifyControl({ action: "play", uris: "spotify:track:a" }), { code: "bad-uri" });
  await assert.rejects(music.spotifyControl({ action: "play", uris: Array(101).fill("spotify:track:a") }), { code: "bad-uri" });
  await assert.rejects(music.spotifyControl({ action: "play", uris: ["spotify:album:a"] }), { code: "bad-uri" });
  await assert.rejects(music.spotifyControl({ action: "play", uri: "spotify:album:a", offset: -2 }), { code: "bad-uri" });
});

test("saving a song puts it in Liked Songs or takes it out, and an older sign-in is told to sign in again", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/library?", { status: 200 }], ["/me/library?", { status: 200 }], ["/me/library?", { status: 403, body: { error: { message: "Insufficient client scope" } } }]],
  });
  await music.spotifyControl({ action: "save", uri: "spotify:track:abc", on: true });
  await music.spotifyControl({ action: "save", uri: "spotify:track:abc", on: false });
  await assert.rejects(music.spotifyControl({ action: "save", uri: "spotify:track:abc", on: true }), { code: "scope" });
  assert.deepEqual(net.calls.slice(1).map((c) => `${c.init.method} ${c.url.slice(API.length)}`), [
    "PUT /me/library?uris=spotify%3Atrack%3Aabc", "DELETE /me/library?uris=spotify%3Atrack%3Aabc", "PUT /me/library?uris=spotify%3Atrack%3Aabc",
  ]);
});

test("spotifySaved says whether a song is in your Liked Songs", async () => {
  const { music, net } = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/library/contains", { body: [true] }], ["/me/library/contains", { body: [] }]] });
  assert.equal(await music.spotifySaved("spotify:track:abc"), true);
  assert.equal(await music.spotifySaved("spotify:track:abc"), false);
  assert.equal(paths(net)[0], "/me/library/contains?uris=spotify%3Atrack%3Aabc");
  await assert.rejects(music.spotifySaved(undefined), { code: "bad-uri" });
});

test("playlists reads up to four pages of your playlists", async () => {
  const page = (offset, next) => ["/me/playlists", { body: { offset, next, items: [{ id: `p${offset}`, name: "P", uri: `spotify:playlist:p${offset}` }] } }];
  const { music, net } = setup({ secrets: signedIn(), routes: [TOKEN, page(0, "more"), page(50, "more"), page(100, "more"), page(150, "more")] });
  assert.equal((await music.playlists("spotify")).length, 4);
  assert.deepEqual(paths(net), ["/me/playlists?limit=50", "/me/playlists?limit=50&offset=50", "/me/playlists?limit=50&offset=100", "/me/playlists?limit=50&offset=150"]);
  const one = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/playlists", { body: { next: "x" } }], ["/me/playlists", { body: {} }]] });
  assert.deepEqual(await one.music.playlists("spotify"), []);
});

test("spotifyTracks reads a page of a playlist, an album, Liked Songs or an artist's songs, and where the next page starts", async () => {
  const items = (n, wrap) => Array.from({ length: n }, (_, i) => wrap(song(`s${i}`)));
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN,
      ["/playlists/p1/items", { body: { total: 120, items: [...items(49, (t) => ({ item: t })), null] } }],
      ["/playlists/p1/items", { body: { total: 120, items: [{ track: song("old") }] } }],
      ["/albums/a1/tracks", { body: { total: 3, items: items(3, (t) => t) } }],
      ["/me/tracks", { body: { total: 60, items: items(50, (t) => ({ track: t })) } }],
      [/\/search\?/, { body: { tracks: { total: 25, items: items(10, (t) => t) } } }],
      [/\/search\?/, { body: {} }],
      ["/playlists/p2/items", { body: {} }]],
  });
  const first = await music.spotifyTracks({ kind: "playlist", id: "p1" });
  assert.deepEqual([first.tracks.length, first.total, first.next], [49, 120, 50]);
  const old = await music.spotifyTracks({ kind: "playlist", id: "p1", offset: "100" });
  assert.deepEqual([old.tracks[0].title, old.next], ["Song old", null]);
  assert.deepEqual((await music.spotifyTracks({ kind: "album", id: "a1" })).next, null);
  const liked = await music.spotifyTracks({ kind: "liked", offset: -5 });
  assert.deepEqual([liked.tracks.length, liked.next], [50, 50]);
  const artist = await music.spotifyTracks({ kind: "artist", id: "ar1", name: " Daft Punk ", offset: 10 });
  assert.deepEqual([artist.tracks.length, artist.next], [10, 20]);
  assert.deepEqual(await music.spotifyTracks({ kind: "artist", id: "ar1", name: "Nobody" }), { tracks: [], total: 0, next: null });
  assert.deepEqual(await music.spotifyTracks({ kind: "playlist", id: "p2" }), { tracks: [], total: 0, next: null });
  const asked = paths(net);
  assert.equal(asked[0], "/playlists/p1/items?limit=50&offset=0&market=from_token&additional_types=track,episode");
  assert.equal(asked[1], "/playlists/p1/items?limit=50&offset=100&market=from_token&additional_types=track,episode");
  assert.equal(asked[3], "/me/tracks?limit=50&offset=0&market=from_token");
  const search = new URL(API + asked[4]).searchParams;
  assert.deepEqual([search.get("q"), search.get("type"), search.get("limit"), search.get("offset")], ['artist:"Daft Punk"', "track", "10", "10"]);
});

test("spotifyTracks refuses an unknown list, a bad id or an artist with no name", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN] });
  await assert.rejects(music.spotifyTracks({ kind: "radio", id: "x" }), { code: "bad-list" });
  await assert.rejects(music.spotifyTracks({ kind: "playlist", id: "../me" }), { code: "bad-id" });
  await assert.rejects(music.spotifyTracks({ kind: "artist", id: "a1", name: "  " }), { code: "bad-name" });
  await assert.rejects(music.spotifyTracks(), { code: "bad-list" });
});

test("spotifySearch groups a few songs, artists, albums and playlists, and skips Spotify's empty results", async () => {
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, [/\/search\?/, { body: {
      tracks: { items: [song("t1"), null] },
      artists: { items: [1, 2, 3, 4].map((i) => ({ id: `ar${i}`, name: `Artist ${i}`, uri: `spotify:artist:ar${i}`, images: [] })) },
      albums: { items: [{ id: "al1", name: "Album", uri: "spotify:album:al1", artists: [{ name: "A" }, { name: "B" }], total_tracks: 9, images: [{ url: "c" }] }, { id: "al2", name: "Bare", uri: "spotify:album:al2" }] },
      playlists: { items: [null, { id: "p1", name: "Mix", uri: "spotify:playlist:p1", owner: { display_name: "Spotify" }, items: { total: 30 } }, { id: "p2", name: "Mine", uri: "spotify:playlist:p2" }] },
    } }]],
  });
  assert.deepEqual(await music.spotifySearch("   "), { tracks: [], artists: [], albums: [], playlists: [] });
  const r = await music.spotifySearch(" daft punk ");
  assert.deepEqual(r.tracks.map((t) => t.uri), ["spotify:track:t1"]);
  assert.equal(r.artists.length, 3);
  assert.deepEqual(r.albums[0], { id: "al1", name: "Album", image: "c", uri: "spotify:album:al1", artists: "A, B", count: 9 });
  assert.deepEqual([r.albums[1].artists, r.albums[1].count], ["", 0]);
  assert.deepEqual(r.playlists, [
    { id: "p1", name: "Mix", image: null, uri: "spotify:playlist:p1", count: 30, owner: "Spotify" },
    { id: "p2", name: "Mine", image: null, uri: "spotify:playlist:p2", count: 0, owner: null },
  ]);
  const q = new URL(API + paths(net)[0]).searchParams;
  assert.deepEqual([q.get("q"), q.get("type"), q.get("limit")], ["daft punk", "track,artist,album,playlist", "5"]);
  const nothing = setup({ secrets: signedIn(), routes: [TOKEN, [/\/search\?/, { body: {} }]] });
  assert.deepEqual(await nothing.music.spotifySearch(null), { tracks: [], artists: [], albums: [], playlists: [] });
  assert.deepEqual(await nothing.music.spotifySearch("x"), { tracks: [], artists: [], albums: [], playlists: [] });
});

test("spotifyQueue shows what plays now and up to 20 songs up next", async () => {
  const { music } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/queue", { status: 204 }], ["/me/player/queue", { body: { currently_playing: song("now"), queue: [...Array.from({ length: 25 }, (_, i) => song(`q${i}`)), null] } }],
      ["/me/player/queue", { body: { currently_playing: null } }], ["/me/player/queue", { status: 403 }]],
  });
  assert.deepEqual(await music.spotifyQueue(), { current: null, queue: [] });
  const q = await music.spotifyQueue();
  assert.deepEqual([q.current.title, q.queue.length, q.queue[0].uri], ["Song now", 20, "spotify:track:q0"]);
  assert.deepEqual(await music.spotifyQueue(), { current: null, queue: [] });
  await assert.rejects(music.spotifyQueue(), { code: "premium" });
});

test("spotifyRecent lists each song you played last once, newest first", async () => {
  const { music } = setup({
    secrets: signedIn(),
    routes: [TOKEN, ["/me/player/recently-played", { body: { items: [{ track: song("a") }, { track: song("b") }, { track: song("a") }, { track: null }] } }], ["/me/player/recently-played", { body: {} }]],
  });
  assert.deepEqual((await music.spotifyRecent()).map((t) => t.uri), ["spotify:track:a", "spotify:track:b"]);
  assert.deepEqual(await music.spotifyRecent(), []);
});

test("spotifyFind plays Liked Songs, one of your playlists by name, or Spotify's top song or playlist", async () => {
  const mine = ["/me/playlists", { body: { items: [{ id: "p1", name: "Deep Focus", uri: "spotify:playlist:p1" }, { id: "p2", name: "Chill", uri: "spotify:playlist:p2" }] } }];
  const { music, net } = setup({
    secrets: signedIn(),
    routes: [TOKEN, mine, mine, mine,
      [/\/search\?/, { body: { tracks: { items: [null, song("top", { artists: [{ name: "Adele" }] })] } } }],
      [/\/search\?/, { body: { playlists: { items: [{ id: "x", name: "Lo-fi Beats", uri: "spotify:playlist:x" }] } } }],
      [/\/search\?/, { body: { tracks: { items: [] } } }],
      [/\/search\?/, { body: {} }]],
  });
  assert.deepEqual(await music.spotifyFind({ q: "My Liked Songs" }), { type: "liked", name: "Liked Songs" });
  assert.deepEqual(await music.spotifyFind({ q: "chill" }), { type: "playlist", name: "Chill", uri: "spotify:playlist:p2" });
  assert.deepEqual(await music.spotifyFind({ q: "focus", kind: "playlist" }), { type: "playlist", name: "Deep Focus", uri: "spotify:playlist:p1" });
  assert.deepEqual(await music.spotifyFind({ q: "hello", kind: "any" }), { type: "track", name: "Song top", uri: "spotify:track:top", artists: "Adele" });
  assert.deepEqual(await music.spotifyFind({ q: "lofi", kind: "track" }).catch(() => null), null);
  const lofi = setup({ secrets: signedIn(), routes: [TOKEN, ["/me/playlists", { body: { items: [] } }], [/\/search\?/, { body: { playlists: { items: [{ id: "x", name: "Lo-fi Beats", uri: "spotify:playlist:x" }] } } }]] });
  assert.deepEqual(await lofi.music.spotifyFind({ q: "lofi", kind: "playlist" }), { type: "playlist", name: "Lo-fi Beats", uri: "spotify:playlist:x" });
  await assert.rejects(music.spotifyFind({ q: "zzz", kind: "track" }), { code: "not-found", status: 404 });
  assert.equal(paths(net).filter((p) => p.startsWith("/me/playlists")).length, 3);
});

test("spotifyFind needs something to find, and a kind it knows", async () => {
  const { music } = setup({ secrets: signedIn(), routes: [TOKEN] });
  await assert.rejects(music.spotifyFind({ q: " " }), { code: "bad-query" });
  await assert.rejects(music.spotifyFind(), { code: "bad-query" });
  await assert.rejects(music.spotifyFind({ q: "x", kind: "podcast" }), { code: "bad-kind" });
  await assert.rejects(music.spotifyFind({ q: "my liked songs", kind: "track" }), { code: "network" });
});
