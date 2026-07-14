/**
 * Scoped instance singleton guard (Cluster 2, 2026-05-31 report).
 *
 * Multiple `claude --continue` sessions each spawn a mailpouch MCP, and each
 * one runs its own IMAP IDLE/auth loop against the SAME mailbox. This guard
 * lets the first live instance for a configuration profile hold an exclusive
 * lock file; a later instance exits before opening duplicate connections.
 *
 * Deliberately no automatic stale-lock reclaim:
 *
 *   A observes a dead PID in lock L
 *   B removes L and creates a new live lock at L
 *   A removes L based on its old observation
 *
 * The last step can unlink B's live lock. Filesystems do not provide a
 * portable compare-and-unlink primitive, so a time/PID check followed by
 * unlink is not a safe reclamation protocol. We fail closed on a stale or
 * malformed record and require an operator to remove it after verifying that
 * its owner is gone. Availability is preferable to duplicate mailbox sessions
 * only when the ownership transition itself is atomic and provable.
 */

import { writeFileSync, readFileSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { homeFile } from "./home-path.js";

export type LockOutcome =
  | { status: "acquired"; path: string; reclaimed: false }
  | { status: "held-by-live-instance"; path: string; pid: number }
  | { status: "stale-lock"; path: string; pid: number | null }
  | { status: "unavailable"; path: string };

/**
 * Derive a lock file path for an opaque scope identity. The identity (typically
 * an account username or configuration-profile path) is hashed so the filename
 * never leaks private metadata and stays filesystem-safe. Empty/undefined
 * identity collapses to a stable "default" bucket for unconfigured installs.
 */
export function lockPathForAccount(accountIdentity: string | undefined | null): string {
  const id = (accountIdentity ?? "").trim().toLowerCase() || "default";
  const hash = createHash("sha256").update(id).digest("hex").slice(0, 16);
  // Env override resolved + $HOME-contained by homeFile (CRED-002).
  return homeFile("MAILPOUCH_LOCK_PATH", `.mailpouch-${hash}.lock`);
}

/** True if `pid` is a live process this user can signal. */
function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    // Signal 0 performs error checking without sending a signal.
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    // EPERM means the process exists but is owned by another user — still alive.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

const LOCK_UNAVAILABLE = Symbol("lock-unavailable");

/** Parse only a complete decimal PID; parseInt("123garbage") is unsafe here. */
function readLockPid(path: string): number | null | undefined | typeof LOCK_UNAVAILABLE {
  try {
    const raw = readFileSync(path, "utf8").trim();
    if (!/^[1-9]\d*$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch (error: unknown) {
    // undefined means the file disappeared between O_EXCL and read; caller can
    // safely retry creation. Other read failures are unavailable, rather than
    // being misreported as a malformed owner record.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    return LOCK_UNAVAILABLE;
  }
}

/**
 * Attempt to acquire the singleton lock for a caller-provided scope identity.
 *
 * A stale/malformed record is intentionally returned as `stale-lock`, never
 * deleted automatically. See the module-level race explanation. Unexpected
 * filesystem failures are also fail-closed (`unavailable`) rather than letting
 * a second daemon start with no ownership proof.
 *
 * @param pid the PID to record as the holder (defaults to this process).
 */
export function acquireSingletonLock(
  accountIdentity: string | undefined | null,
  pid: number = process.pid,
): LockOutcome {
  const path = lockPathForAccount(accountIdentity);

  // A holder may release its lock after our O_EXCL attempt reports EEXIST but
  // before we read it. Retrying creation once handles that benign transition;
  // it never deletes an existing pathname.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: "wx", mode: 0o600 });
      return { status: "acquired", path, reclaimed: false };
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return { status: "unavailable", path };
      }
    }

    const holderPid = readLockPid(path);
    if (holderPid === undefined) continue;
    if (holderPid === LOCK_UNAVAILABLE) return { status: "unavailable", path };
    // A repeated call from the current holder is idempotent. There cannot be a
    // different concurrently-live process with the same PID.
    if (holderPid === pid) return { status: "acquired", path, reclaimed: false };
    if (holderPid !== null && isPidAlive(holderPid)) {
      return { status: "held-by-live-instance", path, pid: holderPid };
    }
    return { status: "stale-lock", path, pid: holderPid };
  }

  return { status: "unavailable", path };
}

/**
 * Release a previously-acquired lock. Only removes a record containing our
 * exact decimal PID. Since stale locks are never automatically reclaimed, an
 * old release cannot race a new automatic owner at the same pathname.
 */
export function releaseSingletonLock(path: string, pid: number = process.pid): void {
  try {
    if (readLockPid(path) === pid) unlinkSync(path);
  } catch { /* already gone or unreadable — nothing to do */ }
}
