// Small local server for the Open PRs page. No dependencies; runs on the Mac (not in Docker)
// so it can start Claude Code reviews in hidden tmux sessions with Remote Control on.
//
// GET  /, /mine, /review      -> the page
// GET  /api/prs               -> my PRs and PRs waiting on my review, fresh from GitHub, plus review sessions
// GET  /api/reviews           -> review sessions only (cheap; the page polls this while a review runs)
// GET  /api/pr?repo=fm&number=1 -> one PR's description, files, commits and activity for the details panel
// GET  /api/review/screen?url= -> the review session's terminal screen right now (live view)
// POST /api/review            -> { url, model? } start (or queue) a background /review-pr session
// POST /api/review/batch      -> { urls, model? } review several PRs; at most 3 run at once, the rest queue
// POST /api/fix               -> { url, kind: checks|conflict|comments|custom, request?, model? } fix my PR in a worktree
// GET  /api/fix/changes?url=  -> the fix's local commits and diff against the PR branch
// POST /api/fix/push          -> { url } push the fix's commits to the PR branch (never forced)
// POST /api/fix/discard       -> { url } close the fix session and remove its worktree
// POST /api/review/answer     -> { url, answer: A|B|C|D } answer the skill's posting question in that session
// POST /api/review/stop       -> { key } interrupt what a session is doing (like Esc); takes a review out of the queue
// POST /api/review/end        -> { key } close a session (key: PR link for reviews, "fix:<link>" for fixes)
// POST /api/review/open       -> { key, where: "warp"|"app" } open a session on this Mac to continue by hand
// POST /api/review-event      -> hook events from review sessions (hooks/report.sh)
// POST /api/remove-me         -> { url } remove me from the PR's requested reviewers on GitHub
import { createServer } from "node:http";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const PORT = Number(process.env.PORT || 4777);
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The workspace root that holds the fm/bm clones and the review-pr skill's .claude folder.
const WORKSPACE = path.resolve(HERE, "..");
const DATA = path.join(HERE, "data");
const REVIEWS_FILE = path.join(DATA, "reviews.json");
const WARP_LAUNCH_DIR = path.join(homedir(), ".warp", "launch_configurations");
const CLAUDE = process.env.CLAUDE_BIN || path.join(homedir(), ".local", "bin", "claude");
const GH = process.env.GH_BIN || "/opt/homebrew/bin/gh";

const REPOS = [
  { key: "fm", repo: "purepm/frontend-monorepo" },
  { key: "bm", repo: "purepm/backend-monorepo" },
];
const PR_URL = /^https:\/\/github\.com\/purepm\/(frontend|backend)-monorepo\/pull\/(\d+)$/;
const ANSWERS = { A: "A", B: "B", C: "C", D: "D" };
// Models a review can run on: claude's aliases for the latest of each. "" = your usual default.
const MODELS = new Set(["", "fable", "opus", "sonnet", "haiku"]);

// Review sessions may run with nobody watching, so the first turn must stop at the skill's posting question.
const REVIEW_NOTE = "This review was started from the Open PRs page and may be running with nobody watching. "
  + "Do not post anything to GitHub until the user answers your posting question. "
  + "Finish with the full report and the posting question, then stop.";

mkdirSync(DATA, { recursive: true });

// ---------- GitHub ----------

let token = process.env.GH_TOKEN || "";
function ghToken(refresh = false) {
  if (token && !refresh) return Promise.resolve(token);
  return new Promise((resolve, reject) => execFile(GH, ["auth", "token"], (err, out) => {
    if (err) return reject(new Error("Could not read your gh login. Run `gh auth login`, then ./prs restart."));
    token = out.trim();
    resolve(token);
  }));
}

async function github(pathname, init = {}, retry = true) {
  const res = await fetch(`https://api.github.com${pathname}`, {
    ...init,
    headers: { Authorization: `Bearer ${await ghToken()}`, "User-Agent": "open-prs-local", Accept: "application/vnd.github+json", ...init.headers },
    signal: AbortSignal.timeout(30000),
  });
  if (res.status === 401 && retry) { await ghToken(true); return github(pathname, init, false); }
  if (res.status === 401) throw new Error("GitHub refused your gh login. Run `gh auth login`, then ./prs restart.");
  return res;
}

const QUERY = `query($mine: String!, $requested: String!, $reviewed: String!) {
  viewer { login }
  mine: search(query: $mine, type: ISSUE, first: 100) { ...prs }
  requested: search(query: $requested, type: ISSUE, first: 100) { ...prs }
  reviewed: search(query: $reviewed, type: ISSUE, first: 50) { ...prs }
}
fragment prs on SearchResultItemConnection {
  nodes { ... on PullRequest {
    number title body url isDraft createdAt updatedAt headRefName baseRefName headRefOid
    author { login }
    reviewDecision mergeable additions deletions changedFiles
    repository { nameWithOwner }
    labels(first: 10) { nodes { name } }
    latestReviews(first: 30) { nodes { state submittedAt author { login } commit { oid } } }
    reviewRequests(first: 10) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state createdAt }
    } } } } } }
  } }
}`;

// CANCELLED counts as non-failing: re-runs cancel the superseded run of the same job.
const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED", "CANCELLED"]);

// Keeps only the latest run of each check, like `gh pr checks` does, and reads each one's outcome.
function latestChecks(contexts = []) {
  const latest = new Map();
  for (const c of contexts) {
    const key = c.__typename === "StatusContext"
      ? `ctx:${c.context}`
      : `run:${c.checkSuite?.workflowRun?.workflow?.name}:${c.name}`;
    const at = c.startedAt || c.createdAt || "";
    const prev = latest.get(key);
    if (!prev || at >= (prev.startedAt || prev.createdAt || "")) latest.set(key, c);
  }
  return [...latest.values()].map((c) => {
    const isStatus = c.__typename === "StatusContext";
    const done = isStatus ? c.state !== "PENDING" && c.state !== "EXPECTED" : c.status === "COMPLETED";
    const result = isStatus ? c.state : c.conclusion;
    return {
      name: c.name || c.context,
      workflow: c.checkSuite?.workflowRun?.workflow?.name || null,
      outcome: !done ? "pending" : PASS.has(result) ? (result === "SKIPPED" || result === "CANCELLED" ? "skipped" : "passed") : "failed",
      result: result || c.status,
      description: c.description || null,
      url: c.detailsUrl || c.targetUrl || null,
      startedAt: c.startedAt || c.createdAt || null,
      completedAt: c.completedAt || null,
    };
  });
}

