/**
 * reading.e2e — coverage for src/tools/reading.ts.
 *
 * Asserts that the read-path tools see what ImapFixtures seeds. Uses
 * get_email_by_id (single-UID FETCH) where possible to sidestep the
 * mailbox-EXISTS cache lag Greenmail can show for get_emails right after
 * APPENDs from a different connection.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import {
  NEWSLETTER_TOKEN_DISPATCH,
  PROMO_BATCH,
  PROMO_CREDIT_KARMA,
  WORK_THREAD_REPLY,
  WORK_THREAD_ROOT,
} from "../fixtures/seed-data.js";

describe("reading.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(async () => {
    await h.resetState();
  });

  describe("get_email_by_id", () => {
    it("returns subject + from for a seeded INBOX UID", async () => {
      const visible = await h.appendVisibleSeed("INBOX", PROMO_CREDIT_KARMA);
      expect(visible.email.subject).toBe(PROMO_CREDIT_KARMA.subject);
      expect(visible.email.from).toContain("creditkarma");
    }, 75_000);

    it("returns an error for a UID that doesn't exist", async () => {
      const [missing] = await h.imap.provenMissingUids("INBOX", 1);
      const raw = await h.callRaw("get_email_by_id", { emailId: String(missing), folder: "INBOX" });
      // Either MCP-level error or domain isError:true.
      const ok = "ok" in raw && raw.ok && raw.isError !== true;
      expect(ok).toBe(false);
    });
  });

  describe("get_emails", () => {
    // mailpouch's mailbox-EXISTS cache lags side-channel APPENDs on Greenmail.
    // get_email_by_id (above) reads correctly because it does a UID FETCH that
    // doesn't depend on the SELECT-cached EXISTS counter. Bridge handles
    // EXPUNGE/EXISTS notifications correctly via IDLE — covered Phase 2.
    it.runIf(bridgeConfigAvailable())("lists messages from INBOX after a fresh sync — bridge-only", async () => {
      const probe = `${h.runToken} list probe`;
      await h.imap.appendSeed("INBOX", { ...PROMO_CREDIT_KARMA, subject: probe });
      await h.call("clear_cache");
      await h.call("sync_emails", { folder: "INBOX", limit: 20 });
      const result = h.json<{ emails: { subject: string }[] }>(
        await h.call("get_emails", { folder: "INBOX", limit: 20 })
      );
      const subjects = new Set(result.emails.map((e) => e.subject));
      expect(subjects.has(probe)).toBe(true);
    });

    it("respects the limit parameter", async () => {
      for (const seed of PROMO_BATCH) await h.imap.appendSeed("INBOX", seed);
      await h.call("clear_cache");
      await h.call("sync_emails", { folder: "INBOX", limit: 20 });
      const result = h.json<{ emails: unknown[] }>(
        await h.call("get_emails", { folder: "INBOX", limit: 2 })
      );
      expect(result.emails.length).toBeLessThanOrEqual(2);
    });

    it.skipIf(bridgeConfigAvailable())("returns empty for a folder that exists but has no messages", async () => {
      const empty = h.scratch
        ? await h.scratch.create("folders")
        : "Folders/Empty";
      if (!h.scratch) await h.imap.createMailbox(empty);
      const result = h.json<{ emails: unknown[] }>(
        await h.call("get_emails", { folder: empty, limit: 10 })
      );
      expect(result.emails.length).toBe(0);
    });

    it("returns an actionable not-found error for a missing folder (Cluster 6)", async () => {
      const missing = h.scratch?.path() ?? "Folders/DoesNotExist";
      const raw = await h.callRaw("get_emails", { folder: missing, limit: 10 });
      const text = "message" in raw ? raw.message : raw.content?.[0]?.text ?? "";
      // Must name the folder and not collapse to the opaque generic string.
      expect(text).toContain(missing);
      expect(text.toLowerCase()).toContain("not found");
      expect(text).not.toBe("An error occurred");
    });
  });

  describe("get_thread", () => {
    // get_thread internally calls searchEmails across INBOX + Sent — same
    // mailbox-EXISTS cache lag as get_emails above.
    it.runIf(bridgeConfigAvailable())("groups a reply with its root by In-Reply-To — bridge-only", async () => {
      const threadId = `thread-${h.runToken}`;
      const subject = `${h.runToken} Q2 planning`;
      const root = await h.appendVisibleSeed("INBOX", {
        ...WORK_THREAD_ROOT,
        subject,
        messageId: `${threadId}-root`,
      });
      await h.appendVisibleSeed("INBOX", {
        ...WORK_THREAD_REPLY,
        subject: `Re: ${subject}`,
        messageId: `${threadId}-reply`,
        inReplyTo: `<${threadId}-root@test.local>`,
        references: `<${threadId}-root@test.local>`,
      });
      const expected = new Set([subject, `Re: ${subject}`]);
      const deadline = Date.now() + 60_000;
      let observed: string[] = [];
      do {
        const raw = await h.call("get_thread", { email_id: String(root.uid), folder: "INBOX" });
        if (raw.isError !== true && raw.structuredContent && typeof raw.structuredContent === "object") {
          const result = raw.structuredContent as { messages?: Array<{ subject?: string }> };
          observed = (result.messages ?? [])
            .map((email) => email.subject)
            .filter((value): value is string => typeof value === "string");
          if ([...expected].every((value) => observed.includes(value))) break;
        }
        await h.call("sync_emails", { folder: "INBOX", limit: 20 });
        if (Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
      } while (Date.now() < deadline);
      expect(observed).toEqual(expect.arrayContaining([...expected]));
    }, 190_000);
  });

  describe("get_unread_count", () => {
    it("reports the unread count across folders", async () => {
      await h.imap.appendSeed("INBOX", PROMO_CREDIT_KARMA);
      await h.imap.appendSeed("INBOX", NEWSLETTER_TOKEN_DISPATCH, ["\\Seen"]);
      await h.call("clear_cache");
      const result = h.json<{ unreadByFolder: Record<string, number>; totalUnread: number }>(
        await h.call("get_unread_count")
      );
      expect(typeof result.totalUnread).toBe("number");
      expect(result.unreadByFolder).toBeTypeOf("object");
    });
  });

  describe("sync_emails", () => {
    it("returns success with a folder + count", async () => {
      await h.imap.appendSeed("INBOX", PROMO_CREDIT_KARMA);
      const result = h.json<{ success: boolean; folder: string; count: number }>(
        await h.call("sync_emails", { folder: "INBOX", limit: 10 })
      );
      expect(result.success).toBe(true);
      expect(result.folder).toBe("INBOX");
      expect(result.count).toBeGreaterThanOrEqual(0);
    });

    it("returns an actionable not-found error for a missing folder (Cluster 6)", async () => {
      const missing = h.scratch?.path() ?? "Folders/Nope";
      const raw = await h.callRaw("sync_emails", { folder: missing, limit: 10 });
      const text = "message" in raw ? raw.message : raw.content?.[0]?.text ?? "";
      expect(text).toContain(missing);
      expect(text.toLowerCase()).toContain("not found");
      expect(text).not.toBe("An error occurred");
    });
  });
});
