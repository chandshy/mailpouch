/**
 * Tests for SimpleIMAPService email operation methods:
 *   - markEmailRead / starEmail
 *   - moveEmail / copyEmailToFolder
 *   - deleteFromFolder / deleteEmail
 *   - setFlag
 *   - bulkMoveEmails / bulkDeleteEmails
 *   - clearCache
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimpleIMAPService, chunkUidsForWire, IMAPNotConnectedError, normalizeAddressList, expandImapSequence } from "./simple-imap-service.js";
import type { EmailFolder, EmailMessage } from "../types/index.js";
import {
  E2E_MAILBOX_IDENTITY_ARG,
  withE2EMailboxIdentity,
} from "../config/e2e-mailbox-identity.js";

// TEST-006: this suite previously imported `beforeEach` but never used it, so
// spies/module state leaked across tests. Restore all mocks between tests.
beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

/**
 * TEST-007: produce a full `EmailFolder` (including `specialUse`) so getFolders
 * mocks don't drift from the real interface and silently feed `undefined`
 * `specialUse` into code paths that read it.
 */
function makeFolder(overrides: Partial<EmailFolder> & { path: string }): EmailFolder {
  return {
    name: overrides.name ?? overrides.path,
    path: overrides.path,
    totalMessages: overrides.totalMessages ?? 0,
    unreadMessages: overrides.unreadMessages ?? 0,
    specialUse: overrides.specialUse,
    folderType: overrides.folderType ?? "user-folder",
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEmail(id: string, folder = "INBOX"): EmailMessage {
  return {
    id,
    folder,
    from: "sender@example.com",
    to: ["recipient@example.com"],
    subject: "Test Subject",
    body: "Test body",
    date: new Date(),
    isRead: false,
    isStarred: false,
    hasAttachment: false,
    isHtml: false,
  };
}

function makeLock() {
  return { release: vi.fn() };
}

// ─── TEST-001 / TEST-002 (audit 2026-05-28): honest IMAP mocks ────────────────
//
// The pre-Batch-7 helpers had two falsehoods:
//   • `defaultFetchMock()` yielded any UID in any range, so the UID-existence
//     pre-flight in production code always succeeded — even if a test seeded
//     nothing.
//   • `messageMove` / `messageDelete` / `messageFlagsAdd` / `messageCopy`
//     ignored which mailbox was currently locked by `getMailboxLock`, so a
//     test could lock INBOX and "successfully" move a UID that only lived in
//     Sent.
//
// The replacement helpers below model real IMAP semantics:
//   • Each client owns a per-folder UID seed map. Default is empty.
//   • `getMailboxLock(folder)` records the locked folder; `lock.release()`
//     clears it.
//   • `fetch(range)` (used for the UID pre-flight) yields only UIDs that
//     exist in the currently-locked folder. No lock → no yields.
//   • `messageMove` / `messageDelete` / `messageFlagsAdd` / `messageFlagsRemove`
//     / `messageCopy` reject when any requested UID isn't in the locked
//     folder's seed set (modelling the IMAP server replying "no such UID").
//
// Tests that previously relied on the permissive default must call
// `seedUids(client, "<folder>", [<uid>, …])` explicitly.

interface MockClientState {
  uidsByFolder: Map<string, Set<string>>;
  lockedFolder: string | null;
  // folder + uid maps to a Message-ID (cross-mailbox identity used to verify a copy/move
  // can be VERIFIED to have landed in the target (the v3.0.65 honest-counts fix).
  midByFolderUid: Map<string, string>;
  // folder + uid → subject, so the mock's SEARCH can match a `subject:` criterion
  // (the live-search-freshness model for v3.0.71 / cluster 7 / O1).
  subjectByFolderUid: Map<string, string>;
  // folder + uid → raw RFC822 source, so searchSingleFolder's fetch+simpleParser
  // path can resolve a freshly-seeded message that was never put in the email cache.
  sourceByFolderUid: Map<string, string>;
  seq: number;
  // Number of leading messageMove/messageCopy calls to throw on (fault injection
  // for fallback tests) — exercises the chunk→per-UID fallback without replacing
  // the default mock, so the message-landing/verification model stays intact.
  failNext: { move: number; copy: number };
  // When set, messageMove/messageCopy RESOLVE successfully but perform NO work
  // (no landing in target, no source removal) — models Proton Bridge answering
  // a COPY/MOVE from the All Mail union with OK while doing nothing. The
  // verification layer must turn this into an honest failure, not a false success.
  silentNoOp: { move: boolean; copy: boolean };
}

const MID_SEP = "\u0001";
function midKeyOf(folder: string, uid: string | number): string { return `${folder}${MID_SEP}${uid}`; }
function defaultMid(folder: string, uid: string | number): string {
  return `<m-${folder.replace(/[^a-z0-9]/gi, "_")}-${uid}@mock>`;
}

/** Stored on the returned client object so test helpers can mutate it. */
const STATE_KEY = "__mailpouchMockState";

function clientState(client: Record<string, unknown>): MockClientState {
  return client[STATE_KEY] as MockClientState;
}

/** Seed a per-folder UID table. Call before any operation that touches `folder`. */
export function seedUids(
  client: Record<string, unknown>,
  folder: string,
  uids: Array<number | string>,
): void {
  const state = clientState(client);
  let set = state.uidsByFolder.get(folder);
  if (!set) {
    set = new Set();
    state.uidsByFolder.set(folder, set);
  }
  for (const u of uids) {
    set.add(String(u));
    const key = midKeyOf(folder, u);
    if (!state.midByFolderUid.has(key)) state.midByFolderUid.set(key, defaultMid(folder, u));
  }
}

/** Seed UIDs that have NO Message-ID (IMAP ENVELOPE returns NIL) — used to
 *  prove copy/move verification falls back to the UIDPLUS COPYUID map rather
 *  than assuming success for un-identifiable messages. */
export function seedUidsNoMid(
  client: Record<string, unknown>,
  folder: string,
  uids: Array<number | string>,
): void {
  const state = clientState(client);
  let set = state.uidsByFolder.get(folder);
  if (!set) { set = new Set(); state.uidsByFolder.set(folder, set); }
  for (const u of uids) {
    set.add(String(u));
    state.midByFolderUid.delete(midKeyOf(folder, u)); // explicitly no Message-ID
  }
}

/**
 * Seed a fully-materialised message into a folder's UID table: subject + raw
 * RFC822 source, so a live IMAP SEARCH (subject criterion) and the subsequent
 * fetch+parse can resolve it WITHOUT the email ever having been in the local
 * cache. This models freshly-arrived INBOX mail (cluster 7 / O1, v3.0.71).
 */
export function seedMessage(
  client: Record<string, unknown>,
  folder: string,
  uid: number | string,
  fields: { subject: string; from?: string; to?: string; date?: Date },
): void {
  const state = clientState(client);
  let set = state.uidsByFolder.get(folder);
  if (!set) { set = new Set(); state.uidsByFolder.set(folder, set); }
  set.add(String(uid));
  const key = midKeyOf(folder, uid);
  if (!state.midByFolderUid.has(key)) state.midByFolderUid.set(key, defaultMid(folder, uid));
  state.subjectByFolderUid.set(key, fields.subject);
  const from = fields.from ?? "sender@example.com";
  const to = fields.to ?? "recipient@example.com";
  const date = (fields.date ?? new Date()).toUTCString();
  const source =
    `Message-ID: ${state.midByFolderUid.get(key)}\r\n` +
    `From: ${from}\r\n` +
    `To: ${to}\r\n` +
    `Subject: ${fields.subject}\r\n` +
    `Date: ${date}\r\n` +
    `Content-Type: text/plain\r\n\r\n` +
    `body of ${fields.subject}\r\n`;
  state.sourceByFolderUid.set(key, source);
}

function parseUidRange(range: unknown): string[] {
  return String(range)
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^\d+$/.test(s));
}

/** Validate that every UID in `range` lives in the currently-locked folder. */
function assertUidsBelongToLockedFolder(state: MockClientState, range: unknown, op: string): void {
  const ids = parseUidRange(range);
  if (state.lockedFolder == null) {
    throw new Error(`${op} called with no mailbox locked (uids=${ids.join(",")})`);
  }
  const seeded = state.uidsByFolder.get(state.lockedFolder) ?? new Set<string>();
  const missing = ids.filter((id) => !seeded.has(id));
  if (missing.length > 0) {
    throw new Error(
      `${op}: UID(s) ${missing.join(",")} not in locked folder ${state.lockedFolder}`,
    );
  }
}

function makeClient(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const state: MockClientState = {
    uidsByFolder: new Map(),
    lockedFolder: null,
    midByFolderUid: new Map(),
    subjectByFolderUid: new Map(),
    sourceByFolderUid: new Map(),
    seq: 900000,
    failNext: { move: 0, copy: 0 },
    silentNoOp: { move: false, copy: false },
  };

  // Land `uids` from the locked source into `target` under fresh UIDs, carrying
  // each message's Message-ID across (real COPY/MOVE semantics). This is what
  // makes the v3.0.65 verification pass for genuine copies/moves.
  const landInTarget = (sourceFolder: string, target: string, uids: string[]): void => {
    let tset = state.uidsByFolder.get(target);
    if (!tset) { tset = new Set(); state.uidsByFolder.set(target, tset); }
    for (const uid of uids) {
      const mid = state.midByFolderUid.get(midKeyOf(sourceFolder, uid)) ?? defaultMid(sourceFolder, uid);
      const newUid = String(++state.seq);
      tset.add(newUid);
      state.midByFolderUid.set(midKeyOf(target, newUid), mid);
    }
  };

  const lockedFolderFetch = vi.fn().mockImplementation((range: unknown) => {
    const ids = parseUidRange(range);
    const folder = state.lockedFolder;
    const seeded = folder ? state.uidsByFolder.get(folder) ?? new Set<string>() : new Set<string>();
    return (async function* () {
      for (const id of ids) {
        if (seeded.has(id)) {
          const key = folder ? midKeyOf(folder, id) : "";
          const mid = folder ? state.midByFolderUid.get(key) : undefined;
          // When a full RFC822 source was seeded (seedMessage), expose it so the
          // searchSingleFolder fetch+simpleParser path can materialise a message
          // that was never in the local cache (live-search freshness).
          const source = folder ? state.sourceByFolderUid.get(key) : undefined;
          yield {
            uid: Number(id),
            envelope: { messageId: mid },
            ...(source !== undefined
              ? { source: Buffer.from(source, "utf8"), flags: new Set<string>(), bodyStructure: {} }
              : {}),
          };
        }
      }
    })();
  });

  // Live IMAP SEARCH over the locked folder's seeded messages.
  //   • SEARCH HEADER MESSAGE-ID <mid> — copy/move landing verification.
  //   • SEARCH SUBJECT <substr> — search_emails freshness (cluster 7 / O1).
  // Returns matching UIDs straight from the per-folder tables; nothing here
  // consults the production email cache, so a freshly-seeded message that was
  // never cached is still found — exactly the live-search guarantee under test.
  const search = vi.fn().mockImplementation(
    async (criteria: { header?: Record<string, string>; subject?: string }, _opts: unknown) => {
      const folder = state.lockedFolder;
      if (!folder) return [];
      const set = state.uidsByFolder.get(folder) ?? new Set<string>();
      const wantMid = criteria?.header?.["message-id"];
      const wantSubject = criteria?.subject;
      const hits: number[] = [];
      for (const uid of set) {
        if (wantMid !== undefined) {
          if (state.midByFolderUid.get(midKeyOf(folder, uid)) === wantMid) hits.push(Number(uid));
          continue;
        }
        if (wantSubject !== undefined) {
          const subj = state.subjectByFolderUid.get(midKeyOf(folder, uid)) ?? "";
          if (subj.toLowerCase().includes(wantSubject.toLowerCase())) hits.push(Number(uid));
          continue;
        }
        // No supported criterion → match nothing (the production code always
        // passes at least one filter in the tests below).
      }
      return hits;
    },
  );

  const getMailboxLock = vi.fn().mockImplementation(async (folder: string) => {
    state.lockedFolder = folder;
    return {
      release: vi.fn().mockImplementation(() => {
        state.lockedFolder = null;
      }),
    };
  });

  const messageFlagsAdd = vi.fn().mockImplementation(async (range: unknown, _flags: unknown, _opts: unknown) => {
    assertUidsBelongToLockedFolder(state, range, "messageFlagsAdd");
  });
  const messageFlagsRemove = vi.fn().mockImplementation(async (range: unknown, _flags: unknown, _opts: unknown) => {
    assertUidsBelongToLockedFolder(state, range, "messageFlagsRemove");
  });
  const messageMove = vi.fn().mockImplementation(async (range: unknown, target: unknown, _opts: unknown) => {
    if (state.failNext.move > 0) { state.failNext.move--; throw new Error("batch error"); }
    assertUidsBelongToLockedFolder(state, range, "messageMove");
    const ids = parseUidRange(range);
    // UIDPLUS COPYUID response: source uid → dest uid. An All-Mail no-op resolves
    // OK but relocates nothing, so it returns an EMPTY uidMap.
    if (state.silentNoOp.move) return { uidMap: new Map<number, number>() };
    const src = state.lockedFolder;
    if (src && typeof target === "string") landInTarget(src, target, ids);
    if (src) {
      const set = state.uidsByFolder.get(src);
      if (set) for (const id of ids) set.delete(id);
    }
    return { uidMap: new Map<number, number>(ids.map((id) => [Number(id), ++state.seq])) };
  });
  const messageCopy = vi.fn().mockImplementation(async (range: unknown, target: unknown, _opts: unknown) => {
    if (state.failNext.copy > 0) { state.failNext.copy--; throw new Error("batch error"); }
    assertUidsBelongToLockedFolder(state, range, "messageCopy");
    const ids = parseUidRange(range);
    if (state.silentNoOp.copy) return { uidMap: new Map<number, number>() };
    const src = state.lockedFolder;
    if (src && typeof target === "string") landInTarget(src, target, ids);
    return { uidMap: new Map<number, number>(ids.map((id) => [Number(id), ++state.seq])) };
  });
  const messageDelete = vi.fn().mockImplementation(async (range: unknown, _opts: unknown) => {
    assertUidsBelongToLockedFolder(state, range, "messageDelete");
    if (state.lockedFolder) {
      const set = state.uidsByFolder.get(state.lockedFolder);
      if (set) for (const id of parseUidRange(range)) set.delete(id);
    }
  });

  const client: Record<string, unknown> = {
    [STATE_KEY]: state,
    capabilities: new Map([["UIDPLUS", true]]),
    getMailboxLock,
    messageFlagsAdd,
    messageFlagsRemove,
    messageMove,
    messageCopy,
    messageDelete,
    search,
    fetch: lockedFolderFetch,
    ...overrides,
  };
  return client;
}

function connectSvc(svc: SimpleIMAPService, clientOverrides: Record<string, unknown> = {}): Record<string, unknown> {
  const client = makeClient(clientOverrides);
  (svc as any).isConnected = true;
  (svc as any).client = client;
  return client;
}

// ─── TEST-022: lock the compound cache-key wire format ────────────────────────
//
// The cache key is `${folder}:${uid}`. Move/delete tests exercise it
// indirectly; this locks it explicitly so a future refactor that changes the
// separator or field order is caught immediately rather than silently producing
// cache misses (which would degrade to slow folder scans, not a hard failure).

describe("SimpleIMAPService cache-key format (TEST-022)", () => {
  it("stores under `${folder}:${uid}` and reads back per-folder", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("1234", makeEmail("1234", "Archive"));

    // Internal map key must be exactly "Archive:1234".
    const keys = [...(svc as any).emailCache.keys()] as string[];
    expect(keys).toContain("Archive:1234");

    // Folder-scoped lookup hits only when both folder and uid match.
    expect((svc as any).getCacheEntry("1234", "Archive")?.id).toBe("1234");
    expect((svc as any).getCacheEntry("1234", "INBOX")).toBeUndefined();

    // Folder-agnostic lookup matches on the `:uid` suffix.
    expect((svc as any).findCacheEntryByUid("1234")?.id).toBe("1234");
  });
});

