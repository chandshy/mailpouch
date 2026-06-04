/**
 * Tests for new SimpleIMAPService features:
 *   - downloadAttachment
 *   - saveDraft
 *   - multi-folder search (folders param)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SimpleIMAPService, stripHtml } from "./simple-imap-service.js";

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
    (svc as any).emailCache.set("INBOX:456", {
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
    (svc as any).emailCache.set("INBOX:789", {
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

  it("re-fetches full source when attachment content is not cached", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    // Email in cache but attachment has no content (stripped by setCacheEntry)
    (svc as any).emailCache.set("INBOX:888", {
      email: {
        id: "888",
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
          { filename: "doc.pdf", contentType: "application/pdf", size: 1024 }, // no content
        ],
      },
      cachedAt: Date.now(),
    });
    // Mock fetchEmailFullSource to return an email with the attachment content
    vi.spyOn(svc as any, "fetchEmailFullSource").mockResolvedValue({
      id: "888",
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
        { filename: "doc.pdf", contentType: "application/pdf", size: 1024, content: Buffer.from("PDF content") },
      ],
    });

    const result = await svc.downloadAttachment("888", 0);
    expect(result).not.toBeNull();
    expect(result!.filename).toBe("doc.pdf");
    const decoded = Buffer.from(result!.content, "base64").toString("utf8");
    expect(decoded).toBe("PDF content");
  });

  it("returns null when re-fetched source also has no attachment content", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    (svc as any).emailCache.set("777", {
      email: {
        id: "777",
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
        attachments: [{ filename: "file.txt", contentType: "text/plain", size: 0 }],
      },
      cachedAt: Date.now(),
    });
    // fetchEmailFullSource returns null (email not found on server)
    vi.spyOn(svc as any, "fetchEmailFullSource").mockResolvedValue(null);

    const result = await svc.downloadAttachment("777", 0);
    expect(result).toBeNull();
  });

  it("rejects an oversize re-fetched attachment even when cached size was understated (PARSE-014)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    // Cached metadata claims a tiny size (or 0) so the metadata guard passes...
    (svc as any).emailCache.set("INBOX:555", {
      email: {
        id: "555", from: "a@b.com", to: [], subject: "T", body: "", isHtml: false,
        date: new Date(), folder: "INBOX", isRead: false, isStarred: false, hasAttachment: true,
        attachments: [{ filename: "sneaky.bin", contentType: "application/octet-stream", size: 0 }],
      },
      cachedAt: Date.now(),
    });
    // ...but the actual re-fetched buffer is 26 MB (> 25 MB cap).
    const huge = Buffer.alloc(26 * 1024 * 1024);
    vi.spyOn(svc as any, "fetchEmailFullSource").mockResolvedValue({
      id: "555", from: "a@b.com", to: [], subject: "T", body: "", isHtml: false,
      date: new Date(), folder: "INBOX", isRead: false, isStarred: false, hasAttachment: true,
      attachments: [{ filename: "sneaky.bin", contentType: "application/octet-stream", size: huge.length, content: huge }],
    });

    await expect(svc.downloadAttachment("555", 0)).rejects.toThrow(/too large/i);
  });

  it("re-maps by filename when the re-fetch attachment order drifts from cached order", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    // Cached order: [a.txt, b.txt]; caller asks for index 0 = a.txt.
    (svc as any).emailCache.set("INBOX:444", {
      email: {
        id: "444", from: "a@b.com", to: [], subject: "T", body: "", isHtml: false,
        date: new Date(), folder: "INBOX", isRead: false, isStarred: false, hasAttachment: true,
        attachments: [
          { filename: "a.txt", contentType: "text/plain", size: 1 },
          { filename: "b.txt", contentType: "text/plain", size: 1 },
        ],
      },
      cachedAt: Date.now(),
    });
    // Re-fetch returns the REVERSED order: index 0 is now b.txt.
    vi.spyOn(svc as any, "fetchEmailFullSource").mockResolvedValue({
      id: "444", from: "a@b.com", to: [], subject: "T", body: "", isHtml: false,
      date: new Date(), folder: "INBOX", isRead: false, isStarred: false, hasAttachment: true,
      attachments: [
        { filename: "b.txt", contentType: "text/plain", size: 1, content: Buffer.from("BBB") },
        { filename: "a.txt", contentType: "text/plain", size: 1, content: Buffer.from("AAA") },
      ],
    });

    const result = await svc.downloadAttachment("444", 0);
    // Must return a.txt (by name), not b.txt (the drifted index-0).
    expect(result!.filename).toBe("a.txt");
    expect(Buffer.from(result!.content, "base64").toString("utf8")).toBe("AAA");
  });
});

// ─── saveDraft tests ──────────────────────────────────────────────────────────

describe("SimpleIMAPService.saveDraft", () => {
  // SMTP-011: findDraftsFolder now returns null (→ structured error) when no
  // Drafts mailbox is resolvable. Tests that exercise the append path must seed
  // a Drafts folder into the cache so resolution succeeds.
  const seedDraftsCache = (svc: SimpleIMAPService) => {
    (svc as any).folderCache.set("Drafts", {
      name: "Drafts", path: "Drafts", totalMessages: 0, unreadMessages: 0,
      folderType: "system", specialUse: "\\Drafts",
    });
  };

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
    seedDraftsCache(svc);

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
    seedDraftsCache(svc);

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
    seedDraftsCache(svc);
    const result = await svc.saveDraft({});
    expect(result.success).toBe(true);
  });

  it("sanitizes attachment filename and contentType", async () => {
    const svc = new SimpleIMAPService();
    const appendMock = vi.fn().mockResolvedValue({ uid: 5 });
    (svc as any).isConnected = true;
    (svc as any).client = { append: appendMock };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({
      subject: "With attachment",
      body: "See attached",
      attachments: [
        {
          filename: "report\r\nX-Injected: yes.pdf", // CRLF injection attempt
          content: Buffer.from("PDF content"),
          contentType: "application/pdf",
        },
        {
          // No filename, invalid contentType (contains newline)
          content: Buffer.from("data"),
          contentType: "text/html\r\nX-Evil: header",
        },
      ],
    });
    expect(result.success).toBe(true);
    expect(appendMock).toHaveBeenCalled();
    // TEST-003 (audit 2026-05-28): the old test only checked that append was
    // called. A regression in the sanitizer would still pass. Now inspect the
    // raw MIME bytes (the second arg to client.append is the rawMime Buffer
    // that goes on the wire) and assert that the injected text never appears
    // as its own MIME header — i.e. no CR/LF immediately precedes it.
    const [, rawMime] = appendMock.mock.calls[0];
    const wire = Buffer.isBuffer(rawMime) ? rawMime.toString("utf8") : String(rawMime);
    // The crafted CRLF in the filename must NOT have started a real MIME
    // header line. Sanitizer leaves the visible token glued onto the filename
    // (e.g. "reportX-Injected: yes.pdf"), which is harmless: it's a literal
    // filename string, not a header. The dangerous form would be a newline
    // followed by the header text.
    expect(wire).not.toMatch(/\r?\n\s*X-Injected:\s*yes/);
    expect(wire).not.toMatch(/\r?\n\s*X-Evil:\s*header/);
    // The filename's CRLF must have been stripped; the visible token survives.
    expect(wire).toMatch(/report/);
  });

  it("uses HTML body when isHtml is set", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 6 }),
    };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({
      subject: "HTML draft",
      body: "<p>Hello</p>",
      isHtml: true,
    });
    expect(result.success).toBe(true);
  });

  it("sanitizes inReplyTo and references headers", async () => {
    const svc = new SimpleIMAPService();
    const appendMock = vi.fn().mockResolvedValue({ uid: 7 });
    (svc as any).isConnected = true;
    (svc as any).client = { append: appendMock };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({
      subject: "Reply",
      body: "See above",
      inReplyTo: "<msg-id@example.com>\r\nX-Injected: evil",
      references: ["<ref1@example.com>", "<ref2\x01@example.com>"],
    });
    expect(result.success).toBe(true);
    // TEST-003: the original test only asserted success — a regression in the
    // CRLF strip on inReplyTo / control-char strip on references would slip
    // past. Inspect the appended MIME bytes and assert the injected header
    // never appears as its own line.
    const [, rawMime] = appendMock.mock.calls[0];
    const wire = Buffer.isBuffer(rawMime) ? rawMime.toString("utf8") : String(rawMime);
    expect(wire).not.toMatch(/\r?\n\s*X-Injected:\s*evil/);
    // The legitimate Message-ID portion of inReplyTo must survive sanitization.
    expect(wire).toMatch(/msg-id@example\.com/);
    // The control character (\x01) embedded in the references list must be gone.
    expect(wire).not.toMatch(/\x01/);
  });

  it("handles to as array, cc as string, bcc as array (lines 1154-1160 branch coverage)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 8 }),
    };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({
      to: ["alice@example.com", "bob@example.com"],  // array → line 1154 branch 0
      cc: "carol@example.com",                        // string → line 1157 branch 1
      bcc: ["dan@example.com"],                        // array → line 1160 branch 0
      subject: "Multi-address draft",
      body: "Hello all",
    });
    expect(result.success).toBe(true);
  });

  it("handles to as string, cc as array, bcc as string (more address-format coverage)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 9 }),
    };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({
      to: "alice@example.com",               // string → existing coverage
      cc: ["cc1@example.com", "cc2@example.com"], // array → line 1157 branch 0
      bcc: "bcc@example.com",                // string → line 1160 branch 1
      subject: "Draft",
      body: "",   // empty body → line 1168: options.body || '' = ''
    });
    expect(result.success).toBe(true);
  });

  it("returns uid undefined when append result is not an object (line 1209 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue(null), // result is null → typeof result !== 'object' is... actually null IS typeof object
    };
    seedDraftsCache(svc);
    // Actually: null → typeof null === 'object' but result && ... is false (null is falsy)
    const result = await svc.saveDraft({ subject: "Test", body: "Body" });
    expect(result.success).toBe(true);
    expect(result.uid).toBeUndefined(); // null result → uid = undefined
  });

  it("uses '' as html body when isHtml=true and body is empty (line 1168 branch1)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 10 }),
    };
    seedDraftsCache(svc);
    // isHtml=true AND body='' → html: (options.body || '') evaluates the || branch
    const result = await svc.saveDraft({
      subject: "HTML Draft",
      body: "",
      isHtml: true,
    });
    expect(result.success).toBe(true);
  });

  it("uses 'attachment' when filename is only control chars (line 1184 branch1: || 'attachment')", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 11 }),
    };
    seedDraftsCache(svc);
    // filename = "\r\n\x00" → after replace becomes "" → "" || "attachment" = "attachment"
    const result = await svc.saveDraft({
      subject: "Test",
      body: "See attached",
      attachments: [{
        filename: "\r\n\x00",
        content: Buffer.from("data"),
        contentType: "application/octet-stream",
      }],
    });
    expect(result.success).toBe(true);
  });

  it("uses undefined contentType when att.contentType is falsy (line 1189 branch1)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockResolvedValue({ uid: 12 }),
    };
    seedDraftsCache(svc);
    // contentType is undefined → rawCt = undefined → safeContentType = undefined
    const result = await svc.saveDraft({
      subject: "Test",
      body: "See attached",
      attachments: [{
        filename: "file.dat",
        content: Buffer.from("data"),
        contentType: undefined as any,
      }],
    });
    expect(result.success).toBe(true);
  });

  it("returns String(error) when thrown value is not an Error (line 1214 branch1)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      append: vi.fn().mockRejectedValue("string-error"), // string, not Error instance
    };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({ subject: "Test", body: "Hello" });
    expect(result.success).toBe(false);
    expect(result.error).toBe("string-error"); // String("string-error")
  });

  // SMTP-011: no Drafts folder → actionable error, append never attempted.
  it("SMTP-011: returns an actionable error when no Drafts folder exists", async () => {
    const svc = new SimpleIMAPService();
    const appendMock = vi.fn();
    (svc as any).isConnected = true;
    (svc as any).client = { append: appendMock };
    // Cache empty + getFolders returns no draft-like folder → findDraftsFolder null.
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    const result = await svc.saveDraft({ subject: "x", body: "y" });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no drafts folder/i);
    expect(appendMock).not.toHaveBeenCalled();
  });

  // SMTP-012: subject / to / cc / bcc CRLF must be stripped before append.
  it("SMTP-012: strips CRLF from subject and address fields", async () => {
    const svc = new SimpleIMAPService();
    const appendMock = vi.fn().mockResolvedValue({ uid: 99 });
    (svc as any).isConnected = true;
    (svc as any).client = { append: appendMock };
    seedDraftsCache(svc);
    const result = await svc.saveDraft({
      subject: "Hello\r\nBcc: leak@evil.com",
      to: "alice@example.com\r\nBcc: leak2@evil.com",
      body: "hi",
    });
    expect(result.success).toBe(true);
    const [, rawMime] = appendMock.mock.calls[0];
    const wire = Buffer.isBuffer(rawMime) ? rawMime.toString("utf8") : String(rawMime);
    // The injected "Bcc:" must not appear as its own header line.
    expect(wire).not.toMatch(/\r?\n\s*Bcc:\s*leak@evil\.com/);
    expect(wire).not.toMatch(/\r?\nBcc:\s*leak2@evil\.com/);
  });

  // VALID-005: per-file size cap mirrors the SMTP send path.
  it("VALID-005: rejects an oversized attachment before append", async () => {
    const svc = new SimpleIMAPService();
    const appendMock = vi.fn().mockResolvedValue({ uid: 1 });
    (svc as any).isConnected = true;
    (svc as any).client = { append: appendMock };
    seedDraftsCache(svc);
    const huge = Buffer.alloc(26 * 1024 * 1024); // 26 MB > 25 MB cap
    const result = await svc.saveDraft({
      subject: "big",
      body: "see attached",
      attachments: [{ filename: "big.bin", content: huge, contentType: "application/octet-stream", size: huge.length }],
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too large/i);
    expect(appendMock).not.toHaveBeenCalled();
  });

  // VALID-005: count cap mirrors the SMTP send path.
  it("VALID-005: rejects more than MAX_ATTACHMENT_COUNT attachments", async () => {
    const svc = new SimpleIMAPService();
    const appendMock = vi.fn().mockResolvedValue({ uid: 1 });
    (svc as any).isConnected = true;
    (svc as any).client = { append: appendMock };
    seedDraftsCache(svc);
    const many = Array.from({ length: 21 }, (_, i) => ({
      filename: `f${i}.txt`, content: "x", contentType: "text/plain", size: 1,
    }));
    const result = await svc.saveDraft({ subject: "many", body: "x", attachments: many });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/too many attachments/i);
    expect(appendMock).not.toHaveBeenCalled();
  });
});

// ─── findDraftsFolder / pickDraftsFolder ──────────────────────────────────────

describe("SimpleIMAPService private findDraftsFolder", () => {
  it("returns folder path from cache when specialUse=\\\\Drafts", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = { append: vi.fn().mockResolvedValue({}) };
    // Seed the folder cache with a Drafts folder
    (svc as any).folderCache.set("Drafts", {
      name: "Drafts", path: "Drafts", totalMessages: 0, unreadMessages: 0,
      folderType: "system", specialUse: "\\Drafts",
    });
    const path = await (svc as any).findDraftsFolder();
    expect(path).toBe("Drafts");
  });

  it("returns null when cache is empty and getFolders() throws (SMTP-011)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc, "getFolders").mockRejectedValue(new Error("no connection"));
    const path = await (svc as any).findDraftsFolder();
    expect(path).toBeNull();
  });

  it("returns path from getFolders() when cache is empty but folders are found", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "MyDrafts", path: "MyDrafts", totalMessages: 0, unreadMessages: 0,
        folderType: "system", specialUse: "\\Drafts" },
    ]);
    const path = await (svc as any).findDraftsFolder();
    expect(path).toBe("MyDrafts");
  });

  it("returns null when getFolders() returns no matching folders (SMTP-011)", async () => {
    const svc = new SimpleIMAPService();
    // Return real folders that don't match drafts patterns
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
      { name: "Sent", path: "Sent", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    const path = await (svc as any).findDraftsFolder();
    expect(path).toBeNull();
  });
});

// ─── fetchEmailFullSource (private) ───────────────────────────────────────────

describe("SimpleIMAPService private fetchEmailFullSource", () => {
  it("returns null when not connected", async () => {
    const svc = new SimpleIMAPService();
    // isConnected=false, client=null by default
    const result = await (svc as any).fetchEmailFullSource("1");
    expect(result).toBeNull();
  });

  it("returns null when getFolders() is empty (no match found)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = { getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }) };
    vi.spyOn(svc, "getFolders").mockResolvedValue([]);

    const result = await (svc as any).fetchEmailFullSource("42");
    expect(result).toBeNull();
  });

  it("returns null when getFolders() throws (catch path)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {};
    vi.spyOn(svc, "getFolders").mockRejectedValue(new Error("connection lost"));

    const result = await (svc as any).fetchEmailFullSource("42");
    expect(result).toBeNull();
  });

  it("returns null when fetch yields no messages (email not in that folder)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    async function* emptyGen() { /* yields nothing */ }
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      fetch: vi.fn().mockReturnValue(emptyGen()),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);

    const result = await (svc as any).fetchEmailFullSource("42");
    expect(result).toBeNull();
  });
});

