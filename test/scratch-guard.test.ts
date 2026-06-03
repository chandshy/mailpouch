/**
 * The safety contract of the non-destructive Bridge gate, proven with NO server
 * and NO mailbox: the scratch guard refuses any non-token path, and cleanup
 * (move scratch messages → Trash, purge Trash of @test.local, delete the empty
 * token folders) provably touches only test artifacts — never real mail.
 */

import { describe, it, expect } from "vitest";
import { runToken, assertScratch, ScratchSession, TEST_MESSAGE_ID_MARKER, type ScratchImap } from "./e2e/support/scratch.js";

type Msg = { id: string };

/** In-memory IMAP: folders → messages, with a Trash. Models the real
 *  ScratchImap operations so cleanup's safety can be asserted offline. */
function fakeImap(init: Record<string, Msg[]> = {}) {
  const folders = new Map<string, Msg[]>(Object.entries(init).map(([k, v]) => [k, [...v]]));
  if (!folders.has("Trash")) folders.set("Trash", []);
  const deleted: string[] = [];
  const created: string[] = [];
  const imap: ScratchImap = {
    async createMailbox(p) { if (!folders.has(p)) { folders.set(p, []); created.push(p); } },
    async listMailboxes() { return [...folders.keys()]; },
    async deleteMailbox(p) { folders.delete(p); deleted.push(p); },
    async emptyToTrash(folder) {
      const msgs = folders.get(folder) ?? [];
      folders.get("Trash")!.push(...msgs);
      folders.set(folder, []);
    },
    async purgeTrash(marker) {
      folders.set("Trash", folders.get("Trash")!.filter((m) => !m.id.includes(marker)));
    },
    async countMessages(folder) {
      return (folders.get(folder) ?? []).length;
    },
  };
  return { imap, folders, deleted, created };
}

/** A fake whose emptyToTrash silently no-ops (models the Proton Bug-A class:
 *  a move-to-Trash that "succeeds" but leaves the messages in place). */
function fakeImapNoMove(init: Record<string, Msg[]> = {}) {
  const f = fakeImap(init);
  f.imap.emptyToTrash = async () => { /* no-op: move silently fails to relocate */ };
  return f;
}

describe("scratch guard — non-destructive safety contract", () => {
  it("assertScratch throws unless the path carries the run token", () => {
    const t = runToken();
    expect(() => assertScratch(`Folders/${t}-1`, t)).not.toThrow();
    expect(() => assertScratch(`Folders/${t} spaced 2`, t)).not.toThrow();
    expect(() => assertScratch("INBOX", t)).toThrow(/REFUSED/);
    expect(() => assertScratch("Folders/Life/Bills", t)).toThrow();
    expect(() => assertScratch("All Mail", t)).toThrow();
    expect(() => assertScratch(`Folders/${t}-1`, "")).toThrow();
  });

  it("ScratchSession.create produces token-bearing folders under system prefixes", async () => {
    const { imap, created } = fakeImap();
    const s = new ScratchSession(imap);
    const f = await s.create("folders");
    const l = await s.create("labels");
    const sp = await s.create("spaced");
    expect(f).toContain(s.token);
    expect(l).toContain(s.token);
    expect(sp).toContain(s.token);
    expect(f.startsWith("Folders/")).toBe(true);
    expect(l.startsWith("Labels/")).toBe(true);
    expect(sp).toMatch(/^Folders\/.* spaced /); // spaces, under Folders/, no reserved word
    expect(created).toEqual([f, l, sp]);
  });

  it("cleanup empties token folders to Trash, purges @test.local, deletes ONLY token folders — real mail intact", async () => {
    const t = "mpE2E-FIXED-abc";
    const { imap, folders, deleted } = fakeImap({
      "INBOX": [{ id: "<real@inbox>" }],
      "Folders/Life/Bills": [{ id: "<r@bills.com>" }],
      "Trash": [{ id: "<real-trashed@bank.com>" }],
      [`Folders/${t}-1`]: [{ id: "<a@test.local>" }, { id: "<b@test.local>" }],
      [`Labels/${t}-2`]: [{ id: "<c@test.local>" }],
      [`Folders/${t} spaced 3`]: [{ id: "<d@test.local>" }],
    });
    await new ScratchSession(imap, t).cleanup();

    // Only token folders deleted.
    expect(deleted.sort()).toEqual([`Folders/${t} spaced 3`, `Folders/${t}-1`, `Labels/${t}-2`].sort());
    // Real folders + their messages untouched.
    expect(folders.get("INBOX")).toEqual([{ id: "<real@inbox>" }]);
    expect(folders.get("Folders/Life/Bills")).toEqual([{ id: "<r@bills.com>" }]);
    // Trash: every @test.local message purged; the real trashed message kept.
    const trash = folders.get("Trash")!;
    expect(trash.some((m) => m.id.includes(TEST_MESSAGE_ID_MARKER))).toBe(false);
    expect(trash).toContainEqual({ id: "<real-trashed@bank.com>" });
    // No token folder survives.
    expect([...folders.keys()].some((p) => p.includes(t))).toBe(false);
  });

  it("retains a token folder (never orphans its mail) when messages can't be relocated", async () => {
    const t = "mpE2E-NOMOVE-xyz";
    const { imap, folders, deleted } = fakeImapNoMove({
      [`Folders/${t}-1`]: [{ id: "<a@test.local>" }, { id: "<b@test.local>" }],
    });
    const retained = await new ScratchSession(imap, t).cleanup();

    // The folder still has its messages → it must NOT be deleted (would orphan
    // them into the unpurgeable All Mail union). It is reported as retained.
    expect(deleted).toEqual([]);
    expect(retained).toEqual([`Folders/${t}-1`]);
    expect(folders.get(`Folders/${t}-1`)).toHaveLength(2);
  });

  it("preflight aborts if the run token is already present on the server", async () => {
    const t = "mpE2E-COLLIDE-xyz";
    const { imap } = fakeImap({ [`Folders/${t}-leftover`]: [] });
    await expect(new ScratchSession(imap, t).preflight()).rejects.toThrow(/preflight/i);
  });

  it("two run tokens never collide", () => {
    expect(runToken()).not.toBe(runToken());
  });
});
