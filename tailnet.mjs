/**
 * Decides which pages may send Felix change requests: Felix on localhost, plus Felix on this Mac's
 * tailnet address when `tailscale serve` publishes it over HTTPS (for the iPad). Nothing else.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const TAILSCALE = process.env.TAILSCALE_BIN || "/usr/local/bin/tailscale";
const TIMEOUT_MS = 10e3;
const RECHECK_MS = 60e3;

/**
 * Reads Tailscale's status for this Mac.
 * @param {(file: string, args: string[], options: { timeout: number }) => Promise<{ stdout: string }>} [run]
 * @returns {Promise<string>} The JSON printed by `tailscale status --json`.
 */
export async function readTailscaleStatus(run = promisify(execFile)) {
  const { stdout } = await run(TAILSCALE, ["status", "--json"], { timeout: TIMEOUT_MS });
  return stdout;
}

/**
 * Turns Tailscale's status into the origin `tailscale serve` gives this Mac.
 * @param {string} statusJson Output of `tailscale status --json`.
 * @returns {string | null} Such as "https://macbook-air-2.taile6e8fb.ts.net", or null without MagicDNS.
 */
export function tailnetOrigin(statusJson) {
  try {
    const name = String(JSON.parse(statusJson)?.Self?.DNSName || "").replace(/\.$/, "");
    return name ? `https://${name}` : null;
  } catch {
    return null;
  }
}

/**
 * Builds the check for a request's Origin header.
 * @param {object} deps
 * @param {number} deps.port Felix's local port.
 * @param {() => Promise<string>} deps.readStatus Returns `tailscale status --json` output.
 * @param {() => number} [deps.now] Clock, in milliseconds.
 * @param {number} [deps.recheckMs] How long a tailnet lookup is trusted before Tailscale is asked again.
 * @returns {(origin?: string) => Promise<boolean>} True when the origin may send change requests.
 */
export function createOriginCheck({ port, readStatus, now = Date.now, recheckMs = RECHECK_MS }) {
  const local = new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`]);
  let lookup = null;
  let lookedAt = 0;
  const tailnet = () => {
    if (!lookup || now() - lookedAt >= recheckMs) {
      lookedAt = now();
      lookup = readStatus().then(tailnetOrigin, () => null);
    }
    return lookup;
  };
  return async (origin) => !origin || local.has(origin) || origin === await tailnet();
}
