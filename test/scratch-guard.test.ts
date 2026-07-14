/** Offline proof of the non-destructive Bridge scratch/ownership contract. */

import { describe, expect, it, vi } from "vitest";
import {
  assertScratch,
  isRunToken,
  isScratchPath,
  runToken,
  ScratchSession,
  type OwnedMoveResult,
  type ScratchImap,
} from "./e2e/support/scratch.js";
import { MutationOutcomeUnknownError } from "./e2e/support/mutation-result.mjs";

type Msg = { id: string; owner?: string };

const TOKEN_A = "mpE2E-00000000-0000-4000-8000-000000000001";
const TOKEN_B = "mpE2E-00000000-0000-4000-8000-000000000002";

interface FakeOptions {
  noMove?: boolean;
  failDelete?: boolean;
  failPurge?: boolean;
  staleMutationPasses?: number;
  pendingOwnershipProofs?: number;
  unclaimedScratch?: boolean;
  hangOwnershipScan?: boolean;
  deferOwnershipScan?: boolean;
  fatalMove?: boolean;
  retainMovedSourceAssociation?: boolean;
}

function fakeImap(init: Record<string, Msg[]> = {}, opts: FakeOptions = {}) {
  const folders = new Map<string, Msg[]>(Object.entries(init).map(([key, value]) => [key, [...value]]));
  if (!folders.has("Trash")) folders.set("Trash", []);
  const deleted: string[] = [];
  const created: Array<{ path: string; exclusive: boolean }> = [];
  let nextUidValidity = 100;
  const uidValidities = new Map<string, string>(
    [...folders.keys()].map((path) => [path, String(nextUidValidity++)]),
  );
  const claimed = new Map<string, string>(opts.unclaimedScratch
    ? []
    : [...folders.keys()]
      .filter((path) => isScratchPath(path, TOKEN_A) || isScratchPath(path, TOKEN_B))
      .map((path) => [path, uidValidities.get(path)!]));
  let activeToken: string | undefined;
  let mutationAttempts = 0;
  let cleanupRefreshes = 0;
  const mutationFolders: string[] = [];
  const cleanupEvents: string[] = [];
  let cleanupAborts = 0;
  let purgeCalls = 0;
  let resolveOwnershipScan: ((count: number) => void) | undefined;

  const owned = (folder: string, token: string) => (folders.get(folder) ?? []).filter((msg) => msg.owner === token);
  const imap: ScratchImap = {
    async createMailbox(path, exclusive = false) {
      if (exclusive && folders.has(path)) throw new Error(`Mailbox already exists: ${path}`);
      if (!folders.has(path)) {
        folders.set(path, []);
        uidValidities.set(path, String(nextUidValidity++));
      }
      created.push({ path, exclusive });
    },
    async listMailboxes() { return [...folders.keys()]; },
    async listCleanupMailboxes() {
      cleanupEvents.push("list");
      return [...folders.keys()];
    },
    async trashMailbox() { return "Trash"; },
    async refreshCleanupSession() {
      cleanupRefreshes += 1;
      cleanupEvents.push("refresh");
    },
    abortCleanupSession(reason = "cleanup aborted") {
      void reason;
      cleanupAborts += 1;
    },
    async deleteMailbox(path, expectedUidValidity) {
      if (opts.failDelete) throw new Error("delete failed");
      if (expectedUidValidity !== undefined && uidValidities.get(path) !== expectedUidValidity) {
        throw new Error(`${path}: UIDVALIDITY changed; refusing mailbox DELETE`);
      }
      folders.delete(path);
      uidValidities.delete(path);
      deleted.push(path);
    },
    setOwnershipToken(token) { activeToken = token; },
    async recordCreatedMailbox(path, token) {
      assertScratch(path, token);
      const uidValidity = uidValidities.get(path);
      if (!uidValidity) throw new Error(`Missing mailbox identity for ${path}`);
      claimed.set(path, uidValidity);
      return { path, uidValidity };
    },
    async createdMailboxProof(path) {
      const claimedUidValidity = claimed.get(path);
      const currentUidValidity = uidValidities.get(path);
      return claimedUidValidity && claimedUidValidity === currentUidValidity
        ? { path, uidValidity: claimedUidValidity }
        : undefined;
    },
    pendingOwnershipProofCount() { return opts.pendingOwnershipProofs ?? 0; },
    async moveOwnedToTrash(folder, token): Promise<OwnedMoveResult> {
      mutationFolders.push(folder);
      cleanupEvents.push(`move:${folder}`);
      if (opts.fatalMove) throw new MutationOutcomeUnknownError("mock exact-owned MOVE");
      const before = folders.get(folder) ?? [];
      const toMove = before.filter((msg) => msg.owner === token);
      mutationAttempts += 1;
      const stale = mutationAttempts <= (opts.staleMutationPasses ?? 0);
      if (!opts.noMove && !stale && toMove.length) {
        if (!opts.retainMovedSourceAssociation) {
          folders.set(folder, before.filter((msg) => msg.owner !== token));
        }
        folders.get("Trash")!.push(...toMove);
      }
      return {
        moved: opts.noMove || stale ? 0 : toMove.length,
        remainingOwned: owned(folder, token).length,
        remainingTotal: (folders.get(folder) ?? []).length,
      };
    },
    async deleteOwnedMessages(folder, token): Promise<OwnedMoveResult> {
      mutationFolders.push(folder);
      cleanupEvents.push(`delete:${folder}`);
      const before = folders.get(folder) ?? [];
      const toDelete = before.filter((msg) => msg.owner === token);
      mutationAttempts += 1;
      const stale = mutationAttempts <= (opts.staleMutationPasses ?? 0);
      if (!opts.noMove && !stale && toDelete.length) {
        folders.set(folder, before.filter((msg) => msg.owner !== token));
      }
      return {
        moved: opts.noMove || stale ? 0 : toDelete.length,
        remainingOwned: owned(folder, token).length,
        remainingTotal: (folders.get(folder) ?? []).length,
      };
    },
    async purgeOwnedTrash(token) {
      purgeCalls += 1;
      if (opts.failPurge) throw new Error("purge failed");
      const before = folders.get("Trash") ?? [];
      const purged = before.filter((msg) => msg.owner === token).length;
      folders.set("Trash", before.filter((msg) => msg.owner !== token));
      cleanupEvents.push(`purge:${purged}`);
      return purged;
    },
    async countMessages(folder) { return (folders.get(folder) ?? []).length; },
    async ownedMessageCount(folder, token) {
      cleanupEvents.push(`owned:${folder}`);
      if (opts.hangOwnershipScan && folder === "INBOX") {
        return new Promise<number>(() => undefined);
      }
      if (opts.deferOwnershipScan && folder === "INBOX") {
        return new Promise<number>((resolve) => { resolveOwnershipScan = resolve; });
      }
      return owned(folder, token).length;
    },
    async trashOwnedMessageCount(token) { return owned("Trash", token).length; },
  };
  return {
    imap,
    folders,
    deleted,
    created,
    mutationFolders,
    cleanupEvents,
    activeToken: () => activeToken,
    cleanupRefreshes: () => cleanupRefreshes,
    cleanupAborts: () => cleanupAborts,
    purgeCalls: () => purgeCalls,
    recreateMailbox(path: string, messages: Msg[] = []) {
      folders.set(path, [...messages]);
      uidValidities.set(path, String(nextUidValidity++));
    },
    resolveOwnershipScan: (count: number) => resolveOwnershipScan?.(count),
  };
}