// ─── markEmailRead ────────────────────────────────────────────────────────────

describe("SimpleIMAPService.markEmailRead", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    await expect(svc.markEmailRead("1", true)).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("marks email as read (adds \\Seen flag)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [42]);
    const email = makeEmail("42");
    vi.spyOn(svc, "getEmailById").mockResolvedValue(email);

    const result = await svc.markEmailRead("42", true);

    expect(result).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("42", ["\\Seen"], { uid: true });
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it("marks email as unread (removes \\Seen flag)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [43]);
    const email = makeEmail("43");
    vi.spyOn(svc, "getEmailById").mockResolvedValue(email);

    const result = await svc.markEmailRead("43", false);

    expect(result).toBe(true);
    expect(client.messageFlagsRemove).toHaveBeenCalledWith("43", ["\\Seen"], { uid: true });
  });

  it("updates cache isRead when entry is present", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [44]);
    const email = makeEmail("44");
    // Seed the cache
    (svc as any).setCacheEntry("44", email);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(email);

    await svc.markEmailRead("44", true);

    const cached = (svc as any).getCacheEntry("44", "INBOX");
    expect(cached?.isRead).toBe(true);
  });

  it("throws when email is not found", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);

    await expect(svc.markEmailRead("99")).rejects.toThrow("not found");
  });
});

// ─── starEmail ────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.starEmail", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    await expect(svc.starEmail("1", true)).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("stars email (adds \\Flagged flag)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [10]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("10"));

    const result = await svc.starEmail("10", true);

    expect(result).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("10", ["\\Flagged"], { uid: true });
  });

  it("unstars email (removes \\Flagged flag)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [11]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("11"));

    await svc.starEmail("11", false);

    expect(client.messageFlagsRemove).toHaveBeenCalledWith("11", ["\\Flagged"], { uid: true });
  });

  it("updates cache isStarred when entry is present", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [12]);
    const email = makeEmail("12");
    (svc as any).setCacheEntry("12", email);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(email);

    await svc.starEmail("12", true);

    expect((svc as any).getCacheEntry("12", "INBOX")?.isStarred).toBe(true);
  });

  it("throws (re-throws) when getEmailById returns null", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);

    await expect(svc.starEmail("99")).rejects.toThrow("not found");
  });
});

// ─── moveEmail ────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.moveEmail", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    await expect(svc.moveEmail("1", "Trash")).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("moves email and returns true", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [20]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("20", "INBOX"));

    const result = await svc.moveEmail("20", "Trash");

    expect(result).toBe(true);
    expect(client.messageMove).toHaveBeenCalledWith("20", "Trash", { uid: true });
  });

  it("source == target is a no-op (never issues a move; guards the All Mail union)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const result = await svc.moveEmail("20", "All Mail", "All Mail");
    expect(result).toBe(true);
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("from the All Mail union, files via COPY (MOVE no-ops from the union)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "All Mail", [700]);
    const result = await svc.moveEmail("700", "Folders/Tech", "All Mail");
    expect(result).toBe(true);
    // Filed via COPY (add-label) — never MOVE, which no-ops from the union.
    expect(client.messageCopy).toHaveBeenCalledWith("700", "Folders/Tech", { uid: true });
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("evicts old cache entry on move (UID is not stable across folders)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [21]);
    const email = makeEmail("21", "INBOX");
    (svc as any).setCacheEntry("21", email);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(email);

    await svc.moveEmail("21", "Sent");

    expect((svc as any).emailCache.has("INBOX:21")).toBe(false);
  });

  it("throws when email not found", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);

    await expect(svc.moveEmail("999", "Trash")).rejects.toThrow("not found");
  });
});

// ─── copyEmailToFolder ────────────────────────────────────────────────────────

describe("SimpleIMAPService.copyEmailToFolder", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    await expect(svc.copyEmailToFolder("1", "Labels/Work")).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("copies email and returns true", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [30]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("30", "INBOX"));

    const result = await svc.copyEmailToFolder("30", "Labels/Work");

    expect(result).toBe(true);
    expect(client.messageCopy).toHaveBeenCalledWith("30", "Labels/Work", { uid: true });
  });

  it("throws when email not found", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);

    await expect(svc.copyEmailToFolder("888", "Labels/Work")).rejects.toThrow("not found");
  });
});

// ─── deleteFromFolder ─────────────────────────────────────────────────────────

describe("SimpleIMAPService.deleteFromFolder", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    await expect(svc.deleteFromFolder("1", "INBOX")).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("deletes email from folder and returns true", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [50]);

    const result = await svc.deleteFromFolder("50", "INBOX");

    expect(result).toBe(true);
    expect(client.messageDelete).toHaveBeenCalledWith("50", { uid: true });
  });

  it("evicts cache entry after deletion", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [51]);
    (svc as any).setCacheEntry("51", makeEmail("51"));

    await svc.deleteFromFolder("51", "INBOX");

    expect((svc as any).emailCache.has("INBOX:51")).toBe(false);
  });

  it("throws when messageDelete fails", async () => {
    const svc = new SimpleIMAPService();
    // Seed the UID so the pre-flight passes, then have messageDelete throw.
    const client = connectSvc(svc, { messageDelete: vi.fn().mockRejectedValue(new Error("EXPUNGED")) });
    seedUids(client, "INBOX", [52]);

    await expect(svc.deleteFromFolder("52", "INBOX")).rejects.toThrow("EXPUNGED");
  });
});

// ─── deleteEmail ──────────────────────────────────────────────────────────────

describe("SimpleIMAPService.deleteEmail", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    await expect(svc.deleteEmail("1")).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("deletes email by MOVING it to Trash (never EXPUNGE) and returns true", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [60]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("60"));

    const result = await svc.deleteEmail("60");

    expect(result).toBe(true);
    expect(client.messageMove).toHaveBeenCalledWith("60", "Trash", { uid: true });
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("is a no-op success when the email is already in Trash (never permanently deletes)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);

    const result = await svc.deleteEmail("62", "Trash");

    expect(result).toBe(true);
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("evicts email from cache after deletion", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [61]);
    const email = makeEmail("61");
    (svc as any).setCacheEntry("61", email);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(email);

    await svc.deleteEmail("61");

    expect((svc as any).emailCache.has("INBOX:61")).toBe(false);
  });

  it("throws when email not found", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);

    await expect(svc.deleteEmail("777")).rejects.toThrow("not found");
  });
});

// ─── setFlag ──────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.setFlag", () => {
  it("throws actionable guidance when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    await expect(svc.setFlag("1", "\\Answered")).rejects.toThrow(/IMAP connection is unavailable.*Proton Bridge/is);
  });

  it("adds flag using cached folder (avoids scanning all folders)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [70]);
    // Seed the cache so setFlag can find the folder without scanning
    (svc as any).setCacheEntry("70", makeEmail("70", "INBOX"));

    const result = await svc.setFlag("70", "\\Answered", true);

    expect(result).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("70", ["\\Answered"], { uid: true });
    // Should have locked the folder from cache, not scanned all folders
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  it("removes flag when set=false", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Sent", [71]);
    (svc as any).setCacheEntry("71", makeEmail("71", "Sent"));

    await svc.setFlag("71", "$Forwarded", false);

    expect(client.messageFlagsRemove).toHaveBeenCalledWith("71", ["$Forwarded"], { uid: true });
  });

  it("throws when email is not in cache and getFolders returns no match", async () => {
    const svc = new SimpleIMAPService();
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
      messageFlagsRemove: vi.fn().mockResolvedValue(undefined),
    };
    (svc as any).isConnected = true;
    (svc as any).client = client;
    vi.spyOn(svc, "getFolders").mockResolvedValue([]);

    await expect(svc.setFlag("999", "\\Answered")).rejects.toThrow("not found in any folder");
  });

  it("finds email via folder scan and sets flag (email not in cache)", async () => {
    const svc = new SimpleIMAPService();
    // Email NOT in cache — setFlag will scan all folders
    const emailId = "77";
    const mockLock = makeLock();
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue(mockLock),
      messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
      messageFlagsRemove: vi.fn().mockResolvedValue(undefined),
      // fetch returns an async generator yielding a message with matching UID
      // mockImplementation (not mockReturnValue) so each fetch() call gets
      // a fresh iterator — setFlag now calls fetch twice (folder scan +
      // pre-flight UID existence check).
      fetch: vi.fn().mockImplementation(() => asyncMessages([{ uid: 77 }])),
    };
    (svc as any).isConnected = true;
    (svc as any).client = client;
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      makeFolder({ path: "INBOX", totalMessages: 1, folderType: "system", specialUse: "\\Inbox" }),
    ]);

    const result = await svc.setFlag(emailId, "\\Answered", true);

    expect(result).toBe(true);
    expect(client.messageFlagsAdd).toHaveBeenCalledWith(emailId, ["\\Answered"], { uid: true });
  });

  it("handles fetch throwing in folder scan (catch swallows, continues to next folder)", async () => {
    const svc = new SimpleIMAPService();
    const emailId = "88";
    const mockLock = makeLock();
    async function* throwingFetch() { throw new Error("NOT IN THIS FOLDER"); }
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue(mockLock),
      messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockReturnValue(throwingFetch()),
    };
    (svc as any).isConnected = true;
    (svc as any).client = client;
    // Only one folder, fetch throws, so email is not found → throws "not found in any folder"
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      makeFolder({ path: "INBOX", folderType: "system", specialUse: "\\Inbox" }),
    ]);

    await expect(svc.setFlag(emailId, "\\Answered")).rejects.toThrow("not found in any folder");
    // lock.release() must still have been called (finally block)
    expect(mockLock.release).toHaveBeenCalled();
  });
});

// ─── bulkMoveEmails ───────────────────────────────────────────────────────────

