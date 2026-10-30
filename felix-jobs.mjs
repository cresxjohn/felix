/**
 * Felix's helpers: work he hands off so he can keep talking to you. Each job (building a tool he's missing, or a
 * task you threw at him) runs in the background, a few at once, the rest waiting their turn. Jobs are saved as they
 * go, so a restart picks up what was running, and each one gets back to you on its own with its answer.
 */
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const LIMIT = 3;
const KEEP = 200;
const ATTEMPTS = 2;

/**
 * @typedef {"build" | "task"} JobKind
 * @typedef {{ id: string, kind: JobKind, title: string, input: Record<string, any>, status: "queued" | "running" | "done" | "failed",
 *   step: string, createdAt: string, startedAt: string | null, endedAt: string | null, attempts: number, by: string | null,
 *   answer: string | null, error: string | null, result: Record<string, any> | null }} Job
 * @typedef {(job: Job, ctl: { step: (text: string) => void, by: (who: string) => void }) => Promise<{ answer: string, result?: Record<string, any> }>} Runner
 */

/**
 * Creates the job queue.
 * @param {{ file: string, runners: Partial<Record<JobKind, Runner>>, limit?: number, onDone?: (job: Job) => void,
 *   now?: () => number }} options
 */
export function createJobs({ file, runners, limit = LIMIT, onDone = () => {}, now = Date.now }) {
  /** @type {Job[]} */
  let jobs = [];
  const running = new Set();
  let saving = Promise.resolve();
  const ready = readFile(file, "utf8").then((t) => {
    jobs = (JSON.parse(t).jobs || []).map((j) => (j.status === "running" ? { ...j, status: "queued", step: "Picking up where I left off" } : j));
  }, () => {}).then(() => pump());

  const stamp = () => new Date(now()).toISOString();

  /** Saves the jobs, one write at a time. */
  function save() {
    const text = `${JSON.stringify({ jobs: jobs.slice(-KEEP) }, null, 2)}\n`;
    saving = saving.then(() => mkdir(path.dirname(file), { recursive: true })).then(() => writeFile(file, text)).catch(() => {});
    return saving;
  }

  /**
   * Changes a job and saves it.
   * @param {Job} job
   * @param {Partial<Job>} patch
   */
  function set(job, patch) {
    Object.assign(job, patch);
    save();
  }

  /** Starts waiting jobs while there's room. */
  function pump() {
    for (const job of jobs) {
      if (running.size >= limit) return;
      if (job.status !== "queued" || running.has(job.id)) continue;
      start(job);
    }
  }

  /**
   * Runs one job to its end.
   * @param {Job} job
   */
  async function start(job) {
    running.add(job.id);
    set(job, { status: "running", startedAt: job.startedAt || stamp(), attempts: (job.attempts || 0) + 1 });
    const runner = runners[job.kind];
    try {
      if (!runner) throw new Error(`Felix can't do ${job.kind} jobs.`);
      const out = await runner(job, { step: (text) => set(job, { step: String(text) }), by: (who) => set(job, { by: who }) });
      set(job, { status: "done", step: "Done", endedAt: stamp(), answer: String(out.answer || "").trim() || "Done.", result: out.result || null });
    } catch (e) {
      const why = String(e?.message || e);
      // A job cut off by a restart already went back in the queue; one that failed on its own gets one more go.
      if (job.attempts < ATTEMPTS && e?.retry) {
        set(job, { status: "queued", step: "Trying again" });
        running.delete(job.id);
        return pump();
      }
      set(job, { status: "failed", step: "Stopped", endedAt: stamp(), error: why, answer: e?.said || null });
    }
    running.delete(job.id);
    try { onDone(job); } catch { /* the job's answer is saved either way */ }
    pump();
  }

  return {
    ready,
    /**
     * Adds a job; it starts as soon as there's room.
     * @param {{ kind: JobKind, title: string, input: Record<string, any> }} spec
     * @returns {Promise<Job>}
     */
    async add({ kind, title, input }) {
      await ready;
      /** @type {Job} */
      const job = { id: `${kind}-${now().toString(36)}-${randomBytes(3).toString("hex")}`, kind, title: String(title).slice(0, 160), input,
        status: "queued", step: "Waiting its turn", createdAt: stamp(), startedAt: null, endedAt: null, attempts: 0, by: null, answer: null, error: null, result: null };
      jobs.push(job);
      save();
      pump();
      return job;
    },
    /**
     * The jobs, newest first.
     * @param {{ limit?: number, open?: boolean }} [options] `open` keeps only the ones still waiting or running.
     * @returns {Job[]}
     */
    list({ limit: n = 20, open = false } = {}) {
      return jobs.filter((j) => !open || j.status === "queued" || j.status === "running").slice(-n).reverse().map((j) => ({ ...j }));
    },
    /** @param {string} id @returns {Job | null} */
    get: (id) => {
      const j = jobs.find((x) => x.id === id);
      return j ? { ...j } : null;
    },
    /** Waits for the saves in flight (for tests). */
    settled: () => saving,
  };
}

