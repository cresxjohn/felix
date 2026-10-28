# Open PRs — setup guide

Open PRs is a small page on your Mac at `http://localhost:4777`. It lists your open PRs and the PRs waiting on your review in fm and bm. It can also run Claude Code reviews and fixes in hidden sessions that you can follow from your phone.

This guide sets it up on a new Mac, or after a reinstall. Follow the steps in order. It takes about 20 minutes, most of it installing tools.

It is also the first piece of the Tech Lead Command Center. The plan for that is here: https://claude.ai/artifact/AKv4sNUDchA8npNnx8cjTB


## 1. What you need

Install these first. Each line says how.

- **Homebrew** (installs the other tools): see https://brew.sh
- **GitHub CLI** and **tmux**:
  ```bash
  brew install gh tmux
  ```
- **Node.js 22.5 or newer** (24 is what it runs on today), through nvm:
  ```bash
  brew install nvm
  nvm install 24
  ```
- **Claude Code** (the `claude` command), installed to `~/.local/bin/claude`: see https://code.claude.com/docs
- **Claude desktop app** (for "Resume in Claude app"), and the **Claude phone app** (to follow reviews on your phone).
- **Warp** (for "Watch in Warp" and "Resume in Warp"): https://www.warp.dev. This one is optional: everything else works without it.

Docker is **not** needed anymore.


## 2. Sign in

Both logins are needed. The page reads GitHub through `gh`, and the review sessions run as the terminal `claude` login, not the desktop app's.

```bash
gh auth login
```

```bash
claude auth login
```

Check both:

```bash
gh auth status
```

```bash
claude auth status
```

`claude auth status` must say `"loggedIn": true`.


## 3. Folder layout

The server expects this layout. The folder *above* `open-prs` is the workspace that review sessions run in.

```
~/dev/pure/repo/                 the workspace
├── fm/                          git clone of purepm/frontend-monorepo
├── bm/                          git clone of purepm/backend-monorepo
├── .claude/skills/review-pr/    the /review-pr skill (SKILL.md + references/)
└── open-prs/                    this project
    ├── server.mjs               the server (no npm packages needed)
    ├── prs                      start / stop script
    ├── public/index.html        the page
    ├── hooks/report.sh          tells the server what a Claude session is doing
    ├── SETUP.md                 this guide
    ├── .gitignore               keeps data/ and hooks/settings.json out of git
    └── data/                    made on first start; your local state (see section 7)
```

This project lives in a private repo on your personal GitHub account: https://github.com/cresxjohn/open-prs

It is pushed and pulled with your personal SSH key, through the `github.com-personal` host alias, so your work `gh` login doesn't matter here. On a new Mac, first add that alias to `~/.ssh/config` with your personal key:

```
Host github.com-personal
  HostName github.com
  User git
  IdentityFile ~/.ssh/<your personal key>
  IdentitiesOnly yes
```

Check it says "Hi cresxjohn!":

```bash
ssh -T git@github.com-personal
```

Then, inside `~/dev/pure/repo/`, get this project:

```bash
git clone git@github.com-personal:cresxjohn/open-prs.git
```

Clone fm and bm next to it, with your work login:

```bash
gh repo clone purepm/frontend-monorepo fm
```

```bash
gh repo clone purepm/backend-monorepo bm
```

Bring these over from the old Mac by hand (they are not in this repo):

- `repo/.claude/skills/` (the review-pr and review-staged skills),
- `repo/.claude/settings.local.json` if you want the same Claude permissions in the workspace,
- `open-prs/data/` only if you want your old review history; otherwise it starts fresh.

Commits in this repo use your personal identity (`cresxjohn`), which is your global git setting. If that ever changes, set it for this repo only: `git config user.email cresellejohn@gmail.com`.


## 4. Install and start

From the `open-prs` folder:

```bash
./prs install
```

This starts the server and sets it to start by itself every time you log in. It also restarts the server if it ever crashes. The page opens in your browser.

Check it:

```bash
./prs status
```

Run `./prs install` again any time you change your Node version (it saves the path to `node` it finds).


## 5. Daily use

You normally do nothing: the page is there after you log in. Keep it open in a pinned browser tab so notifications reach you.

- `./prs start`: start it, if you stopped it
- `./prs stop`: stop it until you log in again (or run start)
- `./prs restart`: restart it, after you change `server.mjs` (edits to `public/index.html` only need a page reload)
- `./prs status`: is it running, and does it start at login
- `./prs logs`: watch the server log

