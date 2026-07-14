import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

const RUN_TOKEN_RE = /^mpE2E-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const JOURNAL_PREFIX = "bridge-setup-";
const JOURNAL_SUFFIX = ".json";

function isRunToken(value) {
  return typeof value === "string" && RUN_TOKEN_RE.test(value);
}

function expectedCloneName(token) {
  return `.mailpouch-e2e-bridge-${token}.json`;
}

function samePlatformPath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function fsyncDirectory(path) {
  if (process.platform === "win32") return;
  const fd = openSync(path, "r");
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function ensurePrivateDirectory(path) {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error(`Bridge E2E setup-journal root is not a private directory: ${path}`);
  }
  if (process.platform !== "win32") {
    chmodSync(path, 0o700);
    if ((lstatSync(path).mode & 0o777) !== 0o700) {
      throw new Error(`Bridge E2E setup-journal root is not mode 0700: ${path}`);
    }
  }
}

function journalToken(name) {
  if (!name.startsWith(JOURNAL_PREFIX) || !name.endsWith(JOURNAL_SUFFIX)) return undefined;
  const token = name.slice(JOURNAL_PREFIX.length, -JOURNAL_SUFFIX.length);
  if (!isRunToken(token)) {
    throw new Error(`Bridge E2E setup-journal name is malformed: ${name}`);
  }
  return token;
}

function validateRecoveryConfigPath(value, token, recoveryConfigRoot) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Bridge E2E setup journal for ${token} has no recovery-config path`);
  }
  const path = resolve(value);
  if (basename(path) !== expectedCloneName(token)) {
    throw new Error(`Bridge E2E setup journal for ${token} names an inexact recovery clone`);
  }
  if (recoveryConfigRoot !== undefined
    && !samePlatformPath(dirname(path), recoveryConfigRoot)) {
    throw new Error(
      `Bridge E2E setup journal for ${token} points outside its recovery-config root`,
    );
  }
  return path;
}

function parseJournal(path, expectedToken, recoveryConfigRoot) {
  const entry = lstatSync(path);
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw new Error(`Bridge E2E setup journal is not a regular, non-symlink file: ${path}`);
  }
  if (process.platform !== "win32" && (entry.mode & 0o077) !== 0) {
    throw new Error(`Bridge E2E setup journal is not owner-only: ${path}`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Bridge E2E setup journal is unreadable or malformed: ${path}`, {
      cause: error,
    });
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)
    || value.version !== 1 || value.token !== expectedToken
    || typeof value.journalId !== "string"
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.journalId)
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error(`Bridge E2E setup journal has invalid authority fields: ${path}`);
  }
  return Object.freeze({
    version: 1,
    token: expectedToken,
    journalId: value.journalId,
    createdAt: value.createdAt,
    recoveryConfigPath: validateRecoveryConfigPath(
      value.recoveryConfigPath,
      expectedToken,
      recoveryConfigRoot,
    ),
    path,
  });
}

export function bridgeSetupJournalPath(scopeRoot, token) {
  if (!isRunToken(token)) throw new Error(`Invalid Bridge E2E setup-journal token: ${String(token)}`);
  return join(resolve(scopeRoot), `${JOURNAL_PREFIX}${token}${JOURNAL_SUFFIX}`);
}

/**
 * Publish credential-free evidence before the encrypted recovery clone is
 * created. A hard crash can therefore never leave that clone undiscoverable.
 */
export function createBridgeSetupJournal({ scopeRoot, token, recoveryConfigPath }) {
  const root = resolve(scopeRoot);
  ensurePrivateDirectory(root);
  const path = bridgeSetupJournalPath(root, token);
  const record = Object.freeze({
    version: 1,
    token,
    journalId: randomUUID(),
    createdAt: new Date().toISOString(),
    recoveryConfigPath: validateRecoveryConfigPath(recoveryConfigPath, token),
  });
  let fd;
  let created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(fd, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncDirectory(root);
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the primary publication error */ }
    }
    if (created) {
      try {
        unlinkSync(path);
        fsyncDirectory(root);
      } catch {
        // A partial or uncertain journal stays visible and makes preflight fail
        // closed; never hide a clone-publication attempt after an fsync error.
      }
    }
    throw new Error(`Bridge E2E could not publish setup journal at ${path}`, { cause: error });
  }
  return Object.freeze({ ...record, path });
}

/** Enumerate and strictly validate every durable setup attempt in one scope. */
export function listBridgeSetupJournals({ scopeRoot, recoveryConfigRoot }) {
  const root = resolve(scopeRoot);
  let names;
  try {
    names = readdirSync(root);
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw new Error(`Bridge E2E could not inspect setup journals at ${root}`, { cause: error });
  }
  const journals = [];
  for (const name of names.sort()) {
    const token = journalToken(name);
    if (!token) continue;
    journals.push(parseJournal(
      join(root, name),
      token,
      recoveryConfigRoot === undefined ? undefined : resolve(recoveryConfigRoot),
    ));
  }
  return journals;
}

/**
 * Durably retire one exact journal after either (a) its ownership manifest is
 * durable, or (b) its clone was durably removed before any mailbox mutation.
 */
export function retireBridgeSetupJournal({
  scopeRoot,
  token,
  recoveryConfigPath,
  journalId,
  allowMissing = false,
}) {
  const root = resolve(scopeRoot);
  const path = bridgeSetupJournalPath(root, token);
  let record;
  try {
    record = parseJournal(path, token, dirname(resolve(recoveryConfigPath)));
  } catch (error) {
    if (allowMissing && error?.code === "ENOENT") return false;
    // parseJournal wraps JSON failures but lstat's ENOENT remains a reliable
    // absence signal for idempotent terminal cleanup.
    if (allowMissing && error?.cause?.code === "ENOENT") return false;
    throw error;
  }
  if (!samePlatformPath(record.recoveryConfigPath, recoveryConfigPath)) {
    throw new Error(`Bridge E2E refused to retire mismatched setup journal ${path}`);
  }
  if (journalId !== undefined && record.journalId !== journalId) {
    throw new Error(`Bridge E2E refused to retire replaced setup journal ${path}`);
  }
  unlinkSync(path);
  fsyncDirectory(root);
  return true;
}