describe("SimpleIMAPService.bulkMoveEmails", () => {
  it("throws when not connected", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    await expect(svc.bulkMoveEmails(["1", "2"], "Trash")).rejects.toThrow("not connected");
  });

  it("batch-moves emails grouped by folder", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [80, 81]);
    // Seed two emails in INBOX
    (svc as any).setCacheEntry("80", makeEmail("80", "INBOX"));
    (svc as any).setCacheEntry("81", makeEmail("81", "INBOX"));

    const results = await svc.bulkMoveEmails(["80", "81"], "Trash");

    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
    // Batch move: the UID set is sent as a single messageMove call
    expect(client.messageMove).toHaveBeenCalledWith("80,81", "Trash", { uid: true });
    // Cache entries at the old folder key should be evicted (UID is not stable across folders)
    expect((svc as any).emailCache.has("INBOX:80")).toBe(false);
    expect((svc as any).emailCache.has("INBOX:81")).toBe(false);
  });

  it("source == target is a no-op per folder (counts success, issues no move; All Mail guard)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const results = await svc.bulkMoveEmails(["80", "81"], "All Mail", "All Mail");
    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("from the All Mail union, bulk-files via COPY (MOVE no-ops from the union)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "All Mail", [701, 702]);
    const results = await svc.bulkMoveEmails(["701", "702"], "Folders/Tech", "All Mail");
    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
    expect(client.messageCopy).toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("falls back to per-email move when batch fails", async () => {
    const svc = new SimpleIMAPService();
    // Batch move fails, per-email move succeeds
    const client = connectSvc(svc);
    clientState(client).failNext.move = 1; // chunk call fails → per-UID fallback
    seedUids(client, "INBOX", [82, 83]);
    (svc as any).setCacheEntry("82", makeEmail("82", "INBOX"));
    (svc as any).setCacheEntry("83", makeEmail("83", "INBOX"));

    const results = await svc.bulkMoveEmails(["82", "83"], "Trash");

    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
  });

  it("records per-email failure in fallback mode", async () => {
    const svc = new SimpleIMAPService();
    // Batch fails, then per-email also fails
    const client = connectSvc(svc, {
      messageMove: vi.fn().mockRejectedValue(new Error("always fails")),
    });
    seedUids(client, "INBOX", [84]);
    (svc as any).setCacheEntry("84", makeEmail("84", "INBOX"));

    const results = await svc.bulkMoveEmails(["84"], "Trash");

    expect(results.failed).toBe(1);
    expect(results.errors[0]).toMatch(/always fails/);
  });

  it("counts invalid email IDs as failed immediately", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);

    // "not-a-uid" fails validateEmailId
    const results = await svc.bulkMoveEmails(["not-a-uid"], "Trash");

    expect(results.failed).toBe(1);
    expect(results.success).toBe(0);
  });

  it("discovers folder via getEmailById when email not in cache", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [95]);
    // Email 95 is NOT in cache — getEmailById is called to discover its folder
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("95", "INBOX"));

    const results = await svc.bulkMoveEmails(["95"], "Archive");

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
  });

  it("handles String() fallback when validateEmailId throws non-Error (line 1531 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => { throw 42; }); // non-Error

    const results = await svc.bulkMoveEmails(["99"], "Trash");

    expect(results.failed).toBe(1);
    expect(results.errors[0]).toContain("42"); // String(42)
  });

  it("handles non-Error in per-email fallback (line 1559 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, {
      messageMove: vi.fn()
        .mockRejectedValueOnce(new Error("batch fail")) // batch fails
        .mockRejectedValueOnce("string error"),          // per-email fails with non-Error
    });
    seedUids(client, "INBOX", [96]);
    (svc as any).setCacheEntry("96", makeEmail("96", "INBOX"));

    const results = await svc.bulkMoveEmails(["96"], "Trash");

    expect(results.failed).toBe(1);
    expect(results.errors[0]).toContain("string error"); // String("string error")
  });

  it("skips cache eviction when email not in cache after successful batch move", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [97]);
    // Email 97 is NOT in cache — getEmailById discovers its folder, then move succeeds
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("97", "INBOX"));

    const results = await svc.bulkMoveEmails(["97"], "Archive");

    expect(results.success).toBe(1);
    // No crash — evictCacheEntry is a no-op when key is absent
  });
});

// ─── bulkDeleteEmails ─────────────────────────────────────────────────────────

describe("SimpleIMAPService.bulkDeleteEmails", () => {
  it("throws when not connected", async () => {
    const svc = new SimpleIMAPService();
    await expect(svc.bulkDeleteEmails(["1"])).rejects.toThrow("not connected");
  });

  it("batch-deletes emails by MOVING them to Trash (never EXPUNGE)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [90, 91]);
    (svc as any).setCacheEntry("90", makeEmail("90", "INBOX"));
    (svc as any).setCacheEntry("91", makeEmail("91", "INBOX"));

    const results = await svc.bulkDeleteEmails(["90", "91"]);

    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
    // Delete = move to Trash, in a single batched messageMove. Never messageDelete.
    expect(client.messageMove).toHaveBeenCalledWith("90,91", "Trash", { uid: true });
    expect(client.messageDelete).not.toHaveBeenCalled();
    // Cache entries should be evicted (compound key)
    expect((svc as any).emailCache.has("INBOX:90")).toBe(false);
    expect((svc as any).emailCache.has("INBOX:91")).toBe(false);
  });

  it("is a no-op success for emails already in Trash (never permanently deletes)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);

    const results = await svc.bulkDeleteEmails(["92", "93"], "Trash");

    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("counts invalid email IDs as failed immediately", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);

    const results = await svc.bulkDeleteEmails(["not-a-uid"]);

    expect(results.failed).toBe(1);
    expect(results.success).toBe(0);
  });

  it("handles String() fallback when validateEmailId throws non-Error (line 1640 branch 1)", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => { throw { code: 99 }; }); // non-Error

    const results = await svc.bulkDeleteEmails(["99"]);

    expect(results.failed).toBe(1);
    expect(results.errors[0]).toContain("[object Object]"); // String({code:99})
  });

  it("discovers folder via getEmailById when email not in cache (then moves to Trash)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "INBOX", [95]);
    // Email "95" is NOT in cache — getEmailById is called to discover its folder
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("95", "INBOX"));

    const results = await svc.bulkDeleteEmails(["95"]);

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.messageMove).toHaveBeenCalledWith("95", "Trash", { uid: true });
  });
});

// ─── countAttachments (private) ───────────────────────────────────────────────

describe("SimpleIMAPService private countAttachments", () => {
  it("returns 0 for null/undefined structure", () => {
    const svc = new SimpleIMAPService();
    expect((svc as any).countAttachments(null)).toBe(0);
    expect((svc as any).countAttachments(undefined)).toBe(0);
  });

  it("recurses into childNodes for multipart structures", () => {
    const svc = new SimpleIMAPService();
    const structure = {
      childNodes: [
        { disposition: "attachment" }, // 1 attachment
        { type: "text" },              // not an attachment
      ],
    };
    expect((svc as any).countAttachments(structure)).toBe(1);
  });

  it("returns 1 for a leaf node with disposition=attachment", () => {
    const svc = new SimpleIMAPService();
    expect((svc as any).countAttachments({ disposition: "attachment" })).toBe(1);
  });

  it("returns 1 for a leaf node with non-text, non-multipart type", () => {
    const svc = new SimpleIMAPService();
    expect((svc as any).countAttachments({ type: "image", subtype: "png" })).toBe(1);
  });

  it("returns 0 for a leaf node with type=text", () => {
    const svc = new SimpleIMAPService();
    expect((svc as any).countAttachments({ type: "text" })).toBe(0);
  });

  it("returns 0 for a leaf node with empty type", () => {
    const svc = new SimpleIMAPService();
    expect((svc as any).countAttachments({ type: "" })).toBe(0);
  });
});

// ─── extractAttachmentMeta (private) ──────────────────────────────────────────

describe("SimpleIMAPService private extractAttachmentMeta", () => {
  it("returns [] for null/undefined structure", () => {
    const svc = new SimpleIMAPService();
    expect((svc as any).extractAttachmentMeta(null)).toEqual([]);
    expect((svc as any).extractAttachmentMeta(undefined)).toEqual([]);
  });

  it("recurses into childNodes and collects attachments", () => {
    const svc = new SimpleIMAPService();
    const structure = {
      childNodes: [
        { disposition: "attachment", dispositionParameters: { filename: "file.pdf" }, type: "application", subtype: "pdf", size: 1024 },
        { type: "text" },
      ],
    };
    const result = (svc as any).extractAttachmentMeta(structure);
    expect(result).toHaveLength(1);
    expect(result[0].filename).toBe("file.pdf");
    expect(result[0].contentType).toBe("application/pdf");
    expect(result[0].size).toBe(1024);
  });

  it("uses parameters.name as fallback filename", () => {
    const svc = new SimpleIMAPService();
    const structure = {
      disposition: "attachment",
      parameters: { name: "doc.txt" },
      type: "text",
      subtype: "plain",
      size: 100,
    };
    const result = (svc as any).extractAttachmentMeta(structure);
    expect(result[0].filename).toBe("doc.txt");
  });

  it("uses 'unnamed' when no filename available", () => {
    const svc = new SimpleIMAPService();
    const result = (svc as any).extractAttachmentMeta({ disposition: "attachment", type: "application", size: 50 });
    expect(result[0].filename).toBe("unnamed");
    expect(result[0].contentType).toBe("application/*"); // subtype ?? '*'
  });

  it("uses contentId from id field", () => {
    const svc = new SimpleIMAPService();
    const result = (svc as any).extractAttachmentMeta({ disposition: "attachment", type: "image", id: "<cid@example>", size: 0 });
    expect(result[0].contentId).toBe("<cid@example>");
  });

  it("falls back to application/octet-stream when type is missing", () => {
    const svc = new SimpleIMAPService();
    const result = (svc as any).extractAttachmentMeta({ disposition: "attachment", size: 0 });
    expect(result[0].contentType).toBe("application/octet-stream");
  });

  it("does not classify multipart as attachment (line 274 branch 2)", () => {
    const svc = new SimpleIMAPService();
    // No disposition + type=multipart → isAttachment=false (type !== 'multipart' is false)
    const result = (svc as any).extractAttachmentMeta({ type: "multipart", size: 100 });
    expect(result).toEqual([]);
  });

  it("does not classify empty-type as attachment (line 274 branch 3)", () => {
    const svc = new SimpleIMAPService();
    // No disposition + type='' → isAttachment=false (type !== '' is false)
    const result = (svc as any).extractAttachmentMeta({ type: "", size: 100 });
    expect(result).toEqual([]);
  });

  it("uses 0 as size when structure.size is undefined (line 283 branch 1)", () => {
    const svc = new SimpleIMAPService();
    // No size field → size ?? 0 = 0
    const result = (svc as any).extractAttachmentMeta({ disposition: "attachment", type: "application" });
    expect(result[0].size).toBe(0);
  });

  it("returns undefined contentId when structure.id is absent (line 283 branch 1 for id)", () => {
    const svc = new SimpleIMAPService();
    // No id field → contentId = undefined
    const result = (svc as any).extractAttachmentMeta({ disposition: "attachment", type: "application", size: 0 });
    expect(result[0].contentId).toBeUndefined();
  });
});

// ─── checkAndUpdateUidValidity (private) ──────────────────────────────────────

describe("SimpleIMAPService private checkAndUpdateUidValidity", () => {
  it("returns immediately when client has no mailbox", () => {
    const svc = new SimpleIMAPService();
    (svc as any).client = null;
    // Should not throw
    expect(() => (svc as any).checkAndUpdateUidValidity("INBOX")).not.toThrow();
  });

  it("returns immediately when mailbox is boolean", () => {
    const svc = new SimpleIMAPService();
    (svc as any).client = { mailbox: false };
    expect(() => (svc as any).checkAndUpdateUidValidity("INBOX")).not.toThrow();
  });

  it("returns immediately when uidValidity is undefined", () => {
    const svc = new SimpleIMAPService();
    (svc as any).client = { mailbox: { uidValidity: undefined } };
    expect(() => (svc as any).checkAndUpdateUidValidity("INBOX")).not.toThrow();
  });

  it("stores uidValidity on first access", () => {
    const svc = new SimpleIMAPService();
    (svc as any).client = { mailbox: { uidValidity: BigInt(1234) } };
    (svc as any).checkAndUpdateUidValidity("INBOX");
    expect((svc as any).uidValidityMap.get("INBOX")).toBe(BigInt(1234));
  });

  it("clears email cache when uidValidity changes", () => {
    const svc = new SimpleIMAPService();
    // Pre-seed the uidValidityMap with an old value
    (svc as any).uidValidityMap.set("INBOX", BigInt(100));
    (svc as any).client = { mailbox: { uidValidity: BigInt(999) } }; // new value
    // Seed the cache
    const email = makeEmail("300");
    (svc as any).setCacheEntry("300", email);
    expect((svc as any).emailCache.size).toBe(1);

    (svc as any).checkAndUpdateUidValidity("INBOX");

    // Cache should have been cleared
    expect((svc as any).emailCache.size).toBe(0);
    expect((svc as any).uidValidityMap.get("INBOX")).toBe(BigInt(999));
  });
});

// ─── clearCache ───────────────────────────────────────────────────────────────

describe("SimpleIMAPService.clearCache", () => {
  it("clears email cache and folder cache", () => {
    const svc = new SimpleIMAPService();
    // Seed some state
    const email = makeEmail("100");
    (svc as any).setCacheEntry("100", email);
    (svc as any).folderCache.set("INBOX", { name: "INBOX", path: "INBOX" });
    (svc as any).folderCachedAt = Date.now();

    svc.clearCache();

    expect((svc as any).emailCache.size).toBe(0);
    expect((svc as any).cacheByteEstimate).toBe(0);
    expect((svc as any).folderCache.size).toBe(0);
    expect((svc as any).folderCachedAt).toBe(0);
  });

  it("does not throw when caches are already empty", () => {
    const svc = new SimpleIMAPService();
    expect(() => svc.clearCache()).not.toThrow();
  });
});

// ─── getFolders ───────────────────────────────────────────────────────────────

