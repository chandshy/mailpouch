/**
 * Permission Escalation Challenge System
 *
 * Provides a two-channel, human-gated authorization flow for permission
 * escalations.  The key security properties:
 *
 *   1. SEPARATE CHANNELS — the agent requests via MCP (channel A), but
 *      approval can ONLY happen via the browser UI or terminal (channel B).
 *      These channels are physically separate; the agent cannot write to B.
 *
 *   2. HUMAN ACTION REQUIRED — the approval UI requires the human to type
 *      "APPROVE" in a confirmation field before the button enables.  This
 *      prevents accidental clicks and makes intent explicit.
 *
 *   3. CSRF PROTECTION — all approval/denial API calls require an
 *      X-CSRF-Token header whose value is embedded only in the HTML page
 *      (generated fresh at server start).  Raw HTTP clients cannot know it
 *      without first loading and parsing the page.
 *
 *   4. THIRD-DEVICE SUPPORT — starting the settings server with --lan
 *      binds it to the LAN interface so any device on the same network
 *      (phone, tablet) can approve.  That is a physically separate device
 *      from the one the agent runs on.
 *
 *   5. ONE-TIME USE + EXPIRY — each challenge is single-use and expires
 *      after EXPIRY_MS.  Replaying an approval token has no effect.
 *
 *   6. RATE LIMITING — max RATE_LIMIT escalation requests per hour and
 *      MAX_PENDING pending at a time, preventing flooding/confusion.
 *
 *   7. DURABLE AUDIT TRAIL — all events are appended to
 *      ~/.mailpouch.audit.jsonl immediately, before any response is
 *      sent.  The agent cannot erase this log via MCP tools.
 *
 *   8. UPGRADE-ONLY — downgrading a preset (reducing privilege) never
 *      requires a challenge; the agent can reduce its own access freely.
 *      Only transitions to a higher-privilege preset require approval.
 *
 * Shared state between the MCP server and the settings server is maintained
 * via a file (~/.mailpouch.pending.json, mode 0600) rather than IPC,
 * so both processes remain independent.
 *
 * Residual risk (documented):
 *   If the agent has a tool capable of fetching localhost HTTP pages and
 *   parsing their HTML, it could in principle extract the CSRF token and
 *   submit an approval.  The "type APPROVE" requirement and physical-device
 *   approval (--lan) mitigate this.  For maximum assurance, approve from a
 *   separate device or disable the HTTP API and use the terminal TUI only.
 */

