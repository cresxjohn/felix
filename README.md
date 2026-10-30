# Felix

Felix: my buddy. Formerly the PURE Tech Lead Command Center.


A small app on your Mac at `http://localhost:4777`. Its home page follows the mock-ups in [docs/PLAN.md](docs/PLAN.md): a top bar with a **Personal | Work** switch, a 12-column grid of cards across the whole window, and the Felix and music bar along the bottom. Every page shares that shell and the same rounded cards (the switch is on the home page only). On the Open PRs page the list and the details panel are two cards side by side, down to the bottom bar, each scrolling inside. Corner sizes live in `public/theme.css` (`--r-card`, `--r-box`, `--r-tag`, `--r-pill`), and pill switches share the `.segmented` style in `public/shell.css`.

**Work mode**
- **Incident Commander** (live): who is on now, who is next, and your next shift. From Datadog On-Call. A wide card also shows today's and tomorrow's people on both schedules.
- **Open PRs** (live): how many PRs are waiting on your review and how many are yours, the counts that need you (each opening the PR page already filtered), and each repo's release.
- **AI usage** (live): how much of your Claude and Cursor plan limits you've used, and when the most used one resets. A small card shows one tool at a time, picked with the Claude | Cursor switch at its top right (Claude first, and it remembers your pick), with just its bars. A card at least 560 px wide shows both tools with every note.
- **My Jira Board**, **Calendar**, **Team out of office**, **Slack** and **Tasks** are built too; a card that reads an account shows its setup step until that account is connected (Slack waits on its Slack app's approval). The progress table in [docs/PLAN.md](docs/PLAN.md) says how far each one is.

**Personal mode**: every card is live. **My day** shows the weather where you are (Open-Meteo, no sign-in; Settings → My day picks the city, Manila first), today's or the next Philippine holiday, and today's events once you connect your personal Google calendar (a read-only sign-in of its own, set up from the card). The weather tries three times, a few seconds each, and if the service still can't be reached the card shows the last reading it had. Holiday names come from Google's "Holidays in the Philippines" calendar, read through your calendar bridge (version 3 of its script, see [SETUP.md](SETUP.md)) or your personal Google sign-in; without either, the card uses the vacation tracker's PH holiday days, which have no names. On the iPad, Google's last sign-in page points at the Mac and won't load: copy its address, paste it into the box on My day and tap **Finish**. On the Mac it finishes on its own. **My time off** shows your own leave from the vacation tracker: the next break (a run of days off, weekends counted; a holiday on a weekend isn't a day off, and the card says so), what you've booked, and this year's days by kind. You pick yourself from your team list once on the card (kept in Settings as `timeoffMe`), so Felix never guesses who you are. **Felix** shows his check-ins: something you told him about whose day has passed ("How did the interview go?"), with **Tell Felix** and **Not now**. Tasks, **Lists**, **Habits**, **Journal** and **Important dates** are live too. Lists holds named lists (Groceries, Packing and Wishlist to start), picked in the card's header: type and press Enter to add, tick to strike an item through (it moves to the bottom), tap its words to change them, × to take it off, drag to reorder, and Clear ticked. Habits are small daily habits you choose (a name, an optional emoji, how many times a day): a row each with today's tick, the streak and a dot per day for the last 7 days or this week; tap a name to change it, fill in a missed day, or archive it. Journal is a few lines a day: a gentle prompt from a fixed list (no AI; Another gives a different one), a text box that saves a moment after you stop typing, an optional face for how the day felt, and ‹ › and Earlier entries to read and change past days. It is never cached in the browser, and Felix can add a line when you ask but never reads it. Important dates lists birthdays and anniversaries (every year, with the age or the anniversary's number when you know the year; February 29 falls on the 28th in other years) and one-off countdowns, soonest first with "in N days", today's tinted; add, change or delete one in its dialog, and countdowns that have passed leave the card but stay in All dates. All of these are saved on this Mac in `data/personal.db` (`personal.mjs`), and days follow this Mac's clock. **Wais** (it took the Bills & renewals card's spot) shows your money from Wais, read-only, through Wais's own MCP server on this Mac. A space picker sits in the header. Under it, Safe to spend reads as a sentence, "₱… over the next 5 years ⌄ in all accounts ⌄", where the period (until payday, or 30 days to 5 years) and the accounts are pickers, with a line when money runs short. Then the Outlook: a line of the balance ahead (recorded days solid, planned ones dashed, a dot at the low point); hover it, or slide a finger along it, for a day's balance. Its own period picker sits under the line, then Now, Lowest and End. There are no tabs: Wais's bills show in the Personal **Tasks** card under "From Wais" (the ones Wais's own Tasks card lists go in Today, with "+ N more in Wais" for the rest; late ones in Overdue; ones to review in Upcoming; none while a label or project filter is on), read-only, each opening in Wais. The space and each space's periods and accounts are kept in Settings (`waisChoices`), so the Mac and the iPad agree. Connect it from the card with an access token made in Wais (Settings → Security → Access tokens); Felix tries it with Wais first, then keeps it in the Keychain. Settings → Wais picks Dev or Prod (Dev until Wais is deployed) and the server's path. See [SETUP.md](SETUP.md).

