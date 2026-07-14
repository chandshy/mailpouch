/**
 * Scheduler Service — queues emails for future delivery.
 *
 * Scheduled emails are persisted to a JSON file so they survive process
 * restarts. A background interval (60 s) checks for due emails and sends
 * them via the SMTPService. Overdue emails from a previous run are processed
 * immediately on startup.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "fs";
import { ScheduledEmail, SendEmailOptions } from "../types/index.js";
import { SMTPService } from "./smtp-service.js";
import { logger } from "../utils/logger.js";
import { tracer } from "../utils/tracer.js";
import {
  MailboxMutationDeadlineError,
  withBackgroundAccountMailMutation,
} from "./mailbox-mutation-deadline.js";

/** Maximum number of seconds in the future for a scheduled send (30 days). */
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Minimum lead time: at least 60 s in the future. */
const MIN_LEAD_TIME_MS = 60 * 1000;
/** Background check interval. */
const POLL_INTERVAL_MS = 60 * 1000;
/** Number of send attempts before marking an item as permanently failed. */
const MAX_RETRIES = 3;
/** Base unit for per-item exponential backoff between retry attempts. */
const RETRY_BACKOFF_BASE_MS = 60 * 1000;
/** Ceiling on a single backoff delay so a high retryCount can't push it absurdly far out. */
const RETRY_BACKOFF_MAX_MS = 30 * 60 * 1000;

/**
 * Exponential per-item backoff: attempt N waits base * 2^(N-1), capped.
 * SMTP-003 — without this, a transient Bridge outage causes every due item to
 * be re-attempted on every 60 s poll tick (a tight blast against a down peer).
 */
function backoffMs(retryCount: number): number {
  const exp = RETRY_BACKOFF_BASE_MS * Math.pow(2, Math.max(0, retryCount - 1));
  return Math.min(exp, RETRY_BACKOFF_MAX_MS);
}
/** Maximum age (ms) for completed/failed/cancelled records kept in history. */
const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Hard cap on non-pending records retained in history (safety valve). */
const MAX_HISTORY_RECORDS = 1000;

const VALID_STATUSES = new Set([
  "pending",
  "sending",
  "sent",
  "failed",
  "cancelled",
  "outcome_unknown",
]);

/**
 * Result of cancelling a scheduled email.
 *
 * `{ ok: false, error: "in_flight" }` is the SMTP-002 signal: the send is
 * already past the await-point in processDue. Callers must NOT treat this as
 * a successful cancel — the message may already be on the wire.
 */
export type CancelResult =
  | { ok: true }
  | { ok: false, error: "not_found" | "already_final" | "in_flight" };

/** Account-aware dependencies for the long-lived scheduler. */
export interface SchedulerAccountOptions {
  /** Active account used to migrate pre-multi-account queue records. */
  activeAccountId?: string | (() => string | undefined);
  /** Resolve the SMTP transport that owns a persisted scheduled delivery. */
  resolveSmtpService?: (accountId: string) => SMTPService | undefined;
  /**
   * Resolve the current opaque mailbox identity for an account ID.  When it
   * is configured, a queued delivery is usable only when its persisted
   * identity exactly matches this value.
   */
  resolveAccountIdentity?: (accountId: string) => string | undefined;
}

/** Result of assigning pre-account records to the active mailbox. */
export interface LegacyScheduleMigrationResult {
  migrated: number;
  /** Immutable copy of the pre-migration file, when one existed. */
  backupPath?: string;
}

/** Result of removing unsafe account-owned queue records after re-identity. */
export interface ScheduleQuarantineResult {
  accountId: string;
  reason: string;
  /** Total records removed from normal operation. */
  quarantined: number;
  /** Records removed immediately from the live store. */
  removed: number;
  /** In-flight records marked cancelled until their send attempt returns. */
  cancelled: number;
  /** Immutable pre-quarantine audit backup. */
  backupPath?: string;
}

/**
 * A pre-v4 record had no account owner. It is accepted only long enough to be
 * migrated deliberately; processDue() never sends an unowned record.
 */
type StoredScheduledEmail = Omit<ScheduledEmail, "accountId" | "accountIdentity"> & {
  accountId?: string;
  accountIdentity?: string;
};

const LEGACY_DEFAULT_ACCOUNT_ID = "primary";

function normalizeAccountId(accountId: unknown): string | undefined {
  return typeof accountId === "string" && accountId.trim() ? accountId.trim() : undefined;
}

function normalizeAccountIdentity(accountIdentity: unknown): string | undefined {
  return typeof accountIdentity === "string" && accountIdentity.trim()
    ? accountIdentity.trim()
    : undefined;
}

