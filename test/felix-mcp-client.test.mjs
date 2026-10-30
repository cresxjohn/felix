import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMcpClient } from "../felix-mcp-client.mjs";

// A tiny MCP server on stdin and stdout: tools/list, and tools/call answering by tool name.
const SERVER = `
import { createInterface } from "node:readline";
let started = false;
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  const reply = (body) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, ...body }) + "\\n");
  if (m.method === "initialize") { started = true; return reply({ result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fake" } } }); }
  if (m.id === undefined) return;
  if (!started) return reply({ error: { code: -1, message: "not started" } });
  if (m.method === "tools/list") return reply({ result: { tools: [{ name: "tasks", description: "Bills owed", inputSchema: { type: "object" } }] } });
  const { name, arguments: a } = m.params;
  if (name === "tasks") return reply({ result: { content: [{ type: "text", text: JSON.stringify({ space: a.space || "main", token: process.env.WAIS_TOKEN || null, leaked: process.env.SECRET_OF_FELIX || null }) }] } });
  if (name === "structured") return reply({ result: { content: [{ type: "text", text: "ignored" }], structuredContent: { ok: 1 } } });
  if (name === "words") return reply({ result: { content: [{ type: "text", text: "just words" }] } });
  if (name === "fails") return reply({ result: { isError: true, content: [{ type: "text", text: "Wais says no." }] } });
  if (name === "slow") return;
  if (name === "die") process.exit(3);
  reply({ error: { code: -32601, message: "No such tool" } });
});
`;

/** A client over the tiny server, in a fresh folder. */
function setup(options = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "felix-mcp-client-"));
  const file = path.join(dir, "server.mjs");
  writeFileSync(file, SERVER);
  let starts = 0;
  const client = createMcpClient({
    name: "Wais",
    spec: async () => { starts += 1; return options.off ? null : { command: process.execPath, args: [file], env: { WAIS_TOKEN: "tok-1" } }; },
    callMs: 500,
    ...options,
  });
  return { client, starts: () => starts, done: () => { client.stop(); rmSync(dir, { recursive: true, force: true }); } };
}

test("starts the server once, lists its tools, calls them, and passes only its own settings", async () => {
  process.env.SECRET_OF_FELIX = "never";
  const { client, starts, done } = setup();
  try {
    assert.deepEqual((await client.tools()).map((t) => t.name), ["tasks"]);
    assert.deepEqual(await client.call("tasks", { space: "home" }), { space: "home", token: "tok-1", leaked: null });
    assert.deepEqual(await client.call("tasks"), { space: "main", token: "tok-1", leaked: null });
    assert.deepEqual(await client.call("structured"), { ok: 1 });
    assert.equal(await client.call("words"), "just words");
    assert.equal(starts(), 1, "one server for every call");
    assert.equal(client.running(), true);
  } finally {
    delete process.env.SECRET_OF_FELIX;
    done();
  }
});

test("a tool's error, an unknown tool and a slow answer come back as plain errors", async () => {
  const { client, done } = setup();
  try {
    await assert.rejects(client.call("fails"), /Wais says no\./);
    await assert.rejects(client.call("nope"), /No such tool/);
    await assert.rejects(client.call("slow"), /Wais took too long to answer/);
    assert.deepEqual(await client.call("tasks"), { space: "main", token: "tok-1", leaked: null }, "still answering after those");
  } finally {
    done();
  }
});

test("a server that stops fails what it was answering, and starts again on the next call", async () => {
  const { client, starts, done } = setup();
  try {
    await assert.rejects(client.call("die"), /Wais stopped|Wais took too long/);
    assert.deepEqual(await client.call("tasks"), { space: "main", token: "tok-1", leaked: null });
    assert.equal(starts(), 2);
    client.stop();
    assert.equal(client.running(), false);
    await client.call("tasks");
    assert.equal(starts(), 3);
  } finally {
    done();
  }
});

test("not set up, a command that can't start, and an idle server", async () => {
  const off = setup({ off: true });
  try {
    await assert.rejects(off.client.call("tasks"), (e) => e.code === "not-set-up" && /Wais isn't set up yet/.test(e.message));
  } finally {
    off.done();
  }
  const broken = createMcpClient({ name: "Wais", spec: async () => ({ command: "/nowhere/wais-mcp" }), callMs: 500 });
  await assert.rejects(broken.call("tasks"), /Wais couldn't start|Wais took too long/);
  const sleepy = setup({ idleMs: 50 });
  try {
    await sleepy.client.call("tasks");
    await new Promise((r) => setTimeout(r, 120));
    assert.equal(sleepy.client.running(), false, "stopped after a while with nothing to do");
  } finally {
    sleepy.done();
  }
});
