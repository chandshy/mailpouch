/**
 * Local SQLite FTS5 index for decrypted Proton Mail messages.
 *
 * Proton's E2EE means Google-style server-side semantic search is impossible.
 * The workaround is to build the index locally from Bridge-decrypted bodies.
 * FTS5 gives us BM25-ranked keyword search with snippet highlighting, which
 * is good-enough for most day-to-day "find the email about X" queries.
 *
 * `better-sqlite3` is an *optional* dependency — mailpouch must still
 * load and serve mail tools when it isn't available. Call openFtsIndex() to
 * get a live instance; it throws FtsUnavailableError when the native
 * binding is missing, and callers return a structured error to the tool
 * dispatcher pointing the user at the install command.
 */

import { createRequire } from "module";
import { statSync, chmodSync, existsSync } from "fs";
import { logger } from "../utils/logger.js";

/** Tighten the FTS DB to 0600. The index contains decrypted email bodies,
 *  subjects, and senders — must be owner-readable only. better-sqlite3 opens
 *  files with the default umask (typically 0644 on Linux), so we chmod
 *  every primary + sidecar file after open. */
function chmodFtsFiles(dbPath: string): void {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const p = dbPath + suffix;
    if (!existsSync(p)) continue;
    try {
      const st = statSync(p);
      if ((st.mode & 0o077) !== 0) chmodSync(p, 0o600);
    } catch { /* best-effort */ }
  }
}

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
  /**
   * Restrict hits to this set of folders. Independent of `folder` (which
   * narrows to a single folder by name). When supplied:
   *  - `undefined` → no restriction (existing behavior).
   *  - non-empty `string[]` → results limited via `folder IN (?, ?, ...)`,
   *    bound parameters to keep SQL injection impossible.
   *  - empty `[]` → zero hits returned (the caller's grant restricts to no
   *    folders, so by construction it sees nothing).
   *
   * Used by the MCP tool surface to enforce per-agent folder allowlists on
   * snippet content. Direct/internal callers can omit it.
   */
  allowedFolders?: string[];
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

  // Increment when the body format changes so stale HTML/raw indexes auto-clear.
  static readonly BODY_FORMAT_VERSION = 2;

  constructor(db: SqliteDatabase, dbPath: string) {
    this.db = db;
    this.dbPath = dbPath;
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS _meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)`);
    const row = this.db.prepare(`SELECT value FROM _meta WHERE key = 'body_format_version'`).get() as { value: string } | undefined;
    const storedVersion = row ? parseInt(row.value, 10) : 0;
    if (storedVersion !== FtsIndexService.BODY_FORMAT_VERSION) {
      logger.info(`FTS body format changed (${storedVersion} → ${FtsIndexService.BODY_FORMAT_VERSION}), clearing index`, "FtsIndexService");
      this.db.exec(`DROP TABLE IF EXISTS messages`);
      this.db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('body_format_version', ?)`).run(String(FtsIndexService.BODY_FORMAT_VERSION));
    }
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
      // `date_epoch >= ?` lives in the WHERE so the date floor is applied BEFORE
      // the LIMIT (a post-LIMIT filter under-returns). Binding 0 when no
      // sinceEpoch is supplied matches everything (epochs are non-negative).
      searchAll: this.db.prepare(
        `SELECT id, subject, "from", "to", folder, body, date_epoch,
                bm25(messages) AS score,
                snippet(messages, 5, '[[', ']]', '…', 12) AS snippet
           FROM messages
          WHERE messages MATCH ? AND date_epoch >= ?
          ORDER BY score
          LIMIT ?`,
      ),
      searchFolder: this.db.prepare(
        `SELECT id, subject, "from", "to", folder, body, date_epoch,
                bm25(messages) AS score,
                snippet(messages, 5, '[[', ']]', '…', 12) AS snippet
           FROM messages
          WHERE messages MATCH ? AND folder = ? AND date_epoch >= ?
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

  /**
   * Atomically clear the index and repopulate it from `records`. The clear and
   * the bulk upsert run inside a single transaction, so a throw mid-rebuild
   * (e.g. a malformed record) rolls the whole thing back and leaves the prior
   * index intact rather than wiping it. Returns the number of records indexed.
   *
   * Callers must prefer this over a bare clear()+upsertMany() pair: a separate
   * clear() commits immediately and a subsequent failure leaves an empty index
   * (PARSE-003, audit-2026-05-28).
   */
  rebuild(records: FtsRecord[]): number {
    const tx = this.db.transaction((batch: FtsRecord[]) => {
      this.db.exec(`DELETE FROM messages`);
      for (const r of batch) this.upsert(r);
      return batch.length;
    });
    return tx(records);
  }

  /**
   * Run a prepared FTS query, translating an FTS5 query-DSL syntax error into a
   * clean empty result instead of letting better-sqlite3's SqliteError escape
   * to the MCP client. The MATCH operand is a user-supplied query in FTS5's own
   * mini-language (quotes, NEAR(), column filters, etc.); a stray `"` or `(`
   * raises `fts5: syntax error near "..."`. SQL injection is already impossible
   * (the operand is a bound parameter) — this only swallows malformed-DSL
   * throws (PARSE-001, audit-2026-05-28). Any other error is re-thrown.
   */
  private runMatch(stmt: SqliteStatement, params: unknown[]): unknown[] {
    try {
      return stmt.all(...params) as unknown[];
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      if (/fts5: syntax error|malformed MATCH|unterminated string/i.test(msg)) {
        logger.debug(`FTS query syntax rejected: ${msg}`, "FtsIndexService");
        return [];
      }
      throw err;
    }
  }

  search(opts: FtsSearchOptions): FtsHit[] {
    const limit = Math.min(Math.max(1, opts.limit ?? 20), 200);
    const folder = opts.folder?.trim();
    // Date floor pushed into every query's WHERE (not a post-LIMIT filter, which
    // would under-return). 0 = no floor (epochs are non-negative).
    const sinceFloor = typeof opts.sinceEpoch === "number" ? opts.sinceEpoch : 0;
    // Folder allowlist short-circuit: an explicit empty array means "the
    // caller has no folder grants" — return zero hits without touching SQL.
    if (Array.isArray(opts.allowedFolders) && opts.allowedFolders.length === 0) {
      return [];
    }
    let hits: unknown[];
    if (opts.allowedFolders && opts.allowedFolders.length > 0) {
      // Build `folder IN (?, ?, …)` with bound parameters so folder names
      // cannot inject SQL even if a malicious grant slipped through.
      // better-sqlite3 prepares per call here; the IN-clause arity is
      // grant-dependent and not amenable to the cached prepared-statement
      // path. n is small (typically <10 folders per grant).
      //
      // COLLATE NOCASE mirrors the case-insensitive folder matching in
      // `GrantManager.checkFolderCondition` (src/agents/grant-manager.ts:
      // toLowerCase compare). Without this, a grant that lists `inbox`
      // would pass the tool-side gate but return zero hits against an
      // index of `INBOX` — silently dropping the agent's reads. Same
      // collation applied to the optional `folder` arg.
      const placeholders = opts.allowedFolders.map(() => "?").join(", ");
      const single = folder ? " AND folder = ? COLLATE NOCASE" : "";
      const sql =
        `SELECT id, subject, "from", "to", folder, body, date_epoch,
                bm25(messages) AS score,
                snippet(messages, 5, '[[', ']]', '…', 12) AS snippet
           FROM messages
          WHERE messages MATCH ? AND folder COLLATE NOCASE IN (${placeholders})${single} AND date_epoch >= ?
          ORDER BY score
          LIMIT ?`;
      const stmt = this.db.prepare(sql);
      const params: unknown[] = [opts.query, ...opts.allowedFolders];
      if (folder) params.push(folder);
      params.push(sinceFloor);
      params.push(limit);
      hits = this.runMatch(stmt, params);
    } else {
      hits = folder
        ? this.runMatch(this.stmts.searchFolder, [opts.query, folder, sinceFloor, limit])
        : this.runMatch(this.stmts.searchAll, [opts.query, sinceFloor, limit]);
    }
    const rows = hits as Array<Record<string, unknown>>;
    const mapped: FtsHit[] = rows.map(r => ({
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
    // sinceEpoch now applied in SQL WHERE (before LIMIT) — no post-filter.
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
 * Build an FtsIndexService. Throws FtsUnavailableError when the database
 * file cannot be opened (disk full, permissions, corruption).
 */
export function openFtsIndex(dbPath: string): FtsIndexService {
  const Database = require("better-sqlite3") as unknown as DatabaseConstructor;
  try {
    const db = new Database(dbPath);
    chmodFtsFiles(dbPath);
    return new FtsIndexService(db, dbPath);
  } catch (err) {
    throw new FtsUnavailableError(
      `Could not open FTS index at ${dbPath}: ${(err as Error).message}`,
    );
  }
}