function hasAccountOwner(item: StoredScheduledEmail): item is ScheduledEmail {
  return !!normalizeAccountId(item.accountId);
}

/** Validate a deserialized ScheduledEmail record. Returns false if malformed. */
function isValidRecord(r: unknown): r is StoredScheduledEmail {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return false;
  if (typeof o.scheduledAt !== "string" || isNaN(Date.parse(o.scheduledAt))) return false;
  if (typeof o.createdAt !== "string" || isNaN(Date.parse(o.createdAt))) return false;
  if (typeof o.status !== "string" || !VALID_STATUSES.has(o.status)) return false;
  if (!o.options || typeof o.options !== "object") return false;
  // Missing accountId is the supported legacy shape. A present but invalid
  // owner is not safe to guess, so reject it instead of assigning it later.
  if (Object.prototype.hasOwnProperty.call(o, "accountId")) {
    const accountId = normalizeAccountId(o.accountId);
    if (!accountId || accountId !== o.accountId) return false;
  }
  // Missing accountIdentity is a supported legacy shape. A present but
  // malformed identity must never be silently normalised or trusted.
  if (Object.prototype.hasOwnProperty.call(o, "accountIdentity")) {
    const accountIdentity = normalizeAccountIdentity(o.accountIdentity);
    if (!accountIdentity || accountIdentity !== o.accountIdentity) return false;
  }
  return true;
}