describe("SimpleIMAPService.getFolders", () => {
  it("returns cached folders when cache is fresh", async () => {
    const svc = new SimpleIMAPService();
    // Seed folder cache with a fresh timestamp
    (svc as any).folderCache.set("INBOX", { name: "INBOX", path: "INBOX", totalMessages: 0, unreadMessages: 0, folderType: "system" });
    (svc as any).folderCachedAt = Date.now(); // freshly cached

    const folders = await svc.getFolders();

    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe("INBOX");
  });

  it("throws (not []) when ensureConnection fails and cache is empty (IMAP-012)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "ensureConnection").mockRejectedValue(new Error("no connection config"));

    // An empty array would be indistinguishable from a real zero-folder account;
    // surface the connection failure instead.
    await expect(svc.getFolders()).rejects.toThrow(/Cannot list folders/);
  });

  it("returns cached folders when ensureConnection throws and cache has data", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).folderCache.set("Sent", { name: "Sent", path: "Sent", totalMessages: 5, unreadMessages: 0, folderType: "system" });
    // Do NOT set folderCachedAt — it's 0, so cache age will be very large and TTL expired
    // but ensureConnection failure still returns the stale cache
    vi.spyOn(svc as any, "ensureConnection").mockRejectedValue(new Error("lost"));

    const folders = await svc.getFolders();

    expect(folders).toHaveLength(1);
    expect(folders[0].path).toBe("Sent");
  });

  it("throws (not []) when client is null after ensureConnection and cache is empty (IMAP-012)", async () => {
    const svc = new SimpleIMAPService();
    // ensureConnection succeeds but client remains null
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = null;

    await expect(svc.getFolders()).rejects.toThrow(/Cannot list folders/);
  });

  it("fetches from IMAP when cache is empty and client is connected", async () => {
    const svc = new SimpleIMAPService();
    const mockStatus = { messages: 10, unseen: 2 };
    const mockClient = {
      list: vi.fn().mockResolvedValue([
        { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set(), specialUse: undefined },
        { path: "Labels/Work", name: "Work", delimiter: "/", flags: new Set(), specialUse: undefined },
      ]),
      status: vi.fn().mockResolvedValue(mockStatus),
    };
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = mockClient;

    const folders = await svc.getFolders();

    expect(folders).toHaveLength(2);
    const inbox = folders.find(f => f.path === "INBOX")!;
    expect(inbox.folderType).toBe("system");
    expect(inbox.totalMessages).toBe(10);
    expect(inbox.unreadMessages).toBe(2);
    const label = folders.find(f => f.path === "Labels/Work")!;
    expect(label.folderType).toBe("label");
  });

  it("throws when IMAP list() fails", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = {
      list: vi.fn().mockRejectedValue(new Error("IMAP list failed")),
    };
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = mockClient;

    await expect(svc.getFolders()).rejects.toThrow("IMAP list failed");
  });

  it("one folder's STATUS rejection does not nuke the whole listing (allSettled)", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = {
      list: vi.fn().mockResolvedValue([
        { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set(), specialUse: undefined },
        { path: "Folders/Flaky", name: "Flaky", delimiter: "/", flags: new Set(), specialUse: undefined },
      ]),
      status: vi.fn().mockImplementation((path: string) =>
        path === "Folders/Flaky"
          ? Promise.reject(new Error("STATUS failed for this mailbox"))
          : Promise.resolve({ messages: 7, unseen: 1 })),
    };
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = mockClient;

    const folders = await svc.getFolders();

    expect(folders).toHaveLength(2);
    expect(folders.find(f => f.path === "INBOX")!.totalMessages).toBe(7);
    // The flaky folder still appears, with safe 0 counts rather than dropping it.
    const flaky = folders.find(f => f.path === "Folders/Flaky")!;
    expect(flaky.totalMessages).toBe(0);
    expect(flaky.unreadMessages).toBe(0);
  });

  it("classifies a folder named 'Junk' as system (SYSTEM_FOLDER_NAMES includes junk)", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = {
      list: vi.fn().mockResolvedValue([
        { path: "Junk", name: "Junk", delimiter: "/", flags: new Set(), specialUse: undefined },
      ]),
      status: vi.fn().mockResolvedValue({ messages: 0, unseen: 0 }),
    };
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = mockClient;

    const folders = await svc.getFolders();
    expect(folders.find(f => f.path === "Junk")!.folderType).toBe("system");
  });

  it("uses 0 when status.messages and status.unseen are missing (lines 526-527)", async () => {
    const svc = new SimpleIMAPService();
    const mockClient = {
      list: vi.fn().mockResolvedValue([
        { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set(), specialUse: undefined },
      ]),
      status: vi.fn().mockResolvedValue({}), // no messages/unseen keys → fallback to 0
    };
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = mockClient;

    const folders = await svc.getFolders();
    expect(folders[0].totalMessages).toBe(0);
    expect(folders[0].unreadMessages).toBe(0);
  });
});

// ─── estimateCacheBytes (private static) ──────────────────────────────────────

describe("SimpleIMAPService.estimateCacheBytes null fallbacks (lines 96-98)", () => {
  it("falls back to 0 when body/subject/from are undefined", () => {
    const email: EmailMessage = {
      id: "x",
      folder: "INBOX",
      from: undefined as any,   // triggers ?? 0 at line 98
      to: [],
      subject: undefined as any, // triggers ?? 0 at line 97
      body: undefined as any,    // triggers ?? 0 at line 96
      date: new Date(),
      isRead: false,
      isStarred: false,
      hasAttachment: false,
      isHtml: false,
    };

    // estimateCacheBytes is a private static method — call it via setCacheEntry
    const svc = new SimpleIMAPService();
    // Setting a cache entry exercises estimateCacheBytes internally
    (svc as any).setCacheEntry("x", email);
    expect((svc as any).emailCache.has("INBOX:x")).toBe(true);
    // Byte estimate should be 200 (fixed overhead) when all string fields are undefined
    expect((svc as any).cacheByteEstimate).toBe(200);
  });
});

// ─── getEmailById (early-exit paths) ─────────────────────────────────────────

describe("SimpleIMAPService.getEmailById (early-exit)", () => {
  it("returns cached email when cache hit", async () => {
    const svc = new SimpleIMAPService();
    const email = makeEmail("200");
    (svc as any).setCacheEntry("200", email);

    const result = await svc.getEmailById("200");

    expect(result).not.toBeNull();
    expect(result!.id).toBe("200");
  });

  it("returns null when not connected and cache is empty", async () => {
    const svc = new SimpleIMAPService();
    // isConnected=false, client=null by default

    const result = await svc.getEmailById("404");

    expect(result).toBeNull();
  });
});

// ─── getEmails (early-exit paths and main fetch) ─────────────────────────────

/** Create an async generator that yields the given messages one by one. */
async function* asyncMessages(msgs: unknown[]) {
  for (const m of msgs) yield m;
}

describe("SimpleIMAPService.getEmails", () => {
  // IMAP-012: a connection failure must surface as a typed error, NOT a silent
  // empty array. An empty array is indistinguishable from a genuinely empty
  // folder, so a model could report "you have 0 emails" while the bridge is down.
  it("throws IMAPNotConnectedError when ensureConnection throws", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockRejectedValue(new Error("no config"));

    await expect(svc.getEmails("INBOX")).rejects.toBeInstanceOf(IMAPNotConnectedError);
  });

  it("throws IMAPNotConnectedError when client is null after ensureConnection", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    (svc as any).client = null;

    await expect(svc.getEmails("INBOX")).rejects.toBeInstanceOf(IMAPNotConnectedError);
  });

  it("returns [] when mailbox has 0 messages", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 0 },
    };

    expect(await svc.getEmails("INBOX")).toEqual([]);
  });

  it("fetches and returns emails from the IMAP fetch loop", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsg = {
      uid: 101,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "Hello World",
        from: [{ name: "Alice", address: "alice@example.com" }],
        to: [{ address: "bob@example.com" }],
        cc: [{ name: "Charlie", address: "charlie@example.com" }], // CC with name
      },
      flags: new Set(["\\Seen"]),
      bodyParts: new Map([["1", Buffer.from("Email body text")]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX", 50, 0);

    expect(emails).toHaveLength(1);
    expect(emails[0].id).toBe("101");
    expect(emails[0].subject).toBe("Hello World");
    expect(emails[0].from).toBe("Alice <alice@example.com>");
    expect(emails[0].isRead).toBe(true);
    expect(emails[0].isStarred).toBe(false);
  });

  it("skips messages with no envelope", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsgNoEnv = { uid: 1, envelope: null, flags: new Set(), bodyParts: new Map(), bodyStructure: {} };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsgNoEnv])),
    };

    const emails = await svc.getEmails("INBOX");

    expect(emails).toHaveLength(0);
  });

  it("returns [] (not a clamped message #1) when offset is at/beyond the message count", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    const fetch = vi.fn();
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 5 },
      fetch,
    };

    // offset (5) == total (5): an empty page, not message #1.
    expect(await svc.getEmails("INBOX", 50, 5)).toEqual([]);
    // offset beyond total too.
    expect(await svc.getEmails("INBOX", 50, 100)).toEqual([]);
    // The Math.max(1,…) clamp must never reach a FETCH for an out-of-range page.
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads $Forwarded in the list view (not the bogus \\Forward)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsg = {
      uid: 7, envelope: { subject: "Fwd", from: [{ address: "a@x.com" }], date: new Date() },
      flags: new Set(["$Forwarded"]), bodyParts: new Map([["1", Buffer.from("hi")]]), bodyStructure: {},
    };
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails[0].isForwarded).toBe(true);
  });

  it("throws when fetch() rejects", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});

    // Make fetch() itself throw (not iterate)
    async function* throwingGen() { throw new Error("fetch failed"); }

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(throwingGen()),
    };

    await expect(svc.getEmails("INBOX")).rejects.toThrow("fetch failed");
  });

  it("catches per-message parse errors without failing the whole fetch (line 657)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    // countAttachments throws for this message
    vi.spyOn(svc as any, "countAttachments").mockImplementation(() => {
      throw new Error("bodyStructure parse error");
    });

    const mockMsg = {
      uid: 999,
      envelope: {
        date: new Date(),
        subject: "Error email",
        from: [{ address: "a@b.com" }],
        to: [],
        cc: [],
      },
      flags: new Set(),
      bodyParts: new Map([["1", Buffer.from("body")]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    // Should NOT throw — per-message error is caught and logged
    const emails = await svc.getEmails("INBOX");
    expect(emails).toEqual([]);
  });

  it("uses ?? 50/0 fallback when limit/offset are null (lines 557-558)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 0 },
    };

    // Passing null bypasses default params and triggers ?? 50 / ?? 0 branches at runtime
    const emails = await (svc as any).getEmails("INBOX", null, null);
    expect(emails).toEqual([]);
  });

  it("uses 0 when mailbox is null (line 583 cond-expr branch 1)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: null, // → cond-expr false branch → total=0
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toEqual([]);
  });

  it("handles from with no name and no address (line 619 address ?? '' branch)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsg = {
      uid: 211,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "No from details",
        from: [{}],          // no name, no address → else branch, address ?? '' = ''
        to: [{ name: "Bob" }], // name, no address → a.address ?? '' = '' (line 623)
        cc: [{}],            // no name, no address → a.address ?? '' = '' (line 626)
      },
      flags: new Set(),
      bodyParts: new Map([["1", Buffer.from("body")]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].from).toBe(""); // no name, no address → ''
    expect(emails[0].to).toEqual(["Bob <>"]); // name but no address
    expect(emails[0].cc).toEqual([""]); // no name, no address → a.address ?? '' = ''
  });

  it("uses empty bodyPreview when bodyParts has no '1' key (line 43 truncateBody)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsg = {
      uid: 200,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "No Body",
        from: [{ address: "a@b.com" }],
        to: [],
        cc: [],
      },
      flags: new Set(),
      bodyParts: new Map(), // no '1' key → bodyText = '' → truncateBody('') → line 43
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].bodyPreview).toBe(""); // truncateBody('') returns ''
  });

  it("truncates long body with word boundary after 80% of limit (lines 53,56,57)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    // Body: 245 'a's then a space then 100 'b's → lastSpace at 245 > 240 (80% of 300) → word-boundary truncation
    const longBody = "a".repeat(245) + " " + "b".repeat(100);

    const mockMsg = {
      uid: 201,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "Long Body",
        from: [{ address: "a@b.com" }],
        to: [],
        cc: [],
      },
      flags: new Set(),
      bodyParts: new Map([["1", Buffer.from(longBody)]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].bodyPreview).toMatch(/\.\.\.$/); // ends with ellipsis
    expect(emails[0].bodyPreview!.length).toBeLessThan(longBody.length);
  });

  it("formats addresses with name (to) and without name (cc) — branch coverage (lines 618-626)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsg = {
      uid: 210,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "Address Test",
        from: [{ name: "Alice" }],          // name but no address → address ?? '' = ''
        to: [{ name: "Bob", address: "bob@example.com" }], // with name → covers cond-expr branch 0
        cc: [{ address: "carol@example.com" }],  // no name → covers cond-expr branch 1 for cc
      },
      flags: new Set(),
      bodyParts: new Map([["1", Buffer.from("body")]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].from).toBe("Alice <>"); // name with empty address fallback
    expect(emails[0].to).toEqual(["Bob <bob@example.com>"]); // with name
    expect(emails[0].cc).toEqual(["carol@example.com"]); // no name
  });

  it("handles null/undefined envelope fields with fallback values (lines 616,639,643,645)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    const mockMsg = {
      uid: 203,
      envelope: {
        date: null,    // → fallback new Date()
        subject: null, // → '(No Subject)'
        from: null,    // → from = ''
        to: null,      // → to = []
        cc: null,      // → cc = []
      },
      flags: undefined, // → isRead=false, isStarred=false
      bodyParts: new Map([["1", Buffer.from("body")]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].subject).toBe("(No Subject)");
    expect(emails[0].from).toBe("");
    expect(emails[0].to).toEqual([]);
    expect(emails[0].isRead).toBe(false);
  });

  it("calls extractAttachmentMeta when countAttachments > 0 (line 630 branch 0)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(2); // > 0 → extractAttachmentMeta called
    vi.spyOn(svc as any, "extractAttachmentMeta").mockReturnValue([
      { filename: "doc.pdf", contentType: "application/pdf", size: 1024, contentId: undefined },
    ]);

    const mockMsg = {
      uid: 204,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "Has Attachments",
        from: [{ address: "a@b.com" }],
        to: [],
        cc: [],
      },
      flags: new Set(),
      bodyParts: new Map([["1", Buffer.from("body")]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].hasAttachment).toBe(true);
    expect(emails[0].attachments).toHaveLength(1);
  });

  it("truncates long body at hard limit when no word boundary after 80% (line 60)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    vi.spyOn(svc as any, "ensureConnection").mockResolvedValue(undefined);
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    vi.spyOn(svc as any, "countAttachments").mockReturnValue(0);

    // 'a '.repeat(120) = 240 chars, last space at 239 (≤ 240 = 80% of 300), then 100 'b's
    // → falls through to hard truncation at line 60
    const longBody = "a ".repeat(120) + "b".repeat(100);

    const mockMsg = {
      uid: 202,
      envelope: {
        date: new Date("2024-01-01"),
        subject: "Hard Truncation",
        from: [{ address: "a@b.com" }],
        to: [],
        cc: [],
      },
      flags: new Set(),
      bodyParts: new Map([["1", Buffer.from(longBody)]]),
      bodyStructure: {},
    };

    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      mailbox: { exists: 1 },
      fetch: vi.fn().mockReturnValue(asyncMessages([mockMsg])),
    };

    const emails = await svc.getEmails("INBOX");
    expect(emails).toHaveLength(1);
    expect(emails[0].bodyPreview).toMatch(/\.\.\.$/);
  });
});

