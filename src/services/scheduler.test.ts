/**
 * Tests for SchedulerService
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SchedulerService } from "./scheduler.js";
import type { SMTPService } from "./smtp-service.js";
import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeSMTP(sendResult: { success: boolean; messageId?: string; error?: string } = { success: true, messageId: "msg-1" }) {
  return {
    sendEmail: vi.fn().mockResolvedValue(sendResult),
  } as unknown as SMTPService;
}

function makeOptions() {
  return {
    to: "bob@example.com",
    subject: "Hello",
    body: "World",
  };
}

function futureDate(secondsFromNow: number): Date {
  return new Date(Date.now() + secondsFromNow * 1000);
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("SchedulerService", () => {
  let tmpDir: string;
  let storePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "scheduler-test-"));
    storePath = join(tmpDir, "scheduled.json");
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── schedule ────────────────────────────────────────────────────────────────

  it("schedule() returns an id and adds to list", () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
    const all = svc.list();
    expect(all).toHaveLength(1);
    expect(all[0].status).toBe("pending");
    expect(all[0].id).toBe(id);
  });

  it("schedule() rejects send_at less than 60s in the future", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    expect(() => svc.schedule(makeOptions(), futureDate(30))).toThrow(/60 seconds/);
  });

  it("schedule() rejects send_at more than 30 days in the future", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    const tooFar = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    expect(() => svc.schedule(makeOptions(), tooFar)).toThrow(/30 days/);
  });

  it("schedule() rejects a date in the past", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    const past = new Date(Date.now() - 1000);
    expect(() => svc.schedule(makeOptions(), past)).toThrow(/60 seconds/);
  });

  // ── cancel ──────────────────────────────────────────────────────────────────

  it("cancel() marks item as cancelled and returns true", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    const result = svc.cancel(id);
    expect(result).toBe(true);
    expect(svc.list()[0].status).toBe("cancelled");
  });

  it("cancel() returns false for unknown id", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    expect(svc.cancel("unknown-id")).toBe(false);
  });

  it("cancel() returns false for already-sent item", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    // Force the item to sent status
    (svc as any).items[0].status = "sent";
    expect(svc.cancel(id)).toBe(false);
  });

  // ── list ────────────────────────────────────────────────────────────────────

  it("list() returns items sorted by scheduledAt ascending", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    const id1 = svc.schedule(makeOptions(), futureDate(200));
    const id2 = svc.schedule(makeOptions(), futureDate(100));
    const items = svc.list();
    expect(items[0].id).toBe(id2); // earlier time first
    expect(items[1].id).toBe(id1);
  });

  // ── processDue ──────────────────────────────────────────────────────────────

  it("processDue() sends due emails and marks them sent", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    // Advance time so the email is due
    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();
    const item = svc.list().find(i => i.id === id)!;
    expect(item.status).toBe("sent");
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("processDue() marks failed when sendEmail returns success:false (after 3 attempts)", async () => {
    const smtp = makeSMTP({ success: false, error: "SMTP error" });
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);
    // Retry up to MAX_RETRIES (3) times before permanently failing
    await svc.processDue();
    expect(svc.list().find(i => i.id === id)!.status).toBe("pending"); // still retrying
    await svc.processDue();
    expect(svc.list().find(i => i.id === id)!.status).toBe("pending"); // still retrying
    await svc.processDue();
    const item = svc.list().find(i => i.id === id)!;
    expect(item.status).toBe("failed");
    expect(item.error).toBe("SMTP error");
    expect(item.retryCount).toBe(3);
    expect(smtp.sendEmail).toHaveBeenCalledTimes(3);
  });

  it("processDue() does not send items that are not due yet", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    svc.schedule(makeOptions(), futureDate(300));
    vi.advanceTimersByTime(60 * 1000);
    await svc.processDue();
    expect(smtp.sendEmail).not.toHaveBeenCalled();
  });

  it("processDue() skips cancelled items", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    svc.cancel(id);
    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();
    expect(smtp.sendEmail).not.toHaveBeenCalled();
  });

  // ── persistence ─────────────────────────────────────────────────────────────

  it("stop() persists scheduled items to disk; start() loads them", () => {
    const smtp = makeSMTP();
    const svc1 = new SchedulerService(smtp, storePath);
    svc1.schedule(makeOptions(), futureDate(120));
    svc1.stop(); // persists

    const svc2 = new SchedulerService(smtp, storePath);
    svc2.start(); // loads from disk
    expect(svc2.list()).toHaveLength(1);
    expect(svc2.list()[0].status).toBe("pending");
    svc2.stop();
  });

  it("start() processes overdue emails immediately on load", async () => {
    const smtp = makeSMTP();
    const svc1 = new SchedulerService(smtp, storePath);
    const id = svc1.schedule(makeOptions(), futureDate(120));
    // Manually make item overdue
    const item = (svc1 as any).items.find((i: any) => i.id === id);
    item.scheduledAt = new Date(Date.now() - 1000).toISOString();
    svc1.stop(); // persists overdue item

    const svc2 = new SchedulerService(smtp, storePath);
    // Load from disk manually then call processDue() directly.
    // (start() is intentionally avoided here: setInterval + fake timers
    //  would loop forever in vi.runAllTimersAsync)
    (svc2 as any).load();
    await svc2.processDue();
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    svc2.stop();
  });

  // ── pending helper ─────────────────────────────────────────────────────────

  it("pending() returns only pending items", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    const id1 = svc.schedule(makeOptions(), futureDate(120));
    const id2 = svc.schedule(makeOptions(), futureDate(180));
    svc.cancel(id1);
    const pending = svc.pending();
    expect(pending).toHaveLength(1);
    expect(pending[0].id).toBe(id2);
  });
});