function summarizeChecks(contexts = []) {
  const out = { total: 0, passed: 0, failed: 0, pending: 0, failing: [] };
  for (const c of latestChecks(contexts)) {
    out.total++;
    if (c.outcome === "pending") out.pending++;
    else if (c.outcome === "failed") { out.failed++; out.failing.push(c.name); }
    else out.passed++;
  }
  out.state = out.total === 0 ? "none" : out.failed ? "failing" : out.pending ? "pending" : "passing";
  return out;
}

// Jira keys like PMHUB-32946, from the branch first, then the title and description.
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "RFC", "HTTP", "TLS", "ES"]);
function ticketKeys(...texts) {
  const keys = new Set();
  for (const text of texts) {
    for (const [, project, num] of String(text || "").matchAll(/\b([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,6})\b/g)) {
      const p = project.toUpperCase();
      if (!NOT_TICKETS.has(p) && /^[A-Z]+[0-9]*$/.test(p)) keys.add(`${p}-${num}`);
    }
  }
  return [...keys];
}

function shape(pr, login) {
  const reviews = pr.latestReviews?.nodes || [];
  const rollup = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup;
  const mine = reviews.find((r) => r.author?.login === login);
  return {
    number: pr.number,
    title: pr.title,
    url: pr.url,
    author: pr.author?.login || "ghost",
    isDraft: pr.isDraft,
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    branch: pr.headRefName,
    base: pr.baseRefName,
    reviewDecision: pr.reviewDecision || null,
    mergeable: pr.mergeable,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    labels: (pr.labels?.nodes || []).map((l) => l.name),
    tickets: ticketKeys(pr.headRefName, pr.title, pr.body),
    approvedBy: reviews.filter((r) => r.state === "APPROVED").map((r) => r.author?.login),
    changesRequestedBy: reviews.filter((r) => r.state === "CHANGES_REQUESTED").map((r) => r.author?.login),
    myReview: mine ? { state: mine.state, submittedAt: mine.submittedAt, commit: mine.commit?.oid || null } : null,
    // The author pushed after my latest review: worth a re-review.
    newCommits: Boolean(mine?.commit?.oid && pr.headRefOid && mine.commit.oid !== pr.headRefOid),
    reviewRequests: (pr.reviewRequests?.nodes || [])
      .map((r) => r.requestedReviewer?.login || r.requestedReviewer?.name)
      .filter(Boolean),
    checks: summarizeChecks(rollup?.contexts?.nodes),
  };
}

async function listPrs() {
  const scope = `is:pr is:open archived:false ${REPOS.map((r) => `repo:${r.repo}`).join(" ")}`;
  const res = await github("/graphql", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      // user-review-requested = asked by name, not through a team. It clears once I submit a review,
      // so PRs I reviewed from this page are kept through the reviewed-by search.
      variables: {
        mine: `${scope} author:@me`,
        requested: `${scope} user-review-requested:@me -author:@me`,
        reviewed: `${scope} reviewed-by:@me -author:@me sort:updated-desc`,
      },
    }),
  });
  const body = await res.json();
  if (body.errors?.length && !body.data) throw new Error(body.errors.map((e) => e.message).join("; "));
  const login = body.data.viewer.login;
  const toPrs = (search) => search.nodes.filter((n) => n.number).map((n) => ({ repo: n.repository.nameWithOwner, ...shape(n, login) }));

  const requested = toPrs(body.data.requested).map((p) => ({ ...p, requested: true }));
  const seen = new Set(requested.map((p) => p.url));
  const tracked = readReviews();
  const keptAfterReview = toPrs(body.data.reviewed)
    .filter((p) => (tracked[p.url] || p.newCommits) && !seen.has(p.url))
    .map((p) => ({ ...p, requested: false }));

  const byRepo = (prs) => REPOS.map(({ key, repo }) => ({
    key,
    repo,
    prs: prs.filter((p) => p.repo === repo).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
  }));
  return {
    fetchedAt: new Date().toISOString(),
    login,
    lists: { mine: byRepo(toPrs(body.data.mine)), review: byRepo([...requested, ...keptAfterReview]) },
  };
}

