#!/usr/bin/env node
/**
 * Persistent, one-item-at-a-time development-improvement loop.
 *
 * The runner owns durable state transitions and validation evidence. Engineers
 * or coding agents still perform the review and implementation work; this
 * command refuses to advance an item without an approved audit input and a
 * validation result that still matches both the item specification and the
 * workspace it tested.
 */

import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import process from "node:process";

const LOOP_DIRECTORY = ".improvement-loop";
const AUDITS_DIRECTORY = "audits";
const SCHEMA_VERSION = 2;
const LEGACY_SCHEMA_VERSION = 1;
const PRIORITIES = ["P0", "P1", "P2", "P3"];
const ITEM_STATUSES = new Set(["queued", "in_progress", "completed", "blocked"]);
const DEFAULT_CHECK_TIMEOUT_MS = 15 * 60 * 1000;
const MAX_CHECK_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const LOCK_INITIALIZATION_GRACE_MS = 10 * 1000;

function now() {
  return new Date().toISOString();
}

function fail(message) {
  throw new Error(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseArguments(argv) {
  const args = [...argv];
  let root = process.cwd();
  if (args[0] === "--root") {
    if (!args[1]) fail("--root requires a directory.");
    root = resolve(args[1]);
    args.splice(0, 2);
  }
  return { root, command: args.shift() ?? "status", args };
}

function paths(root) {
  const directory = join(root, LOOP_DIRECTORY);
  return {
    directory,
    audits: join(directory, AUDITS_DIRECTORY),
    snapshot: join(directory, "snapshot.json"),
    history: join(directory, "history.jsonl"),
    lock: join(directory, "loop.lock"),
    legacyState: join(directory, "state.json"),
    legacyBacklog: join(directory, "backlog.json"),
  };
}

function initialState() {
  return {
    auditGeneration: 0,
    auditRequired: true,
    activeItemId: null,
    lastAudit: null,
    lastValidation: null,
    validationRun: null,
  };
}

function initialSnapshot() {
  return {
    schemaVersion: SCHEMA_VERSION,
    initializedAt: now(),
    historySequence: 0,
    pendingHistoryEvent: null,
    state: initialState(),
    backlog: { items: [] },
  };
}

function writeJsonAtomic(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = openSync(temporary, "wx", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) {
      try { closeSync(descriptor); } catch { /* best effort */ }
    }
    if (existsSync(temporary)) {
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fail(`Could not read ${path}: ${detail}`);
  }
}

function requireDirectory(path, description) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${description} is missing: ${path}. Run \"improve init\" only when creating a new loop.`);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`${description} must be a real directory: ${path}.`);
}

function requireRegularFile(path, description) {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    fail(`${description} is missing: ${path}. Refusing to recreate loop history automatically.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${description} must be a regular file: ${path}.`);
}

function requireLayout(root) {
  const p = paths(root);
  requireDirectory(p.directory, "Improvement-loop directory");
  requireDirectory(p.audits, "Improvement-loop audit directory");
  requireRegularFile(p.snapshot, "Improvement-loop snapshot");
  requireRegularFile(p.history, "Improvement-loop history");
  return p;
}

function ensureInitDirectory(root) {
  const p = paths(root);
  if (!existsSync(p.directory)) mkdirSync(p.directory, { recursive: true, mode: 0o700 });
  requireDirectory(p.directory, "Improvement-loop directory");
  return p;
}

function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error && typeof error === "object" && error.code === "EPERM";
  }
}

function readLockOwner(lockPath) {
  const ownerPath = join(lockPath, "owner.json");
  try {
    const stat = lstatSync(ownerPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const value = JSON.parse(readFileSync(ownerPath, "utf8"));
    if (!value || typeof value !== "object" || !Number.isInteger(value.pid) || typeof value.token !== "string" || !value.token) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function acquireLock(root, { initializing = false } = {}) {
  const p = initializing ? paths(root) : requireLayout(root);
  if (initializing) requireDirectory(p.directory, "Improvement-loop directory");
  const lockPath = p.lock;
  const token = randomUUID();
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      mkdirSync(lockPath, { mode: 0o700 });
      const owner = { pid: process.pid, token, createdAt: now() };
      writeJsonAtomic(join(lockPath, "owner.json"), owner);
      return () => {
        const current = readLockOwner(lockPath);
        if (!current || current.token !== token) return;
        try { rmSync(lockPath, { recursive: true, force: true }); } catch { /* best effort */ }
      };
    } catch (error) {
      if (!(error && typeof error === "object" && error.code === "EEXIST")) throw error;
      let lockStat;
      try {
        lockStat = lstatSync(lockPath);
      } catch {
        continue;
      }
      if (!lockStat.isDirectory() || lockStat.isSymbolicLink()) {
        fail(`Improvement-loop lock is not a real directory: ${lockPath}.`);
      }
      const owner = readLockOwner(lockPath);
      if (owner && isProcessAlive(owner.pid)) {
        fail(`Improvement loop is already running (pid ${owner.pid}).`);
      }
      // A process may have created the directory but not written owner.json.
      // Treat that short window as contended rather than deleting a live lock.
      if (!owner && Date.now() - lockStat.mtimeMs < LOCK_INITIALIZATION_GRACE_MS) {
        fail("Improvement loop lock is being initialized; retry shortly.");
      }
      // Do not automatically reclaim a dead or malformed owner. Two
      // contenders can otherwise race between stale detection and replacement,
      // allowing one to remove the other's newly acquired lock. Failing closed
      // leaves an operator an explicit, auditable recovery decision.
      const detail = owner ? `stale owner pid ${owner.pid}` : "missing or invalid owner metadata";
      fail(`Improvement-loop lock has ${detail}. Confirm no loop process is running, then remove ${lockPath} manually before retrying.`);
    }
  }
  fail("Could not acquire the improvement-loop lock.");
}

function normalizeCheck(value, itemId, index) {
  if (!value || typeof value !== "object") fail(`Item ${itemId} validation[${index}] must be an object.`);
  const check = value;
  if (typeof check.label !== "string" || !check.label.trim()) {
    fail(`Item ${itemId} validation[${index}] needs a label.`);
  }
  if (!Array.isArray(check.command) || check.command.length === 0 || check.command.some(part => typeof part !== "string" || !part || part.includes("\0"))) {
    fail(`Item ${itemId} validation[${index}] needs a non-empty argv command array without NUL bytes.`);
  }
  const timeoutMs = check.timeoutMs === undefined ? DEFAULT_CHECK_TIMEOUT_MS : check.timeoutMs;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_CHECK_TIMEOUT_MS) {
    fail(`Item ${itemId} validation[${index}] timeoutMs must be an integer between 1000 and ${MAX_CHECK_TIMEOUT_MS}.`);
  }
  return { label: check.label.trim(), command: [...check.command], timeoutMs };
}