export class SchedulerService {
  private items: StoredScheduledEmail[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;
  private activeAccountIdSource: (() => string | undefined) | undefined;
  private smtpServiceResolver: ((accountId: string) => SMTPService | undefined) | undefined;
  private accountIdentityResolver: ((accountId: string) => string | undefined) | undefined;

  constructor(
    private smtpService: SMTPService,
    private readonly storePath: string,
    options: SchedulerAccountOptions = {},
  ) {
    this.configureAccountRouting(options);
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return; // already running — prevent duplicate timers
    tracer.spanSync('scheduler.start', {}, () => {
    this.load();
    // load() performs migration and stale-identity quarantine before any due
    // work is examined.
    // Process any overdue emails from a previous session immediately
    void this.processDue().catch(err => logger.error("Scheduler processDue error", "Scheduler", err));
    this.timer = setInterval(
      () => void this.processDue().catch(err => logger.error("Scheduler processDue error", "Scheduler", err)),
      POLL_INTERVAL_MS,
    );
    logger.info(`Scheduler started (${this.pending().length} pending)`, "Scheduler");
    }); // end tracer.spanSync('scheduler.start')
  }

  stop(): void {
    tracer.spanSync('scheduler.stop', {}, () => {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.persist();
    logger.info("Scheduler stopped", "Scheduler");
    }); // end tracer.spanSync('scheduler.stop')
  }

  /**
   * Rebind the single-account fallback when the daemon switches its active
   * account. Account-owned deliveries use the resolver configured below; a
   * send already awaiting SMTP keeps its resolved service.
   */
  setSmtpService(smtpService: SMTPService): void {
    if (this.smtpService === smtpService) return;
    this.smtpService = smtpService;
    logger.info("Scheduler SMTP service rebound to the active account", "Scheduler");
  }

  /**
   * Configure account-aware delivery after the account registry is available.
   * Calling this is safe before start(); start() repeats the legacy migration
   * after it has loaded the persisted queue.
   */
  configureAccountRouting(options: SchedulerAccountOptions): void;
  configureAccountRouting(
    activeAccountId: SchedulerAccountOptions["activeAccountId"],
    resolveSmtpService?: SchedulerAccountOptions["resolveSmtpService"],
    resolveAccountIdentity?: SchedulerAccountOptions["resolveAccountIdentity"],
  ): void;
  configureAccountRouting(
    optionsOrActiveAccountId: SchedulerAccountOptions | SchedulerAccountOptions["activeAccountId"],
    suppliedResolver?: SchedulerAccountOptions["resolveSmtpService"],
    suppliedIdentityResolver?: SchedulerAccountOptions["resolveAccountIdentity"],
  ): void {
    const options: SchedulerAccountOptions =
      typeof optionsOrActiveAccountId === "object" && optionsOrActiveAccountId !== null
        ? optionsOrActiveAccountId
        : {
            activeAccountId: optionsOrActiveAccountId,
            resolveSmtpService: suppliedResolver,
            resolveAccountIdentity: suppliedIdentityResolver,
          };
    if (options.activeAccountId !== undefined) {
      const source = options.activeAccountId;
      this.activeAccountIdSource = typeof source === "function"
        ? source
        : () => source;
    }
    if (options.resolveSmtpService !== undefined) {
      this.smtpServiceResolver = options.resolveSmtpService;
    }
    if (options.resolveAccountIdentity !== undefined) {
      this.accountIdentityResolver = options.resolveAccountIdentity;
    }
    this.migrateLegacyRecordsForActiveAccount();
    this.quarantineStaleIdentityRecords();
  }

  /** Replace only the SMTP owner resolver without changing active-account selection. */
  setSmtpServiceResolver(resolveSmtpService: (accountId: string) => SMTPService | undefined): void {
    this.smtpServiceResolver = resolveSmtpService;
  }

  /** Replace the mailbox-identity resolver and safely repair legacy records. */
  setAccountIdentityResolver(resolveAccountIdentity: (accountId: string) => string | undefined): void {
    this.accountIdentityResolver = resolveAccountIdentity;
    this.migrateLegacyRecordsForActiveAccount();
    this.quarantineStaleIdentityRecords();
  }

  /**
   * Safely repair records written before mailbox identity fingerprints were
   * persisted. Unowned rows are assigned only to the supplied active account;
   * owned rows obtain their fingerprint from their own owner, never from the
   * currently active account. A resolver failure leaves that row inert.
   */
  migrateLegacyRecords(activeAccountId: string): LegacyScheduleMigrationResult {
    const owner = normalizeAccountId(activeAccountId);
    if (!owner) throw new Error("activeAccountId must be a non-empty string");

    const migratedItems = this.items.map(item => {
      const existingOwner = normalizeAccountId(item.accountId);
      const recordOwner = existingOwner ?? owner;
      const existingIdentity = normalizeAccountIdentity(item.accountIdentity);
      if (existingOwner && existingIdentity) return item;

      const accountIdentity = this.resolveCurrentAccountIdentity(recordOwner);
      if (!accountIdentity) return item;
      return {
        ...item,
        accountId: recordOwner,
        accountIdentity,
      };
    });
    const migrated = migratedItems.reduce(
      (count, item, index) => count + (item !== this.items[index] ? 1 : 0),
      0,
    );
    if (migrated === 0) {
      this.quarantineStaleIdentityRecords();
      return { migrated: 0 };
    }

    const snapshot = this.items.map(item => ({ ...item }));
    let backupPath: string | undefined;
    try {
      // Back up the raw input rather than a parsed/re-serialized view. This
      // preserves an operator's exact pre-migration evidence, including any
      // malformed rows that load() intentionally skipped.
      backupPath = this.writeBackup(this.rawStoreSnapshot(snapshot), "legacy-unowned");
      this.items = migratedItems;
      this.writeItems(this.items);
    } catch (err) {
      this.items = snapshot;
      logger.error("Failed to migrate legacy scheduled emails; queue left unchanged", "Scheduler", err);
      throw err;
    }

    logger.info(`Migrated ${migrated} legacy scheduled email(s) to mailbox identities`, "Scheduler", {
      accountId: owner,
      backupPath,
    });
    this.quarantineStaleIdentityRecords();
    return { migrated, backupPath };
  }

  /**
   * Remove a mailbox's persisted side effects after its account ID is removed
   * or repointed. The pre-change bytes are retained in a 0600 audit backup.
   * A send already awaiting SMTP cannot be recalled, so it is marked
   * cancelled and retained only until processDue() observes that transition.
   */
  quarantineAccount(accountId: string, reason: string): ScheduleQuarantineResult {
    const owner = normalizeAccountId(accountId);
    if (!owner) throw new Error("accountId must be a non-empty string");
    const auditReason = typeof reason === "string" ? reason.trim() : "";
    if (!auditReason) throw new Error("reason must be a non-empty string");

    const affected = this.items.filter(item => item.accountId === owner);
    if (affected.length === 0) {
      return { accountId: owner, reason: auditReason, quarantined: 0, removed: 0, cancelled: 0 };
    }

    const snapshot = this.items.map(item => ({ ...item }));
    const sendingIds = new Set(
      affected.filter(item => item.status === "sending").map(item => item.id),
    );
    const removed = affected.length - sendingIds.size;
    const next = this.items.flatMap(item => {
      if (item.accountId !== owner) return [item];
      if (sendingIds.has(item.id)) {
        // Mutate the same object that processDue() may currently be awaiting.
        // Replacing it with a clone would leave that in-flight loop holding a
        // stale "sending" reference and let it overwrite the cancellation.
        item.status = "cancelled";
        return [item];
      }
      return [];
    });

    let backupPath: string | undefined;
    try {
      backupPath = this.writeBackup(this.rawStoreSnapshot(snapshot), "quarantine");
      // Deliberately retain the safe in-memory state if persistence fails.
      // Restoring live records after a security quarantine is worse than
      // making the caller retry after storage recovers.
      this.items = next;
      this.writeItems(this.items);
    } catch (err) {
      this.items = next;
      logger.error("Failed to durably quarantine scheduled emails; safe in-memory quarantine retained", "Scheduler", err);
      throw err;
    }

    logger.warn("Quarantined scheduled email side effects for account", "Scheduler", {
      accountId: owner,
      reason: auditReason,
      quarantined: affected.length,
      removed,
      cancelled: sendingIds.size,
      backupPath,
    });
    return {
      accountId: owner,
      reason: auditReason,
      quarantined: affected.length,
      removed,
      cancelled: sendingIds.size,
      backupPath,
    };
  }

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Queue an email for delivery at `sendAt`.
   *
   * @throws If `sendAt` is not in the valid window [now+60s, now+30d].
   * @returns The assigned scheduled email ID.
   */
  schedule(options: SendEmailOptions, sendAt: Date, accountId?: string, accountIdentity?: string): string {
    return tracer.spanSync('scheduler.schedule', { sendAtMs: sendAt.getTime(), hasAttachments: !!(options.attachments?.length) }, () => {
    const now = Date.now();
    const delta = sendAt.getTime() - now;

    if (delta < MIN_LEAD_TIME_MS) {
      throw new Error(
        `send_at must be at least 60 seconds in the future (got ${Math.round(delta / 1000)}s).`
      );
    }
    if (delta > MAX_SCHEDULE_AHEAD_MS) {
      throw new Error(
        `send_at must be within 30 days from now (got ${Math.round(delta / 86400000)}d).`
      );
    }

    const owner = this.resolveOwnerForNewRecord(accountId);
    const item: ScheduledEmail = {
      id: crypto.randomUUID(),
      accountId: owner,
      accountIdentity: this.resolveIdentityForNewRecord(owner, accountIdentity),
      scheduledAt: sendAt.toISOString(),
      options,
      status: "pending",
      createdAt: new Date().toISOString(),
    };

    this.items.push(item);
    this.persist();
    logger.info(`Email scheduled for ${item.scheduledAt}`, "Scheduler", { id: item.id });
    return item.id;
    }); // end tracer.spanSync('scheduler.schedule')
  }

  /**
   * Cancel a scheduled email.
   *
   * - `"pending"`: marked cancelled, persisted, returns `{ ok: true }`.
   * - `"sending"`: the cooperative-stop signal — status is flipped to
   *   `"cancelled"` so processDue's post-await guard will skip the
   *   status-to-sent flip, but the SMTP send is already on the wire and may
   *   succeed. Returns `{ ok: false, error: "in_flight" }` so the caller can
   *   warn the user that the message may still be delivered.
   * - `"sent" | "failed" | "cancelled" | "outcome_unknown"`: terminal state, no-op, returns
   *   `{ ok: false, error: "already_final" }`.
   * - unknown id: `{ ok: false, error: "not_found" }`.
   */
  cancel(id: string, accountId?: string): CancelResult {
    return tracer.spanSync('scheduler.cancel', { id }, () => {
    const scope = this.resolveAccountScope(accountId);
    const item = this.items.find(i => i.id === id && this.isInScope(i, scope));
    if (!item) return { ok: false, error: "not_found" } as const;
    if (item.status === "pending") {
      item.status = "cancelled";
      this.persist();
      logger.info(`Scheduled email cancelled`, "Scheduler", { id });
      return { ok: true } as const;
    }
    if (item.status === "sending") {
      // Cooperative-stop signal — processDue's post-await guard reads this
      // and skips the status-to-sent flip. Persist so a crash mid-send still
      // reflects the user's intent on next start().
      item.status = "cancelled";
      this.persist();
      logger.warn(`Cancel arrived while send was in flight; message may still be delivered`, "Scheduler", { id });
      return { ok: false, error: "in_flight" } as const;
    }
    return { ok: false, error: "already_final" } as const;
    }); // end tracer.spanSync('scheduler.cancel')
  }

  /** Return all scheduled emails sorted by scheduledAt ascending. */
  list(accountId?: string): ScheduledEmail[] {
    const tags: { resultCount?: number } = {};
    return tracer.spanSync('scheduler.list', tags, () => {
    const scope = this.resolveAccountScope(accountId);
    const result = this.items.filter(item => this.isInScope(item, scope)).sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
    tags.resultCount = result.length;
    return result as ScheduledEmail[];
    }); // end tracer.spanSync('scheduler.list')
  }

  /** Return only pending items. */
  pending(accountId?: string): ScheduledEmail[] {
    const tags: { resultCount?: number } = {};
    return tracer.spanSync('scheduler.pending', tags, () => {
    const scope = this.resolveAccountScope(accountId);
    const result = this.items.filter(i => i.status === "pending" && this.isInScope(i, scope));
    tags.resultCount = result.length;
    return result as ScheduledEmail[];
    }); // end tracer.spanSync('scheduler.pending')
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  async processDue(): Promise<void> {
    if (this.isProcessing) {
      // SMTP-008: a slow in-flight send blocks this tick. Emit a debug line so
      // "why didn't my email send at 12:34?" is diagnosable rather than silent.
      logger.debug("processDue skipped — previous tick still in flight", "Scheduler");
      return;
    }
    this.isProcessing = true;

    const now = new Date();
    const due = this.items.filter(
      (i): i is ScheduledEmail =>
        hasAccountOwner(i) &&
        this.isRecordCurrent(i) &&
        i.status === "pending" &&
        new Date(i.scheduledAt) <= now &&
        // SMTP-003: honor per-item backoff — a failed attempt sets nextAttemptAt
        // into the future; skip until that window has elapsed.
        (!i.nextAttemptAt || new Date(i.nextAttemptAt) <= now)
    );

    if (due.length === 0) {
      this.isProcessing = false;
      return;
    }

    return tracer.span('scheduler.processDue', { dueCount: due.length }, async () => {
    try {
      logger.info(`Processing ${due.length} due scheduled email(s)`, "Scheduler");

      for (const item of due) {
        // A registry rebuild can happen after this tick captured `due`; do a
        // fresh identity check immediately before selecting a transport.
        if (!this.isRecordCurrent(item)) {
          logger.warn("Scheduled email deferred because its mailbox identity changed", "Scheduler", {
            id: item.id,
            accountId: item.accountId,
          });
          continue;
        }
        const smtpService = this.resolveSmtpForAccount(item.accountId);
        if (!smtpService) {
          // Fail closed. Sending a B-owned message through the active A
          // transport is worse than waiting until the account registry can
          // resolve B again (for example after an account was removed).
          logger.warn("Scheduled email deferred because its owner SMTP service is unavailable", "Scheduler", {
            id: item.id,
            accountId: item.accountId,
          });
          continue;
        }
        // The resolver is intentionally consulted twice around transport
        // lookup: a hot account change must not turn a stale queue record into
        // a send through a freshly rebound SMTP service.
        if (!this.isRecordCurrent(item)) {
          logger.warn("Scheduled email deferred because its mailbox identity changed during transport lookup", "Scheduler", {
            id: item.id,
            accountId: item.accountId,
          });
          continue;
        }
        // SMTP-015: if the SMTP backoff gate is already tripped, every remaining
        // item for that owner would return "backoff active" and burn a
        // retryCount for a send that was never actually attempted. Defer this
        // owner but continue processing deliveries belonging to other accounts.
        if (smtpService.backoff?.isBlocked()) {
          logger.warn("SMTP backoff active — deferring scheduled email to a later tick", "Scheduler", {
            id: item.id,
            accountId: item.accountId,
          });
          continue;
        }
        // SMTP-002: flip to "sending" + persist BEFORE the await so a
        // concurrent cancel() can distinguish "still pending" from
        // "already on the wire" and return the in_flight signal.
        const preSendSnapshot = this.snapshot();
        item.status = "sending";
        try {
          // This transition is a delivery fence, not a best-effort history
          // update. If it does not reach disk, sending now could leave the
          // durable record as "pending" and duplicate the message after a
          // crash/restart. Restore memory and fail the tick before SMTP.
          this.persistOrRollback(preSendSnapshot);
        } catch (err) {
          logger.error(
            "Scheduled email not sent because its in-flight state could not be persisted",
            "Scheduler",
            { id: item.id, accountId: item.accountId, err },
          );
          throw err;
        }
        try {
          const result = await withBackgroundAccountMailMutation({
            tool: `scheduled_email:${item.id}`,
            transports: [{
              scope: smtpService,
              abort: () => smtpService.abortActiveMutationTransport(
                `shared cancellation while scheduled email ${item.id} was in flight`,
              ),
            }],
          }, () => smtpService.sendEmail(item.options));
          // SMTP-001: a cancel() landing between the await and this assignment
          // flips item.status to "cancelled" — respect that signal and don't
          // clobber it back to "sent"/"failed".
          if (item.status !== "sending") {
            logger.info(`Scheduled send completed but state changed mid-flight; preserving ${item.status}`, "Scheduler", { id: item.id, finalStatus: item.status });
            continue;
          }
          if (result.success) {
            item.status = "sent";
            delete item.nextAttemptAt;
            logger.info(`Scheduled email sent`, "Scheduler", { id: item.id, messageId: result.messageId });
          } else {
            item.retryCount = (item.retryCount ?? 0) + 1;
            item.error = result.error;
            if ((item.retryCount ?? 0) >= MAX_RETRIES) {
              item.status = "failed";
              delete item.nextAttemptAt;
              logger.warn(`Scheduled email permanently failed after ${MAX_RETRIES} attempts`, "Scheduler", { id: item.id, error: result.error });
            } else {
              item.status = "pending";
              item.nextAttemptAt = new Date(Date.now() + backoffMs(item.retryCount)).toISOString();
              logger.warn(`Scheduled email send failed (attempt ${item.retryCount}/${MAX_RETRIES}), will retry`, "Scheduler", { id: item.id, error: result.error });
            }
          }
          // SMTP-004: persist after each item's terminal/retry status flip so a
          // crash mid-loop cannot leave a "sent" item on disk as "pending"
          // (which would re-send a non-idempotent message on restart).
          this.persist();
        } catch (err: unknown) {
          // Same post-await guard for the throw path.
          if (item.status !== "sending") {
            const errMsg = err instanceof Error ? err.message : String(err);
            logger.info(`Scheduled send threw but state changed mid-flight; preserving ${item.status}`, "Scheduler", { id: item.id, finalStatus: item.status, error: errMsg });
            continue;
          }
          if (err instanceof MailboxMutationDeadlineError && err.outcomeUnknown) {
            item.retryCount = (item.retryCount ?? 0) + 1;
            item.status = "outcome_unknown";
            item.error = err.message;
            delete item.nextAttemptAt;
            logger.error(
              "Scheduled email delivery outcome is unknown; automatic retry is disabled to prevent a duplicate",
              "Scheduler",
              { id: item.id, accountId: item.accountId, error: err.message },
            );
            this.persist();
            continue;
          }
          item.retryCount = (item.retryCount ?? 0) + 1;
          const errMsg = err instanceof Error ? err.message : String(err);
          item.error = errMsg;
          if ((item.retryCount ?? 0) >= MAX_RETRIES) {
            item.status = "failed";
            delete item.nextAttemptAt;
            logger.error(`Scheduled email permanently failed after ${MAX_RETRIES} attempts`, "Scheduler", { id: item.id, error: errMsg });
          } else {
            item.status = "pending";
            item.nextAttemptAt = new Date(Date.now() + backoffMs(item.retryCount)).toISOString();
            logger.warn(`Scheduled email threw (attempt ${item.retryCount}/${MAX_RETRIES}), will retry`, "Scheduler", { id: item.id, error: errMsg });
          }
          // SMTP-004: persist after each item's status flip (throw path too).
          this.persist();
        }
      }

      this.persist();
    } finally {
      this.isProcessing = false;
    }
    }); // end tracer.span('scheduler.processDue')
  }

  private load(): void {
    if (!existsSync(this.storePath)) return;
    try {
      const raw = readFileSync(this.storePath, "utf-8");
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        const valid = parsed.filter(isValidRecord);
        const skipped = parsed.length - valid.length;
        if (skipped > 0) {
          logger.warn(`Skipped ${skipped} malformed record(s) from scheduled email store`, "Scheduler");
        }
        this.items = this.pruneHistory(valid);
        const interrupted = this.items.filter(item => item.status === "sending");
        for (const item of interrupted) {
          item.status = "outcome_unknown";
          item.error = item.error
            ? `${item.error} Delivery was still marked in flight when mailpouch restarted; its outcome is unknown.`
            : "mailpouch restarted while this delivery was in flight; its outcome is unknown. Inspect Sent mail before retrying manually.";
          delete item.nextAttemptAt;
        }
        logger.debug(`Loaded ${this.items.length} scheduled emails from disk`, "Scheduler");
        if (interrupted.length > 0) {
          logger.error(
            `Recovered ${interrupted.length} interrupted scheduled email(s) as outcome_unknown; automatic retry is disabled`,
            "Scheduler",
          );
          this.persist();
        }
      }
    } catch (err: unknown) {
      logger.warn("Failed to load scheduled emails from disk — starting fresh", "Scheduler", err);
      this.items = [];
    }
    // A caller that loads the store directly gets the same safety boundary as
    // start(): repair eligible legacy rows, then remove stale fingerprints.
    this.migrateLegacyRecordsForActiveAccount();
    this.quarantineStaleIdentityRecords();
  }

  /**
   * Remove old non-pending records to prevent unbounded array growth.
   *
   * Strategy:
   *   1. Keep all pending items (they must not be dropped).
   *   2. For non-pending history, including ambiguous outcomes, keep only records created
   *      within MAX_HISTORY_AGE_MS.
   *   3. If the remaining non-pending count still exceeds MAX_HISTORY_RECORDS,
   *      keep only the most-recently-created MAX_HISTORY_RECORDS entries.
   */
  private pruneHistory(items: StoredScheduledEmail[]): StoredScheduledEmail[] {
    const cutoff = Date.now() - MAX_HISTORY_AGE_MS;

    const pending = items.filter(i => i.status === "pending");
    let history = items.filter(
      i => i.status !== "pending" && Date.parse(i.createdAt) >= cutoff
    );

    if (history.length > MAX_HISTORY_RECORDS) {
      // Sort newest-first, keep only the cap
      history = history
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, MAX_HISTORY_RECORDS);
      logger.warn(
        `Pruned scheduled email history to ${MAX_HISTORY_RECORDS} most-recent non-pending records`,
        "Scheduler"
      );
    }

    const pruned = pending.length + history.length;
    if (pruned < items.length) {
      logger.debug(
        `Pruned ${items.length - pruned} old non-pending scheduled email record(s)`,
        "Scheduler"
      );
    }

    return [...pending, ...history];
  }

