/**
 * The safety contract of the non-destructive Bridge gate, proven with NO server
 * and NO mailbox: the scratch guard refuses any non-token path, and cleanup
 * deletes ONLY token-bearing folders — real mail is provably untouched.
 */

import { describe, it, expect } from "vitest";
import { runToken, assertScratch, ScratchSession, type ScratchImap } from "./e2e/support/scratch.js";

function fakeImap(initial: string[] = []) {
  const folders = new Set(initial);
  const deleted: string[] = [];
  const created: string[] = [];
  const imap: ScratchImap = {
    async createMailbox(p) { folders.add(p); created.push(p); },
    async listMailboxes() { return [...folders]; },
    async deleteMailbox(p) { folders.delete(p); deleted.push(p); },
  };
  return { imap, folders, deleted, created };
}

describe("scratch guard — non-destructive safety contract", () => {
  it("assertScratch throws unless the path carries the run token", () => {
    const t = runToken();
    expect(() => assertScratch(`Folders/${t}-1`, t)).not.toThrow();
    expect(() => assertScratch(`${t} All Mail 2`, t)).not.toThrow();
    expect(() => assertScratch("INBOX", t)).toThrow(/REFUSED/);
    expect(() => assertScratch("Folders/Life/Bills", t)).toThrow();
    expect(() => assertScratch("All Mail", t)).toThrow();
    expect(() => assertScratch(`Folders/${t}-1`, "")).toThrow(); // empty token never matches
  });

  it("ScratchSession.create produces token-bearing folders only", async () => {
    const { imap, created } = fakeImap();
    const s = new ScratchSession(imap);
    const f = await s.create("folders");
    const l = await s.create("labels");
    const am = await s.create("allmail");
    expect(f).toContain(s.token);
    expect(l).toContain(s.token);
    expect(am).toContain(s.token);
    expect(l.startsWith("Labels/")).toBe(true);
    expect(am).toMatch(/All Mail/);
    expect(created).toEqual([f, l, am]);
  });

  it("cleanup deletes ONLY token folders, leaving every real folder intact", async () => {
    const t = "mpE2E-FIXED-abc";
    const real = ["INBOX", "Sent", "Archive", "Trash", "Folders/Life/Bills", "Labels/Important", "All Mail"];
    const { imap, deleted, folders } = fakeImap([
      ...real, `Folders/${t}-1`, `Labels/${t}-2`, `${t} All Mail 3`,
    ]);
    const s = new ScratchSession(imap, t);
    await s.cleanup();
    // Everything deleted carried the token; nothing real was touched.
    expect(deleted.length).toBe(3);
    expect(deleted.every((p) => p.includes(t))).toBe(true);
    for (const r of real) expect(folders.has(r)).toBe(true);
    expect([...folders].some((p) => p.includes(t))).toBe(false);
  });

  it("preflight aborts if the run token is already present on the server", async () => {
    const t = "mpE2E-COLLIDE-xyz";
    const { imap } = fakeImap([`Folders/${t}-leftover`]);
    const s = new ScratchSession(imap, t);
    await expect(s.preflight()).rejects.toThrow(/preflight/i);
  });

  it("two run tokens never collide", () => {
    expect(runToken()).not.toBe(runToken());
  });
});
