---
name: review-pr
description: Rigorous code review of a GitHub pull request, compare, or branch URL — fetches the diff and context from GitHub (never the local checkout), loads repo conventions from local clones, cross-checks Jira requirements, and can post inline comments and a verdict via gh. Use this whenever the user pastes a GitHub PR/compare/branch link and asks for a review, feedback, or "check this PR" — even if they don't say "review". Do NOT use for reviewing local uncommitted changes.
argument-hint: <github-pr-or-branch-url>
---

# Review a GitHub PR or branch

Perform a rigorous code review of the changes described by a **GitHub pull request or branch link** — not whatever happens to be checked out locally. Act as a skeptical principal engineer reviewer, not a cheerleader.

**Hybrid context model & execution strategy:**

- **PR scope (diff, metadata, file contents, code search):** GitHub only via `gh` or the GitHub API. Do not use local `git diff`, `git checkout`, or the checked-out branch to determine what changed.
- **Repository conventions (rules, Bugbot, CLAUDE.md):** Read from the matching **local clone** without changing its branch or working tree. Do not fetch rules from GitHub unless no local clone exists.
- **Maximize parallelism:** Group independent tool calls into a single batch. Once the PR metadata and file list are known (Step 1), fetch GitHub file contents (Step 2a), local convention files (Step 2b), and Jira ticket details (Step 2c) **concurrently**.
- **Jira requirements:** When a ticket ID is in the PR title/body, fetch description, **all comments**, and **attachments** via the Atlassian MCP — requirements often change in comments or mockups.

## Step 0 — GitHub link (required)

The user must provide a GitHub URL (in the message or as the skill argument). Without a link, ask once for a PR or branch URL and stop — do not guess from the current branch or workspace.

### What to accept

Parse one of these forms (query strings and `/files` suffixes are fine):

