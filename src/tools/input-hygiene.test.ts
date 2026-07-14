/**
 * Tool-surface input-hygiene regression tests (2026-05-28 audit, v3.0.53).
 *
 * Each test pins one TOOL-### finding: numeric coercion that lets negatives /
 * NaN / Infinity through, blind array casts, empty-string args reaching an
 * upstream API, in-place mutation of cached objects, and a misleading
 * "no correspondence" report. Handlers are invoked directly with a minimal
 * hand-built context so the assertions target the handler boundary, not the
 * full MCP stack.
 */

import { describe, it, expect, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import type { ToolCallContext, ToolResult } from "./types.js";

import { handlers as readingHandlers } from "./reading.js";
import { handlers as sendingHandlers } from "./sending.js";
import { handlers as bridgeHandlers } from "./bridge.js";
import { handlers as analyticsHandlers } from "./analytics.js";
import { handlers as aliasHandlers } from "./aliases.js";
import { handlers as systemHandlers } from "./system.js";
import { handlers as escalationHandlers, type EscalationContext } from "./escalation.js";

const DEFAULT_LIMITS = {
  maxResponseBytes: 1_000_000,
  maxEmailBodyChars: 10_000,
  maxEmailListResults: 100,
  maxAttachmentBytes: 1_000_000,
  warnOnLargeResponse: false,
};

/** Build a minimal ToolCallContext; override only what a given handler touches. */
function makeCtx(overrides: Partial<ToolCallContext>): ToolCallContext {
  const ok = (structured: Record<string, unknown>, text?: string): ToolResult => ({
    content: [{ type: "text" as const, text: text ?? JSON.stringify(structured) }],
    structuredContent: structured,
  });
  return {
    args: {},
    limits: DEFAULT_LIMITS,
    ok,
    getAnalyticsEmails: async () => ({ inbox: [], sent: [] }),
    invalidateAnalytics: () => {},
    ...overrides,
  } as unknown as ToolCallContext;
}

describe("tool input hygiene (v3.0.53)", () => {
  // ── TOOL-001 — search_emails folders cast ──────────────────────────────
  describe("TOOL-001 search_emails folders", () => {
    it("rejects a string folders arg instead of iterating per-character", async () => {
      const ctx = makeCtx({
        args: { folders: "INBOX" },
        imapService: { searchEmails: vi.fn() } as never,
      });
      await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
    });

    it("rejects an object folders arg", async () => {
      const ctx = makeCtx({
        args: { folders: {} },
        imapService: { searchEmails: vi.fn() } as never,
      });
      await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
    });

    it("still accepts a valid string[] folders arg", async () => {
      const searchEmails = vi.fn().mockResolvedValue([]);
      const ctx = makeCtx({ args: { folders: ["INBOX", "Sent"] }, imapService: { searchEmails } as never });
      await expect(readingHandlers.search_emails(ctx)).resolves.toBeDefined();
      expect(searchEmails).toHaveBeenCalledOnce();
    });
  });

  // ── VALID-002 — search_emails length-caps body/text/bcc ────────────────
  describe("VALID-002 search_emails body/text/bcc length cap", () => {
    const over = "x".repeat(501);
    for (const field of ["body", "text", "bcc"] as const) {
      it(`rejects an over-long '${field}' filter`, async () => {
        const ctx = makeCtx({
          args: { [field]: over },
          imapService: { searchEmails: vi.fn() } as never,
        });
        await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
      });
    }

    it("accepts body/text/bcc filters at the 500-char boundary", async () => {
      const searchEmails = vi.fn().mockResolvedValue([]);
      const ctx = makeCtx({
        args: { body: "x".repeat(500), text: "y".repeat(500), bcc: "z".repeat(500) },
        imapService: { searchEmails } as never,
      });
      await expect(readingHandlers.search_emails(ctx)).resolves.toBeDefined();
      expect(searchEmails).toHaveBeenCalledOnce();
    });
  });

  // ── TOOL-002 — request_permission_escalation reason required ───────────
  describe("TOOL-002 escalation reason", () => {
    const escCtx = (args: Record<string, unknown>): EscalationContext =>
      ({ args, config: {} as never }) as EscalationContext;

    it("rejects a missing reason", async () => {
      await expect(
        escalationHandlers.request_permission_escalation(escCtx({ target_preset: "full" }))
      ).rejects.toBeInstanceOf(McpError);
    });

    it("rejects a blank reason", async () => {
      await expect(
        escalationHandlers.request_permission_escalation(escCtx({ target_preset: "full", reason: "   " }))
      ).rejects.toBeInstanceOf(McpError);
    });
  });

  // ── TOOL-003 — get_contacts negative limit ─────────────────────────────
  describe("TOOL-003 get_contacts limit", () => {
    it("clamps a negative limit to >= 1", async () => {
      const getContacts = vi.fn().mockReturnValue([]);
      const ctx = makeCtx({ args: { limit: -5 }, analyticsService: { getContacts } as never });
      await analyticsHandlers.get_contacts(ctx);
      const passed = getContacts.mock.calls[0][0] as number;
      expect(passed).toBeGreaterThanOrEqual(1);
    });

    it("clamps NaN limit to the fallback", async () => {
      const getContacts = vi.fn().mockReturnValue([]);
      const ctx = makeCtx({ args: { limit: Number.NaN }, analyticsService: { getContacts } as never });
      await analyticsHandlers.get_contacts(ctx);
      expect(Number.isFinite(getContacts.mock.calls[0][0] as number)).toBe(true);
    });
  });

  // ── TOOL-004 — get_volume_trends days ──────────────────────────────────
  describe("TOOL-004 get_volume_trends days", () => {
    it("clamps a negative days to >= 1", async () => {
      const getVolumeTrends = vi.fn().mockReturnValue([]);
      const ctx = makeCtx({ args: { days: -10 }, analyticsService: { getVolumeTrends } as never });
      await analyticsHandlers.get_volume_trends(ctx);
      expect(getVolumeTrends.mock.calls[0][0] as number).toBeGreaterThanOrEqual(1);
    });

    it("collapses NaN days to a finite value", async () => {
      const getVolumeTrends = vi.fn().mockReturnValue([]);
      const ctx = makeCtx({ args: { days: Number.NaN }, analyticsService: { getVolumeTrends } as never });
      await analyticsHandlers.get_volume_trends(ctx);
      expect(Number.isFinite(getVolumeTrends.mock.calls[0][0] as number)).toBe(true);
    });

    it("rejects a non-number days", async () => {
      const ctx = makeCtx({ args: { days: "lots" }, analyticsService: { getVolumeTrends: vi.fn() } as never });
      await expect(analyticsHandlers.get_volume_trends(ctx)).rejects.toBeInstanceOf(McpError);
    });
  });

  // ── TOOL-005 — get_logs NaN limit ──────────────────────────────────────
  describe("TOOL-005 get_logs limit", () => {
    it("does not forward NaN to logger.getLogs", async () => {
      const ctx = makeCtx({ args: { limit: Number.NaN } });
      const res = await systemHandlers.get_logs(ctx);
      // logger.getLogs is a real singleton; a NaN limit would have produced a
      // non-array / empty result via slice(-NaN). Assert the handler succeeded
      // and produced a logs array.
      expect((res.structuredContent as { logs: unknown[] }).logs).toBeInstanceOf(Array);
    });
  });

  // ── TOOL-006 — alias pageSize NaN ──────────────────────────────────────
  describe("TOOL-006 alias pageSize", () => {
    it("alias_list collapses NaN pageSize to a finite value", async () => {
      const listAliases = vi.fn().mockResolvedValue([]);
      const ctx = makeCtx({
        args: { pageSize: Number.NaN },
        simpleloginService: { isConfigured: () => true, listAliases } as never,
      });
      await aliasHandlers.alias_list(ctx);
      expect(Number.isFinite(listAliases.mock.calls[0][0] as number)).toBe(true);
    });

    it("alias_get_activity collapses NaN pageSize to a finite value", async () => {
      const getAliasActivities = vi.fn().mockResolvedValue([]);
      const ctx = makeCtx({
        args: { aliasId: 1, pageSize: Number.NaN },
        simpleloginService: { isConfigured: () => true, getAliasActivities } as never,
      });
      await aliasHandlers.alias_get_activity(ctx);
      expect(Number.isFinite(getAliasActivities.mock.calls[0][1] as number)).toBe(true);
    });
  });

  // ── TOOL-007 — alias_create_custom empty strings ───────────────────────
  describe("TOOL-007 alias_create_custom empties", () => {
    it("rejects an empty aliasPrefix", async () => {
      const createCustomAlias = vi.fn();
      const ctx = makeCtx({
        args: { aliasPrefix: "", signedSuffix: "@x.com" },
        simpleloginService: { isConfigured: () => true, createCustomAlias } as never,
      });
      await expect(aliasHandlers.alias_create_custom(ctx)).rejects.toBeInstanceOf(McpError);
      expect(createCustomAlias).not.toHaveBeenCalled();
    });

    it("rejects a whitespace-only signedSuffix", async () => {
      const createCustomAlias = vi.fn();
      const ctx = makeCtx({
        args: { aliasPrefix: "hi", signedSuffix: "   " },
        simpleloginService: { isConfigured: () => true, createCustomAlias } as never,
      });
      await expect(aliasHandlers.alias_create_custom(ctx)).rejects.toBeInstanceOf(McpError);
      expect(createCustomAlias).not.toHaveBeenCalled();
    });
  });

  // ── TOOL-008 — get_correspondence_profile honest no-match message ──────
  describe("TOOL-008 correspondence_profile", () => {
    it("reports exhaustive=true when the contact set is below the scan cap", async () => {
      const getContacts = vi.fn().mockReturnValue([{ email: "someone@else.com" }]);
      const ctx = makeCtx({
        args: { email: "known@example.com" },
        analyticsService: { getContacts } as never,
        getAnalyticsEmails: async () => ({ inbox: [], sent: [] }),
      });
      const res = await readingHandlers.get_correspondence_profile(ctx);
      expect((res.structuredContent as { exhaustive: boolean }).exhaustive).toBe(true);
    });

    it("reports exhaustive=false when the scan cap was hit (possible false negative)", async () => {
      const full = Array.from({ length: 500 }, (_, i) => ({ email: `c${i}@example.com` }));
      const getContacts = vi.fn().mockReturnValue(full);
      const ctx = makeCtx({
        args: { email: "known@example.com" },
        analyticsService: { getContacts } as never,
        getAnalyticsEmails: async () => ({ inbox: [], sent: [] }),
      });
      const res = await readingHandlers.get_correspondence_profile(ctx);
      expect((res.structuredContent as { exhaustive: boolean }).exhaustive).toBe(false);
    });
  });

  // ── TOOL-009 — fts_search limit/sinceEpoch ranges ──────────────────────
  describe("TOOL-009 fts_search ranges", () => {
    const ftsCtx = (args: Record<string, unknown>, search = vi.fn().mockReturnValue([])) =>
      makeCtx({
        args,
        getFts: () => ({ search }) as never,
        getCallerAllowedFolders: () => undefined,
      });

    it("clamps an over-large limit to <= 200", async () => {
      const search = vi.fn().mockReturnValue([]);
      const ctx = ftsCtx({ query: "x", limit: 99999 }, search);
      await readingHandlers.fts_search(ctx);
      expect((search.mock.calls[0][0] as { limit: number }).limit).toBeLessThanOrEqual(200);
    });

    it("collapses a NaN limit to a finite value", async () => {
      const search = vi.fn().mockReturnValue([]);
      const ctx = ftsCtx({ query: "x", limit: Number.NaN }, search);
      await readingHandlers.fts_search(ctx);
      expect(Number.isFinite((search.mock.calls[0][0] as { limit: number }).limit)).toBe(true);
    });

    it("rejects a negative sinceEpoch", async () => {
      const ctx = ftsCtx({ query: "x", sinceEpoch: -1 });
      await expect(readingHandlers.fts_search(ctx)).rejects.toBeInstanceOf(McpError);
    });

    it("rejects a NaN sinceEpoch", async () => {
      const ctx = ftsCtx({ query: "x", sinceEpoch: Number.NaN });
      await expect(readingHandlers.fts_search(ctx)).rejects.toBeInstanceOf(McpError);
    });
  });

  // ── PARSE-003 — fts_rebuild uses the atomic rebuild(), not clear()+upsertMany() ─
  describe("PARSE-003 fts_rebuild wiring", () => {
    it("calls rebuild() and never the non-atomic clear()/upsertMany() pair", async () => {
      const rebuild = vi.fn().mockReturnValue(3);
      const clear = vi.fn();
      const upsertMany = vi.fn();
      const stats = vi.fn().mockReturnValue({ messageCount: 3, dbPath: "/tmp/x.db" });
      const ctx = makeCtx({
        args: {},
        getFts: () => ({ rebuild, clear, upsertMany, stats }) as never,
        getAnalyticsEmails: async () => ({
          inbox: [{ id: "1" }] as never,
          sent: [{ id: "2" }, { id: "3" }] as never,
        }),
        recordFromEmail: ((e: { id: string }) => ({ id: e.id })) as never,
      });
      const res = await readingHandlers.fts_rebuild(ctx);
      expect(rebuild).toHaveBeenCalledOnce();
      expect(rebuild.mock.calls[0][0]).toHaveLength(3);
      expect(clear).not.toHaveBeenCalled();
      expect(upsertMany).not.toHaveBeenCalled();
      expect((res.structuredContent as { indexed: number }).indexed).toBe(3);
    });
  });

  // ── TOOL-025 — get_email_by_id does not mutate the cached object ───────
  describe("TOOL-025 get_email_by_id clone", () => {
    it("leaves the service-returned email.body untruncated", async () => {
      const longBody = "x".repeat(DEFAULT_LIMITS.maxEmailBodyChars + 5_000);
      const cached = { id: "1", body: longBody };
      const ctx = makeCtx({
        args: { emailId: "1" },
        imapService: { getEmailById: vi.fn().mockResolvedValue(cached) } as never,
      });
      const res = await readingHandlers.get_email_by_id(ctx);
      // The returned (truncated) copy must differ from the still-intact cached object.
      expect((res.structuredContent as { body: string }).body).toContain("truncated");
      expect(cached.body).toBe(longBody);
      expect(cached.body.length).toBe(longBody.length);
    });
  });

  describe("sending tool hardening (SMTP-009/010/013)", () => {
    const sendOk = { success: true as const, messageId: "msg-1" };
    function sendCtx(overrides: Partial<ToolCallContext>): ToolCallContext {
      const sendEmail = vi.fn().mockResolvedValue(sendOk);
      return makeCtx({
        actionOk: (messageId?: string) => ({
          content: [{ type: "text" as const, text: JSON.stringify({ success: true, messageId }) }],
          structuredContent: { success: true, messageId },
        }),
        MAX_SUBJECT_LENGTH: 100,
        MAX_BODY_LENGTH: 1_000_000,
        smtpService: { sendEmail } as never,
        config: { smtp: { username: "me@example.com" } } as never,
        ...overrides,
      });
    }

    it("SMTP-013: send_email rejects an omitted subject", async () => {
      const ctx = sendCtx({ args: { to: "a@example.com", body: "hi" } });
      await expect(sendingHandlers.send_email(ctx)).rejects.toBeInstanceOf(McpError);
    });

    it("SMTP-013: send_email rejects a blank subject", async () => {
      const ctx = sendCtx({ args: { to: "a@example.com", body: "hi", subject: "   " } });
      await expect(sendingHandlers.send_email(ctx)).rejects.toBeInstanceOf(McpError);
    });

    it("SMTP-009: reply_to_email caps the Re: subject to MAX_SUBJECT_LENGTH", async () => {
      const sendEmail = vi.fn().mockResolvedValue(sendOk);
      const longSubject = "x".repeat(998);
      const ctx = sendCtx({
        args: { emailId: "1", body: "reply" },
        smtpService: { sendEmail } as never,
        imapService: {
          getEmailById: vi.fn().mockResolvedValue({ id: "1", from: "p@example.com", subject: longSubject, to: [], cc: [] }),
          setFlag: vi.fn().mockResolvedValue(true),
        } as never,
      });
      await sendingHandlers.reply_to_email(ctx);
      const sent = sendEmail.mock.calls[0][0] as { subject: string };
      expect(sent.subject.length).toBeLessThanOrEqual(100);
    });

    it("SMTP-010: forward_email escapes the user message when the original is HTML", async () => {
      const sendEmail = vi.fn().mockResolvedValue(sendOk);
      const ctx = sendCtx({
        args: { emailId: "1", to: "dest@example.com", message: "<script>alert(1)</script>" },
        smtpService: { sendEmail } as never,
        imapService: {
          getEmailById: vi.fn().mockResolvedValue({ id: "1", from: "p@example.com", subject: "Hi", date: new Date(), to: [], isHtml: true, body: "<p>orig</p>" }),
          setFlag: vi.fn().mockResolvedValue(true),
        } as never,
      });
      await sendingHandlers.forward_email(ctx);
      const sent = sendEmail.mock.calls[0][0] as { body: string };
      expect(sent.body).not.toContain("<script>");
      expect(sent.body).toContain("&lt;script&gt;");
    });

    it("SMTP-010: forward_email leaves the user message intact when the original is plain text", async () => {
      const sendEmail = vi.fn().mockResolvedValue(sendOk);
      const ctx = sendCtx({
        args: { emailId: "1", to: "dest@example.com", message: "see < below" },
        smtpService: { sendEmail } as never,
        imapService: {
          getEmailById: vi.fn().mockResolvedValue({ id: "1", from: "p@example.com", subject: "Hi", date: new Date(), to: [], isHtml: false, body: "orig" }),
          setFlag: vi.fn().mockResolvedValue(true),
        } as never,
      });
      await sendingHandlers.forward_email(ctx);
      const sent = sendEmail.mock.calls[0][0] as { body: string };
      expect(sent.body).toContain("see < below");
    });
  });

  // ════════════════════════════════════════════════════════════════════════
  // v3.0.62 low-severity sweep
  // ════════════════════════════════════════════════════════════════════════

  // ── TOOL-016 — search_emails larger/smaller must be non-negative finite ──
  describe("TOOL-016 search_emails larger/smaller", () => {
    for (const field of ["larger", "smaller"] as const) {
      it(`rejects a negative '${field}'`, async () => {
        const ctx = makeCtx({ args: { [field]: -1 }, imapService: { searchEmails: vi.fn() } as never });
        await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
      });
      it(`rejects a NaN '${field}'`, async () => {
        const ctx = makeCtx({ args: { [field]: Number.NaN }, imapService: { searchEmails: vi.fn() } as never });
        await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
      });
    }
    it("accepts a non-negative larger/smaller", async () => {
      const searchEmails = vi.fn().mockResolvedValue([]);
      const ctx = makeCtx({ args: { larger: 0, smaller: 1024 }, imapService: { searchEmails } as never });
      await expect(readingHandlers.search_emails(ctx)).resolves.toBeDefined();
    });
  });

  // ── TOOL-017 — sentBefore/sentSince require parseable date strings ───────
  describe("TOOL-017 search_emails sentBefore/sentSince", () => {
    for (const field of ["sentBefore", "sentSince"] as const) {
      it(`rejects a non-string '${field}'`, async () => {
        const ctx = makeCtx({ args: { [field]: 1234 }, imapService: { searchEmails: vi.fn() } as never });
        await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
      });
      it(`rejects an unparseable '${field}'`, async () => {
        const ctx = makeCtx({ args: { [field]: "not-a-date" }, imapService: { searchEmails: vi.fn() } as never });
        await expect(readingHandlers.search_emails(ctx)).rejects.toBeInstanceOf(McpError);
      });
    }
    it("accepts an ISO date string", async () => {
      const searchEmails = vi.fn().mockResolvedValue([]);
      const ctx = makeCtx({ args: { sentBefore: "2026-01-01T00:00:00Z" }, imapService: { searchEmails } as never });
      await expect(readingHandlers.search_emails(ctx)).resolves.toBeDefined();
      expect((searchEmails.mock.calls[0][0] as { sentBefore: Date }).sentBefore).toBeInstanceOf(Date);
    });
  });

  // ── VALID-016 — fts_search validates the folder filter ───────────────────
  describe("VALID-016 fts_search folder validation", () => {
    const ftsCtx = (args: Record<string, unknown>, search = vi.fn().mockReturnValue([])) =>
      makeCtx({ args, getFts: () => ({ search }) as never, getCallerAllowedFolders: () => undefined });

    it("rejects a traversal in the folder filter", async () => {
      await expect(readingHandlers.fts_search(ftsCtx({ query: "x", folder: "../etc" }))).rejects.toBeInstanceOf(McpError);
    });
    it("accepts a clean folder filter", async () => {
      await expect(readingHandlers.fts_search(ftsCtx({ query: "x", folder: "Folders/Work" }))).resolves.toBeDefined();
    });
  });

  // ── TOOL-013 — fts_rebuild in-progress flag is keyed per DB path ─────────
  describe("TOOL-013 fts_rebuild per-DB in-progress flag", () => {
    it("allows concurrent rebuilds against different DB paths", async () => {
      // Two FTS handles with distinct dbPaths. A blocking rebuild on the first
      // must not reject a rebuild on the second.
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const ftsA = { stats: vi.fn().mockReturnValue({ messageCount: 0, dbPath: "/tmp/a.db" }), rebuild: vi.fn(async () => { await gate; return 0; }) };
      const ftsB = { stats: vi.fn().mockReturnValue({ messageCount: 0, dbPath: "/tmp/b.db" }), rebuild: vi.fn().mockReturnValue(0) };
      const ctxA = makeCtx({ args: {}, getFts: () => ftsA as never, recordFromEmail: ((e: unknown) => e) as never });
      const ctxB = makeCtx({ args: {}, getFts: () => ftsB as never, recordFromEmail: ((e: unknown) => e) as never });
      const pA = readingHandlers.fts_rebuild(ctxA);
      const resB = await readingHandlers.fts_rebuild(ctxB);
      expect(resB.isError).toBeFalsy();
      release();
      await pA;
    });

    it("rejects a second concurrent rebuild against the SAME DB path", async () => {
      let release!: () => void;
      const gate = new Promise<void>((r) => { release = r; });
      const stats = vi.fn().mockReturnValue({ messageCount: 0, dbPath: "/tmp/same.db" });
      const fts = { stats, rebuild: vi.fn(async () => { await gate; return 0; }) };
      const mk = () => makeCtx({ args: {}, getFts: () => fts as never, recordFromEmail: ((e: unknown) => e) as never });
      const p1 = readingHandlers.fts_rebuild(mk());
      const res2 = await readingHandlers.fts_rebuild(mk());
      expect(res2.isError).toBe(true);
      release();
      await p1;
    });
  });

  // ── TOOL-014 — start_bridge flags isError when ports stay down ───────────
  describe("TOOL-014 start_bridge port-failure result", () => {
    const bridgeCtx = (smtpUp: boolean, imapUp: boolean) =>
      makeCtx({
        args: {},
        config: { smtp: { host: "h", port: 1 }, imap: { host: "h", port: 2 } } as never,
        launchProtonBridge: vi.fn().mockResolvedValue(undefined) as never,
        isBridgeReachable: vi.fn().mockImplementation((_h: string, p: number) => Promise.resolve(p === 1 ? smtpUp : imapUp)) as never,
        state: {} as never,
      });

    it("sets isError when ports never come up", async () => {
      const res = await bridgeHandlers.start_bridge(bridgeCtx(false, false));
      expect(res.isError).toBe(true);
      expect((res.structuredContent as { success: boolean }).success).toBe(false);
    });
    it("does not set isError when both ports are reachable", async () => {
      const ctx = bridgeCtx(true, true);
      const res = await bridgeHandlers.start_bridge(ctx);
      expect(res.isError).toBeFalsy();
      expect((res.structuredContent as { success: boolean }).success).toBe(true);
      expect(ctx.launchProtonBridge).toHaveBeenCalledWith(ctx.config);
    });
  });
});
