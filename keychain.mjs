/**
 * Felix's secrets in the macOS login Keychain. Nothing is ever written to disk. Writes go through `security -i`,
 * which reads its command on stdin, so a secret never shows in the process list.
 */
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);
const SAFE_VALUE = /^[\w.~+/=:@-]+$/;

/**
 * Builds an Error with a machine-readable code the page can act on.
 * @param {string} code Short id such as "auth" or "not-connected".
 * @param {string} message Plain-language explanation for the page.
 * @returns {Error & { code: string }}
 */
export function codedError(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Reads one generic password from the login Keychain.
 * @param {string} service Keychain service name.
 * @param {string} [account] Keychain account; any account when left out.
 * @returns {Promise<string | null>} The secret, or null when there is no such item.
 */
export async function readKeychain(service, account) {
  const args = ["find-generic-password", "-s", service, ...(account ? ["-a", account] : []), "-w"];
  try {
    const { stdout } = await run("security", args);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Reads the account name of a Keychain item, such as the email a token belongs to. The secret itself isn't read.
 * @param {string} service Keychain service name.
 * @param {{ runImpl?: typeof run }} [deps]
 * @returns {Promise<string | null>} The account, or null when there is no such item.
 */
export async function readKeychainAccount(service, { runImpl = run } = {}) {
  try {
    const { stdout } = await runImpl("security", ["find-generic-password", "-s", service]);
    return stdout.match(/"acct"<blob>="([^"]*)"/)?.[1] || null;
  } catch {
    return null;
  }
}

/**
 * Runs one `security` command given on stdin.
 * @param {string} line The command, without the leading "security".
 * @param {typeof spawn} spawnImpl
 * @returns {Promise<string>} What it printed as an error, empty when it worked.
 */
function runOnStdin(line, spawnImpl) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl("security", ["-i"], { stdio: ["pipe", "ignore", "pipe"] });
    let errors = "";
    child.stderr.on("data", (chunk) => { errors += chunk; });
    child.on("error", reject);
    child.on("close", (code) => resolve(code === 0 ? errors.trim() : errors.trim() || `security exited with ${code}`));
    child.stdin.end(`${line}\n`);
  });
}

/**
 * Checks that every value can go in a `security` command as it is.
 * @param {string[]} values
 * @throws {Error} When one has characters other than letters, digits and . _ ~ + / = : @ -
 */
function checkValues(values) {
  if (!values.every((v) => SAFE_VALUE.test(v))) throw new Error("That value has characters the Keychain helper doesn't accept.");
}

/**
 * Saves one generic password in the login Keychain, replacing any old one.
 * @param {string} service
 * @param {string} account
 * @param {string} secret
 * @param {{ spawnImpl?: typeof spawn }} [deps]
 * @returns {Promise<void>}
 * @throws {Error} When the value can't be saved.
 */
export async function writeKeychain(service, account, secret, { spawnImpl = spawn } = {}) {
  checkValues([service, account, secret]);
  const failed = await runOnStdin(`add-generic-password -U -s "${service}" -a "${account}" -w "${secret}"`, spawnImpl);
  if (failed) throw new Error("Couldn't save to the Keychain.");
}

/**
 * Removes one generic password from the login Keychain. Removing one that isn't there is fine.
 * @param {string} service
 * @param {string} account
 * @param {{ spawnImpl?: typeof spawn }} [deps]
 * @returns {Promise<void>}
 * @throws {Error} When it is there and can't be removed.
 */
export async function deleteKeychain(service, account, { spawnImpl = spawn } = {}) {
  checkValues([service, account]);
  const failed = await runOnStdin(`delete-generic-password -s "${service}" -a "${account}"`, spawnImpl);
  if (failed && !/could not be found/i.test(failed)) throw new Error("Couldn't remove it from the Keychain.");
}