import { readFileSync, writeFileSync, existsSync, appendFileSync, renameSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import { buildPermissions } from "../config/loader.js";
import { ALL_TOOLS, type PermissionPreset, type ToolName } from "../config/schema.js";

// ─── Constants ─────────────────────────────────────────────────────────────────

/** How long a challenge is valid before it auto-expires. */
const EXPIRY_MS = 5 * 60 * 1000; // 5 minutes

/** Maximum number of pending (unresolved) escalations at any time. */
const MAX_PENDING = 1;

/** Maximum escalation requests per rolling hour. */
const RATE_LIMIT = 5;

/** Maximum number of escalation records retained in the pending file. */
const MAX_HISTORY = 100;

/** Privilege ordering — higher number = more capable preset. */
const PRESET_LEVEL: Record<PermissionPreset, number> = {
  read_only:  0,
  send_only:  1,
  supervised: 2,
  custom:     2,
  full:       3,
};

// ─── Types ─────────────────────────────────────────────────────────────────────

export interface EscalationRecord {
  /** Random hex ID (128 bits). */
  id: string;
  requestedAt: string;   // ISO-8601
  expiresAt: string;     // ISO-8601
  targetPreset: PermissionPreset;
  currentPreset: PermissionPreset;
  /** Agent-supplied reason, capped at 500 chars. */
  reason: string;
  status: "pending" | "approved" | "denied" | "expired";
  resolvedAt: string | null;
  resolvedBy: "browser_ui" | "terminal_tui" | "timeout" | null;
  /** Tools that will be newly enabled by this escalation (computed at request time). */
  newTools: string[];
  /** Tools whose rate limit will be relaxed (computed at request time). */
  unthrottledTools: string[];
}

export interface AuditEntry {
  time: string;
  event: "requested" | "approved" | "denied" | "expired" | "rate_limited";
  id: string;
  fromPreset: PermissionPreset;
  toPreset: PermissionPreset;
  reason?: string;
  via?: string;
}

interface PendingFile {
  version: number;
  escalations: EscalationRecord[];
}

// ─── File paths ────────────────────────────────────────────────────────────────

export function getPendingFilePath(): string {
  // Env-var priority: MAILPOUCH_* > PM_BRIDGE_MCP_* > PROTONMAIL_*. Legacy
  // names honored through v3.0.
  const envPath = process.env.MAILPOUCH_PENDING
    ?? process.env.PM_BRIDGE_MCP_PENDING
    ?? process.env.PROTONMAIL_MCP_PENDING;
  if (envPath) return envPath;
  // Read-old/write-new: prefer the new path, but if a stale pending record
  // is sitting in a legacy file (and the new one doesn't exist yet), keep
  // honoring it so an in-flight escalation isn't dropped on the floor mid-flow.
  const preferred = join(homedir(), ".mailpouch.pending.json");
  const legacyV2 = join(homedir(), ".pm-bridge-mcp.pending.json");
  const legacyV1 = join(homedir(), ".protonmail-mcp.pending.json");
  if (!existsSync(preferred)) {
    if (existsSync(legacyV2)) return legacyV2;
    if (existsSync(legacyV1)) return legacyV1;
  }
  return preferred;
}

export function getAuditLogPath(): string {
  // Env-var priority: MAILPOUCH_* > PM_BRIDGE_MCP_* > PROTONMAIL_*. Legacy
  // names honored through v3.0.
  const envPath = process.env.MAILPOUCH_AUDIT
    ?? process.env.PM_BRIDGE_MCP_AUDIT
    ?? process.env.PROTONMAIL_MCP_AUDIT;
  if (envPath) return envPath;
  // Read-old/write-new: append to a legacy file when it's the only one
  // present so the audit trail stays continuous across the rename.
  const preferred = join(homedir(), ".mailpouch.audit.jsonl");
  const legacyV2 = join(homedir(), ".pm-bridge-mcp.audit.jsonl");
  const legacyV1 = join(homedir(), ".protonmail-mcp.audit.jsonl");
  if (!existsSync(preferred)) {
    if (existsSync(legacyV2)) return legacyV2;
    if (existsSync(legacyV1)) return legacyV1;
  }
  return preferred;
}

// ─── File I/O ─────────────────────────────────────────────────────────────────

/** Valid status values — used to sanitise records loaded from disk. */
const VALID_STATUSES = new Set(["pending", "approved", "denied", "expired"]);

/** Valid preset names — used to sanitise records loaded from disk. */
const VALID_PRESETS  = new Set(["read_only", "send_only", "supervised", "custom", "full"]);

/**
 * Load and validate the pending escalations file.
 *
 * Malformed or tampered records are dropped rather than trusted.  This
 * prevents a compromised file from injecting unexpected state (e.g. a
 * pre-approved record with a forged status).
 */
function loadPendingFile(): PendingFile {
  const path = getPendingFilePath();
  if (!existsSync(path)) return { version: 1, escalations: [] };
  try {
    const raw  = JSON.parse(readFileSync(path, "utf-8")) as PendingFile;
    if (!Array.isArray(raw.escalations)) return { version: 1, escalations: [] };

    const validated = raw.escalations.filter((e): e is EscalationRecord => {
      if (!e || typeof e !== "object")                               return false;
      if (typeof e.id !== "string" || !/^[0-9a-f]{32}$/.test(e.id)) return false;
      if (!VALID_STATUSES.has(e.status))                             return false;
      if (!VALID_PRESETS.has(e.currentPreset))                       return false;
      if (!VALID_PRESETS.has(e.targetPreset))                        return false;
      if (typeof e.requestedAt !== "string" || isNaN(Date.parse(e.requestedAt))) return false;
      if (typeof e.expiresAt   !== "string" || isNaN(Date.parse(e.expiresAt)))   return false;
      if (typeof e.reason      !== "string")                         return false;
      if (!Array.isArray(e.newTools))        e.newTools        = [];
      if (!Array.isArray(e.unthrottledTools)) e.unthrottledTools = [];
      // Ensure each element is a string that names a known tool — prevents a
      // tampered pending file from injecting arbitrary values (e.g. XSS payloads)
      // that propagate into the settings UI's innerHTML renderer.
      const knownTools = new Set<string>(ALL_TOOLS as readonly string[]);
      e.newTools        = (e.newTools as unknown[]).filter(
        (t): t is string => typeof t === "string" && knownTools.has(t)
      );
      e.unthrottledTools = (e.unthrottledTools as unknown[]).filter(
        (t): t is string => typeof t === "string" && knownTools.has(t)
      );
      return true;
    });

    return { version: raw.version ?? 1, escalations: validated };
  } catch {
    return { version: 1, escalations: [] };
  }
}

/**
 * Atomically write the pending file.
 *
 * Writes to a temporary file beside the destination, then renames it into
 * place.  `rename(2)` is atomic on POSIX; on Windows it is also effectively
 * atomic for small files written to the same volume.  This prevents partial
 * reads by a concurrent process and avoids data loss if the process is killed
 * between open and write.
 *
 * Also trims the escalation history to MAX_HISTORY records (oldest first)
 * so the file never grows without bound.
 */
function savePendingFile(data: PendingFile): void {
  // Keep only the most recent MAX_HISTORY records
  if (data.escalations.length > MAX_HISTORY) {
    data.escalations = data.escalations.slice(-MAX_HISTORY);
  }

  const dest    = getPendingFilePath();
  // Same-filesystem tmp so rename(2) stays atomic even when /tmp is on a
  // different mount (tmpfs) than $HOME.
  const tmp     = `${dest}.${randomBytes(8).toString("hex")}.tmp`;
  const payload = JSON.stringify(data, null, 2);

  writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, dest);
}

