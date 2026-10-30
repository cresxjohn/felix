import { test } from "node:test";
import assert from "node:assert/strict";
import { diffSummary, parseDiff } from "../public/felix-diff.mjs";

const CHANGE = `diff --git a/felix-commands.mjs b/felix-commands.mjs
index 20e4563..ef5ebbe 100644
--- a/felix-commands.mjs
+++ b/felix-commands.mjs
@@ -202,4 +202,6 @@ const COMMANDS = [
     re: /^turn (on|off)$/,
     slots: () => ({}),
   },
+  { intent: "mode", re: /^work ?space$/ },
+  { intent: "mode", re: /^open (the )?workspace$/ },
-  { intent: "old" },
   { intent: "next" },
\\ No newline at end of file
diff --git a/docs/new.md b/docs/new.md
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/docs/new.md
@@ -0,0 +1,2 @@
+# Notes
+Felix learned "work space".
diff --git a/old.mjs b/old.mjs
deleted file mode 100644
--- a/old.mjs
+++ /dev/null
@@ -1 +0,0 @@
-export const gone = 1;
diff --git a/public/icon.png b/public/icon.png
Binary files a/public/icon.png and b/public/icon.png differ
diff --git a/a.mjs b/b.mjs
similarity index 90%
rename from a.mjs
rename to b.mjs
`;

test("a change reads as files, each with what happened, how many lines came and went, and numbered lines", () => {
  const files = parseDiff(CHANGE);
  assert.deepEqual(files.map((f) => [f.path, f.status, f.added, f.removed, f.binary]), [
    ["felix-commands.mjs", "changed", 2, 1, false],
    ["docs/new.md", "new", 2, 0, false],
    ["old.mjs", "deleted", 0, 1, false],
    ["public/icon.png", "changed", 0, 0, true],
    ["b.mjs", "renamed", 0, 0, false],
  ]);
  assert.equal(files[4].from, "a.mjs");
  const lines = files[0].lines;
  assert.deepEqual(lines[0], { kind: "hunk", text: "const COMMANDS = [", old: null, new: null });
  assert.deepEqual(lines[1], { kind: "same", text: "    re: /^turn (on|off)$/,", old: 202, new: 202 });
  assert.deepEqual(lines[4], { kind: "add", text: '  { intent: "mode", re: /^work ?space$/ },', old: null, new: 205 });
  assert.deepEqual(lines[6], { kind: "del", text: '  { intent: "old" },', old: 205, new: null });
  assert.deepEqual(lines[7], { kind: "same", text: '  { intent: "next" },', old: 206, new: 207 });
  assert.equal(lines.length, 8, "the no-newline note is left out");
  assert.deepEqual(files[1].lines.slice(1).map((l) => l.new), [1, 2]);
});

test("the change in a few words, and nothing to read when there's no change", () => {
  assert.equal(diffSummary(parseDiff(CHANGE)), "5 files · 4 added, 2 removed");
  assert.equal(diffSummary(parseDiff(CHANGE).slice(0, 1)), "1 file · 2 added, 1 removed");
  assert.deepEqual(parseDiff(""), []);
  assert.deepEqual(parseDiff("No changes in Felix's workbench."), []);
});
