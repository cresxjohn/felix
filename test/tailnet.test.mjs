import { test } from "node:test";
import assert from "node:assert/strict";
import { createOriginCheck, readTailscaleStatus, tailnetOrigin } from "../tailnet.mjs";

const STATUS = JSON.stringify({ Self: { DNSName: "macbook-air-2.taile6e8fb.ts.net." } });
const TAILNET = "https://macbook-air-2.taile6e8fb.ts.net";

/**
 * Builds an origin check with a fake Tailscale and a hand-moved clock.
 * @param {() => Promise<string>} readStatus
 * @returns {{ check: (origin?: string) => Promise<boolean>, calls: () => number, tick: (ms: number) => void }}
 */
function setup(readStatus = async () => STATUS) {
  let clock = 1000;
  let calls = 0;
  const check = createOriginCheck({
    port: 4777,
    readStatus: () => { calls += 1; return readStatus(); },
    now: () => clock,
    recheckMs: 60e3,
  });
  return { check, calls: () => calls, tick: (ms) => { clock += ms; } };
}

test("tailnetOrigin drops the trailing dot of the MagicDNS name", () => {
  assert.equal(tailnetOrigin(STATUS), TAILNET);
});

test("tailnetOrigin is null without a MagicDNS name or for bad output", () => {
  assert.equal(tailnetOrigin(JSON.stringify({ Self: {} })), null);
  assert.equal(tailnetOrigin("{}"), null);
  assert.equal(tailnetOrigin("not json"), null);
});

test("readTailscaleStatus runs `tailscale status --json` with a timeout", async () => {
  let seen;
  const out = await readTailscaleStatus(async (file, args, options) => {
    seen = { file, args, options };
    return { stdout: STATUS };
  });
  assert.equal(out, STATUS);
  assert.match(seen.file, /tailscale$/i);
  assert.deepEqual(seen.args, ["status", "--json"]);
  assert.ok(seen.options.timeout > 0);
});

test("local pages and requests without an Origin are allowed without asking Tailscale", async () => {
  const { check, calls } = setup();
  assert.equal(await check(undefined), true);
  assert.equal(await check("http://localhost:4777"), true);
  assert.equal(await check("http://127.0.0.1:4777"), true);
  assert.equal(calls(), 0);
});

test("this Mac's tailnet address is allowed; other sites and ports are not", async () => {
  const { check } = setup();
  assert.equal(await check(TAILNET), true);
  assert.equal(await check("http://macbook-air-2.taile6e8fb.ts.net"), false);
  assert.equal(await check("https://evil.ts.net"), false);
  assert.equal(await check("http://localhost:5173"), false);
});

test("Tailscale is asked at most once per recheck window", async () => {
  const { check, calls, tick } = setup();
  await check(TAILNET);
  await check("https://evil.example");
  assert.equal(calls(), 1);
  tick(60e3);
  await check(TAILNET);
  assert.equal(calls(), 2);
});

test("without Tailscale only local pages are allowed", async () => {
  const { check } = setup(async () => { throw new Error("tailscale: not running"); });
  assert.equal(await check(TAILNET), false);
  assert.equal(await check("http://localhost:4777"), true);
});