- **Pull request:** `https://github.com/<owner>/<repo>/pull/<n>` (or `.../pull/<n>/files`)
- **Compare:** `https://github.com/<owner>/<repo>/compare/<base>...<head>` (or `..` per GitHub's UI)
- **Branch (tree):** `https://github.com/<owner>/<repo>/tree/<branch>`

Extract at least `owner`, `repo`, and either the PR number `n`, the `base`/`head` ref names (compare), or the `head` branch (tree; resolve `base` as the repo default branch in Step 1).

The URL is the sole source of truth for **which** repository and revision range to review.

### Review artifact id (for concurrent reviews)

Every file written during a review MUST be namespaced so parallel reviews do not clobber each other:

| Review type | `REVIEW_ARTIFACT_ID` |
|-------------|----------------------|
| Pull request | `pr-<PR_NUMBER>` (e.g. `pr-1234`) |
| Compare / tree (no PR #) | `pr-<owner>-<repo>-<head-sha-first-7>` (e.g. `pr-acme-web-a1b2c3d`) |

Use this prefix on **all** review-produced files: `review.json`, drafts, logs, exports, etc.

- **Filename pattern:** `<REVIEW_ARTIFACT_ID>-<purpose>.<ext>` — e.g. `pr-1234-review.json`, `pr-1234-report.md`
- **Location:** Write under `.claude/reviews/` in the **workspace root** (the directory containing the repo clones; create it if needed). Never write review artifacts inside `LOCAL_REPO_ROOT` or other application repos — reviews must not leave files in clones or be disturbed by git operations.
- **Cleanup:** Delete `<REVIEW_ARTIFACT_ID>-review.json` after a successful GitHub post unless asked to keep it. Other artifacts may be kept until the user deletes them.

### Confirm before diffing

One line, then continue to Step 1:

```
Reviewing: owner/repo  <PR#n or base...head>  ref=<head-sha-or-ref>  artifact=<REVIEW_ARTIFACT_ID>  jira=<TICKET-ID|none>  rules=<local|github|none>
```

Every `gh` invocation must include `--repo owner/repo` when the subcommand supports it.

If `gh` is missing or unauthenticated, stop and tell the user to run `gh auth login` (or install `gh`). Do not fall back to a local clone for the diff.

## Step 1 — Establish scope via GitHub

Fetch metadata and the patch from GitHub only. **Run these initial `gh` commands concurrently where possible.**

### Resolve refs and SHAs

**PR** (`/pull/n`):

```bash
gh pr view <n> --repo owner/repo --json number,title,body,baseRefName,headRefName,headRefOid,files,commits
gh pr diff <n> --repo owner/repo
```

Store `HEAD_SHA` = `headRefOid`, `HEAD_REF` = `headRefName`, `BASE_REF` = `baseRefName`, `PR_NUMBER` = `number` (when present).
**Look for a Jira ticket ID (e.g., `XXX-1234`) in the PR `title` or `body`.** Store as `JIRA_KEY` when found.

**Compare or tree** (no PR number):

```bash
gh repo view owner/repo --json defaultBranchRef
gh api repos/owner/repo/compare/base...head
```

For a tree link, set `head` from the URL and `base` from `defaultBranchRef`. Store `HEAD_SHA` from the compare response (`commits[-1].sha` or `merge_base_commit` as appropriate). Set `PR_NUMBER` = empty; derive the artifact id per Step 0.

### Diff triage

Use `gh pr diff` or the compare API patch. For file lists without full patches:

```bash
gh api repos/owner/repo/pulls/<n>/files --paginate
# or compare endpoint: .files[] with filename, patch, additions, deletions
```

If the diff is large (>1000 lines or >30 files), say so up front and propose a review strategy (review by subsystem, or ask which area to prioritize) before generating findings. Do not silently truncate.

## Step 2 — Gather deep context (run 2a, 2b, 2c in parallel)

Once the diff and file list are known, gather all necessary context **concurrently in a single tool call batch**.

### 2a. Read context via GitHub

For every non-trivial changed file, pull **full file contents at `HEAD_SHA`** (and at `BASE_REF` when before/after comparison matters) — not just diff hunks. **Execute these fetches in parallel.**

Fetch a file at a ref:

```bash
gh api repos/owner/repo/contents/<path> --field ref=<HEAD_SHA-or-ref> -q .content | base64 -d
```

Directory listings (e.g. to discover related modules):

```bash
gh api repos/owner/repo/contents/<dir>?ref=<ref>
```

When the diff alone is not enough:

- **Signature changes:** search for callers in the same repo, then fetch each hit file at `HEAD_SHA` for surrounding context:

  ```bash
  gh api "/search/code?q=<symbol>+repo:owner/repo" --paginate
  ```

- **New env vars / config / feature flags:** fetch likely config paths at `HEAD_SHA` (`.env.example`, deploy manifests, infra dirs) via contents API or code search.
- **New DB queries:** fetch the model/repository files referenced in imports at `HEAD_SHA`.

If the change has obvious cross-repo implications (e.g. a BE API contract change with a FE consumer elsewhere), call that out as a **Question for the author** — do not silently assume access to sibling repos; use code search scoped to those repos only if URLs are provided.

### 2b. Resolve local clone and load conventions

Before evaluating the diff, load coding conventions from the **local clone**, not GitHub.

#### Map `owner/repo` → local root

1. Enumerate candidate clone directories under the workspace root (the directory Claude Code was launched from, e.g. `bm`, `fm`, `db`).
2. For each, resolve the GitHub remote and match `owner/repo`:

   ```bash
   git -C <clone-dir> remote get-url origin
   ```

   Accept `git@github.com:owner/repo.git`, `git@github.com-<alias>:owner/repo.git` (SSH host aliases), `https://github.com/owner/repo`, and `.git` suffix variants — match on the `owner/repo` path, not the host.

3. The first matching root is `LOCAL_REPO_ROOT`. If none match, note "no local clone for owner/repo" and fall back to GitHub (below).

#### Read convention files locally (read-only)

**Do not** checkout, pull, stash, reset, or otherwise change branch or working tree in `LOCAL_REPO_ROOT`. Concurrent reviews and in-progress work must not be disturbed.

Load convention files read-only, scoped to the changed paths in the PR diff:

1. **Preferred:** Glob/Read from disk at the clone's **current** checked-out state — do not use `gh api` for rules when a local clone exists.
2. **Optional freshness (still no checkout):** After `git -C <LOCAL_REPO_ROOT> fetch origin` (fetch only), read specific rule files from the remote default branch:

   ```bash
   git -C <LOCAL_REPO_ROOT> show origin/<defaultBranch>:.cursor/rules/<file>.mdc
   ```

   Use `defaultBranch` from `gh repo view owner/repo --json defaultBranchRef -q .defaultBranchRef.name`. Prefer disk when sufficient; use `git show` only when local rules look stale vs `origin/<defaultBranch>`.

Note in the review rubric which branch/state rules were read from (e.g. `rules=local (current branch: feature/foo)` or `rules=local (origin/main via git show)`).

**Which convention files to load:**

| Kind | How to select |
|------|---------------|
| Always-applied rules | Every `.mdc` under `.cursor/rules/` whose frontmatter has no `globs` (or empty `globs`) |
| Path-scoped rules | Every `.mdc` whose `globs` match at least one changed file path in the diff |
| Bugbot | `.cursor/BUGBOT.md` at repo root; also any nested `.cursor/BUGBOT.md` found by walking upward from each changed file's directory (stop at repo root) |
| CLAUDE.md | `CLAUDE.md` at repo root, plus any nested `CLAUDE.md` in directories containing changed files |

If the PR touches paths in multiple repos (e.g. coordinated FE/BE PRs), repeat for each matched local root.

**Fallback when no local clone:**

```bash
gh api repos/owner/repo/contents/.cursor/rules?ref=<HEAD_SHA>
# then fetch each rule file via contents API
```

If no convention files exist locally or on GitHub, note "no convention files found" and proceed with general standards only.

#### Apply conventions in the review

1. Summarize the loaded rules on the fly (always-applied + path-scoped for this diff).
2. Include this summary as a rubric in the review under **Repository conventions**.
3. Actively evaluate the PR/branch against them and call out violations — cite the rule file path (e.g. `.cursor/rules/services/error-handling.mdc`).

### 2c. Fetch business requirements (Jira)

If `JIRA_KEY` was found, fetch the **full ticket context** via the Atlassian MCP tools (if connected). Run these **in parallel** with 2a/2b when possible:

1. **`jira_get_issue`** — summary, description, type, labels, and comments. Set `comment_limit` to **100** (read **all** comments — requirements and constraints often appear there, not in the description). Use `expand=renderedFields` when available. Note `issuetype.name` (Bug vs Story/Feature) — affects how strictly to gate on acceptance criteria vs. implementation gaps.
2. **`jira_get_issue_images`** — inline image attachments (mockups, screenshots, Figma exports). Compare UI in the PR against what the ticket shows.
3. **`jira_download_attachments`** — non-image attachments (specs, CSVs, logs, PDFs). Skim for requirements, edge cases, or repro steps not in the description.

**What to extract:**

| Source | Focus |
|--------|--------|
| Description | Acceptance criteria, steps to reproduce (bugs), scope |
| Comments | Scope changes, clarifications, QA notes, "actually we need…" — treat newer comments as potentially overriding older text |
| Images | Expected UI layout, labels, empty/error states |
| Other attachments | Data samples, repro payloads, written specs |

If no Jira ticket is found, note `jira=none` and evaluate based on the PR description alone. If the Atlassian MCP is unavailable or the ticket cannot be fetched, note the failure and proceed from the PR body only — do not invent ticket requirements.

## Step 3 — Review dimensions

Evaluate the diff against each of these. Skip dimensions that genuinely don't apply, but say so briefly so the user knows you considered them. Be rigorous: brainstorm edge cases, missing error handling, and unhandled states.

### Requirements & acceptance criteria

- Cross-check the diff against the Jira ticket — **description, comments, and attachments** (Step 2c), not the description alone.
- Does the code fully implement the requested feature or fix the bug as described?
- Flag requirements stated only in **comments** or **attachments** that the PR missed.
- Brainstorm and verify edge cases: empty, zero, null, or unusually large inputs? Edge cases implied by the ticket (including comment thread or mockups) that the PR missed?

### Repository conventions

Use the rubric built in Step 2b. Do not re-fetch rules from GitHub when a local clone was resolved.

### Correctness & edge cases

- Off-by-one, null/undefined handling, unhandled promise rejections, swallowed errors.
- **Edge cases:** unhappy paths (API failures, network timeouts), empty arrays/lists, unexpected falsy values, malformed data structures.
- Concurrency: shared mutable state, race conditions, missing transactions, non-idempotent handlers.
- **Date & timezone handling:** business dates stored as noon UTC, displayed in the brand's local timezone. Flag any `new Date(string)` without explicit UTC parsing, any `.toISOString().split('T')[0]` patterns, and any date math that could cross a DST boundary.

### Security

- Input validation on all external boundaries (HTTP handlers, Pub/Sub message handlers, webhook receivers).
- SQL/NoSQL injection: parameterized queries only.
- Secrets: nothing hardcoded; reads from Secret Manager or env.
- AuthN/AuthZ: every new endpoint or RPC explicitly enforces RBAC. Multi-tenant boundary checks (tenant/brand/property scoping) on every query that touches tenant data.
- PII / financial data exposure in logs.

### Performance & data access

- N+1 queries — look for loops issuing DB calls.
- Missing indexes for new query shapes (esp. AlloyDB).
- Elasticsearch: mapping changes that require reindex, queries that bypass aliases, missing analyzers, fielddata risks.
- BigQuery: full table scans, missing partition/cluster predicates, costly JOINs.
- Pub/Sub: ack deadlines vs handler latency, lack of idempotency for at-least-once delivery.
- Cloud Run: handlers that block the event loop, cold-start-sensitive imports.

### Database & migrations

- Schema changes are backward-compatible for the duration of a rolling deploy (additive first, drop later).
- New columns nullable or have defaults.
- Migrations don't lock large tables.
- Replication slot impact considered for changes that bulk-update rows.

**DDL is owned by the Data team.** In `bm`, DDL/migrations for entity changes
(e.g. new columns on `@purepm/db-entities` models) are applied by the Data team
through their own workflow — migration files are **not** expected in the repo.
Do not flag a missing migration, and do not ask the author to confirm the
`ALTER TABLE` is applied; that coordination is out of scope. Still review the
entity definition itself against the rules above (additive, nullable/defaulted,
correct declared type).

### Frontend (Vue/React/TS)

- State that should be derived isn't being stored.
- Effects with missing or over-broad dependencies.
- **Edge cases:** error states, loading spinners, empty states, and partial data states present for every async UI.
- Accessibility: keyboard nav, focus management, alt text on meaningful images.
- Date display uses brand timezone, not user's local.

### Feature flags (LaunchDarkly)

- New flags use attribute-based targeting where possible (avoid list-based segments — they bloat MAU).
- Flag cleanup TODOs on temporary flags.
- Flag default value is the safe one.

### Observability

- Structured logs at the right boundaries (request in/out, external call in/out).
- Datadog tracing preserved across Pub/Sub boundaries.
- New error paths emit the right log level and include enough context to debug from the log alone.

### API & contract

- Backward-compatible response shapes (no removed fields, no changed types).
- New optional fields documented.
- Breaking changes versioned or coordinated with consumers.

### Style & maintainability

- Naming. Function/file size. Dead code. Commented-out code. `TODO` without a ticket reference.
- Don't nitpick formatter-owned things (Prettier/Black/gofmt). Skip them.

## Step 4 — Output format

**The full report printed in chat is the primary deliverable of this skill.** Write it out in its entirety as a normal chat message — never summarize it away, never skip ahead to the posting question, and never bury it in a file. Progress notes emitted while investigating do not count as the report; the complete structured report below must appear in the final message of the turn. The user reads and judges the review here before anything touches GitHub.

Lead the report with the confirmation line from Step 0 (`owner/repo`, PR or ref range, `ref=<head-sha-or-ref>`). Then:

### **Summary** — 2–3 sentences: what this change does, and the single most important thing the author should fix first.

End the summary with a **Verdict** (for the **chat report**; when posting to GitHub use only the short phrase from Step 5):

- No issues/comments at all: "Verdict: LGTM" → GitHub: `LGTM`
- Non-blocking suggestions or nits but no blocking issues: "Verdict: LG. Approved with comments." → GitHub: `LG. Approved with comments.`
- Blocking issues: "Verdict: Changes requested." → GitHub: `Changes requested.`

### **Number the review result items** sequentially across all categories below for identification.

### **Repository conventions** — rubric from Step 2b: which rule files were loaded (always-applied + path-scoped), source (`local` vs `github` fallback), and a one-line summary per rule. Violations belong in Blocking/Non-blocking below with the rule path cited.

### **Blocking issues** — anything that must be fixed before merge. Each entry:

<number>. File and line range

- **Issue:** what's wrong
- **Why it matters:** concrete failure mode, not "best practice says"
- **Suggestion:** code snippet if small — in the chat report use a fenced block; when **posting to GitHub**, wrap code fixes in a ` ```suggestion ` block per Step 5. The chat report is full detail; the GitHub top-level review body is **verdict text only**.

### **Non-blocking suggestions** — same format, but stuff that would improve the change without gating it.

### **Nits** — formatting, naming, minor cleanup. Keep terse, one line each. Group if many.

### **Questions for the author** — things you genuinely can't tell from the diff (intent, missing context, cross-repo implications). Don't pad with rhetorical questions.

### **Things you checked and they look good** — short list. Include which convention files were applied, whether Jira comments/attachments were reviewed, and whether they came from the local clone. This is calibration, not flattery; it tells the user what you actually verified vs. skipped.

## Step 5 — Verdict and posting to the PR

When the analysis is done, end the turn with **one final chat message** containing, in order: the **entire Step 4 report**, then the question below at the bottom. **Do NOT use the AskUserQuestion tool** — output the question as regular text, so the report is guaranteed to be fully visible above it, then stop and wait for the user's typed reply. Do not run any `gh` posting commands and do not write `<REVIEW_ARTIFACT_ID>-review.json` until the user has answered. The full report lives in chat only — never in the GitHub review body.

End the report message with exactly:

**How would you like to proceed with the PR review via `gh`?**
A. Perform suggested verdict
B. Comment all the issues only
C. Comment all issues and perform suggested verdict
D. Do nothing — keep the review in chat only

When the user picks an option (A, B, or C), read [references/posting-to-github.md](references/posting-to-github.md) for the exact posting mechanics: top-level body rules, ` ```suggestion ` block format, the review JSON schema, and the `gh api` submission commands. Key invariants:

- Inline comments require a PR number; for compare/tree-only reviews, explain that posting review comments needs an open PR.
- The **top-level review body is the verdict phrase alone** (`LGTM` / `LG. Approved with comments.` / `Changes requested.`) — no headings, no summary, no "see inline comments".
- All substantive feedback goes in **inline comments** on the relevant lines, with ` ```suggestion ` blocks for applyable code fixes.
- Verify every cited line number by fetching the file at `HEAD_SHA` — diff hunk headers are not sufficient.

## Constraints

- **GitHub for PR scope; local for conventions.** Use `gh` / GitHub API for diffs, changed-file contents at `HEAD_SHA`, and in-repo code search. Use the local filesystem **only** for read-only access to convention files (`.cursor/rules/**/*.mdc`, `.cursor/BUGBOT.md`, `CLAUDE.md`) and resolving `owner/repo` → local clone. **Never** checkout, pull, or reset in application repos. Never use local `git diff` or checkout to determine what changed in the PR.
- **Review artifacts.** All files produced during a review use `<REVIEW_ARTIFACT_ID>-*` naming and live under `.claude/reviews/` in the workspace root — not inside `LOCAL_REPO_ROOT`.
- **CRITICAL: line number accuracy.** Verify every cited line by fetching the file at `HEAD_SHA` from GitHub and locating the exact line in that content. Diff hunk headers (`@@ ... @@`) are not sufficient.
- Cite `path:line` for every finding (paths as in the repo root on GitHub). No vague "somewhere in the auth module" feedback.
- Severity matters. Do not list a missing JSDoc comment next to a SQL injection. If everything is "important," nothing is.
- If you're not sure something is a bug, say "possible issue" and explain what you'd need to verify it.
- Do not invent issues to fill out the report. A short, accurate review beats a long, padded one.
- Do not propose changes outside the diff scope unless they directly enable a fix.
- Do not run project test runners or test commands (`npm test`, `pytest`, `go test`, `cargo test`, etc.). CI runs the suite; this review is static analysis of the diff and GitHub-fetched context only.
- **GitHub top-level body.** When applying a verdict, post only the short verdict phrase — never the summary, rubric, or report sections from Step 4.