function normalizeAudit(value, itemId) {
  if (!value || typeof value !== "object") fail(`Item ${itemId} is missing audited command provenance.`);
  if (typeof value.artifact !== "string" || !value.artifact.trim()) fail(`Item ${itemId} audit artifact is invalid.`);
  if (typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/i.test(value.sha256)) fail(`Item ${itemId} audit hash is invalid.`);
  if (value.commandsApproved !== true) fail(`Item ${itemId} validation commands have not been explicitly approved.`);
  return {
    artifact: value.artifact,
    sha256: value.sha256.toLowerCase(),
    commandsApproved: true,
    ...(typeof value.approvedAt === "string" ? { approvedAt: value.approvedAt } : {}),
    ...(value.migrated === true ? { migrated: true } : {}),
  };
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function normalizeItem(value, { mode = "snapshot", audit } = {}) {
  if (!value || typeof value !== "object") fail("Backlog item must be an object.");
  const input = value;
  if (typeof input.id !== "string" || !/^[A-Z][A-Z0-9._-]{2,80}$/.test(input.id)) {
    fail("Backlog item id must use uppercase letters, digits, dots, underscores, or hyphens.");
  }
  if (!PRIORITIES.includes(input.priority ?? "")) fail(`Item ${input.id} has invalid priority.`);
  if (typeof input.title !== "string" || !input.title.trim()) fail(`Item ${input.id} needs a title.`);
  if (typeof input.area !== "string" || !input.area.trim()) fail(`Item ${input.id} needs an area.`);
  if (typeof input.summary !== "string" || !input.summary.trim()) fail(`Item ${input.id} needs a summary.`);
  const status = input.status ?? "queued";
  if (!ITEM_STATUSES.has(status)) fail(`Item ${input.id} has invalid status.`);
  const acceptanceCriteria = input.acceptanceCriteria ?? [];
  if (!Array.isArray(acceptanceCriteria) || acceptanceCriteria.length === 0 || acceptanceCriteria.some(entry => typeof entry !== "string" || !entry.trim())) {
    fail(`Item ${input.id} acceptanceCriteria must be a non-empty array of non-empty strings.`);
  }
  const validation = input.validation ?? [];
  if (!Array.isArray(validation) || validation.length === 0) fail(`Item ${input.id} needs at least one validation command.`);

  if (mode === "import") {
    if (status !== "queued") fail(`Imported item ${input.id} must be queued.`);
    for (const field of ["startedAt", "completedAt", "attempts", "completionSummary", "blockedReason", "audit"]) {
      if (hasOwn(input, field)) fail(`Imported item ${input.id} cannot set lifecycle field ${field}.`);
    }
  }

  const item = {
    id: input.id,
    priority: input.priority,
    title: input.title.trim(),
    area: input.area.trim(),
    ...(typeof input.source === "string" && input.source.trim() ? { source: input.source.trim() } : {}),
    summary: input.summary.trim(),
    acceptanceCriteria: acceptanceCriteria.map(entry => entry.trim()),
    validation: validation.map((check, index) => normalizeCheck(check, input.id, index)),
    status,
    createdAt: typeof input.createdAt === "string" && input.createdAt ? input.createdAt : now(),
    ...(typeof input.startedAt === "string" ? { startedAt: input.startedAt } : {}),
    ...(typeof input.completedAt === "string" ? { completedAt: input.completedAt } : {}),
    ...(typeof input.attempts === "number" && Number.isInteger(input.attempts) && input.attempts >= 0 ? { attempts: input.attempts } : {}),
    ...(typeof input.completionSummary === "string" ? { completionSummary: input.completionSummary } : {}),
    ...(typeof input.blockedReason === "string" ? { blockedReason: input.blockedReason } : {}),
    audit: audit ?? normalizeAudit(input.audit, input.id),
  };

  if (item.status === "queued" && (item.startedAt || item.completedAt || item.completionSummary || item.blockedReason || item.attempts !== undefined)) {
    fail(`Queued item ${item.id} cannot contain lifecycle completion fields.`);
  }
  if (item.status === "in_progress" && (!item.startedAt || item.attempts === undefined || item.completedAt || item.completionSummary || item.blockedReason)) {
    fail(`In-progress item ${item.id} has inconsistent lifecycle fields.`);
  }
  if (item.status === "completed" && (!item.completedAt || !item.completionSummary || item.blockedReason)) {
    fail(`Completed item ${item.id} has inconsistent lifecycle fields.`);
  }
  if (item.status === "blocked" && (!item.blockedReason || item.completedAt || item.completionSummary)) {
    fail(`Blocked item ${item.id} has inconsistent lifecycle fields.`);
  }
  return item;
}

function normalizeLastValidation(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || typeof value.itemId !== "string" || typeof value.itemSpecHash !== "string" || typeof value.workspaceFingerprint !== "string" || typeof value.at !== "string" || typeof value.ok !== "boolean" || !Array.isArray(value.checks)) {
    fail("Improvement-loop lastValidation is invalid.");
  }
  return value;
}

