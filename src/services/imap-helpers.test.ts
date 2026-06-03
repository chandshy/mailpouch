import { describe, it, expect } from "vitest";
import type { ParsedMail } from "mailparser";
import { buildEmailMessage, verifyRelocatedMessages, stripHtml, truncateBody, normalizeAddressList } from "./imap-helpers.js";
import type { RelocationJob } from "./imap-helpers.js";

/** Minimal ParsedMail factory — only the fields buildEmailMessage reads. */
function parsed(over: Partial<ParsedMail> & { headerEntries?: [string, unknown][] } = {}): ParsedMail {
  const headers = new Map<string, unknown>(over.headerEntries ?? []);
  return {
    from: over.from,
    to: over.to,
    cc: over.cc,
    subject: over.subject,
    text: over.text,
    html: over.html,
    date: over.date,
    attachments: over.attachments ?? [],
    headers,
    inReplyTo: over.inReplyTo,
    references: over.references,
    messageId: over.messageId,
  } as unknown as ParsedMail;
}
const addr = (text: string) => ({ text } as never);
const msg = (uid: number, flags: string[] = []) => ({ uid, flags: new Set(flags) });

describe("buildEmailMessage", () => {
  it("maps the core fields from a parsed text message", () => {
    const e = buildEmailMessage(
      msg(42, ["\\Seen", "\\Flagged"]),
      parsed({
        from: addr("Alice <a@x.com>"),
        to: addr("b@x.com"),
        subject: "Hi",
        text: "hello world",
        date: new Date("2026-06-03T12:00:00Z"),
        messageId: "<m1@x.com>",
      }),
      "Folders/Work",
    );
    expect(e.id).toBe("42");
    expect(e.from).toBe("Alice <a@x.com>");
    expect(e.to).toEqual(["b@x.com"]);
    expect(e.subject).toBe("Hi");
    expect(e.body).toBe("hello world");
    expect(e.bodyPreview).toBe("hello world");
    expect(e.folder).toBe("Folders/Work");
    expect(e.isRead).toBe(true);
    expect(e.isStarred).toBe(true);
    expect(e.isHtml).toBe(false);
    expect(e.messageId).toBe("<m1@x.com>");
    expect(e.date).toEqual(new Date("2026-06-03T12:00:00Z"));
  });

  it("defaults missing fields safely", () => {
    const e = buildEmailMessage(msg(1), parsed({}), "INBOX");
    expect(e.from).toBe("");
    expect(e.to).toEqual([]);
    expect(e.cc).toEqual([]);
    expect(e.subject).toBe("(No Subject)");
    expect(e.body).toBe("");
    expect(e.isRead).toBe(false);
    expect(e.isStarred).toBe(false);
    expect(e.hasAttachment).toBe(false);
    expect(e.messageId).toBeUndefined();
    expect(e.protonId).toBeUndefined();
    expect(e.date).toBeInstanceOf(Date);
  });

  it("flattens multiple To/CC header lines (IMAP-007)", () => {
    const e = buildEmailMessage(
      msg(2),
      parsed({ to: [addr("a@x.com"), addr("b@x.com")], cc: [addr("c@x.com")] }),
      "INBOX",
    );
    expect(e.to).toEqual(["a@x.com", "b@x.com"]);
    expect(e.cc).toEqual(["c@x.com"]);
  });

  it("HTML body → isHtml, body=html, preview is stripped+truncated", () => {
    const e = buildEmailMessage(msg(3), parsed({ html: "<p>Hi <b>there</b></p>" }), "INBOX");
    expect(e.isHtml).toBe(true);
    expect(e.body).toBe("<p>Hi <b>there</b></p>");
    expect(e.bodyPreview).toBe("Hi there");
  });

  it("detects PGP signed/encrypted from content-type", () => {
    const signed = buildEmailMessage(msg(4), parsed({
      headerEntries: [["content-type", { value: "multipart/signed; protocol=\"application/pgp-signature\"" }]],
    }), "INBOX");
    expect(signed.isSignedPGP).toBe(true);
    expect(signed.isEncryptedPGP).toBe(false);
    const enc = buildEmailMessage(msg(5), parsed({
      headerEntries: [["content-type", { value: "multipart/encrypted; protocol=\"application/pgp-encrypted\"" }]],
    }), "INBOX");
    expect(enc.isEncryptedPGP).toBe(true);
  });

  it("extracts protonId from X-Pm-Internal-Id and trims it", () => {
    const e = buildEmailMessage(msg(6), parsed({ headerEntries: [["x-pm-internal-id", "  pm_abc123  "]] }), "INBOX");
    expect(e.protonId).toBe("pm_abc123");
  });

  it("maps attachments + hasAttachment, and reads answered/forwarded flags", () => {
    const e = buildEmailMessage(
      msg(7, ["\\Answered", "\\Forward"]),
      parsed({ attachments: [{ filename: "a.pdf", contentType: "application/pdf", size: 10, content: Buffer.from("x"), cid: "c1" } as never] }),
      "INBOX",
    );
    expect(e.hasAttachment).toBe(true);
    expect(e.attachments?.[0]).toMatchObject({ filename: "a.pdf", contentType: "application/pdf", size: 10, contentId: "c1" });
    expect(e.isAnswered).toBe(true);
    expect(e.isForwarded).toBe(true);
  });
});

