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
import type { EmailMessage } from "../types/index.js";

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

/**
 * Raised when a caller tries to use an index that has not been bound to an
 * account identity, or whose durable owner marker was changed by another
 * process.  FTS rows contain decrypted mail, so failing closed is essential.
 */
export class FtsOwnershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FtsOwnershipError";
  }
}

export interface FtsRecord {
  /** Identifier returned to callers; normal email records use the mailbox-local IMAP UID. */
  id: string;
  /**
   * Internal durable row identity. Generic IMAP UIDs are unique only inside a
   * folder, so callers that index them must provide a folder-qualified key.
   * Omitted for compatibility with direct callers whose `id` is already
   * globally unique.
   */
  storageKey?: string;
  subject: string;
  from: string;
  to: string;
  folder: string;
  body: string;
  /** Seconds since Unix epoch for the message date. */
  dateEpoch: number;
}

/**
 * Build an unambiguous FTS row key for an email.
 *
 * Proton's internal ID survives folder moves and is globally stable. Plain
 * IMAP accounts only expose UIDs, which may repeat in every mailbox, so their
 * row key must include the folder. Keep this separate from `FtsRecord.id`:
 * search results must still return the UID callers use with the IMAP tools.
 */
export function ftsStorageKeyForEmail(email: {
  id: string;
  folder?: string;
  protonId?: string;
}): string {
  if (email.protonId) return `proton:${encodeURIComponent(email.protonId)}`;
  return `imap:${encodeURIComponent(email.folder ?? "INBOX")}:${encodeURIComponent(email.id)}`;
}

/**
 * Convert an email into an FTS record while keeping the result ID compatible
 * with `get_email_by_id`: it is always the mailbox-local IMAP UID. Proton's
 * internal ID is used only for the private storage key, where it can dedupe a
 * moved message without leaking an unusable ID through FTS search results.
 */
