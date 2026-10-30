// Every home card: its title, icon and header link. A card still to come also says what it will show and what it
// needs, and carries an example of how it will look. The examples use made-up names and numbers, never real data.
window.FelixCards = (() => {
  /**
   * A line icon in the cards' style.
   * @param {string} paths The SVG shapes inside a 24 × 24 box.
   * @returns {string}
   */
  const strokeIcon = (paths) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

  /**
   * A label and its value on one line, the value on the right.
   * @param {string} left
   * @param {string} right
   * @param {string} [cls] Extra classes, such as "warn" or "bad" for the value's color.
   * @returns {string}
   */
  const kv = (left, right, cls = "") => `<div class="kv ${cls}"><span>${left}</span><b>${right}</b></div>`;

  /**
   * A colored dot, a label and a number on the right; muted when the number is 0.
   * @param {string} color A CSS color.
   * @param {string} label
   * @param {number} n
   * @returns {string}
   */
  const count = (color, label, n) => `<div class="count${n ? "" : " zero"}"><span class="dot" style="background:${color}"></span>${label}<span class="n">${n}</span></div>`;

  /**
   * A row of filter chips with the first one picked.
   * @param {string[]} labels
   * @returns {string}
   */
  const chips = (labels) => `<div class="chips">${labels.map((l, i) => `<span class="chip${i ? "" : " on"}">${l}</span>`).join("")}</div>`;

  /**
   * One task: a checkbox, its title, a label and when it is due.
   * @param {string} title
   * @param {string} tag
   * @param {string} due
   * @param {"" | "high" | "late" | "done"} [state]
   * @returns {string}
   */
  const task = (title, tag, due, state = "") => `<div class="task ${state}"><span class="box"></span><span class="title">${title}</span><span class="tag">${tag}</span><span class="due">${due}</span></div>`;

  /**
   * A person's initial in a circle, their name and a line under it.
   * @param {string} name
   * @param {string} sub
   * @returns {string}
   */
  const person = (name, sub) => `<div class="person"><span class="face" aria-hidden="true">${name[0]}</span><span><b>${name}</b><span class="sub">${sub}</span></span></div>`;

  /**
   * An item with a muted line under it.
   * @param {string} title
   * @param {string} sub
   * @param {string} [cls]
   * @returns {string}
   */
  const item = (title, sub, cls = "") => `<div class="item ${cls}"><b>${title}</b><span class="sub">${sub}</span></div>`;

  /**
   * A week of habit squares: 1 done, 0 missed.
   * @param {string} name
   * @param {string} week Seven 1s and 0s.
   * @returns {string}
   */
  const habit = (name, week) => `<div class="habit"><span>${name}</span><span class="days">${[...week].map((d) => `<i class="${d === "1" ? "on" : ""}"></i>`).join("")}</span></div>`;

  const label = (text) => `<span class="label">${text}</span>`;
  const addBox = (text) => `<div class="add"><b>+</b>${text}</div>`;
  const check = (text, done = false) => `<div class="check${done ? " done" : ""}"><span class="box"></span>${text}</div>`;

  const PREVIEWS = {
    jira: `<div class="sub">Sprint 21 · 6 days left</div>`
      + `<div class="two">${count("var(--faint)", "To Do", 5)}${count("var(--info)", "In Progress", 2)}${count("var(--warn)", "Code Review", 3)}`
      + `${count("var(--warn)", "Tested", 4)}${count("var(--bad)", "Blocked", 1)}${count("var(--ok)", "Done", 8)}</div>`,
    cal: `${kv("Next", "Daily standup · in 25 min", "accent")}`
      + `<div class="times"><span>10:00</span><span class="ev"><b>Daily standup</b><span class="chip on">Join</span></span><span>1:30</span><span>Sprint planning</span><span>4:00</span><span>1:1 with Sam</span></div>`
      + `<div class="sub fit-only">Tomorrow: 2 events</div>`
      + `<div class="list roomy">${label("Tomorrow")}<div class="times"><span>10:00</span><span>Daily standup</span><span>2:00</span><span>Design review</span></div></div>`,
    slack: `${label("Mentions")}${person("Sam", "can you review #1234? · 9:42")}${person("Alex", "the reindex is done · 9:15")}${person("#team", "@here deploy at 3 PM · 8:50")}`
      + `<hr>${label("To-dos")}${check("Reply to Jordan on the demo plan")}${check("Read the roadmap thread")}<div class="sub">Also in Tasks</div>`
      + `<div class="list roomy">${label("Unread")}${kv("#eng-releases", "3 new")}${kv("#incidents", "1 new", "warn")}${kv("#team-viper", "8 new")}</div>`,
    ooo: `${chips(["Today", "Tomorrow", "Later"])}${person("Riley", "PTO · to Oct 31")}${person("Jordan", "VL · Oct 29 to 30")}`
      + `<div class="roomy">${person("Casey", "Sick leave · today")}</div>`,
    tasks: `${addBox("Add a task: Review #1234 tomorrow 3pm !high")}${chips(["Today", "Upcoming", "Overdue", "Someday", "Done"])}`
      + `${task("Review #1234 (Ledger export)", "#review", "3:00 PM", "high")}${task("Reply to Sam on PROJ-101", "#project", "Today")}`
      + `${task("Prep sprint demo notes", "#sprint", "Overdue", "late")}${task("Ask the data team about the reindex", "#data", "Tomorrow")}`
      + `${task("Renew an access token", "#admin", "Done", "done")}`
      + `<div class="roomy">${task("Update the on-call runbook", "#oncall", "Fri")}${task("Book a 1:1 with Alex", "#team", "Next week")}</div>`,
    myday: `<div class="weather"><span class="temp">29°</span><span>Partly cloudy<span class="sub">Manila</span></span></div>`
      + `<hr>${item("Dinner with family", "Tonight, 7:00 PM")}${item("Badminton with friends", "Sat, 8:00 AM")}<span class="chip warm">Nov 1 · All Saints' Day</span>`,
    buddy: `<div class="bubble">How did the interview go today?</div><div class="sub">You told me on Tuesday</div>`
      + `<div class="sub">Your week, as you shared it</div><div class="mood"><i class="ok"></i><i class="ok"></i><i class="warn"></i><i class="ok"></i><i class="accent"></i><i></i><i></i></div>`
      + chips(["Talk", "Type"]),
    dates: `${item("Nov 3 · Mom's birthday", "in 5 days", "soon")}${item("Nov 14 · Anniversary", "in 16 days")}${item("Dec 20 · Trip to Baguio", "in 52 days")}<div class="sub">From calendars and Felix</div>`,
    timeoff: `${label("Next break")}<div class="big">Dec 22 to Jan 2</div><div class="sub accent">in 54 days · 12 days off</div>`
      + `<hr>${label("Booked")}<div>Dec 22 to Jan 2 · VL</div><div>Feb 13 · Offset</div><div class="sub">From the vacation tracker</div>`,
    habits: `${habit("Water", "1111111")}${habit("Exercise", "1011100")}${habit("Reading", "1101101")}${habit("Sleep 8h", "0110100")}<div class="sub">Water: 12-day streak</div>`,
    bills: `${kv("Electricity", "Nov 5", "warn")}${kv("Internet", "Nov 8")}${kv("Streaming", "Nov 12")}${kv("Car insurance", "Dec 1")}<div class="sub">Reminders only</div>`,
    ptasks: `${addBox("Add: Buy a gift for Mom Sat !high #family")}${chips(["Today", "Upcoming", "Done"])}`
      + `${task("Buy a gift for Mom", "#family", "Sat", "high")}${task("Book the bus to Baguio", "#trip", "Today")}`
      + `${task("Pay the electricity bill", "#bills", "Nov 5")}${task("Renew passport", "#errands", "Overdue", "late")}`
      + `${task("Call Grandma", "#family", "Done", "done")}<div class="sub">Kept apart from work tasks</div>`,
    lists: `${chips(["Groceries", "Packing", "+"])}${check("Eggs", true)}${check("Rice, 5 kg")}${check("Coffee beans")}${check("Dish soap")}`,
    journal: `<div class="accent"><b>Best part of today?</b></div><div class="bubble plain">The demo went really well, and dinner with family.</div><div class="sub">Stays on this Mac</div>`,
  };

  const SAVED_HERE = "Saved on this Mac. Nothing to set up.";

  /**
   * @type {Record<string, { title: string, icon: string, link?: { href: string, label: string, external?: boolean }, soon?: { about: string, needs: string, preview: string } }>}
   */
  const CARDS = {
    ic: {
      title: "Incident Commander",
      icon: strokeIcon(`<path d="M12 3l7 3v6c0 4.5-3 7.5-7 9-4-1.5-7-4.5-7-9V6l7-3z"/>`),
      link: { href: "https://us5.datadoghq.com/on-call/schedules", label: "Datadog", external: true },
    },
    jira: {
      title: "My Jira Board",
      icon: strokeIcon(`<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M8 8v6M12 8v3M16 8v8"/>`),
      link: { href: "https://purepm.atlassian.net/jira/your-work", label: "Open Jira", external: true },
    },
    prs: {
      title: "Open PRs",
      icon: strokeIcon(`<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M6 8.5v7M18 15.5V9a3 3 0 0 0-3-3h-4M13 4l-2 2 2 2"/>`),
      link: { href: "/prs", label: "Open →" },
    },
    ai: {
      title: "AI usage",
      icon: strokeIcon(`<path d="M4 16a8 8 0 1 1 16 0"/><path d="M12 16l4-5"/>`),
    },
    cal: {
      title: "Calendar",
      icon: strokeIcon(`<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>`),
      link: { href: "https://calendar.google.com/calendar/r/day", label: "Google", external: true },
    },
    slack: {
      title: "Slack",
      icon: strokeIcon(`<path d="M5 9h15M4 15h15M10 4 8 20M16 4l-2 16"/>`),
      link: { href: "https://app.slack.com/client", label: "Slack", external: true },
    },
    ooo: {
      title: "Team out of office",
      icon: strokeIcon(`<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6M16 8l4 4M20 8l-4 4"/>`),
    },
    tasks: {
      title: "Tasks",
      icon: strokeIcon(`<path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6.5h9M11 12.5h9M11 18.5h9"/>`),
    },
    myday: {
      title: "My day",
      icon: strokeIcon(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.3 5.3l1.4 1.4M17.3 17.3l1.4 1.4M5.3 18.7l1.4-1.4M17.3 6.7l1.4-1.4"/>`),
      soon: { about: "The weather, your next personal plans, and the next holiday.", needs: "Needs: a Google sign-in with your personal account.", preview: PREVIEWS.myday },
    },
    buddy: {
      title: "Felix",
      // Felix's own face (logo 2a), the same mark as the top bar's.
      icon: `<svg class="mark" viewBox="0 0 64 64" aria-hidden="true"><circle class="face" cx="32" cy="32" r="28"/><rect class="eye" x="21" y="20" width="6.5" height="12.5" rx="3.25"/><path class="wink" d="M36 28.5q3.5-5.5 7 0"/><path class="smile" d="M21.5 40c5.8 5.8 15.2 5.8 21 0"/></svg>`,
    },
    dates: {
      title: "Important dates",
      icon: strokeIcon(`<rect x="3.5" y="8" width="17" height="4" rx="1"/><path d="M5 12v8h14v-8M12 8v12M12 8c-1.5-3-5-3.5-5-1.5S10 8 12 8zm0 0c1.5-3 5-3.5 5-1.5S14 8 12 8z"/>`),
      soon: { about: "Birthdays, anniversaries and trips, each with a countdown.", needs: "Needs: the personal Google sign-in.", preview: PREVIEWS.dates },
    },
    timeoff: {
      title: "My time off",
      icon: strokeIcon(`<path d="M3 12a9 9 0 0 1 18 0H3zM12 12v7a2 2 0 0 0 4 0"/>`),
      soon: { about: "Your next break and the leave you have booked.", needs: "Needs: the work Google sign-in, for the vacation tracker.", preview: PREVIEWS.timeoff },
    },
    habits: {
      title: "Habits",
      icon: strokeIcon(`<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.5"/><circle cx="12" cy="12" r="1"/>`),
      soon: { about: "Small daily habits through the week, with streaks.", needs: SAVED_HERE, preview: PREVIEWS.habits },
    },
    bills: {
      title: "Bills & renewals",
      icon: strokeIcon(`<path d="M6 3h12v18l-3-2-3 2-3-2-3 2Z"/><path d="M9 8h6M9 12h6"/>`),
      soon: { about: "Bills and renewals coming due. Reminders only: Felix pays nothing.", needs: SAVED_HERE, preview: PREVIEWS.bills },
    },
    ptasks: {
      title: "Tasks",
      icon: strokeIcon(`<path d="M4 6l1.5 1.5L8 5M4 12l1.5 1.5L8 11M4 18l1.5 1.5L8 17M11 6.5h9M11 12.5h9M11 18.5h9"/>`),
    },
    lists: {
      title: "Lists",
      icon: strokeIcon(`<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1"/><circle cx="4.5" cy="12" r="1"/><circle cx="4.5" cy="18" r="1"/>`),
      soon: { about: "Groceries, packing and other checklists.", needs: SAVED_HERE, preview: PREVIEWS.lists },
    },
    journal: {
      title: "Journal",
      icon: strokeIcon(`<path d="M4 20l4-1 11-11-3-3L5 16l-1 4z"/><path d="M14 6l3 3"/>`),
      soon: { about: "One question a day, and your answer.", needs: "Stays on this Mac. Nothing to set up.", preview: PREVIEWS.journal },
    },
  };

  return { CARDS, strokeIcon };
})();
