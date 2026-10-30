/**
 * Felix's music source: Spotify, signed in with OAuth and PKCE in the browser through Felix's own Spotify app (its
 * Client ID is public; PKCE needs no secret). The server keeps the sign-in in the Keychain and gives the page only
 * what it shows, plus a short-lived token for Felix's own
 * player in the page (Spotify's Web Playback SDK), so music plays in Felix without the Spotify app. Playback is
 * controlled through Spotify's Web API (Premium only, Spotify's rule).
 */
import { createHash, randomBytes } from "node:crypto";
import { codedError, deleteKeychain, readKeychain, writeKeychain } from "./keychain.mjs";

const SPOTIFY_API = "https://api.spotify.com/v1";
const PENDING_MS = 10 * 60e3;
const ACCOUNT_RETRY_MS = 60e3;
const PLAYER_SCOPES = ["user-read-playback-state", "user-modify-playback-state", "user-read-currently-playing", "playlist-read-private", "user-library-read", "streaming", "user-read-email", "user-read-private"];

/**
 * Each source's sign-in details, and where to read the signed-in account's name. `scopes` is everything a sign-in
 * asks for; `needs` is what the player can't work without (a sign-in missing one is outdated); `extras` names the
 * extras a newer scope turns on, which an older sign-in simply doesn't show until you sign in again.
 */
export const SOURCES = Object.freeze({
  spotify: {
    name: "Spotify",
    service: "cmd-center-spotify",
    clientId: "c934c3cf5cbf4f68ac4f2c50aa608c13",
    authorize: "https://accounts.spotify.com/authorize",
    token: "https://accounts.spotify.com/api/token",
    scopes: [...PLAYER_SCOPES, "user-library-modify", "user-read-recently-played"],
    needs: PLAYER_SCOPES,
    extras: { save: "user-library-modify", recent: "user-read-recently-played" },
    profile: `${SPOTIFY_API}/me`,
    accountName: (me) => me.display_name || me.id || null,
  },
});
const DEVICE_ID = /^[\w-]{1,100}$/;
const SPOTIFY_ID = /^[A-Za-z0-9]{1,64}$/;
const TRACK_URI = /^spotify:(track|episode):[A-Za-z0-9]{1,64}$/;
const CONTEXT_URI = /^spotify:[\w:]+$/;
const REPEAT = ["off", "context", "track"];
const PAGE = 50;
const SEARCH_LIMIT = 10;
const UP_NEXT_MAX = 20;
const URIS_MAX = 100;
const LIKED = /^(my )?(liked|saved|favou?rite) (songs|tracks|music)$|^my likes$/;

/**
 * An error the server answers with its status.
 * @param {number} status
 * @param {string} code
 * @param {string} message
 * @returns {Error & { code: string, status: number }}
 */
const failure = (status, code, message) => Object.assign(codedError(code, message), { status });

/**
 * The source for an id from a request.
 * @param {string} id
 * @returns {typeof SOURCES.spotify}
 * @throws {Error} 400 for an unknown source.
 */
function sourceFor(id) {
  if (!Object.hasOwn(SOURCES, id)) throw failure(400, "bad-source", `There is no music source called "${id}".`);
  return SOURCES[id];
}

/**
 * The small Spotify picture closest to 300 pixels, for the player.
 * @param {Array<{ url: string, width?: number | null }> | undefined} images Largest first, as Spotify sends them.
 * @returns {string | null}
 */
const pickImage = (images = []) => (images.find((i) => (i.width ?? 0) <= 300) || images[0])?.url || null;

/**
 * One song (or podcast episode) as the player lists it.
 * @param {object} t A Spotify track or episode.
 * @param {string | null} [art] The picture to use when the song has none of its own, like its album's.
 * @returns {{ id: string | null, uri: string, title: string, artists: string, art: string | null, durationMs: number, playable: boolean }}
 */
export function trackRow(t, art = null) {
  return {
    id: t.id ?? null,
    uri: t.uri,
    title: t.name,
    artists: (t.artists || [t.show]).map((a) => a?.name).filter(Boolean).join(", "),
    art: pickImage(t.album?.images || t.images) || art,
    durationMs: t.duration_ms ?? 0,
    playable: t.is_playable !== false && !t.is_local,
  };
}