function appendAudit(entry: AuditEntry): void {
  try {
    appendFileSync(getAuditLogPath(), JSON.stringify(entry) + "\n", { encoding: "utf-8", mode: 0o600 });
  } catch {
    // Non-fatal — audit failure must not break the primary flow.
  }
}

// ─── Helpers ───────────────────────────────────────────────────────────────────

/** Returns true if `to` grants materially more privilege than `from`. */
export function isUpgrade(from: PermissionPreset, to: PermissionPreset): boolean {
  return PRESET_LEVEL[to] > PRESET_LEVEL[from];
}

/** Compute which tools move from disabled → enabled when switching presets. */
function computeNewTools(from: PermissionPreset, to: PermissionPreset): string[] {
  const fromPerms = buildPermissions(from).tools;
  const toPerms   = buildPermissions(to).tools;
  return (ALL_TOOLS as readonly string[]).filter(tool => {
    const wasDisabled  = fromPerms[tool as ToolName]?.enabled === false;
    const willEnabled  = toPerms[tool as ToolName]?.enabled !== false;
    return wasDisabled && willEnabled;
  });
}

/** Compute which tools have their rate limit relaxed (lowered or removed). */
function computeUnthrottledTools(from: PermissionPreset, to: PermissionPreset): string[] {
  const fromPerms = buildPermissions(from).tools;
  const toPerms   = buildPermissions(to).tools;
  return (ALL_TOOLS as readonly string[]).filter(tool => {
    const wasLimited   = fromPerms[tool as ToolName]?.rateLimit != null;
    const willUnlimited = toPerms[tool as ToolName]?.rateLimit == null;
    return wasLimited && willUnlimited;
  });
}

/** Evict expired pending escalations, writing back if any changed. */
function evictExpired(data: PendingFile): boolean {
  const now = Date.now();
  let changed = false;
  for (const e of data.escalations) {
    if (e.status === "pending" && new Date(e.expiresAt).getTime() < now) {
      e.status     = "expired";
      e.resolvedAt = new Date().toISOString();
      e.resolvedBy = "timeout";
      appendAudit({
        time:       e.resolvedAt,
        event:      "expired",
        id:         e.id,
        fromPreset: e.currentPreset,
        toPreset:   e.targetPreset,
      });
      changed = true;
    }
  }
  return changed;
}

// ─── Public API ────────────────────────────────────────────────────────────────

export type RequestResult =
  | { ok: true;  id: string; expiresAt: string; newTools: string[]; unthrottledTools: string[] }
  | { ok: false; error: string };

/**
 * Create a new escalation challenge.  Returns the challenge ID (which the
 * agent may share with the user so they can locate it in the settings UI).
 * The actual approval secret never leaves the settings UI.
 */
