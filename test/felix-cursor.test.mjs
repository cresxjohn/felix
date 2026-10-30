import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { SESSION_ARGS, createCursorSession, modelParts, sessionModel, textIn, toolUse } from "../felix-cursor.mjs";

const LISTED = ["composer-2.5[fast=true]", "claude-opus-5-5[context=300k,effort=medium,fast=false]", "claude-opus-5[thinking=true,effort=high]",
  "claude-sonnet-5-5[context=300k,reasoning_effort=high]", "gpt-5.6-sol[reasoning=medium,fast=false]", "gemini-3.1-pro[]"];
const MODELS = LISTED.map(modelParts);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A message Cursor writes as it answers: one piece of the reply.
 * @param {string} text
 * @returns {object}
 */
const chunk = (text) => ({ method: "session/update", params: { sessionId: "s1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });

const DEFAULTS = {
  initialize: () => ({ result: { protocolVersion: 1 } }),
  "session/new": () => ({ result: { sessionId: "s1", models: { currentModelId: LISTED[0], availableModels: LISTED.map((modelId) => ({ modelId })) } } }),
  "session/prompt": (params, { send }) => {
    send({ method: "session/update", params: { update: { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } } } });
    send(chunk("Hi "));
    send(chunk("there. "));
    return { result: { stopReason: "end_turn" } };
  },
};

/**
 * A pretend Cursor ACP server. Each handler answers a method's params with the reply to write, or null to never
 * answer; methods with no handler get an empty result.
 * @param {Record<string, (params: object, io: { send: (msg: object) => void }) => object | null>} [handlers]
 * @returns {{ spawnImpl: Function, procs: Array<EventEmitter & { args: string[], killed: boolean, sent: object[] }> }}
 */
function fakeAcp(handlers = {}) {
  const procs = [];
  const spawnImpl = (bin, args, options) => {
    const proc = Object.assign(new EventEmitter(), { bin, args, options, killed: false, stdout: new PassThrough(), sent: [] });
    const send = (msg) => proc.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...msg })}\n`);
    const respond = (msg) => {
      const handler = handlers[msg.method] || DEFAULTS[msg.method];
      const out = handler ? handler(msg.params, { send }) : { result: {} };
      if (out) send({ id: msg.id, ...out });
    };
    proc.stdin = new Writable({
      write(text, _enc, done) {
        for (const line of String(text).split("\n").filter(Boolean)) {
          const msg = JSON.parse(line);
          proc.sent.push(msg);
          if (msg.method) setImmediate(() => respond(msg));
        }
        done();
      },
    });
    proc.kill = () => {
      proc.killed = true;
      setImmediate(() => proc.emit("exit", 0));
    };
    procs.push(proc);
    return proc;
  };
  return { spawnImpl, procs };
}

/**
 * A Cursor session over a pretend server.
 * @param {Record<string, Function>} [handlers]
 * @param {object} [extra] Options to override.
 */
function session(handlers, extra = {}) {
  const fake = fakeAcp(handlers);
  const cursor = createCursorSession({ bin: "agent", cwd: "/tmp/felix", systemPrompt: "Be Felix.", spawnImpl: fake.spawnImpl, turnMs: 1000, idleMs: 1000, maxTurns: 10, ...extra });
  const sent = (method, n = 0) => fake.procs[n].sent.filter((m) => m.method === method);
  return { ...fake, cursor, sent };
}

test("a model from `cursor-agent models` gets the session's name for it, with its fast and effort options", () => {
  assert.deepEqual(modelParts("composer-2.5[fast=true]"), { id: "composer-2.5[fast=true]", base: "composer-2.5", params: [["fast", "true"]] });
  assert.deepEqual(modelParts("gemini-3.1-pro[]"), { id: "gemini-3.1-pro[]", base: "gemini-3.1-pro", params: [] });
  assert.deepEqual(modelParts("plain"), { id: "plain", base: "plain", params: [] });
  assert.equal(sessionModel("composer-2.5-fast", MODELS), "composer-2.5[fast=true]");
  assert.equal(sessionModel("composer-2.5", MODELS), "composer-2.5[fast=false]");
  assert.equal(sessionModel("claude-opus-5-5-high", MODELS), "claude-opus-5-5[context=300k,effort=high,fast=false]");
  assert.equal(sessionModel("claude-opus-5-5-medium-fast", MODELS), "claude-opus-5-5[context=300k,effort=medium,fast=true]");
  assert.equal(sessionModel("claude-opus-5-thinking", MODELS), "claude-opus-5[thinking=true,effort=high]");
  assert.equal(sessionModel("claude-opus-5-low", MODELS), "claude-opus-5[thinking=false,effort=low]");
  assert.equal(sessionModel("claude-sonnet-5-5-medium", MODELS), "claude-sonnet-5-5[context=300k,reasoning_effort=medium]");
  assert.equal(sessionModel("gpt-5.6-sol-low", MODELS), "gpt-5.6-sol[reasoning=low,fast=false]");
  assert.equal(sessionModel("gemini-3.1-pro", MODELS), "gemini-3.1-pro[]");
  assert.equal(sessionModel(LISTED[1], MODELS), LISTED[1]);
  assert.equal(sessionModel("auto", MODELS), null);
});

test("the session starts once, in agent mode, and the rules go with the first question only", async () => {
  const { cursor, procs, sent } = session();
  const deltas = [];
  assert.deepEqual(await cursor.ask("hello", "composer-2.5-fast", { onDelta: (d) => deltas.push(d) }), { text: "Hi there.", error: null, limit: false });
  assert.deepEqual(deltas, ["Hi ", "there. "]);
  assert.equal((await cursor.ask("again")).text, "Hi there.");
  assert.equal(procs.length, 1);
  assert.equal(procs[0].bin, "agent");
  assert.deepEqual(procs[0].args, [...SESSION_ARGS]);
  assert.ok(procs[0].args.includes("--sandbox"));
  assert.deepEqual(sent("session/new")[0].params, { cwd: "/tmp/felix", mcpServers: [] });
  assert.deepEqual(sent("session/set_mode")[0].params, { sessionId: "s1", modeId: "agent" });
  assert.equal(sent("session/set_model").length, 0);
  assert.deepEqual(sent("session/prompt").map((m) => m.params.prompt[0].text), ["Be Felix.\n\nhello", "again"]);
  await cursor.close();
  assert.equal(procs[0].killed, true);
});

test("the model is switched only when it changes, and the turn before goes along only when unseen", async () => {
  const { cursor, sent } = session();
  await cursor.ask("one", "claude-opus-5-5-medium");
  await cursor.ask("two", "claude-opus-5-5-medium", { before: "one" });
  await cursor.ask("three", "composer-2.5-fast", { before: "earlier" });
  assert.deepEqual(sent("session/set_model").map((m) => m.params.modelId), ["claude-opus-5-5[context=300k,effort=medium,fast=false]", "composer-2.5[fast=true]"]);
  assert.deepEqual(sent("session/prompt").map((m) => m.params.prompt[0].text), ["Be Felix.\n\none", "two", "earlier\n\nthree"]);
  await cursor.close();
});

test("questions are asked one at a time, in order", async () => {
  const { cursor, sent } = session();
  const answers = await Promise.all(["a", "b", "c"].map((q) => cursor.ask(q)));
  assert.deepEqual(answers.map((a) => a.text), ["Hi there.", "Hi there.", "Hi there."]);
  assert.deepEqual(sent("session/prompt").map((m) => m.params.prompt[0].text.split("\n\n").at(-1)), ["a", "b", "c"]);
  await cursor.close();
});

test("Felix's gate answers each permission request once, and each tool Cursor uses is passed on", async () => {
  const asked = [];
  const uses = [];
  const options = [{ optionId: "yes1", kind: "allow_once" }, { optionId: "always", kind: "allow_always" }, { optionId: "no1", kind: "reject_once" }];
  const { cursor, procs } = session({
    "session/prompt": (_p, { send }) => {
      send({ method: "session/update", params: { update: { sessionUpdate: "tool_call", kind: "execute", title: "`gh pr list`", status: "pending" } } });
      send({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", content: [{ type: "content", content: { type: "text", text: "fm#12 by anna" } }] } } });
      send({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", status: "completed" } } });
      send({ id: 80, method: "session/request_permission", params: { toolCall: { kind: "execute", title: "`gh pr list`" }, options } });
      send({ id: 81, method: "session/request_permission", params: { toolCall: { kind: "execute", title: "`gh pr merge 1`" }, options } });
      send({ id: 82, method: "session/request_permission", params: { toolCall: { kind: "boom" }, options } });
      return null;
    },
  }, {
    systemPrompt: () => "Rules now.",
    allow: async (call) => {
      asked.push(call.title);
      if (call.kind === "boom") throw new Error("gate broke");
      return call.title === "`gh pr list`";
    },
  });
  const answer = cursor.ask("q", undefined, { onTool: (u) => uses.push(u) });
  const replies = [];
  for (let i = 0; i < 200 && replies.length < 3; i += 1) {
    await wait(5);
    replies.splice(0, replies.length, ...(procs[0]?.sent || []).filter((m) => !m.method && m.id >= 80));
  }
  assert.deepEqual(replies.find((m) => m.id === 80).result, { outcome: { outcome: "selected", optionId: "yes1" } });
  assert.deepEqual(replies.find((m) => m.id === 81).result, { outcome: { outcome: "selected", optionId: "no1" } });
  assert.deepEqual(replies.find((m) => m.id === 82).result, { outcome: { outcome: "selected", optionId: "no1" } });
  assert.deepEqual(asked, ["`gh pr list`", "`gh pr merge 1`", undefined]);
  assert.deepEqual(uses, [{ step: "Checking GitHub", seen: "`gh pr list`" }, { seen: "fm#12 by anna" }]);
  assert.equal(procs[0].sent.find((m) => m.method === "session/prompt").params.prompt[0].text, "Rules now.\n\nq");
  await cursor.close();
  assert.equal((await answer).error, "Cursor failed: Cursor stopped");
});

test("a tool's result text is found wherever Cursor puts it", () => {
  assert.equal(textIn([{ a: "one", b: [2, { c: "two" }] }, null]), "one\ntwo");
  assert.equal(toolUse({ sessionUpdate: "tool_call", kind: "read" }).step, "Reading a file");
  assert.equal(toolUse({ sessionUpdate: "tool_call" }).step, "Working");
  assert.equal(toolUse({ sessionUpdate: "agent_thought_chunk" }), null);
  assert.deepEqual(toolUse({ sessionUpdate: "tool_call_update", rawOutput: { stdout: "ok" } }), { seen: "ok" });
});

test("without Felix's gate, a tool Cursor asks to use is turned down, and anything else it asks isn't supported", async () => {
  const { cursor, procs } = session({
    "session/prompt": (_p, { send }) => {
      send({ id: 77, method: "session/request_permission", params: {} });
      send({ id: 78, method: "fs/read_text_file", params: {} });
      send(chunk("Done."));
      return { result: { stopReason: "end_turn" } };
    },
  });
  assert.equal((await cursor.ask("q")).text, "Done.");
  const replies = procs[0].sent.filter((m) => !m.method);
  assert.deepEqual(replies.find((m) => m.id === 77).result, { outcome: { outcome: "cancelled" } });
  assert.equal(replies.find((m) => m.id === 78).error.code, -32601);
  await cursor.close();
});

test("the session can't take a question it couldn't start, or a model it doesn't list, so nothing is asked", async () => {
  const asks = async (handlers, model, extra) => {
    const s = session(handlers, extra);
    const answer = await s.cursor.ask("q", model);
    await s.cursor.close();
    return { answer, prompts: s.procs.flatMap((p) => p.sent).filter((m) => m.method === "session/prompt").length };
  };
  assert.deepEqual(await asks({ initialize: () => ({ error: { message: "old" } }) }), { answer: null, prompts: 0 });
  assert.deepEqual(await asks({ "session/new": () => ({ error: { message: "Not logged in" } }) }), { answer: null, prompts: 0 });
  assert.deepEqual(await asks({ "session/new": () => ({ result: {} }) }), { answer: null, prompts: 0 });
  assert.deepEqual(await asks({ "session/set_mode": () => ({ error: { message: "no ask mode" } }) }), { answer: null, prompts: 0 });
  assert.deepEqual(await asks({ initialize: () => null }, undefined, { startMs: 20 }), { answer: null, prompts: 0 });
  assert.deepEqual(await asks({}, "auto"), { answer: null, prompts: 0 });
  assert.deepEqual(await asks({ "session/set_model": () => ({ error: { data: { message: "Invalid model value" } } }) }, "composer-2.5"), { answer: null, prompts: 0 });

  const bare = session({ "session/new": () => ({ result: { sessionId: "s2" } }) });
  assert.equal(await bare.cursor.ask("q", "composer-2.5-fast"), null);
  assert.equal((await bare.cursor.ask("q")).text, "Hi there.");
  await bare.cursor.close();
});

test("a failed, stuck or stopped question comes back as an error, and the next one starts a new session", async () => {
  const failed = session({ "session/prompt": () => ({ error: { message: "Usage limit reached" } }) });
  assert.deepEqual(await failed.cursor.ask("q"), { text: "", error: "Cursor failed: Usage limit reached", limit: false });
  await failed.cursor.close();

  const stuck = session({ "session/prompt": () => null }, { turnMs: 20 });
  assert.equal((await stuck.cursor.ask("q")).error, "Cursor took too long");
  assert.equal(stuck.procs[0].killed, true);
  await stuck.cursor.close();

  let hung = false;
  const dying = session({ "session/prompt": (params, io) => (hung ? DEFAULTS["session/prompt"](params, io) : ((hung = true), null)) });
  const pending = dying.cursor.ask("q");
  await wait(20);
  dying.procs[0].emit("exit", 1);
  assert.equal((await pending).error, "Cursor failed: Cursor stopped");
  assert.equal((await dying.cursor.ask("again")).text, "Hi there.");
  assert.equal(dying.procs.length, 2);
  await dying.cursor.close();

  const missing = session({ initialize: () => null });
  const run = missing.cursor.ask("q");
  await wait(5);
  missing.procs[0].emit("error", new Error("ENOENT"));
  assert.equal(await run, null);
  await missing.cursor.close();
});

test("a session that's had enough questions is replaced in the background, and an idle one closes", async () => {
  const busy = session({}, { maxTurns: 2 });
  await busy.cursor.ask("a");
  await busy.cursor.ask("b");
  assert.equal(busy.procs[0].killed, true);
  assert.equal(busy.procs.length, 2);
  await busy.cursor.ask("c");
  assert.equal(busy.procs.length, 2);
  assert.equal(busy.sent("session/prompt", 1)[0].params.prompt[0].text, "Be Felix.\n\nc");
  await busy.cursor.close();

  const idle = session({}, { idleMs: 20 });
  await idle.cursor.ask("a");
  await wait(40);
  assert.equal(idle.procs[0].killed, true);
  await idle.cursor.close();
});

test("warming starts the session once and keeps it open longer, but leaves a question in progress alone", async () => {
  const { cursor, procs } = session({}, { idleMs: 40 });
  await cursor.warm();
  await cursor.warm();
  assert.equal(procs.length, 1);
  await wait(25);
  await cursor.warm();
  await wait(25);
  assert.equal(procs[0].killed, false);
  await wait(30);
  assert.equal(procs[0].killed, true);
  await cursor.close();

  let release;
  const slow = session({ "session/prompt": (_p, { send }) => { release = () => send({ id: 4, result: { stopReason: "end_turn" } }); return null; } }, { idleMs: 10 });
  const pending = slow.cursor.ask("q");
  await wait(20);
  await slow.cursor.warm();
  await wait(20);
  assert.equal(slow.procs[0].killed, false);
  release();
  assert.equal((await pending).error, null);
  await slow.cursor.close();
  await slow.cursor.close();

  const broken = session({ initialize: () => ({ error: { message: "no" } }) });
  await broken.cursor.warm();
  await broken.cursor.close();
});

test("a message sent while Cursor works is handed over when its current step ends, and the answer carries on", async () => {
  const tool = (status) => ({ method: "session/update", params: { update: { sessionUpdate: "tool_call_update", toolCallId: "t1", title: "Edit home.html", kind: "edit", status } } });
  const prompts = [];
  const { cursor, procs, sent } = session({
    "session/prompt": (params, { send }) => {
      prompts.push(params.prompt[0].text);
      if (prompts.length === 1) {
        send(chunk("Working on it. "));
        send(tool("in_progress"));
        return null;
      }
      send(chunk("Dark mode too."));
      return { result: { stopReason: "end_turn" } };
    },
  });
  assert.equal(await cursor.steer("anything"), false);
  const answer = cursor.ask("Build the Jira card");
  await wait(30);
  assert.equal(await cursor.steer("make it work in dark mode"), true);
  procs[0].stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...tool("completed") })}\n`);
  await wait(30);
  assert.match(prompts[1], /While you were working, I added: "make it work in dark mode"/);
  const first = sent("session/prompt")[0];
  procs[0].stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: first.id, result: { stopReason: "cancelled" } })}\n`);
  assert.equal((await answer).text, "Working on it. \n\nDark mode too.");
  await cursor.close();
});

test("a long piece of work that keeps reporting isn't cut off; only one that goes quiet is", async () => {
  let id = 0;
  const long = session({
    "session/prompt": (params, { send }) => {
      // Reports a tool step every 40 ms for 1.2 s, well past the 500 ms quiet limit, then answers.
      const waitFor = (n) => setTimeout(() => {
        if (n < 30) {
          send({ method: "session/update", params: { update: { sessionUpdate: "tool_call", toolCallId: `t${n}`, title: "Run ./prs test", kind: "execute" } } });
          return waitFor(n + 1);
        }
        send(chunk("Built it."));
        send({ id, result: { stopReason: "end_turn" } });
      }, 40);
      waitFor(0);
      return null;
    },
  }, { turnMs: 500 });
  const asked = long.cursor.ask("build it");
  while (!long.procs[0]?.sent.some((m) => m.method === "session/prompt")) await wait(1);
  id = long.sent("session/prompt")[0].id;
  assert.deepEqual(await asked, { text: "Built it.", error: null, limit: false });
  await long.cursor.close();
});

test("Stop ends the question in progress, and the next question starts a new session", async () => {
  const idle = session();
  assert.equal(await idle.cursor.stop(), false);
  await idle.cursor.ask("q");
  assert.equal(await idle.cursor.stop(), false);
  await idle.cursor.close();

  const busy = session({ "session/prompt": () => null });
  const asked = busy.cursor.ask("build a widget");
  await wait(20);
  assert.equal(await busy.cursor.stop(), true);
  assert.equal((await asked).error, "Cursor failed: Stopped");
  assert.equal(busy.procs[0].killed, true);
  await busy.cursor.close();
});
