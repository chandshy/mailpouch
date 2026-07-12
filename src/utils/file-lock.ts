/**
 * Ownership-aware cross-process lock for synchronous JSON read/modify/write
 * stores (grants, service accounts, and pending escalations).
 *
 * A lock directory contains an owner record with a PID and random token. We
 * reclaim only an owner whose process is conclusively gone; elapsed time is
 * never evidence that a live mutation is stale. Acquisition failure throws so
 * security mutations never proceed unlocked and overwrite a revoke/restrict.
 */

import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { randomBytes } from "crypto";
import { basename, dirname, join, normalize, resolve } from "path";

const SPIN_MS = 15;
const ACQUIRE_TIMEOUT_MS = 1_000;
const OWNER_FILENAME = "owner.json";

interface FileLockOwner {
  version: 1;
  pid: number;
  token: string;
}

interface HeldFileLock {
  directory: string;
  ownerPath: string;
  owner: FileLockOwner;
}

/**
 * Resolve the protected store to one physical filesystem identity.
 *
 * Existing file symlinks must share a lock with their targets. For a store
 * that has not been created yet, resolving its deepest existing parent gives
 * aliases through symlinked directories the same identity from first write.
 */
function canonicalizeTargetOrExistingParent(target: string): string {
  const lexicalTarget = resolve(normalize(target));
  let ancestor = lexicalTarget;
  const suffix: string[] = [];

  while (true) {
    try {
      return join(realpathSync(ancestor), ...suffix);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return lexicalTarget;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

function lockPath(target: string): string {
  return `${canonicalizeTargetOrExistingParent(target)}.lock`;
}

function ownerPath(directory: string): string {
  return join(directory, OWNER_FILENAME);
}

function isOwner(value: unknown): value is FileLockOwner {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<FileLockOwner>;
  return candidate.version === 1
    && typeof candidate.pid === "number"
    && Number.isSafeInteger(candidate.pid)
    && candidate.pid > 0
    && typeof candidate.token === "string"
    && candidate.token.length >= 16;
}

function readOwner(directory: string): FileLockOwner | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(ownerPath(directory), "utf8"));
    return isOwner(parsed) ? parsed : null;
  } catch {
    // An incomplete/corrupt owner may still belong to a paused creator. Leave
    // it in place rather than reclaiming based on age.
    return null;
  }
}

function sameOwner(expected: FileLockOwner, actual: FileLockOwner | null): boolean {
  return actual !== null && expected.pid === actual.pid && expected.token === actual.token;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function createLock(directory: string): HeldFileLock | null {
  try {
    mkdirSync(directory, { mode: 0o700 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }

  const owner: FileLockOwner = {
    version: 1,
    pid: process.pid,
    token: randomBytes(16).toString("hex"),
  };
  const recordPath = ownerPath(directory);
  let fd: number | null = null;
  try {
    fd = openSync(recordPath, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(owner), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    return { directory, ownerPath: recordPath, owner };
  } catch (error) {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* best effort */ }
    }
    try { unlinkSync(recordPath); } catch { /* best effort */ }
    try { rmdirSync(directory); } catch { /* best effort */ }
    throw error;
  }
}

function reclaimDeadOwner(directory: string, abandoned: FileLockOwner): boolean {
  if (isProcessAlive(abandoned.pid)) return false;
  try {
    if (!sameOwner(abandoned, readOwner(directory))) return false;
    if (isProcessAlive(abandoned.pid)) return false;
    unlinkSync(ownerPath(directory));
  } catch {
    return false;
  }
  try {
    rmdirSync(directory);
    return true;
  } catch {
    return false;
  }
}

function tryAcquire(directory: string): HeldFileLock | null {
  const created = createLock(directory);
  if (created) return created;
  const existing = readOwner(directory);
  if (!existing || isProcessAlive(existing.pid)) return null;
  return reclaimDeadOwner(directory, existing) ? createLock(directory) : null;
}

function acquire(directory: string): HeldFileLock {
  // Do not consume wall-clock reads on the uncontended fast path. Callers may
  // use Date.now() as part of the protected TOCTOU decision itself.
  let deadline = 0;
  for (;;) {
    const held = tryAcquire(directory);
    if (held) return held;
    if (deadline === 0) deadline = Date.now() + ACQUIRE_TIMEOUT_MS;
    if (Date.now() >= deadline) {
      throw new Error(`Could not acquire security-store lock: ${directory}`);
    }
    const until = Date.now() + SPIN_MS;
    while (Date.now() < until) { /* synchronous store API */ }
  }
}

function release(held: HeldFileLock): void {
  try {
    if (!sameOwner(held.owner, readOwner(held.directory))) return;
    unlinkSync(held.ownerPath);
    rmdirSync(held.directory);
  } catch {
    // Do not hide the protected operation's result. A failed unlock remains
    // fail-closed and can be reclaimed only after this process exits.
  }
}

export function withFileLock<T>(target: string, fn: () => T): T {
  const held = acquire(lockPath(target));
  try {
    return fn();
  } finally {
    release(held);
  }
}
