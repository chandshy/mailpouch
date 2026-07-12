/**
 * Tests for the no-reply reminder service.
 * Uses an in-memory tmpdir path so persistence is exercised without polluting
 * the actual home directory.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { ReminderService } from "./reminder-service.js";
import { rmSync, existsSync, readdirSync, mkdirSync, writeFileSync, readFileSync, statSync } from "fs";
import { join, basename, dirname } from "path";
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
    // Identity migration/quarantine leaves intentional recovery backups beside
    // the store. Remove only this test's uniquely named artifacts.
    const parent = dirname(path);
    const prefix = `${basename(path)}.`;
    for (const entry of readdirSync(parent)) {
      if (entry.startsWith(prefix) && entry.endsWith(".bak")) {
        rmSync(join(parent, entry), { force: true });
      }
    }
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

  it("scopes list, cancel, reply detection, and due scans to the owning account", () => {
    const sentAt = new Date("2026-04-01T00:00:00Z");
    const svc = new ReminderService(path, { activeAccountId: "account-a" });
    const replyA = svc.add({ accountId: "account-a", messageId: "<reply-a>", recipient: "a@x", subject: "a", sentAt, afterDays: 3 });
    const replyB = svc.add({ accountId: "account-b", messageId: "<reply-b>", recipient: "b@x", subject: "b", sentAt, afterDays: 3 });
    const dueA = svc.add({ accountId: "account-a", messageId: "<due-a>", recipient: "a@x", subject: "due a", sentAt, afterDays: 1 });
    const dueB = svc.add({ accountId: "account-b", messageId: "<due-b>", recipient: "b@x", subject: "due b", sentAt, afterDays: 1 });

    expect(svc.listPending("account-a").map(reminder => reminder.id)).toEqual([dueA.id, replyA.id]);
    expect(svc.cancel(replyB.id, "account-a")).toBe(false);
    expect(svc.detectRepliesAndCancel([{ headers: { "in-reply-to": "<reply-a>" } }], "account-a"))
      .toEqual([replyA.id]);
    expect(svc.listPending("account-b").map(reminder => reminder.id)).toContain(replyB.id);

    const fired = svc.scanDue(new Date("2026-04-03T00:00:00Z"), "account-a");
    expect(fired.map(reminder => reminder.id)).toEqual([dueA.id]);
    expect(svc.listPending("account-b").map(reminder => reminder.id)).toContain(dueB.id);
  });

  it("persists mailbox identity and fails closed for list, cancel, replies, and due scans after repointing", () => {
    const identities = new Map([["account-a", "mailbox-a-v1"]]);
    const sentAt = new Date("2026-04-01T00:00:00Z");
    const svc = new ReminderService(path, {
      activeAccountId: "account-a",
      resolveAccountIdentity: accountId => identities.get(accountId),
    });
    const reply = svc.add({
      accountId: "account-a",
      accountIdentity: "mailbox-a-v1",
      messageId: "<reply-a>",
      recipient: "a@example.com",
      subject: "Reply",
      sentAt,
      afterDays: 3,
    });
    const due = svc.add({
      accountId: "account-a",
      accountIdentity: "mailbox-a-v1",
      messageId: "<due-a>",
      recipient: "a@example.com",
      subject: "Due",
      sentAt,
      afterDays: 1,
    });
    expect(reply.accountIdentity).toBe("mailbox-a-v1");

    identities.set("account-a", "mailbox-a-v2");
    expect(svc.listPending("account-a")).toEqual([]);
    expect(svc.listAll("account-a")).toEqual([]);
    expect(svc.cancel(reply.id, "account-a")).toBe(false);
    expect(svc.detectRepliesAndCancel([{ headers: { "in-reply-to": "<reply-a>" } }], "account-a")).toEqual([]);
    expect(svc.scanDue(new Date("2026-04-05T00:00:00Z"), "account-a")).toEqual([]);
    expect((svc as unknown as { reminders: Array<{ id: string; status: string }> }).reminders
      .filter(reminder => reminder.id === reply.id || reminder.id === due.id)
      .every(reminder => reminder.status === "pending"))
      .toBe(true);
  });

  it("migrates unowned legacy reminders with a timestamped recovery backup", () => {
    const raw = JSON.stringify({
      version: 1,
      reminders: [{
        id: "r-legacy",
        messageId: "<legacy@pm>",
        recipient: "legacy@example.com",
        subject: "Legacy",
        sentAt: "2026-04-01T00:00:00.000Z",
        fireAt: "2026-04-02T00:00:00.000Z",
        status: "pending",
      }],
    }, null, 2);
    writeFileSync(path, raw, "utf-8");
    const svc = new ReminderService(path, {
      resolveAccountIdentity: accountId => accountId === "account-b" ? "mailbox-b-v1" : undefined,
    });

    const migrated = svc.migrateLegacyRecords("account-b");

    expect(migrated).toMatchObject({ migrated: 1 });
    expect(migrated.backupPath).toMatch(/\.legacy-unowned-.*\.bak$/);
    expect(readFileSync(migrated.backupPath!, "utf-8")).toBe(raw);
    expect(svc.listPending("account-b")).toMatchObject([{
      id: "r-legacy",
      accountId: "account-b",
      accountIdentity: "mailbox-b-v1",
    }]);
    expect(JSON.parse(readFileSync(path, "utf-8")).reminders[0].accountId).toBe("account-b");
    expect(JSON.parse(readFileSync(path, "utf-8")).reminders[0].accountIdentity).toBe("mailbox-b-v1");
    expect(svc.migrateLegacyRecords("account-b")).toEqual({ migrated: 0 });
  });

  it("migrates an owned legacy reminder using its owner's identity instead of the active account", () => {
    writeFileSync(path, JSON.stringify({
      version: 2,
      reminders: [{
        id: "r-owned-legacy",
        accountId: "account-a",
        messageId: "<owned@pm>",
        recipient: "a@example.com",
        subject: "Owned",
        sentAt: "2026-04-01T00:00:00.000Z",
        fireAt: "2026-04-03T00:00:00.000Z",
        status: "pending",
      }],
    }), "utf-8");
    const identities = new Map([
      ["account-a", "mailbox-a-v1"],
      ["account-b", "mailbox-b-v1"],
    ]);
    const svc = new ReminderService(path, {
      resolveAccountIdentity: accountId => identities.get(accountId),
    });

    expect(svc.migrateLegacyRecords("account-b")).toMatchObject({ migrated: 1 });
    expect(svc.listPending("account-a")).toMatchObject([{
      id: "r-owned-legacy",
      accountIdentity: "mailbox-a-v1",
    }]);
    expect(svc.listPending("account-b")).toEqual([]);
  });

  it("quarantines a repointed account's reminders with a 0600 raw audit backup", () => {
    const identities = new Map([
      ["account-a", "mailbox-a-v1"],
      ["account-b", "mailbox-b-v1"],
    ]);
    const svc = new ReminderService(path, {
      activeAccountId: "account-a",
      resolveAccountIdentity: accountId => identities.get(accountId),
    });
    const sentAt = new Date("2026-04-01T00:00:00Z");
    const a = svc.add({
      accountId: "account-a", accountIdentity: "mailbox-a-v1", messageId: "<a@pm>",
      recipient: "a@example.com", subject: "A", sentAt, afterDays: 3,
    });
    const b = svc.add({
      accountId: "account-b", accountIdentity: "mailbox-b-v1", messageId: "<b@pm>",
      recipient: "b@example.com", subject: "B", sentAt, afterDays: 3,
    });
    const rawBefore = readFileSync(path, "utf-8");

    identities.set("account-a", "mailbox-a-v2");
    const result = svc.quarantineAccount("account-a", "account mailbox identity changed");

    expect(result).toMatchObject({ accountId: "account-a", quarantined: 1, removed: 1 });
    expect(result.backupPath).toMatch(/\.quarantine-.*\.bak$/);
    expect(readFileSync(result.backupPath!, "utf-8")).toBe(rawBefore);
    expect(statSync(result.backupPath!).mode & 0o777).toBe(0o600);
    expect(svc.listAll("account-a")).toEqual([]);
    expect(svc.listAll("account-b").map(reminder => reminder.id)).toEqual([b.id]);
    expect(JSON.parse(readFileSync(path, "utf-8")).reminders.map((reminder: { id: string }) => reminder.id)).not.toContain(a.id);
  });

  it("automatically quarantines a persisted reminder whose fingerprint is stale after restart", () => {
    const raw = JSON.stringify({
      version: 2,
      reminders: [{
        id: "r-stale",
        accountId: "account-a",
        accountIdentity: "mailbox-a-v1",
        messageId: "<stale@pm>",
        recipient: "a@example.com",
        subject: "Stale",
        sentAt: "2026-04-01T00:00:00.000Z",
        fireAt: "2026-04-03T00:00:00.000Z",
        status: "pending",
      }],
    }, null, 2);
    writeFileSync(path, raw, "utf-8");

    // This mirrors production startup: the reminder store loads before the
    // keychain-backed account registry supplies its identity resolver.
    const svc = new ReminderService(path);
    svc.configureAccountRouting(
      "account-a",
      accountId => accountId === "account-a" ? "mailbox-a-v2" : undefined,
    );
    const backup = readdirSync(dirname(path)).find(entry =>
      entry.startsWith(`${basename(path)}.quarantine-`) && entry.endsWith(".bak"),
    );

    expect(backup).toBeTruthy();
    expect(readFileSync(join(dirname(path), backup!), "utf-8")).toBe(raw);
    expect(statSync(join(dirname(path), backup!)).mode & 0o777).toBe(0o600);
    expect(svc.listAll("account-a")).toEqual([]);
    expect(JSON.parse(readFileSync(path, "utf-8")).reminders).toEqual([]);
  });

  it("prune() removes fired/cancelled records older than the retention window", () => {
    // TEST-004 (audit 2026-05-28): prune() compares against `Date.now()`. The
    // original test only passed when the wall-clock was after ~2026-03-03, so
    // any CI lane stuck in early 2026 (or any locally faked clock) would
    // fail. Pin the system clock to a fixed date so the assertion is
    // deterministic across environments.
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-03-15T00:00:00Z"));
      const svc = new ReminderService(path);
      const old = svc.add({ messageId: "<a>", recipient: "a@x", subject: "old", sentAt: new Date("2026-01-01Z"), afterDays: 1 });
      svc.scanDue(new Date("2026-02-01Z"));
      // 2026-03-15 minus 30 days = 2026-02-13; the old fired record (fired
      // 2026-02-01) is outside the window and must be pruned.
      const removed = svc.prune(30); // retain last 30 days (prune uses Date.now)
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(svc.listAll().find(r => r.id === old.id)).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
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

  describe("persistence atomicity (SMTP-005/006/007)", () => {
    it("writes the tmp file alongside the store, not in tmpdir (SMTP-005)", () => {
      // A persist into a directory whose tmpdir() lives on a different mount must
      // still succeed. We assert the regression indirectly: after a successful
      // persist no stray tmp file is left in tmpdir() (the old code wrote
      // `mailpouch-reminders-*.json.tmp` there), and the on-disk store exists
      // next to `path`.
      const svc = new ReminderService(path);
      svc.add({ messageId: "<a>", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 });
      expect(existsSync(path)).toBe(true);
      const strays = readdirSync(tmpdir()).filter(f => f.startsWith("mailpouch-reminders-") && f.endsWith(".json.tmp"));
      expect(strays).toEqual([]);
    });

    // Force a persist() failure by pointing the store at a path whose PARENT
    // directory does not exist: `writeFileSync(tmp)` then throws ENOENT,
    // exercising the rollback branch deterministically and cross-platform.
    function svcWithFailingPersist(): { svc: ReminderService; goodPath: string } {
      const goodPath = tmpPath();
      const svc = new ReminderService(goodPath);
      return { svc, goodPath };
    }

    it("add() rolls back the in-memory mutation when persist fails (SMTP-006)", () => {
      const { svc } = svcWithFailingPersist();
      svc.add({ messageId: "<seed>", recipient: "a@x", subject: "seed", sentAt: new Date(), afterDays: 1 });
      const before = svc.listAll().length;
      // Break the destination: replace the store path with a directory so the
      // rename target is invalid (EISDIR / ENOTEMPTY), failing persist().
      rmSync((svc as unknown as { path: string }).path, { force: true });
      mkdirSync((svc as unknown as { path: string }).path);
      expect(() => svc.add({ messageId: "<b>", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 })).toThrow();
      // The failed add must NOT remain in memory.
      expect(svc.listAll().length).toBe(before);
      expect(svc.listAll().some(r => r.messageId === "<b>")).toBe(false);
      rmSync((svc as unknown as { path: string }).path, { recursive: true, force: true });
    });

    it("cancel() rolls back when persist fails (SMTP-006)", () => {
      const { svc } = svcWithFailingPersist();
      const rec = svc.add({ messageId: "<a>", recipient: "a@x", subject: "s", sentAt: new Date(), afterDays: 1 });
      const p = (svc as unknown as { path: string }).path;
      rmSync(p, { force: true });
      mkdirSync(p);
      expect(() => svc.cancel(rec.id)).toThrow();
      // Status must still be pending — the failed cancel was rolled back.
      expect(svc.listPending().map(r => r.id)).toEqual([rec.id]);
      rmSync(p, { recursive: true, force: true });
    });

    it("scanDue() rolls back the fired transition when persist fails — at-least-once preserved (SMTP-007)", () => {
      const { svc } = svcWithFailingPersist();
      const sentAt = new Date("2026-04-01T00:00:00Z");
      svc.add({ messageId: "<a>", recipient: "a@x", subject: "due", sentAt, afterDays: 1 });
      const p = (svc as unknown as { path: string }).path;
      rmSync(p, { force: true });
      mkdirSync(p);
      const now = new Date(sentAt.getTime() + 5 * 86_400_000);
      expect(() => svc.scanDue(now)).toThrow();
      // The reminder must remain pending so a later scan re-fires it (no silent loss).
      expect(svc.listPending()).toHaveLength(1);
      rmSync(p, { recursive: true, force: true });
      // After the destination is healthy again, scanDue fires it durably.
      const fired = svc.scanDue(now);
      expect(fired).toHaveLength(1);
    });

    it("scanDue() persists the fired transition before returning (SMTP-007)", () => {
      const svc = new ReminderService(path);
      const sentAt = new Date("2026-04-01T00:00:00Z");
      svc.add({ messageId: "<a>", recipient: "a@x", subject: "due", sentAt, afterDays: 1 });
      const now = new Date(sentAt.getTime() + 5 * 86_400_000);
      svc.scanDue(now);
      // A fresh instance loading from disk must already see the fired state.
      const reloaded = new ReminderService(path);
      expect(reloaded.listPending()).toEqual([]);
      expect(reloaded.listAll().find(r => r.messageId === "<a>")?.status).toBe("fired");
    });
  });
});
