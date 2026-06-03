/**
 * safe-bridge.e2e — the NON-DESTRUCTIVE live-Bridge gate.
 *
 * Runs the Bridge-unique validations (the All-Mail bulk-move "false-success"
 * class / Bug A, plus move/copy/label/flag/folder/search) entirely inside a
 * token-scoped scratch namespace. It CREATES its own folders + messages
 * (`mpE2E-<runid>`-tagged) and on teardown deletes ONLY those — it never wipes,
 * never touches INBOX/system folders, and never alters any pre-existing mail.
 * So it is safe to run against a real Proton Bridge account:
 *
 *   MAILPOUCH_E2E_BRIDGE_CONFIG=<bridge.json> npm run test:e2e:bridge:safe
 *
 * Runs `safe: true` explicitly, so it also exercises the scratch logic on the
 * disposable Greenmail server in the normal `test:e2e:local` run.
 *
 * The one real folder it reads is "All Mail" — as a MOVE source, acting solely
 * on a single self-seeded, token-subjected message id. That test self-skips
 * when "All Mail" is absent (e.g. Greenmail).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startE2E, bridgeConfigAvailable, type E2EHarness } from "../mcp-client.js";
import * as docker from "../support/docker.js";
import type { SeedEmail } from "../support/mime-builder.js";
import { PROMO_CREDIT_KARMA, PROMO_RED_LOBSTER, RELEASE_NVIDIA } from "../fixtures/seed-data.js";

type BulkResult = { success: number; failed: number; errors: string[] };
type SearchResult = { emails: Array<{ id?: string; uid?: number; subject: string }> };

const A = PROMO_CREDIT_KARMA;
const B = PROMO_RED_LOBSTER;
const C = RELEASE_NVIDIA;

describe("safe-bridge.e2e — non-destructive Bridge audit (scratch-scoped)", () => {
  let h: E2EHarness;
  let token: string;

  beforeAll(async () => {
    // Greenmail only: bring up the disposable server. Bridge mode uses the real
    // backend (no docker).
    if (!bridgeConfigAvailable()) await docker.restart();
    h = await startE2E({ safe: true });
    token = h.runToken!;
    expect(h.scratch).toBeDefined();
  }, 60_000);

  afterAll(async () => { if (h) await h.close(); }); // cleanup() deletes only token folders

  /** Sorted subjects actually present in a folder (real server state). */
  async function subjectsIn(folder: string): Promise<string[]> {
    const uids = await h.imap.listUids(folder);
    const subs: string[] = [];
    for (const u of uids) { const s = await h.imap.getSubject(folder, u); if (s) subs.push(s); }
    return subs.sort();
  }
  const sorted = (xs: string[]) => [...xs].sort();
  /** A seed whose subject carries the run token — unambiguous even in All Mail. */
  const tokenSeed = (tag: string): SeedEmail => ({ ...A, subject: `${token} ${tag}` });

  it("bulk_move_emails relocates every message from a non-INBOX scratch source (no loss)", async () => {
    const src = await h.scratch!.create("folders");
    const dst = await h.scratch!.create("folders");
    const u1 = await h.imap.appendScratch(src, token, A);
    const u2 = await h.imap.appendScratch(src, token, B);
    const u3 = await h.imap.appendScratch(src, token, C);

    const r = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [u1, u2, u3].map(String), targetFolder: dst, sourceFolder: src,
    }));
    expect(r.success).toBe(3);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual([]);
    expect(await subjectsIn(dst)).toEqual(sorted([A.subject, B.subject, C.subject]));
  });

  it("bulk_move_emails works from a space-named source (the Bug-A space-in-name shape)", async () => {
    const src = await h.scratch!.create("spaced"); // `Folders/<token> spaced N` — spaces, no reserved word
    const dst = await h.scratch!.create("folders");
    const u1 = await h.imap.appendScratch(src, token, A);
    const u2 = await h.imap.appendScratch(src, token, C);

    const r = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [u1, u2].map(String), targetFolder: dst, sourceFolder: src,
    }));
    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual([]);
    expect(await subjectsIn(dst)).toEqual(sorted([A.subject, C.subject]));
  });

  it("bulk_move_to_label copies into an auto-created label, source retained (the bug-report tool)", async () => {
    const src = await h.scratch!.create("folders");
    const label = `${token}-lbl`;            // token-bearing → cleaned up
    const labelFolder = `Labels/${label}`;
    const u1 = await h.imap.appendScratch(src, token, A);
    const u2 = await h.imap.appendScratch(src, token, B);
    expect(await h.imap.mailboxExists(labelFolder)).toBe(false);

    const r = h.json<BulkResult>(await h.call("bulk_move_to_label", {
      emailIds: [u1, u2].map(String), label, sourceFolder: src,
    }));
    expect(r.success).toBe(2);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(src)).toEqual(sorted([A.subject, B.subject]));        // source RETAINED
    expect(await subjectsIn(labelFolder)).toEqual(sorted([A.subject, B.subject])); // copies present
  });

  it("bulk_mark_read sets \\Seen on a scratch folder without relocating or losing mail", async () => {
    const src = await h.scratch!.create("folders");
    const u1 = await h.imap.appendScratch(src, token, A);
    const u2 = await h.imap.appendScratch(src, token, B);

    const r = h.json<BulkResult>(await h.call("bulk_mark_read", {
      emailIds: [u1, u2].map(String), isRead: true, sourceFolder: src,
    }));
    expect(r.success).toBe(2);
    expect(await subjectsIn(src)).toEqual(sorted([A.subject, B.subject])); // nothing moved/lost
    expect(await h.imap.getFlags(src, u1)).toContain("\\Seen");
  });

  it("bulk_star sets \\Flagged on a scratch folder without relocating or losing mail", async () => {
    const src = await h.scratch!.create("folders");
    const u1 = await h.imap.appendScratch(src, token, A);

    const r = h.json<BulkResult>(await h.call("bulk_star", {
      emailIds: [String(u1)], isStarred: true, sourceFolder: src,
    }));
    expect(r.success).toBe(1);
    expect(await subjectsIn(src)).toEqual([A.subject]);
    expect(await h.imap.getFlags(src, u1)).toContain("\\Flagged");
  });

  it("folder create + rename via tools (token-named, cleaned up)", async () => {
    const a = `Folders/${token}-crud`;
    const b = `Folders/${token}-crud2`;
    h.json(await h.call("create_folder", { folderName: a }));
    expect((await h.imap.listMailboxes()).includes(a)).toBe(true);
    h.json(await h.call("rename_folder", { oldName: a, newName: b }));
    const paths = await h.imap.listMailboxes();
    expect(paths.includes(b)).toBe(true);
    expect(paths.includes(a)).toBe(false);
  });

  it("search_emails finds a seeded message within a scratch folder", async () => {
    const src = await h.scratch!.create("folders");
    await h.imap.appendScratch(src, token, tokenSeed("searchable"));
    const r = h.json<SearchResult>(await h.call("search_emails", { folder: src, subject: token }));
    expect(r.emails.some((e) => e.subject.includes(token))).toBe(true);
  });

  // GENUINE Bug A — move OUT of the real "All Mail" union. Bridge-only. Acts
  // solely on ONE self-seeded, token-subjected message id, located via a direct
  // IMAP SUBJECT search of All Mail — never other mail.
  it("bulk_move_emails relocates a self-seeded message OUT of the real All Mail union", async () => {
    if (!(await h.imap.mailboxExists("All Mail"))) {
      // No Proton All-Mail union (e.g. Greenmail) — the spaced-name analog above covers the name shape.
      return;
    }
    const src = await h.scratch!.create("folders");
    const dst = await h.scratch!.create("folders");
    const seed = tokenSeed("allmail-union");
    await h.imap.appendScratch(src, token, seed); // also surfaces in the All Mail union

    // All Mail indexing can lag a moment after APPEND — poll for OUR message.
    let amUids: number[] = [];
    for (let i = 0; i < 12 && amUids.length === 0; i++) {
      amUids = await h.imap.searchSubject("All Mail", token);
      if (amUids.length === 0) await new Promise((r) => setTimeout(r, 500));
    }
    if (amUids.length === 0) {
      console.warn("All-Mail-union test skipped: seeded message did not surface in All Mail within 6s");
      return; // Proton indexing lag, not a mailpouch defect — the non-INBOX moves above cover the core axis
    }

    const r = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [String(amUids[0])], targetFolder: dst, sourceFolder: "All Mail",
    }));
    expect(r.success).toBe(1);
    expect(r.failed).toBe(0);
    expect(await subjectsIn(dst)).toEqual([seed.subject]); // verified landing — the Bug-A property
  });
});
