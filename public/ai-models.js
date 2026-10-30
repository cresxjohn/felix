/**
 * The Claude models Felix and the Open PRs page offer, by the alias `claude --model` takes for the latest of each.
 * One list for both: the pages load this as a plain script (window.FelixModels) and the server requires it.
 * Cursor's models aren't here; they come from `cursor-agent models`.
 */
(function share(root) {
  const CLAUDE_MODELS = Object.freeze([
    { id: "opus", name: "Opus 5.5" },
    { id: "sonnet", name: "Sonnet 5.5" },
    { id: "haiku", name: "Haiku 5.5" },
    { id: "fable", name: "Fable 5.1" },
  ]);
  const models = Object.freeze({ CLAUDE_MODELS });
  if (typeof module === "object" && module.exports) module.exports = models;
  else root.FelixModels = models;
})(this);