function normalizeValidationRun(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.itemId !== "string" || typeof value.itemSpecHash !== "string" || typeof value.workspaceFingerprint !== "string" || typeof value.startedAt !== "string") {
    fail("Improvement-loop validationRun is invalid.");
  }
  return value;
}

function normalizeAuditRecord(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== "object" || typeof value.at !== "string" || typeof value.summary !== "string" || typeof value.artifact !== "string" || typeof value.sha256 !== "string") {
    fail("Improvement-loop lastAudit is invalid.");
  }
  return value;
}

function validateSnapshot(value) {
  if (!value || typeof value !== "object" || value.schemaVersion !== SCHEMA_VERSION || !value.state || !value.backlog || !Array.isArray(value.backlog.items)) {
    fail("Improvement-loop snapshot has an unsupported or invalid schema.");
  }
  const rawState = value.state;
  if (!Number.isInteger(rawState.auditGeneration) || rawState.auditGeneration < 0 || typeof rawState.auditRequired !== "boolean" || !(typeof rawState.activeItemId === "string" || rawState.activeItemId === null)) {
    fail("Improvement-loop state is invalid.");
  }
  const state = {
    auditGeneration: rawState.auditGeneration,
    auditRequired: rawState.auditRequired,
    activeItemId: rawState.activeItemId,
    lastAudit: normalizeAuditRecord(rawState.lastAudit),
    lastValidation: normalizeLastValidation(rawState.lastValidation),
    validationRun: normalizeValidationRun(rawState.validationRun),
  };
  if (!state.auditRequired && !state.lastAudit) fail("Improvement-loop state requires an audited baseline.");
  const backlog = { items: value.backlog.items.map(item => normalizeItem(item)) };
  const ids = new Set();
  for (const item of backlog.items) {
    if (ids.has(item.id)) fail(`Duplicate backlog item id: ${item.id}`);
    ids.add(item.id);
  }
  const inProgress = backlog.items.filter(item => item.status === "in_progress");
  if (state.activeItemId === null && inProgress.length !== 0) fail("Improvement-loop has an orphaned in-progress item.");
  if (state.activeItemId !== null && (inProgress.length !== 1 || inProgress[0].id !== state.activeItemId)) {
    fail(`state.json names invalid active item ${state.activeItemId}.`);
  }
  if (state.validationRun && (state.activeItemId !== state.validationRun.itemId || !inProgress[0] || itemSpecHash(inProgress[0]) !== state.validationRun.itemSpecHash)) {
    fail("Improvement-loop validation run no longer matches the active item.");
  }
  if (state.lastValidation && state.activeItemId === state.lastValidation.itemId) {
    const active = inProgress[0];
    if (!active || itemSpecHash(active) !== state.lastValidation.itemSpecHash) {
      fail("Improvement-loop last validation no longer matches the active item.");
    }
  }
  if (!Number.isInteger(value.historySequence) || value.historySequence < 0) fail("Improvement-loop history sequence is invalid.");
  if (value.pendingHistoryEvent !== null && (!value.pendingHistoryEvent || typeof value.pendingHistoryEvent !== "object" || !Number.isInteger(value.pendingHistoryEvent.sequence) || !value.pendingHistoryEvent.event || typeof value.pendingHistoryEvent.event !== "object")) {
    fail("Improvement-loop pending history event is invalid.");
  }
  return {
    schemaVersion: SCHEMA_VERSION,
    initializedAt: typeof value.initializedAt === "string" ? value.initializedAt : now(),
    historySequence: value.historySequence,
    pendingHistoryEvent: value.pendingHistoryEvent ?? null,
    state,
    backlog,
  };
}

function loadSnapshot(root) {
  const p = requireLayout(root);
  const snapshot = validateSnapshot(readJson(p.snapshot));
  verifySnapshotArtifacts(root, snapshot);
  return snapshot;
}

function saveSnapshot(root, snapshot) {
  const p = requireLayout(root);
  writeJsonAtomic(p.snapshot, validateSnapshot(snapshot));
}

function historyContainsSequence(historyPath, sequence) {
  const lines = readFileSync(historyPath, "utf8").split("\n").filter(Boolean);
  for (const line of lines) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      fail(`Improvement-loop history is corrupt: ${historyPath}.`);
    }
    if (event && event.sequence === sequence) return true;
  }
  return false;
}

