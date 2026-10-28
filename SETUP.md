# Felix — setup guide

This project runs Felix (formerly the Tech Lead Command Center) on your Mac at `http://localhost:4777`. The home page has an Incident Commander card (from Datadog) and an Open PRs card; the rest are placeholders for now. The Open PRs page (`/prs`) lists your PRs and the PRs waiting on your review in fm and bm. It can also run Claude Code reviews and fixes in hidden sessions that you can follow from your phone.

The plan for the rest is here: https://claude.ai/artifact/AKv4sNUDchA8npNnx8cjTB

This guide sets it up on a new Mac, or after a reinstall. Follow the steps in order. It takes about 20 minutes, most of it installing tools.


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

The server expects this layout. The folder *above* `felix` is the workspace that review sessions run in.

```
~/dev/pure/repo/                 the workspace
├── fm/                          git clone of purepm/frontend-monorepo
├── bm/                          git clone of purepm/backend-monorepo
├── .claude/skills/review-pr     a link to the skill in this project (the server makes it on first start)
└── felix/                       this project
    ├── server.mjs               the server (no npm packages needed)
    ├── datadog.mjs              the Incident Commander card's data
    ├── prs                      start / stop script
    ├── public/home.html         the home page (cards)
    ├── public/index.html        the Open PRs page
    ├── public/theme.css         colors and fonts both pages share
    ├── public/pr-status.js      PR state rules both pages share
    ├── skills/review-pr/        the /review-pr skill reviews use
    ├── hooks/report.sh          tells the server what a Claude session is doing
    ├── README.md                what it does and how it works
    ├── SETUP.md                 this guide
    ├── .gitignore               keeps data/ and hooks/settings.json out of git
    └── data/                    made on first start; your local state (see section 7)
```

This project lives in a private repo on your personal GitHub account: https://github.com/cresxjohn/felix

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
git clone git@github.com-personal:cresxjohn/felix.git
```

Clone fm and bm next to it, with your work login:

```bash
gh repo clone purepm/frontend-monorepo fm
```

```bash
gh repo clone purepm/backend-monorepo bm
```

Bring these over from the old Mac by hand (they are not in this repo):

- `repo/.claude/skills/review-staged/` if you use it. The review-pr skill comes with this repo: on first start the server links it into `repo/.claude/skills/`. If that folder already has a review-pr, the server leaves it alone.
- `repo/.claude/settings.local.json` if you want the same Claude permissions in the workspace,
- `felix/data/` only if you want your old review history; otherwise it starts fresh.

Commits in this repo use your personal identity (`cresxjohn`), which is your global git setting. If that ever changes, set it for this repo only: `git config user.email cresellejohn@gmail.com`.


## 4. Install and start

From the `felix` folder:

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

The home page is `/`. The Open PRs page's links are shareable views: `/prs/mine`, `/prs/review`, plus search settings such as `/prs/review?status=failing&pr=fm-12247&panel=files`. Old `/mine` and `/review` links still work.


## 6. Notifications

Click **Turn on notifications** at the top right of the page and allow them in Chrome. You get a Mac notification when:

- a Claude review is ready for your A–D answer,
- Claude needs your approval or a session fails,
- a Claude fix is ready to push,
- a new review request arrives, or someone pushes new commits after your review.

The Open PRs page sends these, so keep `/prs` open in a pinned tab; the home page doesn't send them yet. The page checks GitHub every 5 minutes. Claude's built-in browser always blocks notifications, so use Chrome.


## 7. Where things are saved

- `data/reviews.json`: every Claude review and fix session, its status, its step log and its report
- `data/server.log`: the server's log
- `hooks/settings.json`: rewritten on every server start; don't edit it
- `~/Library/LaunchAgents/local.felix.plist`: the start-at-login entry (made by `./prs install`)
- `~/.warp/launch_configurations/openprs-*.yaml`: short-lived files that open Warp windows; they delete themselves
- `repo/<fm|bm>-wt-pr-<number>/` and local branch `openprs/pr-<number>`: worktrees made by **Fix with Claude**. **Discard** on the page removes both
- tmux sessions named `openprs-*`: the hidden Claude sessions (`tmux ls` lists them). Idle ones close by themselves: 30 minutes after you answer, or 24 hours if Claude is still waiting on you
- your browser: the last PR list and on-call data (so pages load instantly), your model choice and notification setting
- `repo/.claude/skills/review-pr`: a link to `skills/review-pr` in this project, made by the server on first start

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


## 10. Keys

Felix needs a few keys. They go into the Mac's Keychain, never into files or chat. Each command asks for the value twice, without showing it on screen. The Keychain names still start with `cmd-center-` from the old name; that's fine, nobody sees them.

**Datadog** (Incident Commander card) needs one token and no API key. Your Datadog role is Read Only, so you can't make API keys, and you don't need one:

1. In Datadog (us5), open **Organization Settings → Access Tokens → New Access Token**.
2. Name it `Felix` and pick the longest expiry offered (the default is 1 day).
3. Under scopes, tick only **on_call_read**, then save and copy the token. It is shown only once.
4. Save it:

```bash
security add-generic-password -s cmd-center-datadog-app -a datadog -w
```

The server sends it in the `DD-APPLICATION-KEY` header. Make a new one when it expires. The two schedules it reads:

- PURE Incident Commanders Schedule (Americas): `a39cd3b9-f39f-4c6c-8c2f-017fca628d36`
- Kastl Incident Commanders (Philippines): `1a2e4a4e-f27a-424c-999e-1cb8d6062c85`

**Jira:**

```bash
security add-generic-password -s cmd-center-jira -a <your Jira email> -w
```

Google Calendar (both your calendar and the Tech Team Vacation Tracker) needs no command. The page will have a one-time "Sign in with Google" button that saves its own token to the Keychain as `cmd-center-google-oauth`. On a new Mac, you sign in again once.

On a new Mac, add the keys again the same way. The plan doc's "What I need from you" section says where each key comes from. Later, a setup wizard in the page will walk you through these steps.


## 11. Remove it

```bash
./prs uninstall
```

This stops the server and removes the start-at-login entry. To clean up Claude sessions too:

```bash
tmux kill-server
```

Discard any fix worktrees from the page first, so their local branches are removed as well.
