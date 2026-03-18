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