// ─── getCacheEntry TTL eviction ───────────────────────────────────────────────

describe("SimpleIMAPService getCacheEntry TTL (lines 216-217)", () => {
  it("evicts and returns undefined when cached email TTL has expired", async () => {
    const svc = new SimpleIMAPService();

    const email = makeEmail("77");
    // Manually insert with an expired timestamp (10 min ago, well past 5-min TTL)
    (svc as any).emailCache.set("INBOX:77", { email, cachedAt: Date.now() - 10 * 60 * 1000 });
    (svc as any).cacheByteEstimate = 100;

    // getEmailById calls findCacheEntryByUid internally; with an expired entry and
    // isConnected=false it should return null (cache miss after TTL eviction)
    const result = await svc.getEmailById("77");
    expect(result).toBeNull();
    // Cache entry should have been evicted
    expect((svc as any).emailCache.has("INBOX:77")).toBe(false);
  });
});

// ─── disconnect ───────────────────────────────────────────────────────────────

describe("SimpleIMAPService.disconnect", () => {
  it("logs out and clears state when connected", async () => {
    const svc = new SimpleIMAPService();
    const logout = vi.fn().mockResolvedValue(undefined);
    (svc as any).isConnected = true;
    (svc as any).client = { logout };

    await svc.disconnect();

    expect(logout).toHaveBeenCalledTimes(1);
    expect((svc as any).client).toBeNull();
    expect((svc as any).isConnected).toBe(false);
  });

  it("is a no-op when already disconnected", async () => {
    const svc = new SimpleIMAPService();
    // client is null and isConnected is false by default
    await expect(svc.disconnect()).resolves.toBeUndefined();
    expect((svc as any).client).toBeNull();
  });

  it("detaches and closes a half-open client even when isConnected is false", async () => {
    const svc = new SimpleIMAPService();
    const close = vi.fn();
    const logout = vi.fn();
    (svc as any).isConnected = false;
    (svc as any).client = { close, logout };

    await svc.disconnect();

    expect(close).toHaveBeenCalledTimes(1);
    expect(logout).not.toHaveBeenCalled();
    expect((svc as any).client).toBeNull();
    expect((svc as any).isConnected).toBe(false);
  });
});

// ─── isActive ─────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.isActive", () => {
  it("returns false when not connected", () => {
    const svc = new SimpleIMAPService();
    expect(svc.isActive()).toBe(false);
  });

  it("returns false when isConnected=true but client=null", () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = null;
    expect(svc.isActive()).toBe(false);
  });

  it("returns true when connected with a real client", () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = { noop: vi.fn() };
    expect(svc.isActive()).toBe(true);
  });
});

// ─── reconnect (private) ──────────────────────────────────────────────────────

describe("SimpleIMAPService private reconnect", () => {
  it("throws when connectionConfig is null", async () => {
    const svc = new SimpleIMAPService();
    // connectionConfig is null by default
    await expect((svc as any).reconnect()).rejects.toThrow(/no connection config/);
  });

  it("calls connect() with stored credentials", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).connectionConfig = {
      host: "localhost",
      port: 1143,
      username: "user@example.com",
      password: "secret",
    };
    const connectSpy = vi.spyOn(svc, "connect").mockResolvedValue(undefined);

    await (svc as any).reconnect();

    expect(connectSpy).toHaveBeenCalledWith("localhost", 1143, "user@example.com", "secret", undefined, undefined, false);
  });
});

// ─── setFlag: non-matching UID in folder scan ─────────────────────────────────

describe("SimpleIMAPService.setFlag non-matching UID", () => {
  it("yields non-matching UID in folder scan → folder not found (lines 1470, 1472 branch1)", async () => {
    const svc = new SimpleIMAPService();
    const emailId = "199";
    const mockLock = makeLock();
    // fetch yields a message with a DIFFERENT uid (not matching emailId "199")
    async function* yieldNonMatch() { yield { uid: 999 }; }
    const client = {
      getMailboxLock: vi.fn().mockResolvedValue(mockLock),
      messageFlagsAdd: vi.fn().mockResolvedValue(undefined),
      fetch: vi.fn().mockReturnValue(yieldNonMatch()),
    };
    (svc as any).isConnected = true;
    (svc as any).client = client;
    vi.spyOn(svc, "getFolders").mockResolvedValue([
      makeFolder({ path: "INBOX", folderType: "system", specialUse: "\\Inbox" }),
    ]);

    // Non-matching uid → found=false → folder never set → throws "not found"
    await expect(svc.setFlag(emailId, "\\Answered")).rejects.toThrow("not found in any folder");
    // lock.release() must have been called (finally block in scan)
    expect(mockLock.release).toHaveBeenCalled();
  });
});

// ─── bulkMoveEmails: per-email fallback with no cache entry ───────────────────

describe("SimpleIMAPService.bulkMoveEmails per-email cache update", () => {
  it("skips cache eviction in per-email fallback when email not in cache", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    clientState(client).failNext.move = 1; // batch fails → per-email fallback
    seedUids(client, "INBOX", [198]);
    // Email "198" is NOT in cache → getEmailById is called to discover folder
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("198", "INBOX"));

    const results = await svc.bulkMoveEmails(["198"], "Archive");

    expect(results.success).toBe(1);
    // No crash — evictCacheEntry is a no-op when key is absent
  });
});

// ─── ensureConnection (private) ───────────────────────────────────────────────

describe("SimpleIMAPService private ensureConnection", () => {
  it("does nothing when already connected", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = { noop: vi.fn() };
    const reconnectSpy = vi.spyOn(svc as any, "reconnect").mockResolvedValue(undefined);

    await (svc as any).ensureConnection();

    expect(reconnectSpy).not.toHaveBeenCalled();
  });

  it("calls reconnect() when not connected", async () => {
    const svc = new SimpleIMAPService();
    // isConnected = false by default
    const reconnectSpy = vi.spyOn(svc as any, "reconnect").mockResolvedValue(undefined);

    await (svc as any).ensureConnection();

    expect(reconnectSpy).toHaveBeenCalledTimes(1);
  });
});

// ─── sourceFolder + UID validation (regressions for Bugs A/B/C from
//     2026-05-28 report) ──────────────────────────────────────────────────────
//
// Bug A: bulk_remove_label reported success when callers passed INBOX UIDs
//        for a Labels/ folder — the UIDs didn't exist there, IMAP UID DELETE
//        was a silent no-op, but the success counter was still bumped.
// Bug B: bulk_move_emails/move_email assumed cached/INBOX as the source folder,
//        so moves from custom folders silently no-op'd while reporting success.
// Bug C: bulk_mark_read had the same root cause for flag operations.
//
// The fix has two parts: (1) sourceFolder param skips cache lookup; (2) UID
// FETCH inside the folder lock counts honest success/failed.

describe("sourceFolder param: source-folder-specific UID resolution", () => {
  it("bulkMoveEmails(sourceFolder=Folders/X) locks Folders/X, not INBOX", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/BulkTestMove", [1]);
    // Seed a stale INBOX cache entry for the same UID — without sourceFolder
    // we'd lock INBOX (the bug). With sourceFolder we must lock the explicit one.
    (svc as any).setCacheEntry("1", makeEmail("1", "INBOX"));

    const results = await svc.bulkMoveEmails(["1"], "INBOX", "Folders/BulkTestMove");

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/BulkTestMove");
    expect(client.messageMove).toHaveBeenCalledWith("1", "INBOX", { uid: true });
  });

  it("moveEmail(sourceFolder=Folders/X) locks Folders/X without calling getEmailById", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/BulkTestMove", [1]);
    const gebSpy = vi.spyOn(svc, "getEmailById");

    const result = await svc.moveEmail("1", "Archive", "Folders/BulkTestMove");

    expect(result).toBe(true);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/BulkTestMove");
    expect(client.messageMove).toHaveBeenCalledWith("1", "Archive", { uid: true });
    expect(gebSpy).not.toHaveBeenCalled();
  });

  it("bulkMarkRead(sourceFolder=Folders/X) locks Folders/X, not INBOX", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/BulkTestMove", [1, 2]);

    const results = await svc.bulkMarkRead(["1", "2"], true, "Folders/BulkTestMove");

    expect(results.success).toBe(2);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/BulkTestMove");
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("1,2", ["\\Seen"], { uid: true });
  });

  it("bulkStar(sourceFolder=Folders/X) locks Folders/X, not INBOX", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/BulkTestMove", [7]);

    const results = await svc.bulkStar(["7"], true, "Folders/BulkTestMove");

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/BulkTestMove");
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("7", ["\\Flagged"], { uid: true });
  });

  it("bulkDeleteEmails(sourceFolder=Folders/X) locks Folders/X without scanning", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/BulkTestMove", [3, 4]);
    const gebSpy = vi.spyOn(svc, "getEmailById");

    const results = await svc.bulkDeleteEmails(["3", "4"], "Folders/BulkTestMove");

    expect(results.success).toBe(2);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/BulkTestMove");
    expect(gebSpy).not.toHaveBeenCalled();
  });
});

describe("UID existence pre-flight: missing UIDs count as failed, not silent success", () => {
  // Helper: a fetch mock that only yields UIDs in `existing`. Used to simulate
  // "UID not in this folder" — the IMAP server returns no message for that UID.
  function fetchYielding(existing: string[]) {
    return vi.fn().mockImplementation((range: unknown) => {
      const requested = String(range).split(",").map((s) => s.trim()).filter((s) => /^\d+$/.test(s));
      return (async function* () {
        for (const id of requested) if (existing.includes(id)) yield { uid: Number(id) };
      })();
    });
  }

  it("bulkDeleteFromFolder counts missing UIDs as failed (Bug A)", async () => {
    const svc = new SimpleIMAPService();
    // None of the requested UIDs exist in Labels/BulkTest
    connectSvc(svc, { fetch: fetchYielding([]) });

    const results = await svc.bulkDeleteFromFolder(["2954", "2955"], "Labels/BulkTest");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(2);
    // TEST-021: assert the error count matches `failed`, not just errors[0].
    expect(results.errors).toHaveLength(2);
    expect(results.errors.join(" ")).toMatch(/not found in folder Labels\/BulkTest/);
  });

  it("bulkMoveEmails counts missing UIDs as failed when sourceFolder doesn't contain them (Bug B)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, { fetch: fetchYielding([]) });

    const results = await svc.bulkMoveEmails(["1", "2"], "INBOX", "Folders/BulkTestMove");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(2);
    expect(results.errors).toHaveLength(2); // TEST-021
    // messageMove must NOT have been called — no UIDs to move
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("bulkMarkRead counts missing UIDs as failed (Bug C)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, { fetch: fetchYielding([]) });

    const results = await svc.bulkMarkRead(["1", "2"], true, "Folders/BulkTestMove");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(2);
    expect(results.errors).toHaveLength(2); // TEST-021
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it("bulkMoveEmails partial existence: present UIDs move, missing UIDs fail", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, { fetch: fetchYielding(["1", "3"]) });
    // The custom fetch override decides what the UID pre-flight returns; seed
    // the same UIDs into the honest messageMove guard so the real wire call
    // doesn't fail the mutation step.
    seedUids(client, "Folders/BulkTestMove", [1, 3]);

    const results = await svc.bulkMoveEmails(["1", "2", "3"], "Archive", "Folders/BulkTestMove");

    expect(results.success).toBe(2);
    expect(results.failed).toBe(1);
    expect(client.messageMove).toHaveBeenCalledWith("1,3", "Archive", { uid: true });
  });

  it("moveEmail throws when UID does not exist in sourceFolder", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc, { fetch: fetchYielding([]) });

    await expect(svc.moveEmail("999", "Archive", "Folders/BulkTestMove"))
      .rejects.toThrow(/999 not found in folder Folders\/BulkTestMove/);
  });

  it("markEmailRead throws when UID does not exist in sourceFolder", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc, { fetch: fetchYielding([]) });

    await expect(svc.markEmailRead("999", true, "Folders/BulkTestMove"))
      .rejects.toThrow(/999 not found in folder Folders\/BulkTestMove/);
  });
});

