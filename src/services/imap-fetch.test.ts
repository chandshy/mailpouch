/**
 * Tests for SimpleIMAPService methods that require mocking both ImapFlow
 * and mailparser (simpleParser).  These test the async fetch loops in:
 *   - getEmailById
 *   - fetchEmailFullSource (via downloadAttachment)
 *   - searchSingleFolder (via searchEmails)
 *
 * This file uses top-level vi.mock() to mock 'imapflow' and 'mailparser',
 * keeping these mocks isolated from other test files.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { SimpleIMAPService } from "./simple-imap-service.js";

// ─── Module-level mocks ──────────────────────────────────────────────────────

vi.mock("imapflow", () => {
  const ImapFlow = vi.fn(function () {
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
    };
  });
  return { ImapFlow };
});

// Mock simpleParser to return a deterministic parsed email object
vi.mock("mailparser", () => ({
  simpleParser: vi.fn().mockResolvedValue({
    text: "Hello from parser",
    html: null,
    subject: "Parsed Subject",
    date: new Date("2024-01-15"),
    from: { text: "sender@example.com" },
    to: { text: "recipient@example.com" },
    cc: null,
    attachments: [],
    headers: new Map(),
  }),
}));

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeLock() {
  return { release: vi.fn() };
}

async function* asyncYield<T>(...items: T[]) {
  for (const item of items) yield item;
}

// ─── getEmailById ─────────────────────────────────────────────────────────────

describe("SimpleIMAPService.getEmailById (fetch loop)", () => {
  it("returns email from cache if present", async () => {
    const svc = new SimpleIMAPService();
    const email = {
      id: "1", folder: "INBOX", from: "a@b.com", to: [], subject: "s",
      body: "b", date: new Date(), isRead: false, isStarred: false, hasAttachment: false, isHtml: false,
    };
    (svc as any).setCacheEntry("1", email);

    const result = await svc.getEmailById("1");
    expect(result).not.toBeNull();
    expect(result!.id).toBe("1");
  });

  it("throws IMAPNotConnectedError (not null = 'not found') when disconnected on a cache miss", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "reconnect").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(svc.getEmailById("999")).rejects.toThrow(/IMAP connection unavailable/);
  });

  it("fetches and parses email via async iterator when not cached", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = {
      uid: 42,
      source: Buffer.from("raw email bytes"),
      flags: new Set(["\\Seen"]),
    };

    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    (svc as any).client = mockClient;

    // Mock getFolders to return one folder
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 1, unreadMessages: 0, folderType: "system" as const },
    ]);
    // Mock checkAndUpdateUidValidity (no-op)
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("42");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("42");
    expect(result!.subject).toBe("Parsed Subject");
    expect(result!.body).toBe("Hello from parser");
    expect(result!.isRead).toBe(true);
    expect(result!.folder).toBe("INBOX");
  });

  it("skips messages with no source buffer", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = { uid: 50, source: null, flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("50");
    expect(result).toBeNull();
  });

  it("caches the fetched email for future lookups", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = { uid: 55, source: Buffer.from("data"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    await svc.getEmailById("55");
    // Should now be in cache under the compound key folder:uid
    expect((svc as any).emailCache.has("INBOX:55")).toBe(true);
  });

  it("returns email with attachment metadata stripped (line 778)", async () => {
    // Override simpleParser to return an email with attachments
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: "Email with attachment",
      date: new Date("2024-03-01"),
      from: { text: "a@example.com" },
      to: { text: "b@example.com" },
      cc: null,
      attachments: [
        { filename: "report.pdf", contentType: "application/pdf", size: 2048, content: Buffer.from("PDF"), cid: "cid-1" },
      ],
      headers: new Map([["x-mailer", "TestMailer"]]),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = { uid: 66, source: Buffer.from("raw"), flags: new Set(["\\Answered"]), envelope: {} };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("66");

    expect(result).not.toBeNull();
    expect(result!.hasAttachment).toBe(true);
    expect(result!.attachments).toHaveLength(1);
    // content field should be stripped from the returned value
    expect((result!.attachments![0] as any).content).toBeUndefined();
    expect(result!.attachments![0].filename).toBe("report.pdf");
  });

  it("re-throws when getMailboxLock fails (catch block line 795)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      getMailboxLock: vi.fn().mockRejectedValue(new Error("IMAP lock error")),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);

    await expect(svc.getEmailById("42")).rejects.toThrow("IMAP lock error");
  });

  it("uses false fallback for isAnswered/isForwarded when flags is undefined (lines 760-761)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: "No flags",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 76, source: Buffer.from("raw"), flags: undefined }; // no flags
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("76");
    expect(result).not.toBeNull();
    expect(result!.isAnswered).toBe(false); // flags?.has(...) ?? false → false
    expect(result!.isForwarded).toBe(false);
    expect(result!.isRead).toBe(false);
    expect(result!.isStarred).toBe(false);
  });

  it("covers getEmailById branches: cc with text, date fallback, filename fallback, headers null (lines 732-766)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: "Branch Coverage",
      date: null,                   // → line 737: parsed.date || new Date()
      from: null,                   // → line 730: from = ''
      to: null,                     // → line 731: to = []
      cc: { text: "cc@example.com" }, // → line 732: cc with text → [text]
      attachments: [
        { filename: null, contentType: "application/pdf", size: 512, content: Buffer.from("x"), cid: undefined },
        // filename=null → line 743: att.filename || 'unnamed'
      ],
      headers: null,                // → line 749: headers ? ... : undefined
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 73, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("73");
    expect(result).not.toBeNull();
    expect(result!.cc).toEqual(["cc@example.com"]); // cc with text
    expect(result!.from).toBe(""); // from null
    expect(result!.date).toBeInstanceOf(Date); // date fallback
    expect(result!.attachments![0].filename).toBe("unnamed"); // filename fallback
    expect(result!.headers).toBeUndefined(); // headers null
  });

  it("handles content-type as string for PGP detection (line 723 branch 0)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Signed body",
      html: null,
      subject: "PGP Signed",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map([
        ["content-type", "multipart/signed; protocol=\"application/pgp-signature\""],
        // string value → covers line 723 branch 0 (typeof contentType === 'string')
      ]),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 74, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("74");
    expect(result).not.toBeNull();
    expect(result!.isSignedPGP).toBe(true); // ctStr is a string with the right content
  });

  it("handles headers array values (line 753 branch 0: Array.isArray(v))", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: "Headers Test",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map([
        ["received", ["from server1", "from server2"]], // array → join(', ')
      ]),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 75, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("75");
    expect(result).not.toBeNull();
    expect(result!.headers?.["received"]).toBe("from server1, from server2"); // joined
  });

  it("uses html body when parsed.text is null (line 719 branch 1)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: null,
      html: "<b>Hello HTML</b>",
      subject: "HTML Email",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 71, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("71");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("<b>Hello HTML</b>");
    expect(result!.isHtml).toBe(true);
  });

  it("uses empty string body when both text and html are null (line 719 branch 2)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: null,
      html: null,
      subject: "Empty Body",
      date: new Date("2024-01-15"),
      from: null,
      to: null,
      cc: null,
      attachments: [],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 72, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("72");
    expect(result).not.toBeNull();
    expect(result!.body).toBe(""); // both text and html null → ''
    expect(result!.from).toBe(""); // from null → ''
    expect(result!.to).toEqual([]); // to null → []
  });
});

// ─── fetchEmailFullSource (private) with real simpleParser mock ───────────────

describe("SimpleIMAPService private fetchEmailFullSource (with parser)", () => {
  it("parses and returns email with attachments when source is present", async () => {
    // Override simpleParser to return attachments for this test
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body text",
      html: null,
      subject: "With Attachments",
      date: new Date("2024-01-15"),
      from: { text: "a@b.com" },
      to: { text: "b@c.com" },
      cc: null,
      attachments: [
        { filename: "doc.pdf", contentType: "application/pdf", size: 1024, content: Buffer.from("pdf"), cid: undefined },
      ],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = { uid: 60, source: Buffer.from("raw"), flags: new Set(["\\Flagged"]) };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);

    const result = await (svc as any).fetchEmailFullSource("60");

    expect(result).not.toBeNull();
    expect(result!.subject).toBe("With Attachments");
    expect(result!.isStarred).toBe(true);
    expect(result!.hasAttachment).toBe(true);
    expect(result!.attachments).toHaveLength(1);
    expect(result!.attachments![0].filename).toBe("doc.pdf");
  });
});

// ─── searchSingleFolder (private) ────────────────────────────────────────────

describe("SimpleIMAPService private searchSingleFolder", () => {
  it("returns empty array when client search finds no UIDs", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    const result = await (svc as any).searchSingleFolder("INBOX", {}, 50);

    expect(result).toEqual([]);
    expect(mockClient.search).toHaveBeenCalledTimes(1);
  });

  it("fetches and returns matching messages via client.fetch (in-lock fetch)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = {
      uid: 70,
      source: Buffer.from("raw email"),
      flags: new Set(["\\Seen"]),
    };

    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue([70]),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    (svc as any).client = mockClient;

    const results = await (svc as any).searchSingleFolder("INBOX", { subject: "test" }, 50);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("70");
    expect(results[0].subject).toBe("Parsed Subject");
    expect(results[0].folder).toBe("INBOX");
    expect(results[0].isRead).toBe(true);
  });

  it("covers all search criteria options", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue([]),
    };
    (svc as any).client = mockClient;

    // Pass all available search options to cover the criteria-building code
    const options = {
      from: "alice@example.com",
      to: "bob@example.com",
      subject: "Hello",
      body: "world",
      text: "searchable",
      bcc: "hidden@example.com",
      header: { field: "X-Custom", value: "value" },
      dateFrom: "2024-01-01",
      dateTo: "2024-12-31",
      isRead: true,
      isStarred: false,
      answered: true,
      isDraft: false,
      larger: 1000,
      smaller: 100000,
      sentBefore: new Date("2024-12-31"),
      sentSince: new Date("2024-01-01"),
    };

    await (svc as any).searchSingleFolder("INBOX", options, 50);

    // The search should have been called with populated criteria
    expect(mockClient.search).toHaveBeenCalledTimes(1);
    const criteria = mockClient.search.mock.calls[0][0];
    expect(criteria.from).toBe("alice@example.com");
    expect(criteria.subject).toBe("Hello");
    expect(criteria.seen).toBe(true);
    expect(criteria.flagged).toBe(false);
  });

  it("respects the limit parameter (slices UID array before fetching)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    // 5 UIDs returned by search, limit=2 → only first 2 are fetched
    const mockFetch = vi.fn().mockReturnValue(asyncYield()); // yields nothing → no results
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5]),
      fetch: mockFetch,
    };
    (svc as any).client = mockClient;

    const results = await (svc as any).searchSingleFolder("INBOX", {}, 2);
    // With limit=2, fetch is called at most 2 times (once per UID)
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(results).toHaveLength(0);
  });

  it("keeps the NEWEST matches when more than `limit` match, newest first", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockFetch = vi.fn().mockReturnValue(asyncYield());
    const mockClient = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue([1, 2, 3, 4, 5]),
      fetch: mockFetch,
    };
    (svc as any).client = mockClient;

    await (svc as any).searchSingleFolder("INBOX", {}, 2);

    expect(mockFetch.mock.calls.map((c: unknown[]) => c[0])).toEqual(["5", "4"]);
    expect(mockClient.search.mock.calls[0][1]).toMatchObject({ returnOptions: [{ partial: "-1:-2" }] });
  });

  it("returns [] immediately when client is null (line 805)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).client = null;

    const results = await (svc as any).searchSingleFolder("INBOX", {}, 50);
    expect(results).toEqual([]);
  });

  it("returns [] when search() returns a non-array (line 857 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue(null), // not an array → branch 1 → []
    };

    const results = await (svc as any).searchSingleFolder("INBOX", {}, 50);
    expect(results).toEqual([]);
  });

  it("skips invalid dateTo date string (line 825 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      search: vi.fn().mockResolvedValue([]),
    };

    await (svc as any).searchSingleFolder("INBOX", { dateTo: "invalid-date" }, 50);
    const criteria = (svc as any).client.search.mock.calls[0][0];
    expect(criteria.before).toBeUndefined(); // invalid date → skipped
  });
});

// ─── fetchEmailFullSource: fallback branches ──────────────────────────────────

describe("SimpleIMAPService private fetchEmailFullSource fallback branches", () => {
  it("uses html body when text is null, cc with text, date fallback, no subject (lines 1060-1070)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: null,
      html: "<b>html</b>",        // → line 1060: parsed.text || parsed.html → html
      subject: null,              // → line 1066: || '(No Subject)'
      date: null,                 // → line 1070: || new Date()
      from: null,                 // → line 1063: || ''
      to: null,                   // → line 1064: [] branch
      cc: { text: "cc@example.com" }, // → line 1065: [text] branch
      attachments: [],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 90, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);

    const result = await (svc as any).fetchEmailFullSource("90");
    expect(result).not.toBeNull();
    expect(result!.body).toBe("<b>html</b>"); // html branch
    expect(result!.subject).toBe("(No Subject)"); // null subject fallback
    expect(result!.from).toBe(""); // null from fallback
    expect(result!.cc).toEqual(["cc@example.com"]); // cc with text
    expect(result!.date).toBeInstanceOf(Date); // null date fallback
  });

  it("uses '' body when both text and html are null (line 1060 branch 2)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: null,
      html: null,               // → line 1060: '' fallback
      subject: "Empty",
      date: new Date(),
      from: { text: "a@b.com" },
      to: { text: "b@c.com" },
      cc: null,
      attachments: [
        { filename: null, contentType: "application/pdf", size: 0, content: Buffer.from(""), cid: undefined },
        // filename null → line 1076: || 'unnamed'
      ],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 91, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);

    const result = await (svc as any).fetchEmailFullSource("91");
    expect(result).not.toBeNull();
    expect(result!.body).toBe(""); // both text and html null → ''
    expect(result!.attachments![0].filename).toBe("unnamed"); // null filename fallback
  });
});

// ─── getEmailById: additional branch coverage ─────────────────────────────────

describe("SimpleIMAPService.getEmailById additional branches", () => {
  it("uses (No Subject) fallback when parsed.subject is null (line 733 branch1)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: null, // → line 733: parsed.subject || '(No Subject)'
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 95, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("95");
    expect(result).not.toBeNull();
    expect(result!.subject).toBe("(No Subject)");
  });

  it("sets protonId when x-pm-internal-id header is a string (line 766 branch0)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: "Proton Email",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map([
        ["x-pm-internal-id", " proton-stable-id-abc "], // string → branch0 → pmId.trim()
      ]),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 96, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("96");
    expect(result).not.toBeNull();
    expect(result!.protonId).toBe("proton-stable-id-abc");
  });

  it("detects PGP encrypted email (line 764: ctStr includes multipart/encrypted)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Encrypted body",
      html: null,
      subject: "PGP Encrypted",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: [],
      headers: new Map([
        ["content-type", "multipart/encrypted; protocol=\"application/pgp-encrypted\""],
      ]),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 97, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("97");
    expect(result).not.toBeNull();
    expect(result!.isEncryptedPGP).toBe(true);
  });

  it("handles undefined attachments from parser (line 773: attachments?.length ?? 0)", async () => {
    const { simpleParser } = await import("mailparser");
    (simpleParser as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: "Body",
      html: null,
      subject: "No Attachments",
      date: new Date("2024-01-15"),
      from: { text: "sender@example.com" },
      to: { text: "recipient@example.com" },
      cc: null,
      attachments: undefined, // → attachments?.map() = undefined → attachments?.length undefined → ?? 0
      headers: new Map(),
    });

    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    const mockMessage = { uid: 98, source: Buffer.from("raw"), flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const result = await svc.getEmailById("98");
    expect(result).not.toBeNull();
    expect(result!.hasAttachment).toBe(false);
    expect(result!.attachments).toBeUndefined();
  });
});

// ─── fetchEmailFullSource: null source branch ─────────────────────────────────

describe("SimpleIMAPService private fetchEmailFullSource null source", () => {
  it("returns null when fetch yields a message with no source (line 1058)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;

    const mockMessage = { uid: 88, source: null, flags: new Set() };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      fetch: vi.fn().mockReturnValue(asyncYield(mockMessage)),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" as const },
    ]);

    const result = await (svc as any).fetchEmailFullSource("88");
    expect(result).toBeNull();
  });
});
