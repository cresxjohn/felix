# Felix

Felix: my buddy. Formerly the PURE Tech Lead Command Center.


A small app on your Mac at `http://localhost:4777`. Today it is the Work view, for the work a tech lead does every day. Its home page is a grid of cards:

- **Incident Commander** (live): who is on call now and next, today's and tomorrow's people on the Philippines and Americas schedules, and your next shift. From Datadog On-Call.
- **Open PRs** (live): counts that need you, each opening the PR page already filtered.
- **Calendar**, **Tasks**, **Team out of office** and **My Jira Board**: placeholders for now.

The **Open PRs** page (`/prs`) lists your PRs and the PRs waiting on your review in fm (`purepm/frontend-monorepo`) and bm (`purepm/backend-monorepo`). Claude Code can review or fix them for you in the background.

The plan for the rest is here: https://claude.ai/artifact/AKv4sNUDchA8npNnx8cjTB (a copy with the mock-ups lives in [docs/PLAN.md](docs/PLAN.md), for reading in an editor)

New Mac or reinstall? Follow [SETUP.md](SETUP.md).


## What it does

**Home** (`/`)
- **Incident Commander:** who is on now and until when, who is next, the two teams' people for today and tomorrow, and your next shift with how many days to go. It reads Datadog every hour, and right after midnight. **R** or the refresh button asks Datadog again at once.
- **Open PRs:** how many PRs need your review, have new commits, or have a Claude review waiting on you, and how many of yours are in the merge queue, ready to merge, failing checks, in conflict, have requested changes or a Claude fix waiting. Each line opens the PR page with that filter on. Below them, each repo's open release (status, how many of your PRs it ships, Approve or Merge) and last release (on dev, in prod).

**Two lists**
- **My PRs** (`/prs/mine`) and **Needs my review** (`/prs/review`), straight from GitHub. The old `/mine` and `/review` links still work.
- Each PR shows its Jira ticket, review state, checks, merge conflicts and size (XS to XL).
- Search, status filters, repo filter, sorting and grouping. Every view has its own link, for example `/review?status=failing&pr=fm-12247`.
- **Copy link** on every PR, and **Remove me** to drop yourself from a PR's reviewers on GitHub. Remove me asks for a second click first.
- **Merge** on your PRs that GitHub says are ready (approved, checks pass, no conflicts). It adds the PR to the merge queue, which squashes it into main, and asks for a second click first. A PR in the queue shows its place.
- **Releases** at the top of the PR page: for fm and bm, the open "chore: release main (changeset)" PR with its checks and whether it can merge, which of your merged PRs it ships (and in which packages), every change it includes, and where the last release got to: its dev deploy ("1 - Merges to main") and whether it reached prod. A release counts as in prod once a successful prod promotion's `promotion-manifest.yml` lists all its deployable packages at that version or newer; libraries are skipped. Each repo has an Open release card (with "You approved" as a badge once you have) and a Last release card. Each card shows the release's status (ready to merge, awaiting reviewers, changes requested, or in the merge queue) with **Approve** and **Merge** buttons, both asking for a second click. Cards start folded; open the ones you want.
- **Select PRs** with the checkboxes on either tab. On My PRs you can merge the ready ones or copy all their links at once; on Needs my review you can start Claude reviews or copy links.

**Details panel** (the right half of the screen)
- **Conversation:** the description, reviews, comments and inline code comments, plus reviewers, labels and assignees.
- **Commits** and **Checks**, each check with a link to its details.
- **Files changed:** each file's changes, with line numbers.
- The panel is rebuilt from the GitHub API, because GitHub pages can't be shown inside another page.