  private persist(): void {
    // SMTP-018: prune on every write, not only at load(). A long-running process
    // accumulates >MAX_HISTORY_RECORDS non-pending records in memory and would
    // otherwise rewrite (and grow) the full blob on every schedule/cancel/tick.
    this.items = this.pruneHistory(this.items);
    try {
      this.writeItems(this.items);
    } catch (err: unknown) {
      logger.warn("Failed to persist scheduled emails", "Scheduler", err);
    }
  }

  /** Deep-enough immutable snapshot for status/retry persistence rollback. */
  private snapshot(): StoredScheduledEmail[] {
    return this.items.map(item => ({ ...item }));
  }

  /**
   * Persist a safety-critical state transition or restore the prior in-memory
   * queue and rethrow. Unlike persist(), this must never degrade to logging:
   * callers use it as a fence before an irreversible SMTP send begins.
   */
  private persistOrRollback(snapshot: StoredScheduledEmail[]): void {
    try {
      // Do not prune after the caller has changed a pending record to
      // "sending". Pending work is retained regardless of age, but the history
      // policy would classify that same record as terminal-ish and drop it
      // after 30 days before SMTP even begins. The post-send persist path can
      // prune safely once an outcome exists.
      this.writeItems(this.items);
    } catch (err) {
      this.items = snapshot;
      throw err;
    }
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
      // Direct consumers predating account routing remain compatible. The MCP
      // dispatcher always supplies a real account ID before reaching here.
      ?? LEGACY_DEFAULT_ACCOUNT_ID;
  }