// Everything the details panel shows for one PR. GitHub pages can't be framed, so we rebuild the
// useful parts from the API; bodies come back as GitHub's own sanitized HTML.
async function prDetails(repoKey, number) {
  const repo = REPOS.find((r) => r.key === repoKey)?.repo;
  if (!repo || !/^\d+$/.test(String(number))) throw httpError(400, "Unknown PR.");
  const base = `/repos/${repo}`;
  const html = { Accept: "application/vnd.github.html+json" };
  const get = async (p, headers) => {
    const res = await github(p, { headers });
    if (!res.ok) throw httpError(res.status === 404 ? 404 : 502, `GitHub answered ${res.status} for ${p}.`);
    return res.json();
  };
  const [owner, name] = repo.split("/");
  const [pr, files, commits, reviews, comments, codeComments, meta] = await Promise.all([
    get(`${base}/pulls/${number}`, html),
    get(`${base}/pulls/${number}/files?per_page=100`),
    get(`${base}/pulls/${number}/commits?per_page=100`),
    get(`${base}/pulls/${number}/reviews?per_page=100`, html),
    get(`${base}/issues/${number}/comments?per_page=100`, html),
    get(`${base}/pulls/${number}/comments?per_page=100`, html),
    github("/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: PR_META_QUERY, variables: { owner, name, number: Number(number) } }),
    }).then((r) => r.json()).then((b) => b.data?.repository?.pullRequest || {}),
  ]);

  // Reviewers as GitHub's sidebar shows them: everyone asked, plus everyone who reviewed.
  const reviewers = new Map();
  for (const r of meta.latestReviews?.nodes || []) {
    if (r.author?.login) reviewers.set(r.author.login, { login: r.author.login, state: r.state, at: r.submittedAt, requested: false });
  }
  for (const n of meta.reviewRequests?.nodes || []) {
    const login = n.requestedReviewer?.login || n.requestedReviewer?.name;
    if (!login) continue;
    const prev = reviewers.get(login);
    reviewers.set(login, { login, state: prev?.state || null, at: prev?.at || null, requested: true, team: !n.requestedReviewer?.login });
  }

  // Inline code comments, grouped under the review they belong to.
  const byReview = new Map();
  for (const c of codeComments) {
    const list = byReview.get(c.pull_request_review_id) || [];
    list.push({
      id: c.id, replyTo: c.in_reply_to_id || null, author: c.user?.login, at: c.created_at, html: c.body_html || "",
      path: c.path, line: c.line ?? c.original_line, hunk: (c.diff_hunk || "").split("\n").slice(-6).join("\n"), url: c.html_url,
      outdated: c.position == null,
    });
    byReview.set(c.pull_request_review_id, list);
  }

  return {
    url: pr.html_url,
    number: pr.number,
    title: pr.title,
    author: pr.user?.login,
    state: pr.merged_at ? "merged" : pr.state,
    draft: pr.draft,
    head: pr.head?.ref,
    base: pr.base?.ref,
    bodyHtml: pr.body_html || "",
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    mergeableState: pr.mergeable_state,
    reviewDecision: meta.reviewDecision || null,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changed_files,
    commitCount: pr.commits,
    reviewers: [...reviewers.values()],
    assignees: (meta.assignees?.nodes || []).map((a) => a.login),
    labels: (meta.labels?.nodes || []).map((l) => ({ name: l.name, color: l.color })),
    milestone: meta.milestone ? { title: meta.milestone.title, url: meta.milestone.url } : null,
    tickets: ticketKeys(pr.head?.ref, pr.title, pr.body),
    checks: latestChecks(meta.commits?.nodes?.[0]?.commit?.statusCheckRollup?.contexts?.nodes),
    // `patch` is GitHub's unified diff for the file; GitHub leaves it out for very large or binary files.
    // `url` jumps to the file in the PR's "Files changed" view (GitHub anchors are diff-<sha256 of the path>).
    files: files.map((f) => ({
      name: f.filename,
      previousName: f.previous_filename || null,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch ?? null,
      url: `${pr.html_url}/files#diff-${createHash("sha256").update(f.filename).digest("hex")}`,
    })),
    commits: commits.map((c) => ({
      sha: c.sha.slice(0, 7), message: c.commit.message.split("\n")[0], author: c.author?.login || c.commit.author?.name,
      date: c.commit.author?.date, url: c.html_url,
    })),
    // Conversation: reviews (with their inline code comments) and comments, oldest first.
    // Reviews that are only a reply to a code comment show up as that reply, like on GitHub.
    timeline: [
      ...reviews.filter((r) => r.state !== "PENDING").map((r) => ({
        kind: "review", state: r.state, author: r.user?.login, at: r.submitted_at, html: r.body_html || "", url: r.html_url,
        codeComments: byReview.get(r.id) || [],
      })).filter((r) => r.html || r.codeComments.length || r.state !== "COMMENTED"),
      ...comments.map((c) => ({ kind: "comment", author: c.user?.login, at: c.created_at, html: c.body_html || "", url: c.html_url })),
    ].sort((a, b) => String(a.at).localeCompare(String(b.at))),
  };
}

