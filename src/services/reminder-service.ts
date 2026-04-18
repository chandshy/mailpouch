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

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { logger } from "../utils/logger.js";

export type ReminderStatus = "pending" | "fired" | "cancelled";

export interface Reminder {
  /** Short random ID, not persistent across manual edits. */
  id: string;
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

interface ReminderFile {
  version: 1;
  reminders: Reminder[];
}

export class ReminderService {
  private readonly path: string;
  private reminders: Reminder[] = [];

  constructor(path: string) {
    this.path = path;
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
      this.reminders = Array.isArray(parsed.reminders) ? parsed.reminders : [];
    } catch (err) {
      logger.warn(`ReminderService: failed to parse ${this.path}, starting empty`, "ReminderService", err);
      this.reminders = [];
    }
  }

  private persist(): void {
    const payload: ReminderFile = { version: 1, reminders: this.reminders };
    const tmp = join(tmpdir(), `mailpouch-reminders-${randomBytes(8).toString("hex")}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
  }

  /**
   * Create a reminder. Returns the persisted record.
   * @param args.afterDays  Days from sentAt to the deadline. Minimum 1, maximum 365.
   */
  add(args: {
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
    const record: Reminder = {
      id: `r-${randomBytes(5).toString("hex")}`,
      messageId: args.messageId,
      imapUid: args.imapUid,
      recipient: args.recipient,
      subject: args.subject,
      sentAt: args.sentAt.toISOString(),
      fireAt: new Date(fireAtMs).toISOString(),
      status: "pending",
      note: args.note,
    };
    this.reminders.push(record);
    this.persist();
    return record;
  }

  /** Return pending reminders sorted by earliest fireAt. */
  listPending(): Reminder[] {
    return this.reminders
      .filter(r => r.status === "pending")
      .sort((a, b) => Date.parse(a.fireAt) - Date.parse(b.fireAt));
  }

  /** Return every reminder, regardless of status. */
  listAll(): Reminder[] {
    return [...this.reminders];
  }

  cancel(id: string): boolean {
    const r = this.reminders.find(x => x.id === id);
    if (!r || r.status !== "pending") return false;
    r.status = "cancelled";
    this.persist();
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
  detectRepliesAndCancel(inbox: Array<{ headers?: Record<string, string | string[]> }>): string[] {
    const pending = this.reminders.filter(r => r.status === "pending");
    if (pending.length === 0) return [];

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
    if (cancelled.length > 0) this.persist();
    return cancelled;
  }

  /**
   * Advance each due pending reminder to "fired" and return them. Caller is
   * responsible for surfacing the list to the user (MCP log, tool response,
   * etc.) — this method does not push anywhere.
   */
  scanDue(now: Date = new Date()): Reminder[] {
    const cutoffMs = now.getTime();
    const fired: Reminder[] = [];
    let mutated = false;
    for (const r of this.reminders) {
      if (r.status === "pending" && Date.parse(r.fireAt) <= cutoffMs) {
        r.status = "fired";
        fired.push({ ...r });
        mutated = true;
      }
    }
    if (mutated) this.persist();
    return fired;
  }

  /** Remove fired/cancelled reminders older than the retention window. */
  prune(retainDays = 30): number {
    const cutoff = Date.now() - retainDays * 24 * 60 * 60 * 1000;
    const before = this.reminders.length;
    this.reminders = this.reminders.filter(r => {
      if (r.status === "pending") return true;
      return Date.parse(r.fireAt) >= cutoff;
    });
    const removed = before - this.reminders.length;
    if (removed > 0) this.persist();
    return removed;
  }
}