  /**
   * Bind new work to the resolver's current identity. A caller-provided
   * identity is accepted only when it agrees with that resolver, preventing a
   * stale ToolCallContext from queuing work after a mailbox was repointed.
   */
  private resolveIdentityForNewRecord(accountId: string, accountIdentity?: string): string | undefined {
    const supplied = normalizeAccountIdentity(accountIdentity);
    if (accountIdentity !== undefined && !supplied) {
      throw new Error("accountIdentity must be a non-empty string when provided");
    }

    if (!this.accountIdentityResolver) return supplied;

    const current = this.resolveCurrentAccountIdentity(accountId);
    if (!current) {
      throw new Error(`Cannot schedule email: account identity for ${accountId} is unavailable`);
    }
    if (supplied && supplied !== current) {
      throw new Error(`Cannot schedule email: account identity for ${accountId} changed`);
    }
    return current;
  }

  private currentActiveAccountId(): string | undefined {
    try {
      return normalizeAccountId(this.activeAccountIdSource?.());
    } catch (err) {
      logger.warn("Could not resolve active account for scheduler", "Scheduler", err);
      return undefined;
    }
  }

  private isInScope(item: StoredScheduledEmail, accountId: string | undefined): boolean {
    return hasAccountOwner(item)
      && this.isRecordCurrent(item)
      && (accountId === undefined || item.accountId === accountId);
  }

