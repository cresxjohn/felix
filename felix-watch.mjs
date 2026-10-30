/**
 * Watchers: "tell me when CI passes on fm#123", "let me know when Brian approves it". Each is a condition on a PR
 * that Felix checks against the Open PRs data every minute; when it comes true, he tells you once (on screen, and
 * aloud when replies are read aloud), and the watcher ends. They're kept in data/felix/watchers.json, so a restart
 * keeps them, and you can list or cancel them. They only read; a watcher never does anything on GitHub.
 */
import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";

const PR_REF = /\b(fm|bm) ?#? ?(\d{1,6})\b/i;
const NOBODY = new Set(["it", "someone", "somebody", "anyone", "anybody", "they", "he", "she", "a", "the", "my", "pr", "this", "that", "reviewer", "gets", "is", "was"]);

/**
 * @typedef {{ id: string, ref: string, kind: "checks-pass" | "checks-fail" | "approved" | "ready", who?: string | null, at: string }} Watcher
 * @typedef {{ id: string, text: string, ref: string, at: string }} Fired What Felix tells you when a watcher comes true.
 */

/**
 * What a "tell me when ..." asks Felix to watch for, and the PR it names, if it names one.
 * @param {string} what The part after "tell me when", like "ci passes on fm#123" or "brian approves it".
 * @returns {{ kind: Watcher["kind"], who: string | null, ref: string | null } | null} Null when it isn't something Felix can watch.
 */