const PR_META_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) { pullRequest(number: $number) {
    reviewDecision
    assignees(first: 10) { nodes { login } }
    labels(first: 20) { nodes { name color } }
    milestone { title url }
    reviewRequests(first: 20) { nodes { requestedReviewer { ... on User { login } ... on Team { name } } } }
    latestReviews(first: 30) { nodes { state submittedAt author { login } } }
    commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes {
      __typename
      ... on CheckRun { name status conclusion startedAt completedAt detailsUrl checkSuite { workflowRun { workflow { name } } } }
      ... on StatusContext { context state description targetUrl createdAt }
    } } } } } }
  } }
}`;

async function removeMeAsReviewer(url) {
  const [, side, number] = PR_URL.exec(url) || [];
  if (!number) throw httpError(400, "Not a fm or bm PR link.");
  const me = await (await github("/user")).json();
  const res = await github(`/repos/purepm/${side}-monorepo/pulls/${number}/requested_reviewers`, {
    method: "DELETE",
    body: JSON.stringify({ reviewers: [me.login] }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw httpError(502, `GitHub refused: ${body.message || res.status}`);
  }
}

// ---------- Claude sessions: reviews and fixes ----------
// Each session is an interactive Claude Code session in a hidden tmux window, with Remote Control on so
// it also shows up in the Claude phone app and on claude.ai/code. Hooks (hooks/report.sh) tell this
// server what the session is doing. reviews.json keeps one entry per key:
//   "<pr url>"      a review of someone's PR (/review-pr)
//   "fix:<pr url>"  a fix on one of my PRs, made in its own git worktree
// Entry: { type, sessionId, tmux, cwd, status, startedAt, updatedAt, steps, lastStep, result, error,
//          answer, rcUrl, note, log, model, ...fix fields }
// status: queued -> running -> ready (waiting on you) -> answering -> answered | pushed;
//         or waiting (asks for approval), failed, stopped, ended.

const TMUX = process.env.TMUX_BIN || "/opt/homebrew/bin/tmux";
const HOOKS_SETTINGS = path.join(HERE, "hooks", "settings.json");
const BUSY = ["running", "answering", "waiting"];
const MAX_RUNNING = 3; // reviews beyond this wait in a queue

// Hooks only run in sessions this server starts: the settings file is passed with --settings.
function writeHooksSettings() {
  const command = `${path.join(HERE, "hooks", "report.sh")}`;
  const hook = [{ hooks: [{ type: "command", command, timeout: 5 }] }];
  const events = ["SessionStart", "UserPromptSubmit", "PreToolUse", "Notification", "Stop", "StopFailure", "SessionEnd"];
  writeFileSync(HOOKS_SETTINGS, JSON.stringify({ hooks: Object.fromEntries(events.map((e) => [e, hook])) }, null, 2));
}
writeHooksSettings();

function readReviews() {
  try { return JSON.parse(readFileSync(REVIEWS_FILE, "utf8")); } catch { return {}; }
}

function writeReviews(all) {
  writeFileSync(REVIEWS_FILE, JSON.stringify(all, null, 2));
}

// "fix:<url>" -> { url, fix: true }; validates the PR link.
function parseKey(key) {
  const fix = String(key).startsWith("fix:");
  const url = fix ? key.slice(4) : String(key);
  const m = PR_URL.exec(url);
  if (!m) throw httpError(400, "Not a fm or bm PR link.");
  return { url, fix, repoKey: m[1] === "frontend" ? "fm" : "bm", side: m[1], number: m[2] };
}

function tmuxName(key) {
  const { fix, repoKey, number } = parseKey(key);
  return `openprs-${fix ? "fix-" : ""}${repoKey}-${number}`;
}

function sessionAlive(name) {
  if (!name) return false;
  try { execFileSync(TMUX, ["has-session", "-t", `=${name}`], { stdio: "ignore" }); return true; } catch { return false; }
}

function stepLabel(tool, input = {}) {
  if (tool === "Bash") return input.description || String(input.command || "").slice(0, 90);
  if (tool === "Read") return `Read ${path.basename(input.file_path || "")}`;
  if (tool === "Edit" || tool === "Write") return `${tool === "Edit" ? "Edit" : "Write"} ${path.basename(input.file_path || "")}`;
  if (tool === "Grep") return `Search for ${String(input.pattern || "").slice(0, 60)}`;
  if (tool === "Glob") return `Find ${input.pattern || "files"}`;
  if (tool === "Skill") return `Load ${input.skill || "skill"}`;
  if (tool === "Agent" || tool === "Task") return input.description || "Run a helper";
  if (tool?.startsWith("mcp__")) return tool.split("__").slice(2).join(" ");
  return tool;
}

// The Remote Control link the session prints when it starts (claude.ai/code/session_…).
function findRcUrl(name) {
  try {
    const screen = execFileSync(TMUX, ["capture-pane", "-p", "-J", "-S", "-200", "-t", `=${name}:`], { encoding: "utf8" });
    return screen.match(/https:\/\/claude\.ai\/code\/session_[A-Za-z0-9]+/)?.[0] || null;
  } catch { return null; }
}

// Fills in what hooks can't tell us: the Remote Control link, and sessions that ended without a SessionEnd.
function refresh(r) {
  if (r.status === "queued") { r.alive = false; return r; }
  const alive = sessionAlive(r.tmux);
  if (alive && !r.rcUrl) r.rcUrl = findRcUrl(r.tmux);
  if (!alive && [...BUSY, "ready"].includes(r.status)) {
    r.status = r.status === "ready" ? "ended" : r.stopRequested ? "stopped" : "failed";
    if (r.status === "failed") r.error = r.error || "The session closed before it finished.";
    r.updatedAt = new Date().toISOString();
  }
  r.alive = alive;
  return r;
}

function reviewsSnapshot() {
  const all = readReviews();
  for (const r of Object.values(all)) refresh(r);
  writeReviews(all);
  return Object.fromEntries(Object.entries(all).map(([key, r]) => [key, {
    type: r.type || "review", sessionId: r.sessionId, status: r.status, alive: r.alive, startedAt: r.startedAt, updatedAt: r.updatedAt,
    steps: r.steps || 0, lastStep: r.lastStep || null, result: r.result || null, error: r.error || null,
    answer: r.answer || null, rcUrl: r.rcUrl || null, note: r.note || null, log: r.log || [], model: r.model || "",
    kind: r.kind || null, head: r.head || null, branch: r.branch || null, pushedAt: r.pushedAt || null,
  }]));
}

// The session's terminal screen right now, for the page's live view.
function reviewScreen(key) {
  const r = readReviews()[key];
  if (!r) throw httpError(404, "No Claude session for this PR.");
  if (!sessionAlive(r.tmux)) return { alive: false, text: "" };
  const text = execFileSync(TMUX, ["capture-pane", "-p", "-J", "-S", "-400", "-t", `=${r.tmux}:`], { encoding: "utf8" });
  return { alive: true, text: text.replace(/\s+$/, "") };
}

// A short, timestamped record of what the session did; kept after it ends.
function addLog(r, text, kind = "step") {
  r.log = [...(r.log || []), { at: new Date().toISOString(), kind, text: String(text).slice(0, 200) }].slice(-300);
}

// Called by hooks/report.sh for every hook event in one of our sessions.
function onHookEvent(key, ev) {
  const all = readReviews();
  const r = all[key];
  if (!r || (ev.session_id && ev.session_id !== r.sessionId)) return; // not one of ours, or an old session
  const fix = r.type === "fix";
  switch (ev.hook_event_name) {
    case "SessionStart":
      if (r.status !== "ready") r.lastStep = fix ? "Starting the fix" : "Starting the review";
      addLog(r, ev.source === "resume" ? "Session resumed" : "Session started", "event");
      break;
    case "UserPromptSubmit": {
      const text = String(ev.prompt || "").trim();
      if (["ready", "answered", "ended", "pushed"].includes(r.status)) {
        r.status = "answering";
        r.answer = /^[ABCD]$/i.test(text) ? text.toUpperCase() : text.slice(0, 60);
        r.lastStep = "Working on your answer";
        addLog(r, `You answered: ${text}`, "you");
      } else {
        r.status = "running";
        addLog(r, `Prompt: ${text.slice(0, 160)}`, "you");
      }
      break;
    }
    case "PreToolUse":
      r.steps = (r.steps || 0) + 1;
      r.lastStep = stepLabel(ev.tool_name, ev.tool_input);
      if (r.status === "waiting") r.status = r.answer ? "answering" : "running";
      addLog(r, r.lastStep);
      break;
    case "Notification":
      // Claude is waiting on the person: a permission prompt or an idle reminder.
      if (/permission|approv/i.test(`${ev.notification_type} ${ev.message}`)) {
        r.status = "waiting";
        r.note = ev.message || "Claude needs your approval.";
        addLog(r, r.note, "wait");
      }
      break;
    case "Stop":
      r.result = ev.last_assistant_message || r.result;
      r.status = fix ? "ready" : r.answer ? "answered" : "ready";
      r.note = null;
      addLog(r, fix ? "Changes ready for you to check and push" : r.answer ? "Finished your answer" : "Review ready, waiting on your answer", "done");
      break;
    case "StopFailure":
      r.status = "failed";
      r.error = ev.error || ev.message || "Claude stopped with an error.";
      addLog(r, r.error, "error");
      break;
    case "SessionEnd":
      if (BUSY.includes(r.status)) { r.status = r.stopRequested ? "stopped" : "failed"; r.error = r.error || "The session closed before it finished."; }
      else if (r.status === "ready") r.status = "ended";
      addLog(r, "Session closed", "event");
      break;
  }
  r.updatedAt = new Date().toISOString();
  writeReviews(all);
  if (!BUSY.includes(r.status)) startQueued();
}

// Starts claude in a hidden tmux window. Arguments go straight to claude (no shell), so nothing here
// is read as shell syntax.
function launchSession(all, key, { cwd, title, prompt, note, model, extraArgs = [] }) {
  const name = tmuxName(key);
  if (sessionAlive(name)) execFileSync(TMUX, ["kill-session", "-t", `=${name}`]); // replace an older session for this PR
  const sessionId = randomUUID();
  execFileSync(TMUX, [
    "new-session", "-d", "-s", name, "-x", "200", "-y", "50", "-c", cwd,
    "-e", `OPEN_PRS_REVIEW=${key}`, "-e", `OPEN_PRS_PORT=${PORT}`,
    CLAUDE,
    "--session-id", sessionId,
    "--remote-control", title,
    "--settings", HOOKS_SETTINGS,
    // Nobody is at the Mac to click permission prompts; this matches the workspace's own default.
    "--permission-mode", "bypassPermissions",
    ...(model ? ["--model", model] : []),
    ...extraArgs,
    "--append-system-prompt", note,
    prompt,
  ]);
  const now = new Date().toISOString();
  const prev = all[key] || {};
  all[key] = {
    ...prev, sessionId, tmux: name, cwd, model, status: "running", startedAt: now, updatedAt: now,
    steps: 0, lastStep: "Starting Claude", result: null, error: null, answer: null, rcUrl: null, note: null, stopRequested: false,
    log: [...(prev.log || []), { at: now, kind: "event", text: `Started (${model || "default model"})` }].slice(-300),
  };
}

function runningCount(all) {
  return Object.values(all).filter((r) => BUSY.includes(r.status) && sessionAlive(r.tmux)).length;
}

// ---------- Reviews ----------

function launchReview(all, url, model) {
  const { repoKey, number } = parseKey(url);
  launchSession(all, url, {
    cwd: WORKSPACE, title: `Review ${repoKey}#${number}`, prompt: `/review-pr ${url}`, note: REVIEW_NOTE, model,
  });
  all[url].type = "review";
}