// ─── Batch 2 (v3.0.44): finish the v3.0.41 fix in sibling paths ──────────────

describe("v3.0.44 sibling-path fixes (IMAP-003 / IMAP-006 / IMAP-008 / IMAP-009)", () => {
  // IMAP-003: bulkMarkRead/bulkStar/bulkCopyToFolder used to default to INBOX
  // when sourceFolder absent and cache missed. Now discover folder via
  // getEmailById, then explicit failure if still not found.

  it("bulkMarkRead without sourceFolder discovers folder via getEmailById (not INBOX default)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/Work", [42]);
    // Cache MISS — must call getEmailById to discover
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("42", "Folders/Work"));

    const results = await svc.bulkMarkRead(["42"], true);

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/Work");
    expect(client.getMailboxLock).not.toHaveBeenCalledWith("INBOX");
  });

  it("bulkMarkRead reports failed when getEmailById returns null (instead of defaulting to INBOX)", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(null);

    const results = await svc.bulkMarkRead(["99"], true);

    expect(results.success).toBe(0);
    expect(results.failed).toBe(1);
    expect(results.errors[0]).toMatch(/Email 99 not found in any folder/);
  });

  it("bulkMarkRead surfaces discovery transport errors distinctly from ID-format errors", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);
    vi.spyOn(svc, "getEmailById").mockRejectedValue(new Error("IMAP FETCH failed"));

    const results = await svc.bulkMarkRead(["55"], true);

    expect(results.failed).toBe(1);
    // A valid-format ID that fails during discovery must NOT be mislabeled "Invalid email ID".
    expect(results.errors[0]).toMatch(/Failed to locate email 55/);
    expect(results.errors[0]).not.toMatch(/Invalid email ID/);
  });

  it("bulkStar without sourceFolder discovers folder via getEmailById", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Labels/Priority", [7]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("7", "Labels/Priority"));

    const results = await svc.bulkStar(["7"], true);

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Labels/Priority");
  });

  it("bulkCopyToFolder without sourceFolder discovers folder via getEmailById", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/X", [12]);
    vi.spyOn(svc, "getEmailById").mockResolvedValue(makeEmail("12", "Folders/X"));

    const results = await svc.bulkCopyToFolder(["12"], "Labels/Y");

    expect(results.success).toBe(1);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/X");
    expect(client.messageCopy).toHaveBeenCalledWith("12", "Labels/Y", { uid: true });
  });

  // IMAP-006: findExistingUidsInLockedFolder used to catch all errors and
  // return empty Set → all UIDs reported as "not found" (silent corruption
  // of success/failed counters). Now rethrows; bulk callers surface a
  // distinct "existence check failed" message.

  it("bulkMarkRead surfaces 'existence check failed' on transport error (IMAP-006)", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc, {
      fetch: vi.fn().mockImplementation(() => {
        // First call: pre-flight UID FETCH throws
        throw new Error("connection reset");
      }),
    });

    const results = await svc.bulkMarkRead(["1", "2"], true, "INBOX");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(2);
    for (const err of results.errors) {
      expect(err).toMatch(/existence check failed/);
      expect(err).toMatch(/connection reset/);
    }
  });

  it("bulkDeleteFromFolder surfaces 'existence check failed' on transport error", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc, {
      fetch: vi.fn().mockImplementation(() => { throw new Error("BAD command line too long"); }),
    });

    const results = await svc.bulkDeleteFromFolder(["10", "11"], "Labels/Foo");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(2);
    expect(results.errors[0]).toMatch(/existence check failed.*BAD command line too long/);
  });

  // IMAP-008: setFlag now does pre-flight UID FETCH inside the lock.

  it("setFlag throws when UID is not present in the resolved folder (IMAP-008)", async () => {
    const svc = new SimpleIMAPService();
    // Inline empty-fetch mock (fetchYielding from sister describe block isn't in scope here).
    connectSvc(svc, {
      fetch: vi.fn().mockImplementation(() => (async function* () { /* no UIDs */ })()),
    });

    await expect(svc.setFlag("999", "\\Answered", true, "Folders/Work"))
      .rejects.toThrow(/999 not found in folder Folders\/Work/);
  });

  // IMAP-009: setFlag now accepts sourceFolder, locking it directly.

  it("setFlag with sourceFolder locks the specified folder and skips the scan (IMAP-009)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "Folders/Priority", [5]);
    const getEmailByIdSpy = vi.spyOn(svc, "getEmailById");

    const result = await svc.setFlag("5", "\\Flagged", true, "Folders/Priority");

    expect(result).toBe(true);
    expect(client.getMailboxLock).toHaveBeenCalledWith("Folders/Priority");
    expect(getEmailByIdSpy).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).toHaveBeenCalledWith("5", ["\\Flagged"], { uid: true });
  });

  // VALID-001: getEmailById rejects CRLF/control-char folder hints.

  it("getEmailById rejects folderHint containing CRLF (VALID-001)", async () => {
    const svc = new SimpleIMAPService();
    connectSvc(svc);

    await expect(svc.getEmailById("1", "INBOX\r\nLOGOUT" as string))
      .rejects.toThrow();
  });
});

describe("v3.0.45 chunkUidsForWire (IMAP-002)", () => {
  it("returns empty array for empty input", () => {
    expect(chunkUidsForWire([])).toEqual([]);
  });

  it("returns single chunk when all UIDs fit", () => {
    expect(chunkUidsForWire(["1", "2", "3"])).toEqual(["1,2,3"]);
  });

  it("respects maxLen budget across chunk boundaries", () => {
    // "10" + "," + "20" + "," + "30" = 8 bytes
    const chunks = chunkUidsForWire(["10", "20", "30", "40"], 5);
    // First chunk: "10,20" = 5 bytes (fits exactly); next UID would push to 8.
    expect(chunks[0]).toBe("10,20");
    expect(chunks.join(",").split(",")).toEqual(["10", "20", "30", "40"]);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(5);
  });

  it("splits a 2000-UID workload into multiple sub-8KB chunks", () => {
    const uids = Array.from({ length: 2000 }, (_, i) => String(1_000_000 + i));
    const chunks = chunkUidsForWire(uids);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(7500);
    // No UID is lost or duplicated across chunks.
    const flat = chunks.flatMap((c) => c.split(","));
    expect(flat).toEqual(uids);
  });

  it("never emits an empty chunk even for a single oversized UID", () => {
    const chunks = chunkUidsForWire(["999999999"], 3);
    expect(chunks).toEqual(["999999999"]);
  });
});

describe("v3.0.45 runIdleLoop refuses TLS downgrade (IMAP-001)", () => {
  it("refuses to start IDLE when bridgeCertPath is unset and allowInsecureBridge is not set", async () => {
    const svc = new SimpleIMAPService();
    const prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
    delete process.env.MAILPOUCH_INSECURE_BRIDGE;

    (svc as any).connectionConfig = {
      host: 'localhost',
      port: 1143,
      username: 'u',
      password: 'p',
      // bridgeCertPath undefined; allowInsecureBridge undefined
    };
    (svc as any).idleActive = true;

    await (svc as any).runIdleLoop();

    expect((svc as any).idleActive).toBe(false);
    // idleClient should never have been instantiated
    expect((svc as any).idleClient).toBeFalsy();

    if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
  });

  it("refuses to start IDLE when cert load throws and allowInsecureBridge is not set", async () => {
    const svc = new SimpleIMAPService();
    const prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
    delete process.env.MAILPOUCH_INSECURE_BRIDGE;

    (svc as any).connectionConfig = {
      host: '127.0.0.1',
      port: 1143,
      bridgeCertPath: '/nonexistent/path/cert.pem',
      // allowInsecureBridge undefined
    };
    (svc as any).idleActive = true;

    await (svc as any).runIdleLoop();

    expect((svc as any).idleActive).toBe(false);
    expect((svc as any).idleClient).toBeFalsy();

    if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
  });
});

describe("v3.0.45 bulk methods chunk wire calls (IMAP-002)", () => {
  it("bulkDeleteEmails splits 2000 UIDs across multiple messageMove calls (delete = move to Trash)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const uids = Array.from({ length: 2000 }, (_, i) => String(1_000_000 + i));
    // Seed every UID into the locked folder so the honest fetch pre-flight
    // reports them as present (mirrors the old permissive-default behaviour
    // but only for this folder).
    seedUids(client, "INBOX", uids);
    await svc.bulkDeleteEmails(uids, "INBOX");

    // Delete now moves to Trash; the UID-set still chunks under the wire cap.
    const calls = (client.messageMove as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const [arg, target] of calls) {
      expect(String(arg).length).toBeLessThanOrEqual(7500);
      expect(target).toBe("Trash");
    }
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("bulkMoveEmails per-chunk failure falls back per-UID for that chunk only", async () => {
    const svc = new SimpleIMAPService();
    // 5 short UIDs fit comfortably under the 7500-byte default, so they land
    // in a single chunked call. We force that chunked call to fail and assert
    // the fallback runs per-UID for every UID in the failing chunk (5 calls)
    // plus the original chunked call = 6 total. Multi-chunk splitting itself
    // is covered by the 2000-UID `bulkDeleteEmails` test above and by the
    // `chunkUidsForWire` boundary tests.
    const uids = ["1", "2", "3", "4", "5"];
    const client = connectSvc(svc);
    clientState(client).failNext.move = 1; // chunked call fails → per-UID fallback for that chunk
    seedUids(client, "INBOX", uids);

    vi.spyOn(svc, "getEmailById").mockImplementation(async (id) => makeEmail(id, "INBOX"));

    const results = await svc.bulkMoveEmails(uids, "Archive", "INBOX");

    expect(results.success).toBe(5);
    expect(results.failed).toBe(0);
    // First call was the chunked one that failed; subsequent calls are per-UID.
    expect(client.messageMove).toHaveBeenCalledTimes(1 + uids.length);
  });
});

// ─── v3.0.52 IMAP service hardening regressions ──────────────────────────────

// IMAP-004: header search field/value must be sanitised like every other
// SEARCH input — a raw '"' in the value or a malformed field name lets a caller
// craft arbitrary IMAP SEARCH terms (defence-in-depth through `search_emails`).
describe("SimpleIMAPService.searchSingleFolder header sanitisation (IMAP-004)", () => {
  function searchSvc(searchSpy: ReturnType<typeof vi.fn>): SimpleIMAPService {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      getMailboxLock: vi.fn().mockResolvedValue(makeLock()),
      // Returning [] short-circuits the rest of the method after criteria build.
      search: searchSpy,
    };
    return svc;
  }

  it("strips quote/backslash from the header value before passing to search", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const svc = searchSvc(search);

    await (svc as any).searchSingleFolder("INBOX", {
      header: { field: "X-Test", value: '"\r\nLOGOUT' },
    }, 50);

    expect(search).toHaveBeenCalledTimes(1);
    const criteria = search.mock.calls[0][0];
    // The injected quote (and backslash) are gone; the wire string can no
    // longer close imapflow's quoted argument early.
    expect(criteria.header["X-Test"]).not.toContain('"');
    expect(criteria.header["X-Test"]).not.toContain("\\");
  });

  it("rejects a header field name that is not RFC 5322 field-name grammar", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const svc = searchSvc(search);

    await expect(
      (svc as any).searchSingleFolder("INBOX", {
        header: { field: 'X-Test"\r\nA0001 LOGOUT', value: "x" },
      }, 50),
    ).rejects.toThrow(/Invalid header field name/);
    expect(search).not.toHaveBeenCalled();
  });

  it("accepts a well-formed header field name", async () => {
    const search = vi.fn().mockResolvedValue([]);
    const svc = searchSvc(search);

    await (svc as any).searchSingleFolder("INBOX", {
      header: { field: "List-Unsubscribe", value: "anything" },
    }, 50);

    expect(search).toHaveBeenCalledTimes(1);
    expect(search.mock.calls[0][0].header["List-Unsubscribe"]).toBe("anything");
  });
});

// IMAP-005: the IDLE EXISTS/EXPUNGE handlers evict INBOX cache entries by
// snapshotting keys first and matching the folder case-insensitively, so an
// entry cached under an aliased path (`Inbox`) is still invalidated.
describe("SimpleIMAPService.evictInboxCacheEntries (IMAP-005)", () => {
  it("evicts INBOX entries regardless of folder-name case", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("1", makeEmail("1", "INBOX"));
    (svc as any).setCacheEntry("2", makeEmail("2", "Inbox"));
    (svc as any).setCacheEntry("3", makeEmail("3", "Sent"));
    expect((svc as any).emailCache.size).toBe(3);

    (svc as any).evictInboxCacheEntries();

    // Both INBOX and Inbox evicted; Sent untouched.
    expect((svc as any).emailCache.has("INBOX:1")).toBe(false);
    expect((svc as any).emailCache.has("Inbox:2")).toBe(false);
    expect((svc as any).emailCache.has("Sent:3")).toBe(true);
  });
});

