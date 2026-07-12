/**
 * No-reply reminder service.
 *
 * Persists reminders keyed to an already-sent email and fires them when a
 * user-chosen deadline elapses. A follow-up PR will add automatic
 * reply-detection via IMAP header search; for v1 the agent composes that
 * check itself by calling search_emails with the stored Message-ID.
 *
 * Storage is a single JSON file written atomically via tmp → rename, with
 * mode 0600 to match the rest of the project's credential-hygiene story.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, chmodSync } from "fs";
import { randomBytes } from "crypto";
import { logger } from "../utils/logger.js";

export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  /** Short random ID, not persistent across manual edits. */
  id: string;
  /** Stable ID of the mailbox that owns this reply-tracking record. */
  accountId: string;
  /**
   * Opaque mailbox/transport fingerprint captured when this reminder was
   * created. It blocks an account ID that is later repointed at a different
   * mailbox from reading, cancelling, or firing the old reminder.
   */
  accountIdentity?: string;
  /** RFC 2822 Message-ID of the message the user sent and wants a reply to. */
  messageId: string;
  /** IMAP UID of the original message (for quick re-lookup). */
  imapUid?: string;
  /** Recipient that ought to reply. */
  recipient: string;
  /** Original subject (stored so the reminder payload is human-readable). */
  subject: string;
  /** ISO-8601 timestamp the original message was sent. */
  sentAt: string;
  /** ISO-8601 timestamp when this reminder should fire. */
  fireAt: string;
  status: ReminderStatus;
  /** Optional free-text reminder-why, shown with the notification. */
  note?: string;
}

/** A pre-account record is retained only long enough for an explicit migration. */
type StoredReminder = Omit<Reminder, "accountId" | "accountIdentity"> & {
  accountId?: string;
  accountIdentity?: string;
};

interface ReminderFile {
  version: 1 | 2;
  reminders: StoredReminder[];
}

/** Account source used to attach a durable owner to legacy reminder records. */
export interface ReminderAccountOptions {
  activeAccountId?: string | (() => string | undefined);
  /** Resolve the current opaque mailbox identity for an account ID. */
  resolveAccountIdentity?: (accountId: string) => string | undefined;
}

/** Result of assigning pre-account reminder records to the active mailbox. */
export interface LegacyReminderMigrationResult {
  migrated: number;
  /** Immutable copy of the pre-migration file, when one existed. */
  backupPath?: string;
}

/** Result of removing unsafe reminders after an account is removed or repointed. */
export interface ReminderQuarantineResult {
  accountId: string;
  reason: string;
  quarantined: number;
  removed: number;
  backupPath?: string;
}

const LEGACY_DEFAULT_ACCOUNT_ID = "primary";
const VALID_REMINDER_STATUSES = new Set<ReminderStatus>(["pending", "fired", "cancelled"]);

