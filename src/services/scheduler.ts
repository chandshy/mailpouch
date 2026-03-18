/**
 * Scheduler Service — queues emails for future delivery.
 *
 * Scheduled emails are persisted to a JSON file so they survive process
 * restarts. A background interval (60 s) checks for due emails and sends
 * them via the SMTPService. Overdue emails from a previous run are processed
 * immediately on startup.
 */

import { readFileSync, writeFileSync, renameSync, chmodSync, existsSync } from "fs";
import { join, dirname } from "path";
import { ScheduledEmail, SendEmailOptions } from "../types/index.js";
import { SMTPService } from "./smtp-service.js";
import { logger } from "../utils/logger.js";
import { tracer } from "../utils/tracer.js";

/** Maximum number of seconds in the future for a scheduled send (30 days). */
const MAX_SCHEDULE_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
/** Minimum lead time: at least 60 s in the future. */
const MIN_LEAD_TIME_MS = 60 * 1000;
/** Background check interval. */
const POLL_INTERVAL_MS = 60 * 1000;
/** Number of send attempts before marking an item as permanently failed. */
const MAX_RETRIES = 3;
/** Maximum age (ms) for completed/failed/cancelled records kept in history. */
const MAX_HISTORY_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
/** Hard cap on non-pending records retained in history (safety valve). */
const MAX_HISTORY_RECORDS = 1000;

const VALID_STATUSES = new Set(["pending", "sent", "failed", "cancelled"]);

/** Validate a deserialized ScheduledEmail record. Returns false if malformed. */
function isValidRecord(r: unknown): r is import("../types/index.js").ScheduledEmail {
  if (!r || typeof r !== "object") return false;
  const o = r as Record<string, unknown>;
  if (typeof o.id !== "string" || !o.id) return false;
  if (typeof o.scheduledAt !== "string" || isNaN(Date.parse(o.scheduledAt))) return false;
  if (typeof o.createdAt !== "string" || isNaN(Date.parse(o.createdAt))) return false;
  if (typeof o.status !== "string" || !VALID_STATUSES.has(o.status)) return false;
  if (!o.options || typeof o.options !== "object") return false;
  return true;
}

export class SchedulerService {
  private items: ScheduledEmail[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor(
    private readonly smtpService: SMTPService,
    private readonly storePath: string,
  ) {}

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  start(): void {
    if (this.timer) return; // already running — prevent duplicate timers
    tracer.spanSync('scheduler.start', {}, () => {
    this.load();
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

  // ─── Public API ─────────────────────────────────────────────────────────────

  /**
   * Queue an email for delivery at `sendAt`.
   *
   * @throws If `sendAt` is not in the valid window [now+60s, now+30d].
   * @returns The assigned scheduled email ID.
   */
  schedule(options: SendEmailOptions, sendAt: Date): string {
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

    const item: ScheduledEmail = {
      id: crypto.randomUUID(),
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

  /** Cancel a pending scheduled email. Returns false if not found or not pending. */
  cancel(id: string): boolean {
    return tracer.spanSync('scheduler.cancel', { id }, () => {
    const item = this.items.find(i => i.id === id);
    if (!item || item.status !== "pending") return false;
    item.status = "cancelled";
    this.persist();
    logger.info(`Scheduled email cancelled`, "Scheduler", { id });
    return true;
    }); // end tracer.spanSync('scheduler.cancel')
  }

  /** Return all scheduled emails sorted by scheduledAt ascending. */
  list(): ScheduledEmail[] {
    const tags: { resultCount?: number } = {};
    return tracer.spanSync('scheduler.list', tags, () => {
    const result = [...this.items].sort(
      (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime()
    );
    tags.resultCount = result.length;
    return result;
    }); // end tracer.spanSync('scheduler.list')
  }

  /** Return only pending items. */
  pending(): ScheduledEmail[] {
    const tags: { resultCount?: number } = {};
    return tracer.spanSync('scheduler.pending', tags, () => {
    const result = this.items.filter(i => i.status === "pending");
    tags.resultCount = result.length;
    return result;
    }); // end tracer.spanSync('scheduler.pending')
  }

  // ─── Internal ───────────────────────────────────────────────────────────────

  async processDue(): Promise<void> {
    if (this.isProcessing) return;
    this.isProcessing = true;

    const now = new Date();
    const due = this.items.filter(
      i => i.status === "pending" && new Date(i.scheduledAt) <= now
    );

    if (due.length === 0) {
      this.isProcessing = false;
      return;
    }

    return tracer.span('scheduler.processDue', { dueCount: due.length }, async () => {
    try {
      logger.info(`Processing ${due.length} due scheduled email(s)`, "Scheduler");

      for (const item of due) {
        try {
          const result = await this.smtpService.sendEmail(item.options);
          if (result.success) {
            item.status = "sent";
            logger.info(`Scheduled email sent`, "Scheduler", { id: item.id, messageId: result.messageId });
          } else {
            item.retryCount = (item.retryCount ?? 0) + 1;
            item.error = result.error;
            if ((item.retryCount ?? 0) >= MAX_RETRIES) {
              item.status = "failed";
              logger.warn(`Scheduled email permanently failed after ${MAX_RETRIES} attempts`, "Scheduler", { id: item.id, error: result.error });
            } else {
              logger.warn(`Scheduled email send failed (attempt ${item.retryCount}/${MAX_RETRIES}), will retry`, "Scheduler", { id: item.id, error: result.error });
            }
          }
        } catch (err: any) {
          item.retryCount = (item.retryCount ?? 0) + 1;
          item.error = err.message;
          if ((item.retryCount ?? 0) >= MAX_RETRIES) {
            item.status = "failed";
            logger.error(`Scheduled email permanently failed after ${MAX_RETRIES} attempts`, "Scheduler", { id: item.id, error: err.message });
          } else {
            logger.warn(`Scheduled email threw (attempt ${item.retryCount}/${MAX_RETRIES}), will retry`, "Scheduler", { id: item.id, error: err.message });
          }
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
        logger.debug(`Loaded ${this.items.length} scheduled emails from disk`, "Scheduler");
      }
    } catch (err) {
      logger.warn("Failed to load scheduled emails from disk — starting fresh", "Scheduler", err);
      this.items = [];
    }
  }

  /**
   * Remove old non-pending records to prevent unbounded array growth.
   *
   * Strategy:
   *   1. Keep all pending items (they must not be dropped).
   *   2. For non-pending (sent/failed/cancelled), keep only those created
   *      within MAX_HISTORY_AGE_MS.
   *   3. If the remaining non-pending count still exceeds MAX_HISTORY_RECORDS,
   *      keep only the most-recently-created MAX_HISTORY_RECORDS entries.
   */
  private pruneHistory(items: ScheduledEmail[]): ScheduledEmail[] {
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
    const tmp = this.storePath + ".tmp";
    try {
      writeFileSync(tmp, JSON.stringify(this.items, null, 2), { encoding: "utf-8", mode: 0o600 });
      renameSync(tmp, this.storePath);
      // Ensure destination file has 0600 permissions (renameSync preserves the
      // temp file's mode on POSIX, but chmod is a no-op-safe belt-and-suspenders
      // guard; silently ignored on Windows where chmod has no effect).
      try { chmodSync(this.storePath, 0o600); } catch { /* ignore on Windows */ }
    } catch (err) {
      logger.warn("Failed to persist scheduled emails", "Scheduler", err);
    }
  }
}
