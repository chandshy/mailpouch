/**
 * deletion.e2e — coverage for src/tools/deletion.ts.
 *
 * All deletion tools require { confirmed: true } per mailpouch's destructive
 * gate. We assert both the gate (rejects without confirmed) and the
 * underlying IMAP state after a confirmed delete + expunge.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import {
  NEWSLETTER_TOKEN_DISPATCH,
  PROMO_CREDIT_KARMA,
  PROMO_RED_LOBSTER,
  RELEASE_NVIDIA,
} from "../fixtures/seed-data.js";

type BulkResult = { success: number; failed: number; errors: string[] };
type ActionResult = { success: boolean };

// Custom mailbox lifecycle is Greenmail-only. Live Bridge deletion coverage
// moves exact-owned INBOX UIDs to Trash in safe-bridge.e2e.
describe.skipIf(bridgeConfigAvailable())("deletion.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E({ safe: true });
    expect(h.scratch).toBeDefined();
    // Disposable Greenmail starts with INBOX only. Deletion tools move mail
    // to Trash, while a real Proton account already exposes that system folder.
    if (!bridgeConfigAvailable()) {
      await h.imap.createMailbox("Trash");
      await h.call("sync_folders");
    }
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(async () => {
    await h.resetState();
  });

  describe("delete_email — destructive gate", () => {
    it("rejects when confirmed flag is missing", async () => {
      const source = await h.scratch!.create("folders");
      const uid = await h.imap.appendSeed(source, PROMO_CREDIT_KARMA);
      const raw = await h.call("delete_email", { emailId: String(uid), sourceFolder: source });
      expect(raw.isError).toBe(true);
      // TEST-024: the confirmation gate must fire BEFORE any IMAP mutation —
      // assert that the run-owned message survives. Avoid whole-folder counts:
      // a real Bridge mailbox may receive unrelated mail during the test.
      expect(await h.imap.uidExists(source, uid)).toBe(true);
    });

    it("deletes when confirmed:true is supplied", async () => {
      const source = await h.scratch!.create("folders");
      const uid = await h.imap.appendSeed(source, PROMO_CREDIT_KARMA);
      h.json<ActionResult>(
        await h.call("delete_email", {
          emailId: String(uid),
          sourceFolder: source,
          confirmed: true,
        })
      );
      expect(await h.imap.uidExists(source, uid)).toBe(false);
    });

    // The singular custom-folder EXPUNGE check remains unit-covered. It cannot
    // run on live Bridge without creating a mailbox, and Greenmail's
    // cross-connection sequence view is not stable enough for this assertion.
    it.skip("deletes from sourceFolder when supplied — needs an isolated stable backend", () => {});
  });

  describe("bulk_delete_emails", () => {
    it("rejects without confirmed:true", async () => {
      const source = await h.scratch!.create("folders");
      const u = await h.imap.appendSeed(source, PROMO_CREDIT_KARMA);
      const raw = await h.call("bulk_delete_emails", {
        emailIds: [String(u)],
        sourceFolder: source,
      });
      expect(raw.isError).toBe(true);
      expect(await h.imap.uidExists(source, u)).toBe(true);
    });

    it("deletes multiple scratch-folder UIDs with confirmed:true", async () => {
      const source = await h.scratch!.create("folders");
      const u1 = await h.imap.appendSeed(source, PROMO_CREDIT_KARMA);
      const u2 = await h.imap.appendSeed(source, PROMO_RED_LOBSTER);
      const u3 = await h.imap.appendSeed(source, RELEASE_NVIDIA);

      const result = h.json<BulkResult>(
        await h.call("bulk_delete_emails", {
          emailIds: [String(u1), String(u2), String(u3)],
          sourceFolder: source,
          confirmed: true,
        })
      );

      expect(result.success).toBe(3);
      expect(result.failed).toBe(0);
      expect(await h.imap.uidExists(source, u1)).toBe(false);
      expect(await h.imap.uidExists(source, u2)).toBe(false);
      expect(await h.imap.uidExists(source, u3)).toBe(false);
    });

    it.skipIf(bridgeConfigAvailable())("counts missing UIDs as failed when sourceFolder is supplied", async () => {
      const work = await h.scratch!.create("folders");
      const real = await h.imap.appendSeed(work, NEWSLETTER_TOKEN_DISPATCH);
      const missing1 = real + 1_000_000;
      const missing2 = missing1 + 1;

      const result = h.json<BulkResult>(
        await h.call("bulk_delete_emails", {
          emailIds: [String(real), String(missing1), String(missing2)],
          confirmed: true,
          sourceFolder: work,
        })
      );

      expect(result.success).toBe(1);
      expect(result.failed).toBe(2);
      expect(result.errors.join(" ")).toMatch(new RegExp(`${missing1}|${missing2}`));
    });
  });

  describe("bulk_delete (alias for bulk_delete_emails)", () => {
    it("behaves identically to bulk_delete_emails", async () => {
      const source = await h.scratch!.create("folders");
      const u1 = await h.imap.appendSeed(source, PROMO_CREDIT_KARMA);
      const u2 = await h.imap.appendSeed(source, PROMO_RED_LOBSTER);
      const result = h.json<BulkResult>(
        await h.call("bulk_delete", {
          emailIds: [String(u1), String(u2)],
          sourceFolder: source,
          confirmed: true,
        })
      );
      expect(result.success).toBe(2);
    });
  });
});
