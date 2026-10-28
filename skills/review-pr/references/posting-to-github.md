# Posting the review to GitHub

Read this when the user has chosen option A, B, or C in Step 5. All commands use `--repo owner/repo` and the values resolved in Steps 0–1 (`PR_NUMBER`, `HEAD_SHA`, `REVIEW_ARTIFACT_ID`).

## Top-level review body — verdict text only

The full review report (summary, rubric, blocking issues, nits, etc.) is printed in chat only. When posting to GitHub, the **top-level review `body` must be the verdict phrase alone** — short, personal, no headings, no summary, no "See inline comments", no nits, no questions.

| Verdict | GitHub `-b` / `body` value (exact) |
|---------|-----------------------------------|
| LGTM | `LGTM` |
| LG with comments | `LG. Approved with comments.` |
| Changes requested | `Changes requested.` |

**Do not** post to GitHub:

- `**Summary**` / `**Verdict:**` headings or markdown section headers
- PR description-style summaries of what the change does
- Pointers like "See inline comments for details"
- Nits, questions, or convention rubrics in the top-level body

Put **all** substantive feedback in **inline comments** on the relevant lines. The top-level comment should read like a quick human sign-off.

## Option A — verdict only, no inline comments

```bash
gh pr review <n> --repo owner/repo --approve -b "LGTM"
gh pr review <n> --repo owner/repo --approve -b "LG. Approved with comments."
gh pr review <n> --repo owner/repo --request-changes -b "Changes requested."
```

## Option B — inline comments only, no approve/request-changes

Submit via the pulls review API with `"event": "COMMENT"` and `"body": ""` (empty) or omit a meaningful body — never duplicate the chat report in `body`.

## Option C — verdict + inline comments

One review via the pulls review API — `"body"` is **only** the verdict phrase; all issues live in `"comments"`.

## Inline comment format

Each inline comment body:

```markdown
### Issue:

<Explain the issue>

### Why it matters:

<Explanation>

### Suggestion:

<Short prose explanation, then a GitHub suggestion block — see below>
```

Format identifiers with inline `` `backticks` ``.

## GitHub suggestion blocks (required for code fixes)

When the fix is a **code change**, use GitHub's native **suggestion** fence so the author gets an **Apply suggestion** button on the inline comment. Do not use plain ` ```ts ` / ` ```javascript ` fences for replaceable code.

**Format:**

````markdown
### Suggestion:

<Brief explanation of the change.>

```suggestion
<exact replacement lines — what the file should contain after the fix>
```
````

**Rules:**

| Rule | Detail |
|------|--------|
| Fence label | Exactly ` ```suggestion ` — no language tag (`ts`, `vue`, etc.) |
| Content | Replacement text only, not a unified diff (`-`/`+` lines) |
| Scope | Lines in the block replace the line(s) the inline comment is attached to |
| Single-line fix | Comment on that line; suggestion block contains the one replacement line |
| Multi-line fix | Use GitHub's multi-line comment API: set `start_line` (first line) and `line` (last line) on the same `side: "RIGHT"` hunk |
| Context | Include unchanged surrounding lines inside the suggestion **only** when replacing a contiguous range (GitHub replaces the whole commented range) |
| Non-code fixes | Prose-only under **Suggestion:** (no suggestion block) — e.g. config steps, rename across repo, add a test file |
| JSON body | In `<REVIEW_ARTIFACT_ID>-review.json`, escape newlines as `\n`; keep the suggestion fence intact inside the string |

**Single-line example** (inline comment on line 42):

````markdown
### Issue:

Missing null guard before accessing `lease.tenant`.

### Why it matters:

Throws at runtime when `tenant` is absent on draft leases.

### Suggestion:

Return early when tenant is missing.

```suggestion
if (!lease.tenant) return null;
```
````

**Multi-line example** (`<REVIEW_ARTIFACT_ID>-review.json` comment object):

```json
{
  "path": "src/handler.ts",
  "start_line": 10,
  "line": 14,
  "side": "RIGHT",
  "body": "### Issue:\n...\n\n### Why it matters:\n...\n\n### Suggestion:\nReplace the try/catch swallow with explicit error mapping.\n\n```suggestion\n  try {\n    return await service.fetch(id);\n  } catch (err) {\n    throw mapServiceError(err);\n  }\n```"
}
```

**Do not:**

- Use ` ```typescript ` or other language fences for apply-able fixes
- Put suggestion blocks in the top-level review body only (they must be on **inline** comments to enable Apply)
- Suggest changes spanning non-contiguous lines in one block (split into separate inline comments)

## Submitting inline comments via the GitHub API

1. Resolve `HEAD_SHA` again if needed: `gh pr view <n> --repo owner/repo --json headRefOid -q .headRefOid`
2. **Verify line numbers:** fetch the file at `HEAD_SHA` via the contents API, decode, and confirm the cited line matches the code you reference. Do not infer line numbers from diff hunk headers alone.
3. Build `<REVIEW_ARTIFACT_ID>-review.json` under `.claude/reviews/` in the workspace root:

```json
{
  "commit_id": "<HEAD_SHA>",
  "body": "LG. Approved with comments.",
  "event": "APPROVE",
  "comments": [
    {
      "path": "path/to/file.ts",
      "line": 42,
      "side": "RIGHT",
      "body": "### Issue:\n...\n\n### Why it matters:\n...\n\n### Suggestion:\n```suggestion\n...\n```"
    }
  ]
}
```

`event` is `APPROVE`, `REQUEST_CHANGES`, or `COMMENT`.

4. Submit:

```bash
gh api --method POST -H "Accept: application/vnd.github+json" \
  /repos/owner/repo/pulls/<n>/reviews --input .claude/reviews/<REVIEW_ARTIFACT_ID>-review.json
```

5. Delete `.claude/reviews/<REVIEW_ARTIFACT_ID>-review.json` after a successful post unless asked to keep it.
