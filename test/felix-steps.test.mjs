import { test } from "node:test";
import assert from "node:assert/strict";
import { claudeStep, commandStep, cursorStep, ownSteps } from "../felix-steps.mjs";

test("steps are plain words: no commands, file paths or tool names", () => {
  assert.equal(commandStep("gh pr view 12 --json title"), "Checking GitHub");
  assert.equal(commandStep("cd x && ./prs test"), "Running the tests");
  assert.equal(commandStep("rg -n clear public/felix.js | head"), "Looking through your records");
  assert.equal(commandStep("make deploy"), "Running a step");
  assert.equal(claudeStep("Grep", { pattern: "x" }), "Looking through your records");
  assert.equal(claudeStep("SomethingNew", {}), "Working");
  assert.equal(cursorStep({ kind: "think" }), "Looking into it");
  assert.equal(cursorStep({ kind: "execute", title: "`git log -3`" }), "Checking the code's history");
});

test("Felix's own tools show as what they check or do, from Claude and Cursor alike", () => {
  assert.equal(claudeStep("mcp__felix__calendar_events", { from: "2026-11-02" }), "Checking your calendar");
  assert.equal(claudeStep("mcp__felix__slack_post", {}), "Posting in Slack");
  assert.equal(claudeStep("mcp__other__thing", {}), "Using one of my tools");
  assert.equal(cursorStep({ kind: "other", title: "felix-jira_search: assignee = currentUser()" }), "Checking Jira");
  assert.equal(cursorStep({ kind: "other", title: "tasks_add" }), "Adding the task");
  assert.equal(cursorStep({ kind: "other", title: "MCP tool", rawInput: { name: "tasks_update", id: "t1" } }), "Updating your task");
});

test("Felix's helpers and the tools he built show their own plain words", () => {
  assert.equal(claudeStep("mcp__felix__tool_build", {}), "Starting on a new tool");
  assert.equal(claudeStep("mcp__felix__delegate", {}), "Handing it to a helper");
  ownSteps((name) => (name === "team_leave_year" ? "Checking the leave tracker" : null));
  try {
    assert.equal(claudeStep("mcp__felix__team_leave_year", {}), "Checking the leave tracker");
    assert.equal(claudeStep("mcp__felix__unknown_tool", {}), "Using one of my tools");
    assert.equal(cursorStep({ kind: "other", title: "felix-team_leave_year" }), "Checking the leave tracker");
    assert.equal(cursorStep({ kind: "other", rawInput: { tool: "mcp__felix__team_leave_year" } }), "Checking the leave tracker");
    assert.equal(cursorStep({ kind: "other", title: "felix-unknown_tool" }), "Working");
  } finally {
    ownSteps(() => null);
  }
});
