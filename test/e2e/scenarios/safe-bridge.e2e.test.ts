/**
 * Live Proton Bridge safety gate.
 *
 * Pre-existing mail and folders are read-only. Every mutation operand below is
 * a message appended by this run with the exact ownership header, Message-ID,
 * folder UIDVALIDITY, and UID recorded before dispatch. Folder lifecycle tests
 * stay on disposable Greenmail because IMAP has no atomic delete-if-empty
 * operation for a live mailbox.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bridgeConfigAvailable, startE2E, type E2EHarness } from "../mcp-client.js";
import type { SeedEmail } from "../support/mime-builder.js";
import { PROMO_CREDIT_KARMA, PROMO_RED_LOBSTER } from "../fixtures/seed-data.js";

type BulkResult = { success: number; failed: number; errors: string[] };
type SearchResult = { emails: Array<{ subject: string }> };
type SubjectExpectation = { folder: string; subject: string; present: boolean };

describe.skipIf(!bridgeConfigAvailable())("safe-bridge.e2e — exact-owned messages only", () => {
  let h: E2EHarness;
  let token: string;

  beforeAll(async () => {
    h = await startE2E({ safe: true });
    token = h.runToken!;
    expect(h.mode).toBe("bridge");
    expect(h.scratch).toBeDefined();
  });

  afterAll(async () => {
    if (h) await h.close();
  });

  const seed = (tag: string, base: SeedEmail = PROMO_CREDIT_KARMA): SeedEmail => ({
    ...base,
    subject: `${token} ${tag}`,
  });

  /**
   * APPEND through the independent fixture, then wait until mailpouch's own
   * IMAP connection can read the same exact Message-ID, subject, and ownership
   * header. Dispatching a mutation before this read-only readiness proof can
   * race Bridge's per-session projection and produce a false "UID not found".
   */
  async function appendVisible(folder: string, owned: SeedEmail, flags: string[] = []): Promise<number> {
    return (await h.appendVisibleSeed(folder, owned, flags)).uid;
  }

  async function waitForSubjects(expectations: readonly SubjectExpectation[]): Promise<void> {
    const byFolder = new Map<string, SubjectExpectation[]>();
    for (const expectation of expectations) {
      const folderExpectations = byFolder.get(expectation.folder) ?? [];
      folderExpectations.push(expectation);
      byFolder.set(expectation.folder, folderExpectations);
    }
    const deadline = Date.now() + 30_000;
    let observed = new Map<string, Map<string, number[]>>();
    do {
      observed = new Map();
      let matched = true;
      // ImapFixtures owns one mutable IMAP client, so folders are observed
      // sequentially. Each folder call reconnects once, then checks every
      // subject under that one fresh selected-mailbox session.
      for (const [folder, folderExpectations] of byFolder) {
        const matches = await h.imap.searchSubjects(
          folder,
          folderExpectations.map(({ subject }) => subject),
        );
        observed.set(folder, matches);
        if (folderExpectations.some(
          ({ subject, present }) => (matches.get(subject)?.length ?? 0) > 0 !== present,
        )) matched = false;
      }
      if (matched) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);
    for (const { folder, subject, present } of expectations) {
      expect(
        (observed.get(folder)?.get(subject)?.length ?? 0) > 0,
        `${folder} subject ${subject}`,
      ).toBe(present);
    }
  }

  async function waitForFlags(folder: string, uids: number[], expected: string[]): Promise<void> {
    const deadline = Date.now() + 30_000;
    let observed = new Map<number, string[] | null>();
    do {
      observed = await h.imap.getFlagsForUids(folder, uids);
      if ([...observed.values()].every(
        (flags) => flags && expected.every((flag) => flags.includes(flag)),
      )) return;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    } while (Date.now() < deadline);
    for (const uid of uids) {
      expect(observed.get(uid), `UID ${uid} flags`).toEqual(expect.arrayContaining(expected));
    }
  }

  it("marks and stars only exact run-owned INBOX UIDs", async () => {
    const first = seed("owned-flags-1");
    const second = seed("owned-flags-2", PROMO_RED_LOBSTER);
    const uid1 = await appendVisible("INBOX", first);
    const uid2 = await appendVisible("INBOX", second);

    const read = h.json<BulkResult>(await h.call("bulk_mark_read", {
      emailIds: [String(uid1), String(uid2)],
      isRead: true,
      sourceFolder: "INBOX",
    }));
    expect(read).toMatchObject({ success: 2, failed: 0 });

    const starred = h.json<BulkResult>(await h.call("bulk_star", {
      emailIds: [String(uid1), String(uid2)],
      isStarred: true,
      sourceFolder: "INBOX",
    }));
    expect(starred).toMatchObject({ success: 2, failed: 0 });
    await waitForFlags("INBOX", [uid1, uid2], ["\\Seen", "\\Flagged"]);
  }, 60_000);

  it("moves only exact run-owned INBOX UIDs into Archive", async () => {
    const first = seed("owned-archive-1");
    const second = seed("owned-archive-2", PROMO_RED_LOBSTER);
    const uid1 = await appendVisible("INBOX", first);
    const uid2 = await appendVisible("INBOX", second);

    const result = h.json<BulkResult>(await h.call("bulk_move_emails", {
      emailIds: [String(uid1), String(uid2)],
      targetFolder: "Archive",
      sourceFolder: "INBOX",
    }));
    expect(result).toMatchObject({ success: 2, failed: 0 });
    await waitForSubjects([
      { folder: "INBOX", subject: first.subject, present: false },
      { folder: "INBOX", subject: second.subject, present: false },
      { folder: "Archive", subject: first.subject, present: true },
      { folder: "Archive", subject: second.subject, present: true },
    ]);
  }, 90_000);

  it("moves one exact run-owned INBOX UID into Archive", async () => {
    const owned = seed("owned-archive-single");
    const uid = await appendVisible("INBOX", owned);

    const result = h.json<{ success: boolean }>(await h.call("move_email", {
      emailId: String(uid),
      targetFolder: "Archive",
      sourceFolder: "INBOX",
    }));
    expect(result.success).toBe(true);
    await waitForSubjects([
      { folder: "INBOX", subject: owned.subject, present: false },
      { folder: "Archive", subject: owned.subject, present: true },
    ]);
  }, 90_000);

  it("deletes only exact run-owned INBOX UIDs by moving them to Trash", async () => {
    const first = seed("owned-trash-1");
    const second = seed("owned-trash-2", PROMO_RED_LOBSTER);
    const uid1 = await appendVisible("INBOX", first);
    const uid2 = await appendVisible("INBOX", second);

    const result = h.json<BulkResult>(await h.call("bulk_delete_emails", {
      emailIds: [String(uid1), String(uid2)],
      sourceFolder: "INBOX",
      confirmed: true,
    }));
    expect(result).toMatchObject({ success: 2, failed: 0 });
    await waitForSubjects([
      { folder: "INBOX", subject: first.subject, present: false },
      { folder: "INBOX", subject: second.subject, present: false },
      { folder: "Trash", subject: first.subject, present: true },
      { folder: "Trash", subject: second.subject, present: true },
    ]);
  }, 90_000);

  it("deletes one exact run-owned INBOX UID by moving it to Trash", async () => {
    const owned = seed("owned-trash-single");
    const uid = await appendVisible("INBOX", owned);

    const result = h.json<{ success: boolean }>(await h.call("delete_email", {
      emailId: String(uid),
      sourceFolder: "INBOX",
      confirmed: true,
    }));
    expect(result.success).toBe(true);
    await waitForSubjects([
      { folder: "INBOX", subject: owned.subject, present: false },
      { folder: "Trash", subject: owned.subject, present: true },
    ]);
  }, 90_000);

  /**
   * The load-bearing safety property of remove_label: unlabelling detaches the
   * message from Labels/<name> and MUST leave it alive in its source folder.
   * `deleteFromFolder` implements that as \Deleted + EXPUNGE against the label
   * mailbox, which is only non-destructive because Proton treats an EXPUNGE
   * from a Labels/ mailbox as "remove this label", not "delete this message".
   *
   * That assumption lives entirely in Bridge, and Bridge has been actively
   * churning it: BRIDGE-485 (v3.24.0) separated expunge-from-old-location from
   * the unlabel path, BRIDGE-488 (v3.24.0) reverted RemoveFromMailbox to its
   * pre-3.23.0 behaviour, and BRIDGE-522 (v3.24.1) put the old unlabel endpoint
   * behind a feature flag. If any of that flips, remove_label silently becomes
   * a permanent delete.
   *
   * It cannot be covered in the Greenmail lane: there a Labels/ mailbox is an
   * ordinary folder, so an EXPUNGE genuinely destroys the message and a test
   * that only asserts "gone from the label" passes either way. Hence bridge-only.
   */
  it("remove_label detaches the label and leaves the message alive in its source folder", async () => {
    const label = await h.scratch!.create("labels");
    const labelName = label.slice("Labels/".length);
    const owned = seed("owned-unlabel-survives");
    const inboxUid = await appendVisible("INBOX", owned);

    h.json(await h.call("move_to_label", {
      emailId: String(inboxUid),
      label: labelName,
      sourceFolder: "INBOX",
    }));
    // Labelling is additive — the message is in both places before we unlabel.
    await waitForSubjects([
      { folder: "INBOX", subject: owned.subject, present: true },
      { folder: label, subject: owned.subject, present: true },
    ]);

    // Labels/ mailboxes have their own UID space, so re-resolve the UID there.
    const inLabel = await h.imap.searchSubjects(label, [owned.subject]);
    const labelUid = (inLabel.get(owned.subject) ?? [])[0];
    expect(labelUid, "message should be resolvable inside the label mailbox").toBeDefined();

    h.json(await h.call("remove_label", {
      emailId: String(labelUid),
      label: labelName,
    }));

    // The invariant: detached from the label, STILL PRESENT in INBOX. The
    // second assertion is the one that catches an unlabel-turned-delete.
    await waitForSubjects([
      { folder: label, subject: owned.subject, present: false },
      { folder: "INBOX", subject: owned.subject, present: true },
    ]);
  }, 90_000);

  it("searches a run-owned message without mutating existing mail", async () => {
    const owned = seed("owned-search");
    await appendVisible("INBOX", owned);
    const result = h.json<SearchResult>(await h.call("search_emails", {
      folder: "INBOX",
      subject: owned.subject,
    }));
    expect(result.emails.some((email) => email.subject === owned.subject)).toBe(true);
  });

  it("refuses every All Mail UID even when the message is run-owned", async () => {
    const owned = seed("owned-all-mail-refusal");
    await appendVisible("INBOX", owned);

    let allMailUids: number[] = [];
    for (let attempt = 0; attempt < 120 && allMailUids.length === 0; attempt += 1) {
      allMailUids = await h.imap.searchSubject("All Mail", owned.subject);
      if (allMailUids.length === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(allMailUids).toHaveLength(1);

    await expect(h.call("bulk_move_emails", {
      emailIds: [String(allMailUids[0])],
      targetFolder: "Archive",
      sourceFolder: "All Mail",
    })).rejects.toThrow(/remap All Mail UIDs/i);
    expect(await h.imap.isOwnedUid("All Mail", allMailUids[0]!, token)).toBe(true);
  }, 90_000);

  it("refuses live folder creation before MCP dispatch", async () => {
    await expect(h.call("create_folder", {
      folderName: `Folders/${token}-must-not-exist`,
    })).rejects.toThrow(/cannot later be deleted atomically/i);
    expect(await h.imap.mailboxExists(`Folders/${token}-must-not-exist`)).toBe(false);
  });
});