// IMAP-007: mailparser's `to`/`cc` can be a single AddressObject OR an array of
// them (multiple To: header lines). The old singular-only shape collapsed the
// array case to [], silently dropping recipients.
describe("normalizeAddressList (IMAP-007)", () => {
  it("returns [] for undefined", () => {
    expect(normalizeAddressList(undefined)).toEqual([]);
  });

  it("handles the singular AddressObject shape", () => {
    expect(normalizeAddressList({ text: "a@x.com", value: [] } as any)).toEqual(["a@x.com"]);
  });

  it("flattens an array of AddressObjects (multiple To: header lines)", () => {
    const result = normalizeAddressList([
      { text: "a@x.com", value: [] },
      { text: "b@y.com", value: [] },
    ] as any);
    expect(result).toEqual(["a@x.com", "b@y.com"]);
  });
});

// IMAP-010: checkAndUpdateUidValidity must not silently swallow errors — a
// thrown comparison is exactly when stale cache is most dangerous, so it logs
// at warn AND conservatively clears the cache.
describe("SimpleIMAPService.checkAndUpdateUidValidity error path (IMAP-010)", () => {
  it("clears the cache when reading the mailbox throws", () => {
    const svc = new SimpleIMAPService();
    (svc as any).setCacheEntry("1", makeEmail("1", "INBOX"));
    expect((svc as any).emailCache.size).toBe(1);
    // mailbox getter throws when accessed.
    Object.defineProperty((svc as any).client = {}, "mailbox", {
      get() { throw new Error("reconnect race"); },
    });

    expect(() => (svc as any).checkAndUpdateUidValidity("INBOX")).not.toThrow();
    expect((svc as any).emailCache.size).toBe(0);
  });
});

// IMAP-014: protected-folder checks must trim+casefold AND consult specialUse,
// not just compare against literal English names.
describe("SimpleIMAPService protected folders (IMAP-014)", () => {
  function svcWithFolders(folders: Array<{ path: string; specialUse?: string }>): SimpleIMAPService {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      mailboxDelete: vi.fn().mockResolvedValue(undefined),
      mailboxRename: vi.fn().mockResolvedValue(undefined),
    };
    vi.spyOn(svc, "getFolders").mockResolvedValue(folders as any);
    vi.spyOn(svc as any, "validateFolderName").mockImplementation(() => {});
    return svc;
  }

  it("rejects deletion of INBOX with trailing whitespace", async () => {
    const svc = svcWithFolders([{ path: "INBOX", specialUse: "\\Inbox" }]);
    await expect(svc.deleteFolder("INBOX  ")).rejects.toThrow(/protected/);
  });

  it("rejects deletion of a localised special-use mailbox", async () => {
    const svc = svcWithFolders([{ path: "Papelera", specialUse: "\\Trash" }]);
    await expect(svc.deleteFolder("Papelera")).rejects.toThrow(/protected/);
  });

  it("rejects renaming a localised special-use mailbox", async () => {
    const svc = svcWithFolders([{ path: "Papelera", specialUse: "\\Trash" }]);
    await expect(svc.renameFolder("Papelera", "Garbage")).rejects.toThrow(/protected/);
  });

  it("allows deletion of an ordinary user folder", async () => {
    const svc = svcWithFolders([{ path: "Projects" }]);
    await expect(svc.deleteFolder("Projects")).resolves.toBe(true);
  });
});

// IMAP-011: expandImapSequence must reject NaN/`*`/inverted ranges and cap the
// produced count instead of OOMing on a hostile `1:1000000000`.
describe("expandImapSequence (IMAP-011)", () => {
  it("expands a simple range and comma list", () => {
    expect(expandImapSequence("1:3")).toEqual([1, 2, 3]);
    expect(expandImapSequence("1,3,5")).toEqual([1, 3, 5]);
    expect(expandImapSequence("7")).toEqual([7]);
  });

  it("rejects the unbounded `*` form instead of silently returning [1]", () => {
    expect(() => expandImapSequence("1:*")).toThrow();
  });

  it("rejects non-numeric input instead of returning [NaN]", () => {
    expect(() => expandImapSequence("a:b")).toThrow();
  });

  it("rejects an inverted range", () => {
    expect(() => expandImapSequence("5:1")).toThrow();
  });

  it("caps an enormous range instead of allocating a billion elements", () => {
    expect(() => expandImapSequence("1:1000000000")).toThrow(/too large/i);
  });

  it("rejects a part with more than one colon (malformed sequence grammar)", () => {
    // "1:2:3" must be rejected, not silently truncated to "1:2".
    expect(() => expandImapSequence("1:2:3")).toThrow(/Invalid IMAP sequence part/);
    expect(() => expandImapSequence("5,1:2:3")).toThrow(/Invalid IMAP sequence part/);
  });
});

// IMAP-015: UID validation must reject structurally-impossible UIDs (non-32-bit,
// leading zero, arbitrary-length decimals) — not just `\d+`.
describe("validateEmailId (IMAP-015)", () => {
  function validate(id: string): void {
    (new SimpleIMAPService() as any).validateEmailId(id);
  }

  it("accepts an ordinary UID", () => {
    expect(() => validate("12345")).not.toThrow();
  });

  it("accepts the max 32-bit UID", () => {
    expect(() => validate("4294967295")).not.toThrow();
  });

  it("rejects a 50-digit pseudo-UID", () => {
    expect(() => validate("1".repeat(50))).toThrow(/Invalid email ID/);
  });

  it("rejects a value above the 32-bit ceiling", () => {
    expect(() => validate("4294967296")).toThrow(/Invalid email ID/);
  });

  it("rejects a leading-zero UID", () => {
    expect(() => validate("0123")).toThrow(/Invalid email ID/);
  });
});

// IMAP-019: a rejected logout() must still null the client + clear isConnected
// so the next ensureConnection() doesn't trust a dead socket.
describe("disconnect error path (IMAP-019)", () => {
  it("forces local teardown even when logout() rejects", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = true;
    (svc as any).client = {
      logout: vi.fn().mockRejectedValue(new Error("socket closed")),
    };

    await svc.disconnect();

    expect((svc as any).client).toBeNull();
    expect((svc as any).isConnected).toBe(false);
    expect(svc.isActive()).toBe(false);
  });
});

// PARSE-014: downloadAttachment rejects oversize attachments up front instead
// of re-fetching + base64-encoding the whole thing in memory.
describe("SimpleIMAPService.downloadAttachment size guard (PARSE-014)", () => {
  it("throws before fetching when the attachment exceeds the size cap", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    const fetchFullSource = vi.spyOn(svc as any, "fetchEmailFullSource");
    const big = makeEmail("1", "INBOX");
    (big as any).attachments = [{
      filename: "huge.pdf",
      contentType: "application/pdf",
      size: 50 * 1024 * 1024, // 50 MB — over the 25 MB cap
    }];
    vi.spyOn(svc as any, "findCacheEntryByUid").mockReturnValue(big);

    await expect(svc.downloadAttachment("1", 0)).rejects.toThrow(/too large/i);
    // Must short-circuit before the full-source re-fetch.
    expect(fetchFullSource).not.toHaveBeenCalled();
  });

  it("allows an attachment within the size cap", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "validateEmailId").mockImplementation(() => {});
    const small = makeEmail("2", "INBOX");
    (small as any).attachments = [{
      filename: "ok.pdf",
      contentType: "application/pdf",
      size: 1024,
      content: Buffer.from("hello"),
    }];
    vi.spyOn(svc as any, "findCacheEntryByUid").mockReturnValue(small);

    const result = await svc.downloadAttachment("2", 0);
    expect(result?.filename).toBe("ok.pdf");
    expect(result?.content).toBe(Buffer.from("hello").toString("base64"));
  });
});

// ─── v3.0.65: honest counts — copy/move success means VERIFIED IN TARGET ──────
// Bug A regression. Source = a non-INBOX union mailbox ("All Mail"). Before the
// fix, success was counted when messageCopy/messageMove merely RESOLVED, so a
// Bridge no-op from All Mail reported {success:N} while nothing landed.
describe("SimpleIMAPService move/copy honest verification (Bug A, All Mail source)", () => {
  it("bulkCopyToFolder reports FAILURE when the copy resolves but nothing lands in the target", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    clientState(client).silentNoOp.copy = true; // Bridge accepts COPY from All Mail but does nothing
    seedUids(client, "All Mail", [1, 2, 3, 4]);

    const results = await svc.bulkCopyToFolder(["1", "2", "3", "4"], "Labels/Receipts", "All Mail");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(4);
    expect(results.errors.join(" ")).toMatch(/not present|All Mail|union/i);
    // Copy-failure messages now carry the SOURCE folder (parity with bulkMove)
    // so a multi-source failure is debuggable.
    expect(results.errors.join(" ")).toMatch(/from All Mail/);
  });

  it("bulkCopyToFolder counts success only after verifying the message landed (real copy)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "All Mail", [1, 2]);

    const results = await svc.bulkCopyToFolder(["1", "2"], "Labels/Receipts", "All Mail");

    expect(results.success).toBe(2);
    expect(results.failed).toBe(0);
  });

  it("verifies copies of messages that have NO Message-ID via the UIDPLUS COPYUID map (no false success, no false failure)", async () => {
    // ENVELOPE can return NIL for Message-ID. Verification must not assume
    // success for un-identifiable messages (the Copilot-flagged hole) — but a
    // genuinely-landed copy must still succeed, proven by the COPYUID uidMap.
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUidsNoMid(client, "All Mail", [1, 2]);
    const ok = await svc.bulkCopyToFolder(["1", "2"], "Labels/Receipts", "All Mail");
    expect(ok.success).toBe(2); // uidMap confirms landing without a Message-ID
    expect(ok.failed).toBe(0);

    // And a no-Message-ID message whose copy no-ops (empty uidMap) is a failure,
    // never an assumed success.
    const svcB = new SimpleIMAPService();
    const clientB = connectSvc(svcB);
    clientState(clientB).silentNoOp.copy = true;
    seedUidsNoMid(clientB, "All Mail", [5, 6]);
    const bad = await svcB.bulkCopyToFolder(["5", "6"], "Labels/Receipts", "All Mail");
    expect(bad.success).toBe(0);
    expect(bad.failed).toBe(2);
  });

  it("bulkMoveEmails from All Mail reports FAILURE when the COPY-file resolves but nothing lands", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    // From the All Mail union, bulkMoveEmails files via COPY (MOVE no-ops there).
    // A copy the union accepts but doesn't perform must be an honest failure,
    // never a false success.
    clientState(client).silentNoOp.copy = true;
    seedUids(client, "All Mail", [10, 11, 12]);

    const results = await svc.bulkMoveEmails(["10", "11", "12"], "Folders/Work", "All Mail");

    expect(results.success).toBe(0);
    expect(results.failed).toBe(3);
    expect(results.errors.join(" ")).toMatch(/not present|All Mail|union/i);
  });

  it("bulkMoveEmails from All Mail files via COPY and verifies landing (success)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedUids(client, "All Mail", [10, 11, 12]);

    const results = await svc.bulkMoveEmails(["10", "11", "12"], "Folders/Work", "All Mail");

    expect(results.success).toBe(3);
    expect(results.failed).toBe(0);
    expect(client.messageCopy).toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalled();
  });
});

// ─── searchEmails freshness — live IMAP SEARCH, not a cache scan ──────────────
// Cluster 7 / Observation O1 (consolidated report 2026-05-31, shipped v3.0.71):
//   `search_emails({folder:"INBOX", subject:"…"})` returned count:0 for a
//   message verifiably in INBOX (e.g. a just-sent self-mail). The hypothesis was
//   that search scanned a stale in-memory cache instead of issuing a live IMAP
//   SEARCH, so mail that arrived after the last cache fill was invisible.
//
// These tests pin the live-search guarantee: a message seeded ONLY on the
// (mock) server — never inserted into the production email cache — must still be
// returned by searchEmails. If a future refactor reintroduced a cache-only scan,
// `getCacheEntry` would miss the freshly-seeded UID and the assertion below would
// fail, catching the regression.
describe("SimpleIMAPService.searchEmails freshness (cluster 7 / O1, v3.0.71)", () => {
  it("finds a freshly-arrived INBOX message that was never in the cache", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);

    // Message exists on the server only — no prior getEmails/cache fill.
    seedMessage(client, "INBOX", 4242, { subject: "Hello from a fresh self-mail" });
    // Prove the cache really is cold for this UID.
    expect((svc as any).getCacheEntry("4242", "INBOX")).toBeUndefined();

    const results = await svc.searchEmails({ folder: "INBOX", subject: "fresh self-mail" });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("4242");
    expect(results[0].subject).toBe("Hello from a fresh self-mail");
    expect(results[0].folder).toBe("INBOX");
    // The live SEARCH was issued against the locked folder with the subject filter.
    expect(client.search).toHaveBeenCalled();
    const searchCriteria = (client.search as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(searchCriteria.subject).toBe("fresh self-mail");
  });

  it("populates the cache from the live fetch so a re-search hits the cache", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedMessage(client, "INBOX", 4243, { subject: "Indexed after first fetch" });

    await svc.searchEmails({ folder: "INBOX", subject: "Indexed after first" });
    // First search materialised the message into the cache for cheap re-serve.
    expect((svc as any).getCacheEntry("4243", "INBOX")?.subject).toBe("Indexed after first fetch");

    const again = await svc.searchEmails({ folder: "INBOX", subject: "Indexed after first" });
    expect(again).toHaveLength(1);
    expect(again[0].id).toBe("4243");
  });

  it("returns empty when no seeded message matches the live SEARCH", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    seedMessage(client, "INBOX", 4244, { subject: "Quarterly report" });

    const results = await svc.searchEmails({ folder: "INBOX", subject: "no such subject" });
    expect(results).toHaveLength(0);
  });
});

