import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { deleteKeychain, readKeychainAccount, writeKeychain } from "../keychain.mjs";

test("readKeychainAccount reads the account name from security's listing", async () => {
  const seen = [];
  const runImpl = async (cmd, args) => {
    seen.push([cmd, args]);
    return { stdout: 'keychain: "login.keychain-db"\nattributes:\n    "acct"<blob>="me@pure.co"\n    "svce"<blob>="cmd-center-jira"\n' };
  };
  assert.equal(await readKeychainAccount("cmd-center-jira", { runImpl }), "me@pure.co");
  assert.deepEqual(seen, [["security", ["find-generic-password", "-s", "cmd-center-jira"]]]);
});

test("readKeychainAccount is null when there's no account or no item", async () => {
  assert.equal(await readKeychainAccount("s", { runImpl: async () => ({ stdout: '"acct"<blob>=""' }) }), null);
  assert.equal(await readKeychainAccount("s", { runImpl: async () => ({ stdout: "attributes:\n" }) }), null);
  assert.equal(await readKeychainAccount("s", { runImpl: async () => { throw new Error("The specified item could not be found"); } }), null);
});

test("a security helper that can't start fails the write and the delete", async () => {
  const spawnImpl = () => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => setImmediate(() => child.emit("error", new Error("spawn security ENOENT"))) };
    return child;
  };
  await assert.rejects(writeKeychain("s", "a", "v", { spawnImpl }), /ENOENT/);
  await assert.rejects(deleteKeychain("s", "a", { spawnImpl }), /ENOENT/);
  await assert.rejects(deleteKeychain("s", "bad value", { spawnImpl }), /characters/);
});
