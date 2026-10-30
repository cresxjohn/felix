import { test } from "node:test";
import assert from "node:assert/strict";
import { ALLOW_TOOL, createMcp } from "../felix-mcp.mjs";

test("Claude Code can start, list Felix's one tool, and ask it; notifications get no answer", async () => {
  const asked = [];
  const mcp = createMcp({ decide: async (name, input) => { asked.push(name); return input.command === "ls"; } });
  assert.equal((await mcp({ id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } })).result.protocolVersion, "2025-03-26");
  assert.equal((await mcp({ id: 2, method: "initialize" })).result.serverInfo.name, "felix");
  assert.deepEqual((await mcp({ id: 3, method: "tools/list" })).result.tools.map((t) => t.name), [ALLOW_TOOL]);
  assert.deepEqual((await mcp({ id: 4, method: "ping" })).result, {});
  assert.equal(await mcp({ method: "notifications/initialized" }), null);
  const yes = await mcp({ id: 5, method: "tools/call", params: { name: ALLOW_TOOL, arguments: { tool_name: "Bash", input: { command: "ls" } } } });
  assert.deepEqual(JSON.parse(yes.result.content[0].text), { behavior: "allow", updatedInput: { command: "ls" } });
  const no = await mcp({ id: 6, method: "tools/call", params: { name: ALLOW_TOOL, arguments: { tool_name: "Bash", input: { command: "rm x" } } } });
  assert.equal(JSON.parse(no.result.content[0].text).behavior, "deny");
  const bare = await mcp({ id: 7, method: "tools/call", params: { name: ALLOW_TOOL } });
  assert.equal(JSON.parse(bare.result.content[0].text).behavior, "deny");
  assert.deepEqual(asked, ["Bash", "Bash", ""]);
  assert.equal((await mcp({ id: 8, method: "tools/call", params: { name: "other" } })).error.code, -32601);
});

test("Felix's service tools are listed; a lookup runs at once, an action asks first, and a failure comes back readable", async () => {
  const asked = [];
  const tools = [
    { name: "calendar_events", description: "events", inputSchema: { type: "object" }, run: async (a) => ({ events: [{ title: "Standup" }], from: a.from }) },
    { name: "slack_post", description: "post", inputSchema: { type: "object" }, card: (a) => ({ title: `Post this in ${a.channel}?`, detail: a.text }), run: async () => ({ ok: true }) },
    { name: "broken", description: "x", inputSchema: { type: "object" }, run: async () => { throw new Error("Slack isn't connected yet."); } },
  ];
  let allow = false;
  const mcp = createMcp({ decide: async () => true, tools, act: async (card) => { asked.push(card); return allow; } });
  const listed = await mcp({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.deepEqual(listed.result.tools.map((t) => t.name), [ALLOW_TOOL, "calendar_events", "slack_post", "broken"]);
  assert.equal(listed.result.tools[1].run, undefined, "only the tool's description goes out");

  const looked = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "calendar_events", arguments: { from: "2026-11-02", to: "2026-11-06" } } });
  assert.deepEqual(JSON.parse(looked.result.content[0].text), { events: [{ title: "Standup" }], from: "2026-11-02" });
  assert.deepEqual(asked, [], "a lookup asks nobody");

  const refused = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "slack_post", arguments: { channel: "#team", text: "Hi all" } } });
  assert.equal(refused.result.isError, true);
  assert.deepEqual(asked, [{ title: "Post this in #team?", detail: "Hi all" }]);
  allow = true;
  const posted = await mcp({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "slack_post", arguments: { channel: "#team", text: "Hi all" } } });
  assert.deepEqual(JSON.parse(posted.result.content[0].text), { ok: true });

  const failed = await mcp({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "broken", arguments: {} } });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /That didn't work: Slack isn't connected yet\./);
});

test("the tool list is read afresh each time, so a tool Felix just built is there, and a card may take a moment to make", async () => {
  const tools = [{ name: "calendar_events", description: "x", inputSchema: { type: "object" }, run: async () => 1 }];
  const asked = [];
  const mcp = createMcp({ decide: async () => true, tools: () => tools, act: async (card) => { asked.push(card); return true; } });
  assert.deepEqual((await mcp({ id: 1, method: "tools/list" })).result.tools.map((t) => t.name), [ALLOW_TOOL, "calendar_events"]);
  tools.push({ name: "nudge_team", description: "y", inputSchema: { type: "object" }, card: async (a) => ({ title: "Nudge them?", detail: a.who }), run: async () => "sent" });
  assert.deepEqual((await mcp({ id: 2, method: "tools/list" })).result.tools.map((t) => t.name), [ALLOW_TOOL, "calendar_events", "nudge_team"]);
  const ran = await mcp({ id: 3, method: "tools/call", params: { name: "nudge_team", arguments: { who: "Ana" } } });
  assert.equal(ran.result.content[0].text, '"sent"');
  assert.deepEqual(asked, [{ title: "Nudge them?", detail: "Ana" }]);
});
