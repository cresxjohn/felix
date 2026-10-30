/**
 * Caches for the sources Felix reads often but that are slow to load (GitHub's PR list takes about 2 seconds).
 * Fresh data is returned as is. Older data, up to a limit, is returned at once while a new copy loads behind it,
 * so a question doesn't wait and the next one gets newer data. Loads asked for together share one request. The
 * cards' own reloads fill the same cache, so while a card is on screen Felix rarely has to load anything.
 */

const KEEP = 50;

/**
 * @template T
 * @typedef {{ at: number, data: T | null, pending: Promise<T> | null }} Entry
 */

/**
 * Data stamped with when it was loaded, unless it says so itself, so Felix can say how recent it is.
 * @template T
 * @param {T} data
 * @param {number} at
 * @returns {T}
 */
function stamped(data, at) {
  if (!data || typeof data !== "object" || Array.isArray(data) || "fetchedAt" in data) return data;
  return { ...data, fetchedAt: new Date(at).toISOString() };
}

/**
 * Creates a cache over a loader.
 * @template A, T
 * @param {{ load: (arg: A) => Promise<T>, key?: (arg: A) => string, freshMs: number, staleMs: number, now?: () => number }} options
 *   `freshMs`: returned as is while younger. `staleMs`: returned while a new copy loads, while younger.
 * @returns {{ get: (arg?: A) => Promise<T>, refresh: (arg?: A) => Promise<T> }}
 */
export function createCache({ load, key = () => "", freshMs, staleMs, now = Date.now }) {
  /** @type {Map<string, Entry<T>>} */
  const entries = new Map();

  /**
   * The entry for a key, made when missing; the oldest go once there are too many.
   * @param {string} k
   * @returns {Entry<T>}
   */
  function entryFor(k) {
    let e = entries.get(k);
    if (!e) {
      e = { at: 0, data: null, pending: null };
      entries.set(k, e);
      if (entries.size > KEEP) entries.delete(entries.keys().next().value);
    }
    return e;
  }

  /**
   * Loads a new copy now, or joins the load already running, and keeps it.
   * @param {A} [arg]
   * @returns {Promise<T>}
   */
  function refresh(arg) {
    const e = entryFor(key(arg));
    e.pending ||= load(arg).then(
      (data) => {
        Object.assign(e, { at: now(), data: stamped(data, now()), pending: null });
        return e.data;
      },
      (err) => {
        e.pending = null;
        throw err;
      },
    );
    return e.pending;
  }

  /**
   * The data, from the cache when it's recent enough; somewhat old data comes back at once while it reloads.
   * @param {A} [arg]
   * @returns {Promise<T>}
   */
  function get(arg) {
    const e = entries.get(key(arg));
    const age = e && e.data !== null ? now() - e.at : Infinity;
    if (age < freshMs) return Promise.resolve(e.data);
    if (age < staleMs) {
      refresh(arg).catch(() => {});
      return Promise.resolve(e.data);
    }
    return refresh(arg);
  }

  return { get, refresh };
}