export function requestEscalation(
  targetPreset: PermissionPreset,
  currentPreset: PermissionPreset,
  reason: string,
): RequestResult {
  const data = loadPendingFile();
  if (evictExpired(data)) savePendingFile(data);

  // ── Upgrade check ─────────────────────────────────────────────────────────
  if (!isUpgrade(currentPreset, targetPreset)) {
    return {
      ok:    false,
      error: `'${targetPreset}' is not a higher privilege level than '${currentPreset}'. ` +
             `Downgrading does not require human approval — use the settings UI directly.`,
    };
  }

  // ── Rate limiting ─────────────────────────────────────────────────────────
  const oneHourAgo = Date.now() - 60 * 60 * 1000;
  const recentCount = data.escalations.filter(
    e => new Date(e.requestedAt).getTime() > oneHourAgo
  ).length;
  if (recentCount >= RATE_LIMIT) {
    appendAudit({
      time:       new Date().toISOString(),
      event:      "rate_limited",
      id:         "n/a",
      fromPreset: currentPreset,
      toPreset:   targetPreset,
      reason,
    });
    return {
      ok:    false,
      error: `Rate limit: max ${RATE_LIMIT} escalation requests per hour.`,
    };
  }

  // ── One-pending-at-a-time ──────────────────────────────────────────────────
  const pending = data.escalations.filter(e => e.status === "pending");
  if (pending.length >= MAX_PENDING) {
    const p = pending[0];
    const secsLeft = Math.max(0, Math.round(
      (new Date(p.expiresAt).getTime() - Date.now()) / 1000
    ));
    return {
      ok:    false,
      error: `An escalation is already pending (ID ${p.id}, expires in ${secsLeft}s). ` +
             `Ask the human to approve or deny it in the settings UI first.`,
    };
  }

  // ── Create challenge ───────────────────────────────────────────────────────
  const id         = randomBytes(16).toString("hex");
  const now        = new Date();
  const expiresAt  = new Date(now.getTime() + EXPIRY_MS);
  const newTools         = computeNewTools(currentPreset, targetPreset);
  const unthrottledTools = computeUnthrottledTools(currentPreset, targetPreset);

  const record: EscalationRecord = {
    id,
    requestedAt:      now.toISOString(),
    expiresAt:        expiresAt.toISOString(),
    targetPreset,
    currentPreset,
    reason:           reason.replace(/[\x00-\x1f\x7f]|\x1b\[[0-9;]*[a-zA-Z]/g, "").slice(0, 500),
    status:           "pending",
    resolvedAt:       null,
    resolvedBy:       null,
    newTools,
    unthrottledTools,
  };

  data.escalations.push(record);
  savePendingFile(data);

  appendAudit({
    time:       now.toISOString(),
    event:      "requested",
    id,
    fromPreset: currentPreset,
    toPreset:   targetPreset,
    reason,
  });

  return { ok: true, id, expiresAt: expiresAt.toISOString(), newTools, unthrottledTools };
}

/** Read the current status of an escalation without modifying it. */
export function getEscalationStatus(id: string): EscalationRecord | null {
  const data = loadPendingFile();
  if (evictExpired(data)) savePendingFile(data);
  return data.escalations.find(e => e.id === id) ?? null;
}

/** Return all currently-pending escalations (for display in the settings UI). */
export function getPendingEscalations(): EscalationRecord[] {
  const data = loadPendingFile();
  if (evictExpired(data)) savePendingFile(data);
  return data.escalations.filter(e => e.status === "pending");
}

export type ApproveResult =
  | { ok: true;  targetPreset: PermissionPreset }
  | { ok: false; error: string };

/**
 * Mark an escalation as approved and return the preset to apply.
 * The caller (settings server) is responsible for actually updating the
 * config file — this function only records the decision.
 */
export function approveEscalation(
  id: string,
  via: "browser_ui" | "terminal_tui",
): ApproveResult {
  const data = loadPendingFile();
  if (evictExpired(data)) savePendingFile(data);

  const e = data.escalations.find(r => r.id === id);
  if (!e)                    return { ok: false, error: "Escalation not found."              };
  if (e.status !== "pending") return { ok: false, error: `Escalation is already ${e.status}.` };
  if (Date.now() > new Date(e.expiresAt).getTime()) {
    return { ok: false, error: "Challenge has expired." };
  }

  e.status     = "approved";
  e.resolvedAt = new Date().toISOString();
  e.resolvedBy = via;
  savePendingFile(data);

  appendAudit({
    time:       e.resolvedAt,
    event:      "approved",
    id,
    fromPreset: e.currentPreset,
    toPreset:   e.targetPreset,
    via,
  });

  return { ok: true, targetPreset: e.targetPreset };
}

/** Mark an escalation as denied. */
export function denyEscalation(
  id: string,
  via: "browser_ui" | "terminal_tui",
): { ok: true } | { ok: false; error: string } {
  const data = loadPendingFile();
  if (evictExpired(data)) savePendingFile(data);

  const e = data.escalations.find(r => r.id === id);
  if (!e)                    return { ok: false, error: "Escalation not found."              };
  if (e.status !== "pending") return { ok: false, error: `Escalation is already ${e.status}.` };

  e.status     = "denied";
  e.resolvedAt = new Date().toISOString();
  e.resolvedBy = via;
  savePendingFile(data);

  appendAudit({
    time:       e.resolvedAt,
    event:      "denied",
    id,
    fromPreset: e.currentPreset,
    toPreset:   e.targetPreset,
    via,
  });

  return { ok: true };
}

/** Read the audit log (most recent entries first).
 *
 * Reads only the last `limit` non-empty lines to avoid O(N) memory and parse
 * cost on large log files.  Each line is parsed independently so a single
 * malformed entry does not poison the entire result set.
 */
export function getAuditLog(limit = 50): AuditEntry[] {
  const path = getAuditLogPath();
  if (!existsSync(path)) return [];
  try {
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    // Take only the tail we need before parsing — avoids O(N) JSON.parse.
    const tail = lines.slice(-Math.max(1, limit));
    const entries: AuditEntry[] = [];
    for (const line of tail) {
      try {
        entries.push(JSON.parse(line) as AuditEntry);
      } catch {
        // Skip malformed lines — do not let a corrupted entry block the rest.
      }
    }
    return entries.reverse();
  } catch {
    return [];
  }
}
