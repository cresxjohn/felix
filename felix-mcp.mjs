/**
 * Felix's MCP server, for his AI (Claude Code, and Cursor through `felix-mcp-bridge.mjs`). It has "allow", which
 * Claude Code asks before it uses any tool that needs permission (its --permission-prompt-tool), and Felix's service
 * tools (`felix-tools.mjs`): looking things up runs at once, and doing something waits on a card you allow. Both
 * answers come from Felix's gate. It's served on Felix's own port, to this Mac only, behind a token only his AI has.
 */

export const ALLOW_TOOL = "allow";
const PROTOCOL = "2025-06-18";
// The most text one tool's answer gives the AI.
const ANSWER_CHARS = 24_000;

const TOOLS = [{
  name: ALLOW_TOOL,
  description: "Decides whether Felix's AI may use a tool. Felix answers; reads go through and changes wait for the user's yes.",
  inputSchema: {
    type: "object",
    properties: { tool_name: { type: "string" }, input: { type: "object" }, tool_use_id: { type: "string" } },
    required: ["tool_name", "input"],
  },
}];

/**
 * @typedef {{ jsonrpc?: string, id?: number | string, method?: string, params?: { protocolVersion?: string, name?: string,
 *   arguments?: { tool_name?: string, input?: Record<string, unknown> } } }} McpRequest
 * @typedef {(name: string, input: Record<string, unknown>) => Promise<boolean>} Decide
 * @typedef {(card: { title: string, detail: string }) => Promise<boolean>} Act Asks you to allow a service action.
 */

/**
 * The tool's answer, in the shape Claude Code reads.
 * @param {boolean} yes
 * @param {Record<string, unknown>} input
 * @returns {object}
 */
const verdict = (yes, input) => ({
  content: [{ type: "text", text: JSON.stringify(yes ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The user said no, or Felix never runs that. Don't try another way around it." }) }],
});

/**
 * The result of one MCP call.
 * @param {McpRequest} msg
 * @param {Decide} decide
 * @returns {Promise<{ result?: object, error?: { code: number, message: string } }>}
 */
async function resultFor(msg, decide, tools = [], act = async () => false) {
  if (typeof tools === "function") tools = tools();
  if (msg.method === "initialize") {
    return { result: { protocolVersion: msg.params?.protocolVersion || PROTOCOL, capabilities: { tools: {} }, serverInfo: { name: "felix", version: "1" } } };
  }
  if (msg.method === "tools/list") {
    return { result: { tools: [...TOOLS, ...tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))] } };
  }
  if (msg.method === "ping") return { result: {} };
  if (msg.method === "tools/call" && msg.params?.name === ALLOW_TOOL) {
    const input = msg.params.arguments?.input || {};
    return { result: verdict(await decide(String(msg.params.arguments?.tool_name || ""), input), input) };
  }
  const tool = msg.method === "tools/call" ? tools.find((t) => t.name === msg.params?.name) : null;
  if (tool) return { result: await callTool(tool, /** @type {Record<string, any>} */ (msg.params?.arguments || {}), act) };
  return { error: { code: -32601, message: "Felix doesn't support that" } };
}

/**
 * Runs one of Felix's service tools: an action asks you first. What it found goes back as JSON text; a refusal or a
 * failure as an error the AI can read and say plainly.
 * @param {import("./felix-tools.mjs").Tool} tool
 * @param {Record<string, any>} args
 * @param {Act} act
 * @returns {Promise<object>}
 */
async function callTool(tool, args, act) {
  const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
  if (tool.card && !(await act(await tool.card(args)))) return text("The user didn't allow it. Don't try another way around it.", true);
  try {
    const out = await tool.run(args);
    const json = JSON.stringify(out ?? null);
    return text(json.length > ANSWER_CHARS ? `${json.slice(0, ANSWER_CHARS)} …(cut short)` : json);
  } catch (e) {
    return text(`That didn't work: ${e?.message || e}`, true);
  }
}

/**
 * Creates the handler for MCP's JSON-RPC messages.
 * @param {{ decide: Decide, tools?: import("./felix-tools.mjs").Tool[] | (() => import("./felix-tools.mjs").Tool[]), act?: Act }} options
 *   `tools` may be a getter, read on each message, so a tool Felix builds shows up without a restart.
 * @returns {(msg: McpRequest) => Promise<object | null>} Null for a notification, which gets no answer.
 */
export function createMcp({ decide, tools = [], act }) {
  return async (msg) => {
    if (msg.id === undefined || msg.id === null) return null;
    return { jsonrpc: "2.0", id: msg.id, ...(await resultFor(msg, decide, tools, act)) };
  };
}