In Personal mode the top bar says "Off work" instead of Start my day. The refresh button (and **R**) reloads every Personal card, and Auto refresh uses the same interval as in Work, but it reloads only the cards whose data comes from outside this Mac: My day, My time off and Wais. The others change only when you change them. "Hey Felix", Start my day and the mic button are placeholders in both modes.

**Loading.** Until a card's first data comes, it shows a grey skeleton in the shape of its content. When the real content arrives, its rows come in once from top to bottom (never on a refresh). Changes you make on a card (ticking, adding, reordering) show at once; if the server says no, the card goes back and a note says what failed (`public/card-load.mjs`).

**Felix** (the left side of the bottom bar, on every page): type a question or a command and press Enter. The answer shows in a panel above the bar, with chips naming each source and when it was read (for example "Datadog · 8:23 PM"), which link to it. Felix keeps the conversation as you move between pages, and Arrow up brings back earlier questions.
- **Local commands** are answered on this Mac with no AI, in about a second: who's on call, who's next, when your next shift is, what's waiting on your review, what's failing, how your PRs are doing, AI usage, what's playing, play, pause, next and previous, open a page ("show my PRs with conflicts", "open settings", "open fm#12247"), go anywhere in the app (below), turn auto refresh or fit to screen on or off, switch to work or personal ("work space" and "open the workspace" switch to Work too), "where did you get that?" and "help". Merge ("merge fm#123") and review ("review fm#123 with cursor") ask first, with **Merge** / **Start review** and **Cancel** buttons.
- **Getting around**, also local with no AI:
  - PR lists with filters, mixed as you like, on the tab that has them: failing, conflicts, ready to merge, in the merge queue, approved, changes requested, drafts, checks running, new commits and needs review. "Show PRs waiting on me with failing checks" opens `/prs/review?status=failing`.
  - A PR's tab: "open fm#12247's files", or its checks, commits, conversation or AI review (`?pr=…&panel=…`).
  - A card on Home by name: "go to Tasks", my habits, lists, journal, My day, dates, time off, Wais, check-ins, on-call, Jira, calendar, who's out, Slack or AI usage. Home opens with `?card=<id>`, switches mode if the card is on the other side, scrolls to it and gives it a soft ring. "Show my meetings" is still a question Felix answers; "open my calendar" goes to the card.
  - Places outside Felix: "open #incident-response" or "the incident response channel" opens the channel in Slack by its name (`slack.com/app_redirect`); "open the Datadog schedule" opens the Philippines Incident Commander schedule, "the Americas schedule" the other one, and "open datadog" On-Call. The reply also has a chip to tap, since a spoken command on the iPad may not be allowed to open a window.
  - "Edit the layout" says plainly that moving cards isn't built yet and opens Settings' Home section (full width and Fit to screen).