describe("scratch guard — non-destructive ownership contract", () => {
  it("generates UUIDv4-backed run tokens", () => {
    const first = runToken();
    const second = runToken();
    expect(isRunToken(first)).toBe(true);
    expect(isRunToken(second)).toBe(true);
    expect(first).not.toBe(second);
  });

  it("accepts only anchored direct children of Folders/ or Labels/", () => {
    expect(() => assertScratch(`Folders/${TOKEN_A}-1`, TOKEN_A)).not.toThrow();
    expect(() => assertScratch(`Labels/${TOKEN_A}-label`, TOKEN_A)).not.toThrow();
    expect(() => assertScratch(`Folders/${TOKEN_A} spaced 2`, TOKEN_A)).not.toThrow();

    for (const path of [
      "INBOX",
      `INBOX/${TOKEN_A}-1`,
      `Trash/${TOKEN_A}-1`,
      `Folders/Life/${TOKEN_A}-1`,
      `Folders/prefix-${TOKEN_A}-1`,
      `Folders/${TOKEN_B}-1`,
      `Folders/${TOKEN_A}-1/child`,
    ]) {
      expect(isScratchPath(path, TOKEN_A), path).toBe(false);
      expect(() => assertScratch(path, TOKEN_A), path).toThrow(/REFUSED/);
    }
    expect(() => assertScratch("INBOX", "INBOX")).toThrow(/REFUSED/);
    expect(() => new ScratchSession(fakeImap().imap, "mpE2E-not-a-uuid")).toThrow(/Invalid E2E run token/);
  });

  it("creates token folders exclusively and activates append ownership", async () => {
    const fake = fakeImap();
    const session = new ScratchSession(fake.imap, TOKEN_A);
    const folder = await session.create("folders");
    const label = await session.create("labels");
    const spaced = await session.create("spaced");
    expect(fake.activeToken()).toBe(TOKEN_A);
    expect(fake.created).toEqual([
      { path: folder, exclusive: true },
      { path: label, exclusive: true },
      { path: spaced, exclusive: true },
    ]);
  });

  it("retains an unclaimed token-shaped folder even when it is empty", async () => {
    const collision = `Folders/${TOKEN_A}-collision`;
    const fake = fakeImap({ [collision]: [] }, { unclaimedScratch: true });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      // Leave enough wall-clock budget for instrumented coverage runs to
      // observe the semantic retention error instead of only the deadline.
      settleAfterPurgeMs: 250,
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/no positive mailbox-creation proof/i);
    expect(fake.deleted).toEqual([]);
    expect(fake.folders.has(collision)).toBe(true);
  });

  it("cleans this run across system and scratch folders without touching other mail", async () => {
    const scratch = `Folders/${TOKEN_A}-1`;
    const fake = fakeImap({
      INBOX: [
        { id: "real-inbox" },
        { id: "owned-inbox", owner: TOKEN_A },
      ],
      Archive: [{ id: "owned-archive", owner: TOKEN_A }, { id: "real-archive" }],
      Trash: [
        { id: "real@test.local" },
        { id: "other-run", owner: TOKEN_B },
        { id: "owned-trash", owner: TOKEN_A },
      ],
      [scratch]: [{ id: "owned-scratch", owner: TOKEN_A }],
    });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup();
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.residue).toEqual([]);
    expect(report.ownedMessageResidue).toEqual({});
    expect(fake.deleted).toEqual([scratch]);
    expect(fake.folders.get("INBOX")).toEqual([{ id: "real-inbox" }]);
    expect(fake.folders.get("Archive")).toEqual([{ id: "real-archive" }]);
    expect(fake.folders.get("Trash")).toEqual([
      { id: "real@test.local" },
      { id: "other-run", owner: TOKEN_B },
    ]);
  });

  it("can delete verified-empty scratch folders through a guarded caller", async () => {
    const scratch = `Folders/${TOKEN_A}-guarded-delete`;
    const fake = fakeImap({ [scratch]: [] });
    const guardedDeletes: string[] = [];
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      deleteMailbox: async (path) => {
        guardedDeletes.push(path);
        fake.folders.delete(path);
      },
    });
    expect(report.ok).toBe(true);
    expect(guardedDeletes).toEqual([scratch]);
    expect(fake.deleted).toEqual([]);
  });

  it("refuses an external delete callback in deadline-bound Bridge cleanup", async () => {
    const scratch = `Folders/${TOKEN_A}-guarded-delete`;
    const fake = fakeImap({ [scratch]: [] });
    const deleteMailbox = vi.fn(async () => undefined);

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      deleteMailbox,
      settleAfterPurgeMs: 25,
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/refuses an external mailbox-delete callback/i);
    expect(deleteMailbox).not.toHaveBeenCalled();
    expect(fake.folders.has(scratch)).toBe(true);
  });

  it("requires a fresh-session hook before deadline-bound cleanup can mutate", async () => {
    const original = [{ id: "owned-trash", owner: TOKEN_A }];
    const fake = fakeImap({ Trash: original });
    delete fake.imap.refreshCleanupSession;

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 25,
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/refreshCleanupSession|fresh authenticated session/i);
    expect(fake.purgeCalls()).toBe(0);
    expect(fake.mutationFolders).toEqual([]);
    expect(fake.folders.get("Trash")).toEqual(original);
  });

  it("deletes a run folder directly only when every contained message is owned", async () => {
    const scratch = `Folders/${TOKEN_A}-all-owned`;
    const fake = fakeImap({
      [scratch]: [
        { id: "owned-1", owner: TOKEN_A },
        { id: "owned-2", owner: TOKEN_A },
      ],
    });
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup();
    expect(report.ok).toBe(true);
    expect(report.deleted).toEqual([scratch]);
    expect(fake.folders.has(scratch)).toBe(false);
    expect(fake.folders.get("Trash")).toEqual([]);
  });

  it("may retain only verified-empty run folders on a disposable server", async () => {
    const scratch = `Folders/${TOKEN_A}-greenmail-residue`;
    const fake = fakeImap({
      [scratch]: [{ id: "owned", owner: TOKEN_A }],
    });
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      retainEmptyFolders: true,
    });
    expect(report.ok).toBe(true);
    expect(report.residue).toEqual([scratch]);
    expect(report.retained).toEqual([scratch]);
    expect(fake.folders.get(scratch)).toEqual([]);
    expect(fake.folders.get("Trash")).toEqual([]);
  });

  it("moves owned mail but retains a scratch folder containing unowned mail", async () => {
    const scratch = `Folders/${TOKEN_A}-1`;
    const fake = fakeImap({
      [scratch]: [{ id: "owned", owner: TOKEN_A }, { id: "real" }],
    });
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup();
    expect(report.ok).toBe(false);
    expect(report.retained).toEqual([scratch]);
    expect(report.errors.join(" ")).toMatch(/non-owned/);
    expect(fake.deleted).toEqual([]);
    expect(fake.folders.get(scratch)).toEqual([{ id: "real" }]);
    expect(fake.folders.get("Trash")).toEqual([]);
  });

  it("retains owned messages and the folder when MOVE silently no-ops", async () => {
    const scratch = `Folders/${TOKEN_A}-1`;
    const fake = fakeImap(
      { [scratch]: [{ id: "owned", owner: TOKEN_A }] },
      { noMove: true, failDelete: true },
    );
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup();
    expect(report.ok).toBe(false);
    expect(report.retained).toEqual([scratch]);
    expect(report.errors.join(" ")).toMatch(/could not be cleaned/);
    expect(fake.folders.get(scratch)).toEqual([{ id: "owned", owner: TOKEN_A }]);
  });

  it("reconciles stale Bridge views, cleans owned mail, and retains the empty run folder", async () => {
    const scratch = `Folders/${TOKEN_A}-eventual`;
    const fake = fakeImap(
      { [scratch]: [{ id: "owned", owner: TOKEN_A }] },
      { staleMutationPasses: 1 },
    );
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 100,
    });
    expect(report.ok).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.residue).toEqual([scratch]);
    expect(report.retained).toEqual([scratch]);
    expect(report.manualFolderCleanup).toEqual([scratch]);
    expect(report.ownedMessageResidue).toEqual({});
    expect(fake.deleted).toEqual([]);
    expect(fake.folders.get(scratch)).toEqual([]);
    expect(fake.cleanupRefreshes()).toBeGreaterThanOrEqual(2);
  });

  it("starts each owned source mutation from a fresh cleanup session", async () => {
    const fake = fakeImap({
      INBOX: [{ id: "inbox-owned", owner: TOKEN_A }],
      Archive: [{ id: "archive-owned", owner: TOKEN_A }],
    });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 100,
    });

    expect(report.ok).toBe(true);
    const mutationIndexes = fake.cleanupEvents
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => event.startsWith("move:"));
    expect(mutationIndexes).toHaveLength(2);
    expect(fake.cleanupEvents.slice(
      mutationIndexes[0]!.index + 1,
      mutationIndexes[1]!.index,
    )).toContain("refresh");
  });

  it("uses exact-owned UID DELETE instead of MOVE for projected category mailboxes", async () => {
    const fake = fakeImap({
      Starred: [{ id: "starred-owned", owner: TOKEN_A }],
      Important: [{ id: "important-owned", owner: TOKEN_A }],
    });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 250,
    });

    expect(report.ok).toBe(true);
    expect(fake.cleanupEvents).toContain("delete:Starred");
    expect(fake.cleanupEvents).toContain("delete:Important");
    expect(fake.cleanupEvents).not.toContain("move:Starred");
    expect(fake.cleanupEvents).not.toContain("move:Important");
    expect(fake.folders.get("Starred")).toEqual([]);
    expect(fake.folders.get("Important")).toEqual([]);
  });

  it("skips broad audits after mutations, prioritizes common sources, and requires two clean audits", async () => {
    const fake = fakeImap({
      INBOX: [{ id: "inbox-owned", owner: TOKEN_A }],
      "All Mail": [],
      "A very long ordinary mailbox": [],
      Important: [],
    });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 250,
    });

    expect(report.ok).toBe(true);
    const moveIndex = fake.cleanupEvents.indexOf("move:INBOX");
    const refreshAfterMove = fake.cleanupEvents.indexOf("refresh", moveIndex + 1);
    expect(moveIndex).toBeGreaterThanOrEqual(0);
    expect(refreshAfterMove).toBe(moveIndex + 1);
    expect(moveIndex).toBeLessThan(fake.cleanupEvents.indexOf("owned:A very long ordinary mailbox"));

    const trashMutationIndex = fake.cleanupEvents.indexOf("purge:1");
    const refreshAfterTrashMutation = fake.cleanupEvents.indexOf("refresh", trashMutationIndex + 1);
    const sourceCheckpointIndex = fake.cleanupEvents.indexOf("delete:INBOX", moveIndex + 1);
    expect(trashMutationIndex).toBeGreaterThan(moveIndex);
    expect(refreshAfterTrashMutation).toBe(trashMutationIndex + 1);
    expect(sourceCheckpointIndex).toBeGreaterThan(refreshAfterTrashMutation);
    expect(fake.cleanupEvents.filter((event) => event === "owned:All Mail")).toHaveLength(2);
  });

  it("hands two fresh All-Mail-only observations to standalone recovery early", async () => {
    const fake = fakeImap({
      INBOX: [],
      "All Mail": [{ id: "all-mail-only", owner: TOKEN_A }],
    });
    const startedAt = Date.now();

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 5_000,
    });

    expect(report.ok).toBe(false);
    expect(report.fatalErrorCode).toBe("MAILPOUCH_E2E_ALL_MAIL_RESCUE_REQUIRED");
    expect(report.ownedMessageResidue).toEqual({ "All Mail": 1 });
    expect(report.errors.join(" ")).toMatch(/fresh-process COPY rescue is required/i);
    expect(fake.cleanupEvents.filter((event) => event === "owned:All Mail")).toHaveLength(2);
    expect(fake.cleanupRefreshes()).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(1_500);
    expect(fake.mutationFolders).not.toContain("All Mail");
  });

  it("purges Trash before reconciling a retained source association on a fresh round", async () => {
    const fake = fakeImap({
      INBOX: [{ id: "retained-source", owner: TOKEN_A }],
      "All Mail": [],
    }, {
      retainMovedSourceAssociation: true,
    });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 250,
    });

    expect(report.ok).toBe(true);
    const move = fake.cleanupEvents.indexOf("move:INBOX");
    const purge = fake.cleanupEvents.indexOf("purge:1", move + 1);
    const sourceDelete = fake.cleanupEvents.indexOf("delete:INBOX", purge + 1);
    expect(move).toBeGreaterThanOrEqual(0);
    expect(purge).toBeGreaterThan(move);
    expect(sourceDelete).toBeGreaterThan(purge);
    expect(fake.cleanupEvents.slice(move + 1, purge)).toContain("refresh");
    expect(fake.cleanupEvents.slice(purge + 1, sourceDelete)).toContain("refresh");
    expect(fake.folders.get("INBOX")).toEqual([]);
  });

  it("never dispatches mailbox DELETE after repeated empty Bridge proofs", async () => {
    const scratch = `Folders/${TOKEN_A}-empty-proof`;
    const fake = fakeImap({ [scratch]: [] });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 100,
    });

    expect(report.ok).toBe(true);
    expect(report.residue).toEqual([scratch]);
    expect(report.retained).toEqual([scratch]);
    expect(report.manualFolderCleanup).toEqual([scratch]);
    expect(fake.deleted).toEqual([]);
    expect(fake.folders.has(scratch)).toBe(true);
    expect(fake.cleanupRefreshes()).toBeGreaterThanOrEqual(2);
  });

  it("does not delete a positively-claimed path after its UIDVALIDITY changes", async () => {
    const scratch = `Folders/${TOKEN_A}-recreated`;
    const fake = fakeImap({ [scratch]: [] });
    let refreshes = 0;
    fake.imap.refreshCleanupSession = async () => {
      refreshes += 1;
      if (refreshes === 2) fake.recreateMailbox(scratch);
    };

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 250,
    });

    expect(report.ok).toBe(false);
    expect(fake.deleted).toEqual([]);
    expect(fake.folders.has(scratch)).toBe(true);
    expect(report.errors.join(" ")).toMatch(/no positive mailbox-creation proof/i);
  });

  it("does not delete when a second fresh session reveals foreign folder content", async () => {
    const scratch = `Folders/${TOKEN_A}-transient-empty`;
    const fake = fakeImap({ [scratch]: [] });
    let refreshes = 0;
    fake.imap.refreshCleanupSession = async () => {
      refreshes += 1;
      if (refreshes === 2) fake.folders.set(scratch, [{ id: "pre-existing" }]);
    };

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 250,
    });

    expect(report.ok).toBe(false);
    expect(fake.deleted).toEqual([]);
    expect(fake.folders.get(scratch)).toEqual([{ id: "pre-existing" }]);
  });

  it("cleans a legacy rescue mailbox as an ordinary exact-owned scratch folder", async () => {
    const rescue = `Folders/${TOKEN_A}-cleanup-rescue`;
    const fake = fakeImap({
      "All Mail": [],
      [rescue]: [{ id: "owned-rescue", owner: TOKEN_A }],
    });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 100,
    });

    expect(report.ok).toBe(true);
    expect(fake.mutationFolders).toContain(rescue);
    expect(fake.deleted).not.toContain(rescue);
    expect(report.manualFolderCleanup).toContain(rescue);
    expect(fake.folders.get(rescue)).toEqual([]);
  });

  it("waits the full delivery grace and retains unresolved pending ownership proofs", async () => {
    const fake = fakeImap({}, { pendingOwnershipProofs: 1 });
    const startedAt = Date.now();
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 30,
    });

    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/unresolved pending ownership proof/i);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(30);
    expect(fake.cleanupRefreshes()).toBeGreaterThanOrEqual(2);
  });

  it("fails closed at the Bridge convergence deadline after a permanent exact-delete no-op", async () => {
    const scratch = `Folders/${TOKEN_A}-stuck`;
    const fake = fakeImap(
      { [scratch]: [{ id: "owned", owner: TOKEN_A }] },
      { noMove: true },
    );
    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 25,
    });
    expect(report.ok).toBe(false);
    expect(report.residue).toEqual([scratch]);
    expect(report.ownedMessageResidue).toEqual({ [scratch]: 1 });
    expect(report.errors.join(" ")).toMatch(/owned message residue/);
    expect(fake.folders.get(scratch)).toEqual([{ id: "owned", owner: TOKEN_A }]);
  });

  it("returns at the deadline even when an aborted ownership scan never settles", async () => {
    const fake = fakeImap({ INBOX: [] }, { hangOwnershipScan: true });
    const startedAt = Date.now();

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 25,
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(fake.cleanupAborts()).toBe(1);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/absolute deadline/i);
    expect(report.fatalErrorCode).toBe("MAILPOUCH_E2E_CLEANUP_TIMEOUT");
  });

  it("propagates a fatal mutation outcome without dispatching later cleanup operations", async () => {
    const fake = fakeImap({
      INBOX: [{ id: "first", owner: TOKEN_A }],
      Archive: [{ id: "second", owner: TOKEN_A }],
    }, { fatalMove: true });
    const startedAt = Date.now();

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 1_000,
    });

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(report.ok).toBe(false);
    expect(report.errors.join(" ")).toMatch(/did not return an explicit success/i);
    expect(report.errors.join(" ")).not.toMatch(/absolute deadline/i);
    expect(report.fatalErrorCode).toBe("MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN");
    expect(fake.mutationFolders).toHaveLength(1);
    expect(fake.purgeCalls()).toBe(1);
    expect(fake.cleanupEvents.at(-1)).toBe("move:INBOX");
  });

  it("does not mutate when an ownership read resolves after the deadline", async () => {
    const original = [{ id: "owned", owner: TOKEN_A }];
    const fake = fakeImap({ INBOX: original }, { deferOwnershipScan: true });

    const report = await new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 25,
    });
    expect(report.ok).toBe(false);
    expect(fake.cleanupAborts()).toBe(1);
    const returnedReport = structuredClone(report);

    // Simulate a transport/iterator which ignored close and delivered its read
    // result after the cleanup caller had already failed closed.
    fake.resolveOwnershipScan(1);
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.mutationFolders).toEqual([]);
    expect(fake.folders.get("INBOX")).toEqual(original);
    expect(report).toEqual(returnedReport);
  });

  it("does not mutate when All Mail resolution settles after the deadline", async () => {
    const original = [{ id: "owned-trash", owner: TOKEN_A }];
    const fake = fakeImap({ Trash: original, "All Mail": [] });
    let enteredResolver!: () => void;
    let resolveAllMail!: (path: string) => void;
    const entered = new Promise<void>((resolve) => { enteredResolver = resolve; });
    fake.imap.allMailMailbox = async () => {
      enteredResolver();
      return new Promise<string>((resolve) => { resolveAllMail = resolve; });
    };

    const cleanup = new ScratchSession(fake.imap, TOKEN_A).cleanup({
      settleAfterPurgeMs: 25,
    });
    await entered;
    const report = await cleanup;

    expect(report.ok).toBe(false);
    expect(report.fatalErrorCode).toBe("MAILPOUCH_E2E_CLEANUP_TIMEOUT");
    expect(fake.cleanupAborts()).toBe(1);
    const returnedReport = structuredClone(report);
    const returnedFolders = structuredClone([...fake.folders.entries()]);

    resolveAllMail("All Mail");
    await new Promise((resolve) => setImmediate(resolve));

    expect(fake.purgeCalls()).toBe(0);
    expect(fake.mutationFolders).toEqual([]);
    expect(fake.folders.get("Trash")).toEqual(original);
    expect([...fake.folders.entries()]).toEqual(returnedFolders);
    expect(report).toEqual(returnedReport);
  });

  it("reports purge and delete failures instead of passing silently", async () => {
    const scratch = `Folders/${TOKEN_A}-1`;
    const purgeFake = fakeImap({
      Trash: [{ id: "owned", owner: TOKEN_A }],
    }, { failPurge: true });
    const purgeReport = await new ScratchSession(purgeFake.imap, TOKEN_A).cleanup();
    expect(purgeReport.ok).toBe(false);
    expect(purgeReport.errors.join(" ")).toMatch(/purge failed/);
    expect(purgeReport.ownedMessageResidue).toEqual({ Trash: 1 });

    const deleteFake = fakeImap({ [scratch]: [] }, { failDelete: true });
    const deleteReport = await new ScratchSession(deleteFake.imap, TOKEN_A).cleanup();
    expect(deleteReport.ok).toBe(false);
    expect(deleteReport.errors.join(" ")).toMatch(/mailbox delete failed/);
    expect(deleteReport.residue).toEqual([scratch]);
  });

  it("preflight checks only this run's anchored namespace", async () => {
    const fake = fakeImap({
      [`Folders/${TOKEN_A}-leftover`]: [],
      [`Folders/prefix-${TOKEN_A}-not-owned`]: [],
    });
    await expect(new ScratchSession(fake.imap, TOKEN_A).preflight()).rejects.toThrow(/preflight/i);
    expect(fake.activeToken()).toBeUndefined();

    const onlySubstring = fakeImap({ [`Folders/prefix-${TOKEN_A}-not-owned`]: [] });
    await expect(new ScratchSession(onlySubstring.imap, TOKEN_A).preflight()).resolves.toBeUndefined();
  });
});
