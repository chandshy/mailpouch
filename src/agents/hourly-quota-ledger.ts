/**
 * Durable, cross-process reservations for grant-scoped hourly tool caps.
 *
 * This deliberately uses SQLite's `BEGIN IMMEDIATE` write transaction rather
 * than a hand-rolled lock file. Multiple daemon processes may legitimately
 * exist while troubleshooting (`MAILPOUCH_NO_SINGLETON=1`), and an advisory
 * lock that can time out or reclaim based only on age would allow two callers
 * to admit the final quota slot. SQLite serializes the prune/count/insert
 * critical section and recovers locks through its journal protocol after a
 * crashed owner.
 */

import { chmodSync, existsSync, realpathSync, statSync } from "fs";
import { createRequire } from "module";
import { basename, dirname, join, normalize, resolve } from "path";
import { logger } from "../utils/logger.js";
import { MAX_AGENT_TOOL_CALLS_PER_HOUR, isValidAgentToolHourlyCap } from "./grant-conditions.js";

const require = createRequire(import.meta.url);

export const HOUR_MS = 60 * 60 * 1_000;
const SQLITE_BUSY_TIMEOUT_MS = 250;

interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
}

interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  close(): void;
}

type DatabaseConstructor = new (path: string) => SqliteDatabase;

export interface HourlyToolReservation {
  allowed: boolean;
  /** Reservations currently inside the rolling window, including this one when allowed. */
  used: number;
  limit: number;
  /** Present only when the durable ledger could not safely make a decision. */
  failure?: "quota_store_unavailable";
}

interface CountRow {
  count: number | bigint;
}

/**
 * Resolve an existing file, or its deepest existing parent, to a physical
 * identity. This mirrors config/profile path handling: a grants-file symlink
 * must not produce a second quota database, while a first-run file beneath a
 * symlinked parent has one stable identity before and after it is created.
 */
function canonicalizePathOrExistingParent(path: string): string {
  const lexicalPath = resolve(normalize(path));
  let ancestor = lexicalPath;
  const suffix: string[] = [];

  while (true) {
    try {
      return join(realpathSync(ancestor), ...suffix);
    } catch {
      const parent = dirname(ancestor);
      if (parent === ancestor) return lexicalPath;
      suffix.unshift(basename(ancestor));
      ancestor = parent;
    }
  }
}

/** Derive quota state from the physical grants-file identity, not its spelling. */
export function hourlyQuotaPathForGrantPath(grantPath: string): string {
  return `${canonicalizePathOrExistingParent(grantPath)}.quota.sqlite`;
}

/**
 * SQLite-backed hourly reservation ledger. The database contains only opaque
 * client IDs, canonical tool names, and timestamps; no mail data or tokens.
 */
export class HourlyQuotaLedger {
  private db: SqliteDatabase | null = null;
  private deleteExpired: SqliteStatement | null = null;
  private countWindow: SqliteStatement | null = null;
  private insertReservation: SqliteStatement | null = null;

  constructor(private readonly path: string) {}

  /**
   * Atomically reserve one rolling-hour slot. Any failure to open, validate,
   * lock, or transact against the shared ledger denies the call; there is no
   * memory-only or unlocked fallback.
   */
  reserve(clientId: string, canonicalTool: string, limit: number, now: number): HourlyToolReservation {
    if (!isValidAgentToolHourlyCap(limit) || limit > MAX_AGENT_TOOL_CALLS_PER_HOUR || !Number.isSafeInteger(now)) {
      return { allowed: false, used: 0, limit, failure: "quota_store_unavailable" };
    }
    if (limit === 0) return { allowed: false, used: 0, limit };

    let transactionOpen = false;
    try {
      const db = this.getDatabase();
      const windowStart = now - HOUR_MS;
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;

      this.deleteExpired!.run(windowStart);
      const row = this.countWindow!.get(clientId, canonicalTool, windowStart) as CountRow | undefined;
      const used = countFromRow(row);
      if (used === null) throw new Error("Hourly quota ledger returned an invalid count");

      if (used >= limit) {
        // Ensure SQLite's primary/WAL/SHM files remain owner-only even for a
        // read-equivalent exhausted decision made through a write transaction.
        this.enforceOwnerOnlyFiles();
        db.exec("COMMIT");
        transactionOpen = false;
        return { allowed: false, used, limit };
      }

      this.insertReservation!.run(clientId, canonicalTool, now);
      this.enforceOwnerOnlyFiles();
      db.exec("COMMIT");
      transactionOpen = false;
      // A sidecar can appear during COMMIT on some SQLite builds, so verify
      // once more. If it cannot be secured, fail closed for future requests.
      this.enforceOwnerOnlyFiles();
      return { allowed: true, used: used + 1, limit };
    } catch (error) {
      if (transactionOpen) {
        try { this.db?.exec("ROLLBACK"); } catch { /* best effort after a failed transaction */ }
      }
      logger.warn("Agent hourly quota ledger unavailable; denying capped tool call", "AgentQuota", error);
      return { allowed: false, used: 0, limit, failure: "quota_store_unavailable" };
    }
  }