// Starts a review now, or queues it when MAX_RUNNING sessions are already working.
function startReview(url, model = "") {
  parseKey(url);
  if (!MODELS.has(model)) throw httpError(400, "Unknown model.");
  const all = readReviews();
  const current = all[url] && refresh(all[url]);
  if (current && [...BUSY, "queued"].includes(current.status)) throw httpError(409, "A review of this PR is already running or queued.");
  if (runningCount(all) >= MAX_RUNNING) {
    const now = new Date().toISOString();
    all[url] = { ...(current || {}), type: "review", model, status: "queued", queuedAt: now, startedAt: now, updatedAt: now, alive: false, lastStep: "Waiting for a free slot" };
    addLog(all[url], `Queued (${MAX_RUNNING} reviews already running)`, "event");
    writeReviews(all);
    return "queued";
  }
  launchReview(all, url, model);
  writeReviews(all);
  return "started";
}

function startQueued() {
  const all = readReviews();
  const queued = Object.entries(all).filter(([, r]) => r.status === "queued").sort(([, a], [, b]) => String(a.queuedAt).localeCompare(String(b.queuedAt)));
  let changed = false;
  for (const [url, r] of queued) {
    if (runningCount(all) >= MAX_RUNNING) break;
    try { launchReview(all, url, r.model || ""); } catch (e) { Object.assign(r, { status: "failed", error: e.message }); }
    changed = true;
  }
  if (changed) writeReviews(all);
}
setInterval(startQueued, 15e3).unref();

function startBatch(urls, model) {
  const out = { started: 0, queued: 0, skipped: 0 };
  for (const url of urls.slice(0, 30)) {
    try { out[startReview(String(url), model)]++; } catch { out.skipped++; }
  }
  return out;
}

function liveSession(key) {
  const r = readReviews()[key];
  if (!r) throw httpError(404, "No Claude session for this PR.");
  if (!sessionAlive(r.tmux)) throw httpError(409, "That session has ended. Start a new one or open it to resume.");
  return r;
}

