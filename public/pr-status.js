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

  // Where a release PR stands, in GitHub's own terms. `o` is one repo's `open` from /api/releases.
  // cls matches the pill colors: ok, warn, alert, run, or "" for neutral.
  function releaseStatus(o) {
    if (o.inMergeQueue) return { cls: "run", label: "In merge queue" };
    if (o.mergeState === "CLEAN") return { cls: "ok", label: "Ready to merge", title: o.approvedBy.length ? `Approved by ${o.approvedBy.join(", ")}` : "" };
    if (o.changesBy.length) return { cls: "alert", label: `Changes requested by ${o.changesBy.join(", ")}` };
    if (o.reviewDecision === "REVIEW_REQUIRED") {
      const who = o.awaiting.length ? ` · ${o.awaiting.join(", ")}` : o.approvedBy.length ? ` · ${o.approvedBy.length} approved` : "";
      const title = `Needs ${o.approvedBy.length ? "another" : "an"} approving review before it can merge${o.approvedBy.length ? `. Approved by ${o.approvedBy.join(", ")}` : ""}`;
      return { cls: "warn", label: `Awaiting reviewers${who}`, title };
    }
    if (o.checks && o.checks !== "SUCCESS") return { cls: "run", label: "Waiting for checks" };
    return { cls: "", label: "Not ready to merge", title: `GitHub says ${(o.mergeState || "unknown").toLowerCase()}` };
  }

  // Whether the last release reached prod. `prod` is `last.prod` from /api/releases; null means unknown.
  // Returns { cls, label, title, url } or null when there's nothing to say (no deployable packages).
  function prodStatus(prod, ago) {
    if (!prod || prod.state === "none") return null;
    if (prod.state === "in-prod") return { cls: "ok", label: `In prod · ${ago(prod.run.at)}`, title: `All ${prod.total} deployable packages were promoted to prod`, url: prod.run.url };
    if (prod.running) return { cls: "run", label: "Prod promotion running", url: prod.running.url };
    if (prod.state === "partial") return { cls: "warn", label: `Partly in prod · ${prod.covered} of ${prod.total}`, title: "Some of its packages were promoted to prod" };
    return { cls: "", label: "Not in prod yet", title: "Waits for the next prod promotion" };
  }

  return { needsReview, claudeState, fixState, readyToMerge, releaseStatus, prodStatus };
})();
