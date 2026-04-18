/**
 * Local SQLite FTS5 index for decrypted Proton Mail messages.
 *
 * Proton's E2EE means Google-style server-side semantic search is impossible.
 * The workaround is to build the index locally from Bridge-decrypted bodies.
 * FTS5 gives us BM25-ranked keyword search with snippet highlighting, which
 * is good-enough for most day-to-day "find the email about X" queries.
 *
 * `better-sqlite3` is an *optional* dependency — pm-bridge-mcp must still
 * load and serve mail tools when it isn't available. Call openFtsIndex() to
 * get a live instance; it throws FtsUnavailableError when the native
 * binding is missing, and callers return a structured error to the tool
 * dispatcher pointing the user at the install command.
 */

import { createRequire } from "module";
import { statSync } from "fs";
import { logger } from "../utils/logger.js";

const require = createRequire(import.meta.url);

export class FtsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FtsUnavailableError";
  }
}

export interface FtsRecord {
  /** Stable cross-folder identifier — prefer the Proton X-Pm-Internal-Id header, else IMAP UID. */
  id: string;
  subject: string;
  from: string;
  to: string;
  folder: string;
  body: string;
  /** Seconds since Unix epoch for the message date. */
  dateEpoch: number;
}

export interface FtsHit extends FtsRecord {
  /** BM25 rank — lower is better. */
  score: number;
  /** FTS5-generated snippet with matches highlighted in [[...]]. */
  snippet: string;
}

export interface FtsSearchOptions {
  query: string;
  limit?: number;
  folder?: string;
  /** Unix-epoch seconds: messages older than this are excluded. */
  sinceEpoch?: number;
}

export interface FtsStats {
  messageCount: number;
  dbPath: string;
  databaseBytes: number;
}

// Narrow the slice of better-sqlite3 we consume so this file's types stay
// resolvable even when the native package isn't installed.
interface SqliteStatement {
  run(...params: unknown[]): { changes: number };
  all(...params: unknown[]): unknown[];
  get(...params: unknown[]): unknown;
}
interface SqliteDatabase {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  transaction<F extends (...args: never[]) => unknown>(fn: F): F;
  close(): void;
  pragma(s: string): unknown;
}
type DatabaseConstructor = new (path: string) => SqliteDatabase;

export class FtsIndexService {
  private readonly db: SqliteDatabase;
  private readonly dbPath: string;
  private readonly stmts: {
    upsert: SqliteStatement;
    remove: SqliteStatement;
    searchAll: SqliteStatement;
    searchFolder: SqliteStatement;
    count: SqliteStatement;
  };

  constructor(db: SqliteDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
        id UNINDEXED,
        subject,
        "from",
        "to",
        folder UNINDEXED,
        body,
        date_epoch UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    this.stmts = {
      upsert: this.db.prepare(
        `INSERT INTO messages (id, subject, "from", "to", folder, body, date_epoch)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ),
      remove: this.db.prepare(`DELETE FROM messages WHERE id = ?`),
      searchAll: this.db.prepare(
        `SELECT id, subject, "from", "to", folder, body, date_epoch,
                bm25(messages) AS score,
                snippet(messages, 5, '[[', ']]', '…', 12) AS snippet
           FROM messages
          WHERE messages MATCH ?
          ORDER BY score
          LIMIT ?`,
      ),
      searchFolder: this.db.prepare(
        `SELECT id, subject, "from", "to", folder, body, date_epoch,
                bm25(messages) AS score,
                snippet(messages, 5, '[[', ']]', '…', 12) AS snippet
           FROM messages
          WHERE messages MATCH ? AND folder = ?
          ORDER BY score
          LIMIT ?`,
      ),
      count: this.db.prepare(`SELECT COUNT(*) AS n FROM messages`),
    };
  }

  /** Insert or replace a record. Single-row path; see upsertMany for bulk. */
  upsert(record: FtsRecord): void {
    this.stmts.remove.run(record.id);
    this.stmts.upsert.run(
      record.id,
      record.subject ?? "",
      record.from ?? "",
      record.to ?? "",
      record.folder ?? "",
      record.body ?? "",
      record.dateEpoch ?? 0,
    );
  }

  /** Bulk upsert wrapped in a single transaction. */
  upsertMany(records: FtsRecord[]): number {
    if (records.length === 0) return 0;
    // better-sqlite3's transaction() preserves the argument signature of the
    // inner fn, so we can write it concretely without any casts.
    const tx = this.db.transaction((batch: FtsRecord[]) => {
      for (const r of batch) this.upsert(r);
      return batch.length;
    });
    return tx(records);
  }

  remove(id: string): boolean {
    const res = this.stmts.remove.run(id);
    return res.changes > 0;
  }

  search(opts: FtsSearchOptions): FtsHit[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
    const folder = opts.folder?.trim();
    const hits = folder
      ? (this.stmts.searchFolder.all(opts.query, folder, limit) as unknown[])
      : (this.stmts.searchAll.all(opts.query, limit) as unknown[]);
    const rows = hits as Array<Record<string, unknown>>;
    let mapped: FtsHit[] = rows.map(r => ({
      id: String(r.id ?? ""),
      subject: String(r.subject ?? ""),
      from: String(r.from ?? ""),
      to: String(r.to ?? ""),
      folder: String(r.folder ?? ""),
      body: String(r.body ?? ""),
      dateEpoch: typeof r.date_epoch === "number" ? r.date_epoch : Number(r.date_epoch ?? 0),
      score: typeof r.score === "number" ? r.score : Number(r.score ?? 0),
      snippet: String(r.snippet ?? ""),
    }));
    if (typeof opts.sinceEpoch === "number") {
      mapped = mapped.filter(h => h.dateEpoch >= (opts.sinceEpoch ?? 0));
    }
    return mapped;
  }

  stats(): FtsStats {
    const row = this.stmts.count.get() as { n?: number } | undefined;
    const n = typeof row?.n === "number" ? row.n : 0;
    let sizeBytes = 0;
    try {
      sizeBytes = statSync(this.dbPath).size;
    } catch { /* ignore — stats best-effort */ }
    return { messageCount: n, dbPath: this.dbPath, databaseBytes: sizeBytes };
  }

  /** Delete everything from the index. Follow with upsertMany() to rebuild. */
  clear(): void {
    this.db.exec(`DELETE FROM messages`);
  }

  close(): void {
    try { this.db.close(); } catch (err) {
      logger.debug("FtsIndexService: close failed (non-fatal)", "FtsIndexService", err);
    }
  }
}

/**
 * Build an FtsIndexService. Resolves better-sqlite3 lazily so importing this
 * module does not crash when the optional dep is missing. Throws
 * FtsUnavailableError with an install hint when the native binding cannot
 * be loaded.
 */
export function openFtsIndex(dbPath: string): FtsIndexService {
  let Database: DatabaseConstructor;
  try {
    Database = require("better-sqlite3") as unknown as DatabaseConstructor;
  } catch (err) {
    throw new FtsUnavailableError(
      "FTS index requires 'better-sqlite3' (optional dependency). Install with " +
      "`npm install better-sqlite3` in the pm-bridge-mcp directory. " +
      `Underlying error: ${(err as Error).message}`,
    );
  }
  try {
    const db = new Database(dbPath);
    return new FtsIndexService(db, dbPath);
  } catch (err) {
    throw new FtsUnavailableError(
      `Could not open FTS index at ${dbPath}: ${(err as Error).message}`,
    );
  }
}