/**
 * Felix's tools for his helpers: building a tool he's missing, handing off a task, seeing how they're going, and
 * using a tool he built after this conversation began.
 * @param {{ jobs: ReturnType<typeof createJobs>, toolbox: ReturnType<typeof import("./felix-toolbox.mjs").createToolbox> }} deps
 * @returns {import("./felix-tools.mjs").Tool[]}
 */
export function jobTools({ jobs, toolbox }) {
  const brief = (j) => ({ id: j.id, kind: j.kind, title: j.title, status: j.status, step: j.step, startedAt: j.startedAt, endedAt: j.endedAt, answer: j.answer });
  return [
    {
      name: "tool_build",
      description: "When none of your tools can get what the user asked for, start building one. It runs in the background on its own (it takes a few minutes): the new tool is written, tested, saved, then used to answer the question, and the answer reaches the user on its own. Returns at once. Then tell the user, in these words: \"I'm sorry, I'm not able to do it right now, let me look into this.\" To make an existing tool of yours do more, give its name in extend.",
      inputSchema: {
        type: "object",
        properties: {
          question: { type: "string", description: "The user's question, in their words, to answer once the tool is ready." },
          need: { type: "string", description: "What the tool must do, in plain words: what it reads, what it gives back." },
          extend: { type: "string", description: "The name of one of your own tools to extend instead of making a new one." },
        },
        required: ["question", "need"],
      },
      run: async (a) => {
        const same = jobs.list({ open: true }).find((j) => j.kind === "build" && j.input.need === a.need);
        if (same) return { started: false, already: brief(same) };
        const job = await jobs.add({ kind: "build", title: String(a.need).slice(0, 120), input: { question: String(a.question), need: String(a.need), extend: a.extend ? String(a.extend) : null } });
        return { started: true, job: brief(job), say: "I'm sorry, I'm not able to do it right now, let me look into this." };
      },
    },
    {
      name: "delegate",
      description: "Hands a task to a helper that works in the background with all your tools, so you can keep talking with the user: for things that take a while, or when the user throws several things at you at once. Each helper gets back to the user on its own. Returns at once; tell the user you're on it.",
      inputSchema: {
        type: "object",
        properties: { task: { type: "string", description: "The whole task, with everything the helper needs to know." }, title: { type: "string", description: "A few plain words for it." } },
        required: ["task"],
      },
      run: async (a) => brief(await jobs.add({ kind: "task", title: String(a.title || a.task).slice(0, 120), input: { task: String(a.task) } })),
    },
    {
      name: "jobs_status",
      description: "How your helpers' jobs are going: what's waiting, running (and on which step), done (with its answer) or stopped.",
      inputSchema: { type: "object", properties: { open: { type: "boolean", description: "Only the ones still waiting or running." } } },
      run: async (a) => ({ jobs: jobs.list({ limit: 15, open: Boolean(a.open) }).map(brief) }),
    },
    {
      name: "my_tools",
      description: "The tools you built yourself, with what each takes. Use one with tool_use when it isn't in your tool list yet (it was built after this conversation began).",
      inputSchema: { type: "object", properties: {} },
      run: async () => (await toolbox.mine()).tools.map(({ name, description, inputSchema, version }) => ({ name, description, inputSchema, version })),
    },
    {
      name: "tool_use",
      description: "Runs one of the tools you built yourself, by its name, with its arguments.",
      inputSchema: { type: "object", properties: { name: { type: "string" }, args: { type: "object" } }, required: ["name"] },
      run: async (a) => {
        const tool = toolbox.list().find((t) => t.own && t.name === a.name);
        if (!tool) throw new Error(`There's no tool of mine called ${a.name}. my_tools lists them.`);
        if (tool.card) throw new Error(`${a.name} does something, so it's used directly, not through tool_use.`);
        return tool.run(a.args || {});
      },
    },
  ];
}
