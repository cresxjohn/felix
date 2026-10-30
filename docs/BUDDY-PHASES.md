# Felix buddy: phases for the /loop (source: docs/PLAN.md, "Buddy" through "More that makes Felix better")

Status key: todo / running / done / blocked

1. How Felix talks — done (verified 2026-10-30: 264/269 pass, the 5 failures are the shift agent's new settings in settings.test)
   Tone rules in Felix's prompt (answer first, contractions, no filler, spoken times and dates, short PR titles,
   vary wordings, reads the room, facts only). Settings: Felix's name (rename; default Felix) and activation phrase
   text (follows the name unless set), tone (casual / balanced / professional), chattiness, humor. Progress lines:
   spoken after ~1.5 s with no answer, naming the real step, updates every few seconds, never the same line twice in
   a row, interruptible; settings on/off, delay, interval, own phrases. "When unsure, it asks". Old data called out
   ("as of 10 minutes ago").
2. Wake phrase: "Hey Felix" or just "Felix" (the user asked for this next, with its settings) — done (verified 2026-10-30: 318/318 pass, 99.76%; real-mic check left to the user)
   Off by default; a Settings switch turns it on. While a Felix window is open and in view, the browser keeps the mic
   open and watches the level (the same quiet-floor logic as felix-voice.js); only when someone speaks is that short
   clip sent to the local whisper.cpp (POST /api/felix/hear), never anywhere else. If the words start with the phrase
   ("hey felix", "felix", allowing common mishearings, using the activation phrase setting from phase 1 and the name),
   Felix wakes: if more was said in the same breath ("Hey Felix, who's on call?") that rest is the question; if not,
   a soft chime and he listens for the command as the mic button does today. Text that doesn't start with the phrase
   is dropped at once, never stored or shown. It pauses while Felix is talking (so he doesn't wake himself), while
   the window is hidden, and while the mic button is in use. The top bar's "Say “Hey Felix”" pill becomes real: its
   dot shows listening for the name (on), off, or no mic permission, and a click turns it on or off. Settings: wake
   phrase on/off, the phrase (follows Felix's name unless set), "also wake on just the name", microphone choice, and
   sensitivity (how loud speech must be). Tests for the phrase matching (including mishearings and "Felix" mid-
   sentence not waking him) and the clip-dropping rule.
3. Felix as a strong agent (the user: "solidify felix as agent... powerful and capable, even making changes to its own
   app") — done (verified 2026-10-30: 448/448, 99.26%, Felix healthy; live rollback test broke the server ~75s — told never again)
   Audit the agent loop end to end on both Claude (agent mode behind the MCP gate) and Cursor (ACP agent mode): it
   reliably reads, edits, runs commands and tests in its workbench and finishes multi-step builds. Self-change flow:
   build in the workbench, Felix runs the tests there himself and reports pass/fail before offering Apply, picture of
   the changed page, Apply to Felix (tests first), restart, health check of the restarted Felix, automatic rollback
   to the saved state if it fails; "Undo the last apply" command. Long builds: no turn timeout killing real work
   (agent turns get a long budget), progress steps streamed, steering and Stop work throughout. Knows its own code:
   the system prompt carries a short map of the app's files and roles and its conventions (JSDoc, tests,
   no npm packages, settings in the schema), so changes match. Safety unchanged: nothing real changes without the
   user's Apply; anything outside the workbench still goes through the gate.
4. Memory — done (2026-10-30: memory files 100% covered; remaining suite failures belonged to the music/settings agents and one Jira test of mine, fixed)
   Learn after a conversation ends (one cheap AI step), small dated notes with the user's own words, updates keep
   history, recall only relevant notes plus a short "about you", idle tidy-up (merge duplicates, archive old),
   follow-ups from dated memories, honest about memory ("you told me on Oct 12" / "I don't remember"), secrets
   filtered, "off the record", "forget that", "what do you know about me", pause learning, Settings memory page
   (search, edit, delete, export). Builds on felix-memory.mjs.
5. Friend mode — done (2026-10-30: 517 tests, 99.26%; personal memories out of backups blocked until backups exist)
   Personal talk detected and kept apart from work data; warmer model for personal talk (setting); honest friend,
   not a yes-man; encourages reaching out to people; crisis help (NCMH 1553, Philippines); quiet hours; check-ins on
   the Personal home's Felix card from dated memories; personal memories out of backups unless chosen; settings
   (friend mode on/off, personality, what it may remember, personal-talk model, quiet hours).
6. Conversation and actions — done (2026-10-30: 581/581, 99.92%)
   Follows the conversation ("And tomorrow?", "the first one"); learned phrases (offer to remember an AI-mapped
   command, then run it locally; review in Settings); undo the last local action; watchers ("tell me when CI passes
   on my PR", "let me know when Brian approves") that speak and show, list and cancel; "that's wrong" / thumbs-down
   saves to the test set; usage budget shown and leaning local near the limit; "Brief me" and "Wrap up my day" from
   the connected sources (saying which aren't connected); web search only when asked, sources named; "Fix the
   failing checks on my PR" by voice.
7. Voice and presence — running
   Push-to-talk key; barge-in
   (stop/wait/its name/talking over it, ignoring its own voice); speaking up on its own (off by default: review
   ready, fix ready); stays quiet when the screen is locked or you're away; status icon (listening for name,
   listening, thinking, speaking) with mute and "pause 30 minutes"; voice selector (Kokoro voices, macOS voices,
   Piper if free and local); names-and-words dictionary from the app's people and terms, editable; opt-in care
   nudges after long stretches without a break.

Blocked (needs a connection Felix doesn't have yet): calendar questions and accept/decline/join (Google
Calendar: card + /api/calendar now built, needs the user's sign-in), Jira questions (Jira card + /api/jira built, needs the token), Slack drafts and opening channels (Slack app), Start my day / breaks / end
my day (Start my day isn't built), staying quiet in meetings from the calendar, "your voice only" speaker
recognition (no free local engine chosen yet; record as blocked unless one is found that's free and local).
