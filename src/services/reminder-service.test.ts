/**
 * Tests for the no-reply reminder service.
 * Uses an in-memory tmpdir path so persistence is exercised without polluting
 * the actual home directory.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ReminderService } from "./reminder-service.js";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

function tmpPath(): string {
  return join(tmpdir(), `mailpouch-reminders-${randomBytes(6).toString("hex")}.json`);
}

describe("ReminderService", () => {
  let path: string;

  beforeEach(() => {
    path = tmpPath();
  });

  afterEach(() => {
    if (existsSync(path)) rmSync(path, { force: true });
  });

  it("starts empty when no file exists", () => {
    const svc = new ReminderService(path);
    expect(svc.listPending()).toEqual([]);
  });

  it("persists a new reminder and reloads it from disk", () => {
    const sentAt = new Date("2026-01-01T00:00:00Z");
    const svc1 = new ReminderService(path);
    const rec = svc1.add({
      messageId: "<m1@proton>",
      recipient: "a@example.com",
      subject: "Re: Proposal",
      sentAt,
      afterDays: 3,
    });
    expect(rec.id).toMatch(/^r-[0-9a-f]{10}$/);
    expect(rec.status).toBe("pending");

    const svc2 = new ReminderService(path);
    const pending = svc2.listPending();
    expect(pending).toHaveLength(1);
    expect(pending[0].messageId).toBe("<m1@proton>");
    expect(pending[0].fireAt).toBe(new Date(sentAt.getTime() + 3 * 86_400_000).toISOString());
  });

  it("clamps afterDays to [1, 365]", () => {
    const svc = new ReminderService(path);
    const rec0 = svc.add({ messageId: "<a>", recipient: "a@x", subject: "s", sentAt: new Date("2026-01-01Z"), afterDays: 0 });
    const recHuge = svc.add({ messageId: "<b>", recipient: "a@x", subject: "s", sentAt: new Date("2026-01-01Z"), afterDays: 9999 });
    const base = new Date("2026-01-01Z").getTime();
    expect(Date.parse(rec0.fireAt) - base).toBe(1 * 86_400_000);
    expect(Date.parse(recHuge.fireAt) - base).toBe(365 * 86_400_000);
  });

  it("rejects add without a messageId or recipient", () => {
    const svc = new ReminderService(path);
    expect(() => svc.add({ messageId: "", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 })).toThrow();
    expect(() => svc.add({ messageId: "<a>", recipient: "", subject: "s", sentAt: new Date(), afterDays: 1 })).toThrow();
  });

  it("cancel() flips a pending reminder to 'cancelled' and drops it from listPending", () => {
    const svc = new ReminderService(path);
    const rec = svc.add({ messageId: "<a>", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 });
    expect(svc.cancel(rec.id)).toBe(true);
    expect(svc.listPending()).toEqual([]);
    expect(svc.listAll().find(r => r.id === rec.id)?.status).toBe("cancelled");
  });

  it("cancel() returns false for unknown or non-pending IDs", () => {
    const svc = new ReminderService(path);
    expect(svc.cancel("r-missing")).toBe(false);
    const rec = svc.add({ messageId: "<a>", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 });
    svc.cancel(rec.id);
    // second cancel on the same id is a no-op
    expect(svc.cancel(rec.id)).toBe(false);
  });

  it("scanDue() fires only reminders whose deadline has passed", () => {
    const svc = new ReminderService(path);
    const sentAt = new Date("2026-04-01T00:00:00Z");
    const soon  = svc.add({ messageId: "<a>", recipient: "a@x", subject: "soon",  sentAt, afterDays: 1 });
    const later = svc.add({ messageId: "<b>", recipient: "a@x", subject: "later", sentAt, afterDays: 30 });
    // now = sentAt + 5 days → soon is due, later is not
    const fired = svc.scanDue(new Date(sentAt.getTime() + 5 * 86_400_000));
    expect(fired.map(r => r.id)).toEqual([soon.id]);
    // Firing is persisted — a re-scan at the same instant returns nothing.
    expect(svc.scanDue(new Date(sentAt.getTime() + 5 * 86_400_000))).toEqual([]);
    expect(svc.listPending().map(r => r.id)).toEqual([later.id]);
  });

  it("listPending is sorted by fireAt (earliest first)", () => {
    const svc = new ReminderService(path);
    const sentAt = new Date("2026-04-01T00:00:00Z");
    svc.add({ messageId: "<z>", recipient: "a@x", subject: "long",  sentAt, afterDays: 30 });
    svc.add({ messageId: "<a>", recipient: "a@x", subject: "short", sentAt, afterDays: 1 });
    svc.add({ messageId: "<m>", recipient: "a@x", subject: "mid",   sentAt, afterDays: 7 });
    expect(svc.listPending().map(r => r.subject)).toEqual(["short", "mid", "long"]);
  });

  it("prune() removes fired/cancelled records older than the retention window", () => {
    const svc = new ReminderService(path);
    const old = svc.add({ messageId: "<a>", recipient: "a@x", subject: "old", sentAt: new Date("2026-01-01Z"), afterDays: 1 });
    svc.scanDue(new Date("2026-02-01Z"));
    // After 2026-03-15 the old fired record is outside a 30-day window.
    const removed = svc.prune(30); // retain last 30 days (prune uses Date.now)
    expect(removed).toBeGreaterThanOrEqual(1);
    expect(svc.listAll().find(r => r.id === old.id)).toBeUndefined();
  });

  it("recovers from a malformed file by starting empty", async () => {
    const svc1 = new ReminderService(path);
    svc1.add({ messageId: "<a>", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 });
    // Corrupt the file on disk
    const { writeFileSync } = await import("fs");
    writeFileSync(path, "{not valid json", "utf-8");
    const svc2 = new ReminderService(path);
    expect(svc2.listAll()).toEqual([]);
  });

  describe("detectRepliesAndCancel", () => {
    it("cancels a reminder when an inbox message's In-Reply-To matches its Message-ID", () => {
      const svc = new ReminderService(path);
      const r = svc.add({
        messageId: "<outbound-42@mailpouch>",
        recipient: "alice@x",
        subject: "Proposal",
        sentAt: new Date(),
        afterDays: 3,
      });
      const cancelled = svc.detectRepliesAndCancel([
        { headers: { "in-reply-to": "<outbound-42@mailpouch>" } },
      ]);
      expect(cancelled).toEqual([r.id]);
      expect(svc.listPending()).toHaveLength(0);
    });

    it("matches against References header and multi-valued tokens", () => {
      const svc = new ReminderService(path);
      svc.add({
        messageId: "<chain-1@mailpouch>",
        recipient: "bob@x", subject: "chain", sentAt: new Date(), afterDays: 1,
      });
      const cancelled = svc.detectRepliesAndCancel([
        { headers: { "References": "<other@x> <chain-1@mailpouch> <another@x>" } },
      ]);
      expect(cancelled).toHaveLength(1);
    });

    it("is case-insensitive and tolerates bracket-less Message-IDs", () => {
      const svc = new ReminderService(path);
      svc.add({
        messageId: "bare-id@pm",
        recipient: "z@x", subject: "bare", sentAt: new Date(), afterDays: 1,
      });
      const cancelled = svc.detectRepliesAndCancel([
        { headers: { "in-reply-to": "<Bare-ID@PM>" } },
      ]);
      expect(cancelled).toHaveLength(1);
    });

    it("does nothing when no message references a tracked Message-ID", () => {
      const svc = new ReminderService(path);
      svc.add({
        messageId: "<watched@pm>",
        recipient: "z@x", subject: "s", sentAt: new Date(), afterDays: 1,
      });
      const cancelled = svc.detectRepliesAndCancel([
        { headers: { "in-reply-to": "<unrelated@pm>" } },
      ]);
      expect(cancelled).toEqual([]);
      expect(svc.listPending()).toHaveLength(1);
    });

    it("ignores messages with no reply-headers", () => {
      const svc = new ReminderService(path);
      svc.add({ messageId: "<x@pm>", recipient: "z@x", subject: "s", sentAt: new Date(), afterDays: 1 });
      expect(svc.detectRepliesAndCancel([{}])).toEqual([]);
      expect(svc.listPending()).toHaveLength(1);
    });

    it("is a no-op when there are no pending reminders", () => {
      const svc = new ReminderService(path);
      expect(svc.detectRepliesAndCancel([{ headers: { "in-reply-to": "<anything@x>" } }])).toEqual([]);
    });
  });
});