  /** Close the connection without checkpointing or deleting any durable quota state. */
  close(): void {
    const db = this.db;
    this.db = null;
    this.deleteExpired = null;
    this.countWindow = null;
    this.insertReservation = null;
    if (!db) return;
    try { db.close(); } catch (error) {
      logger.debug("Agent hourly quota ledger close failed", "AgentQuota", error);
    }
  }

  private getDatabase(): SqliteDatabase {
    if (this.db) return this.db;

    const Database = require("better-sqlite3") as unknown as DatabaseConstructor;
    let db: SqliteDatabase | null = null;
    try {
      db = new Database(this.path);
      this.enforceOwnerOnlyFiles();

      const journalMode = String(db.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
      if (journalMode !== "wal") throw new Error(`Hourly quota ledger refused WAL mode (got ${journalMode})`);

      db.pragma("synchronous = FULL");
      if (Number(db.pragma("synchronous", { simple: true })) !== 2) {
        throw new Error("Hourly quota ledger refused FULL synchronous mode");
      }

      db.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      if (Number(db.pragma("busy_timeout", { simple: true })) !== SQLITE_BUSY_TIMEOUT_MS) {
        throw new Error("Hourly quota ledger refused configured busy timeout");
      }

      db.exec(`
        CREATE TABLE IF NOT EXISTS hourly_tool_reservations (
          id INTEGER PRIMARY KEY,
          client_id TEXT NOT NULL,
          canonical_tool TEXT NOT NULL,
          reserved_at_ms INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS hourly_tool_reservations_window
          ON hourly_tool_reservations (client_id, canonical_tool, reserved_at_ms);
        CREATE INDEX IF NOT EXISTS hourly_tool_reservations_expiry
          ON hourly_tool_reservations (reserved_at_ms);
      `);
      const quickCheck = String(db.pragma("quick_check", { simple: true })).toLowerCase();
      if (quickCheck !== "ok") throw new Error(`Hourly quota ledger integrity check failed (${quickCheck})`);

      this.enforceOwnerOnlyFiles();
      this.deleteExpired = db.prepare("DELETE FROM hourly_tool_reservations WHERE reserved_at_ms <= ?");
      this.countWindow = db.prepare(
        "SELECT COUNT(*) AS count FROM hourly_tool_reservations WHERE client_id = ? AND canonical_tool = ? AND reserved_at_ms > ?",
      );
      this.insertReservation = db.prepare(
        "INSERT INTO hourly_tool_reservations (client_id, canonical_tool, reserved_at_ms) VALUES (?, ?, ?)",
      );
      this.db = db;
      return db;
    } catch (error) {
      try { db?.close(); } catch { /* preserve the original failure */ }
      throw error;
    }
  }

  /** Tighten the database and every SQLite journal sidecar after creation/use. */
  private enforceOwnerOnlyFiles(): void {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const file = `${this.path}${suffix}`;
      if (!existsSync(file)) continue;
      chmodSync(file, 0o600);
      // Windows does not expose POSIX owner bits. On POSIX, a failed chmod is
      // a security-boundary failure rather than a cosmetic warning.
      if (process.platform !== "win32" && (statSync(file).mode & 0o077) !== 0) {
        throw new Error(`Hourly quota ledger file is not owner-only: ${file}`);
      }
    }
  }
}

function countFromRow(row: CountRow | undefined): number | null {
  if (!row) return null;
  const count = typeof row.count === "bigint" ? Number(row.count) : row.count;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}
