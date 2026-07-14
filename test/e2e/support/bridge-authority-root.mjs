import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const AUTHORITY_DIRECTORY = ".mailpouch-e2e-authority";
const AUTHORITY_VERSION = "v2";
export const BRIDGE_RUN_LEASE_FILENAME = "bridge-run.lease.json";

function objectRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function normalizedMailboxHost(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Bridge E2E mailbox identity requires a non-empty IMAP host.");
  }
  let host = value.trim().toLowerCase().replace(/\.$/, "");
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (["localhost", "127.0.0.1", "::1"].includes(host)) return "loopback";
  return host;
}

function normalizedMailboxPort(value) {
  const port = value === undefined ? 1143 : Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Bridge E2E mailbox identity requires a valid IMAP port.");
  }
  return port;
}

function normalizedMailboxUsername(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error("Bridge E2E mailbox identity requires a non-empty username.");
  }
  return value.trim().normalize("NFKC").toLowerCase();
}

/**
 * Derive an opaque, credential-free identity for the active IMAP mailbox.
 * Config aliases and independent config files selecting the same Bridge
 * endpoint/user therefore serialize through one authority scope.
 */
export function bridgeMailboxScopeKeyFromConfig(value) {
  const config = objectRecord(value);
  const connection = objectRecord(config.connection);
  const accounts = Array.isArray(config.accounts)
    ? config.accounts.filter((account) => account !== null && typeof account === "object")
    : [];
  const active = accounts.find((account) => account.id === config.activeAccountId) ?? accounts[0];
  const selected = active ? { ...connection, ...active } : connection;
  const identity = {
    version: 1,
    protocol: "imap",
    host: normalizedMailboxHost(selected.imapHost),
    port: normalizedMailboxPort(selected.imapPort),
    username: normalizedMailboxUsername(selected.username),
  };
  return createHash("sha256")
    .update(`mailpouch-bridge-mailbox\0${JSON.stringify(identity)}`, "utf8")
    .digest("hex");
}

function mailboxScopeKeyFromFile(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Bridge E2E authority could not read mailbox identity from ${path}`, {
      cause: error,
    });
  }
  return bridgeMailboxScopeKeyFromConfig(parsed);
}

function requiredMailboxScopeKey(value) {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("Bridge E2E authority requires a SHA-256 mailbox scope key.");
  }
  return value.toLowerCase();
}

function requiredConfigPath(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(
      "Bridge E2E authority requires MAILPOUCH_E2E_AUTHORITY_CONFIG or " +
      "MAILPOUCH_E2E_BRIDGE_CONFIG to name the source configuration profile.",
    );
  }
  let canonical;
  try {
    canonical = realpathSync.native(resolve(value));
  } catch (error) {
    throw new Error(`Bridge E2E authority could not canonicalize source config ${resolve(value)}`, {
      cause: error,
    });
  }
  const entry = lstatSync(canonical);
  if (!entry.isFile()) {
    throw new Error(`Bridge E2E authority source config is not a regular file: ${canonical}`);
  }
  return process.platform === "win32" ? canonical.toLowerCase() : canonical;
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Bridge E2E authority path is not a private directory: ${path}`);
  }
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
    if ((lstatSync(path).mode & 0o777) !== 0o700) {
      throw new Error(`Bridge E2E authority directory is not mode 0700: ${path}`);
    }
  }
}

/**
 * Resolve the one user-private authority namespace for an active mailbox.
 * The canonical source path is still validated and retained for source/clone
 * separation, while the opaque mailbox key makes independent profiles and
 * worktrees that target the same mailbox converge on one scope.
 */
export function resolveBridgeAuthorityScope(options = {}) {
  const authorityConfigPath = requiredConfigPath(
    options.authorityConfigPath
      ?? process.env.MAILPOUCH_E2E_AUTHORITY_CONFIG
      ?? process.env.MAILPOUCH_E2E_BRIDGE_CONFIG,
  );
  const mailboxScopeKey = requiredMailboxScopeKey(
    options.mailboxScopeKey ?? mailboxScopeKeyFromFile(authorityConfigPath),
  );
  const homeRoot = resolve(options.homeRoot ?? homedir());
  const authorityRoot = join(homeRoot, AUTHORITY_DIRECTORY);
  const baseRoot = join(authorityRoot, AUTHORITY_VERSION);
  const scopeId = createHash("sha256")
    .update(`mailpouch-bridge-authority-v2\0${mailboxScopeKey}`, "utf8")
    .digest("hex");
  const scopeRoot = join(baseRoot, scopeId);
  ensurePrivateDirectory(authorityRoot);
  ensurePrivateDirectory(baseRoot);
  ensurePrivateDirectory(scopeRoot);
  return Object.freeze({
    authorityConfigPath,
    mailboxScopeKey,
    homeRoot,
    baseRoot,
    scopeId,
    scopeRoot,
    leasePath: join(scopeRoot, BRIDGE_RUN_LEASE_FILENAME),
  });
}

