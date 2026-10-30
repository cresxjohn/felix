/**
 * Reading what Felix's AI processes write: one JSON event per line.
 */

/**
 * Calls `onLine` with each whole line a process writes.
 * @param {import("node:stream").Readable | null | undefined} stream
 * @param {(line: string) => void} onLine
 */
export function eachLine(stream, onLine) {
  let buffer = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    buffer += chunk;
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) if (line.trim()) onLine(line);
  });
}

/**
 * A line of JSON, or null when it isn't one.
 * @template [T=Record<string, unknown>]
 * @param {string} line
 * @returns {T | null}
 */
export function parsed(line) {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}