The page's links are shareable views: `/mine`, `/review`, plus search settings such as `/review?status=failing&pr=fm-12247&panel=files`.


## 6. Notifications

Click **Turn on notifications** at the top right of the page and allow them in Chrome. You get a Mac notification when:

- a Claude review is ready for your A–D answer,
- Claude needs your approval or a session fails,
- a Claude fix is ready to push,
- a new review request arrives, or someone pushes new commits after your review.

The tab must stay open; the page checks GitHub every 5 minutes. Claude's built-in browser always blocks notifications, so use Chrome.


## 7. Where things are saved

- `open-prs/data/reviews.json`: every Claude review and fix session, its status, its step log and its report
- `open-prs/data/server.log`: the server's log
- `open-prs/hooks/settings.json`: rewritten on every server start; don't edit it
- `~/Library/LaunchAgents/local.open-prs.plist`: the start-at-login entry (made by `./prs install`)
- `~/.warp/launch_configurations/openprs-*.yaml`: short-lived files that open Warp windows; they delete themselves
- `repo/<fm|bm>-wt-pr-<number>/` and local branch `openprs/pr-<number>`: worktrees made by **Fix with Claude**. **Discard** on the page removes both
- tmux sessions named `openprs-*`: the hidden Claude sessions (`tmux ls` lists them). Idle ones close by themselves: 30 minutes after you answer, or 24 hours if Claude is still waiting on you
- your browser: the last list (so the page loads instantly), your model choice and notification setting

Nothing secret is saved in this folder. The GitHub token is read from `gh` each time.


## 8. Settings you can change

The server reads these environment variables. You only need them if a tool lives somewhere else on the new Mac. To use one, add it under `EnvironmentVariables` in the LaunchAgent file, then run `./prs restart`.

- `PORT`: the page's port (default 4777)
- `CLAUDE_BIN`: the `claude` command (default `~/.local/bin/claude`)
- `GH_BIN`: the `gh` command (default `/opt/homebrew/bin/gh`)
- `TMUX_BIN`: the `tmux` command (default `/opt/homebrew/bin/tmux`)

On an Intel Mac, Homebrew uses `/usr/local/bin`, so set `GH_BIN` and `TMUX_BIN`.


## 9. Troubleshooting

- **"Can't reach the local server"**: it isn't running. Run `./prs start`, then `./prs logs` if it won't stay up.
- **A review fails with "OAuth session expired"**: the terminal Claude login lapsed. Run `claude auth login`, then **Review again**.
- **"GitHub refused your gh login"**: run `gh auth login`, then `./prs restart`.
- **A Claude session sits on "Starting Claude" forever**: it is waiting on a question in its terminal. Click **Watch in Warp**, or run `tmux attach -t '=openprs-fm-12247'` (use your PR's name), and answer it. The server already answers the "Do you trust this folder?" question for fix worktrees by itself.
- **"Watch in Warp" says "not found"**: an old version left `=name` unquoted, and zsh reads that as a command. Update `server.mjs`.
- **Fix with Claude fails right after "Preparing worktree"**: bm runs `npm install` in a git hook after checkout. The server skips hooks for that one step; if you see this again, check `./prs logs`.
- **Port 4777 is taken**: find what uses it with `lsof -iTCP:4777 -sTCP:LISTEN`.
- **The page looks stuck on old data**: press **R** or the refresh button. The header says "Saved list from …" until fresh data arrives.


## 10. Coming later: command center keys

The command center plan needs a few keys. They go into the Mac's Keychain, never into files or chat. Each command asks for the value without showing it on screen:

```bash
security add-generic-password -s open-prs-datadog-api -a datadog -w
```

```bash
security add-generic-password -s open-prs-datadog-app -a datadog -w
```

```bash
security add-generic-password -s open-prs-jira -a <your Jira email> -w
```

```bash
security add-generic-password -s open-prs-calendar-ics -a google -w
```

On a new Mac, add them again the same way. The plan doc's "What I need from you" section says where each key comes from.


## 11. Remove it

```bash
./prs uninstall
```

This stops the server and removes the start-at-login entry. To clean up Claude sessions too:

```bash
tmux kill-server
```

Discard any fix worktrees from the page first, so their local branches are removed as well.