/**
 * What the player shows from Spotify's playback state.
 * @param {object | null} p The /me/player answer, null when nothing is set to play.
 * @returns {{ playing: boolean, progressMs: number, shuffle: boolean, repeat: string, context: string | null, track: object | null, device: object | null }}
 */
export function spotifyNowPlaying(p) {
  const item = p?.item;
  const track = item ? { ...trackRow(item), album: item.album?.name ?? null, url: item.external_urls?.spotify || null } : null;
  const device = p?.device
    ? { id: p.device.id ?? null, name: p.device.name, volume: p.device.volume_percent ?? null, supportsVolume: p.device.supports_volume !== false }
    : null;
  return {
    playing: Boolean(p?.is_playing), progressMs: p?.progress_ms ?? 0, shuffle: Boolean(p?.shuffle_state),
    repeat: REPEAT.includes(p?.repeat_state) ? p.repeat_state : "off", context: p?.context?.uri ?? null, track, device,
  };
}

/**
 * Words to compare names by: lowercase letters and numbers, single spaces.
 * @param {unknown} s
 * @returns {string}
 */
const words = (s) => String(s ?? "").toLowerCase().normalize("NFKD").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/**
 * The playlist you meant by name: the same name, or, when `loose`, one that starts with or holds those words.
 * @param {Array<{ name: string }>} lists
 * @param {string} said
 * @param {boolean} loose
 * @returns {object | undefined}
 */
export function playlistNamed(lists, said, loose) {
  const want = words(said);
  const named = lists.map((p) => [p, words(p.name)]);
  const exact = named.find(([, n]) => n === want);
  if (exact || !loose) return exact?.[0];
  return (named.find(([, n]) => n.startsWith(`${want} `)) || named.find(([, n]) => ` ${n} `.includes(` ${want} `)))?.[0];
}

/**
 * Builds the music service.
 * @param {object} deps
 * @param {string} deps.redirectBase Where the sign-in comes back, like "http://127.0.0.1:4777".
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {{ read: typeof readKeychain, write: typeof writeKeychain, remove: typeof deleteKeychain }} [deps.secrets]
 * @param {() => number} [deps.now]
 * @param {(size: number) => Buffer} [deps.random]
 */
