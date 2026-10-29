// Where a PR stands, shared by the Open PRs page and the home page's Open PRs card so both count the same way.
// `reviews` is the server's session map: PR link -> review session, "fix:<PR link>" -> fix session.
window.PrStatus = (() => {
  function needsReview(p) {
    return !p.isDraft && p.reviewDecision !== "APPROVED" && !p.changesRequestedBy.length;
  }

  // Claude review on someone else's PR. Order matters: a running session wins, then my newest GitHub
  // review, then the session's own state.
  function claudeState(p, reviews) {
    const r = reviews[p.url];
    const my = p.myReview;
    if (r?.status === "running") return { id: "running", cls: "run", label: `On-going · ${r.steps} step${r.steps === 1 ? "" : "s"}` };
    if (r?.status === "answering") return { id: "running", cls: "run", label: "Working on your answer…" };
    if (r?.status === "waiting") return { id: "ready", cls: "warn", label: "Needs your approval" };
    if (r?.status === "queued") return { id: "queued", cls: "", label: "Queued for Claude" };
    if (my && (!r || my.submittedAt >= r.startedAt)) {
      if (my.state === "APPROVED") return { id: "done", cls: "ok", label: "Done · you approved" };
      if (my.state === "CHANGES_REQUESTED") return { id: "changes", cls: "alert", label: "You requested changes" };
      if (my.state === "COMMENTED") return { id: "commented", cls: "", label: "You commented" };
    }
    if (r?.status === "ready") return { id: "ready", cls: "warn", label: "Complete · needs your action" };
    if (r?.status === "answered") return { id: "answered", cls: "", label: r.answer === "D" ? "Kept in chat only" : `Answered ${r.answer}` };
    if (r?.status === "failed") return { id: "failed", cls: "bad", label: "Review failed" };
    if (r?.status === "stopped") return { id: "stopped", cls: "", label: "Review stopped" };
    if (r?.status === "ended") return { id: "ended", cls: "", label: "Session ended" };
    return null;
  }

  // Claude fix on one of my PRs.
  function fixState(p, reviews) {
    const f = reviews[`fix:${p.url}`];
    if (!f) return null;
    const steps = `${f.steps} step${f.steps === 1 ? "" : "s"}`;
    return {
      running: { id: "running", cls: "run", label: `Claude fixing · ${steps}` },
      answering: { id: "running", cls: "run", label: `Claude fixing · ${steps}` },
      waiting: { id: "ready", cls: "warn", label: "Fix needs your approval" },
      ready: { id: "ready", cls: "warn", label: "Fix ready · check and push" },
      pushed: { id: "pushed", cls: "ok", label: "Fix pushed" },
      failed: { id: "failed", cls: "bad", label: "Fix failed" },
      stopped: { id: "stopped", cls: "", label: "Fix stopped" },
      ended: { id: "ended", cls: "", label: "Fix session ended" },
    }[f.status] || null;
  }

  // GitHub says CLEAN (approved, checks pass, no conflicts) and it isn't in the merge queue yet.
  function readyToMerge(p) {
    return p.mergeState === "CLEAN" && !p.isDraft && !p.inMergeQueue;
  }

  return { needsReview, claudeState, fixState, readyToMerge };
})();
