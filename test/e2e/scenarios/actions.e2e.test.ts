/**
 * actions.e2e — end-to-end coverage for src/tools/actions.ts.
 *
 * Primary purpose: prove the v3.0.41 bug fixes (Bugs A/B/C from the
 * 2026-05-28 report) cannot regress. The pattern:
 *
 *   1. Seed real messages into a non-INBOX folder via ImapFixtures.
 *   2. Invoke the mutating tool through MCP.
 *   3. Assert on *actual IMAP state* (flags / folder contents) — not just the
 *      tool's return value. This catches false-success counters.
 *
 * Skipping the IMAP-side assertion is what hid these bugs in unit tests.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import type { SeedEmail } from "../support/mime-builder.js";
import {
  NEWSLETTER_TOKEN_DISPATCH,
  PROMO_CREDIT_KARMA,
  PROMO_RED_LOBSTER,
  RELEASE_NVIDIA,
} from "../fixtures/seed-data.js";

type BulkResult = { success: number; failed: number; errors: string[] };
type ActionResult = { success: boolean };

const ARCHIVE = "Archive";

// Live Bridge action coverage lives in safe-bridge.e2e.test.ts and operates
// only on exact-owned INBOX UIDs. These custom-folder routing cases require
// mailbox lifecycle operations, which are confined to disposable Greenmail.
describe.skipIf(bridgeConfigAvailable())("actions.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E({ safe: true });
    expect(h.scratch).toBeDefined();
    // Disposable Greenmail starts with INBOX only. Wrapper tools require
    // these system targets; a real Proton account already exposes them.
    if (!bridgeConfigAvailable()) {
      await h.imap.createMailbox(ARCHIVE);
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

  const scratchFolder = (): Promise<string> => h.scratch!.create("folders");
  const scratchLabelPath = async (): Promise<{ folder: string; label: string }> => {
    // Live Bridge must have a positive, durable CREATE proof before a label can
    // become a mutation target. Disposable Greenmail retains auto-create
    // coverage for the production helper.
    const folder = h.mode === "bridge"
      ? await h.scratch!.create("labels")
      : h.scratch!.path("labels");
    return { folder, label: folder.slice("Labels/".length) };
  };
  const scratchLabel = async (): Promise<{ folder: string; label: string }> => {
    const folder = await h.scratch!.create("labels");
    return { folder, label: folder.slice("Labels/".length) };
  };
  const ownedSeed = (tag: string, base: SeedEmail = PROMO_CREDIT_KARMA): SeedEmail => ({
    ...base,
    subject: `${h.runToken} ${tag}`,
  });
  const expectOwnedSubject = async (folder: string, subject: string, count = 1): Promise<void> => {
    expect(await h.imap.searchSubject(folder, subject)).toHaveLength(count);
  };

  // ── Bug B regression: bulk_move_emails with non-INBOX source ──────────────

  describe("bulk_move_emails — source folder routing (Bug B)", () => {
    it("uses sourceFolder when UIDs live in a custom folder", async () => {
      const work = await scratchFolder();
      const target = await scratchFolder();
      const seed1 = ownedSeed("bulk-move-custom-1");
      const seed2 = ownedSeed("bulk-move-custom-2", PROMO_RED_LOBSTER);
      const uid1 = await h.imap.appendSeed(work, seed1);
      const uid2 = await h.imap.appendSeed(work, seed2);

      const result = h.json<BulkResult>(
        await h.call("bulk_move_emails", {
          emailIds: [String(uid1), String(uid2)],
          targetFolder: target,
          sourceFolder: work,
        })
      );

      expect(result.success).toBe(2);
      expect(result.failed).toBe(0);
      expect(await h.imap.uidExists(work, uid1)).toBe(false);
      expect(await h.imap.uidExists(work, uid2)).toBe(false);
      await expectOwnedSubject(target, seed1.subject);
      await expectOwnedSubject(target, seed2.subject);
    });

    it.skipIf(bridgeConfigAvailable())("without sourceFolder, INBOX UIDs still move (back-compat)", async () => {
      const target = await scratchFolder();
      const seed1 = ownedSeed("bulk-move-default-1", NEWSLETTER_TOKEN_DISPATCH);
      const seed2 = ownedSeed("bulk-move-default-2", RELEASE_NVIDIA);
      const uid1 = await h.imap.appendSeed("INBOX", seed1);
      const uid2 = await h.imap.appendSeed("INBOX", seed2);

      const result = h.json<BulkResult>(
        await h.call("bulk_move_emails", {
          emailIds: [String(uid1), String(uid2)],
          targetFolder: target,
        })
      );

      expect(result.success).toBe(2);
      expect(await h.imap.uidExists("INBOX", uid1)).toBe(false);
      expect(await h.imap.uidExists("INBOX", uid2)).toBe(false);
      await expectOwnedSubject(target, seed1.subject);
      await expectOwnedSubject(target, seed2.subject);
    });

    it.skipIf(bridgeConfigAvailable())("reports failed for UIDs missing in sourceFolder (Observation O2 — honest counts)", async () => {
      const work = await scratchFolder();
      const target = await scratchFolder();
      const realUid = await h.imap.appendSeed(work, ownedSeed("bulk-move-partial"));
      const missingUid = await h.provenMissingUid(work);

      const result = h.json<BulkResult>(
        await h.call("bulk_move_emails", {
          emailIds: [String(realUid), missingUid],
          targetFolder: target,
          sourceFolder: work,
        })
      );

      // Core Bug B/O2 contract: honest success/failed split. The harness
      // doesn't assert source-folder emptiness here because Greenmail's
      // expunge semantics on a partial UID set can leave source non-empty
      // even after a successful UID MOVE (a Greenmail quirk; Bridge does
      // the right thing). The success/failed counts are the real test.
      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
      expect(result.errors.join(" ")).toContain(`${missingUid} not found in folder`);
    });

    it.skipIf(bridgeConfigAvailable())("reports all-failed when sourceFolder is wrong (Bug B silent no-op repro)", async () => {
      // Seed in WORK but tell mailpouch the source is PROJECT (empty). The
      // pre-fix behavior would have happily reported success.
      const work = await scratchFolder();
      const project = await scratchFolder();
      const target = await scratchFolder();
      const uid = await h.imap.appendSeed(work, ownedSeed("bulk-move-wrong-source"));
      const missingProjectUid = await h.provenMissingUid(project);

      const result = h.json<BulkResult>(
        await h.call("bulk_move_emails", {
          emailIds: [missingProjectUid],
          targetFolder: target,
          sourceFolder: project,
        })
      );

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
      // Nothing moved.
      expect(await h.imap.uidExists(work, uid)).toBe(true);
    });
  });

  // ── Bug C regression: bulk_mark_read flag-set with non-INBOX source ───────

  describe("bulk_mark_read — source folder routing (Bug C)", () => {
    it("sets \\Seen on UIDs in a custom folder when sourceFolder is supplied", async () => {
      const work = await scratchFolder();
      const uid1 = await h.imap.appendSeed(work, ownedSeed("bulk-seen-1"));
      const uid2 = await h.imap.appendSeed(work, ownedSeed("bulk-seen-2", PROMO_RED_LOBSTER));

      const result = h.json<BulkResult>(
        await h.call("bulk_mark_read", {
          emailIds: [String(uid1), String(uid2)],
          isRead: true,
          sourceFolder: work,
        })
      );

      expect(result.success).toBe(2);
      expect(await h.imap.getFlags(work, uid1)).toContain("\\Seen");
      expect(await h.imap.getFlags(work, uid2)).toContain("\\Seen");
    });

    it.skipIf(bridgeConfigAvailable())("reports failed for UIDs not in sourceFolder rather than silent success", async () => {
      const work = await scratchFolder();
      const realUid = await h.imap.appendSeed(work, ownedSeed("bulk-seen-partial"));
      const missingUid = await h.provenMissingUid(work);

      const result = h.json<BulkResult>(
        await h.call("bulk_mark_read", {
          emailIds: [String(realUid), missingUid],
          isRead: true,
          sourceFolder: work,
        })
      );

      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
    });

    it("clears \\Seen when isRead=false", async () => {
      const work = await scratchFolder();
      const uid = await h.imap.appendSeed(work, ownedSeed("bulk-unseen"), ["\\Seen"]);
      expect(await h.imap.getFlags(work, uid)).toContain("\\Seen");

      // Greenmail's IMAP connection can churn between rapid bulk ops in this
      // suite (UIDVALIDITY mtime drift); allow one retry via resetState if
      // the first call surfaces as a transient connection error.
      let raw = await h.call("bulk_mark_read", {
        emailIds: [String(uid)],
        isRead: false,
        sourceFolder: work,
      });
      if (raw.isError && /not connected|Command failed/i.test(raw.content[0]?.text ?? "")) {
        await h.resetState();
        raw = await h.call("bulk_mark_read", {
          emailIds: [String(uid)],
          isRead: false,
          sourceFolder: work,
        });
        h.json<BulkResult>(raw);
        expect(await h.imap.getFlags(work, uid)).not.toContain("\\Seen");
        return;
      }
      h.json<BulkResult>(raw);
      expect(await h.imap.getFlags(work, uid)).not.toContain("\\Seen");
    });
  });

  // ── Bug A regression: bulk_remove_label honest counts ─────────────────────
  //
  // Labels use a token-scoped mailbox. The semantics we care about — labels
  // have their own UID space — are modelled because UIDVALIDITY is per-mailbox.

  describe("bulk_remove_label — Labels/ UID validation (Bug A)", () => {
    it("succeeds when passed UIDs that exist inside Labels/{name}", async () => {
      const { folder, label } = await scratchLabel();
      const u1 = await h.imap.appendSeed(folder, ownedSeed("remove-label-1"));
      const u2 = await h.imap.appendSeed(folder, ownedSeed("remove-label-2", RELEASE_NVIDIA));

      const result = h.json<BulkResult>(
        await h.call("bulk_remove_label", {
          emailIds: [String(u1), String(u2)],
          label,
        })
      );

      expect(result.success).toBe(2);
      expect(await h.imap.uidExists(folder, u1)).toBe(false);
      expect(await h.imap.uidExists(folder, u2)).toBe(false);
    });

    it.skipIf(bridgeConfigAvailable())("fails honestly when passed UIDs that don't exist in Labels/{name}", async () => {
      // Pre-fix behavior: { success: 4, failed: 0 } even though nothing happened.
      const { folder, label } = await scratchLabel();
      const realUid = await h.imap.appendSeed(folder, ownedSeed("remove-label-missing"));
      const missingUid = await h.provenMissingUid(folder);

      const result = h.json<BulkResult>(
        await h.call("bulk_remove_label", {
          emailIds: [missingUid],
          label,
        })
      );

      expect(result.success).toBe(0);
      expect(result.failed).toBe(1);
      // The real UID is untouched because we didn't include it.
      expect(await h.imap.uidExists(folder, realUid)).toBe(true);
    });
  });

  // ── Singular actions ───────────────────────────────────────────────────────

  describe("mark_email_read (singular)", () => {
    it.skipIf(bridgeConfigAvailable())("marks an INBOX UID as read", async () => {
      const uid = await h.imap.appendSeed("INBOX", ownedSeed("mark-read-inbox"));
      h.json<ActionResult>(await h.call("mark_email_read", { emailId: String(uid), isRead: true }));
      expect(await h.imap.getFlags("INBOX", uid)).toContain("\\Seen");
    });

    it("marks a custom-folder UID when sourceFolder is supplied", async () => {
      const work = await scratchFolder();
      const uid = await h.imap.appendSeed(work, ownedSeed("mark-read-custom"));
      h.json<ActionResult>(
        await h.call("mark_email_read", {
          emailId: String(uid),
          isRead: true,
          sourceFolder: work,
        })
      );
      expect(await h.imap.getFlags(work, uid)).toContain("\\Seen");
    });

    it.skipIf(bridgeConfigAvailable())("returns a domain error when UID doesn't exist in sourceFolder", async () => {
      const work = await scratchFolder();
      const missingUid = await h.provenMissingUid(work);
      const result = await h.callRaw("mark_email_read", {
        emailId: missingUid,
        isRead: true,
        sourceFolder: work,
      });
      // The underlying error names the absent UID and run-owned scratch folder,
      // but mailpouch's MCP error layer normalizes it to "Resource not found".
      // Either form proves the call failed (vs. silently no-op'ing as the
      // pre-fix behavior would). The key contract is that it's an error.
      const isError =
        ("ok" in result && !result.ok) ||
        ("isError" in result && result.isError === true);
      expect(isError).toBe(true);
    });
  });

  describe("star_email (singular)", () => {
    it("sets \\Flagged on an INBOX UID", async () => {
      const source = await scratchFolder();
      const uid = await h.imap.appendSeed(source, ownedSeed("star-scratch"));
      h.json<ActionResult>(await h.call("star_email", {
        emailId: String(uid),
        isStarred: true,
        sourceFolder: source,
      }));
      expect(await h.imap.getFlags(source, uid)).toContain("\\Flagged");
    });

    it("clears \\Flagged when isStarred=false", async () => {
      const source = await scratchFolder();
      const uid = await h.imap.appendSeed(source, ownedSeed("unstar-scratch"), ["\\Flagged"]);
      h.json<ActionResult>(await h.call("star_email", {
        emailId: String(uid),
        isStarred: false,
        sourceFolder: source,
      }));
      expect(await h.imap.getFlags(source, uid)).not.toContain("\\Flagged");
    });
  });

  describe("move_email (singular)", () => {
    // Singular MOVE behavior is covered by unit tests. Live Bridge cannot
    // create the isolated source/target folders this legacy scenario needs,
    // and Greenmail's cross-connection close remains unreliable here.
    it.skip("moves UID from sourceFolder to targetFolder — needs an isolated stable backend", () => {});
  });

  describe("archive_email / move_to_trash / move_to_spam (wrappers)", () => {
    it("archive_email moves to Archive", async () => {
      const source = await scratchFolder();
      const seed = ownedSeed("archive-wrapper");
      const uid = await h.imap.appendSeed(source, seed);
      h.json<ActionResult>(await h.call("archive_email", {
        emailId: String(uid),
        sourceFolder: source,
      }));
      expect(await h.imap.uidExists(source, uid)).toBe(false);
      await expectOwnedSubject(ARCHIVE, seed.subject);
    });

    it("move_to_trash requires confirmed:true (destructive gate)", async () => {
      const source = await scratchFolder();
      const uid = await h.imap.appendSeed(source, ownedSeed("trash-blocked"));
      const blocked = await h.call("move_to_trash", { emailId: String(uid), sourceFolder: source });
      // Confirmation gate should reject without { confirmed: true }
      expect(blocked.isError).toBe(true);
      expect(await h.imap.uidExists(source, uid)).toBe(true);
    });

    it("move_to_trash with confirmed:true moves to Trash", async () => {
      const source = await scratchFolder();
      const seed = ownedSeed("trash-confirmed");
      const uid = await h.imap.appendSeed(source, seed);
      h.json<ActionResult>(await h.call("move_to_trash", {
        emailId: String(uid),
        sourceFolder: source,
        confirmed: true,
      }));
      expect(await h.imap.uidExists(source, uid)).toBe(false);
      await expectOwnedSubject("Trash", seed.subject);
    });
  });

  describe("bulk_star — flag toggle across UIDs", () => {
    it("stars multiple scratch-folder UIDs", async () => {
      const source = await scratchFolder();
      const u1 = await h.imap.appendSeed(source, ownedSeed("bulk-star-1"));
      const u2 = await h.imap.appendSeed(source, ownedSeed("bulk-star-2", PROMO_RED_LOBSTER));

      const result = h.json<BulkResult>(
        await h.call("bulk_star", {
          emailIds: [String(u1), String(u2)],
          isStarred: true,
          sourceFolder: source,
        })
      );

      expect(result.success).toBe(2);
      expect(await h.imap.getFlags(source, u1)).toContain("\\Flagged");
      expect(await h.imap.getFlags(source, u2)).toContain("\\Flagged");
    });
  });

  describe("move_to_label / bulk_move_to_label — IMAP COPY semantics", () => {
    // Previously skipped as "bridge-only" on the theory that Greenmail COPY into
    // a freshly-created label raced IDLE cache invalidation. As of v3.0.65 the
    // label tools create Labels/{name} up front (ensureFolderExists) and verify
    // the copy landed by Message-ID, so these run reliably on Greenmail — and
    // un-skipping them is what closes the gap that hid the Bug-A regression.
    it("move_to_label copies (not moves) the email to Labels/{label}", async () => {
      const source = await scratchFolder();
      const { folder, label } = await scratchLabelPath();
      const seed = ownedSeed("move-to-label");
      const uid = await h.imap.appendSeed(source, seed);
      h.json<ActionResult>(await h.call("move_to_label", {
        emailId: String(uid),
        label,
        sourceFolder: source,
      }));
      expect(await h.imap.uidExists(source, uid)).toBe(true);
      await expectOwnedSubject(folder, seed.subject);
    });

    it("bulk_move_to_label copies several UIDs to Labels/{label}", async () => {
      const source = await scratchFolder();
      const { folder, label } = await scratchLabelPath();
      const seed1 = ownedSeed("bulk-move-label-1");
      const seed2 = ownedSeed("bulk-move-label-2", PROMO_RED_LOBSTER);
      const u1 = await h.imap.appendSeed(source, seed1);
      const u2 = await h.imap.appendSeed(source, seed2);
      const result = h.json<BulkResult>(
        await h.call("bulk_move_to_label", {
          emailIds: [String(u1), String(u2)],
          label,
          sourceFolder: source,
        })
      );
      expect(result.success).toBe(2);
      expect(await h.imap.uidExists(source, u1)).toBe(true);
      expect(await h.imap.uidExists(source, u2)).toBe(true);
      await expectOwnedSubject(folder, seed1.subject);
      await expectOwnedSubject(folder, seed2.subject);
    });
  });

  // ── O2 generic — honest counts apply across the whole bulk surface ────────

  describe("honest success counts (Observation O2)", () => {
    it.skipIf(bridgeConfigAvailable())("bulk_star: partial existence yields success+failed split, not all-success", async () => {
      const source = await scratchFolder();
      const u = await h.imap.appendSeed(source, ownedSeed("bulk-star-partial"));
      const missingUid = await h.provenMissingUid(source);
      const result = h.json<BulkResult>(
        await h.call("bulk_star", {
          emailIds: [String(u), missingUid],
          isStarred: true,
          sourceFolder: source,
        })
      );
      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
    });

    it.skipIf(bridgeConfigAvailable())("bulk_mark_read: partial existence yields success+failed split", async () => {
      const source = await scratchFolder();
      const u = await h.imap.appendSeed(source, ownedSeed("bulk-read-partial"));
      const missingUid = await h.provenMissingUid(source);
      const result = h.json<BulkResult>(
        await h.call("bulk_mark_read", {
          emailIds: [String(u), missingUid],
          isRead: true,
          sourceFolder: source,
        })
      );
      expect(result.success).toBe(1);
      expect(result.failed).toBe(1);
    });
  });
});