// Types the answer into the session, as if you typed it in the terminal.
function answerReview(url, answer) {
  if (!ANSWERS[answer]) throw httpError(400, "Answer must be A, B, C or D.");
  const r = liveSession(url);
  if (r.status !== "ready") throw httpError(409, "The review is not waiting on an answer.");
  execFileSync(TMUX, ["send-keys", "-t", `=${r.tmux}:`, "-l", ANSWERS[answer]]);
  execFileSync(TMUX, ["send-keys", "-t", `=${r.tmux}:`, "Enter"]);
  const all = readReviews();
  Object.assign(all[url], { status: "answering", answer, lastStep: "Sending your answer", updatedAt: new Date().toISOString() });
  writeReviews(all);
}

// Stop interrupts the current work (like pressing Esc); End closes the session for good.
// Both also take a review out of the queue.
function stopReview(key) {
  const all = readReviews();
  if (all[key]?.status === "queued") return endReview(key);
  const r = liveSession(key);
  execFileSync(TMUX, ["send-keys", "-t", `=${r.tmux}:`, "Escape"]);
  Object.assign(all[key], { status: "stopped", stopRequested: true, lastStep: "Stopped", updatedAt: new Date().toISOString() });
  writeReviews(all);
}

function endReview(key) {
  const all = readReviews();
  const r = all[key];
  if (!r) throw httpError(404, "No Claude session for this PR.");
  if (sessionAlive(r.tmux)) execFileSync(TMUX, ["kill-session", "-t", `=${r.tmux}`]);
  if ([...BUSY, "queued"].includes(r.status)) { r.status = "stopped"; r.stopRequested = true; }
  else if (r.status === "ready") r.status = "ended";
  r.updatedAt = new Date().toISOString();
  writeReviews(all);
  startQueued();
}

// ---------- Fixes on my own PRs ----------
// Claude works in a separate git worktree (<repo>-wt-pr-<n>) on a local branch that tracks the PR's
// branch. It commits locally but may not push; the page shows the commits and diff, and you push.

const run = promisify(execFile);
const git = (cwd, args, opts = {}) => run("git", ["-C", cwd, ...args], { maxBuffer: 64 * 1024 * 1024, timeout: 180e3, ...opts });

const FIX_PROMPTS = {
  checks: (p) => `My PR ${p.url} (branch ${p.head}) has failing checks: ${p.failing.join(", ") || "see the PR"}. Find the cause (gh run view --log-failed, or each check's details), fix it in this worktree, run the relevant tests or linters, and commit the fix.`,
  conflict: (p) => `My PR ${p.url} (branch ${p.head}) has merge conflicts with ${p.base}. Merge origin/${p.base} into this branch (git fetch origin ${p.base} && git merge origin/${p.base}), resolve every conflict keeping the intent of both sides, run the relevant tests, and commit the merge.`,
  comments: (p) => `Reviewers left comments on my PR ${p.url}. Read every review and inline comment (gh api repos/${p.repo}/pulls/${p.number}/reviews and gh api repos/${p.repo}/pulls/${p.number}/comments), make the code changes you agree with in this worktree, and commit them. In your summary, list each comment and what you did, and explain any you think should not be changed.`,
  custom: (p) => `On my PR ${p.url} (branch ${p.head}): ${p.request}\nIf this needs code changes, make them in this worktree and commit them.`,
};

const fixNote = (p) => `You are working in a separate git worktree at ${p.wt}, on local branch ${p.branch}, which tracks origin/${p.head} (the PR's branch). `
  + "Commit your work locally with a clear Conventional Commits message. Do NOT push, do NOT force-push or rewrite history, "
  + "do NOT comment on, review or merge the PR on GitHub, and do NOT add .changeset files. "
  + "The user reads your changes in the Open PRs page and pushes from there. "
  + "End with a short summary: what you changed, how you checked it, and anything left undone.";

// Belt and braces: these commands are blocked in fix sessions even with permissions bypassed.
const FIX_BLOCKED = ["Bash(git push:*)", "Bash(gh pr comment:*)", "Bash(gh pr review:*)", "Bash(gh pr merge:*)", "Bash(gh pr close:*)"].join(",");

async function startFix(url, kind, request, model = "") {
  const { repoKey, side, number } = parseKey(url);
  if (!FIX_PROMPTS[kind]) throw httpError(400, "Unknown kind of fix.");
  if (!MODELS.has(model)) throw httpError(400, "Unknown model.");
  if (kind === "custom" && !String(request || "").trim()) throw httpError(400, "Say what Claude should change.");
  const key = `fix:${url}`;
  const all0 = readReviews();
  if (all0[key] && BUSY.includes(refresh(all0[key]).status)) throw httpError(409, "Claude is already working on this PR.");

  const [d, me] = await Promise.all([prDetails(repoKey, number), github("/user").then((r) => r.json())]);
  if (d.author !== me.login) throw httpError(403, "Fix with Claude is only for your own PRs.");
  if (d.state !== "open") throw httpError(409, "This PR is not open.");

  const repoDir = path.join(WORKSPACE, repoKey);
  const wt = path.join(WORKSPACE, `${repoKey}-wt-pr-${number}`);
  const branch = `openprs/pr-${number}`;
  await git(repoDir, ["fetch", "origin", d.head, d.base]);
  if (!existsSync(wt)) {
    // Hooks off for this one command: bm's post-checkout hook runs npm install, which is slow and can fail.
    // Claude's own commits in the worktree still run the repo's normal hooks.
    await run("git", ["-c", "core.hooksPath=/dev/null", "-C", repoDir, "worktree", "add", "-B", branch, wt, `origin/${d.head}`],
      { maxBuffer: 64 * 1024 * 1024, timeout: 300e3 });
  } else {
    // Reusing an earlier worktree: catch up with the PR branch when there's nothing local in the way.
    await git(wt, ["merge", "--ff-only", `origin/${d.head}`]).catch(() => {});
  }

  const p = {
    url, head: d.head, base: d.base, repo: `purepm/${side}-monorepo`, number, wt, branch,
    failing: d.checks.filter((c) => c.outcome === "failed").map((c) => c.name),
    request: String(request || "").trim().slice(0, 2000),
  };
  const all = readReviews();
  launchSession(all, key, {
    cwd: wt, title: `Fix ${repoKey}#${number}`, prompt: FIX_PROMPTS[kind](p), note: fixNote(p), model,
    extraArgs: ["--disallowedTools", FIX_BLOCKED],
  });
  Object.assign(all[key], { type: "fix", kind, wt, branch, head: d.head, base: d.base, repoDir, pushedAt: null });
  writeReviews(all);
  acceptFolderTrust(all[key].tmux);
}

