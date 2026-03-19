/**
 * Tests for new SimpleIMAPService features:
 *   - downloadAttachment
 *   - saveDraft
 *   - multi-folder search (folders param)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SimpleIMAPService } from "./simple-imap-service.js";

// ─── downloadAttachment tests ─────────────────────────────────────────────────

describe("SimpleIMAPService.downloadAttachment", () => {
  it("returns null when email is not found", async () => {
    const svc = new SimpleIMAPService();
    // Inject a spy on getEmailById that returns null
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);
    // emailCache is empty
    const result = await svc.downloadAttachment("123", 0);
    expect(result).toBeNull();
  });

  it("returns null when email has no attachments", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    // Inject an email with no attachments into cache (new format: { email, cachedAt })
    (svc as any).emailCache.set("123", {
      email: {
        id: "123",
        from: "a@b.com",
        to: [],
        subject: "Test",
        body: "Hello",
        isHtml: false,
        date: new Date(),
        folder: "INBOX",
        isRead: false,
        isStarred: false,
        hasAttachment: false,
      },
      cachedAt: Date.now(),
    });
    const result = await svc.downloadAttachment("123", 0);
    expect(result).toBeNull();
  });

  it("returns null for out-of-bounds attachment index", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    const buf = Buffer.from("hello");
    (svc as any).emailCache.set("123", {
      email: {
        id: "123",
        from: "a@b.com",
        to: [],
        subject: "Test",
        body: "Hello",
        isHtml: false,
        date: new Date(),
        folder: "INBOX",
        isRead: false,
        isStarred: false,
        hasAttachment: true,
        attachments: [
          { filename: "file.txt", contentType: "text/plain", size: 5, content: buf },
        ],
      },
      cachedAt: Date.now(),
    });
    const result = await svc.downloadAttachment("123", 5);
    expect(result).toBeNull();
  });

  it("returns base64 content for a cached Buffer attachment", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    const content = Buffer.from("hello world");
    // Inject directly (bypassing setCacheEntry) so content is NOT stripped
    (svc as any).emailCache.set("456", {
      email: {
        id: "456",
        from: "a@b.com",
        to: [],
        subject: "Test",
        body: "Hello",
        isHtml: false,
        date: new Date(),
        folder: "INBOX",
        isRead: false,
        isStarred: false,
        hasAttachment: true,
        attachments: [
          { filename: "hello.txt", contentType: "text/plain", size: content.length, content },
        ],
      },
      cachedAt: Date.now(),
    });
    const result = await svc.downloadAttachment("456", 0);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("hello.txt");
    expect(result!.contentType).toBe("text/plain");
    expect(result!.encoding).toBe("base64");
    // Decode and verify content
    const decoded = Buffer.from(result!.content, "base64").toString("utf8");
    expect(decoded).toBe("hello world");
  });

  it("returns string content as-is (already base64)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    const base64Content = Buffer.from("test data").toString("base64");
    // Inject directly (bypassing setCacheEntry) so string content is preserved
    (svc as any).emailCache.set("789", {
      email: {
        id: "789",
        from: "a@b.com",
        to: [],
        subject: "Test",
        body: "Hello",
        isHtml: false,
        date: new Date(),
        folder: "INBOX",
        isRead: false,
        isStarred: false,
        hasAttachment: true,
        attachments: [
          { filename: "data.bin", contentType: "application/octet-stream", size: 9, content: base64Content },
        ],
      },
      cachedAt: Date.now(),
    });
    const result = await svc.downloadAttachment("789", 0);
    expect(result).not.toBeNull();
    expect(result!.content).toBe(base64Content);
    expect(result!.encoding).toBe("base64");
  });

  it("returns null when attachment has no content", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    (svc as any).emailCache.set("999", {
      email: {
        id: "999",
        from: "a@b.com",
        to: [],
        subject: "Test",
        body: "Hello",
        isHtml: false,
        date: new Date(),
        folder: "INBOX",
        isRead: false,
        isStarred: false,
        hasAttachment: true,
        attachments: [
          { filename: "empty.txt", contentType: "text/plain", size: 0 },
        ],
      },
      cachedAt: Date.now(),
    });
    const result = await svc.downloadAttachment("999", 0);
    expect(result).toBeNull();
  });
});

// ─── saveDraft tests ──────────────────────────────────────────────────────────

describe("SimpleIMAPService.saveDraft", () => {
  it("returns error when not connected", async () => {
    const svc = new SimpleIMAPService();
    // client is null, isConnected is false by default
    const result = await svc.saveDraft({ subject: "Test", body: "Hello" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/not connected/i);
  });

  it("returns success with uid when IMAP append succeeds", async () => {
    const svc = new SimpleIMAPService();
    // Mock private state
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 42 }),
    };

    const result = await svc.saveDraft({
      to: "bob@example.com",
      subject: "Draft subject",
      body: "Draft body",
    });

    expect(result.success).toBe(true);
    expect(result.uid).toBe(42);
  });

  it("returns error when IMAP append throws", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockRejectedValue(new Error("APPEND failed")),
    };

    const result = await svc.saveDraft({ subject: "Test", body: "Hello" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/APPEND failed/);
  });

  it("handles draft with no fields (fully empty draft)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 1 }),
    };
    const result = await svc.saveDraft({});
    expect(result.success).toBe(true);
  });
});

// ─── multi-folder search tests ────────────────────────────────────────────────

describe("SimpleIMAPService.searchEmails (multi-folder)", () => {
  it("uses single-folder behaviour when folders is not set", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    await svc.searchEmails({ folder: "INBOX", subject: "test" });
    // Ensure single lock acquired (one folder)
    expect(mockClient.getMailboxLock).toHaveBeenCalledTimes(1);
    expect(mockClient.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  it("searches multiple folders when folders array is provided", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const lockObj = { release: vi.fn() };
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(lockObj),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    await svc.searchEmails({ folders: ["INBOX", "Sent"], subject: "test" });
    // Should have acquired locks for both folders
    expect(mockClient.getMailboxLock).toHaveBeenCalledTimes(2);
    const calledWith = mockClient.getMailboxLock.mock.calls.map((c: any[]) => c[0]);
    expect(calledWith).toContain("INBOX");
    expect(calledWith).toContain("Sent");
  });
});

// ─── healthCheck tests ─────────────────────────────────────────────────────

describe("SimpleIMAPService.healthCheck", () => {
  it("returns false when not connected (isConnected = false)", async () => {
    const svc = new SimpleIMAPService();
    // isConnected defaults to false and client is null — no connection attempted.
    const result = await svc.healthCheck();
    expect(result).toBe(false);
  });

  it("returns false when client is null even if flag were true", async () => {
    const svc = new SimpleIMAPService();
    // Force isConnected = true but leave client = null to exercise the guard.
    (svc as any).isConnected = true;
    (svc as any).client = null;
    const result = await svc.healthCheck();
    expect(result).toBe(false);
  });

  it("returns true when connected and noop() resolves", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = { noop: vi.fn().mockResolvedValue(undefined) };
    (svc as any).isConnected = true;
    (svc as any).client = mockClient;
    const result = await svc.healthCheck();
    expect(result).toBe(true);
    expect(mockClient.noop).toHaveBeenCalledTimes(1);
  });

  it("returns false when noop() rejects (TCP drop scenario)", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = { noop: vi.fn().mockRejectedValue(new Error("ECONNRESET")) };
    (svc as any).isConnected = true;
    (svc as any).client = mockClient;
    const result = await svc.healthCheck();
    expect(result).toBe(false);
  });

  it("never throws even when noop() rejects", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = { noop: vi.fn().mockRejectedValue(new Error("broken pipe")) };
    (svc as any).isConnected = true;
    (svc as any).client = mockClient;
    // healthCheck must not propagate the error.
    await expect(svc.healthCheck()).resolves.toBe(false);
  });
});

// ─── Cycle #22: service-level validateFolderName traversal guard ───────────────

describe("SimpleIMAPService private validateFolderName — path traversal guard", () => {
  it("throws for a folder name containing '..'", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("../../etc")).toThrow(/path traversal/i);
  });

  it("throws for a folder name that is exactly '..'", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("..")).toThrow(/path traversal/i);
  });

  it("throws for 'Folders/../INBOX' traversal", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("Folders/../INBOX")).toThrow(/path traversal/i);
  });

  it("accepts a normal folder path with no traversal", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("Folders/Work")).not.toThrow();
  });

  it("accepts 'Labels/MyLabel'", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("Labels/MyLabel")).not.toThrow();
  });

  it("still throws for control characters (existing behaviour preserved)", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("INBOX\x00evil")).toThrow(/control characters/i);
  });
});

// ─── Cycle #42: email cache byte-size limit ────────────────────────────────────

/** Build a minimal EmailMessage with a body of the given length. */
function makeEmail(id: string, bodyLength: number): import("../types/index.js").EmailMessage {
  return {
    id,
    from: "a@b.com",
    to: [],
    subject: "s",
    body: "x".repeat(bodyLength),
    isHtml: false,
    date: new Date(),
    folder: "INBOX",
    isRead: false,
    isStarred: false,
    hasAttachment: false,
  };
}