export function ftsRecordFromEmail(
  email: Pick<EmailMessage, "id" | "protonId" | "subject" | "from" | "to" | "folder" | "date">,
  body: string,
): FtsRecord {
  return {
    id: email.id,
    storageKey: ftsStorageKeyForEmail(email),
    subject: email.subject ?? "",
    from: email.from ?? "",
    to: (email.to ?? []).join(", "),
    folder: email.folder ?? "",
    body,
    dateEpoch: Math.floor((email.date?.getTime?.() ?? 0) / 1000),
  };
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
  /** Identity this process successfully bound through ensureOwnerIdentity(). */
  private boundOwnerIdentity: string | undefined;
  /** One-way fuse: a stale instance must never reclaim or reuse the index. */
  private ownerInvalidated = false;
  private readonly stmts: {
    upsert: SqliteStatement;
    removeByStorageKey: SqliteStatement;
    removeById: SqliteStatement;
    searchAll: SqliteStatement;
    searchFolder: SqliteStatement;
    count: SqliteStatement;
  };

  // Increment when the stored row format changes so old raw-UID rows cannot
  // collide with the new folder-qualified generic-IMAP keys.
  static readonly BODY_FORMAT_VERSION = 3;

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
        storage_key UNINDEXED,
        tokenize='porter unicode61'
      );
    `);
    this.stmts = {
      upsert: this.db.prepare(
        `INSERT INTO messages (id, subject, "from", "to", folder, body, date_epoch, storage_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      removeByStorageKey: this.db.prepare(`DELETE FROM messages WHERE storage_key = ?`),
      // The public remove() API historically accepted the ID surfaced by
      // search. Retain that contract even when multiple folders have a given
      // generic IMAP UID; upsert uses the private storage-key statement.
      removeById: this.db.prepare(`DELETE FROM messages WHERE id = ?`),
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

  /** Read the durable owner marker inside the caller's SQLite transaction. */
  private readOwnerMarker(): string | undefined {
    const row = this.db.prepare(`SELECT value FROM _meta WHERE key = 'owner_identity'`).get() as { value?: unknown } | undefined;
    return typeof row?.value === "string" ? row.value : undefined;
  }

  /**
   * Execute a transaction explicitly rather than using better-sqlite3's
   * default deferred helper. Owner transitions need BEGIN IMMEDIATE so another
   * process cannot observe or interleave the clear/marker write half-way
   * through the operation.
   */
  private transaction<T>(mode: "read" | "write", operation: () => T): T {
    let active = false;
    try {
      this.db.exec(mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN");
      active = true;
      const result = operation();
      this.db.exec("COMMIT");
      active = false;
      return result;
    } catch (err) {
      if (active) {
        try { this.db.exec("ROLLBACK"); } catch { /* original error wins */ }
      }
      throw err;
    }
  }

  private staleOwnershipError(): FtsOwnershipError {
    return new FtsOwnershipError(
      "This FTS index instance is stale because its mailbox owner changed; open a new account-owned index.",
    );
  }

  /**
   * Check the in-memory binding against the durable marker while a transaction
   * is open. Once this detects a mismatch, the instance is permanently
   * invalidated: it cannot reclaim the marker or access decrypted rows later.
   */
  private assertCurrentOwner(): void {
    if (this.ownerInvalidated) throw this.staleOwnershipError();
    if (!this.boundOwnerIdentity) {
      throw new FtsOwnershipError("FTS index must be bound with ensureOwnerIdentity() before use.");
    }
    if (this.readOwnerMarker() !== this.boundOwnerIdentity) {
      this.ownerInvalidated = true;
      throw this.staleOwnershipError();
    }
  }

  private withCurrentOwnerRead<T>(operation: () => T): T {
    if (this.ownerInvalidated) throw this.staleOwnershipError();
    return this.transaction("read", () => {
      this.assertCurrentOwner();
      return operation();
    });
  }

  private withCurrentOwnerWrite<T>(operation: () => T): T {
    if (this.ownerInvalidated) throw this.staleOwnershipError();
    return this.transaction("write", () => {
      this.assertCurrentOwner();
      return operation();
    });
  }

  private upsertUnsafe(record: FtsRecord): void {
    const storageKey = record.storageKey ?? record.id;
    this.stmts.removeByStorageKey.run(storageKey);
    this.stmts.upsert.run(
      record.id,
      record.subject ?? "",
      record.from ?? "",
      record.to ?? "",
      record.folder ?? "",
      record.body ?? "",
      record.dateEpoch ?? 0,
      storageKey,
    );
  }

  /** Insert or replace a record. Single-row path; see upsertMany for bulk. */
  upsert(record: FtsRecord): void {
    this.withCurrentOwnerWrite(() => this.upsertUnsafe(record));
  }

  /** Bulk upsert wrapped in a single transaction. */
  upsertMany(records: FtsRecord[]): number {
    return this.withCurrentOwnerWrite(() => {
      for (const record of records) this.upsertUnsafe(record);
      return records.length;
    });
  }

  remove(id: string): boolean {
    return this.withCurrentOwnerWrite(() => this.stmts.removeById.run(id).changes > 0);
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
    return this.withCurrentOwnerWrite(() => {
      this.db.exec(`DELETE FROM messages`);
      for (const record of records) this.upsertUnsafe(record);
      return records.length;
    });
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

  private searchUnsafe(opts: FtsSearchOptions): FtsHit[] {
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

  search(opts: FtsSearchOptions): FtsHit[] {
    return this.withCurrentOwnerRead(() => this.searchUnsafe(opts));
  }

  stats(): FtsStats {
    return this.withCurrentOwnerRead(() => {
      const row = this.stmts.count.get() as { n?: number } | undefined;
      const n = typeof row?.n === "number" ? row.n : 0;
      let sizeBytes = 0;
      try {
        sizeBytes = statSync(this.dbPath).size;
      } catch { /* ignore — stats best-effort */ }
      return { messageCount: n, dbPath: this.dbPath, databaseBytes: sizeBytes };
    });
  }

  /**
   * Bind this on-disk index to an opaque mailbox identity.
   *
   * Account IDs are editable labels: retaining an index when the same ID is
   * repointed to a different mailbox would expose the former mailbox through
   * search.  The owner marker is intentionally checked on every acquisition
   * so a process restart cannot bypass the in-memory reset path.
   *
   * Returns true when the index had to be cleared.
   */
  ensureOwnerIdentity(identity: string): boolean {
    const requestedIdentity = typeof identity === "string" ? identity.trim() : "";
    if (!requestedIdentity) throw new Error("FTS owner identity is required");
    if (this.ownerInvalidated) throw this.staleOwnershipError();

    const changed = this.transaction("write", () => {
      const storedIdentity = this.readOwnerMarker();
      // A service that was previously bound must not win a later race by
      // clearing a successor's database and writing its old marker back.
      if (this.boundOwnerIdentity !== undefined && storedIdentity !== this.boundOwnerIdentity) {
        this.ownerInvalidated = true;
        throw this.staleOwnershipError();
      }
      if (storedIdentity === requestedIdentity) {
        return false;
      }

      this.clearUnsafe();
      this.db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('owner_identity', ?)`).run(requestedIdentity);
      return true;
    });

    // Do not publish the in-memory binding until COMMIT has succeeded. If the
    // filesystem rejects the transaction, retaining the prior binding makes a
    // later operation re-check the durable marker instead of trusting a state
    // that never reached disk.
    this.boundOwnerIdentity = requestedIdentity;

    logger.info(
      changed
        ? "FTS owner identity changed; cleared account index"
        : "FTS index owner identity verified",
      "FtsIndexService",
    );
    return changed;
  }

  /** Delete everything from the index. Follow with upsertMany() to rebuild. */
  clear(): void {
    this.withCurrentOwnerWrite(() => this.clearUnsafe());
  }

  private clearUnsafe(): void {
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
    // Tighten the main db immediately, so it is never briefly world-readable.
    chmodFtsFiles(dbPath);
    // The constructor enables `journal_mode = WAL`, and THAT is what creates
    // the -wal/-shm sidecars. Chmod'ing only before this point left them at
    // the umask default (0644 observed) forever, because chmodFtsFiles skips
    // files that do not exist yet — and -wal holds live page data, i.e. the
    // decrypted mail in the index. Re-run it once the sidecars exist.
    const service = new FtsIndexService(db, dbPath);
    chmodFtsFiles(dbPath);
    return service;
  } catch (err) {
    throw new FtsUnavailableError(
      `Could not open FTS index at ${dbPath}: ${(err as Error).message}`,
    );
  }
}