// A new worktree is a folder Claude Code hasn't seen, so it asks "Do you trust this folder?" before
// starting. This server just made the worktree from your own repo for your own PR, so it answers yes
// (Claude Code then remembers it). Only that exact prompt is answered; it gives up after 30 seconds.
function acceptFolderTrust(name, triesLeft = 30) {
  setTimeout(() => {
    let screen = "";
    try { screen = execFileSync(TMUX, ["capture-pane", "-p", "-t", `=${name}:`], { encoding: "utf8" }); } catch { return; }
    if (/Yes, I trust this folder/.test(screen) && /safety check/i.test(screen)) {
      try {
        execFileSync(TMUX, ["send-keys", "-t", `=${name}:`, "Down"]);
        execFileSync(TMUX, ["send-keys", "-t", `=${name}:`, "Enter"]);
      } catch {}
      return;
    }
    if (triesLeft > 0 && !/remote-control is active|\/rc active/i.test(screen)) acceptFolderTrust(name, triesLeft - 1);
  }, 1000);
}

function fixEntry(url) {
  const r = readReviews()[`fix:${url}`];
  if (!r?.wt) throw httpError(404, "No Claude fix for this PR.");
  if (!existsSync(r.wt)) throw httpError(410, "The fix's worktree is gone.");
  return r;
}

// Splits `git diff` output into files shaped like the GitHub files list, so the page can reuse its diff view.
function parseDiff(text) {
  return text.split(/^(?=diff --git )/m).filter((s) => s.startsWith("diff --git")).map((chunk) => {
    const m = /^diff --git a\/(.+?) b\/(.+)$/m.exec(chunk);
    const at = chunk.indexOf("\n@@");
    const patch = at >= 0 ? chunk.slice(at + 1) : null;
    const lines = patch ? patch.split("\n") : [];
    return {
      name: m?.[2] || "?", previousName: m && m[1] !== m[2] ? m[1] : null,
      status: /^new file/m.test(chunk) ? "added" : /^deleted file/m.test(chunk) ? "removed" : /^rename from/m.test(chunk) ? "renamed" : "modified",
      additions: lines.filter((l) => l.startsWith("+")).length, deletions: lines.filter((l) => l.startsWith("-")).length,
      patch: patch && patch.length < 400e3 ? patch.replace(/\n$/, "") : null,
    };
  });
}

