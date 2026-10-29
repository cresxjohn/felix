// Runs one Cursor agent session for Felix, inside a hidden tmux window (like Claude reviews and fixes).
//
// Cursor's CLI has no hooks for Felix to listen to, so each turn runs `cursor-agent -p --output-format
// stream-json --resume <chat>` and this script turns the stream into the same events hooks/report.sh
// sends for Claude (UserPromptSubmit, PreToolUse, Stop, StopFailure). It prints readable progress for the
// live view, then waits on stdin: an answer typed into the window (the page's A–D buttons do that)
// starts the next turn in the same chat. Ctrl-C ends it.
//
//   node cursor-runner.mjs --chat <id> [--model <model>] -- <first prompt>
// Environment: OPEN_PRS_REVIEW (the session key), OPEN_PRS_PORT, CURSOR_AGENT_BIN.
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";

const AGENT = process.env.CURSOR_AGENT_BIN || path.join(homedir(), ".local", "bin", "cursor-agent");
const KEY = process.env.OPEN_PRS_REVIEW || "";
const PORT = process.env.OPEN_PRS_PORT || "4777";

const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : ""; };
const chat = opt("--chat");
const model = opt("--model");
const firstPrompt = args.slice(args.indexOf("--") + 1).join(" ");

async function report(ev) {
  if (!KEY) return;
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/review-event`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Open-Prs-Review": KEY },
      body: JSON.stringify({ ...ev, session_id: chat }),
      signal: AbortSignal.timeout(3000),
    });
  } catch {}
}

const say = (text) => process.stdout.write(`${text}\n`);

// Cursor's tool calls, in the shape Felix's step labels already understand (Claude tool names).
function asTool(toolCall = {}) {
  const [kind, body = {}] = Object.entries(toolCall)[0] || ["tool", {}];
  const a = body.args || {};
  switch (kind) {
    case "shellToolCall": return { tool_name: "Bash", tool_input: { command: a.command || "", description: a.description } };
    case "readToolCall": return { tool_name: "Read", tool_input: { file_path: a.path || "" } };
    case "editToolCall": return { tool_name: "Edit", tool_input: { file_path: a.path || "" } };
    case "writeToolCall": return { tool_name: "Write", tool_input: { file_path: a.path || "" } };
    case "grepToolCall": return { tool_name: "Grep", tool_input: { pattern: a.pattern || "" } };
    case "globToolCall": return { tool_name: "Glob", tool_input: { pattern: a.globPattern || a.pattern || "" } };
    case "function": return { tool_name: body.name || "tool", tool_input: {} };
    // MCP tools come as "<server>-<tool>", e.g. "mcp-atlassian-jira_get_issue"; the step shows the tool part.
    case "mcpToolCall": return { tool_name: String(a.name || "mcp").replace(/^.*-(?=[^-]+$)/, ""), tool_input: a.args || {} };
    default: return { tool_name: kind.replace(/ToolCall$/, ""), tool_input: a };
  }
}

function turn(prompt) {
  return new Promise((resolve) => {
    report({ hook_event_name: "UserPromptSubmit", prompt });
    say(`\n› ${prompt.length > 300 ? `${prompt.slice(0, 300)}…` : prompt}\n`);
    const child = spawn(AGENT, [
      "-p", "--output-format", "stream-json", "--resume", chat, "--trust", "--force",
      ...(model ? ["--model", model] : []),
      prompt,
    ], { stdio: ["ignore", "pipe", "pipe"] });
    // `last` is the text after the most recent tool call: the turn's final message, like Claude's
    // last_assistant_message. Cursor's own `result` joins every message of the turn with no breaks.
    let buf = "", result = null, failed = false, stderr = "", last = "";
    const handle = (line) => {
      let ev;
      try { ev = JSON.parse(line); } catch { return; }
      if (ev.type === "tool_call" && ev.subtype === "started") {
        const t = asTool(ev.tool_call);
        report({ hook_event_name: "PreToolUse", ...t });
        if (last && !last.endsWith("\n")) say("");
        last = "";
        say(`  · ${t.tool_name}: ${JSON.stringify(t.tool_input).slice(0, 140)}`);
      } else if (ev.type === "assistant") {
        const part = (ev.message?.content || []).map((c) => c.text || "").join("");
        if (part) { last += part; process.stdout.write(part); }
      } else if (ev.type === "result") {
        result = ev.result ?? last;
        failed = Boolean(ev.is_error);
      }
    };
    child.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) { handle(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.on("data", (d) => { stderr += d; process.stdout.write(String(d)); });
    child.on("close", (code) => {
      if (buf.trim()) handle(buf);
      if (result !== null && !failed) report({ hook_event_name: "Stop", last_assistant_message: last.trim() || String(result).trim() });
      else report({ hook_event_name: "StopFailure", error: (stderr.trim() || String(result || "")).slice(-600) || `Cursor stopped (exit ${code}).` });
      say(`\n${result !== null && !failed ? "Done." : "Cursor stopped with an error."} Type a reply and press Enter to continue, or Ctrl-C to end.`);
      resolve();
    });
  });
}

if (!chat || !firstPrompt) { say("Usage: node cursor-runner.mjs --chat <id> [--model <model>] -- <prompt>"); process.exit(2); }
report({ hook_event_name: "SessionStart", source: "startup" });
await turn(firstPrompt);
const rl = readline.createInterface({ input: process.stdin });
for await (const line of rl) {
  const reply = line.trim();
  if (reply) await turn(reply);
}
