/**
 * bulk-audit.e2e — full end-to-end audit of the bulk mail-relocation tools.
 *
 * Goal (per the v3.0.65 Bug-A follow-up): prove that for EVERY bulk function,
 * mail actually moves from the SOURCE to the TARGET without getting lost —
 * verified against real IMAP state by message IDENTITY (subjects), not just by
 * the tool's self-reported counts, and from NON-INBOX sources (including a
 * space-named "All Mail" analog) which is exactly the axis Bug A hid behind.
 *
 * Per relocation we assert:
 *   • the tool's {success}/{failed} match the real mailbox delta (honest counts)
 *   • MOVE: source loses exactly the targeted messages; target gains exactly
 *     those same messages (by subject); nothing lost
 *   • COPY/label: source RETAINS the messages; target gains copies of them
 *   • flags: no message relocated or lost; the flag is actually set
 *
 * Isolation: each test uses freshly-created, uniquely-named source/target
 * mailboxes, so it is independent of cross-test residue (wipe() only manages
 * the system folders). Runs against Greenmail (RFC-strict).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import {
  PROMO_CREDIT_KARMA,
  PROMO_RED_LOBSTER,
  RELEASE_NVIDIA,
} from "../fixtures/seed-data.js";

type BulkResult = { success: number; failed: number; errors: string[] };

// ASCII-only subjects so identity comparison isn't perturbed by header decoding.
const A = PROMO_CREDIT_KARMA;  // "Your credit score update"
const B = PROMO_RED_LOBSTER;   // "Endless Shrimp is back"
const C = RELEASE_NVIDIA;      // "NVIDIA CUDA 13 is released"

// Custom mailbox lifecycle is Greenmail-only. Live Bridge exercises the same
// message operations against exact-owned INBOX UIDs in safe-bridge.e2e.
describe.skipIf(bridgeConfigAvailable())("bulk-audit.e2e — mail moves source→target without loss", () => {
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

  afterAll(async () => { if (h) await h.close(); });

  beforeEach(async () => {
    await h.resetState();
  });

  const mk = (kind: "folders" | "labels" | "spaced" = "folders"): Promise<string> =>
    h.scratch!.create(kind);
  /** Sorted subjects actually present in a folder (real server state). */
  async function subjectsIn(folder: string): Promise<string[]> {
    const uids = await h.imap.listUids(folder);
    const subs: string[] = [];
    for (const u of uids) {
      const s = await h.imap.getSubject(folder, u);
      if (s) subs.push(s);
    }
    return subs.sort();
  }
  const sorted = (xs: string[]) => [...xs].sort();

  // ── bulk_move_emails: MOVE source→target, conserve identities ─────────────
  it("bulk_move_emails relocates every message from a non-INBOX source to the target (no loss)", async () => {
    const src = await mk();
    const dst = await mk();
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, B);
    const u3 = await h.imap.appendSeed(src, C);

    const r = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [u1, u2, u3].map(String),
      targetFolder: dst,
      sourceFolder: src,
    }));

    expect(r.success).toBe(3);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual([]);                              // source emptied
    expect(await subjectsIn(dst)).toEqual(sorted([A.subject, B.subject, C.subject])); // exactly these
  });

  it("bulk_move_emails works from a space-named non-INBOX source ('All Mail' analog)", async () => {
    const src = await mk("spaced"); // space in the name — the Bug-A shape
    const dst = await mk();
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, C);

    const r = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [u1, u2].map(String),
      targetFolder: dst,
      sourceFolder: src,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual([]);
    expect(await subjectsIn(dst)).toEqual(sorted([A.subject, C.subject]));
  });

  // ── bulk_move_to_label: COPY (apply label), source retained, label created ─
  // The exact tool from the bug report; its E2E was previously it.skip-ped.
  it("bulk_move_to_label copies every message into an auto-created label (source retained, no loss)", async () => {
    const src = await mk();
    const labelFolder = h.mode === "bridge"
      ? await h.scratch!.create("labels")
      : h.scratch!.path("labels");
    const label = labelFolder.slice("Labels/".length);
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, B);

    if (h.mode === "greenmail") {
      expect(await h.imap.mailboxExists(labelFolder)).toBe(false); // tool must create it
    }

    const r = h.json<BulkResult>(await h.call("bulk_move_to_label", {
      emailIds: [u1, u2].map(String),
      label,
      sourceFolder: src,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual(sorted([A.subject, B.subject]));  // COPY: source retained
    expect(await h.imap.mailboxExists(labelFolder)).toBe(true);             // label created
    expect(await subjectsIn(labelFolder)).toEqual(sorted([A.subject, B.subject]));
  });

  it("bulk_move_to_label applies a label to messages sourced from 'All Mail'", async () => {
    const src = await mk("spaced");
    const labelFolder = h.mode === "bridge"
      ? await h.scratch!.create("labels")
      : h.scratch!.path("labels");
    const label = labelFolder.slice("Labels/".length);
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, C);

    const r = h.json<BulkResult>(await h.call("bulk_move_to_label", {
      emailIds: [u1, u2].map(String),
      label,
      sourceFolder: src,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual(sorted([A.subject, C.subject]));  // retained
    expect(await subjectsIn(labelFolder)).toEqual(sorted([A.subject, C.subject]));
  });

  // ── bulk_remove_label: messages leave the label folder (no collateral) ────
  it("bulk_remove_label removes exactly the targeted messages from the label", async () => {
    const labelFolder = await mk("labels");
    const label = labelFolder.slice("Labels/".length);
    const u1 = await h.imap.appendSeed(labelFolder, A);
    const u2 = await h.imap.appendSeed(labelFolder, B);
    await h.imap.appendSeed(labelFolder, C); // kept

    const r = h.json<BulkResult>(await h.call("bulk_remove_label", {
      emailIds: [u1, u2].map(String),
      label,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(labelFolder)).toEqual([C.subject]); // only the untargeted one remains
  });

  // ── bulk_delete_emails: source loses exactly the targeted (others kept) ────
  it("bulk_delete_emails removes exactly the targeted messages from a non-INBOX source", async () => {
    const src = await mk();
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, B);
    await h.imap.appendSeed(src, C); // kept

    const r = h.json<BulkResult>(await h.call("bulk_delete_emails", {
      emailIds: [u1, u2].map(String),
      sourceFolder: src,
      confirmed: true,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual([C.subject]); // no collateral loss
  });

  // ── flag ops: nothing relocated or lost, flag actually set ────────────────
  it("bulk_star sets \\Flagged on a non-INBOX source without moving or losing mail", async () => {
    const src = await mk();
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, B);

    const r = h.json<BulkResult>(await h.call("bulk_star", {
      emailIds: [u1, u2].map(String),
      isStarred: true,
      sourceFolder: src,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual(sorted([A.subject, B.subject])); // still present
    expect(await h.imap.getFlags(src, u1)).toContain("\\Flagged");
    expect(await h.imap.getFlags(src, u2)).toContain("\\Flagged");
  });

  it("bulk_mark_read sets \\Seen on a non-INBOX source without moving or losing mail", async () => {
    const src = await mk();
    const u1 = await h.imap.appendSeed(src, A);
    const u2 = await h.imap.appendSeed(src, B);

    const r = h.json<BulkResult>(await h.call("bulk_mark_read", {
      emailIds: [u1, u2].map(String),
      isRead: true,
      sourceFolder: src,
    }));

    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual(sorted([A.subject, B.subject]));
    expect(await h.imap.getFlags(src, u1)).toContain("\\Seen");
    expect(await h.imap.getFlags(src, u2)).toContain("\\Seen");
  });

  // ── honest-counts contract: a partly-missing batch never over-counts ──────
  it.skipIf(bridgeConfigAvailable())("bulk_move_emails reports an honest success/failed split when some UIDs don't exist", async () => {
    const src = await mk();
    const dst = await mk();
    const real = await h.imap.appendSeed(src, A);
    const missing1 = real + 1_000_000;
    const missing2 = missing1 + 1;

    const r = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [String(real), String(missing1), String(missing2)],
      targetFolder: dst,
      sourceFolder: src,
    }));

    expect(r.success).toBe(1);
    expect(r.failed).toBe(2);
    expect(await subjectsIn(src)).toEqual([]);            // the real one moved
    expect(await subjectsIn(dst)).toEqual([A.subject]);   // nothing fabricated
  });
});