describe("stripHtml / truncateBody / normalizeAddressList (moved, unchanged)", () => {
  it("stripHtml decodes entities BEFORE stripping tags (PARSE-008)", () => {
    expect(stripHtml("a &lt;script&gt;alert(1)&lt;/script&gt; b")).toBe("a b");
    expect(stripHtml("<!-- secret: pw -->visible")).toBe("visible");
  });
  it("truncateBody breaks on a word boundary near the cap", () => {
    expect(truncateBody("short")).toBe("short");
    const long = "word ".repeat(100);
    const t = truncateBody(long, 20);
    expect(t.endsWith("...")).toBe(true);
    expect(t.length).toBeLessThanOrEqual(23);
  });
  it("normalizeAddressList handles single, array, and undefined", () => {
    expect(normalizeAddressList(undefined)).toEqual([]);
    expect(normalizeAddressList(addr("a@x.com"))).toEqual(["a@x.com"]);
    expect(normalizeAddressList([addr("a@x.com"), addr("b@x.com")])).toEqual(["a@x.com", "b@x.com"]);
  });
});

describe("verifyRelocatedMessages", () => {
  const noFind = async () => new Set<string>();
  const err = (uid: string, src?: string) => `fail ${uid} from ${src ?? "?"}`;
  const job = (o: Partial<RelocationJob>): RelocationJob => ({
    accepted: [], midMap: new Map(), relocated: new Set(), uidplus: false, ...o,
  });

  it("UIDPLUS-confirmed relocations succeed (no Message-ID search needed)", async () => {
    const r = await verifyRelocatedMessages(
      [job({ accepted: ["1", "2"], relocated: new Set(["1", "2"]), uidplus: true })],
      "Folders/X", noFind, err,
    );
    expect(r).toEqual({ success: 2, failed: 0, errors: [] });
  });

  it("no UIDPLUS: success only when the Message-ID is found in the target", async () => {
    const find = async (_f: string, mids: string[]) => new Set(mids.filter((m) => m === "mid-1"));
    const r = await verifyRelocatedMessages(
      [job({ accepted: ["1", "2"], midMap: new Map([["1", "mid-1"], ["2", "mid-2"]]), uidplus: false, folder: "All Mail" })],
      "Folders/X", find, err,
    );
    expect(r.success).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.errors).toEqual(["fail 2 from All Mail"]);
  });

  it("a silent no-op (accepted, nothing lands) is an honest failure, never success", async () => {
    const r = await verifyRelocatedMessages(
      [job({ accepted: ["9"], midMap: new Map([["9", "mid-9"]]), uidplus: false, folder: "All Mail" })],
      "Folders/X", noFind, err,
    );
    expect(r).toEqual({ success: 0, failed: 1, errors: ["fail 9 from All Mail"] });
  });

  it("a thrown Message-ID search degrades to failure, not a crash", async () => {
    const find = async () => { throw new Error("boom"); };
    const r = await verifyRelocatedMessages(
      [job({ accepted: ["1"], midMap: new Map([["1", "mid-1"]]), uidplus: false })],
      "Folders/X", find, err,
    );
    expect(r.failed).toBe(1);
  });
});

import { buildSearchCriteria, sanitizeImapSearchValue } from "./imap-helpers.js";
import type { SearchEmailOptions } from "../types/index.js";

describe("buildSearchCriteria", () => {
  it("maps fields + sanitizes injection chars", () => {
    const c = buildSearchCriteria({ from: 'a"\\\r\nx', subject: "hi", isRead: false, isStarred: true } as SearchEmailOptions);
    expect(c.from).toBe("ax");          // quote/backslash/CR/LF stripped
    expect(c.subject).toBe("hi");
    expect(c.seen).toBe(false);
    expect(c.flagged).toBe(true);
  });
  it("maps dates, size, flag, sent predicates", () => {
    const sb = new Date("2026-06-01");
    const c = buildSearchCriteria({ dateFrom: "2026-05-01", larger: 1000, answered: true, isDraft: false, sentBefore: sb } as SearchEmailOptions);
    expect(c.since).toBeInstanceOf(Date);
    expect(c.larger).toBe(1000);
    expect(c.answered).toBe(true);
    expect(c.draft).toBe(false);
    expect(c.sentBefore).toBe(sb);
  });
  it("enforces the header field-name grammar (IMAP-004)", () => {
    expect(() => buildSearchCriteria({ header: { field: "X bad", value: "v" } } as SearchEmailOptions)).toThrow(/Invalid header field/);
    const c = buildSearchCriteria({ header: { field: "X-Custom", value: 'v"x' } } as SearchEmailOptions);
    expect(c.header).toEqual({ "X-Custom": "vx" });
  });
  it("ignores an invalid date silently", () => {
    expect(buildSearchCriteria({ dateFrom: "not-a-date" } as SearchEmailOptions).since).toBeUndefined();
  });
  it("sanitizeImapSearchValue strips quote/backslash/CRLF/NUL", () => {
    expect(sanitizeImapSearchValue('a"b\\c\r\nd\x00e')).toBe("abcde");
  });
});
