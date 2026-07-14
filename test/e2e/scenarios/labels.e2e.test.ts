/**
 * labels.e2e — coverage for the label-side of src/tools/actions.ts.
 *
 * list_labels and get_emails_by_label are exercised here; move_to_label /
 * bulk_move_to_label / bulk_remove_label are covered in actions.e2e.test.ts
 * (the COPY-into-fresh-label race vs Greenmail is skipped there with a
 * pointer to the Phase-2 Bridge run).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import { PROMO_CREDIT_KARMA, PROMO_RED_LOBSTER } from "../fixtures/seed-data.js";

describe("labels.e2e", () => {
  let h: E2EHarness;

  beforeAll(async () => {
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E({ safe: true });
    expect(h.scratch).toBeDefined();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  beforeEach(async () => {
    await h.resetState();
  });

  describe("list_labels", () => {
    it("returns an array of labels (empty when none exist)", async () => {
      const result = h.json<{ labels: { name: string }[] }>(await h.call("list_labels"));
      expect(Array.isArray(result.labels)).toBe(true);
    });

    // Disabled for live Bridge because an auto-created label cannot later be
    // deleted atomically. Greenmail retains label lifecycle coverage through
    // the action scenarios.
    it.skip("lists a label after a Labels/* mailbox is created and synced", async () => {
      const labelFolder = await h.scratch!.create("labels");
      const label = labelFolder.slice("Labels/".length);
      await h.call("sync_folders");
      const result = h.json<{ labels: { name: string }[] }>(await h.call("list_labels"));
      expect(result.labels.some((l) => l.name.includes(label))).toBe(true);
    });
  });

  describe("get_emails_by_label", () => {
    it.skipIf(bridgeConfigAvailable())("returns messages from the label folder", async () => {
      const labelFolder = await h.scratch!.create("labels");
      const label = labelFolder.slice("Labels/".length);
      await h.imap.appendSeed(labelFolder, PROMO_CREDIT_KARMA);
      await h.imap.appendSeed(labelFolder, PROMO_RED_LOBSTER);
      await h.call("clear_cache");
      await h.call("sync_folders");
      const result = h.json<{ emails: { subject: string }[] }>(
        await h.call("get_emails_by_label", { label, limit: 20 })
      );
      const subjects = result.emails.map((e) => e.subject);
      expect(subjects).toEqual(expect.arrayContaining([
        PROMO_CREDIT_KARMA.subject,
        PROMO_RED_LOBSTER.subject,
      ]));
    });

    it("returns an actionable not-found error for a missing label (Cluster 6)", async () => {
      const missingFolder = h.scratch!.path("labels");
      const missingLabel = missingFolder.slice("Labels/".length);
      const raw = await h.callRaw("get_emails_by_label", { label: missingLabel, limit: 10 });
      const text = "message" in raw ? raw.message : raw.content?.[0]?.text ?? "";
      // Names the resolved Labels/<name> folder; never the opaque generic string.
      expect(text).toContain(missingFolder);
      expect(text.toLowerCase()).toContain("not found");
      expect(text).not.toBe("An error occurred");
    });
  });
});