- **Your Personal cards by voice and chat**, also local with no AI: "add eggs and milk to groceries", "got the eggs", "remove milk from groceries", "what's on my packing list"; "I drank water", "done with reading today", "how are my habits", "what's my reading streak"; "note in my journal: …" (added after what's there, never said back or logged); "what's coming up", "when is Mama's birthday", "remind me Lola's birthday is November 3"; "when's my next break", "how many leave days have I used"; "what's the weather", "will it rain tomorrow", "is tomorrow a holiday"; and from Wais, read-only, "how much can I spend" and "what bills are due". They fire only on a list, item, habit or date you have, so "groceries were expensive" or "I drank coffee" stay talk, and a habit is never ticked on "I didn't…". They answer whenever you ask, in either mode, because you asked; nothing personal is read into work answers, wrap-ups or briefings, and personal commands aren't passed to Felix's learning. For anything they can't parse, Felix's AI has `personal_*` tools (lists, adding to a list, habits, ticking one, adding a journal line, important dates, time off) that act at once like the task tools, and `wais_*` tools (spaces, safe to spend, bills, outlook) that only read; no tool reads the journal, and a journal line never goes into Felix's log. After a change, the open cards load again (`felix-personal` BroadcastChannel).
- **Anything else goes to the AI.** Settings → Felix picks the **AI** (Auto, Claude or Cursor) and then the **Model**, from the same lists as Open PRs. On **Auto**, Felix uses Claude Code while your Claude plan has room and Cursor once a Claude limit is used up (from Claude's own limit report, or the AI usage card at 100%), so it never runs into Claude's paid extra usage. With the model on Auto, Felix picks one for each question: quick ones (who, when, status) get Sonnet, and ones that need thought (summaries, explanations, "why", advice, comparisons, what a PR changes) get Opus. On Cursor that's Composer 2.5 Fast, which has its own usage pool, and Cursor's Opus. The reply streams into the chat as it's written, one checked sentence at a time, with a typing effect, and each answer is labeled with the model that wrote it (for example "Composer 2.5 Fast (Cursor)"). Felix is told to talk like a friendly teammate, with example replies for the tone.
- **Felix is an agent, always.** Like a coding assistant in your editor, his AI can read anything (files on this Mac, the web, GitHub through `gh`) and run commands, and it works in **its workbench**: Felix's own copy of the Felix app (`data/felix/workbench`, a git repo of its own). Ask him to build or change anything in Felix ("add a weather widget", "make the music bar smaller") and he does it in the workbench, where edits are free since nothing real changes. The answer then shows a picture of the changed page, with **Apply to Felix** (runs the tests in the workbench first, copies the changes into your Felix without committing them, then restarts Felix), **See the code** and **Discard**. See the code opens a sheet inside Felix, never a new tab (the iPad app has no way back from one): each file with what happened to it and its + and − counts, then its numbered lines, with Apply and Discard at the top and Close (or Esc, or a tap outside). Tapping the picture opens it bigger in the same sheet (`public/felix-diff.mjs` reads the change). The workbench catches up with your Felix before each question whenever it has no changes of its own.
- **Every change asks you first, every time.** Every tool the AI asks to use passes through Felix's gate (`felix-gate.mjs`), in code, so no prompt can talk it out of it. Reads go straight through: files, searches, `git log`, `gh pr view`, `gh api` GETs. Anything that changes something outside the workbench (posting, commenting, approving, merging or editing on GitHub, writing files elsewhere, installing, anything Felix doesn't recognize as a read) shows up in the chat as a card with exactly what will run, and waits for you to click **Allow** or type yes. A spoken yes doesn't count for a change. A card nobody answers is turned down after 10 minutes, and so is everything still waiting when the answer ends. Some things are never run, even if you ask: your logins (`gh auth`), secrets, the Keychain (`security`), `sudo`, `launchctl` and Tailscale.
- **Memory.** Felix keeps short note cards in `memory/` in his workbench, one per thing worth keeping (a person, a repo, a decision, a preference), linked with `[[name]]`. Felix's code builds the graph from those links, with no extra AI call: a question that names a card carries that card and a line about each card linked to it. The index (`memory/README.md`, at most 2,000 characters) goes to the AI once, when a session starts; every other card is read only when a question needs it. The AI saves and updates cards itself, and the answer shows a **Memory updated** chip; "forget …" takes something out. Memory never holds secrets or live work data, and it's never part of Apply.
- **Always-open sessions.** Claude runs one warm session per model, and Cursor runs one session that switches models between questions (Cursor's CLI as an ACP server, `cursor-agent acp`). Measured Oct 29, a fresh Cursor run took 8 to 19 seconds for a one-word reply; the open session takes 2 to 4. While the app is open and in view it keeps them warm, and a session that's had 20 questions is replaced in the background, so a question never waits for one to start. Closed, they shut down after 30 idle minutes. If Cursor's session can't start or doesn't list the model, a one-off run answers instead.
- **It remembers the conversation.** Felix keeps the last 4 exchanges from the past 30 minutes and sends them with each question, so whichever model or AI answers can follow along, even after a session restarts or Auto switches to Cursor. A follow-up that points back, like "and who approved it?" or "is it out yet?", also reads the sources and PRs of the answer before. Felix first reads the sources the question needs (Datadog, GitHub, releases, AI usage or Spotify) and sends the AI that data, as compact records with times already written out ("today at 10 PM", "in 4 days"), so most questions need no tools at all. A request to build, change, remember or forget something reads no sources first. Claude's session loads none of your Claude settings or MCP servers; it gets Felix's own MCP server, whose one tool is the gate.
- **Every fact is checked in code** before you see it: each name, number, time, PR number and ticket key in the reply must appear in the data just read, in what the AI's tools read while answering, in its memory, or in your question. If one doesn't, Claude gets one more try, told which words didn't match; if that fails too, Felix keeps the sentences it already checked and showed, or says it can't confirm it when there are none. Numbers may be rounded the way people say them (69.485% as "69%"). Word forms count as everyday words ("checks", "approved", "waiting"), since the Mac's word list only has the base words. For questions about Slack (not connected until the Slack app is approved) or your journal (kept private from the AI), the AI is told it can't see them.
- **Sentences show only once checked.** Each streamed sentence is fact-checked before it appears, and after one fails nothing more is shown; if a second try is needed, the shown sentences stay and the second try carries on after them.
- **Quick to read its sources.** The PR list (about 2.5 seconds from GitHub) and each PR's details are cached: under a minute old they're used as they are, and up to 5 minutes old they're used at once while a fresh copy loads in the background. The Open PRs card's own reloads keep the cache fresh, a merge reloads it, and opening Felix's chat loads it ahead of your question. The other sources already answer in well under a second.
- If Claude fails on its usage limit, the same Claude model answers instead through Cursor's session: always on Auto, and with Claude picked, unless **Use Cursor when Claude runs out** is off. Settings → Felix turns Felix off, picks the AI and model and turns the Cursor backup off. Every question and answer, with the data it used and what the check found, is logged in `data/felix/log.jsonl`.
- **Talking** (being built): click the mic in the chat box and just talk; Felix stops listening when you stop, and reads the reply aloud (Settings → Felix: when I talk, always or never; the voice; the speed, each with **Play sample**, which reads a random line). Speech starts about half a second after the text shows: the reply is read a phrase at a time as it streams, with the next phrases made while one plays. whisper.cpp hears and Kokoro speaks, both on this Mac, so no audio leaves it; the Mac's own voice stands in until Kokoro is set up. Say "yes" or "no" when Felix asks before a merge or review. When a spoken reply takes a moment, Felix says what he's doing ("Hold on, checking GitHub"), but only once he's on a real step: while he's just thinking ("Looking into it" and the like) he stays quiet, and says nothing at all if the answer comes first (`public/felix-progress.mjs`). Set up once with `./prs voice`.

The switch changes the cards at once and is remembered. The live cards reload every minute (Settings → Auto refresh) while the window is in view (the ring around the refresh button counts down); in Personal mode that's My day, My time off and Wais. A hidden window skips the reload and catches up when you come back.

**Settings** (`/settings`, the gear in the top bar): the mode, **Fit to screen**, auto refresh on or off, and how often (1 to 15 minutes), plus Felix (on or off, the AI and its model, the Cursor backup, and talking: when, the voice and the speed, with Play sample), and a section for each Personal card (Lists, Habits, My day, My time off, Journal, Important dates and Wais, where you pick Dev or Prod and the server's path). Every change saves at once and reaches open home pages without a reload. Each group has a Reset, and there is a Reset all; both ask for a second click. A search box filters the list. Settings live in `data/settings.json`. The **App** group shows whether Felix is installed (with Install when Chrome offers it), the steps to uninstall and reinstall it (Chrome doesn't let a page remove its own app, and a managed Chrome blocks `chrome://app-settings`), and whether Chrome can save its launcher.

**Music player** (the right side of the bottom bar, on every page and in both modes): until you sign in it says "Not signed in to Spotify" with a **Sign in** button. That button, and **Sign in with Spotify** in Settings → Music, open Spotify's own login in a small window, which closes itself when you're done; Settings then says who's signed in, with **Sign out**. Felix signs in through its own Spotify developer app, whose Client ID is built into `music.mjs` (a Client ID isn't secret, and PKCE needs no client secret). That app is in Spotify's development mode, so only its owner and up to 5 Spotify accounts added under **User Management** in the Spotify dashboard can sign in, and they need Premium. Music plays right in Felix through Spotify's Web Playback SDK, which shows up in Spotify as a device called "Felix", so the Spotify app isn't needed; the server hands the page a short-lived token for it (`POST /api/music/spotify/token`). Play, pause, next, previous and your playlists, with the song, artist, artwork and progress in the bar. Moving to another Felix page doesn't stop the music: a window's first page load gets Felix's lasting outer page (`public/host.html`, which holds the bottom bar and the player), and every page then loads in a frame there, while the address bar, the title and Back follow along. The next page loads in a second frame under the current one, which stays until the new page has drawn, so switching pages doesn't flash; the outer page keeps the history, so Back and Forward work across pages and within one (the /prs tabs). If Spotify is already playing on your phone, the bar controls that instead. A sign-in from before Felix could play music itself shows **Sign in again** in Settings. The sign-in lives in the Keychain (`cmd-center-spotify`), saved through `security -i` so it never shows in the process list. Sign in from this Mac: Spotify sends you back to `http://127.0.0.1:4777`.

**Fit to screen**: on a wide window (1200 px or more) the home page fills the window exactly with no page scrolling; the rows share the height, and a card whose content is longer scrolls inside.

The **Open PRs** page (`/prs`) lists your PRs and the PRs waiting on your review in fm (`purepm/frontend-monorepo`) and bm (`purepm/backend-monorepo`). Claude Code can review or fix them for you in the background.

The plan for the rest is here: https://claude.ai/artifact/AKv4sNUDchA8npNnx8cjTB (a copy with the mock-ups lives in [docs/PLAN.md](docs/PLAN.md), for reading in an editor)

New Mac or reinstall? Follow [SETUP.md](SETUP.md).


## What it does

**Home** (`/`)
- **Incident Commander:** who is on now and until when, then a Next line (hover for the schedule and how long until) and a Your shift line with how many days to go. A card at least 560 px wide adds the two teams' people for today and tomorrow. It reads Datadog every hour, and right after midnight. **R** or the refresh button asks Datadog again at once.
- **Open PRs:** two big numbers, PRs to review and yours, each opening its tab. Under them the key counts always show (need your review, AI review waiting, ready to merge, checks failing), muted at 0; new commits, conflicts, merge queue, changes requested and AI fix waiting show only when something is there. Each line opens the PR page with that filter on. Then one line per repo for its release: the open release PR with its status and Approve or Merge, or when the last one merged.
- **AI usage:** one section per AI tool, each with its plan and a bar per limit, colored orange from 80% and red at 100%. Hover a bar for when it resets; the foot says when the most used limit resets.
  - **Claude:** the 5-hour session limit, the weekly limit and any per-model weekly limit, plus extra usage credits used this month (hover for when that count resets; Claude doesn't send it, so it's the 1st of next month). When a limit is used up, the card says until when and points to Cursor.
  - **Cursor:** the share of included usage used (overall, Auto and Composer, and named models), and your on-demand spend against your own limit and the team pool.
  - It reads each tool's own sign-in from the Keychain (`Claude Code-credentials` and `cursor-access-token`), so there is nothing to set up. A tool that isn't signed in shows the command to sign in. Checks are cached for 2 minutes, and the page asks on every reload.

**Two lists**
- **My PRs** (`/prs/mine`) and **Needs my review** (`/prs/review`), straight from GitHub. The old `/mine` and `/review` links still work. Release PRs stay out of Needs my review; they live in the Releases tab.
- Each PR shows its Jira ticket, review state, checks, merge conflicts and size (XS to XL).
- Search, status filters, repo filter, sorting and grouping. Every view has its own link, for example `/review?status=failing&pr=fm-12247`.
- **Copy link** on every PR, and **Remove me** to drop yourself from a PR's reviewers on GitHub. Remove me asks for a second click first.
- **Merge** on your PRs that GitHub says are ready (approved, checks pass, no conflicts). It adds the PR to the merge queue, which squashes it into main, and asks for a second click first. A PR in the queue shows its place.
- **Releases** tab (`/prs/releases`) next to My PRs and Needs my review; its count is how many open release PRs there are (one per repo at most): for fm and bm, the open "chore: release main (changeset)" PR with its checks and whether it can merge, which of your merged PRs it ships (and in which packages), every change it includes, and where the last release got to: its dev deploy ("1 - Merges to main") and whether it reached prod. A release counts as in prod once a successful prod promotion's `promotion-manifest.yml` lists all its deployable packages at that version or newer; libraries are skipped. Each repo has an Open release card (with "You approved" as a badge once you have) and a Last release card. Each card shows the release's status (ready to merge, awaiting reviewers, changes requested, or in the merge queue) with **Approve** and **Merge** buttons, both asking for a second click. Cards start folded; open the ones you want.
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

**As an app**
- Felix installs as an app with its own window and Dock icon. In Chrome, open `http://localhost:4777` and click **Install app** in the header, or the install icon in the address bar. In Safari, use File → Add to Dock. If opening the app brings another app (like Slack) forward instead, Chrome couldn't save Felix's launcher: Settings → App → App launcher shows the Terminal fix, then uninstall and reinstall.
- The installed app can hide Chrome's title bar (Window Controls Overlay): click the **^** button at the top right of the app window to hide it, and the same place shows it again. Felix's top bar then moves up between the window buttons and Chrome's own icons, and its empty middle drags the window. Chrome only lets the outer page (`public/host.html`) drag the window, so `shell.js` lays invisible drag areas over the page's top bar there.
- Right-click the Dock icon for shortcuts to Open PRs, Needs my review, My PRs and Releases.
- If the server is down, the window still opens with the last data and says how to start it. Pages always come from the server first, so a new release shows on the next reload.

**On the iPad**
- Tailscale publishes Felix to your own devices only: `tailscale serve --bg 4777` gives `https://<mac>.<tailnet>.ts.net` (see `tailscale serve status`). Never use Funnel, which makes it public.
- With Tailscale connected on the iPad, open that address in Safari, then Share → Add to Home Screen.
- Every action works there too. The server accepts change requests from localhost and from this Mac's tailnet address, which it reads from `tailscale status --json`.
- To reorder tasks, list items and habits by touch, press and hold a row, then slide it (a mouse still drags). iPad Safari can't start the browser's own drag from a finger, so `public/reorder.js` does it.
- Connecting your personal Google calendar from the iPad needs one paste: see My day above.
- The setting survives restarts, but the Mac must be awake with Tailscale running. Turn on Tailscale's "Launch at login" so it comes back after you log in.

**Around it**
- An AI picker (Claude or Cursor) and a model picker: a global default at the top, and a per-PR override in the panel. Cursor's models come from `cursor-agent models`.
- Mac notifications when a review or fix needs you, or a new review request arrives.
- Starts at login. Idle Claude sessions close on their own.


## How it works

```
Browser ─► server.mjs (127.0.0.1:4777) ─► GitHub API (token from `gh auth token`)
                ├─► datadog.mjs ─► Datadog On-Call API (token from the Keychain)
                ├─► ai-usage.mjs ─► Claude and Cursor usage APIs (each tool's own sign-in from the Keychain)
                ├─► personal.mjs ─► data/personal.db (lists, habits, journal, important dates)
                ├─► myday.mjs ─► Open-Meteo, Google Calendar (holidays, your personal calendar)
                ├─► wais.mjs ─► felix-mcp-client.mjs ─► node wais-mcp.mjs (Wais's own MCP server, read-only)
                │
                ├─► tmux ─► claude --remote-control … "/review-pr <url>"   (review)
                │      └─► claude … in <repo>-wt-pr-<n>                    (fix)
                │
                ├─► tmux ─► cursor-runner.mjs ─► cursor-agent -p --resume <chat>  (review or fix on Cursor)
                │
                └─◄ hooks/report.sh ◄─ Claude Code hooks (progress, done, waiting)
                 ◄─ cursor-runner.mjs (the same events, read from Cursor's stream-json)
```

- `server.mjs`: the whole server. Plain Node 22.5+, no npm packages. It serves the page, talks to GitHub, and starts and tracks Claude sessions.
- `datadog.mjs`: the Incident Commander data. It reads the token from the Keychain, steps through the shifts, and caches them for an hour.
- `ai-usage.mjs`: the AI usage data, from Claude's and Cursor's usage APIs.
- `keychain.mjs`: reads secrets from the Keychain, for both modules above.
- `tailnet.mjs`: decides which pages may send change requests (localhost and this Mac's tailnet address).
- `personal.mjs`: the Personal mode's own store (`data/personal.db`, Node's built-in SQLite): lists and their items, habits and their daily check-ins and streaks, the journal, important dates, and the `/api/personal/…` routes. Its tables are made by the numbered steps in `MIGRATIONS`, each run once; a later card adds its tables as a new step at the end, and a step that has shipped never changes. Important dates from other sources (a calendar, Felix's memory) can join through `datesView`'s `more`; nothing is wired yet. Felix reaches it only through `felix-personal.mjs`, when you ask; his work answers, briefings and the tools he builds never read it.
- `settings.mjs`: keeps the settings in `data/settings.json`, checking every change against `public/settings-schema.mjs`.
- `public/settings-schema.mjs`: every setting with its group, default and allowed values. The server and the Settings page both use it, so a new setting needs one entry there.
- `public/settings.html`: the Settings page.
- `music.mjs`: Spotify sign-in (OAuth with PKCE), playback control, the Web Playback SDK token and your playlists (`/api/music/…`).
- `public/music.js`: the music player in the bottom bar, its playlist menu and the in-page Spotify player.
- `felix.mjs`: Felix itself: local command or AI, which sources a question needs, the rules Claude answers by, the fact check, the source chips and the merges and reviews waiting for your yes.
- `felix-commands.mjs`: matches what you typed to a local command, including where to go (pages, PR filters and tabs, Home cards, outside links). `felix-answers.mjs`: the local commands' answers, a few wordings each.
- `felix-facts.mjs`: reads the cards' data fresh and turns each source into a compact record. `felix-verify.mjs`: the fact check, and the sentence gate that lets only checked sentences stream out. `felix-cache.mjs`: the stale-while-revalidate cache for slow sources.
- `felix-brain.mjs`: the warm Claude session (`claude -p` with stream-json in and out, one per model, streaming text as it's written), and Cursor: its open session, or a one-off `cursor-agent -p` run when that can't answer. `felix-cursor.mjs`: Cursor's open session (`cursor-agent acp`, JSON-RPC over stdin and stdout), and the translation from `cursor-agent models` names to the session's ("composer-2.5-fast" is "composer-2.5[fast=true]"). `felix-lines.mjs`: reads their output a line at a time.
- `felix-conversation.mjs`: the recap of the last few exchanges, and which sources a follow-up reads.
- `felix-agent.mjs`: puts the agent together (workbench, memory, gate, Claude's MCP config and sandbox settings) and applies or discards the workbench's changes. `felix-workbench.mjs`: Felix's own copy of the app. `felix-gate.mjs`: decides each tool use, and the cards for changes. `felix-readonly.mjs`: whether a shell, git or gh command only reads. `felix-memory.mjs`: the note cards, their link graph and the memory rules. `felix-mcp.mjs`: the MCP server Claude Code asks the gate through (`POST /mcp`).
- `public/ai-models.js`: the Claude model list that Open PRs, Settings and the server share.
- `public/felix.js`: the chat box in the bottom bar and the conversation panel.
- `public/host.html`: the lasting outer page a window opens on; each page loads in its frame so the bottom bar and music carry on between pages. The server picks it from `Sec-Fetch-Dest: document` (or `X-Felix-Dest`, which the service worker sends because the browser drops the real one there).
- `public/music-signed-in.html`: where a music sign-in window ends; it says how it went and closes itself.
- `public/dropdown.js`: the dropdown menus every page shares, drawn over a hidden native select.
- `myday.mjs`: My day's weather (Open-Meteo, three short tries, then the last reading), Philippine holidays (Google's public holiday calendar through the bridge or your work Google app, then your personal sign-in, else the tracker's PH holiday days without names) and today on your personal Google calendar (read-only). `public/places.mjs`: the cities its weather can be for.
- `wais.mjs`: the Wais card and Felix's Wais tools: starts Wais's MCP server with Node, the environment from Settings and the token from the Keychain, tries a new token, and puts the card's five answers together (spaces, accounts, safe to spend, tasks, outlook), kept 2 minutes. `public/wais-choices.mjs`: the card's choices per space, kept in one Settings value.
- `felix-mcp-client.mjs`: Felix as an MCP client: starts another app's MCP server on this Mac (Wais's, so far) over stdin and stdout, shares it between calls, stops it after 10 idle minutes and starts it again when needed. The token goes in the server's environment, never in a file or a log.
- `felix-personal.mjs`: Felix's way into the Personal cards for his commands and tools: careful matching of your lists, items, habits and dates, spoken dates ("November 3"), and a facade over the stores that counts its changes so the open cards load again.
- `felix-tools.mjs`: Felix's built-in AI tools, including `personal_*` and the read-only `wais_*`. `felix-steps.mjs`: the plain words for each step he's on ("Checking your lists"). `felix-tone.mjs`: the "Style for this reply" line sent with each question, and the filter that cuts it out of a reply when a model reads it back, wherever it shows.
- `felix-toolbox.mjs`, `felix-tool-worker.mjs`, `felix-ctx.mjs`, `felix-builder.mjs` and `felix-jobs.mjs`: the tools Felix builds himself and his background helpers. See "Felix's own tools" below.
- `timeoff.mjs`: My time off: your leave from the tracker for the person picked as you, the breaks it makes with holidays and weekends, and this year's days by kind.
- `public/reorder.js`: press, hold and slide to reorder rows by touch, for iPad Safari, which can't start the browser's own drag from a finger.
- `public/card-load.mjs`: how the home cards load and change: a skeleton shaped like each card's content until its first data comes, the top-to-bottom fade-in when the real content takes its place (once, never on a refresh), and optimistic changes that show at once and are put back, with a note, if the server says no.
- `public/journal-prompts.mjs`: the Journal card's gentle prompts, one a day.
- `public/felix-diff.mjs`: reads a change as git writes it into files, + and − counts and numbered lines, for the See the code sheet (`public/felix.js` draws the sheet). `public/felix-progress.mjs`: the spoken progress lines.
- `launcher.mjs`: checks that Chrome can write the installed app's launcher in `~/Applications` (`GET /api/app/launcher`).
- `public/shell.js` and `public/shell.css`: the shell every page shares (top bar, mode switch, settings gear, refresh ring, Felix and music bar), plus reading and saving settings.
- `public/cards.js`: every home card's title, icon and link, and for cards still to come, what they need and their example (made-up data only).
- `test/`: tests, run with `./prs test`.
- `public/manifest.webmanifest`, `public/sw.js` and `public/app.js`: make Felix an installable app (the service worker keeps a copy of the pages, never the API). `public/offline.html` shows when no copy is saved yet.
- `public/icons/`: the app icons. Edit the SVGs, then run `./prs icons` to render the PNGs.
- `public/screenshots/`: the picture Chrome's install dialog shows, at 1280×800. It uses made-up on-call names; keep real work data out of it.
- `public/home.html`: the home page with its cards.
- `public/layout.js`: where each card sits on the home page's 12-column grid in each mode (column, row, width and height), checked by `test/layout.test.mjs`.
- `public/index.html`: the Open PRs page (HTML, CSS and JS in one file).
- `public/theme.css` (colors and fonts) and `public/pr-status.js` (what state a PR is in) are shared by both pages. Page edits, like any other edit, reach Felix with `./prs restart` (see Commands).
- `skills/review-pr/`: the `/review-pr` skill that reviews use. On start, the server links it into the workspace's `.claude/skills/` if it isn't there yet.
- `cursor-runner.mjs`: runs a Cursor session. Cursor has no hooks, so it reads `cursor-agent`'s stream-json output and sends the server the same events the Claude hook does. A reply typed into its window (the A–D buttons do that) starts the next turn in the same chat.
- `hooks/report.sh`: a Claude Code hook that forwards session events to the server. It only runs in sessions this server starts.
- `prs`: start, stop, install at login (macOS LaunchAgent), releases, status and logs.
- `tools/`: the tools Felix built himself, each with its test.
- `data/`: local state (sessions, logs, `personal.db`, `tasks.db`) and the releases Felix serves. It is not in git.

**Safety**
- The server only listens on `127.0.0.1`.
- Write requests must be JSON from the page itself, so other websites can't trigger them.
- Fix sessions can't run `git push` or post on PRs. On Cursor this is a deny list in the worktree's `.cursor/cli.json`, kept out of git through `info/exclude`.
- No secrets are stored in this folder. The Datadog, Jira, Wais and Google tokens live in the macOS Keychain.
- Felix's AI works in its workbench. Claude runs with `--permission-mode acceptEdits` (free edits only inside the workbench), Claude Code's sandbox (commands run on their own only when they stay in the workbench with no network; `gh` runs outside it so the gate decides), secret files denied (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh`, the Keychains folder, `.env`, keys), and every other permission sent to the gate through `--permission-prompt-tool`. Cursor runs in agent mode inside its sandbox, and each permission it asks for gets the gate's answer, as "allow once" or "reject once", never "always". Cursor's sandbox doesn't keep reads from its tools out of other folders.
- Changes outside the workbench need your click or typed yes on a card, every time; your Felix only changes through Apply, which you click. The gate and the Apply route are code, not instructions to the AI.
- `POST /mcp` only answers Claude: it needs the random token in `data/felix/mcp.json` (made on each start, readable only by you), and turns away anything forwarded through the tailnet.


## Commands

```bash
./prs install     # start now and at every login (makes the first release if there's none)
./prs start       # start it, if you stopped it
./prs status
./prs restart     # make a fresh release of this folder and serve it
./prs release     # make a release without restarting
./prs logs
./prs stop
./prs uninstall   # stop starting at login
./prs test        # run the tests, with coverage
./prs icons       # render the app icons from their SVGs
./prs voice       # set up talking to Felix (whisper.cpp, ffmpeg and Kokoro)
```

Felix serves a release: a frozen copy of this folder in `data/releases/`, with `data/live` pointing at the one in use.
Editing here, server or pages, never reaches Felix, or the app on your iPad, until `./prs restart` makes a new
release. His data, the tools he builds (`tools/`) and the tests stay in this folder and aren't copied; the last five
releases are kept. Apply to Felix restarts him the same way, so his own changes get a release too.

## Felix's own tools

When none of Felix's tools can get what you asked, he says he'll look into it and builds one in the background
(`felix-builder.mjs`): Claude Opus 5.5 High writes it while your Claude limit has room, and Cursor's
`claude-opus-5-5-high` once it's used up. The builder goes by your Claude limit only, not by the AI picked for the
chat. It writes the tool and its test in `data/felix/jobs/<job>/`; Felix checks it, runs its test, saves it as
`tools/<name>.mjs` and answers you with it. A tool runs in a worker thread of its own (`felix-tool-worker.mjs`) and
reaches your services only through `ctx` (`felix-ctx.mjs`), which never hands it a token: reads (calendar, the vacation
tracker, on-call, Jira search and `jira.get` for any Jira REST read, Slack search and `slack.read` for Slack's
read-only methods, Google Calendar, PRs, AI usage, public web pages), plus your tasks. Your Personal cards and Wais
aren't in `ctx`. Tools are picked up without a restart (`felix-toolbox.mjs`), and only ever added or extended: every
version is kept in `data/felix/tools/`, a deleted tool comes back, a broken one falls back to its last good version.
His helpers (`felix-jobs.mjs`) run up to three background jobs at once, and each answer reaches the chat on its own.
A helper writes "ANSWER:" before its answer, so its working notes never reach you. On Cursor, Felix first approves his
own tool server in the job's folder (`cursor-agent mcp enable felix`), since Cursor won't load a folder's tool server
it hasn't approved.


## API

All routes are local only.

| Route | What it does |
| --- | --- |
| `GET /api/incident-commander` | On-call shifts for today, tomorrow and my next shift (`?fresh=1` skips the hour cache) |
| `GET /api/ai-usage` | Claude and Cursor plan limits used, each with its own error if it can't be read (`?fresh=1` skips the 2-minute cache, at most once every 15 seconds) |
| `GET /api/prs` | Both PR lists from GitHub, plus Claude sessions |
| `GET /api/releases` | Each repo's open release PR, my PRs in it, and the last release's dev and prod status (`?fresh=1` skips the 1-minute cache) |
| `GET /api/reviews` | Claude and Cursor sessions only (the page polls this) |
| `GET /api/models` | Cursor's model list (empty, with a reason, when Cursor isn't signed in) |
| `GET /api/pr?repo=fm&number=1` | One PR's details for the panel |
| `GET /api/review/screen?key=` | A session's terminal screen |
| `POST /api/review` | Start or queue a review `{ url, tool?, model? }` (`tool` is `claude`, the default, or `cursor`) |
| `POST /api/review/batch` | Review several PRs `{ urls, tool?, model? }` |
| `POST /api/review/answer` | Answer A–D `{ url, answer }` |
| `POST /api/review/stop` | Interrupt a session, or take a review out of the queue `{ key }` |
| `POST /api/review/end` | Close a session `{ key }` |
| `POST /api/review/open` | Open a session in Warp or the Claude app `{ key, where }` |
| `POST /api/fix` | Start a fix on my PR `{ url, kind, request?, tool?, model? }` |
| `GET /api/fix/changes?url=` | The fix's commits and diff |
| `POST /api/fix/push` | Push the fix to the PR branch `{ url }` |
| `POST /api/fix/discard` | Close the fix and remove its worktree `{ url }` |
| `POST /api/remove-me` | Remove me from a PR's reviewers `{ url }` |
| `POST /api/merge` | Add my ready PR, or a ready release PR, to the merge queue `{ url }` |
| `POST /api/release/approve` | Approve a release PR (only `changeset-release/main`) `{ url }` |
| `POST /api/merge/batch` | The same for several PRs, one at a time `{ urls }` |
| `POST /api/review-event` | Hook events from Claude sessions |
| `POST /api/felix/ask` | Ask Felix `{ text }`. Answers in lines of JSON: `{ step }` while it checks its sources, `{ text }` for each checked sentence as it's written, `{ reset: true }` when a second try replaces what was shown, then `{ answer }` (with `by`, the model's name) with `text`, `chips`, and `navigate`, `settings`, `music` or `confirm` when the page has something to do |
| `POST /api/felix/confirm` | Say yes or no to a merge or review Felix asked about `{ id, yes }` (each lasts 2 minutes and works once) |
| `POST /api/felix/warm` | Start Felix's Claude session and load the PR list ahead of a question (the chat box does this when it opens and on focus) |
| `GET /api/felix/diff` | The workbench's changes as a patch, for the See the code sheet |
| `GET /api/felix/jobs` | Felix's background jobs, the tools he built, and any that wouldn't load |
| `GET`, `POST /api/personal/…` | The Personal cards' lists, items, habits, journal and important dates, from `data/personal.db` (the full list is at the top of `server.mjs`) |
| `GET /api/personal/myday` | My day: the weather, Philippine holidays and today on your personal calendar (`?fresh=1` skips the caches) |
| `GET /api/personal/timeoff` | My time off for the person picked as you, or the team list to pick from (`?pick=1` picks again) |
| `GET /api/wais` | The Wais card, from Wais's MCP server, kept 2 minutes (`?space=&period=&accounts=&outlook=&fresh=1`) |
| `POST /api/connect/wais` | Try a Wais access token, then save it to the Keychain `{ fields: { token } }`; `/api/disconnect/wais` removes it |
| `POST /api/google/finish/<work\|personal>` | Finish a Google sign-in begun on the iPad, from the address Google sent you back to `{ address }` |

A session `key` is the PR link for a review, or `fix:<PR link>` for a fix.


## Roadmap

From the plan:

1. Home page with cards; the PR page moves to `/prs`. **Done.**
2. Incident Commander (Datadog on-call). **Done.**
3. Calendar and Team out of office (Google Calendar).
4. Tasks.
5. Jira board card, a Jira tab in the panel, and a Team view of everyone's open PRs.
6. A setup wizard with this guide built in, so a new Mac sets itself up from the page.
7. Felix, typing: local commands, Claude answers from fresh data, the fact check and source chips, streamed replies, the Auto model and the PR cache. **Done.** Talking to Felix (whisper.cpp to hear, Kokoro to speak) is next.
8. Personal mode: every card live, by voice and chat too, with Wais read-only. **Mostly done.** Wais Prod waits on Wais's own deploy, and the Felix card's talk box and "how your week has felt" aren't built.