function appendHistory(root, event) {
  const p = requireLayout(root);
  let descriptor;
  try {
    descriptor = openSync(p.history, "a", 0o600);
    writeFileSync(descriptor, `${JSON.stringify(event)}\n`, "utf8");
    fsyncSync(descriptor);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function recoverPendingHistory(root, snapshot) {
  if (!snapshot.pendingHistoryEvent) return snapshot;
  const p = requireLayout(root);
  const pending = snapshot.pendingHistoryEvent;
  if (!historyContainsSequence(p.history, pending.sequence)) appendHistory(root, pending.event);
  snapshot.pendingHistoryEvent = null;
  saveSnapshot(root, snapshot);
  return snapshot;
}

function commit(root, snapshot, event) {
  const sequence = snapshot.historySequence + 1;
  const record = { sequence, at: now(), ...event };
  snapshot.historySequence = sequence;
  snapshot.pendingHistoryEvent = { sequence, event: record };
  saveSnapshot(root, snapshot);
  appendHistory(root, record);
  snapshot.pendingHistoryEvent = null;
  saveSnapshot(root, snapshot);
}

async function mutate(root, operation) {
  requireLayout(root);
  const release = acquireLock(root);
  try {
    const snapshot = recoverPendingHistory(root, loadSnapshot(root));
    return await operation(snapshot);
  } finally {
    release();
  }
}

function priorityRank(priority) {
  return PRIORITIES.indexOf(priority);
}

function nextQueued(backlog) {
  return backlog.items
    .filter(item => item.status === "queued")
    .sort((left, right) => priorityRank(left.priority) - priorityRank(right.priority) || left.createdAt.localeCompare(right.createdAt))[0];
}

function findItem(backlog, id) {
  const item = backlog.items.find(candidate => candidate.id === id);
  if (!item) fail(`Unknown backlog item: ${id}`);
  return item;
}

function itemSpecHash(item) {
  return sha256(JSON.stringify({
    id: item.id,
    priority: item.priority,
    title: item.title,
    area: item.area,
    source: item.source ?? null,
    summary: item.summary,
    acceptanceCriteria: item.acceptanceCriteria,
    validation: item.validation,
    audit: item.audit,
  }));
}

function commandOutput(command, args, root) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: null,
    stdio: ["ignore", "pipe", "ignore"],
    shell: false,
  });
  if (result.error || result.status !== 0) return null;
  return Buffer.from(result.stdout ?? "");
}

function fingerprintListedFiles(root, listed, category) {
  const hash = createHash("sha256");
  for (const relativePath of listed.toString("utf8").split("\0").filter(Boolean).sort()) {
    if (relativePath === LOOP_DIRECTORY || relativePath.startsWith(`${LOOP_DIRECTORY}/`)) continue;
    const absolutePath = resolve(root, relativePath);
    if (relative(root, absolutePath).startsWith("..") || isAbsolute(relative(root, absolutePath))) continue;
    try {
      const stat = lstatSync(absolutePath);
      hash.update(category).update("\0").update(relativePath).update("\0");
      if (stat.isSymbolicLink()) hash.update("link\0").update(readlinkSync(absolutePath));
      else if (stat.isFile()) hash.update("file\0").update(readFileSync(absolutePath));
    } catch {
      hash.update(category).update("\0").update(relativePath).update("\0missing\0");
    }
  }
  return hash.digest("hex");
}

function fallbackWorkspaceFingerprint(root) {
  const hash = createHash("sha256");
  const excluded = new Set([".git", LOOP_DIRECTORY, "node_modules", "dist", "coverage"]);
  function walk(directory, prefix = "") {
    const entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue;
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolutePath, relativePath);
      else if (entry.isSymbolicLink()) hash.update(`L\0${relativePath}\0${readlinkSync(absolutePath)}\0`);
      else if (entry.isFile()) hash.update(`F\0${relativePath}\0`).update(readFileSync(absolutePath));
    }
  }
  walk(root);
  return `tree:${hash.digest("hex")}`;
}

function workspaceFingerprint(root) {
  const tracked = commandOutput("git", ["ls-files", "--cached", "-z"], root);
  if (!tracked) return fallbackWorkspaceFingerprint(root);
  const head = commandOutput("git", ["rev-parse", "--verify", "HEAD"], root) ?? Buffer.from("NO_HEAD");
  const untracked = commandOutput("git", ["ls-files", "--others", "--exclude-standard", "-z"], root) ?? Buffer.alloc(0);
  // Hash current content, not `git diff`, so tracked and untracked source files
  // are both covered while loop bookkeeping remains intentionally excluded.
  const trackedFingerprint = fingerprintListedFiles(root, tracked, "tracked");
  const untrackedFingerprint = fingerprintListedFiles(root, untracked, "untracked");
  return `git:${sha256(Buffer.concat([head, Buffer.from("\0"), Buffer.from(trackedFingerprint), Buffer.from("\0"), Buffer.from(untrackedFingerprint)]))}`;
}

function executable(command) {
  if (process.platform === "win32" && (command === "npm" || command === "npx" || command === "node")) return `${command}.cmd`;
  return command;
}

async function runCheck(check, root) {
  const [command, ...args] = check.command;
  const startedAt = Date.now();
  console.log(`→ ${check.label}: ${check.command.join(" ")} (timeout ${Math.round(check.timeoutMs / 1000)}s)`);
  return new Promise((resolveCheck) => {
    let child;
    let timeout;
    let forceKill;
    let settled = false;
    let timedOut = false;
    const finish = (exitCode, signal = null) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      if (forceKill) clearTimeout(forceKill);
      resolveCheck({ exitCode, signal, timedOut, durationMs: Date.now() - startedAt });
    };
    try {
      child = spawn(executable(command), args, { cwd: root, stdio: "inherit", shell: false });
    } catch (error) {
      console.error(`Could not start ${check.label}: ${error instanceof Error ? error.message : String(error)}`);
      finish(-1);
      return;
    }
    child.once("error", error => {
      console.error(`Could not start ${check.label}: ${error.message}`);
      finish(-1);
    });
    child.once("close", (code, signal) => finish(code ?? -1, signal));
    timeout = setTimeout(() => {
      timedOut = true;
      console.error(`Validation timed out: ${check.label}.`);
      try { child.kill("SIGTERM"); } catch { /* child already exited */ }
      forceKill = setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* child already exited */ }
      }, 5_000);
    }, check.timeoutMs);
  });
}

