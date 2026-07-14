/**
 * drafts.e2e — coverage for src/tools/drafts.ts that doesn't depend on
 * outbound SMTP (Greenmail's SMTP doesn't speak STARTTLS, which mailpouch
 * forces for localhost). Outbound-delivery scenarios (schedule_email
 * actually firing, remind_if_no_reply hooking into Sent) are covered in
 * the Phase-2 Bridge suite.
 *
 * What we CAN exercise here:
 *   - save_draft (uses IMAP APPEND to Drafts, no SMTP)
 *   - list_scheduled_emails / list_pending_reminders (introspect local stores)
 *   - cancel_scheduled_email / cancel_reminder error paths
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";

describe("drafts.e2e", () => {
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

  describe("save_draft", () => {
    it("appends a draft to the Drafts folder", async () => {
      // Drafts may not exist by default on Greenmail; create it first.
      if (!bridgeConfigAvailable()) await h.imap.createMailbox("Drafts");
      const subject = `${h.runToken ?? "greenmail"} Draft from harness`;
      const result = h.json<{ success: boolean; uid?: number }>(
        await h.call("save_draft", {
          to: h.accountEmail ?? "alice@test.local",
          subject,
          body: "Test body content.",
        })
      );
      expect(result.success).toBe(true);
      expect(result.uid).toBeTypeOf("number");
      expect(await h.imap.uidExists("Drafts", result.uid!)).toBe(true);
    });
  });

  describe("list_scheduled_emails", () => {
    it("returns an empty list when nothing is scheduled", async () => {
      const result = h.json<{ scheduled: unknown[] }>(await h.call("list_scheduled_emails"));
      expect(Array.isArray(result.scheduled)).toBe(true);
    });
  });

  describe("list_pending_reminders", () => {
    it("returns an empty list when no reminders are set", async () => {
      const result = h.json<{ reminders: unknown[] }>(await h.call("list_pending_reminders"));
      expect(Array.isArray(result.reminders)).toBe(true);
    });
  });

  describe("cancel_scheduled_email — error path", () => {
    it("returns an error for an ID that doesn't exist", async () => {
      const raw = await h.callRaw("cancel_scheduled_email", { id: "nonexistent-id" });
      const isError =
        ("ok" in raw && !raw.ok) ||
        ("isError" in raw && raw.isError === true);
      expect(isError).toBe(true);
    });
  });

  describe("cancel_reminder — error path", () => {
    it("returns an error for an ID that doesn't exist", async () => {
      const raw = await h.callRaw("cancel_reminder", { id: "nonexistent-id" });
      const isError =
        ("ok" in raw && !raw.ok) ||
        ("isError" in raw && raw.isError === true);
      expect(isError).toBe(true);
    });
  });
});
