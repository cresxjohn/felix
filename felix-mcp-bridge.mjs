#!/usr/bin/env node
/**
 * Felix's MCP server for Cursor: Cursor starts its tool servers itself and talks to them over stdin and stdout, so
 * this passes each message on to Felix's own server (FELIX_MCP_URL, with its token in FELIX_MCP_TOKEN) and writes
 * the answer back. One JSON message a line each way.
 */
import { createInterface } from "node:readline";

const url = process.env.FELIX_MCP_URL;
const token = process.env.FELIX_MCP_TOKEN;

const lines = createInterface({ input: process.stdin });
lines.on("line", async (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(msg) });
    const text = await res.text();
    // A notification gets no answer.
    if (text.trim()) process.stdout.write(`${text.trim()}\n`);
  } catch (e) {
    if (msg.id !== undefined && msg.id !== null) {
      process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: `Felix isn't reachable: ${e.message}` } })}\n`);
    }
  }
});
