import { randomUUID } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { resolveBridgeAuthorityScope } from "./bridge-authority-root.mjs";

const LEASE_FILENAME = "bridge-run.lease.json";

interface BridgeRunLeaseOwner {
  version: 1;
  pid: number;
  token: string;
  createdAt: string;
}

export interface BridgeRunLeaseOptions {
  /** Test-only direct directory override. Production uses the stable profile scope. */
  leaseRoot?: string;
  /** Canonical source profile used to derive the cross-worktree authority scope. */
  authorityConfigPath?: string;
  /** Opaque normalized endpoint/user identity shared by equivalent profiles. */
  mailboxScopeKey?: string;
  /** Test-only user-home override. */
  homeRoot?: string;
  /** Test-only owner PID override. */
  pid?: number;
}

export interface BridgeRunLease {
  readonly path: string;
  readonly pid: number;
  readonly ownerToken: string;
  /** Idempotent; removes the lease only while its exact owner record remains. */
  release(): void;
}

function isOwner(value: unknown): value is BridgeRunLeaseOwner {
  if (!value || typeof value !== "object") return false;
  const owner = value as Partial<BridgeRunLeaseOwner>;
  return owner.version === 1
    && typeof owner.pid === "number"
    && Number.isSafeInteger(owner.pid)
    && owner.pid > 0
    && typeof owner.token === "string"
    && owner.token.length >= 16
    && typeof owner.createdAt === "string"
    && !Number.isNaN(Date.parse(owner.createdAt));
}

function readOwner(path: string): BridgeRunLeaseOwner | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return isOwner(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sameOwner(expected: BridgeRunLeaseOwner, actual: BridgeRunLeaseOwner | undefined): boolean {
  return actual !== undefined
    && actual.pid === expected.pid
    && actual.token === expected.token;
}

function fsyncDirectory(path: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function releaseExact(path: string, owner: BridgeRunLeaseOwner): void {
  try {
    if (!sameOwner(owner, readOwner(path))) return;
    unlinkSync(path);
    fsyncDirectory(dirname(path));
  } catch {
    // A failed or externally-raced release stays fail-closed. The surviving
    // lease must be inspected and removed explicitly by an operator.
  }
}

function holderDescription(path: string): string {
  const owner = readOwner(path);
  if (!owner) return "its owner record is missing, unreadable, or malformed";
  // The random token is the delegated-cleanup authorization capability. It
  // belongs only in the mode-0600 lease and the owning process's memory/env,
  // never in an exception which may be logged by CI or an operator shell.
  return `it records PID ${owner.pid}, created ${owner.createdAt}`;
}

function unavailableError(path: string): Error {
  return new Error(
    `Bridge E2E run lease already exists at ${path}; ${holderDescription(path)}. ` +
    `Automatic age- or PID-based reclaim is disabled. Verify that no Bridge E2E or cleanup process is running, ` +
    `manually remove this exact lease file, then resolve any retained ownership recovery run before retrying. ` +
    `(Recovery tooling cannot acquire its own lease while this file exists, so the stale lease must be removed first.)`,
  );
}

/**
 * Acquire the one cross-process lease for a live Bridge mailbox run.
 *
 * The caller must hold this lease from before retained-run preflight through
 * the final manifest/config commit in close(). A surviving file is never
 * reclaimed automatically, even when its PID appears dead or its age is old.
 */
export function acquireBridgeRunLease(
  options: BridgeRunLeaseOptions = {},
): BridgeRunLease {
  const leaseRoot = resolve(
    options.leaseRoot ?? resolveBridgeAuthorityScope({
      authorityConfigPath: options.authorityConfigPath,
      mailboxScopeKey: options.mailboxScopeKey,
      homeRoot: options.homeRoot,
    }).scopeRoot,
  );
  mkdirSync(leaseRoot, { recursive: true, mode: 0o700 });
  const path = join(leaseRoot, LEASE_FILENAME);
  const pid = options.pid ?? process.pid;
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error(`Bridge E2E run lease requires a positive integer PID; received ${String(pid)}.`);
  }
  const owner: BridgeRunLeaseOwner = {
    version: 1,
    pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };

  let fd: number;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw unavailableError(path);
    throw new Error(`Bridge E2E could not create its run lease at ${path}`, { cause: error });
  }

  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
  } catch (error) {
    // The exclusive creator still owns this pathname. Publish no usable lease
    // when its complete owner record could not be made durable.
    try { closeSync(fd); } catch { /* retain the primary error */ }
    releaseExact(path, owner);
    throw new Error(`Bridge E2E could not persist its run lease at ${path}`, { cause: error });
  }
  try {
    closeSync(fd);
    // Persist the exclusive directory entry as well as the owner payload.
    fsyncDirectory(leaseRoot);
  } catch (error) {
    releaseExact(path, owner);
    throw new Error(`Bridge E2E could not finalize its run lease at ${path}`, { cause: error });
  }

  let released = false;
  return Object.freeze({
    path,
    pid: owner.pid,
    ownerToken: owner.token,
    release(): void {
      if (released) return;
      released = true;
      releaseExact(path, owner);
    },
  });
}