  /** True only when the persisted mailbox fingerprint still names this owner. */
  private isRecordCurrent(item: StoredScheduledEmail): boolean {
    if (!hasAccountOwner(item)) return false;
    const persisted = normalizeAccountIdentity(item.accountIdentity);
    if (item.accountIdentity !== undefined && (!persisted || persisted !== item.accountIdentity)) return false;

    // Keep direct, pre-routing consumers compatible. In production the
    // resolver is always installed, so a missing legacy identity is inert
    // until migration has obtained an owner-specific fingerprint.
    if (!this.accountIdentityResolver) return true;
    if (!persisted) return false;
    return persisted === this.resolveCurrentAccountIdentity(item.accountId);
  }

  private resolveCurrentAccountIdentity(accountId: string): string | undefined {
    if (!this.accountIdentityResolver) return undefined;
    try {
      return normalizeAccountIdentity(this.accountIdentityResolver(accountId));
    } catch (err) {
      logger.warn("Could not resolve scheduled email mailbox identity", "Scheduler", { accountId, err });
      return undefined;
    }
  }

  private resolveSmtpForAccount(accountId: string): SMTPService | undefined {
    if (this.smtpServiceResolver) {
      try {
        const resolved = this.smtpServiceResolver(accountId);
        if (resolved) return resolved;
      } catch (err) {
        logger.warn("Could not resolve scheduled email owner SMTP service", "Scheduler", { accountId, err });
      }
    }

    // Without an account resolver, the only safe fallback is the service
    // bound to the active owner. Legacy direct users have no active source,
    // so their single SMTP service retains the old behavior.
    const active = this.currentActiveAccountId();
    return !active || active === accountId ? this.smtpService : undefined;
  }