// What pushing would change on the PR branch: local commits and the diff against origin/<head>.
async function fixChanges(url) {
  const r = fixEntry(url);
  await git(r.wt, ["fetch", "origin", r.head]).catch(() => {});
  const upstream = `origin/${r.head}`;
  const [log, counts, status, diff] = await Promise.all([
    git(r.wt, ["log", "--format=%h%x09%an%x09%cI%x09%s", `${upstream}..HEAD`]),
    git(r.wt, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`]),
    git(r.wt, ["status", "--porcelain"]),
    git(r.wt, ["diff", upstream, "HEAD"]),
  ]);
  const [behind, ahead] = counts.stdout.trim().split(/\s+/).map(Number);
  return {
    head: r.head, branch: r.branch, worktree: r.wt, ahead, behind,
    uncommitted: status.stdout.split("\n").filter(Boolean).length,
    commits: log.stdout.split("\n").filter(Boolean).map((l) => { const [sha, author, date, ...msg] = l.split("\t"); return { sha, author, date, message: msg.join("\t") }; }),
    files: parseDiff(diff.stdout),
  };
}

// Pushes the worktree's commits to the PR branch. Never forced: if the branch moved, it fails.
async function pushFix(url) {
  const r = fixEntry(url);
  const all = readReviews();
  const key = `fix:${url}`;
  if (BUSY.includes(refresh(all[key]).status)) throw httpError(409, "Claude is still working. Wait for it to finish first.");
  const { stdout } = await git(r.wt, ["rev-list", "--count", `origin/${r.head}..HEAD`]);
  if (Number(stdout.trim()) === 0) throw httpError(409, "There are no new commits to push.");
  try {
    await git(r.wt, ["push", "origin", `HEAD:refs/heads/${r.head}`]);
  } catch (e) {
    throw httpError(409, `Push was refused: ${String(e.stderr || e.message).trim().split("\n").slice(-2).join(" ")}`);
  }
  Object.assign(all[key], { status: "pushed", pushedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  addLog(all[key], `Pushed to ${r.head}`, "done");
  writeReviews(all);
}

// Closes the session and removes the worktree and its local branch. Unpushed commits are lost.
async function discardFix(url) {
  const key = `fix:${url}`;
  const all = readReviews();
  const r = all[key];
  if (!r) throw httpError(404, "No Claude fix for this PR.");
  if (sessionAlive(r.tmux)) execFileSync(TMUX, ["kill-session", "-t", `=${r.tmux}`]);
  if (r.wt && existsSync(r.wt)) await git(r.repoDir, ["worktree", "remove", "--force", r.wt]);
  if (r.branch) await git(r.repoDir, ["branch", "-D", r.branch]).catch(() => {});
  delete all[key];
  writeReviews(all);
}

// ---------- Idle sessions and opening by hand ----------

// Each open session keeps a Claude process running, so idle ones are closed on a timer. They can still
// be resumed later. Answered (or stopped/failed/pushed) sessions close after 30 minutes without activity;
// one still waiting on you stays open for a day so you can answer from your phone.
const IDLE_LIMIT_MS = { answered: 30 * 60e3, pushed: 30 * 60e3, stopped: 30 * 60e3, failed: 30 * 60e3, ended: 30 * 60e3, ready: 24 * 3600e3 };

function endIdleSessions() {
  const all = readReviews();
  let changed = false;
  for (const r of Object.values(all)) {
    const limit = IDLE_LIMIT_MS[r.status];
    if (!limit || !sessionAlive(r.tmux) || Date.now() - new Date(r.updatedAt) < limit) continue;
    try { execFileSync(TMUX, ["kill-session", "-t", `=${r.tmux}`]); } catch {}
    addLog(r, "Session closed after being idle", "event");
    if (r.status === "ready") r.status = "ended";
    r.updatedAt = new Date().toISOString();
    changed = true;
  }
  if (changed) writeReviews(all);
}
setInterval(endIdleSessions, 5 * 60e3).unref();

// Opens the session on this Mac: a Warp window attached to the live tmux session (or resuming it if
// it ended), or the Claude app. On the phone, use the Remote Control link instead.
function openSession(key, where) {
  const r = readReviews()[key];
  if (!r?.sessionId) throw httpError(404, "No Claude session for this PR.");
  const alive = sessionAlive(r.tmux);
  const cwd = r.cwd && existsSync(r.cwd) ? r.cwd : WORKSPACE;
  if (where === "app") {
    if (alive) throw httpError(409, "The session is still running in the background. Open it with the Remote Control link, or end it first.");
    // `claude --desktop` refuses to run without a terminal, so give it one with macOS's `script`.
    spawn("/usr/bin/script", ["-q", "/dev/null", CLAUDE, "--desktop", "--resume", r.sessionId], { cwd, detached: true, stdio: "ignore" }).unref();
    return;
  }
  const name = tmuxName(key);
  // Quoted: zsh would read a bare `=name` as "path of the command name".
  const command = alive ? `${TMUX} attach -t '=${name}'` : `${CLAUDE} --resume ${r.sessionId}`;
  mkdirSync(WARP_LAUNCH_DIR, { recursive: true });
  const file = path.join(WARP_LAUNCH_DIR, `${name}.yaml`);
  // Only a UUID, a fixed tmux name and validated paths go into the command line.
  writeFileSync(file, [
    "---",
    `name: ${name}`,
    "windows:",
    "  - tabs:",
    `      - title: ${name.replace("openprs-", "")}`,
    "        layout:",
    `          cwd: ${cwd}`,
    "          commands:",
    `            - exec: ${command}`,
    "",
  ].join("\n"));
  spawn("open", [`warp://launch/${name}`], { detached: true, stdio: "ignore" }).unref();
  setTimeout(() => { try { unlinkSync(file); } catch {} }, 15000);
}

// ---------- HTTP ----------

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

async function readBody(req, limit = 20000) {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) throw httpError(413, "Request too large.");
  }
  return JSON.parse(raw || "{}");
}

// Writes must come from this page: JSON only (blocks plain cross-site form posts) and a local Origin.
function checkWrite(req) {
  const origin = req.headers.origin;
  const okOrigin = !origin || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`;
  if (!okOrigin || !String(req.headers["content-type"] || "").startsWith("application/json")) {
    throw httpError(403, "Requests must come from the Open PRs page.");
  }
}

const PAGES = new Set(["/", "/index.html", "/mine", "/review"]);

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, `http://localhost:${PORT}`);
  try {
    if (req.method === "GET" && PAGES.has(pathname)) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(await readFile(path.join(HERE, "public", "index.html")));
    }
    if (req.method === "GET" && pathname === "/api/prs") {
      const data = await listPrs();
      return json(res, 200, { ...data, reviews: reviewsSnapshot() });
    }
    if (req.method === "GET" && pathname === "/api/reviews") return json(res, 200, { reviews: reviewsSnapshot() });
    const q = new URL(req.url, `http://localhost:${PORT}`).searchParams;
    if (req.method === "GET" && pathname === "/api/review/screen") return json(res, 200, reviewScreen(q.get("key") || q.get("url") || ""));
    if (req.method === "GET" && pathname === "/api/fix/changes") return json(res, 200, await fixChanges(q.get("url") || ""));
    if (req.method === "GET" && pathname === "/api/pr") {
      return json(res, 200, await prDetails(q.get("repo"), q.get("number")));
    }

    if (req.method === "POST") {
      checkWrite(req);
      // Hook events carry whole reports and tool inputs, so they may be large.
      const body = await readBody(req, pathname === "/api/review-event" ? 4e6 : 20000);
      const url = String(body.url || "");
      // `key` names a session: a PR link for a review, "fix:<link>" for a fix.
      const key = String(body.key || url);
      let extra = {};
      if (pathname === "/api/review") extra = { result: startReview(url, String(body.model || "")) };
      else if (pathname === "/api/review/batch") extra = startBatch(Array.isArray(body.urls) ? body.urls : [], String(body.model || ""));
      else if (pathname === "/api/review/answer") answerReview(url, String(body.answer || ""));
      else if (pathname === "/api/review-event") {
        // From hooks/report.sh: the session key rides in a header, the hook's own JSON is the body.
        const hookKey = String(req.headers["x-open-prs-review"] || "");
        try { parseKey(hookKey); onHookEvent(hookKey, body); } catch {}
        return json(res, 200, { ok: true });
      }
      else if (pathname === "/api/review/stop") stopReview(key);
      else if (pathname === "/api/review/end") endReview(key);
      else if (pathname === "/api/review/open") openSession(key, body.where === "app" ? "app" : "warp");
      else if (pathname === "/api/fix") await startFix(url, String(body.kind || ""), String(body.request || ""), String(body.model || ""));
      else if (pathname === "/api/fix/push") await pushFix(url);
      else if (pathname === "/api/fix/discard") await discardFix(url);
      else if (pathname === "/api/remove-me") await removeMeAsReviewer(url);
      else throw httpError(404, "Not found");
      return json(res, 200, { ok: true, ...extra, reviews: reviewsSnapshot() });
    }
    json(res, 404, { error: "Not found" });
  } catch (e) {
    json(res, e.status || 502, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Open PRs on http://localhost:${PORT}`));