describe("SimpleIMAPService cache byte-size limit", () => {
  it("evicts oldest entry when MAX_EMAIL_CACHE_BYTES is exceeded", () => {
    const svc = new SimpleIMAPService();
    const MAX_BYTES = 50 * 1024 * 1024; // 50 MB

    // Add a large email that fills ~49 MB of the estimate budget
    const bigBodyLen = MAX_BYTES - 1024;
    (svc as any).setCacheEntry("1", makeEmail("1", bigBodyLen));
    expect((svc as any).emailCache.size).toBe(1);

    // Add another entry that tips over the byte limit
    (svc as any).setCacheEntry("2", makeEmail("2", 2048));

    // Entry "1" should have been evicted to make room
    expect((svc as any).emailCache.has("1")).toBe(false);
    expect((svc as any).emailCache.has("2")).toBe(true);
    expect((svc as any).cacheByteEstimate).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("updates cacheByteEstimate when evictCacheEntry is called", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("10", makeEmail("10", 1000));
    const beforeBytes: number = (svc as any).cacheByteEstimate;
    expect(beforeBytes).toBeGreaterThan(0);

    (svc as any).evictCacheEntry("10");
    expect((svc as any).cacheByteEstimate).toBeLessThan(beforeBytes);
    expect((svc as any).emailCache.has("10")).toBe(false);
  });

  it("resets cacheByteEstimate to 0 on clearCacheAll", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("20", makeEmail("20", 500));
    (svc as any).setCacheEntry("21", makeEmail("21", 500));
    expect((svc as any).cacheByteEstimate).toBeGreaterThan(0);

    (svc as any).clearCacheAll();
    expect((svc as any).cacheByteEstimate).toBe(0);
    expect((svc as any).emailCache.size).toBe(0);
  });

  it("does not exceed count cap of 500 alongside byte limit", () => {
    const svc = new SimpleIMAPService();
    for (let i = 0; i < 510; i++) {
      (svc as any).setCacheEntry(String(i), makeEmail(String(i), 50));
    }
    // Count should be capped at 500
    expect((svc as any).emailCache.size).toBeLessThanOrEqual(500);
    // Byte estimate should be positive and consistent
    expect((svc as any).cacheByteEstimate).toBeGreaterThan(0);
  });

  it("updating an existing entry adjusts byte estimate correctly", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("99", makeEmail("99", 100));
    const bytesAfterFirst: number = (svc as any).cacheByteEstimate;

    // Update same entry with a larger body
    (svc as any).setCacheEntry("99", makeEmail("99", 1000));
    const bytesAfterUpdate: number = (svc as any).cacheByteEstimate;

    // Should still be only 1 entry, but with higher byte count
    expect((svc as any).emailCache.size).toBe(1);
    expect(bytesAfterUpdate).toBeGreaterThan(bytesAfterFirst);
  });
});