function normalizeAccountId(accountId: unknown): string | undefined {
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function normalizeAccountIdentity(accountIdentity: unknown): string | undefined {
  return typeof accountIdentity === "string" && accountIdentity.trim()
    ? accountIdentity.trim()
    : undefined;
}

function hasAccountOwner(reminder: StoredReminder): reminder is Reminder {
  return !!normalizeAccountId(reminder.accountId);
}

function isValidReminder(value: unknown): value is StoredReminder {
  if (!value || typeof value !== "object") return false;
  const reminder = value as Record<string, unknown>;
  if (typeof reminder.id !== "string" || !reminder.id) return false;
  if (typeof reminder.messageId !== "string" || typeof reminder.recipient !== "string") return false;
  if (typeof reminder.subject !== "string") return false;
  if (typeof reminder.sentAt !== "string" || Number.isNaN(Date.parse(reminder.sentAt))) return false;
  if (typeof reminder.fireAt !== "string" || Number.isNaN(Date.parse(reminder.fireAt))) return false;
  if (typeof reminder.status !== "string" || !VALID_REMINDER_STATUSES.has(reminder.status as ReminderStatus)) return false;
  if (Object.prototype.hasOwnProperty.call(reminder, "accountId")) {
    const accountId = normalizeAccountId(reminder.accountId);
    if (!accountId || accountId !== reminder.accountId) return false;
  }
  if (Object.prototype.hasOwnProperty.call(reminder, "accountIdentity")) {
    const accountIdentity = normalizeAccountIdentity(reminder.accountIdentity);
    if (!accountIdentity || accountIdentity !== reminder.accountIdentity) return false;
  }
  return true;
}

export class ReminderService {
  private readonly path: string;
  private reminders: StoredReminder[] = [];
  private activeAccountIdSource: (() => string | undefined) | undefined;
  private accountIdentityResolver: ((accountId: string) => string | undefined) | undefined;

  constructor(path: string, options: ReminderAccountOptions = {}) {
    this.path = path;
    this.configureAccountRouting(options);
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) {
      this.reminders = [];
      return;
    }
    try {
      const raw = readFileSync(this.path, "utf-8");
      const parsed = JSON.parse(raw) as Partial<ReminderFile>;
      const candidate = Array.isArray(parsed.reminders) ? parsed.reminders : [];
      this.reminders = candidate.filter(isValidReminder);
      const skipped = candidate.length - this.reminders.length;
      if (skipped > 0) {
        logger.warn(`ReminderService: skipped ${skipped} malformed reminder record(s)`, "ReminderService");
      }
    } catch (err) {
      logger.warn(`ReminderService: failed to parse ${this.path}, starting empty`, "ReminderService", err);
      this.reminders = [];
    }
    // Keep direct loads safe too: migrate only records with a resolver-backed
    // owner, then remove any persisted fingerprint that no longer matches.
    this.migrateLegacyRecordsForActiveAccount();
    this.quarantineStaleIdentityRecords();
  }

  private persist(): void {
    const payload: ReminderFile = { version: 2, reminders: this.reminders };
    // SMTP-005: write the tmp file alongside the destination, not in tmpdir().
    // rename(2) is only atomic within a single filesystem; a tmpfs /tmp →
    // ext4 $HOME rename throws EXDEV on containerised / NFS-home installs.
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
    try { chmodSync(this.path, 0o600); } catch { /* ignore on Windows */ }
  }

  /**
   * SMTP-006: persist the current in-memory state, rolling it back to the
   * supplied snapshot if the write fails. Without this, a failed persist()
   * (EXDEV, ENOSPC, EACCES) leaves `this.reminders` advanced past disk; a
   * later successful persist() would then silently flush the half-baked
   * mutation — e.g. a "fired" reminder the caller never received getting
   * written as "fired", breaking check_reminders' at-least-once guarantee.
   *
   * SMTP-007: scanDue() routes its fire-transition through here, so the
   * "fired" flip is committed to disk before the method returns or rolled
   * back atomically with the in-memory state. The at-least-once limitation
   * (a dropped MCP response after a successful persist) remains by design
   * pending a dedicated acknowledge tool — see the SMTP-007 audit note.
   *
   * @param snapshot Deep copy of `this.reminders` taken BEFORE the mutation.
   * @throws Re-throws the underlying persist error after rolling back so the
   *         caller (and the MCP tool layer) sees the failure.
   */
  private persistOrRollback(snapshot: StoredReminder[]): void {
    try {
      this.persist();
    } catch (err) {
      this.reminders = snapshot;
      logger.error(
        `ReminderService: persist failed — rolled back in-memory state to last durable snapshot`,
        "ReminderService",
        err,
      );
      throw err;
    }
  }

  /** Deep-clone the current reminders for use as a rollback snapshot. */
  private snapshot(): StoredReminder[] {
    return this.reminders.map(r => ({ ...r }));
  }

  /**
   * Configure the active-account source after account startup. The migration
   * is idempotent, so callers may invoke this after every registry rebuild.
   */
  configureAccountRouting(options: ReminderAccountOptions): void;
  configureAccountRouting(
    activeAccountId: ReminderAccountOptions["activeAccountId"],
    resolveAccountIdentity?: ReminderAccountOptions["resolveAccountIdentity"],
  ): void;
  configureAccountRouting(
    optionsOrActiveAccountId: ReminderAccountOptions | ReminderAccountOptions["activeAccountId"],
    suppliedIdentityResolver?: ReminderAccountOptions["resolveAccountIdentity"],
  ): void {
    const options: ReminderAccountOptions =
      typeof optionsOrActiveAccountId === "object" && optionsOrActiveAccountId !== null
        ? optionsOrActiveAccountId
        : { activeAccountId: optionsOrActiveAccountId, resolveAccountIdentity: suppliedIdentityResolver };
    if (options.activeAccountId !== undefined) {
      const source = options.activeAccountId;
      this.activeAccountIdSource = typeof source === "function"
        ? source
        : () => source;
    }
    if (options.resolveAccountIdentity !== undefined) {
      this.accountIdentityResolver = options.resolveAccountIdentity;
    }
    this.migrateLegacyRecordsForActiveAccount();
    this.quarantineStaleIdentityRecords();
  }

  /** Replace the mailbox-identity resolver and safely repair legacy records. */
  setAccountIdentityResolver(resolveAccountIdentity: (accountId: string) => string | undefined): void {
    this.accountIdentityResolver = resolveAccountIdentity;
    this.migrateLegacyRecordsForActiveAccount();
    this.quarantineStaleIdentityRecords();
  }

  /**
   * Safely repair records written before mailbox identity fingerprints were
   * persisted. Existing owners are resolved by their own ID; only unowned
   * rows use the supplied active account. Rows with no resolvable identity
   * remain inert rather than being guessed into another mailbox.
   */
  migrateLegacyRecords(activeAccountId: string): LegacyReminderMigrationResult {
    const owner = normalizeAccountId(activeAccountId);
    if (!owner) throw new Error("activeAccountId must be a non-empty string");

    const migratedReminders = this.reminders.map(reminder => {
      const existingOwner = normalizeAccountId(reminder.accountId);
      const recordOwner = existingOwner ?? owner;
      const existingIdentity = normalizeAccountIdentity(reminder.accountIdentity);
      if (existingOwner && existingIdentity) return reminder;

      const accountIdentity = this.resolveCurrentAccountIdentity(recordOwner);
      if (!accountIdentity) return reminder;
      return {
        ...reminder,
        accountId: recordOwner,
        accountIdentity,
      };
    });
    const migrated = migratedReminders.reduce(
      (count, reminder, index) => count + (reminder !== this.reminders[index] ? 1 : 0),
      0,
    );
    if (migrated === 0) {
      this.quarantineStaleIdentityRecords();
      return { migrated: 0 };
    }

    const snapshot = this.snapshot();
    let backupPath: string | undefined;
    try {
      // Preserve raw source bytes for recovery/audit rather than a parsed
      // projection that might omit malformed rows.
      backupPath = this.writeBackup(this.rawStoreSnapshot(snapshot), "legacy-unowned");
      this.reminders = migratedReminders;
      this.persist();
    } catch (err) {
      this.reminders = snapshot;
      logger.error("ReminderService: legacy migration failed; store left unchanged", "ReminderService", err);
      throw err;
    }

    logger.info(`ReminderService: migrated ${migrated} legacy reminder(s) to mailbox identities`, "ReminderService", {
      accountId: owner,
      backupPath,
    });
    this.quarantineStaleIdentityRecords();
    return { migrated, backupPath };
  }

  /**
   * Remove a mailbox's persisted reminders after its account ID has been
   * removed or repointed. The original bytes are retained in a 0600 audit
   * backup so an operator can inspect the quarantined state.
   */
  quarantineAccount(accountId: string, reason: string): ReminderQuarantineResult {
    const owner = normalizeAccountId(accountId);
    if (!owner) throw new Error("accountId must be a non-empty string");
    const auditReason = typeof reason === "string" ? reason.trim() : "";
    if (!auditReason) throw new Error("reason must be a non-empty string");

    const affected = this.reminders.filter(reminder => reminder.accountId === owner);
    if (affected.length === 0) {
      return { accountId: owner, reason: auditReason, quarantined: 0, removed: 0 };
    }

    const snapshot = this.snapshot();
    const next = this.reminders.filter(reminder => reminder.accountId !== owner);
    let backupPath: string | undefined;
    try {
      backupPath = this.writeBackup(this.rawStoreSnapshot(snapshot), "quarantine");
      // Retain the safe in-memory removal if the atomic write fails. A future
      // retry can repair disk; reintroducing unsafe reminders cannot.
      this.reminders = next;
      this.persist();
    } catch (err) {
      this.reminders = next;
      logger.error("ReminderService: durable quarantine failed; safe in-memory quarantine retained", "ReminderService", err);
      throw err;
    }

    logger.warn("ReminderService: quarantined account-owned reminders", "ReminderService", {
      accountId: owner,
      reason: auditReason,
      quarantined: affected.length,
      backupPath,
    });
    return {
      accountId: owner,
      reason: auditReason,
      quarantined: affected.length,
      removed: affected.length,
      backupPath,
    };
  }

  /**
   * Create a reminder. Returns the persisted record.
   * @param args.afterDays  Days from sentAt to the deadline. Minimum 1, maximum 365.
   */
  add(args: {
    /** Account owner supplied by the MCP dispatcher; never exposed as reminder content. */
    accountId?: string;
    /** Opaque mailbox identity supplied by the MCP dispatcher. */
    accountIdentity?: string;
    messageId: string;
    imapUid?: string;
    recipient: string;
    subject: string;
    sentAt: Date;
    afterDays: number;
    note?: string;
  }): Reminder {
    if (!args.messageId) throw new Error("messageId is required");
    if (!args.recipient) throw new Error("recipient is required");
    const clampedDays = Math.min(Math.max(Math.trunc(args.afterDays), 1), 365);
    const fireAtMs = args.sentAt.getTime() + clampedDays * 24 * 60 * 60 * 1000;
    const owner = this.resolveOwnerForNewRecord(args.accountId);
    const record: Reminder = {
      id: `r-${randomBytes(5).toString("hex")}`,
      accountId: owner,
      accountIdentity: this.resolveIdentityForNewRecord(owner, args.accountIdentity),
      messageId: args.messageId,
      imapUid: args.imapUid,
      recipient: args.recipient,
      subject: args.subject,
      sentAt: args.sentAt.toISOString(),
      fireAt: new Date(fireAtMs).toISOString(),
      status: "pending",
      note: args.note,
    };
    const snapshot = this.snapshot();
    this.reminders.push(record);
    this.persistOrRollback(snapshot);
    return record;
  }

  /** Return pending reminders sorted by earliest fireAt. */
  listPending(accountId?: string): Reminder[] {
    const scope = this.resolveAccountScope(accountId);
    return this.reminders
      .filter(r => r.status === "pending" && this.isInScope(r, scope))
      .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt)) as Reminder[];
  }

  /** Return every reminder, regardless of status. */
  listAll(accountId?: string): Reminder[] {
    const scope = this.resolveAccountScope(accountId);
    return this.reminders.filter(r => this.isInScope(r, scope)) as Reminder[];
  }

  cancel(id: string, accountId?: string): boolean {
    const scope = this.resolveAccountScope(accountId);
    const r = this.reminders.find(x => x.id === id && this.isInScope(x, scope));
    if (!r || r.status !== "pending") return false;
    const snapshot = this.snapshot();
    r.status = "cancelled";
    this.persistOrRollback(snapshot);
    return true;
  }

  /**
   * Auto-cancel reminders whose tracked Message-ID appears in the
   * In-Reply-To / References headers of any of the given inbox messages.
   * Returns the IDs of the reminders that were cancelled.
   *
   * Case-insensitive match on the angle-bracket form of the Message-ID.
   * The caller typically passes a recent inbox slice (the autosync loop
   * already fetches one), so this is cheap and doesn't hit IMAP itself.
   */
  detectRepliesAndCancel(
    inbox: Array<{ headers?: Record<string, string | string[]> }>,
    accountId?: string,
  ): string[] {
    const scope = this.resolveAccountScope(accountId);
    const pending = this.reminders.filter(r => r.status === "pending" && this.isInScope(r, scope));
    if (pending.length === 0) return [];

    const snapshot = this.snapshot();

    // Build a lowercased set of the Message-IDs we're watching for,
    // tolerating both <id@host> and bare id@host forms.
    const watched = new Set<string>();
    for (const r of pending) {
      const mid = r.messageId.toLowerCase().trim();
      if (!mid) continue;
      watched.add(mid);
      watched.add(mid.replace(/^<|>$/g, ""));
    }

    const cancelled: string[] = [];
    for (const msg of inbox) {
      const headers = msg.headers ?? {};
      const candidates: string[] = [];
      for (const key of ["in-reply-to", "In-Reply-To", "references", "References"]) {
        const v = headers[key];
        if (Array.isArray(v)) candidates.push(...v);
        else if (typeof v === "string") candidates.push(v);
      }
      for (const raw of candidates) {
        const tokens = raw.toLowerCase().match(/<[^<>\s]+>/g) ?? [raw.toLowerCase().trim()];
        for (const t of tokens) {
          const bare = t.replace(/^<|>$/g, "");
          if (watched.has(t) || watched.has(bare)) {
            for (const r of pending) {
              if (r.status !== "pending") continue;
              const m = r.messageId.toLowerCase();
              if (m === t || m === bare || m.replace(/^<|>$/g, "") === bare) {
                r.status = "cancelled";
                cancelled.push(r.id);
              }
            }
          }
        }
      }
    }
    if (cancelled.length > 0) this.persistOrRollback(snapshot);
    return cancelled;
  }

  /**
   * Advance each due pending reminder to "fired" and return them. Caller is
   * responsible for surfacing the list to the user (MCP log, tool response,
   * etc.) — this method does not push anywhere.
   */
  scanDue(now: Date = new Date(), accountId?: string): Reminder[] {
    const cutoffMs = now.getTime();
    const fired: Reminder[] = [];
    const snapshot = this.snapshot();
    const scope = this.resolveAccountScope(accountId);
    let mutated = false;
    for (const r of this.reminders) {
      if (hasAccountOwner(r) && r.status === "pending" && this.isInScope(r, scope) && Date.parse(r.fireAt) <= cutoffMs) {
        r.status = "fired";
        fired.push({ ...r });
        mutated = true;
      }
    }
    // SMTP-007: commit the "fired" transition to disk BEFORE returning it. On
    // persist failure persistOrRollback() restores the snapshot and throws, so
    // we never hand the caller reminders whose fired-state didn't reach disk —
    // they stay pending and resurface on the next scan (at-least-once).
    if (mutated) this.persistOrRollback(snapshot);
    return fired;
  }

  /** Remove fired/cancelled reminders older than the retention window. */
  prune(retainDays = 30, accountId?: string): number {
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const snapshot = this.snapshot();
    const scope = this.resolveAccountScope(accountId);
    const before = this.reminders.length;
    this.reminders = this.reminders.filter(r => {
      if (!this.isInScope(r, scope)) return true;
      if (r.status === "pending") return true;
      return Date.parse(r.fireAt) >= cutoff;
    });
    const removed = before - this.reminders.length;
    if (removed > 0) this.persistOrRollback(snapshot);
    return removed;
  }

  private resolveAccountScope(accountId?: string): string | undefined {
    return normalizeAccountId(accountId) ?? this.currentActiveAccountId();
  }

  private resolveOwnerForNewRecord(accountId?: string): string {
    const explicitAccountId = normalizeAccountId(accountId);
    if (accountId !== undefined && !explicitAccountId) {
      throw new Error("accountId must be a non-empty string when provided");
    }
    return explicitAccountId
      ?? this.currentActiveAccountId()
      // Keeps the service's pre-account direct API compatible. MCP handlers
      // pass their dispatcher-resolved account ID, so production records do
      // not rely on this fallback.
      ?? LEGACY_DEFAULT_ACCOUNT_ID;
  }

  /** Bind new work to the resolver's current identity, rejecting stale callers. */
  private resolveIdentityForNewRecord(accountId: string, accountIdentity?: string): string | undefined {
    const supplied = normalizeAccountIdentity(accountIdentity);
    if (accountIdentity !== undefined && !supplied) {
      throw new Error("accountIdentity must be a non-empty string when provided");
    }

    if (!this.accountIdentityResolver) return supplied;

    const current = this.resolveCurrentAccountIdentity(accountId);
    if (!current) {
      throw new Error(`Cannot create reminder: account identity for ${accountId} is unavailable`);
    }
    if (supplied && supplied !== current) {
      throw new Error(`Cannot create reminder: account identity for ${accountId} changed`);
    }
    return current;
  }

  private currentActiveAccountId(): string | undefined {
    try {
      return normalizeAccountId(this.activeAccountIdSource?.());
    } catch (err) {
      logger.warn("ReminderService: could not resolve active account", "ReminderService", err);
      return undefined;
    }
  }

  private isInScope(reminder: StoredReminder, accountId: string | undefined): boolean {
    return hasAccountOwner(reminder)
      && this.isRecordCurrent(reminder)
      && (accountId === undefined || reminder.accountId === accountId);
  }

  /** True only when the persisted fingerprint still identifies this owner. */
  private isRecordCurrent(reminder: StoredReminder): boolean {
    if (!hasAccountOwner(reminder)) return false;
    const persisted = normalizeAccountIdentity(reminder.accountIdentity);
    if (reminder.accountIdentity !== undefined && (!persisted || persisted !== reminder.accountIdentity)) return false;

    // Direct legacy consumers have no resolver, so preserve their local
    // single-mailbox behavior. Routed production records require a matching
    // fingerprint and therefore fail closed while migration is incomplete.
    if (!this.accountIdentityResolver) return true;
    if (!persisted) return false;
    return persisted === this.resolveCurrentAccountIdentity(reminder.accountId);
  }

  private resolveCurrentAccountIdentity(accountId: string): string | undefined {
    if (!this.accountIdentityResolver) return undefined;
    try {
      return normalizeAccountIdentity(this.accountIdentityResolver(accountId));
    } catch (err) {
      logger.warn("ReminderService: could not resolve mailbox identity", "ReminderService", { accountId, err });
      return undefined;
    }
  }

  private migrateLegacyRecordsForActiveAccount(): void {
    const activeAccountId = this.currentActiveAccountId();
    if (!activeAccountId || !this.accountIdentityResolver) return;
    if (!this.reminders.some(reminder => !hasAccountOwner(reminder) || !normalizeAccountIdentity(reminder.accountIdentity))) return;
    try {
      this.migrateLegacyRecords(activeAccountId);
    } catch (err) {
      // Scoped reads skip records without a current fingerprint, so a failed
      // migration is safe to retry and never attributes a reminder to the
      // wrong mailbox.
      logger.error("ReminderService: legacy migration deferred after a failed safe write", "ReminderService", err);
    }
  }

  /**
   * Remove persisted reminders that belong to a former (or now missing)
   * mailbox identity. Migration runs first so a record without a fingerprint
   * remains available only for an owner-specific safe repair.
   */
  private quarantineStaleIdentityRecords(): void {
    if (!this.accountIdentityResolver) return;

    const staleOwners = new Set<string>();
    for (const reminder of this.reminders) {
      if (!hasAccountOwner(reminder)) continue;
      if (!normalizeAccountIdentity(reminder.accountIdentity)) continue;
      if (!this.isRecordCurrent(reminder)) staleOwners.add(reminder.accountId);
    }

    for (const accountId of staleOwners) {
      try {
        this.quarantineAccount(accountId, "persisted mailbox identity no longer matches the account registry");
      } catch (err) {
        // quarantineAccount keeps the safe in-memory removal if storage is
        // unavailable, so reporting the durability failure cannot revive it.
        logger.error("ReminderService: failed to quarantine stale identity", "ReminderService", { accountId, err });
      }
    }
  }

  /** Prefer raw source bytes for audit/recovery; fall back to the memory snapshot. */
  private rawStoreSnapshot(snapshot: StoredReminder[]): string {
    if (existsSync(this.path)) {
      try {
        return readFileSync(this.path, "utf-8");
      } catch (err) {
        logger.warn("ReminderService: could not read store for audit backup; using in-memory snapshot", "ReminderService", err);
      }
    }
    return JSON.stringify({ version: 2, reminders: snapshot }, null, 2);
  }

  private writeBackup(raw: string, kind: "legacy-unowned" | "quarantine"): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const backupPath = `${this.path}.${kind}-${stamp}${suffix}.bak`;
      try {
        writeFileSync(backupPath, raw, { encoding: "utf-8", mode: 0o600, flag: "wx" });
        try { chmodSync(backupPath, 0o600); } catch { /* ignore on Windows */ }
        return backupPath;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
    throw new Error("Could not allocate a unique reminder audit backup path");
  }
}
