import { test } from "node:test";
import assert from "node:assert/strict";
import { ghKind, gitKind, shellKind, wordsOf } from "../felix-readonly.mjs";

test("commands that only look are reads, run straight away", () => {
  for (const c of ["ls -la", "cat README.md | head -20", "rg -n felix public/ 2>/dev/null", "git status && git log --oneline -5", "pwd; echo hi",
    "find . -name '*.mjs'", "sed -n '1,20p' server.mjs", "./prs test", "node --test test/a.test.mjs", "cd public && ls", "GH_PAGER=cat gh pr list"]) {
    assert.equal(shellKind(c), "read", c);
  }
});

test("anything that writes, or that Felix doesn't know, is a change", () => {
  for (const c of ["rm -rf build", "touch x", "echo hi > notes.txt", "cat $(which node)", "sed -i '' s/a/b/ f", "find . -delete", "git push",
    "git commit -m x", "git branch -D main", "npm install", "curl https://example.com", "ls && rm x", "", "xargs rm", "echo `date`"]) {
    assert.equal(shellKind(c), "change", c);
  }
});

test("logins, the Keychain and the system are never touched", () => {
  for (const c of ["security find-generic-password -s x", "sudo ls", "gh auth token", "gh secret list", "ls; launchctl list", "echo $(security dump-keychain)",
    "gh api /user/keys", "tailscale funnel 443"]) {
    assert.equal(shellKind(c), "never", c);
  }
});

test("git reads are told apart from git changes", () => {
  assert.equal(gitKind(["-C", "/tmp/x", "log"]), "read");
  assert.equal(gitKind(["--no-pager", "diff"]), "read");
  assert.equal(gitKind(["branch", "-a"]), "read");
  assert.equal(gitKind(["branch", "feature"]), "change");
  assert.equal(gitKind(["remote", "-v"]), "read");
  assert.equal(gitKind(["remote", "add", "x", "y"]), "change");
  assert.equal(gitKind(["tag"]), "read");
  assert.equal(gitKind(["checkout", "main"]), "change");
});

test("gh reads look at GitHub; posting, merging and editing are changes", () => {
  assert.equal(ghKind(["pr", "view", "12", "-R", "purepm/frontend-monorepo"]), "read");
  assert.equal(ghKind(["pr", "checks", "12"]), "read");
  assert.equal(ghKind(["search", "prs", "--author", "@me"]), "read");
  assert.equal(ghKind(["status"]), "read");
  assert.equal(ghKind(["pr", "merge", "12"]), "change");
  assert.equal(ghKind(["pr", "comment", "12", "-b", "hi"]), "change");
  assert.equal(ghKind(["pr", "view", "12", "--web"]), "change");
  assert.equal(ghKind(["issue", "create"]), "change");
  assert.equal(ghKind([]), "change");
  assert.equal(ghKind(["-R", "x"]), "change");
  assert.equal(ghKind(["codespace", "list"]), "never");
});

test("gh api: a GET and a GraphQL query are reads; fields, other methods and mutations are changes", () => {
  assert.equal(ghKind(["api", "repos/a/b/pulls"]), "read");
  assert.equal(ghKind(["api", "-X", "GET", "repos/a/b/pulls", "-f", "state=open"]), "read");
  assert.equal(ghKind(["api", "--method=PATCH", "repos/a/b"]), "change");
  assert.equal(ghKind(["api", "repos/a/b/issues/1/comments", "-f", "body=hi"]), "change");
  assert.equal(ghKind(["api", "graphql", "-f", "query=query { viewer { login } }"]), "read");
  assert.equal(ghKind(["api", "graphql", "-f", "query=mutation { addStar }"]), "change");
  assert.equal(ghKind(["api", "repos/a/b/actions/secrets"]), "never");
});

test("quoted words keep their spaces", () => {
  assert.deepEqual(wordsOf(`gh pr comment 1 -b "two words" 'and more'`), ["gh", "pr", "comment", "1", "-b", "two words", "and more"]);
});