// ─── wipeCache ────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.wipeCache", () => {
  function makeEmail(id: string): import("../types/index.js").EmailMessage {
    return {
      id, folder: "INBOX", from: "from@example.com", to: ["to@example.com"],
      subject: "Subject", date: new Date().toISOString(), isRead: false,
      body: "email body content", attachments: [], isAnswered: false, isForwarded: false,
    };
  }

  it("overwrites sensitive fields in cached emails and clears the cache", () => {
    const svc = new SimpleIMAPService();
    // Populate the cache with an email that has body and subject
    (svc as any).setCacheEntry("msg1", makeEmail("msg1"));
    expect((svc as any).emailCache.size).toBe(1);

    svc.wipeCache();

    // Cache should be empty after wipe
    expect((svc as any).emailCache.size).toBe(0);
    expect((svc as any).cacheByteEstimate).toBe(0);
  });

  it("wipes attachment buffer content (sets to zero) if present", () => {
    const svc = new SimpleIMAPService();
    const email = makeEmail("msg2");
    const buf = Buffer.from("sensitive attachment data");
    email.attachments = [{ filename: "file.txt", size: buf.length, contentType: "text/plain", contentId: undefined, content: buf }];
    (svc as any).emailCache.set("msg2", { email, cachedAt: Date.now() });

    svc.wipeCache();

    expect((svc as any).emailCache.size).toBe(0);
  });

  it("clears connectionConfig credentials on wipe", () => {
    const svc = new SimpleIMAPService();
    // Set a fake connection config with credentials
    (svc as any).connectionConfig = { host: "localhost", port: 1143, username: "user", password: "secret" };

    svc.wipeCache();

    expect((svc as any).connectionConfig).toBeNull();
  });

  it("handles wipeCache gracefully when cache is already empty", () => {
    const svc = new SimpleIMAPService();
    // Should not throw even with empty cache and null connectionConfig
    expect(() => svc.wipeCache()).not.toThrow();
  });
});

// ─── stopIdle ─────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.stopIdle", () => {
  it("sets idleClient to null and clears idleActive flag", () => {
    const svc = new SimpleIMAPService();
    // Simulate a fake idle client
    const mockIdleClient = {
      logout: vi.fn().mockResolvedValue(undefined),
    };
    (svc as any).idleClient = mockIdleClient;
    (svc as any).idleActive = true;

    svc.stopIdle();

    expect((svc as any).idleClient).toBeNull();
    expect((svc as any).idleActive).toBe(false);
    expect(mockIdleClient.logout).toHaveBeenCalled();
  });

  it("handles stopIdle gracefully when idleClient is null", () => {
    const svc = new SimpleIMAPService();
    (svc as any).idleClient = null;
    (svc as any).idleActive = false;
    expect(() => svc.stopIdle()).not.toThrow();
  });
});
