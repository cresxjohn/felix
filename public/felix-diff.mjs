/**
 * What Felix changed in his workbench, read for people: the change as git writes it ("diff --git …") becomes a list
 * of files, each with what happened to it (new, deleted, renamed or changed), how many lines came and went, and its
 * lines with their numbers before and after. The chat's code view draws from this; the tests load it too.
 */

/**
 * @typedef {{ kind: "add" | "del" | "same" | "hunk", text: string, old: number | null, new: number | null }} DiffLine
 *   `hunk` is a "@@ … @@" line that starts a part of the file, with the code around it in `text`.
 * @typedef {{ path: string, from: string | null, status: "new" | "deleted" | "renamed" | "changed", binary: boolean,
 *   added: number, removed: number, lines: DiffLine[] }} DiffFile
 */

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@ ?(.*)$/;

/**
 * Reads a change as git writes it.
 * @param {string} text
 * @returns {DiffFile[]}
 */
export function parseDiff(text) {
  /** @type {DiffFile[]} */
  const files = [];
  /** @type {DiffFile | null} */
  let file = null;
  let oldNo = 0;
  let newNo = 0;
  let inHunk = false;
  for (const raw of String(text || "").split("\n")) {
    const head = raw.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (head) {
      file = { path: head[2], from: head[1] === head[2] ? null : head[1], status: head[1] === head[2] ? "changed" : "renamed", binary: false, added: 0, removed: 0, lines: [] };
      files.push(file);
      inHunk = false;
      continue;
    }
    if (!file) continue;
    if (!inHunk) {
      if (raw.startsWith("new file mode")) file.status = "new";
      else if (raw.startsWith("deleted file mode")) file.status = "deleted";
      else if (raw.startsWith("Binary files") || raw.startsWith("GIT binary patch")) file.binary = true;
    }
    const hunk = raw.match(HUNK);
    if (hunk) {
      oldNo = Number(hunk[1]);
      newNo = Number(hunk[2]);
      inHunk = true;
      file.lines.push({ kind: "hunk", text: hunk[3] || "", old: null, new: null });
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("+")) {
      file.lines.push({ kind: "add", text: raw.slice(1), old: null, new: newNo++ });
      file.added += 1;
    } else if (raw.startsWith("-")) {
      file.lines.push({ kind: "del", text: raw.slice(1), old: oldNo++, new: null });
      file.removed += 1;
    } else if (raw.startsWith(" ")) {
      file.lines.push({ kind: "same", text: raw.slice(1), old: oldNo++, new: newNo++ });
    }
    // "\ No newline at end of file" and blank trailing lines say nothing a reader needs.
  }
  return files;
}

/**
 * The whole change in a few words: "2 files · 14 added, 3 removed".
 * @param {DiffFile[]} files
 * @returns {string}
 */
export function diffSummary(files) {
  const added = files.reduce((n, f) => n + f.added, 0);
  const removed = files.reduce((n, f) => n + f.removed, 0);
  const count = `${files.length} file${files.length === 1 ? "" : "s"}`;
  return `${count} · ${added} added, ${removed} removed`;
}
