import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { AccountRuntimeRegistry } from "./account-runtime.js";
import type { EmailMessage } from "../types/index.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function email(id: string): EmailMessage {
  return {
    id,
    from: "sender@example.com",
    to: ["receiver@example.com"],
    subject: id,
    body: id,
    isHtml: false,
    date: new Date("2026-01-01T00:00:00.000Z"),
    folder: "INBOX",
    isRead: true,
    isStarred: false,
    hasAttachment: false,
  };
}

describe("AccountRuntimeRegistry", () => {
  it("keeps analytics caches and services isolated by account", async () => {
    const registry = new AccountRuntimeRegistry({ legacyFtsPath: join(tmpdir(), "unused-legacy.db") });
    const imapA = { getEmails: vi.fn(async (folder: string) => [email(`a-${folder}`)]) };
    const imapB = { getEmails: vi.fn(async (folder: string) => [email(`b-${folder}`)]) };
    const trim = (messages: EmailMessage[]) => messages;

    const a = await registry.getAnalyticsEmails("account-a", imapA as never, trim);
    const b = await registry.getAnalyticsEmails("account-b", imapB as never, trim);

    expect(a.inbox[0].id).toBe("a-INBOX");
    expect(b.inbox[0].id).toBe("b-INBOX");
    expect(registry.getAnalyticsService("account-a")).not.toBe(registry.getAnalyticsService("account-b"));

    await registry.getAnalyticsEmails("account-a", imapA as never, trim);
    expect(imapA.getEmails).toHaveBeenCalledTimes(2); // INBOX + Sent once, cached thereafter
    registry.invalidateAnalytics("account-a");
    await registry.getAnalyticsEmails("account-a", imapA as never, trim);
    expect(imapA.getEmails).toHaveBeenCalledTimes(4);
  });

  it("archives the legacy unowned FTS database and gives accounts distinct paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailpouch-runtime-"));
    dirs.push(dir);
    const legacy = join(dir, "legacy.db");
    writeFileSync(legacy, "old index");
    const fakeFts = { close: vi.fn(), ensureOwnerIdentity: vi.fn() };
    const registry = new AccountRuntimeRegistry({
      legacyFtsPath: legacy,
      openFtsIndex: vi.fn(() => fakeFts as never),
      now: () => Date.parse("2026-01-02T03:04:05.678Z"),
    });

    const a = registry.getFts("account-a", "identity-a");
    const b = registry.getFts("account-b", "identity-b");

    expect(a).toBe(fakeFts);
    expect(b).toBe(fakeFts);
    expect(existsSync(legacy)).toBe(false);
    expect(existsSync(`${legacy}.legacy-unowned-2026-01-02T03-04-05-678Z`)).toBe(true);
    expect(registry.ftsPathFor("account-a")).not.toBe(registry.ftsPathFor("account-b"));
    expect(registry.ftsPathFor("account-a")).not.toBe(legacy);
    expect(fakeFts.ensureOwnerIdentity).toHaveBeenCalledWith("identity-a");
    expect(fakeFts.ensureOwnerIdentity).toHaveBeenCalledWith("identity-b");
  });

  it("invalidates stale background work and wipes an identity-repointed mailbox", () => {
    const fakeFts = {
      close: vi.fn(),
      clear: vi.fn(),
      ensureOwnerIdentity: vi.fn(),
    };
    const registry = new AccountRuntimeRegistry({
      legacyFtsPath: join(tmpdir(), "unused-legacy.db"),
      openFtsIndex: vi.fn(() => fakeFts as never),
    });

    const before = registry.generationFor("account-a");
    registry.getFts("account-a", "identity-a");
    registry.resetMailbox("account-a");

    expect(registry.isCurrentGeneration("account-a", before)).toBe(false);
    expect(fakeFts.clear).toHaveBeenCalledTimes(1);
    expect(fakeFts.close).toHaveBeenCalledTimes(1);
  });

  it("keeps last-known SMTP health scoped to the owning account", () => {
    const registry = new AccountRuntimeRegistry({ legacyFtsPath: join(tmpdir(), "unused-legacy.db") });
    const checkedAt = new Date("2026-01-02T03:04:05.000Z");
    registry.setSmtpStatus("account-a", { connected: true, lastCheck: checkedAt });
    registry.setSmtpStatus("account-b", { connected: false, lastCheck: checkedAt, error: "auth failed" });

    expect(registry.getSmtpStatus("account-a")).toMatchObject({ connected: true });
    expect(registry.getSmtpStatus("account-b")).toMatchObject({ connected: false, error: "auth failed" });
  });
});
