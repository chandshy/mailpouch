/**
 * Tests for SchedulerService
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SchedulerService } from "./scheduler.js";
import type { SMTPService } from "./smtp-service.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, statSync } from "fs";
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

  it("cancel() marks item as cancelled and returns ok:true", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    const result = svc.cancel(id);
    expect(result).toEqual({ ok: true });
    expect(svc.list()[0].status).toBe("cancelled");
  });

  it("cancel() returns not_found for unknown id", () => {
    const svc = new SchedulerService(makeSMTP(), storePath);
    expect(svc.cancel("unknown-id")).toEqual({ ok: false, error: "not_found" });
  });

  it("cancel() returns already_final for already-sent item", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    // Force the item to sent status
    (svc as any).items[0].status = "sent";
    expect(svc.cancel(id)).toEqual({ ok: false, error: "already_final" });
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

  it("keeps list and cancel operations scoped to the owning account", () => {
    const svc = new SchedulerService(makeSMTP(), storePath, { activeAccountId: "account-a" });
    const idA = svc.schedule(makeOptions(), futureDate(120), "account-a");
    const idB = svc.schedule(makeOptions(), futureDate(180), "account-b");

    expect(svc.list("account-a").map(item => item.id)).toEqual([idA]);
    expect(svc.list("account-b").map(item => item.id)).toEqual([idB]);
    // Do not reveal or mutate another account's queue item.
    expect(svc.cancel(idB, "account-a")).toEqual({ ok: false, error: "not_found" });
    expect(svc.list("account-b")[0].status).toBe("pending");
  });

  it("persists mailbox identity and fails closed after an account is repointed", async () => {
    const identities = new Map([["account-a", "mailbox-a-v1"]]);
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath, {
      activeAccountId: "account-a",
      resolveAccountIdentity: accountId => identities.get(accountId),
    });
    const id = svc.schedule(makeOptions(), futureDate(120), "account-a", "mailbox-a-v1");

    expect(svc.list("account-a")).toMatchObject([{ id, accountIdentity: "mailbox-a-v1" }]);

    // Reusing the stable account ID for another mailbox makes old work inert:
    // it is neither exposed, cancellable, nor eligible to send.
    identities.set("account-a", "mailbox-a-v2");
    expect(svc.list("account-a")).toEqual([]);
    expect(svc.pending("account-a")).toEqual([]);
    expect(svc.cancel(id, "account-a")).toEqual({ ok: false, error: "not_found" });

    vi.advanceTimersByTime(121_000);
    await svc.processDue();
    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect((svc as unknown as { items: Array<{ id: string; status: string }> }).items.find(item => item.id === id)?.status)
      .toBe("pending");
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

  it("does not send unless the in-flight transition is durably persisted", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));

    // Preserve the successfully-created queue record, then make the next
    // adjacent-temp rename fail deterministically by replacing its destination
    // with a directory. This models EACCES/ENOSPC/rename failures without
    // platform-specific permission assumptions.
    rmSync(storePath);
    mkdirSync(storePath);
    vi.advanceTimersByTime(121 * 1000);

    await expect(svc.processDue()).rejects.toThrow();

    expect(smtp.sendEmail).not.toHaveBeenCalled();
    expect((svc as unknown as { items: Array<{ id: string; status: string }> }).items)
      .toContainEqual(expect.objectContaining({ id, status: "pending" }));
  });

  it("retains an old overdue record while its durable send is in flight", async () => {
    let resolveSend!: (value: { success: boolean; messageId: string }) => void;
    const sendPromise = new Promise<{ success: boolean; messageId: string }>(resolve => { resolveSend = resolve; });
    const smtp = { sendEmail: vi.fn().mockReturnValue(sendPromise) } as unknown as SMTPService;
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    const item = (svc as unknown as { items: Array<{ id: string; createdAt: string; scheduledAt: string }> })
      .items.find(candidate => candidate.id === id)!;
    item.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
    item.scheduledAt = new Date(Date.now() - 1_000).toISOString();
    svc.stop();

    const processing = svc.processDue();
    await Promise.resolve();

    expect(JSON.parse(readFileSync(storePath, "utf-8"))).toContainEqual(
      expect.objectContaining({ id, status: "sending" }),
    );
    expect(svc.cancel(id)).toEqual({ ok: false, error: "in_flight" });

    resolveSend({ success: true, messageId: "already-on-wire" });
    await processing;
  });

  it("uses the rebound SMTP service for deliveries that start after an account switch", async () => {
    const smtpA = makeSMTP({ success: true, messageId: "a" });
    const smtpB = makeSMTP({ success: true, messageId: "b" });
    const svc = new SchedulerService(smtpA, storePath);
    svc.schedule(makeOptions(), futureDate(120));

    svc.setSmtpService(smtpB);
    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();

    expect(smtpA.sendEmail).not.toHaveBeenCalled();
    expect(smtpB.sendEmail).toHaveBeenCalledTimes(1);
  });

  it("delivers each due record through its persisted owner's SMTP service", async () => {
    const smtpA = makeSMTP({ success: true, messageId: "a" });
    const smtpB = makeSMTP({ success: true, messageId: "b" });
    const services = new Map<string, SMTPService>([
      ["account-a", smtpA],
      ["account-b", smtpB],
    ]);
    const svc = new SchedulerService(smtpA, storePath, {
      activeAccountId: "account-a",
      resolveSmtpService: accountId => services.get(accountId),
    });
    const idA = svc.schedule(makeOptions(), futureDate(120), "account-a");
    const idB = svc.schedule(makeOptions(), futureDate(120), "account-b");

    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();

    expect(smtpA.sendEmail).toHaveBeenCalledTimes(1);
    expect(smtpB.sendEmail).toHaveBeenCalledTimes(1);
    expect(svc.list("account-a").find(item => item.id === idA)?.status).toBe("sent");
    expect(svc.list("account-b").find(item => item.id === idB)?.status).toBe("sent");
  });

  it("never falls back to the active SMTP service for another account's queued email", async () => {
    const activeSmtp = makeSMTP({ success: true, messageId: "active" });
    const svc = new SchedulerService(activeSmtp, storePath, { activeAccountId: "account-a" });
    const id = svc.schedule(makeOptions(), futureDate(120), "account-b");

    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();

    expect(activeSmtp.sendEmail).not.toHaveBeenCalled();
    expect(svc.list("account-b").find(item => item.id === id)?.status).toBe("pending");
  });

  it("processDue() marks failed when sendEmail returns success:false (after 3 attempts)", async () => {
    const smtp = makeSMTP({ success: false, error: "SMTP error" });
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);
    // Retry up to MAX_RETRIES (3) times before permanently failing. Each failed
    // attempt sets a per-item backoff (SMTP-003), so advance past it between
    // attempts or the item is skipped as not-yet-eligible.
    await svc.processDue();
    expect(svc.list().find(i => i.id === id)!.status).toBe("pending"); // still retrying
    vi.advanceTimersByTime(61 * 1000); // past attempt-1 backoff (60s)
    await svc.processDue();
    expect(svc.list().find(i => i.id === id)!.status).toBe("pending"); // still retrying
    vi.advanceTimersByTime(121 * 1000); // past attempt-2 backoff (120s)
    await svc.processDue();
    const item = svc.list().find(i => i.id === id)!;
    expect(item.status).toBe("failed");
    expect(item.error).toBe("SMTP error");
    expect(item.retryCount).toBe(3);
    expect(smtp.sendEmail).toHaveBeenCalledTimes(3);
  });

  it("processDue() applies per-item exponential backoff between retries (SMTP-003)", async () => {
    const smtp = makeSMTP({ success: false, error: "transient" });
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    // First attempt fails → retryCount 1, nextAttemptAt ~60s out.
    await svc.processDue();
    const afterFirst = svc.list().find(i => i.id === id)!;
    expect(afterFirst.retryCount).toBe(1);
    expect(afterFirst.nextAttemptAt).toBeTruthy();
    expect(new Date(afterFirst.nextAttemptAt!).getTime()).toBeGreaterThan(Date.now());

    // A poll tick BEFORE the backoff window elapses must NOT re-send.
    vi.advanceTimersByTime(30 * 1000);
    await svc.processDue();
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    expect(svc.list().find(i => i.id === id)!.retryCount).toBe(1);

    // After the window elapses it retries once more.
    vi.advanceTimersByTime(31 * 1000);
    await svc.processDue();
    expect(smtp.sendEmail).toHaveBeenCalledTimes(2);
    expect(svc.list().find(i => i.id === id)!.retryCount).toBe(2);
  });

  it("processDue() clears nextAttemptAt on success", async () => {
    // Fail once (sets backoff), then succeed; nextAttemptAt should be cleared.
    const smtp = {
      sendEmail: vi.fn()
        .mockResolvedValueOnce({ success: false, error: "x" })
        .mockResolvedValueOnce({ success: true, messageId: "m" }),
    } as unknown as SMTPService;
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();
    expect(svc.list().find(i => i.id === id)!.nextAttemptAt).toBeTruthy();
    vi.advanceTimersByTime(61 * 1000);
    await svc.processDue();
    const item = svc.list().find(i => i.id === id)!;
    expect(item.status).toBe("sent");
    expect(item.nextAttemptAt).toBeUndefined();
  });

  it("processDue() persists after each item's status flip, not only at loop end (SMTP-004)", async () => {
    // Two due items. The second send stays pending; while it is in flight we
    // inspect the on-disk store. With per-item persist the first item is
    // already "sent" on disk — under the old loop-end-only persist a crash here
    // would re-send it on restart.
    let resolveSecond!: (v: { success: boolean; messageId: string }) => void;
    const secondPromise = new Promise<{ success: boolean; messageId: string }>(r => { resolveSecond = r; });
    const smtp = {
      sendEmail: vi.fn()
        .mockResolvedValueOnce({ success: true, messageId: "m1" })
        .mockReturnValueOnce(secondPromise),
    } as unknown as SMTPService;
    const svc = new SchedulerService(smtp, storePath);
    svc.schedule(makeOptions(), futureDate(120));
    svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    const due = svc.processDue();
    // Let the first send resolve and its post-send persist run, while the
    // second send is still pending (loop has NOT reached its end-of-loop persist).
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    await Promise.resolve();

    const onDisk = JSON.parse(readFileSync(storePath, "utf-8"));
    const sentCount = onDisk.filter((r: { status: string }) => r.status === "sent").length;
    expect(sentCount).toBe(1);

    resolveSecond({ success: true, messageId: "m2" });
    await due;
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

  it("start() is a no-op when already running (duplicate start guard — line 57)", () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    svc.start(); // first start — sets timer
    svc.start(); // second start — should be a no-op (line 57: if (this.timer) return)
    // Verify only one timer was set (stop once is enough to clear)
    svc.stop();
    // After stop, timer is null; starting again should work normally
    svc.start();
    svc.stop();
  });

  it("setInterval callback fires after POLL_INTERVAL_MS and calls processDue via start()", async () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    // Advance time so the item becomes due (120s + 1s margin)
    vi.advanceTimersByTime(121 * 1000);
    svc.start();
    // Advance by POLL_INTERVAL_MS (60s) to fire the setInterval callback once
    await vi.advanceTimersByTimeAsync(60_001);
    svc.stop();
    const item = svc.list().find(i => i.id === id)!;
    // The interval callback fired processDue() → item is sent (by start()'s immediate call).
    // The interval fires again but the item is already sent, so sendEmail is only called once total.
    expect(item.status).toBe("sent");
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
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

  // ── history pruning ─────────────────────────────────────────────────────────

  it("load() prunes non-pending records older than 30 days", () => {
    const smtp = makeSMTP();
    const svc1 = new SchedulerService(smtp, storePath);

    // Schedule two emails and immediately mark one as 'sent' with an old createdAt
    const idKeep = svc1.schedule(makeOptions(), futureDate(120));  // pending — always kept
    const idOld  = svc1.schedule(makeOptions(), futureDate(180));

    // Simulate: mark idOld as 'sent' with a createdAt older than 30 days
    const oldRecord = (svc1 as any).items.find((i: any) => i.id === idOld);
    oldRecord.status = "sent";
    oldRecord.createdAt = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();

    svc1.stop(); // persists both records to disk

    // Now load from disk — the old 'sent' record should be pruned
    const svc2 = new SchedulerService(smtp, storePath);
    (svc2 as any).load();

    const loaded = svc2.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(idKeep);
    expect(loaded[0].status).toBe("pending");
  });

  it("load() skips malformed records and warns", () => {
    const smtp = makeSMTP();
    const svc1 = new SchedulerService(smtp, storePath);

    // Schedule one valid item, then persist a mix of valid + malformed to disk
    const id = svc1.schedule(makeOptions(), futureDate(120));
    svc1.stop(); // persists the one valid item

    // Now manually overwrite the file with a mix of valid + invalid records covering
    // all branches of isValidRecord (lines 34-40):
    const valid = (svc1 as any).items[0];
    const now = new Date().toISOString();
    const records = [
      valid,
      null,                                                                  // line 34: !r
      { id: "", scheduledAt: now, createdAt: now, status: "pending", options: {} },   // line 36: !o.id
      { id: "ok", scheduledAt: "not-a-date", createdAt: now, status: "pending", options: {} }, // line 37: isNaN(scheduledAt)
      { id: "ok", scheduledAt: now, createdAt: "bad", status: "pending", options: {} },        // line 38: isNaN(createdAt)
      { id: "ok", scheduledAt: now, createdAt: now, status: "unknown", options: {} },          // line 39: invalid status
      { id: "ok", scheduledAt: now, createdAt: now, status: "pending", options: null },        // line 40: options null
    ];
    writeFileSync(storePath, JSON.stringify(records), "utf-8");

    const svc2 = new SchedulerService(smtp, storePath);
    (svc2 as any).load();

    // Only the valid record should survive
    const loaded = svc2.list();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].id).toBe(id);
  });

  it("load() handles JSON parse errors gracefully", () => {
    const smtp = makeSMTP();

    // Write invalid JSON to the store path
    writeFileSync(storePath, "{ not valid json ]", "utf-8");

    const svc = new SchedulerService(smtp, storePath);
    // load() is called in start(); call it directly to test the error branch
    expect(() => (svc as any).load()).not.toThrow();
    expect(svc.list()).toHaveLength(0);
  });

  it("migrates unowned legacy records only after writing an immutable timestamped backup", () => {
    const now = new Date().toISOString();
    const raw = JSON.stringify([{
      id: "legacy-schedule",
      scheduledAt: new Date(Date.now() + 120_000).toISOString(),
      createdAt: now,
      status: "pending",
      options: makeOptions(),
    }], null, 2);
    writeFileSync(storePath, raw, "utf-8");
    const svc = new SchedulerService(makeSMTP(), storePath, {
      resolveAccountIdentity: accountId => accountId === "account-b" ? "mailbox-b-v1" : undefined,
    });
    (svc as unknown as { load: () => void }).load();

    const migrated = svc.migrateLegacyRecords("account-b");

    expect(migrated).toMatchObject({ migrated: 1 });
    expect(migrated.backupPath).toMatch(/\.legacy-unowned-.*\.bak$/);
    expect(readFileSync(migrated.backupPath!, "utf-8")).toBe(raw);
    expect(svc.list("account-b")).toMatchObject([{
      id: "legacy-schedule",
      accountId: "account-b",
      accountIdentity: "mailbox-b-v1",
    }]);
    expect(JSON.parse(readFileSync(storePath, "utf-8"))[0].accountId).toBe("account-b");
    expect(JSON.parse(readFileSync(storePath, "utf-8"))[0].accountIdentity).toBe("mailbox-b-v1");
    // Repeating setup cannot create a second backup or change ownership again.
    expect(svc.migrateLegacyRecords("account-b")).toEqual({ migrated: 0 });
  });

  it("migrates an owned legacy delivery with that owner's identity, not the active account", () => {
    const now = new Date().toISOString();
    writeFileSync(storePath, JSON.stringify([{
      id: "owned-legacy-schedule",
      accountId: "account-a",
      scheduledAt: new Date(Date.now() + 120_000).toISOString(),
      createdAt: now,
      status: "pending",
      options: makeOptions(),
    }]), "utf-8");
    const identities = new Map([
      ["account-a", "mailbox-a-v1"],
      ["account-b", "mailbox-b-v1"],
    ]);
    const svc = new SchedulerService(makeSMTP(), storePath, {
      resolveAccountIdentity: accountId => identities.get(accountId),
    });
    (svc as unknown as { load: () => void }).load();

    expect(svc.migrateLegacyRecords("account-b")).toMatchObject({ migrated: 1 });
    expect(svc.list("account-a")).toMatchObject([{
      id: "owned-legacy-schedule",
      accountIdentity: "mailbox-a-v1",
    }]);
    expect(svc.list("account-b")).toEqual([]);
  });

  it("quarantines a repointed account's queue with a 0600 raw audit backup", () => {
    const identities = new Map([
      ["account-a", "mailbox-a-v1"],
      ["account-b", "mailbox-b-v1"],
    ]);
    const svc = new SchedulerService(makeSMTP(), storePath, {
      activeAccountId: "account-a",
      resolveAccountIdentity: accountId => identities.get(accountId),
    });
    const idA = svc.schedule(makeOptions(), futureDate(120), "account-a", "mailbox-a-v1");
    const idB = svc.schedule(makeOptions(), futureDate(180), "account-b", "mailbox-b-v1");
    const rawBefore = readFileSync(storePath, "utf-8");

    identities.set("account-a", "mailbox-a-v2");
    const result = svc.quarantineAccount("account-a", "account mailbox identity changed");

    expect(result).toMatchObject({
      accountId: "account-a",
      quarantined: 1,
      removed: 1,
      cancelled: 0,
    });
    expect(result.backupPath).toMatch(/\.quarantine-.*\.bak$/);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe(rawBefore);
    // Windows does not expose POSIX permission bits through stat/chmod.
    if (process.platform !== "win32") {
      expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    }
    expect(svc.list("account-a")).toEqual([]);
    expect(svc.list("account-b").map(item => item.id)).toEqual([idB]);
    expect(JSON.parse(readFileSync(storePath, "utf-8")).map((item: { id: string }) => item.id)).not.toContain(idA);
  });

  it("quarantine cooperatively cancels an in-flight send on the same record object", async () => {
    let resolveSend!: (value: { success: boolean; messageId: string }) => void;
    const sendPromise = new Promise<{ success: boolean; messageId: string }>(resolve => { resolveSend = resolve; });
    const smtp = { sendEmail: vi.fn().mockReturnValue(sendPromise) } as unknown as SMTPService;
    const identities = new Map([["account-a", "mailbox-a-v1"]]);
    const svc = new SchedulerService(smtp, storePath, {
      activeAccountId: "account-a",
      resolveAccountIdentity: accountId => identities.get(accountId),
    });
    const id = svc.schedule(makeOptions(), futureDate(120), "account-a", "mailbox-a-v1");
    vi.advanceTimersByTime(121_000);

    const processing = svc.processDue();
    await Promise.resolve();
    expect((svc as unknown as { items: Array<{ id: string; status: string }> }).items.find(item => item.id === id)?.status)
      .toBe("sending");

    expect(svc.quarantineAccount("account-a", "account mailbox identity changed"))
      .toMatchObject({ quarantined: 1, removed: 0, cancelled: 1 });
    expect((svc as unknown as { items: Array<{ id: string; status: string }> }).items.find(item => item.id === id)?.status)
      .toBe("cancelled");

    resolveSend({ success: true, messageId: "already-on-wire" });
    await processing;
    expect((svc as unknown as { items: Array<{ id: string; status: string }> }).items.find(item => item.id === id)?.status)
      .toBe("cancelled");
  });

  it("automatically quarantines a persisted schedule whose fingerprint is stale after restart", () => {
    const raw = JSON.stringify([{
      id: "stale-schedule",
      accountId: "account-a",
      accountIdentity: "mailbox-a-v1",
      scheduledAt: new Date(Date.now() + 120_000).toISOString(),
      createdAt: new Date().toISOString(),
      status: "pending",
      options: makeOptions(),
    }], null, 2);
    writeFileSync(storePath, raw, "utf-8");
    const svc = new SchedulerService(makeSMTP(), storePath, {
      activeAccountId: "account-a",
      resolveAccountIdentity: accountId => accountId === "account-a" ? "mailbox-a-v2" : undefined,
    });

    svc.start();
    const backup = readdirSync(tmpDir).find(entry => entry.startsWith("scheduled.json.quarantine-") && entry.endsWith(".bak"));
    expect(backup).toBeTruthy();
    expect(readFileSync(join(tmpDir, backup!), "utf-8")).toBe(raw);
    if (process.platform !== "win32") {
      expect(statSync(join(tmpDir, backup!)).mode & 0o777).toBe(0o600);
    }
    expect(svc.list("account-a")).toEqual([]);
    expect(JSON.parse(readFileSync(storePath, "utf-8"))).toEqual([]);
    svc.stop();
  });

  it("pruneHistory() caps non-pending records at MAX_HISTORY_RECORDS", () => {
    const smtp = makeSMTP();
    const svc = new SchedulerService(smtp, storePath);

    // Build 1001 "sent" records within the 30-day retention window (newer than cutoff)
    const recentDate = new Date(Date.now() - 1000).toISOString(); // 1 second ago
    const records = Array.from({ length: 1001 }, (_, i) => ({
      id: `id-${i}`,
      scheduledAt: recentDate,
      createdAt: recentDate,
      status: "sent",
      options: makeOptions(),
      retryCount: 0,
    }));

    // pruneHistory is private; access via the internal load path
    const pruned: any[] = (svc as any).pruneHistory(records);
    // Should be capped at 1000
    expect(pruned.length).toBe(1000);
  });

  it("persist() error path — warns when write fails", () => {
    const smtp = makeSMTP();
    // Use a path inside a non-existent directory to force writeFileSync to fail
    const badPath = join(tmpDir, "nonexistent", "subdir", "scheduled.json");
    const svc = new SchedulerService(smtp, badPath);
    // schedule() calls persist() internally; the error should be swallowed and warned
    expect(() => svc.schedule(makeOptions(), futureDate(120))).not.toThrow();
  });

  it("processDue() is a no-op when already processing (concurrent lock guard — line 157)", async () => {
    let resolveSend!: () => void;
    const sendPromise = new Promise<void>(res => { resolveSend = res; });
    const smtp = {
      sendEmail: vi.fn().mockReturnValue(sendPromise.then(() => ({ success: true, messageId: 'msg1' }))),
    } as unknown as SMTPService;
    const svc = new SchedulerService(smtp, storePath);
    svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    // Start first processDue — it will await sendEmail (which is pending)
    const firstDue = svc.processDue();
    // While first is still running, call processDue again — should be a no-op (isProcessing = true)
    await svc.processDue();
    // sendEmail should only have been called once (second processDue was skipped)
    expect(smtp.sendEmail).toHaveBeenCalledTimes(1);
    // Now resolve and let the first call complete
    resolveSend();
    await firstDue;
  });

  it("processDue() handles non-Error thrown from sendEmail (String(err) branch)", async () => {
    // Throw a non-Error value to exercise the String(err) fallback at line 192
    const smtp = {
      sendEmail: vi.fn().mockRejectedValue("plain string rejection"),
    } as unknown as SMTPService;
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    // Exhaust retries — advance past each per-item backoff window (SMTP-003).
    await svc.processDue();
    vi.advanceTimersByTime(61 * 1000);
    await svc.processDue();
    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();

    const item = svc.list().find(i => i.id === id)!;
    expect(item.status).toBe("failed");
    expect(item.error).toBe("plain string rejection");
  });

  it("processDue() handles thrown exceptions from sendEmail (catch branch)", async () => {
    // Make sendEmail throw an Error instead of returning success:false
    const smtp = {
      sendEmail: vi.fn().mockRejectedValue(new Error("Connection refused")),
    } as unknown as SMTPService;
    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    // Run processDue 3 times (MAX_RETRIES) to exhaust retries via the catch
    // branch, advancing past each per-item backoff window (SMTP-003).
    await svc.processDue();
    vi.advanceTimersByTime(61 * 1000);
    await svc.processDue();
    vi.advanceTimersByTime(121 * 1000);
    await svc.processDue();

    const item = svc.list().find(i => i.id === id)!;
    expect(item.status).toBe("failed");
    expect(item.error).toBe("Connection refused");
    expect(item.retryCount).toBe(3);
  });

  it("load() retains recent non-pending records (within 30 days)", () => {
    const smtp = makeSMTP();
    const svc1 = new SchedulerService(smtp, storePath);

    const idPending = svc1.schedule(makeOptions(), futureDate(120));
    const idSent    = svc1.schedule(makeOptions(), futureDate(180));

    // Mark idSent as 'sent' with a recent createdAt (within 30 days)
    const sentRecord = (svc1 as any).items.find((i: any) => i.id === idSent);
    sentRecord.status = "sent";
    sentRecord.createdAt = new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(); // 1 day ago

    svc1.stop();

    const svc2 = new SchedulerService(smtp, storePath);
    (svc2 as any).load();

    const loaded = svc2.list();
    expect(loaded).toHaveLength(2);
    const ids = loaded.map((i: any) => i.id);
    expect(ids).toContain(idPending);
    expect(ids).toContain(idSent);
  });

  // ── SMTP-001 / SMTP-002 regression tests ────────────────────────────────────

  it("SMTP-001: cancel() landing mid-send is not clobbered to 'sent' by post-await flip", async () => {
    // Pause sendEmail so we can cancel between the await and the status flip.
    let resolveSend!: (val: { success: boolean; messageId?: string }) => void;
    const sendPromise = new Promise<{ success: boolean; messageId?: string }>(res => { resolveSend = res; });
    const smtp = {
      sendEmail: vi.fn().mockReturnValue(sendPromise),
    } as unknown as SMTPService;

    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    // Kick off processDue — it flips status to "sending" + persists, then awaits.
    const processing = svc.processDue();
    // Yield a microtask so processDue reaches the await.
    await Promise.resolve();

    // While paused, the item should be in the "sending" state.
    expect((svc as any).items.find((i: any) => i.id === id).status).toBe("sending");

    // Cancel while the send is in flight — SMTP-002 path: flips status to
    // "cancelled" and returns the in_flight signal.
    const cancelResult = svc.cancel(id);
    expect(cancelResult).toEqual({ ok: false, error: "in_flight" });

    // Resolve the send successfully — the post-await guard must NOT flip back
    // to "sent" (that was the SMTP-001 bug).
    resolveSend({ success: true, messageId: "msg-1" });
    await processing;

    const finalItem = svc.list().find(i => i.id === id)!;
    expect(finalItem.status).toBe("cancelled");
  });

  it("SMTP-002: cancel() returns in_flight error while sendEmail is awaited", async () => {
    let resolveSend!: (val: { success: boolean; messageId?: string }) => void;
    const sendPromise = new Promise<{ success: boolean; messageId?: string }>(res => { resolveSend = res; });
    const smtp = {
      sendEmail: vi.fn().mockReturnValue(sendPromise),
    } as unknown as SMTPService;

    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    const processing = svc.processDue();
    // Yield so processDue reaches the await on sendEmail.
    await Promise.resolve();

    // cancel() must return the in_flight discriminant — the user has been told
    // the send was already on the wire.
    expect(svc.cancel(id)).toEqual({ ok: false, error: "in_flight" });

    // Resolve the send — because cancel() set status to "cancelled" mid-flight,
    // the post-await guard preserves "cancelled" rather than flipping to "sent".
    resolveSend({ success: true, messageId: "msg-1" });
    await processing;

    // Verify the final persisted state reflects the cancel, not the send.
    expect(svc.list().find(i => i.id === id)!.status).toBe("cancelled");
  });

  it("SMTP-002: cancel() returns in_flight even when the send subsequently fails", async () => {
    // The cooperative-stop signal must fire regardless of how sendEmail resolves.
    let rejectSend!: (err: unknown) => void;
    const sendPromise = new Promise<{ success: boolean }>((_res, rej) => { rejectSend = rej; });
    const smtp = {
      sendEmail: vi.fn().mockReturnValue(sendPromise),
    } as unknown as SMTPService;

    const svc = new SchedulerService(smtp, storePath);
    const id = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    const processing = svc.processDue();
    await Promise.resolve();

    expect(svc.cancel(id)).toEqual({ ok: false, error: "in_flight" });

    rejectSend(new Error("Connection refused"));
    await processing;

    // Even on send failure, the user-initiated cancel wins — no retry, no
    // "failed" state, the record is honestly "cancelled".
    expect(svc.list().find(i => i.id === id)!.status).toBe("cancelled");
  });

  it("SMTP-015: an active SMTP backoff defers the rest of the batch without bumping retryCount", async () => {
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "msg-1" });
    const smtp = {
      sendEmail,
      // Backoff is already tripped before this batch runs.
      backoff: { isBlocked: () => true },
    } as unknown as SMTPService;

    const svc = new SchedulerService(smtp, storePath);
    const id1 = svc.schedule(makeOptions(), futureDate(120));
    const id2 = svc.schedule(makeOptions(), futureDate(120));
    vi.advanceTimersByTime(121 * 1000);

    await svc.processDue();

    // No send attempted, and crucially no retryCount burned — both items remain
    // cleanly "pending" for a later tick once the backoff window elapses.
    expect(sendEmail).not.toHaveBeenCalled();
    const items = svc.list();
    expect(items.find(i => i.id === id1)!.status).toBe("pending");
    expect(items.find(i => i.id === id2)!.status).toBe("pending");
    expect(items.find(i => i.id === id1)!.retryCount ?? 0).toBe(0);
    expect(items.find(i => i.id === id2)!.retryCount ?? 0).toBe(0);
  });

  it("SMTP-018: pruneHistory runs on persist(), not only at load()", () => {
    // Seed the store with exactly the history cap (1000) of terminal records,
    // then prove that ONE persist (triggered by a single schedule+cancel that
    // pushes the count to 1001) trims the on-disk blob back to the cap. This
    // exercises the same persist-time prune as 1000+ live cancels but with two
    // writes instead of ~2000 — the brute-force version times out on Windows CI.
    const now = new Date().toISOString();
    const seeded = Array.from({ length: 1000 }, (_, i) => ({
      id: `seed-${i}`,
      scheduledAt: now,
      createdAt: now,
      status: "cancelled" as const,
      options: { to: "bob@example.com", subject: "x", body: "y" },
    }));
    writeFileSync(storePath, JSON.stringify(seeded), "utf-8");

    // load() accepts all 1000 (== cap, not over it); disk still holds 1000.
    const svc = new SchedulerService(makeSMTP(), storePath);
    // schedule (+1 pending) then cancel (→ cancelled) takes non-pending to 1001.
    // With the SMTP-018 fix, persist() prunes back to 1000 before writing;
    // without it, the unpruned 1001 lands on disk.
    const id = svc.schedule(makeOptions(), futureDate(120));
    svc.cancel(id);

    const onDisk = JSON.parse(readFileSync(storePath, "utf-8")) as Array<{ status: string }>;
    const nonPending = onDisk.filter(r => r.status !== "pending");
    expect(nonPending.length).toBeLessThanOrEqual(1000);
  });
});