function parseCommandArguments(args, { positional = [], boolean = [], value = [] } = {}) {
  const result = { positional: [], flags: {} };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (!argument.startsWith("--")) {
      result.positional.push(argument);
      continue;
    }
    if (boolean.includes(argument)) {
      if (result.flags[argument]) fail(`${argument} may only be supplied once.`);
      result.flags[argument] = true;
      continue;
    }
    if (value.includes(argument)) {
      if (hasOwn(result.flags, argument)) fail(`${argument} may only be supplied once.`);
      const supplied = args[index + 1];
      if (!supplied || supplied.startsWith("--") || !supplied.trim()) fail(`${argument} requires a non-empty value.`);
      result.flags[argument] = supplied;
      index += 1;
      continue;
    }
    fail(`Unknown option: ${argument}.`);
  }
  if (result.positional.length < positional[0] || result.positional.length > positional[1]) {
    fail(`Expected ${positional[0] === positional[1] ? positional[0] : `${positional[0]}–${positional[1]}`} positional argument(s).`);
  }
  return result;
}

function resolveAuditArtifact(root, suppliedPath, { initializing = false } = {}) {
  if (typeof suppliedPath !== "string" || !suppliedPath) fail("An audit artifact path is required.");
  const p = initializing ? paths(root) : requireLayout(root);
  if (initializing) {
    requireDirectory(p.directory, "Improvement-loop directory");
    requireDirectory(p.audits, "Improvement-loop audit directory");
  }
  const requested = resolve(root, suppliedPath);
  const auditsRoot = resolve(p.audits);
  const lexical = relative(auditsRoot, requested);
  if (!lexical || lexical.startsWith("..") || isAbsolute(lexical)) {
    fail(`Audit artifact must be inside ${join(LOOP_DIRECTORY, AUDITS_DIRECTORY)}.`);
  }
  let stat;
  try {
    stat = lstatSync(requested);
  } catch {
    fail(`Audit artifact is missing: ${suppliedPath}.`);
  }
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`Audit artifact must be a regular, non-symlink file: ${suppliedPath}.`);
  let physicalAudits;
  let physicalArtifact;
  try {
    physicalAudits = realpathSync(auditsRoot);
    physicalArtifact = realpathSync(requested);
  } catch {
    fail(`Audit artifact could not be resolved safely: ${suppliedPath}.`);
  }
  const physicalRelative = relative(physicalAudits, physicalArtifact);
  if (!physicalRelative || physicalRelative.startsWith("..") || isAbsolute(physicalRelative)) {
    fail(`Audit artifact resolves outside ${join(LOOP_DIRECTORY, AUDITS_DIRECTORY)}.`);
  }
  const raw = readFileSync(requested);
  let payload;
  try {
    payload = JSON.parse(raw.toString("utf8"));
  } catch (error) {
    fail(`Audit artifact must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { path: join(LOOP_DIRECTORY, AUDITS_DIRECTORY, lexical).replaceAll("\\", "/"), sha256: sha256(raw), payload };
}

function verifySnapshotArtifacts(root, snapshot) {
  const records = [];
  if (snapshot.state.lastAudit) records.push({ description: "last audit", ...snapshot.state.lastAudit });
  for (const item of snapshot.backlog.items) records.push({ description: `item ${item.id}`, ...item.audit });
  const checked = new Set();
  for (const record of records) {
    // A one-time v1 migration may not have had an artifact at all. Preserve the
    // explicit marker, but do not pretend an unverifiable legacy string is a
    // normal audit file. When an actual legacy audit file exists it is verified.
    if (record.migrated === true && record.artifact === "legacy-backlog") continue;
    const key = `${record.artifact}:${record.sha256}`;
    if (checked.has(key)) continue;
    const artifact = resolveAuditArtifact(root, record.artifact);
    if (artifact.sha256 !== record.sha256) {
      fail(`Recorded audit artifact for ${record.description} has changed: ${record.artifact}. Import/re-audit it again instead of using stale evidence.`);
    }
    checked.add(key);
  }
}

function migrateLegacySnapshot(root) {
  const p = paths(root);
  const legacyState = readJson(p.legacyState);
  const legacyBacklog = readJson(p.legacyBacklog);
  if (!legacyState || legacyState.schemaVersion !== LEGACY_SCHEMA_VERSION || !legacyBacklog || legacyBacklog.schemaVersion !== LEGACY_SCHEMA_VERSION || !Array.isArray(legacyBacklog.items)) {
    fail("Legacy improvement-loop files have an unsupported schema; recover them manually before initialization.");
  }
  let legacyAudit;
  const auditFiles = readdirSync(p.audits, { withFileTypes: true }).filter(entry => entry.isFile() && entry.name.endsWith(".json")).map(entry => entry.name).sort();
  if (auditFiles.length === 1) {
    legacyAudit = resolveAuditArtifact(root, join(LOOP_DIRECTORY, AUDITS_DIRECTORY, auditFiles[0]), { initializing: true });
  }
  const fallbackHash = sha256(JSON.stringify(legacyBacklog.items));
  const audit = {
    artifact: legacyAudit?.path ?? "legacy-backlog",
    sha256: legacyAudit?.sha256 ?? fallbackHash,
    commandsApproved: true,
    approvedAt: now(),
    migrated: true,
  };
  const snapshot = {
    schemaVersion: SCHEMA_VERSION,
    initializedAt: typeof legacyState.initializedAt === "string" ? legacyState.initializedAt : now(),
    historySequence: 0,
    pendingHistoryEvent: null,
    state: {
      auditGeneration: Number.isInteger(legacyState.auditGeneration) && legacyState.auditGeneration >= 0 ? legacyState.auditGeneration : 0,
      auditRequired: typeof legacyState.auditRequired === "boolean" ? legacyState.auditRequired : true,
      activeItemId: typeof legacyState.activeItemId === "string" ? legacyState.activeItemId : null,
      lastAudit: legacyState.lastAudit && typeof legacyState.lastAudit === "object" ? {
        at: typeof legacyState.lastAudit.at === "string" ? legacyState.lastAudit.at : now(),
        summary: typeof legacyState.lastAudit.summary === "string" ? legacyState.lastAudit.summary : "Legacy audit migrated.",
        artifact: audit.artifact,
        sha256: audit.sha256,
        migrated: true,
      } : null,
      // Deliberately discard old validation evidence: it has no v2 item/spec/workspace fingerprint.
      lastValidation: null,
      validationRun: null,
    },
    backlog: { items: legacyBacklog.items.map(item => normalizeItem(item, { audit })) },
  };
  return validateSnapshot(snapshot);
}

function usage() {
  console.log(`Usage: node scripts/improvement-loop.mjs [--root <repo>] <command>

Commands:
  init                                                   create/migrate durable loop files
  status [--json]                                        print a brief status report
  import <audits/items.json> --approve-commands [--replace]
                                                         import reviewed, trusted audit items
  begin [ITEM-ID]                                        select one queued item
  validate <ITEM-ID>                                     run approved validation argv checks
  complete <ITEM-ID> --summary <text>                    complete only after fresh validation
  block <ITEM-ID> --summary <text>                       record an external/material blocker
  re-audit --audit <audits/report.json> --summary <text> record a hashed fresh audit

Audit artifacts must be regular files under .improvement-loop/audits/. See docs/improvement-loop.md.`);
}

async function commandInit(root, args) {
  parseCommandArguments(args, { positional: [0, 0] });
  const p = ensureInitDirectory(root);
  const release = acquireLock(root, { initializing: true });
  try {
    const canonicalExists = existsSync(p.snapshot);
    if (canonicalExists) {
      requireLayout(root);
      const snapshot = recoverPendingHistory(root, loadSnapshot(root));
      console.log(`.${LOOP_DIRECTORY.replace(/^\./, "")} is already initialized (schema v${snapshot.schemaVersion}).`);
      return;
    }
    const legacyPresent = [p.legacyState, p.legacyBacklog, p.history].map(existsSync);
    if (legacyPresent.some(Boolean) && !legacyPresent.every(Boolean)) {
      fail("Refusing to initialize from partial legacy loop files; recover or remove the incomplete set explicitly.");
    }
    if (existsSync(p.audits)) requireDirectory(p.audits, "Improvement-loop audit directory");
    else mkdirSync(p.audits, { recursive: true, mode: 0o700 });
    if (legacyPresent.every(Boolean)) {
      requireRegularFile(p.legacyState, "Legacy improvement-loop state");
      requireRegularFile(p.legacyBacklog, "Legacy improvement-loop backlog");
      requireRegularFile(p.history, "Improvement-loop history");
      const snapshot = migrateLegacySnapshot(root);
      writeJsonAtomic(p.snapshot, snapshot);
      commit(root, snapshot, { action: "migrated", fromSchemaVersion: LEGACY_SCHEMA_VERSION, legacyValidationDiscarded: true });
      console.log(`Migrated ${LOOP_DIRECTORY}/ to schema v${SCHEMA_VERSION}; active work needs fresh v2 validation.`);
      return;
    }
    if (existsSync(p.history) || existsSync(p.legacyState) || existsSync(p.legacyBacklog)) {
      fail("Refusing to initialize over unrecognized loop files; recover or remove them explicitly.");
    }
    writeFileSync(p.history, "", { encoding: "utf8", mode: 0o600 });
    const snapshot = initialSnapshot();
    writeJsonAtomic(p.snapshot, snapshot);
    commit(root, snapshot, { action: "initialized", root });
    console.log(`Initialized ${LOOP_DIRECTORY}/ (schema v${SCHEMA_VERSION}).`);
  } finally {
    release();
  }
}

async function printStatus(root, json = false) {
  const report = await mutate(root, (snapshot) => {
    const { state, backlog } = snapshot;
    const counts = Object.fromEntries([...ITEM_STATUSES].map(status => [status, backlog.items.filter(item => item.status === status).length]));
    const active = state.activeItemId ? findItem(backlog, state.activeItemId) : undefined;
    const next = nextQueued(backlog);
    return {
      auditGeneration: state.auditGeneration,
      auditRequired: state.auditRequired,
      active: active ? { id: active.id, priority: active.priority, title: active.title } : null,
      next: next ? { id: next.id, priority: next.priority, title: next.title } : null,
      validationInProgress: state.validationRun ? { itemId: state.validationRun.itemId, startedAt: state.validationRun.startedAt } : null,
      counts,
      lastAudit: state.lastAudit,
      lastValidation: state.lastValidation,
    };
  });
  if (json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  console.log("IMPROVEMENT LOOP");
  console.log(`Audit generation: ${report.auditGeneration}${report.auditRequired ? " (re-audit required)" : ""}`);
  console.log(`Backlog: ${report.counts.queued} queued · ${report.counts.in_progress} active · ${report.counts.completed} completed · ${report.counts.blocked} blocked`);
  console.log(report.active ? `Active: ${report.active.id} [${report.active.priority}] — ${report.active.title}` : "Active: none");
  console.log(report.next ? `Next: ${report.next.id} [${report.next.priority}] — ${report.next.title}` : "Next: none");
  if (report.validationInProgress) console.log(`Validation: running for ${report.validationInProgress.itemId} since ${report.validationInProgress.startedAt}`);
  if (report.lastAudit) console.log(`Last audit: ${report.lastAudit.at} — ${report.lastAudit.summary}`);
  if (report.lastValidation) console.log(`Last validation: ${report.lastValidation.itemId} — ${report.lastValidation.ok ? "PASS" : "FAIL"}`);
}

async function commandImport(root, args) {
  const parsed = parseCommandArguments(args, { positional: [1, 1], boolean: ["--replace", "--approve-commands"] });
  if (!parsed.flags["--approve-commands"]) {
    fail("import requires --approve-commands before this runner will execute audit-supplied argv checks.");
  }
  await mutate(root, (snapshot) => {
    const artifact = resolveAuditArtifact(root, parsed.positional[0]);
    const rawItems = Array.isArray(artifact.payload) ? artifact.payload : artifact.payload?.items;
    if (!Array.isArray(rawItems) || rawItems.length === 0) fail("Imported audit JSON must contain a non-empty items array.");
    const audit = { artifact: artifact.path, sha256: artifact.sha256, commandsApproved: true, approvedAt: now() };
    const imported = rawItems.map(item => normalizeItem(item, { mode: "import", audit }));
    const importedIds = new Set();
    for (const item of imported) {
      if (importedIds.has(item.id)) fail(`Imported audit contains duplicate item id: ${item.id}.`);
      importedIds.add(item.id);
    }
    for (const item of imported) {
      const index = snapshot.backlog.items.findIndex(existing => existing.id === item.id);
      if (index < 0) {
        snapshot.backlog.items.push(item);
        continue;
      }
      const existing = snapshot.backlog.items[index];
      if (!parsed.flags["--replace"]) fail(`Item ${item.id} already exists; pass --replace to update a queued item.`);
      if (existing.id === snapshot.state.activeItemId || existing.status !== "queued") {
        fail(`Refusing to replace lifecycle-managed item ${item.id}; create a follow-up item instead.`);
      }
      snapshot.backlog.items[index] = item;
    }
    commit(root, snapshot, { action: "imported", count: imported.length, artifact: artifact.path, sha256: artifact.sha256, commandsApproved: true });
    console.log(`Imported ${imported.length} audited backlog item(s).`);
  });
}

async function commandBegin(root, args) {
  const parsed = parseCommandArguments(args, { positional: [0, 1] });
  await mutate(root, (snapshot) => {
    const { state, backlog } = snapshot;
    if (state.auditRequired) fail("A fresh re-audit is required before starting another improvement.");
    if (state.activeItemId) fail(`Item ${state.activeItemId} is already active.`);
    const requestedId = parsed.positional[0];
    const item = requestedId ? findItem(backlog, requestedId) : nextQueued(backlog);
    if (!item) fail("No queued improvement item is available.");
    if (item.status !== "queued") fail(`Item ${item.id} is ${item.status}, not queued.`);
    item.status = "in_progress";
    item.startedAt = now();
    item.attempts = (item.attempts ?? 0) + 1;
    state.activeItemId = item.id;
    state.lastValidation = null;
    state.validationRun = null;
    commit(root, snapshot, { action: "begun", itemId: item.id, priority: item.priority, title: item.title, itemSpecHash: itemSpecHash(item) });
    console.log(`Started ${item.id} [${item.priority}]: ${item.title}`);
  });
}

async function commandValidate(root, args) {
  const parsed = parseCommandArguments(args, { positional: [1, 1] });
  const id = parsed.positional[0];
  const run = await mutate(root, (snapshot) => {
    const { state, backlog } = snapshot;
    if (state.activeItemId !== id) fail(`Only the active item may be validated (active: ${state.activeItemId ?? "none"}).`);
    if (state.validationRun) fail(`Validation is already running for ${state.validationRun.itemId}.`);
    const item = findItem(backlog, id);
    const itemSpec = itemSpecHash(item);
    const workspace = workspaceFingerprint(root);
    const validationRun = { id: randomUUID(), itemId: id, itemSpecHash: itemSpec, workspaceFingerprint: workspace, startedAt: now() };
    state.lastValidation = null;
    state.validationRun = validationRun;
    commit(root, snapshot, { action: "validation_started", itemId: id, runId: validationRun.id, itemSpecHash: itemSpec, workspaceFingerprint: workspace });
    return { validationRun, checks: item.validation };
  });

  const checks = [];
  let ok = true;
  for (const check of run.checks) {
    const result = await runCheck(check, root);
    checks.push({ label: check.label, command: check.command, timeoutMs: check.timeoutMs, ...result });
    if (result.exitCode !== 0 || result.timedOut) {
      ok = false;
      break;
    }
  }

  const final = await mutate(root, (snapshot) => {
    const { state, backlog } = snapshot;
    const active = state.activeItemId ? findItem(backlog, state.activeItemId) : undefined;
    const stillCurrent = state.activeItemId === id
      && state.validationRun?.id === run.validationRun.id
      && active
      && itemSpecHash(active) === run.validationRun.itemSpecHash;
    if (!stillCurrent) {
      commit(root, snapshot, { action: "validation_discarded", itemId: id, runId: run.validationRun.id, reason: "active item changed or was blocked while checks ran" });
      console.log(`Validation discarded: ${id} changed while checks ran.`);
      return false;
    }
    const finalWorkspace = workspaceFingerprint(root);
    const workspaceMatches = finalWorkspace === run.validationRun.workspaceFingerprint;
    const resultOk = ok && workspaceMatches;
    state.validationRun = null;
    state.lastValidation = {
      itemId: id,
      itemSpecHash: run.validationRun.itemSpecHash,
      workspaceFingerprint: run.validationRun.workspaceFingerprint,
      completedWorkspaceFingerprint: finalWorkspace,
      at: now(),
      ok: resultOk,
      ...(workspaceMatches ? {} : { invalidatedReason: "workspace changed while validation ran" }),
      checks,
    };
    commit(root, snapshot, { action: "validated", itemId: id, runId: run.validationRun.id, ok: resultOk, itemSpecHash: run.validationRun.itemSpecHash, workspaceFingerprint: run.validationRun.workspaceFingerprint, completedWorkspaceFingerprint: finalWorkspace, checks });
    console.log(resultOk ? `Validation PASS: ${id}` : `Validation FAIL: ${id}${workspaceMatches ? "" : " (workspace changed)"}`);
    return resultOk;
  });
  if (!final) process.exitCode = 1;
}

async function commandComplete(root, args) {
  const parsed = parseCommandArguments(args, { positional: [1, 1], value: ["--summary"] });
  if (!parsed.flags["--summary"]) fail("complete requires --summary.");
  const id = parsed.positional[0];
  const summary = parsed.flags["--summary"].trim();
  await mutate(root, (snapshot) => {
    const { state, backlog } = snapshot;
    if (state.activeItemId !== id) fail(`Only the active item can be completed (active: ${state.activeItemId ?? "none"}).`);
    if (state.validationRun) fail(`Item ${id} still has validation in progress.`);
    const item = findItem(backlog, id);
    const spec = itemSpecHash(item);
    const currentWorkspace = workspaceFingerprint(root);
    if (!state.lastValidation || state.lastValidation.itemId !== id || state.lastValidation.ok !== true || state.lastValidation.itemSpecHash !== spec || state.lastValidation.workspaceFingerprint !== currentWorkspace || state.lastValidation.completedWorkspaceFingerprint !== currentWorkspace) {
      fail(`Item ${id} needs a fresh passing validation for its current specification and workspace before completion.`);
    }
    item.status = "completed";
    item.completedAt = now();
    item.completionSummary = summary;
    delete item.blockedReason;
    state.activeItemId = null;
    state.auditRequired = true;
    commit(root, snapshot, { action: "completed", itemId: id, summary, itemSpecHash: spec, workspaceFingerprint: currentWorkspace });
    console.log(`Completed ${id}. A re-audit is now required.`);
  });
}

async function commandBlock(root, args) {
  const parsed = parseCommandArguments(args, { positional: [1, 1], value: ["--summary"] });
  if (!parsed.flags["--summary"]) fail("block requires --summary.");
  const id = parsed.positional[0];
  const summary = parsed.flags["--summary"].trim();
  await mutate(root, (snapshot) => {
    const { state, backlog } = snapshot;
    if (state.activeItemId !== id) fail(`Only the active item can be blocked (active: ${state.activeItemId ?? "none"}).`);
    const item = findItem(backlog, id);
    item.status = "blocked";
    item.blockedReason = summary;
    delete item.completedAt;
    delete item.completionSummary;
    state.activeItemId = null;
    state.validationRun = null;
    state.lastValidation = null;
    state.auditRequired = true;
    commit(root, snapshot, { action: "blocked", itemId: id, summary });
    console.log(`Blocked ${id}. A re-audit is now required.`);
  });
}

async function commandReaudit(root, args) {
  const parsed = parseCommandArguments(args, { positional: [0, 0], value: ["--audit", "--summary"] });
  if (!parsed.flags["--audit"] || !parsed.flags["--summary"]) fail("re-audit requires both --audit and --summary.");
  await mutate(root, (snapshot) => {
    const { state } = snapshot;
    if (state.activeItemId || state.validationRun) fail("A re-audit may only be recorded when no improvement is active.");
    const artifact = resolveAuditArtifact(root, parsed.flags["--audit"]);
    state.auditGeneration += 1;
    state.auditRequired = false;
    state.lastAudit = { at: now(), summary: parsed.flags["--summary"].trim(), artifact: artifact.path, sha256: artifact.sha256 };
    commit(root, snapshot, { action: "re_audited", generation: state.auditGeneration, summary: state.lastAudit.summary, artifact: artifact.path, sha256: artifact.sha256 });
    console.log(`Recorded audit generation ${state.auditGeneration} from ${artifact.path}.`);
  });
}

async function main() {
  const { root, command, args } = parseArguments(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    parseCommandArguments(args, { positional: [0, 0] });
    usage();
    return;
  }
  if (command === "init") return commandInit(root, args);
  if (command === "status") {
    const parsed = parseCommandArguments(args, { positional: [0, 0], boolean: ["--json"] });
    return printStatus(root, Boolean(parsed.flags["--json"]));
  }
  if (command === "import") return commandImport(root, args);
  if (command === "begin") return commandBegin(root, args);
  if (command === "validate") return commandValidate(root, args);
  if (command === "complete") return commandComplete(root, args);
  if (command === "block") return commandBlock(root, args);
  if (command === "re-audit") return commandReaudit(root, args);
  fail(`Unknown command: ${command}`);
}

main().catch(error => {
  console.error(`improvement-loop: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
