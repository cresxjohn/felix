#!/bin/sh
# Claude Code hook for review sessions started by the Open PRs page: forwards the hook's JSON
# to the local server. It only runs in sessions the page started (they pass hooks/settings.json),
# and it exits quietly if the page isn't running.
[ -n "$OPEN_PRS_REVIEW" ] || exit 0
curl -s -m 3 -X POST "http://127.0.0.1:${OPEN_PRS_PORT:-4777}/api/review-event" \
  -H "Content-Type: application/json" -H "X-Open-Prs-Review: $OPEN_PRS_REVIEW" \
  --data-binary @- >/dev/null 2>&1
exit 0