  private migrateLegacyRecordsForActiveAccount(): void {
    const activeAccountId = this.currentActiveAccountId();
    if (!activeAccountId || !this.accountIdentityResolver) return;
    if (!this.items.some(item => !hasAccountOwner(item) || !normalizeAccountIdentity(item.accountIdentity))) return;
    try {
      this.migrateLegacyRecords(activeAccountId);
    } catch (err) {
      // The queue remains untouched and processDue() skips records without a
      // current identity, so a failed migration cannot silently route a
      // delivery to another inbox.
      logger.error("Legacy scheduled-email migration deferred after a failed safe write", "Scheduler", err);
    }
  }

  /**
   * Purge persisted work that was bound to an older (or now missing) mailbox
   * identity. This runs after migration so pre-fingerprint records get their
   * one safe opportunity to resolve an owner before anything is removed.
   */
  private quarantineStaleIdentityRecords(): void {
    if (!this.accountIdentityResolver) return;

    const staleOwners = new Set<string>();
    for (const item of this.items) {
      if (!hasAccountOwner(item)) continue;
      // A missing fingerprint is a migration candidate, not proof of a
      // mailbox change. It remains inert until a later safe migration.
      if (!normalizeAccountIdentity(item.accountIdentity)) continue;
      if (!this.isRecordCurrent(item)) staleOwners.add(item.accountId);
    }

    for (const accountId of staleOwners) {
      try {
        this.quarantineAccount(accountId, "persisted mailbox identity no longer matches the account registry");
      } catch (err) {
        // quarantineAccount retains the safe in-memory state even if disk is
        // unavailable. Log the durability failure without re-enabling work.
        logger.error("Failed to quarantine stale scheduled-email identity", "Scheduler", { accountId, err });
      }
    }
  }

