/**
 * Whether a shell command only reads. Felix's AI runs reads straight away; anything else is a change, which
 * waits for your yes, and a few things Felix never runs. A command counts as a read only when every part of it
 * is one Felix knows reads, so anything unfamiliar is a change.
 */

const READERS = new Set(["ls", "cat", "head", "tail", "rg", "grep", "egrep", "wc", "pwd", "echo", "printf", "which", "file", "stat", "du",
  "df", "tree", "sort", "uniq", "cut", "tr", "jq", "date", "basename", "dirname", "realpath", "diff", "cd", "true", "nl", "column", "less"]);
const NEVER_COMMANDS = new Set(["security", "sudo", "su", "launchctl", "osascript", "defaults", "dscl", "passwd", "ssh-add", "tailscale"]);
const FIND_WRITES = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"]);
const GIT_READS = new Set(["status", "log", "diff", "show", "blame", "rev-parse", "ls-files", "ls-tree", "grep", "shortlog", "describe",
  "cat-file", "rev-list", "whatchanged", "merge-base", "name-rev", "count-objects"]);
const GIT_LISTS = { branch: /^-(a|r|v|vv|-all|-remotes|-list|-show-current)$/, tag: /^-(l|-list|n\d*)$/, remote: /^-(v|-verbose)$/ };
const GH_NEVER = new Set(["auth", "secret", "variable", "ssh-key", "gpg-key", "extension", "alias", "config", "codespace", "attestation", "token"]);
const GH_READS = {
  pr: ["view", "list", "diff", "checks", "status"],
  issue: ["view", "list", "status"],
  run: ["view", "list"],
  workflow: ["view", "list"],
  release: ["view", "list"],
  repo: ["view", "list"],
  label: ["list"],
  cache: ["list"],
  ruleset: ["list", "view", "check"],
  search: ["prs", "issues", "code", "commits", "repos"],
};
const GH_API_WRITES = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);
const QUIET = /\s+\d?>\s*\/dev\/null|\s+2>&1/g;
const WORD = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;

/**
 * @typedef {"read" | "change" | "never"} Kind
 */

/**
 * A command's words, with quotes taken off.
 * @param {string} part
 * @returns {string[]}
 */
export const wordsOf = (part) => [...part.matchAll(WORD)].map((m) => m[1] ?? m[2] ?? m[3]);

/**
 * The more careful of two kinds.
 * @param {Kind} a
 * @param {Kind} b
 * @returns {Kind}
 */
const worse = (a, b) => (a === "never" || b === "never" ? "never" : a === "change" || b === "change" ? "change" : "read");

/**
 * What a git command does: the ones that only look are reads.
 * @param {string[]} args The words after "git".
 * @returns {Kind}
 */
export function gitKind(args) {
  const rest = [...args];
  while (rest[0] === "-C" || rest[0] === "--no-pager" || rest[0] === "-c") rest.splice(0, rest[0] === "--no-pager" ? 1 : 2);
  const [sub, ...flags] = rest;
  if (GIT_READS.has(sub)) return "read";
  const lists = GIT_LISTS[sub];
  return lists && flags.every((f) => lists.test(f)) ? "read" : "change";
}

/**
 * What a `gh api` call does: a GET is a read, and so is a GraphQL query; anything sent with fields is a change.
 * @param {string[]} args The words after "api".
 * @returns {Kind}
 */
function ghApiKind(args) {
  const method = args.find((a, i) => args[i - 1] === "-X" || args[i - 1] === "--method") || args.find((a) => a.startsWith("--method="))?.slice(9);
  const endpoint = args.find((a, i) => !a.startsWith("-") && !/^(-X|--method|-H|--header|-f|-F|--field|--raw-field|-q|--jq|-t|--template|--hostname|--cache)$/.test(args[i - 1] || ""));
  if (/secrets|keys|tokens|authorizations/i.test(endpoint || "")) return "never";
  if (endpoint === "graphql") return args.some((a) => /\bmutation\b/i.test(a)) || args.includes("--input") ? "change" : "read";
  if (method) return method.toUpperCase() === "GET" ? "read" : "change";
  return args.some((a) => GH_API_WRITES.has(a)) ? "change" : "read";
}

/**
 * What a gh command does. Reads look at GitHub; changes post, merge, close or edit; a few, like your login and
 * secrets, Felix never touches.
 * @param {string[]} args The words after "gh".
 * @returns {Kind}
 */
export function ghKind(args) {
  const [group, sub] = args;
  if (!group || group.startsWith("-")) return "change";
  if (GH_NEVER.has(group)) return "never";
  if (group === "api") return ghApiKind(args.slice(1));
  if (group === "status") return "read";
  if (args.includes("--web") || args.includes("-w")) return "change";
  return (GH_READS[group] || []).includes(sub) ? "read" : "change";
}

/**
 * What one command in a chain does.
 * @param {string[]} words
 * @returns {Kind}
 */
function commandKind(words) {
  const start = words.findIndex((w) => !/^[A-Z_][A-Z0-9_]*=/.test(w));
  const [name, ...args] = words.slice(start < 0 ? words.length : start);
  if (!name) return "read";
  const base = name.split("/").pop() || name;
  if (NEVER_COMMANDS.has(base)) return "never";
  if (base === "git") return gitKind(args);
  if (base === "gh") return ghKind(args);
  if (base === "sed") return args.some((a) => /^-i|^--in-place/.test(a)) ? "change" : "read";
  if (base === "find") return args.some((a) => FIND_WRITES.has(a)) ? "change" : "read";
  if (name === "./prs" && args[0] === "test") return "read";
  if (base === "node" && args[0] === "--test") return "read";
  return READERS.has(base) ? "read" : "change";
}

/**
 * What a shell command does, as a whole: a read only when every part of it reads. Writing to a file, or
 * running one command inside another, makes it a change.
 * @param {string} command
 * @returns {Kind}
 */
export function shellKind(command) {
  const text = String(command || "").replace(QUIET, " ").trim();
  if (!text) return "change";
  const parts = text.split(/&&|\|\||[;|]/).map((p) => commandKind(wordsOf(p)));
  if (parts.includes("never") || wordsOf(text.replace(/[`$()]/g, " ")).some((w) => NEVER_COMMANDS.has(w))) return "never";
  if (/[`<>\n]|\$\(/.test(text)) return "change";
  return parts.reduce(worse, "read");
}
