import { randomBytes, timingSafeEqual } from "node:crypto";
import { writeFileSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, basename } from "node:path";
import { getConfigPath } from "../config/loader.js";

/**
 * Proof-of-identity for the "is a mailpouch settings UI already on this port?"
 * probe in src/index.ts.
 *
 * The probe used to accept any local listener that answered `GET /api/status`
 * with a boolean `hasConfig` field — a shape trivial to forge. Whoever binds
 * the settings port first therefore became the URL that mailpouch advertises
 * to the tray and to agents, which is where a user is asked to type their
 * Bridge password.
 *
 * The asymmetry a fix can stand on: any local user can bind 127.0.0.1, but the
 * config file is 0o600. So the real UI publishes a random nonce *beside the
 * config, at the same 0o600*, and echoes it on /api/status. A listener that
 * cannot read the file cannot produce the nonce.
 *
 * ponytail: this does NOT defend against an attacker already running as the
 * config's owner — such an attacker can read the nonce, and has the config and
 * keyring anyway. The threat it closes is the different-local-user / sandboxed-
 * process case. Upgrade path if that stops being enough: a peer-credential
 * check on the socket (SO_PEERCRED / LOCAL_PEERCRED), which is unixy and does
 * not port cleanly to Windows.
 */

/**
 * Sits beside the config it belongs to, so a profile selected via
 * MAILPOUCH_CONFIG gets its own identity instead of sharing one.
 * Exported for the tests, which must not restate the naming rule.
 */
export function instancePath(): string {
  const cfg = getConfigPath();
  return join(dirname(cfg), `${basename(cfg)}.settings-instance`);
}

/**
 * The nonce this process is currently serving, if any. The /api/status route
 * is built long before the bind happens, so it reads through this rather than
 * closing over a value that does not exist yet.
 */
let _current: string | null = null;

/** Publish a fresh nonce for this process's settings server. Best-effort. */
export function publishInstanceId(): string | null {
  try {
    const id = randomBytes(32).toString("hex");
    writeFileSync(instancePath(), id, { mode: 0o600, encoding: "utf-8" });
    _current = id;
    return id;
  } catch {
    // A settings UI that cannot publish its identity still serves; it just
    // won't be reused by another mailpouch's probe. Failing closed is right.
    _current = null;
    return null;
  }
}

/** The nonce to echo on /api/status, or null if this instance has none. */
export function currentInstanceId(): string | null {
  return _current;
}

/** Remove this instance's nonce on shutdown so it cannot be replayed. */
export function clearInstanceId(): void {
  _current = null;
  try { rmSync(instancePath(), { force: true }); } catch { /* nothing to undo */ }
}

/**
 * Does `candidate` match the nonce currently on disk? Constant-time.
 * False whenever the file is missing, unreadable, or the wrong shape — the
 * caller then binds its own server, which is the safe default.
 */
export function instanceIdMatches(candidate: unknown): boolean {
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  let expected: string;
  try {
    expected = readFileSync(instancePath(), "utf-8").trim();
  } catch {
    return false;
  }
  if (expected.length === 0 || candidate.length !== expected.length) return false;
  try {
    return timingSafeEqual(Buffer.from(candidate, "utf-8"), Buffer.from(expected, "utf-8"));
  } catch {
    return false;
  }
}