  /** Prefer raw source bytes for audit/recovery; fall back to the memory snapshot. */
  private rawStoreSnapshot(snapshot: StoredScheduledEmail[]): string {
    if (existsSync(this.storePath)) {
      try {
        return readFileSync(this.storePath, "utf-8");
      } catch (err) {
        logger.warn("Could not read scheduled-email store for audit backup; using in-memory snapshot", "Scheduler", err);
      }
    }
    return JSON.stringify(snapshot, null, 2);
  }

  private writeBackup(raw: string, kind: "legacy-unowned" | "quarantine"): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    for (let attempt = 0; attempt < 100; attempt++) {
      const suffix = attempt === 0 ? "" : `-${attempt}`;
      const backupPath = `${this.storePath}.${kind}-${stamp}${suffix}.bak`;
      try {
        writeFileSync(backupPath, raw, { encoding: "utf-8", mode: 0o600, flag: "wx" });
        try { chmodSync(backupPath, 0o600); } catch { /* ignore on Windows */ }
        return backupPath;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw err;
      }
    }
    throw new Error("Could not allocate a unique scheduled-email audit backup path");
  }

  private writeItems(items: StoredScheduledEmail[]): void {
    const tmp = this.storePath + ".tmp";
    writeFileSync(tmp, JSON.stringify(items, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.storePath);
    // Ensure destination file has 0600 permissions (renameSync preserves the
    // temp file's mode on POSIX, but chmod is a no-op-safe belt-and-suspenders
    // guard; silently ignored on Windows where chmod has no effect).
    try { chmodSync(this.storePath, 0o600); } catch { /* ignore on Windows */ }
  }
}
