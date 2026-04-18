/**
 * Agent audit log — append-only JSONL with size-based rotation.
 *
 * Every gated tool call writes a row. Rows deliberately carry NO argument
 * values and NO response bodies — the agent already saw both, and logging
 * them would create a parallel on-disk copy of the user's email. We store
 * a truncated sha256 hash of the args instead so "same call repeated" is
 * observable without content leakage.
 *
 * File: ~/.mailpouch-agent-audit.jsonl (0600)
 * Rotation: when current file exceeds ROTATE_BYTES, rename to .1.gz and
 *           start fresh. Keep KEEP_GENERATIONS compressed generations.
 */

import { appendFileSync, existsSync, statSync, renameSync, writeFileSync, readFileSync, unlinkSync } from "fs";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import type { AuditRow } from "./types.js";
import { logger } from "../utils/logger.js";

const ROTATE_BYTES = 10 * 1024 * 1024;  // 10 MB per generation
const KEEP_GENERATIONS = 3;

export interface AuditDeps {
  /** Absolute path to the active log file. */
  path: string;
  /** Now() override for deterministic tests. */
  now?: () => number;
}

export class AgentAuditLog {
  private readonly path: string;
  private readonly now: () => number;

  constructor(deps: AuditDeps) {
    this.path = deps.path;
    this.now = deps.now ?? Date.now;
  }

  /** Append a row. Best-effort — logging failures are warned, not thrown. */
  write(row: AuditRow): void {
    try {
      this.rotateIfNeeded();
      appendFileSync(this.path, JSON.stringify(row) + "\n", { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      logger.warn(`AgentAuditLog: append failed for ${this.path}`, "AgentAuditLog", err);
    }
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.path)) return;
    let sizeBytes = 0;
    try { sizeBytes = statSync(this.path).size; } catch { /* swallow */ return; }
    if (sizeBytes < ROTATE_BYTES) return;

    // Age the existing .N.gz files up by one.
    for (let i = KEEP_GENERATIONS - 1; i >= 1; i--) {
      const from = `${this.path}.${i}.gz`;
      const to   = `${this.path}.${i + 1}.gz`;
      if (existsSync(from)) {
        try { renameSync(from, to); } catch (err) { logger.debug(`rotate rename ${from} → ${to} failed`, "AgentAuditLog", err); }
      }
    }
    // Gzip the current file into .1.gz, then truncate the live file.
    try {
      const raw = readFileSync(this.path);
      writeFileSync(`${this.path}.1.gz`, gzipSync(raw), { encoding: undefined, mode: 0o600 });
      writeFileSync(this.path, "", { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      logger.warn(`AgentAuditLog: rotation failed, keeping current file`, "AgentAuditLog", err);
    }
    // Evict generations beyond KEEP_GENERATIONS.
    for (let i = KEEP_GENERATIONS + 1; i < KEEP_GENERATIONS + 5; i++) {
      const p = `${this.path}.${i}.gz`;
      if (existsSync(p)) {
        try { unlinkSync(p); } catch { /* ignore */ }
      }
    }
  }

  /**
   * Read the last `limit` rows. Used by the (forthcoming) Log UI tab.
   * Cheap for typical sizes because the file is append-only JSONL; for
   * very large logs consider tailing with a seek, but we're at most 10 MB
   * so a full load + slice is fine.
   */
  readTail(limit = 200): AuditRow[] {
    if (!existsSync(this.path)) return [];
    try {
      const raw = readFileSync(this.path, "utf-8");
      const lines = raw.split("\n").filter(l => l.length > 0);
      const slice = lines.slice(-limit);
      const rows: AuditRow[] = [];
      for (const line of slice) {
        try { rows.push(JSON.parse(line) as AuditRow); } catch { /* skip malformed */ }
      }
      return rows;
    } catch (err) {
      logger.warn(`AgentAuditLog: readTail failed`, "AgentAuditLog", err);
      return [];
    }
  }
}

/**
 * Truncated sha256 of JSON.stringify(args). Gives us a stable "same args"
 * fingerprint without storing the content. 16 hex chars = 64 bits of
 * collision resistance, plenty for a dedup hint at mailpouch scale.
 */
export function hashArgs(args: unknown): string {
  if (args === undefined || args === null) return "";
  try {
    const s = JSON.stringify(args);
    if (!s) return "";
    return createHash("sha256").update(s, "utf-8").digest("hex").slice(0, 16);
  } catch {
    return "";
  }
}