export function createMusic({ redirectBase, fetchImpl = fetch, secrets = { read: readKeychain, write: writeKeychain, remove: deleteKeychain }, now = Date.now, random = randomBytes }) {
  const pending = new Map();
  const tokens = new Map();
  const accounts = new Map();
  const errors = new Map();

  const redirectUri = (id) => `${redirectBase}/api/music/callback/${id}`;
  const read = (id, account) => secrets.read(SOURCES[id].service, account);

  /**
   * Whether the sign-in is from before Felix asked for something it needs now, like playing Spotify itself.
   * Unknown until the first token of this run.
   * @param {string} id
   * @returns {boolean}
   */
  function lacksScopes(id) {
    const granted = tokens.get(id)?.scope?.split(" ");
    return Boolean(granted) && SOURCES[id].needs.some((scope) => !granted.includes(scope));
  }

  /**
   * Which extras the sign-in allows, and the scopes it lacks for the others. Both are empty until the first token
   * of this run says what the sign-in allows.
   * @param {string} id
   * @returns {{ can: Record<string, boolean>, missing: string[] }}
   */
  function extrasFor(id) {
    const granted = tokens.get(id)?.scope?.split(" ");
    const extras = Object.entries(SOURCES[id].extras);
    return {
      can: Object.fromEntries(extras.map(([extra, scope]) => [extra, Boolean(granted?.includes(scope))])),
      missing: granted ? extras.map(([, scope]) => scope).filter((scope) => !granted.includes(scope)) : [],
    };
  }

  /**
   * The signed-in account's name, asked for once and remembered; a failed ask is tried again after a minute.
   * @param {string} id
   * @returns {Promise<string | null>}
   */
  async function accountName(id) {
    const known = accounts.get(id);
    if (known && (known.name || now() - known.at < ACCOUNT_RETRY_MS)) return known.name;
    let name = null;
    try {
      const res = await call(id, SOURCES[id].profile);
      if (res.ok) name = SOURCES[id].accountName(await res.json());
    } catch {
      name = null;
    }
    accounts.set(id, { name, at: now() });
    return name;
  }

  /**
   * One source's sign-in: signed in as whom, whether it needs redoing, and why the last sign-in failed.
   * @param {string} id
   * `can` says which extras (saving songs, recently played) the sign-in allows, and `missing` the scopes a new
   * sign-in would add for the rest.
   * @returns {Promise<[string, { name: string, connected: boolean, outdated: boolean, account: string | null, error: string | null, can: Record<string, boolean>, missing: string[] }]>}
   */
  async function sourceStatus(id) {
    const connected = Boolean(await read(id, "refresh-token"));
    const account = connected ? await accountName(id) : null;
    const outdated = connected && lacksScopes(id);
    const { can, missing } = extrasFor(id);
    return [id, { name: SOURCES[id].name, connected, outdated, account, error: errors.get(id) || null, can, missing }];
  }

  /**
   * Each source's sign-in.
   * @returns {Promise<Record<string, Awaited<ReturnType<typeof sourceStatus>>[1]>>}
   */
  const status = async () => Object.fromEntries(await Promise.all(Object.keys(SOURCES).map(sourceStatus)));

  /**
   * Signs a source out.
   * @param {string} id
   * @returns {Promise<void>}
   */
  async function disconnect(id) {
    sourceFor(id);
    tokens.delete(id);
    accounts.delete(id);
    await secrets.remove(SOURCES[id].service, "refresh-token");
  }

  /**
   * The address that starts a source's sign-in, remembered for 10 minutes.
   * @param {string} id
   * @param {string} returnTo Where to send the browser after.
   * @returns {string}
   * @throws {Error} 400 for an unknown source.
   */
  function connectUrl(id, returnTo) {
    const s = sourceFor(id);
    errors.delete(id);
    for (const [key, p] of pending) if (p.expires < now()) pending.delete(key);
    const verifier = random(32).toString("base64url");
    const state = random(16).toString("base64url");
    pending.set(state, { id, verifier, returnTo, expires: now() + PENDING_MS });
    const params = new URLSearchParams({
      client_id: s.clientId, response_type: "code", redirect_uri: redirectUri(id), scope: s.scopes.join(" "), state,
      code_challenge_method: "S256", code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    });
    return `${s.authorize}?${params}`;
  }

  /**
   * Asks a source's sign-in server for tokens, and keeps them.
   * @param {string} id
   * @param {Record<string, string>} form
   * @returns {Promise<string>} The access token.
   * @throws {Error} "expired" when the sign-in is no longer good.
   */
  async function requestTokens(id, form) {
    const s = SOURCES[id];
    const body = new URLSearchParams({ ...form, client_id: s.clientId });
    const res = await fetchImpl(s.token, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (form.grant_type === "refresh_token") await disconnect(id);
      throw failure(401, "expired", `${s.name} didn't accept the sign-in (${answer.error || res.status}). Sign in again in Settings → Music.`);
    }
    if (answer.refresh_token) await secrets.write(s.service, "refresh-token", answer.refresh_token);
    tokens.set(id, { access: answer.access_token, expires: now() + (answer.expires_in ?? 3600) * 1000, scope: answer.scope ?? tokens.get(id)?.scope });
    return answer.access_token;
  }

  /**
   * Finishes a sign-in from the source's redirect. Why it failed shows in the source's status until the next try.
   * @param {string} id
   * @param {{ code?: string | null, state?: string | null, error?: string | null }} query
   * @returns {Promise<string>} Where to send the browser.
   * @throws {Error & { returnTo?: string }} When the sign-in was refused, cancelled or too old.
   */
  async function finish(id, { code, state, error }) {
    const s = sourceFor(id);
    const p = pending.get(String(state));
    pending.delete(String(state));
    try {
      if (!p || p.id !== id || p.expires < now()) throw failure(400, "stale", `That ${s.name} sign-in took too long. Click Sign in again.`);
      if (error || !code) throw failure(400, "denied", `The ${s.name} sign-in was cancelled.`);
      await requestTokens(id, { grant_type: "authorization_code", code, redirect_uri: redirectUri(id), code_verifier: p.verifier });
      accounts.delete(id);
      return p.returnTo;
    } catch (e) {
      errors.set(id, e.message);
      throw Object.assign(e, { returnTo: p?.returnTo });
    }
  }

  /**
   * A current access token for a source, renewed from the saved sign-in when needed.
   * @param {string} id
   * @returns {Promise<string>}
   * @throws {Error} "not-connected" when the source isn't signed in.
   */
  async function accessToken(id) {
    const t = tokens.get(id);
    if (t && t.expires - 60e3 > now()) return t.access;
    const refresh = await read(id, "refresh-token");
    if (!refresh) throw failure(409, "not-connected", `${SOURCES[id].name} isn't signed in. Sign in from Settings → Music.`);
    return requestTokens(id, { grant_type: "refresh_token", refresh_token: refresh });
  }

  /**
   * Calls a source's API as you.
   * @param {string} id
   * @param {string} url
   * @param {RequestInit} [init]
   * @returns {Promise<Response>}
   */
  async function call(id, url, init = {}) {
    const headers = { Authorization: `Bearer ${await accessToken(id)}`, ...(init.body ? { "Content-Type": "application/json" } : {}) };
    try {
      return await fetchImpl(url, { ...init, headers });
    } catch {
      throw failure(502, "network", `Couldn't reach ${SOURCES[id].name}.`);
    }
  }

  /**
   * Turns a failed Spotify answer into a plain explanation. A sign-in without the scope asked for says to sign in
   * again; when reading a list (`browsing`), a refusal or a 404 is about that list, not about Premium or a device.
   * @param {Response} res
   * @param {boolean} [browsing]
   * @returns {Promise<Error>}
   */
  async function spotifyFailure(res, browsing = false) {
    const { reason, message } = (await res.json().catch(() => ({})))?.error || {};
    if (res.status === 401) tokens.delete("spotify");
    if (res.status === 403 && /scope/i.test(message || "")) return failure(403, "scope", "Sign in to Spotify again so Felix can do this. Settings → Music has the button.");
    if (res.status === 429) {
      const wait = Number(res.headers?.get?.("retry-after"));
      return failure(429, "rate-limited", `Spotify asked Felix to slow down. Try again in ${wait > 0 && wait < 120 ? `${Math.ceil(wait)} seconds` : "a minute"}.`);
    }
    if (browsing && res.status === 403) return failure(403, "unavailable", "Spotify doesn't let apps like Felix list the songs in this one.");
    if (browsing && res.status === 404) return failure(404, "not-found", "Spotify couldn't find that.");
    if (res.status === 403 || reason === "PREMIUM_REQUIRED") return failure(403, "premium", "Playing and controlling Spotify needs Spotify Premium. Felix can still show what's playing.");
    if (res.status === 404 || reason === "NO_ACTIVE_DEVICE") return failure(409, "no-device", "Felix's Spotify player isn't ready yet. Wait a moment, or reload the page.");
    return failure(502, "http", `Spotify answered ${res.status}.`);
  }

  /**
   * What Spotify is playing now, on any of your devices.
   * @returns {Promise<ReturnType<typeof spotifyNowPlaying>>}
   */
  async function spotifyNow() {
    const res = await call("spotify", `${SPOTIFY_API}/me/player?additional_types=track,episode`);
    if (res.status === 204) return spotifyNowPlaying(null);
    if (!res.ok) throw await spotifyFailure(res);
    return spotifyNowPlaying(await res.json());
  }

  /**
   * A Spotify device to play on when none is active: this Mac's app first.
   * @returns {Promise<string | null>}
   */
  async function spotifyDevice() {
    const res = await call("spotify", `${SPOTIFY_API}/me/player/devices`);
    const devices = res.ok ? (await res.json()).devices || [] : [];
    return (devices.find((d) => d.type === "Computer") || devices[0])?.id || null;
  }

  /**
   * What to send Spotify to start playing: a playlist, album or artist from its start or from a song in it, or a
   * list of songs from one of them.
   * @param {{ uri?: string, uris?: string[], offset?: number | string }} what
   * @returns {string | undefined} The request body, or nothing to carry on where it was.
   */
  function playBody({ uri, uris, offset }) {
    if (!uri && !uris) return undefined;
    const body = uri ? { context_uri: uri } : { uris };
    if (offset !== undefined) body.offset = typeof offset === "number" ? { position: offset } : { uri: offset };
    return JSON.stringify(body);
  }

  /**
   * Plays, on the device asked for, else the active one, else another of yours.
   * @param {Parameters<typeof playBody>[0]} what Nothing to carry on.
   * @param {string | undefined} device
   * @returns {Promise<void>}
   */
  async function spotifyPlay(what, device) {
    const body = playBody(what);
    const playOn = (id) => call("spotify", `${SPOTIFY_API}/me/player/play${id ? `?device_id=${encodeURIComponent(id)}` : ""}`, { method: "PUT", body });
    let res = await playOn(device);
    if (res.status === 404 && !device) {
      const other = await spotifyDevice();
      if (other) res = await playOn(other);
    }
    if (!res.ok) throw await spotifyFailure(res);
  }

  /**
   * Moves playback to a device, such as Felix's own player after a page change.
   * @param {string} device
   * @param {boolean} play Whether to carry on playing there.
   * @returns {Promise<void>}
   */
  async function spotifyTransfer(device, play) {
    const res = await call("spotify", `${SPOTIFY_API}/me/player`, { method: "PUT", body: JSON.stringify({ device_ids: [device], play }) });
    if (!res.ok) throw await spotifyFailure(res);
  }

  /**
   * A device id from a request, or undefined for none.
   * @param {unknown} device
   * @returns {string | undefined}
   * @throws {Error} 400 when it doesn't look like one.
   */
  function deviceFrom(device) {
    if (device === undefined || device === null || device === "") return undefined;
    if (!DEVICE_ID.test(String(device))) throw failure(400, "bad-device", "That isn't a Spotify device.");
    return String(device);
  }

  /**
   * A song's Spotify address from a request.
   * @param {unknown} uri
   * @returns {string}
   * @throws {Error} 400 when it isn't one.
   */
  function trackUri(uri) {
    if (!TRACK_URI.test(String(uri))) throw failure(400, "bad-uri", "That isn't a Spotify song.");
    return String(uri);
  }

  /**
   * What a play request asks for, checked: a playlist, album or artist (`uri`), or songs (`uris`), and where to
   * start in it (`offset`, a position or a song).
   * @param {{ uri?: unknown, uris?: unknown, offset?: unknown }} body
   * @returns {Parameters<typeof playBody>[0]}
   * @throws {Error} 400 for a bad value.
   */
  function playRequest({ uri, uris, offset }) {
    if (uri !== undefined && !CONTEXT_URI.test(String(uri))) throw failure(400, "bad-uri", "That isn't a Spotify playlist.");
    if (uris !== undefined && !(Array.isArray(uris) && uris.length && uris.length <= URIS_MAX)) throw failure(400, "bad-uri", `Send between 1 and ${URIS_MAX} songs.`);
    const what = { uri: uri === undefined ? undefined : String(uri), uris: uris?.map(trackUri) };
    if (offset !== undefined) what.offset = Number.isInteger(offset) && offset >= 0 ? offset : trackUri(offset);
    return what;
  }

  /**
   * The simple player steps, each with its method, its path under /me/player and its checked query.
   * @type {Record<string, (body: Record<string, unknown>) => [string, string, Record<string, string>?]>}
   */
  const STEPS = {
    pause: () => ["PUT", "pause"],
    next: () => ["POST", "next"],
    previous: () => ["POST", "previous"],
    volume: ({ volume }) => {
      if (!(Number(volume) >= 0 && Number(volume) <= 100)) throw failure(400, "bad-volume", "The volume goes from 0 to 100.");
      return ["PUT", "volume", { volume_percent: String(Math.round(Number(volume))) }];
    },
    shuffle: ({ on }) => ["PUT", "shuffle", { state: String(Boolean(on)) }],
    repeat: ({ mode }) => {
      if (!REPEAT.includes(mode)) throw failure(400, "bad-repeat", "Repeat is off, context or track.");
      return ["PUT", "repeat", { state: mode }];
    },
    seek: ({ positionMs }) => {
      if (!(Number.isInteger(positionMs) && positionMs >= 0)) throw failure(400, "bad-position", "Say where in the song to go, in milliseconds.");
      return ["PUT", "seek", { position_ms: String(positionMs) }];
    },
    queue: ({ uri }) => ["POST", "queue", { uri: trackUri(uri) }],
  };

  /**
   * Saves a song to your Liked Songs, or takes it out. Needs the newer sign-in (user-library-modify).
   * @param {unknown} uri
   * @param {boolean} on
   * @returns {Promise<void>}
   */
  async function spotifySave(uri, on) {
    const res = await call("spotify", `${SPOTIFY_API}/me/library?${new URLSearchParams({ uris: trackUri(uri) })}`, { method: on ? "PUT" : "DELETE" });
    if (!res.ok) throw await spotifyFailure(res);
  }

  /**
   * Plays, pauses, skips, seeks, shuffles, repeats, queues, saves, moves playback or sets the volume in Spotify.
   * Every step but saving goes to `device` when one is given, like Felix's own player.
   * @param {{ action?: unknown, device?: unknown, play?: unknown, uri?: unknown, on?: unknown } & Record<string, unknown>} body
   * @returns {Promise<void>}
   * @throws {Error} 400 for an unknown action or a bad value.
   */
  async function spotifyControl(body = {}) {
    const { action, device, play } = body;
    if (action === "play") return spotifyPlay(playRequest(body), deviceFrom(device));
    if (action === "save") return spotifySave(body.uri, Boolean(body.on));
    if (action === "transfer") {
      const to = deviceFrom(device);
      if (!to) throw failure(400, "bad-device", "Say which device to move playback to.");
      return spotifyTransfer(to, Boolean(play));
    }
    if (!Object.hasOwn(STEPS, String(action))) throw failure(400, "bad-action", `Spotify can't "${action}".`);
    const [method, step, query = {}] = STEPS[action](body);
    const target = deviceFrom(device);
    const params = new URLSearchParams(target ? { ...query, device_id: target } : query);
    const res = await call("spotify", `${SPOTIFY_API}/me/player/${step}${params.size ? `?${params}` : ""}`, { method });
    if (!res.ok) throw await spotifyFailure(res);
  }

  /**
   * Reads a Spotify list, explaining a refusal as being about that list.
   * @param {string} path Under the Web API, with its query.
   * @returns {Promise<any>}
   */
  async function browse(path) {
    const res = await call("spotify", `${SPOTIFY_API}${path}`);
    if (!res.ok) throw await spotifyFailure(res, true);
    return res.json();
  }

  /**
   * Your Spotify playlists, up to 200.
   * @returns {Promise<Array<{ id: string, name: string, image: string | null, count: number, uri: string }>>}
   */
  async function spotifyPlaylists() {
    const all = [];
    let path = `/me/playlists?limit=${PAGE}`;
    for (let page = 0; path && page < 4; page++) {
      const answer = await browse(path);
      all.push(...(answer.items || []));
      path = answer.next ? `/me/playlists?limit=${PAGE}&offset=${(answer.offset ?? 0) + PAGE}` : null;
    }
    return all.filter(Boolean).map((p) => ({ id: p.id, name: p.name, image: pickImage(p.images || []), count: (p.items || p.tracks)?.total ?? 0, uri: p.uri }));
  }

  /**
   * A source's playlists.
   * @param {string} id
   * @returns {Promise<Awaited<ReturnType<typeof spotifyPlaylists>>>}
   */
  const playlists = async (id) => {
    sourceFor(id);
    return spotifyPlaylists();
  };

  /**
   * Where each kind of list reads its songs, and how to find them in the answer. An artist's list is a search for
   * their songs, since Spotify no longer lets apps like Felix read an artist's top tracks.
   * @type {Record<string, { path: (id: string, offset: number, name: string) => string, songs: (answer: any) => { items: any[], total: number }, size: number }>}
   */
  const LISTS = {
    playlist: { path: (id, offset) => `/playlists/${id}/items?limit=${PAGE}&offset=${offset}&market=from_token&additional_types=track,episode`, songs: (a) => ({ items: (a.items || []).map((i) => i?.item || i?.track), total: a.total }), size: PAGE },
    album: { path: (id, offset) => `/albums/${id}/tracks?limit=${PAGE}&offset=${offset}&market=from_token`, songs: (a) => a, size: PAGE },
    liked: { path: (id, offset) => `/me/tracks?limit=${PAGE}&offset=${offset}&market=from_token`, songs: (a) => ({ items: (a.items || []).map((i) => i?.track), total: a.total }), size: PAGE },
    artist: {
      path: (id, offset, name) => `/search?${new URLSearchParams({ q: `artist:"${name}"`, type: "track", limit: String(SEARCH_LIMIT), offset: String(offset), market: "from_token" })}`,
      songs: (a) => a.tracks, size: SEARCH_LIMIT,
    },
  };

  /**
   * One page of a playlist's, album's, artist's or your Liked Songs' songs.
   * @param {{ kind?: unknown, id?: unknown, name?: unknown, offset?: unknown }} q
   * @returns {Promise<{ tracks: ReturnType<typeof trackRow>[], total: number, next: number | null }>} `next` is the
   *   offset of the next page, or null on the last.
   * @throws {Error} 400 for an unknown list or a bad id.
   */
  async function spotifyTracks({ kind, id, name, offset } = {}) {
    if (!Object.hasOwn(LISTS, String(kind))) throw failure(400, "bad-list", "That isn't a kind of Spotify list.");
    if (kind !== "liked" && !SPOTIFY_ID.test(String(id))) throw failure(400, "bad-id", "That isn't a Spotify id.");
    if (kind === "artist" && !String(name ?? "").trim()) throw failure(400, "bad-name", "Say which artist.");
    const from = Math.max(0, Math.min(10000, Math.floor(Number(offset)) || 0));
    const list = LISTS[kind];
    const { items = [], total = 0 } = list.songs(await browse(list.path(String(id), from, String(name ?? "").trim().slice(0, 200)))) || {};
    const tracks = items.filter((t) => t?.uri).map((t) => trackRow(t));
    const next = from + list.size;
    return { tracks, total, next: items.length === list.size && next < total ? next : null };
  }

  /**
   * Spotify's songs, artists, albums and playlists for what you typed, a few of each.
   * @param {unknown} q
   * @returns {Promise<{ tracks: object[], artists: object[], albums: object[], playlists: object[] }>}
   */
  async function spotifySearch(q) {
    const text = String(q ?? "").trim().slice(0, 200);
    if (!text) return { tracks: [], artists: [], albums: [], playlists: [] };
    const answer = await browse(`/search?${new URLSearchParams({ q: text, type: "track,artist,album,playlist", limit: "5", market: "from_token" })}`);
    const items = (kind) => (answer[kind]?.items || []).filter((x) => x?.uri);
    return {
      tracks: items("tracks").map((t) => trackRow(t)),
      artists: items("artists").slice(0, 3).map((a) => ({ id: a.id, name: a.name, image: pickImage(a.images), uri: a.uri })),
      albums: items("albums").slice(0, 3).map((a) => ({ id: a.id, name: a.name, image: pickImage(a.images), uri: a.uri, artists: (a.artists || []).map((x) => x.name).join(", "), count: a.total_tracks ?? 0 })),
      playlists: items("playlists").slice(0, 3).map((p) => ({ id: p.id, name: p.name, image: pickImage(p.images || []), uri: p.uri, count: (p.items || p.tracks)?.total ?? 0, owner: p.owner?.display_name || null })),
    };
  }

  /**
   * What plays now and up next, from Spotify's queue.
   * @returns {Promise<{ current: ReturnType<typeof trackRow> | null, queue: ReturnType<typeof trackRow>[] }>}
   */
  async function spotifyQueue() {
    const res = await call("spotify", `${SPOTIFY_API}/me/player/queue`);
    if (res.status === 204) return { current: null, queue: [] };
    if (!res.ok) throw await spotifyFailure(res);
    const answer = await res.json();
    return {
      current: answer.currently_playing ? trackRow(answer.currently_playing) : null,
      queue: (answer.queue || []).filter((t) => t?.uri).slice(0, UP_NEXT_MAX).map((t) => trackRow(t)),
    };
  }

  /**
   * The songs you played last, each once, newest first. Needs the newer sign-in (user-read-recently-played).
   * @returns {Promise<ReturnType<typeof trackRow>[]>}
   */
  async function spotifyRecent() {
    const answer = await browse("/me/player/recently-played?limit=30");
    const seen = new Set();
    return (answer.items || []).map((i) => i.track).filter((t) => t?.uri && !seen.has(t.uri) && seen.add(t.uri)).slice(0, UP_NEXT_MAX).map((t) => trackRow(t));
  }

  /**
   * Whether a song is in your Liked Songs.
   * @param {unknown} uri
   * @returns {Promise<boolean>}
   */
  async function spotifySaved(uri) {
    const answer = await browse(`/me/library/contains?${new URLSearchParams({ uris: trackUri(uri) })}`);
    return Boolean(answer?.[0]);
  }

  /**
   * What to play for something you said, like "focus" or "my liked songs": one of your playlists with that name
   * first (for `kind` "playlist", one whose name starts with or holds those words), else Spotify's top song (or
   * playlist) for it.
   * @param {{ q?: unknown, kind?: unknown }} ask `kind` is "any", "playlist" or "track".
   * @returns {Promise<{ type: "liked" | "playlist" | "track", name: string, uri?: string, artists?: string }>}
   * @throws {Error} 404 "not-found" when Spotify has nothing for it.
   */
  async function spotifyFind({ q, kind = "any" } = {}) {
    const text = String(q ?? "").trim().slice(0, 200);
    if (!text) throw failure(400, "bad-query", "Say what to play.");
    if (!["any", "playlist", "track"].includes(kind)) throw failure(400, "bad-kind", "Find a playlist, a track or either.");
    if (kind !== "track" && LIKED.test(words(text))) return { type: "liked", name: "Liked Songs" };
    if (kind !== "track") {
      const mine = playlistNamed(await spotifyPlaylists(), text, kind === "playlist");
      if (mine) return { type: "playlist", name: mine.name, uri: mine.uri };
    }
    const type = kind === "playlist" ? "playlist" : "track";
    const answer = await browse(`/search?${new URLSearchParams({ q: text, type, limit: "1", market: "from_token" })}`);
    const top = (answer[`${type}s`]?.items || []).find((x) => x?.uri);
    if (!top) throw failure(404, "not-found", `Spotify has nothing for "${text}".`);
    return type === "track" ? { type, name: top.name, uri: top.uri, artists: trackRow(top).artists } : { type, name: top.name, uri: top.uri };
  }

  /**
   * A current Spotify token for Felix's own player in the page, which plays music without the Spotify app.
   * @returns {Promise<string>}
   * @throws {Error} 409 "sign-in-again" when the sign-in is from before Felix could play music itself.
   */
  async function spotifyToken() {
    const token = await accessToken("spotify");
    if (lacksScopes("spotify")) throw failure(409, "sign-in-again", "Sign in to Spotify again in Settings → Music so Felix can play music itself.");
    return token;
  }

  return {
    status, disconnect, connectUrl, finish, spotifyNow, spotifyControl, spotifyToken, playlists,
    spotifyTracks, spotifySearch, spotifyQueue, spotifyRecent, spotifySaved, spotifyFind,
  };
}