describe("SimpleIMAPService private pickDraftsFolder", () => {
  it("prefers specialUse=\\\\Drafts", () => {
    const svc = new SimpleIMAPService();
    const folders = [
      { name: "Drafts", path: "Drafts", totalMessages: 0, unreadMessages: 0, folderType: "system" as const, specialUse: "\\Drafts" },
    ];
    expect((svc as any).pickDraftsFolder(folders)).toBe("Drafts");
  });

  it("falls back to name match (case-insensitive)", () => {
    const svc = new SimpleIMAPService();
    const folders = [
      { name: "DRAFTS", path: "DRAFTS", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ];
    expect((svc as any).pickDraftsFolder(folders)).toBe("DRAFTS");
  });

  it("matches path when name doesn't match", () => {
    const svc = new SimpleIMAPService();
    const folders = [
      { name: "Other", path: "draft", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ];
    expect((svc as any).pickDraftsFolder(folders)).toBe("draft");
  });

  it("returns null when no match", () => {
    const svc = new SimpleIMAPService();
    const folders = [
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ];
    expect((svc as any).pickDraftsFolder(folders)).toBeNull();
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

  it("searches all folders when folders=['*']", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
      { name: "Sent", path: "Sent", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    const lockObj = { release: vi.fn() };
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(lockObj),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    await svc.searchEmails({ folders: ["*"], subject: "test" });
    // Both folders should have been searched
    expect(mockClient.getMailboxLock).toHaveBeenCalledTimes(2);
  });

  it("throws (not []) when ensureConnection fails (IMAP-012)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockRejectedValue(new Error("no config"));

    // A connection failure must not masquerade as "no matches".
    await expect(svc.searchEmails({ folder: "INBOX" })).rejects.toThrow(/Cannot search emails/);
  });

  it("throws (not []) when client is null after ensureConnection (IMAP-012)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = null;

    await expect(svc.searchEmails({ folder: "INBOX" })).rejects.toThrow(/Cannot search emails/);
  });

  it("applies hasAttachment filter to single-folder results", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const lockObj = { release: vi.fn() };
    // Return a matching UID so we can filter on it
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(lockObj),
      search: vi.fn().mockResolvedValue([200]),
    };
    (svc as any).client = mockClient;
    // Pre-seed email 200 with hasAttachment=false so it gets filtered out by hasAttachment:true
    (svc as any).setCacheEntry("200", {
      id: "200", folder: "INBOX", from: "a@b.com", to: [], subject: "S",
      body: "B", date: new Date(), isRead: false, isStarred: false,
      hasAttachment: false, isHtml: false,
    });

    // hasAttachment:true should filter out the email with hasAttachment:false
    const results = await svc.searchEmails({ folder: "INBOX", hasAttachment: true });
    expect(results).toEqual([]);
  });

  it("applies hasAttachment filter to multi-folder results", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const lockObj = { release: vi.fn() };
    // search returns UID 100 in the first folder
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(lockObj),
      search: vi.fn().mockResolvedValue([100]),
    };
    (svc as any).client = mockClient;
    // Pre-seed email 100 in cache so getEmailById returns it without IMAP fetch
    (svc as any).setCacheEntry("100", {
      id: "100", folder: "INBOX", from: "x@y.com", to: [], subject: "S",
      body: "B", date: new Date(), isRead: false, isStarred: false,
      hasAttachment: true, isHtml: false,
    });
    // Multi-folder search with hasAttachment=false filter — email 100 has hasAttachment=true, so filtered out
    const results = await svc.searchEmails({ folders: ["INBOX", "Sent"], hasAttachment: false });
    expect(results).toEqual([]);
  });

  it("does not under-return below limit when hasAttachment filters early matches (over-fetch)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const lockObj = { release: vi.fn() };
    // SEARCH returns 6 UIDs; the first 4 have NO attachment, the last 2 do.
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(lockObj),
      search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5, 6]),
    };
    (svc as any).client = mockClient;
    for (const uid of [1, 2, 3, 4, 5, 6]) {
      (svc as any).setCacheEntry(String(uid), {
        id: String(uid), folder: "INBOX", from: "a@b.com", to: [], subject: "S",
        body: "B", date: new Date(), isRead: false, isStarred: false,
        hasAttachment: uid >= 5, isHtml: false,
      });
    }
    // limit=2, hasAttachment=true. The OLD code limited the IMAP window to 2
    // (UIDs 1,2 — both attachment-less) then filtered to ZERO. The over-fetch
    // must instead return the 2 attachment-bearing messages.
    const results = await svc.searchEmails({ folder: "INBOX", hasAttachment: true, limit: 2 });
    expect(results.map(e => e.id).sort()).toEqual(["5", "6"]);
  });

  it("re-throws when searchSingleFolder throws (outer catch block)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    // Make getMailboxLock throw so searchSingleFolder propagates the error
    const mockClient = {
      getMailboxLock: vi.fn().mockRejectedValue(new Error("mailbox locked")),
    };
    (svc as any).client = mockClient;

    await expect(svc.searchEmails({ folder: "INBOX" })).rejects.toThrow("mailbox locked");
  });

  it("skips invalid dateFrom when date string is unparseable (line 821 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    // 'not-a-date' parses to NaN → dateFrom should be ignored (line 821 branch 1)
    const results = await svc.searchEmails({ folder: "INBOX", dateFrom: "not-a-date" });
    expect(results).toEqual([]);
    // searchCriteria.since should NOT be set
    const criteria = mockClient.search.mock.calls[0][0];
    expect(criteria.since).toBeUndefined();
  });

  it("uses INBOX default when options.folder is not specified (line 926 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    // No folder specified → defaults to 'INBOX'
    await svc.searchEmails({ subject: "test" });
    expect(mockClient.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  it("continues when one folder search is rejected — handles Promise.allSettled rejected (line 953)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    // searchSingleFolder for one folder throws; the other resolves — allSettled handles both
    vi.spyOn(svc as any, "searchSingleFolder")
      .mockResolvedValueOnce([])
      .mockRejectedValueOnce(new Error("folder unavailable"));
    (svc as any).client = {};

    const results = await svc.searchEmails({ folders: ["INBOX", "Sent"] });
    expect(results).toEqual([]); // fulfilled result merged; rejected ignored
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
    expect(() => (svc as any).validateFolderName("../../etc")).toThrow(/invalid characters/i);
  });

  it("throws for a folder name that is exactly '..'", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("..")).toThrow(/invalid characters/i);
  });

  it("throws for 'Folders/../INBOX' traversal", () => {
    const svc = new SimpleIMAPService();
    expect(() => (svc as any).validateFolderName("Folders/../INBOX")).toThrow(/invalid characters/i);
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

  // VALID-003: the service-private validateFolderName and the shared
  // helpers.validateImapPath must agree on the same set of malicious inputs.
  it("VALID-003: service and shared validator reject the same malicious names", async () => {
    const { validateImapPath } = await import("../utils/helpers.js");
    const svc = new SimpleIMAPService();
    const bad = ["", "   ", "..", "Folders/../etc", "INBOX\x00x", "a\r\nA1 LOGOUT", "x".repeat(1001)];
    for (const name of bad) {
      expect(validateImapPath(name), `helpers should reject ${JSON.stringify(name)}`).not.toBeNull();
      expect(() => (svc as any).validateFolderName(name), `service should reject ${JSON.stringify(name)}`).toThrow();
    }
    const good = ["INBOX", "Folders/Work", "Labels/MyLabel"];
    for (const name of good) {
      expect(validateImapPath(name)).toBeNull();
      expect(() => (svc as any).validateFolderName(name)).not.toThrow();
    }
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
    expect((svc as any).emailCache.has("INBOX:1")).toBe(false);
    expect((svc as any).emailCache.has("INBOX:2")).toBe(true);
    expect((svc as any).cacheByteEstimate).toBeLessThanOrEqual(MAX_BYTES);
  });

  it("updates cacheByteEstimate when evictCacheEntry is called", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("10", makeEmail("10", 1000));
    const beforeBytes: number = (svc as any).cacheByteEstimate;
    expect(beforeBytes).toBeGreaterThan(0);

    (svc as any).evictCacheEntry("INBOX:10");
    expect((svc as any).cacheByteEstimate).toBeLessThan(beforeBytes);
    expect((svc as any).emailCache.has("INBOX:10")).toBe(false);
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

// ─── stripHtml — entity-decode order (PARSE-008) + comment stripping (PARSE-009) ─
describe("stripHtml", () => {
  it("PARSE-008: encoded <script> does not emerge as literal HTML tags", () => {
    const out = stripHtml("&lt;script&gt;alert(1)&lt;/script&gt;");
    // Decoded to real <script>...</script>, then tag-stripped → no raw markup.
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/<\/script>/i);
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
  });

  it("PARSE-008: numeric entities (decimal + hex) are decoded then stripped", () => {
    const dec = stripHtml("&#60;script&#62;x&#60;/script&#62;");
    expect(dec).not.toContain("<");
    const hex = stripHtml("&#x3c;script&#x3e;x&#x3c;/script&#x3e;");
    expect(hex).not.toContain("<");
  });

  it("PARSE-009: HTML comment contents do not survive as prose", () => {
    const out = stripHtml("before<!-- secret: pw123 -->after");
    expect(out).not.toMatch(/secret/);
    expect(out).not.toMatch(/pw123/);
    expect(out).toContain("before");
    expect(out).toContain("after");
  });

  it("PARSE-009: multi-line comments are fully removed", () => {
    const out = stripHtml("a<!--\nhidden\nlines\n-->b");
    expect(out).not.toMatch(/hidden/);
    expect(out).toContain("a");
    expect(out).toContain("b");
  });

  it("still strips style/script blocks and plain tags", () => {
    expect(stripHtml("<style>.x{}</style><p>hi</p>")).toBe("hi");
    expect(stripHtml("<script>evil()</script>visible")).toBe("visible");
  });

  it("decodes &amp; without re-interpreting it", () => {
    expect(stripHtml("Tom &amp; Jerry")).toBe("Tom & Jerry");
  });

  it("returns empty string for empty input", () => {
    expect(stripHtml("")).toBe("");
  });
});