**Claude review** (other people's PRs)
- Runs your `/review-pr` skill in a hidden session on your Mac, with Remote Control on, so you can follow it in the Claude phone app.
- It shows live progress, a live terminal view and a step log, then the full review.
- You pick **A–D** for what to post. Nothing goes to GitHub before you do, and posting needs a second click.
- **Review several at once:** at most 3 run at a time; the rest wait in a queue.
- A **Re-review** button appears when the author pushes after your review.

**Claude fix** (your own PRs)
- Fixes failing checks, resolves a merge conflict, works through review comments, or does what you type.
- It works in its own git worktree (`<repo>-wt-pr-<n>`), so your checkout isn't touched.
- Claude commits there but can't push. You read the commits and diff in the **Changes** tab, then press **Push** (never forced) or **Discard**.

**Around it**
- A model picker: a global default at the top, and a per-PR override in the panel.
- Mac notifications when a review or fix needs you, or a new review request arrives.
- Starts at login. Idle Claude sessions close on their own.


## How it works

```
Browser ─► server.mjs (127.0.0.1:4777) ─► GitHub API (token from `gh auth token`)
                ├─► datadog.mjs ─► Datadog On-Call API (token from the Keychain)
                │
                ├─► tmux ─► claude --remote-control … "/review-pr <url>"   (review)
                │      └─► claude … in <repo>-wt-pr-<n>                    (fix)
                │
                └─◄ hooks/report.sh ◄─ Claude Code hooks (progress, done, waiting)
```

- `server.mjs`: the whole server. Plain Node 22.5+, no npm packages. It serves the page, talks to GitHub, and starts and tracks Claude sessions.
- `datadog.mjs`: the Incident Commander data. It reads the token from the Keychain, steps through the shifts, and caches them for an hour.
- `public/home.html`: the home page with its cards.
- `public/index.html`: the Open PRs page (HTML, CSS and JS in one file).
- `public/theme.css` (colors and fonts) and `public/pr-status.js` (what state a PR is in) are shared by both pages. Page edits only need a reload.
- `skills/review-pr/`: the `/review-pr` skill that reviews use. On start, the server links it into the workspace's `.claude/skills/` if it isn't there yet.
- `hooks/report.sh`: a Claude Code hook that forwards session events to the server. It only runs in sessions this server starts.
- `prs`: start, stop, install at login (macOS LaunchAgent), status and logs.
- `data/`: local state (sessions, logs). It is not in git.

**Safety**
- The server only listens on `127.0.0.1`.
- Write requests must be JSON from the page itself, so other websites can't trigger them.
- Fix sessions can't run `git push` or post on PRs.
- No secrets are stored in this folder. The Datadog token lives in the macOS Keychain.


## Commands

```bash
./prs install     # start now and at every login
./prs status
./prs restart     # after editing server.mjs
./prs logs
./prs stop
./prs uninstall   # stop starting at login
```


## API

All routes are local only.

| Route | What it does |
| --- | --- |
| `GET /api/incident-commander` | On-call shifts for today, tomorrow and my next shift (`?fresh=1` skips the hour cache) |
| `GET /api/prs` | Both PR lists from GitHub, plus Claude sessions |
| `GET /api/releases` | Each repo's open release PR, my PRs in it, and the last release's dev and prod status (`?fresh=1` skips the 1-minute cache) |
| `GET /api/reviews` | Claude sessions only (the page polls this) |
| `GET /api/pr?repo=fm&number=1` | One PR's details for the panel |
| `GET /api/review/screen?key=` | A session's terminal screen |
| `POST /api/review` | Start or queue a Claude review `{ url, model? }` |
| `POST /api/review/batch` | Review several PRs `{ urls, model? }` |
| `POST /api/review/answer` | Answer A–D `{ url, answer }` |
| `POST /api/review/stop` | Interrupt a session, or take a review out of the queue `{ key }` |
| `POST /api/review/end` | Close a session `{ key }` |
| `POST /api/review/open` | Open a session in Warp or the Claude app `{ key, where }` |
| `POST /api/fix` | Start a fix on my PR `{ url, kind, request?, model? }` |
| `GET /api/fix/changes?url=` | The fix's commits and diff |
| `POST /api/fix/push` | Push the fix to the PR branch `{ url }` |
| `POST /api/fix/discard` | Close the fix and remove its worktree `{ url }` |
| `POST /api/remove-me` | Remove me from a PR's reviewers `{ url }` |
| `POST /api/merge` | Add my ready PR, or a ready release PR, to the merge queue `{ url }` |
| `POST /api/release/approve` | Approve a release PR (only `changeset-release/main`) `{ url }` |
| `POST /api/merge/batch` | The same for several PRs, one at a time `{ urls }` |
| `POST /api/review-event` | Hook events from Claude sessions |

A session `key` is the PR link for a review, or `fix:<PR link>` for a fix.


## Roadmap

From the plan:

1. Home page with cards; the PR page moves to `/prs`. **Done.**
2. Incident Commander (Datadog on-call). **Done.**
3. Calendar and Team out of office (Google Calendar).
4. Tasks.
5. Jira board card, a Jira tab in the panel, and a Team view of everyone's open PRs.
6. A setup wizard with this guide built in, so a new Mac sets itself up from the page.