function isLeaseOwner(value) {
  return value !== null
    && typeof value === "object"
    && value.version === 1
    && Number.isSafeInteger(value.pid)
    && value.pid > 0
    && typeof value.token === "string"
    && value.token.length >= 16
    && typeof value.createdAt === "string"
    && !Number.isNaN(Date.parse(value.createdAt));
}

function exactToken(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function releaseExactLease(scope, expected) {
  try {
    let actual;
    try { actual = JSON.parse(readFileSync(scope.leasePath, "utf8")); } catch { return; }
    if (!isLeaseOwner(actual)
      || actual.pid !== expected.pid
      || !exactToken(actual.token, expected.token)) return;
    unlinkSync(scope.leasePath);
    fsyncDirectory(scope.scopeRoot);
  } catch {
    // An uncertain release retains the lease. Operators must verify and
    // remove it explicitly; never unlink a record which may belong to a
    // successor or another process.
  }
}

/**
 * Authorize one cleanup process against the profile's live harness lease.
 * No lease means an ordinary post-crash manual cleanup may proceed. A present
 * lease always requires the exact random owner token; supplying a token when
 * its lease disappeared also fails closed rather than becoming a bypass flag.
 */
export function assertBridgeCleanupLeaseAccess(options = {}) {
  const scope = options.scope ?? resolveBridgeAuthorityScope(options);
  let raw;
  try {
    raw = readFileSync(scope.leasePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (options.ownerToken !== undefined && options.ownerToken !== "") {
        throw new Error(
          `Bridge cleanup refused owner-token handoff because its lease is missing at ${scope.leasePath}.`,
        );
      }
      return Object.freeze({ scope, leasePresent: false, delegated: false });
    }
    throw new Error(`Bridge cleanup could not inspect its run lease at ${scope.leasePath}`, {
      cause: error,
    });
  }

  let owner;
  try {
    owner = JSON.parse(raw);
  } catch {
    owner = undefined;
  }
  if (!isLeaseOwner(owner)) {
    throw new Error(
      `Bridge cleanup refused malformed or unreadable run lease at ${scope.leasePath}; ` +
      "verify no Bridge E2E process is running before manual repair.",
    );
  }
  if (!exactToken(owner.token, options.ownerToken)) {
    throw new Error(
      `Bridge cleanup refused while the live harness lease at ${scope.leasePath} records PID ${owner.pid}; ` +
      "the exact owner-token handoff from that harness is required.",
    );
  }
  return Object.freeze({ scope, leasePresent: true, delegated: true, owner });
}

/**
 * Participate in the shared Bridge run lease for the cleanup's full lifetime.
 * A delegated child validates the parent's exact token and never releases the
 * parent's lease. An ordinary manual cleanup atomically creates its own lease,
 * closing the absence-check/start-run race until terminal cleanup finalization.
 */
export function acquireBridgeCleanupLeaseAccess(options = {}) {
  const scope = options.scope ?? resolveBridgeAuthorityScope(options);
  const ownerToken = options.ownerToken;
  if (ownerToken !== undefined && ownerToken !== "") {
    const delegated = assertBridgeCleanupLeaseAccess({ scope, ownerToken });
    return Object.freeze({
      ...delegated,
      release() {},
    });
  }

  const owner = {
    version: 1,
    pid: process.pid,
    token: randomUUID(),
    createdAt: new Date().toISOString(),
  };
  let fd;
  try {
    fd = openSync(scope.leasePath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      // This always throws for an undelegated caller, while preserving the
      // holder diagnostic and malformed-record fail-closed behavior.
      assertBridgeCleanupLeaseAccess({ scope });
    }
    throw new Error(`Bridge cleanup could not create its run lease at ${scope.leasePath}`, {
      cause: error,
    });
  }

  try {
    writeFileSync(fd, `${JSON.stringify(owner)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(scope.scopeRoot);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve primary failure */ }
    }
    releaseExactLease(scope, owner);
    throw new Error(`Bridge cleanup could not persist its run lease at ${scope.leasePath}`, {
      cause: error,
    });
  }

  let released = false;
  return Object.freeze({
    scope,
    leasePresent: true,
    delegated: false,
    owner,
    release() {
      if (released) return;
      released = true;
      releaseExactLease(scope, owner);
    },
  });
}