// ─── getEmailById folder resolution (#1: All Mail union must not mask the real folder) ───
describe("SimpleIMAPService.getEmailById — All Mail must not mask the real folder", () => {
  const folderList = [
    { path: "All Mail", name: "All Mail", delimiter: "/", flags: new Set(), specialUse: "\\All" },
    { path: "Folders/Tech", name: "Tech", delimiter: "/", flags: new Set(), specialUse: undefined },
  ];

  it("returns the real folder (not 'All Mail') when the message exists in both", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, {
      list: vi.fn().mockResolvedValue(folderList),
      status: vi.fn().mockResolvedValue({ messages: 1, unseen: 0 }),
    });
    // Same UID present in the union AND the real folder — All Mail scanned last.
    seedMessage(client, "All Mail", 900, { subject: "filed message" });
    seedMessage(client, "Folders/Tech", 900, { subject: "filed message" });
    const email = await svc.getEmailById("900");
    expect(email?.folder).toBe("Folders/Tech");
  });

  it("falls back to 'All Mail' for a message that exists ONLY there (true archive)", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, {
      list: vi.fn().mockResolvedValue(folderList),
      status: vi.fn().mockResolvedValue({ messages: 1, unseen: 0 }),
    });
    seedMessage(client, "All Mail", 901, { subject: "archived message" });
    const email = await svc.getEmailById("901");
    expect(email?.folder).toBe("All Mail");
  });
});

// ─── #2: folder-count cache must invalidate on mutation ───
describe("SimpleIMAPService folder-count cache invalidation (#2)", () => {
  function svcWithFolders() {
    const svc = new SimpleIMAPService();
    const list = vi.fn().mockResolvedValue([
      { path: "INBOX", name: "INBOX", delimiter: "/", flags: new Set(), specialUse: undefined },
    ]);
    const status = vi.fn().mockResolvedValue({ messages: 5, unseen: 1 });
    const client = connectSvc(svc, { list, status });
    return { svc, client, status };
  }

  it("get_folders caches, but a move invalidates the cache so counts refetch", async () => {
    const { svc, client, status } = svcWithFolders();
    await svc.getFolders();
    const afterFirst = status.mock.calls.length;
    await svc.getFolders();
    expect(status.mock.calls.length).toBe(afterFirst); // 2nd call served from cache — no STATUS
    seedUids(client, "INBOX", [1]);
    await svc.moveEmail("1", "Folders/X", "INBOX");      // mutation → clearFolderCache()
    await svc.getFolders();
    expect(status.mock.calls.length).toBeGreaterThan(afterFirst); // refetched after the move
  });

  it("syncFolders always bypasses the cache (explicit refresh)", async () => {
    const { svc, status } = svcWithFolders();
    await svc.getFolders();
    const n = status.mock.calls.length;
    await svc.syncFolders();
    expect(status.mock.calls.length).toBeGreaterThan(n);
  });

  it("starEmail invalidates the folder cache (Starred \\Flagged count changes)", async () => {
    const { svc, client, status } = svcWithFolders();
    await svc.getFolders();
    const afterFirst = status.mock.calls.length;
    seedUids(client, "INBOX", [1]);
    await svc.starEmail("1", true, "INBOX");
    await svc.getFolders();
    expect(status.mock.calls.length).toBeGreaterThan(afterFirst); // refetched after the star
  });

  it("bulkStar invalidates the folder cache on success (parity with bulkMarkRead)", async () => {
    const { svc, client, status } = svcWithFolders();
    await svc.getFolders();
    const afterFirst = status.mock.calls.length;
    seedUids(client, "INBOX", [1, 2]);
    await svc.bulkStar(["1", "2"], true, "INBOX");
    await svc.getFolders();
    expect(status.mock.calls.length).toBeGreaterThan(afterFirst);
  });
});

// ─── empty_trash: gated permanent purge, Trash-only ───────────────────────────

describe("SimpleIMAPService.emptyTrash (Phase 3 — gated permanent delete)", () => {
  function trashClient(uids: number[], over: Record<string, unknown> = {}) {
    let locked: string | null = null;
    return {
      get mailbox() { return { exists: uids.length }; },
      getMailboxLock: vi.fn().mockImplementation(async (f: string) => {
        locked = f;
        return { release: () => { locked = null; } };
      }),
      search: vi.fn().mockResolvedValue(uids),
      messageDelete: vi.fn().mockResolvedValue(undefined),
      get _locked() { return locked; },
      ...over,
    };
  }

  it("EXPUNGEs every message in the resolved Trash mailbox and only Trash", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "resolveTrashPath").mockResolvedValue("Papelera"); // localised Trash
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    const client = trashClient([11, 12, 13]);
    (svc as any).isConnected = true;
    (svc as any).client = client;

    const result = await svc.emptyTrash();

    expect(result.deleted).toBe(3);
    // Locked the resolved (localised) Trash, not a literal "Trash"/INBOX.
    expect(client.getMailboxLock).toHaveBeenCalledWith("Papelera");
    expect(client.getMailboxLock).not.toHaveBeenCalledWith("INBOX");
    expect(client.messageDelete).toHaveBeenCalledWith("11,12,13", { uid: true });
  });

  it("short-circuits an already-empty Trash without FETCH/SEARCH (empty-mailbox quirk)", async () => {
    const svc = new SimpleIMAPService();
    vi.spyOn(svc as any, "resolveTrashPath").mockResolvedValue("Trash");
    vi.spyOn(svc as any, "checkAndUpdateUidValidity").mockImplementation(() => {});
    const client = trashClient([]);
    (svc as any).isConnected = true;
    (svc as any).client = client;

    const result = await svc.emptyTrash();

    expect(result.deleted).toBe(0);
    expect(client.search).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
  });

  it("throws when not connected (never silently no-ops a destructive op)", async () => {
    const svc = new SimpleIMAPService();
    (svc as any).isConnected = false;
    (svc as any).client = null;
    await expect(svc.emptyTrash()).rejects.toThrow(/not connected/i);
  });
});

// ─── Live Bridge E2E child-side UIDVALIDITY fence ───────────────────────────

describe("SimpleIMAPService live Bridge E2E mailbox identity fence", () => {
  const token = "mpE2E-00000000-0000-4000-8000-000000000002";
  const source = `Folders/${token}-source`;
  const target = `Folders/${token}-target`;

  function enableLiveFence(): void {
    vi.stubEnv("MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS", "1");
    vi.stubEnv("MAILPOUCH_E2E_RUN_TOKEN", token);
  }

  function proof(uidValidity: string, uids: string[]): Record<string, unknown> {
    return {
      [E2E_MAILBOX_IDENTITY_ARG]: { token, folder: source, uidValidity, uids },
    };
  }

  function bindSelectedIdentity(
    client: Record<string, unknown>,
    initialUidValidity: bigint,
  ): (next: bigint) => void {
    let uidValidity = initialUidValidity;
    const originalLock = client.getMailboxLock as (folder: string) => Promise<{ release(): void }>;
    client.getMailboxLock = vi.fn(async (folder: string) => {
      const lock = await originalLock(folder);
      client.mailbox = { path: folder, uidValidity };
      return {
        release: () => {
          lock.release();
          client.mailbox = false;
        },
      };
    });
    return (next: bigint) => {
      uidValidity = next;
      if (client.mailbox && typeof client.mailbox === "object") {
        (client.mailbox as { uidValidity: bigint }).uidValidity = next;
      }
    };
  }

  async function runLive<T>(
    args: Record<string, unknown>,
    operation: () => Promise<T>,
  ): Promise<T> {
    enableLiveFence();
    return await withE2EMailboxIdentity(args, operation);
  }

  it("permits a wire mutation only when the child selects the proven mailbox identity", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42]);

    await expect(runLive(proof("17", ["42"]), () => svc.moveEmail("42", target, source)))
      .resolves.toBe(true);
    expect(client.messageMove).toHaveBeenCalledWith("42", target, { uid: true });
  });

  it.each([
    ["move", "messageMove", (svc: SimpleIMAPService) => svc.moveEmail("42", target, source)],
    ["delete", "messageDelete", (svc: SimpleIMAPService) => svc.deleteFromFolder("42", source)],
  ])("refuses %s before any destructive wire command when UIDPLUS is absent", async (_name, wire, operation) => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, { capabilities: new Map() });
    bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42]);

    await expect(runLive(proof("17", ["42"]), () => operation(svc)))
      .rejects.toThrow(/UIDPLUS/i);
    expect(client[wire] as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it.each([
    ["bulk move", "messageMove", (svc: SimpleIMAPService) => svc.bulkMoveEmails(["42"], target, source)],
    ["bulk delete", "messageDelete", (svc: SimpleIMAPService) => svc.bulkDeleteFromFolder(["42"], source)],
  ])("refuses %s without UIDPLUS and never enters a fallback wire path", async (_name, wire, operation) => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc, { capabilities: new Map() });
    bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42]);

    await expect(runLive(proof("17", ["42"]), () => operation(svc)))
      .rejects.toThrow(/UIDPLUS/i);
    expect(client[wire] as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it.each([
    ["flags", "messageFlagsAdd", (svc: SimpleIMAPService) => svc.markEmailRead("42", true, source)],
    ["move", "messageMove", (svc: SimpleIMAPService) => svc.moveEmail("42", target, source)],
    ["copy", "messageCopy", (svc: SimpleIMAPService) => svc.copyEmailToFolder("42", target, source)],
    ["delete", "messageDelete", (svc: SimpleIMAPService) => svc.deleteFromFolder("42", source)],
  ])("refuses %s before its wire command when UIDVALIDITY changed", async (_name, wire, operation) => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    bindSelectedIdentity(client, 18n);
    seedUids(client, source, [42]);

    await expect(runLive(proof("17", ["42"]), () => operation(svc)))
      .rejects.toThrow(/mailbox identity changed/i);
    expect(client[wire] as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
  });

  it("rechecks after UID preflight and refuses a last-moment identity change", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const setIdentity = bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42]);
    const originalFetch = client.fetch as (...args: unknown[]) => AsyncIterable<Record<string, unknown>>;
    let fetchCall = 0;
    client.fetch = vi.fn((...args: unknown[]) => {
      const call = ++fetchCall;
      const iterable = originalFetch(...args);
      return (async function* () {
        for await (const item of iterable) yield item;
        if (call === 2) setIdentity(18n);
      })();
    });

    await expect(runLive(proof("17", ["42"]), () => svc.moveEmail("42", target, source)))
      .rejects.toThrow(/mailbox identity changed/i);
    expect(client.messageMove).not.toHaveBeenCalled();
  });

  it("rechecks before every bulk fallback and never retries after identity drift", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const setIdentity = bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42, 43]);
    client.messageMove = vi.fn(async () => {
      setIdentity(18n);
      throw new Error("simulated batch failure after mailbox recreation");
    });

    const result = await runLive(
      proof("17", ["42", "43"]),
      () => svc.bulkMoveEmails(["42", "43"], target, source),
    );

    expect(result).toMatchObject({ success: 0, failed: 2 });
    expect(client.messageMove).toHaveBeenCalledTimes(1);
    expect(result.errors.every((message) => /mailbox identity changed/i.test(message))).toBe(true);
  });

  it("stops bulk flag fallback retries when the mailbox identity drifts after the failed batch", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const setIdentity = bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42, 43]);
    client.messageFlagsAdd = vi.fn(async () => {
      setIdentity(18n);
      throw new Error("simulated batch failure after mailbox recreation");
    });

    const result = await runLive(
      proof("17", ["42", "43"]),
      () => svc.bulkMarkRead(["42", "43"], true, source),
    );

    expect(result).toMatchObject({ success: 0, failed: 2 });
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
    expect(result.errors.every((message) => /mailbox identity changed/i.test(message))).toBe(true);
  });

  it("stops bulk copy fallback retries when the mailbox identity drifts after the failed batch", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const setIdentity = bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42, 43]);
    client.messageCopy = vi.fn(async () => {
      setIdentity(18n);
      throw new Error("simulated batch failure after mailbox recreation");
    });

    const result = await runLive(
      proof("17", ["42", "43"]),
      () => svc.bulkCopyToFolder(["42", "43"], target, source),
    );

    expect(result).toMatchObject({ success: 0, failed: 2 });
    expect(client.messageCopy).toHaveBeenCalledTimes(1);
    expect(result.errors.every((message) => /mailbox identity changed/i.test(message))).toBe(true);
  });

  it("suppresses the trailing bulk-delete EXPUNGE when UIDVALIDITY drifts between fallback retries", async () => {
    const svc = new SimpleIMAPService();
    const client = connectSvc(svc);
    const setIdentity = bindSelectedIdentity(client, 17n);
    seedUids(client, source, [42, 43]);
    const originalFlagsAdd = client.messageFlagsAdd as (...args: unknown[]) => Promise<unknown>;
    client.messageDelete = vi.fn().mockRejectedValue(new Error("simulated batch delete failure"));
    client.messageFlagsAdd = vi.fn(async (...args: unknown[]) => {
      await originalFlagsAdd(...args);
      setIdentity(18n);
    });

    await expect(runLive(
      proof("17", ["42", "43"]),
      () => svc.bulkDeleteFromFolder(["42", "43"], source),
    )).rejects.toThrow(/mailbox identity changed/i);

    // One failed fast-path DELETE only. The final UID EXPUNGE is never sent
    // after the first fallback STORE observes a different mailbox identity.
    expect(client.messageDelete).toHaveBeenCalledTimes(1);
    expect(client.messageFlagsAdd).toHaveBeenCalledTimes(1);
  });
});