export function parseWatch(what) {
  const text = String(what || "").toLowerCase();
  const pr = PR_REF.exec(text);
  const ref = pr ? `${pr[1]}#${pr[2]}` : null;
  if (/\b(ci|checks?|tests?|build|pipeline)\b[^.]*\b(fail|fails|failed|failing|breaks?|broke|goes red|turns red|is red|are red)\b/.test(text)) return { kind: "checks-fail", who: null, ref };
  if (/\b(ci|checks?|tests?|build|pipeline)\b[^.]*\b(pass|passes|passed|succeeds?|goes green|turns green|is green|are green|finish(es)?|done)\b/.test(text)) return { kind: "checks-pass", who: null, ref };
  if (/\b(ready to merge|mergeable|can (be )?merged?|clean to merge)\b/.test(text)) return { kind: "ready", who: null, ref };
  // "It's approved" or "it gets approved" names nobody; "Brian approves it" names Brian.
  if (/\b(gets?|is|it'?s|was|got) approved\b/.test(text)) return { kind: "approved", who: null, ref };
  const by = /(?:^|\s)([a-z][a-z.'-]*) (?:approves|approved|gives (?:it )?(?:a |an )?(?:approval|lgtm))\b/.exec(text);
  if (by) return { kind: "approved", who: NOBODY.has(by[1]) ? null : by[1], ref };
  if (/\bapproval\b/.test(text)) return { kind: "approved", who: null, ref };
  return null;
}

/**
 * The PR a watcher is about, from the Open PRs record: one of yours, or one waiting on your review.
 * @param {object} prs The "prs" fact's record.
 * @param {string} ref
 * @returns {Record<string, any> | undefined}
 */
const prIn = (prs, ref) => [...(prs.yourPrs || []), ...(prs.waitingOnYourReview || []), ...(prs.reviewedEarlier || [])].find((p) => p.ref === ref);

/**
 * Whether a watcher has come true, and what to tell you. A PR that's no longer open ends its watcher too.
 * @param {Watcher} w
 * @param {object} prs
 * @returns {string | null}
 */
export function firedText(w, prs) {
  const pr = prIn(prs, w.ref);
  if (!pr) return `${w.ref} isn't in your open PRs anymore, so I stopped watching it. It may have merged or closed.`;
  if (w.kind === "checks-pass" && pr.checks === "passing") return `Checks passed on ${w.ref}.`;
  if (w.kind === "checks-fail" && pr.checks === "failing") return `Checks are failing on ${w.ref}${pr.failingChecks?.length ? `: ${pr.failingChecks.slice(0, 3).join(", ")}` : ""}.`;
  if (w.kind === "ready" && pr.readyToMerge) return `${w.ref} is ready to merge.`;
  if (w.kind === "approved") {
    const who = (pr.approvedBy || []).find((a) => !w.who || a.toLowerCase().startsWith(w.who) || w.who.startsWith(a.toLowerCase()));
    if (who) return `${who} approved ${w.ref}.`;
  }
  return null;
}

/**
 * How a watcher reads in a list: "CI passing on fm#123", "Brian approving fm#123".
 * @param {Watcher} w
 * @returns {string}
 */
export function watcherText(w) {
  const what = { "checks-pass": "checks passing", "checks-fail": "checks failing", ready: "ready to merge" }[w.kind]
    || `${w.who ? `${w.who.replace(/^./, (c) => c.toUpperCase())}'s` : "an"} approval`;
  return `${what} on ${w.ref}`;
}

/**
 * Writes a file in one step, so a crash never leaves half a file.
 * @param {string} file
 * @param {string} text
 * @returns {Promise<void>}
 */
async function writeAtomic(file, text) {
  await writeFile(`${file}.tmp`, text);
  await rename(`${file}.tmp`, file);
}

/**
 * Creates the watchers store.
 * @param {{ file: string, now?: () => number, read?: (file: string) => Promise<string>, write?: (file: string, text: string) => Promise<void> }} options
 */
export function createWatchers({ file, now = Date.now, read = (f) => readFile(f, "utf8"), write = writeAtomic }) {
  /** @type {Watcher[] | null} */
  let list = null;
  /** @type {Fired[]} What came true and hasn't been told yet. */
  let fired = [];
  const load = async () => {
    list ||= await read(file).then((t) => JSON.parse(t).watchers || [], () => []);
    return list;
  };
  const save = () => write(file, `${JSON.stringify({ watchers: list }, null, 2)}\n`);

  return {
    /** Every watcher, oldest first. @returns {Promise<Watcher[]>} */
    all: async () => [...(await load())],
    /**
     * Starts watching, unless the same watcher is already on.
     * @param {Omit<Watcher, "id" | "at">} w
     * @returns {Promise<Watcher>}
     */
    async add(w) {
      const same = (await load()).find((x) => x.ref === w.ref && x.kind === w.kind && (x.who || null) === (w.who || null));
      if (same) return same;
      const watcher = { id: randomUUID().slice(0, 8), ref: w.ref, kind: w.kind, who: w.who || null, at: new Date(now()).toISOString() };
      list.push(watcher);
      await save();
      return watcher;
    },
    /**
     * Stops watchers: one PR's, or all of them.
     * @param {string | null} ref Null for all.
     * @returns {Promise<number>} How many stopped.
     */
    async cancel(ref) {
      const before = (await load()).length;
      list = ref ? list.filter((w) => w.ref !== ref) : [];
      const count = before - list.length;
      if (count) await save();
      return count;
    },
    /**
     * Checks every watcher against fresh Open PRs data; the ones that came true end, and wait to be told.
     * @param {object} prs The "prs" fact's record.
     * @returns {Promise<Fired[]>} The ones that came true just now.
     */
    async check(prs) {
      const now_ = new Date(now()).toISOString();
      const done = [];
      for (const w of await load()) {
        const text = firedText(w, prs);
        if (text) done.push({ id: w.id, text, ref: w.ref, at: now_ });
      }
      if (!done.length) return [];
      const ended = new Set(done.map((d) => d.id));
      list = list.filter((w) => !ended.has(w.id));
      fired = [...fired, ...done];
      await save();
      return done;
    },
    /** What came true since last asked, once. @returns {Fired[]} */
    takeFired() {
      const out = fired;
      fired = [];
      return out;
    },
  };
}
