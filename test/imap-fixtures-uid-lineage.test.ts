import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_MUTATION_COMMAND_MS } from "./e2e/support/time-budgets.mjs";

type MockSearchQuery = {
  all?: boolean;
  header?: Record<string, string>;
  subject?: string;
  or?: MockSearchQuery[];
};

const mockState = vi.hoisted(() => ({
  mailboxes: new Map<string, {
    uidValidity: bigint;
    messages: Array<{
      uid: number;
      ownershipToken?: string;
      messageId?: string;
      omitMessageId?: boolean;
      subject?: string;
      source?: string;
      flags?: string[];
    }>;
  }>(),
  moveUidMap: new Map<number, number>(),
  moveReportedUidValidity: 0n,
  copyUidMap: new Map<number, number>(),
  copyReportedUidValidity: 0n,
  copyForeignUid: undefined as number | undefined,
  copyThrowsAfterMutation: false,
  createdMailboxUidValidity: 1n,
  moveCalls: [] as Array<{ source: string; target: string; uids: number[] }>,
  copyCalls: [] as Array<{ source: string; target: string; uids: number[] }>,
  deleteCalls: [] as Array<{ folder: string; uids: number[] }>,
  searchCalls: [] as Array<{ folder: string; query: MockSearchQuery }>,
  hiddenOwnershipSearchFolders: new Set<string>(),
  deferredFetchFolders: new Set<string>(),
  fetchResolvers: new Map<string, () => void>(),
  specialUse: new Map<string, string>(),
  moveNeverSettlesAfterMutation: false,
  moveReturnsFalseAfterMutation: false,
  closeCalls: 0,
  logoutCalls: 0,
  connectCalls: 0,
  nextClientId: 0,
  mutationClientIds: [] as number[],
  lockCalls: [] as string[],
  fetchCalls: [] as Array<{ folder: string; uids: number[] }>,
}));

function requestedUids(sequence: unknown): number[] {
  if (Array.isArray(sequence)) return sequence.filter((uid): uid is number => typeof uid === "number");
  if (typeof sequence === "number") return [sequence];
  if (typeof sequence !== "string") return [];
  return sequence
    .split(",")
    .map((uid) => Number(uid))
    .filter((uid) => Number.isSafeInteger(uid) && uid > 0);
}

vi.mock("imapflow", () => ({
  ImapFlow: class MockImapFlow {
    private readonly clientId = ++mockState.nextClientId;
    mailbox: false | { path: string; exists: number; uidValidity: bigint } = false;
    isClosed = false;
    private selected = "";

    connect = vi.fn(async () => { mockState.connectCalls += 1; });
    logout = vi.fn(async () => { mockState.logoutCalls += 1; });
    close = vi.fn(() => { mockState.closeCalls += 1; });

    list = vi.fn(async () => [...mockState.mailboxes].map(([path]) => ({
      path,
      flags: new Set<string>(),
      ...(mockState.specialUse.has(path)
        ? { specialUse: mockState.specialUse.get(path) }
        : path === "Trash" ? { specialUse: "\\Trash" } : {}),
    })));

    mailboxCreate = vi.fn(async (path: string) => {
      if (mockState.mailboxes.has(path)) return { path, created: false };
      mockState.mailboxes.set(path, { uidValidity: mockState.createdMailboxUidValidity, messages: [] });
      return { path, created: true };
    });

    mailboxDelete = vi.fn(async (path: string) => {
      if (!mockState.mailboxes.has(path)) throw new Error(`Unknown mailbox: ${path}`);
      mockState.mailboxes.delete(path);
      return true;
    });

    getMailboxLock = vi.fn(async (path: string) => {
      mockState.lockCalls.push(path);
      const mailbox = mockState.mailboxes.get(path);
      if (!mailbox) throw new Error(`Unknown mailbox: ${path}`);
      this.selected = path;
      this.mailbox = {
        path,
        exists: mailbox.messages.length,
        uidValidity: mailbox.uidValidity,
      };
      return { release: vi.fn() };
    });

    search = vi.fn(async (query: MockSearchQuery) => {
      const mailbox = mockState.mailboxes.get(this.selected);
      if (!mailbox) return [];
      mockState.searchCalls.push({ folder: this.selected, query });
      const evaluate = (term: MockSearchQuery): number[] => {
        if (term.or) return [...new Set(term.or.flatMap(evaluate))];
        if (term.all) return mailbox.messages.map(({ uid }) => uid);

        const ownership = Object.entries(term.header ?? {})
          .find(([name]) => name.toLowerCase() === "x-mailpouch-e2e-run");
        if (ownership) {
          if (mockState.hiddenOwnershipSearchFolders.has(this.selected)) return [];
          return mailbox.messages
            .filter(({ ownershipToken }) => ownershipToken === ownership[1])
            .map(({ uid }) => uid);
        }
        const messageId = Object.entries(term.header ?? {})
          .find(([name]) => name.toLowerCase() === "message-id")?.[1];
        if (messageId) {
          return mailbox.messages
            .filter((message) => (message.messageId ?? `uid-${message.uid}@e2e.test`) === messageId)
            .map(({ uid }) => uid);
        }
        const subject = Object.entries(term.header ?? {})
          .find(([name]) => name.toLowerCase() === "subject")?.[1] ?? term.subject;
        if (subject) {
          return mailbox.messages
            .filter((message) => message.subject?.includes(subject) === true)
            .map(({ uid }) => uid);
        }
        return [];
      };
      return evaluate(query);
    });

    fetch = vi.fn((sequence: unknown) => {
      const selected = this.selected;
      const uids = new Set(requestedUids(sequence));
      mockState.fetchCalls.push({ folder: selected, uids: [...uids] });
      return (async function* () {
        if (mockState.deferredFetchFolders.has(selected)) {
          await new Promise<void>((resolve) => { mockState.fetchResolvers.set(selected, resolve); });
        }
        const mailbox = mockState.mailboxes.get(selected);
        for (const message of mailbox?.messages ?? []) {
          if (!uids.has(message.uid)) continue;
          const messageId = message.omitMessageId
            ? undefined
            : message.messageId ?? `uid-${message.uid}@e2e.test`;
          const headers = Buffer.from(
            `${message.ownershipToken ? `X-MailPouch-E2E-Run: ${message.ownershipToken}\r\n` : ""}` +
            `${messageId ? `Message-ID: <${messageId}>\r\n` : ""}` +
            `${message.subject ? `Subject: ${message.subject}\r\n` : ""}`,
          );
          yield {
            uid: message.uid,
            headers,
            envelope: { messageId, subject: message.subject },
            flags: new Set(message.flags ?? []),
            ...(message.source ? { source: Buffer.from(message.source) } : {}),
          };
        }
      })();
    });

    status = vi.fn(async (path: string) => ({
      messages: mockState.mailboxes.get(path)?.messages.length ?? 0,
    }));

    messageMove = vi.fn(async (sequence: unknown, target: string) => {
      const source = this.selected;
      const uids = requestedUids(sequence);
      mockState.mutationClientIds.push(this.clientId);
      mockState.moveCalls.push({ source, target, uids });
      const sourceMailbox = mockState.mailboxes.get(source)!;
      const targetMailbox = mockState.mailboxes.get(target)!;
      const sourceOwnership = new Map(sourceMailbox.messages.map((message) => [message.uid, message.ownershipToken]));
      sourceMailbox.messages = sourceMailbox.messages.filter(({ uid }) => !uids.includes(uid));
      for (const sourceUid of uids) {
        const destinationUid = mockState.moveUidMap.get(sourceUid);
        if (destinationUid !== undefined) {
          targetMailbox.messages.push({ uid: destinationUid, ownershipToken: sourceOwnership.get(sourceUid) });
        }
      }
      if (mockState.moveNeverSettlesAfterMutation) {
        return new Promise<never>(() => undefined);
      }
      if (mockState.moveReturnsFalseAfterMutation) return false;
      return {
        uidValidity: mockState.moveReportedUidValidity,
        uidMap: new Map(uids.flatMap((uid) => {
          const destinationUid = mockState.moveUidMap.get(uid);
          return destinationUid === undefined ? [] : [[uid, destinationUid] as const];
        })),
      };
    });

    messageCopy = vi.fn(async (sequence: unknown, target: string) => {
      const source = this.selected;
      const uids = requestedUids(sequence);
      mockState.copyCalls.push({ source, target, uids });
      const sourceMailbox = mockState.mailboxes.get(source)!;
      const sourceOwnership = new Map(sourceMailbox.messages.map((message) => [message.uid, message.ownershipToken]));
      const targetMailbox = mockState.mailboxes.get(target)!;
      if (mockState.copyForeignUid !== undefined) {
        targetMailbox.messages.push({ uid: mockState.copyForeignUid });
      }
      for (const sourceUid of uids) {
        const destinationUid = mockState.copyUidMap.get(sourceUid);
        if (destinationUid !== undefined) {
          targetMailbox.messages.push({ uid: destinationUid, ownershipToken: sourceOwnership.get(sourceUid) });
        }
      }
      if (mockState.copyThrowsAfterMutation) throw new Error("ambiguous COPY response");
      return {
        uidValidity: mockState.copyReportedUidValidity,
        uidMap: new Map(mockState.copyUidMap),
      };
    });

    messageDelete = vi.fn(async (sequence: unknown) => {
      const uids = requestedUids(sequence);
      mockState.mutationClientIds.push(this.clientId);
      mockState.deleteCalls.push({ folder: this.selected, uids });
      const mailbox = mockState.mailboxes.get(this.selected)!;
      mailbox.messages = mailbox.messages.filter(({ uid }) => !uids.includes(uid));
      return true;
    });
  },
}));

import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";
import { runToken } from "./e2e/support/scratch.js";

const TOKEN = "mpE2E-12345678-1234-4abc-8def-1234567890ab";
const SOURCE = `Folders/${TOKEN}-source`;
const RESCUE = `Folders/${TOKEN}-cleanup-rescue`;

const options = {
  host: "127.0.0.1",
  port: 3143,
  user: "test@example.test",
  pass: "secret",
};

function seedMove(actualTrashUidValidity: bigint): ImapFixtures {
  mockState.mailboxes.set(SOURCE, {
    uidValidity: 11n,
    messages: [{ uid: 10, ownershipToken: TOKEN }],
  });
  mockState.mailboxes.set("Trash", {
    uidValidity: actualTrashUidValidity,
    messages: [{ uid: 501 }],
  });
  mockState.moveUidMap.set(10, 502);
  mockState.moveReportedUidValidity = 42n;
  mockState.hiddenOwnershipSearchFolders.add("Trash");
  return new ImapFixtures(options);
}

function seedCopy(actualRescueUidValidity: bigint): ImapFixtures {
  mockState.mailboxes.set("All Mail", {
    uidValidity: 21n,
    messages: [{ uid: 20, ownershipToken: TOKEN }],
  });
  mockState.mailboxes.set("Trash", { uidValidity: 22n, messages: [] });
  mockState.copyUidMap.set(20, 702);
  mockState.copyReportedUidValidity = 77n;
  mockState.copyForeignUid = 701;
  mockState.createdMailboxUidValidity = actualRescueUidValidity;
  mockState.hiddenOwnershipSearchFolders.add(RESCUE);
  return new ImapFixtures(options);
}

describe("ImapFixtures destination UID lineage", () => {
  beforeEach(() => {
    mockState.mailboxes = new Map();
    mockState.moveUidMap = new Map();
    mockState.moveReportedUidValidity = 0n;
    mockState.copyUidMap = new Map();
    mockState.copyReportedUidValidity = 0n;
    mockState.copyForeignUid = undefined;
    mockState.copyThrowsAfterMutation = false;
    mockState.createdMailboxUidValidity = 1n;
    mockState.moveCalls.length = 0;
    mockState.copyCalls.length = 0;
    mockState.deleteCalls.length = 0;
    mockState.searchCalls.length = 0;
    mockState.hiddenOwnershipSearchFolders = new Set();
    mockState.deferredFetchFolders = new Set();
    mockState.fetchResolvers = new Map();
    mockState.specialUse = new Map();
    mockState.moveNeverSettlesAfterMutation = false;
    mockState.moveReturnsFalseAfterMutation = false;
    mockState.closeCalls = 0;
    mockState.logoutCalls = 0;
    mockState.connectCalls = 0;
    mockState.nextClientId = 0;
    mockState.mutationClientIds.length = 0;
    mockState.lockCalls.length = 0;
    mockState.fetchCalls.length = 0;
  });

  afterEach(() => vi.useRealTimers());

  it("does not claim an exclusively created mailbox when ImapFlow reports created:false", async () => {
    mockState.mailboxes.set(SOURCE, { uidValidity: 11n, messages: [] });
    const fixtures = new ImapFixtures(options);

    await expect(fixtures.createMailbox(SOURCE, true)).rejects.toThrow(/already exists/i);
    await expect(fixtures.createMailbox(SOURCE, false)).resolves.toBeUndefined();
  });

  it("combines all ownership discovery hints into one SEARCH per mailbox", async () => {
    mockState.mailboxes.set(SOURCE, {
      uidValidity: 10n,
      messages: [{ uid: 1, ownershipToken: TOKEN, messageId: "owned@e2e.test" }],
    });
    const fixtures = new ImapFixtures(options);
    const messageIds = Array.from({ length: 28 }, (_, index) => `hint-${index}@e2e.test`);
    (fixtures as unknown as { ownershipManifest: {
      searchMessageIds(): string[];
      searchSubjects(folder: string): string[];
      needsSource(): boolean;
    } }).ownershipManifest = {
      searchMessageIds: () => messageIds,
      searchSubjects: () => ["pending exact subject"],
      needsSource: () => false,
    };

    await expect(fixtures.ownedUids(SOURCE, TOKEN)).resolves.toEqual([1]);

    expect(mockState.searchCalls).toHaveLength(1);
    expect(mockState.searchCalls[0]?.query.or).toHaveLength(2);
    expect(mockState.searchCalls[0]?.query.or?.[0]?.or).toHaveLength(30);
    expect(mockState.searchCalls[0]?.query.or?.[1]).toEqual({ all: true });
  });

  it("durably promotes a fetched headerless pending artifact before authorizing its UID", async () => {
    const token = runToken();
    const subject = `${token} response-lost send`;
    mockState.mailboxes.set("Sent", {
      uidValidity: 10n,
      messages: [{
        uid: 17,
        messageId: "response-lost@example.test",
        subject,
      }],
    });
    const fixtures = new ImapFixtures(options);
    fixtures.beginSentMessageAdoption(subject, token);

    try {
      await expect(fixtures.ownedUids("Sent", token)).resolves.toEqual([17]);
      expect(fixtures.pendingOwnershipProofCount()).toBe(0);
      expect((fixtures as unknown as { ownershipManifest: { snapshot(): {
        proofs: Array<{ messageId: string }>;
      } } }).ownershipManifest.snapshot().proofs).toEqual([
        expect.objectContaining({ messageId: "response-lost@example.test" }),
      ]);
    } finally {
      fixtures.completeOwnershipRun(token);
    }
  });

  it("does not consume pending authority with an exact-header fixture seed", async () => {
    const token = runToken();
    const source = `Folders/${token}-header-seed`;
    const subject = `${token} exact-header seed`;
    mockState.mailboxes.set(source, {
      uidValidity: 10n,
      messages: [{
        uid: 18,
        ownershipToken: token,
        messageId: "fixture-seed@example.test",
        subject,
      }],
    });
    const fixtures = new ImapFixtures(options);
    fixtures.beginSentMessageAdoption(subject, token);

    try {
      await expect(fixtures.ownedUids(source, token)).resolves.toEqual([18]);
      expect(fixtures.pendingOwnershipProofCount()).toBe(1);
    } finally {
      fixtures.completeOwnershipRun(token);
    }
  });

  it("keeps a missing-Message-ID pending artifact out of the mutation UID set", async () => {
    const token = runToken();
    const subject = `${token} missing stable identity`;
    mockState.mailboxes.set("Sent", {
      uidValidity: 10n,
      messages: [{ uid: 19, omitMessageId: true, subject }],
    });
    const fixtures = new ImapFixtures(options);
    fixtures.beginSentMessageAdoption(subject, token);

    try {
      await expect(fixtures.ownedUids("Sent", token)).resolves.toEqual([]);
      expect(fixtures.pendingOwnershipProofCount()).toBe(1);
    } finally {
      fixtures.completeOwnershipRun(token);
    }
  });

  it("keeps a sent-vs-draft ambiguous artifact out of the mutation UID set", async () => {
    const token = runToken();
    const subject = `${token} ambiguous pending artifact`;
    mockState.mailboxes.set("Drafts", {
      uidValidity: 10n,
      messages: [{ uid: 20, messageId: "ambiguous@example.test", subject }],
    });
    const fixtures = new ImapFixtures(options);
    fixtures.beginSentMessageAdoption(subject, token);
    fixtures.beginDraftMessageAdoption("Drafts", subject, token);

    try {
      await expect(fixtures.ownedUids("Drafts", token)).resolves.toEqual([]);
      expect(fixtures.pendingOwnershipProofCount()).toBe(2);
    } finally {
      fixtures.completeOwnershipRun(token);
    }
  });

  it("purges only the MOVE-mapped destination UID when UIDVALIDITY matches", async () => {
    const fixtures = seedMove(42n);

    await expect(fixtures.moveOwnedToTrash(SOURCE, TOKEN)).resolves.toMatchObject({ moved: 1 });
    await expect(fixtures.purgeOwnedTrash(TOKEN)).resolves.toBe(1);

    expect(mockState.moveCalls).toEqual([{ source: SOURCE, target: "Trash", uids: [10] }]);
    expect(mockState.deleteCalls).toEqual([{ folder: "Trash", uids: [502] }]);
    expect(mockState.mailboxes.get("Trash")!.messages.map(({ uid }) => uid)).toEqual([501]);
  });

  it("moves one deterministic exact-owned UID per fresh-session checkpoint", async () => {
    const fixtures = new ImapFixtures(options);
    mockState.mailboxes.set(SOURCE, {
      uidValidity: 11n,
      messages: Array.from({ length: 9 }, (_, index) => ({
        uid: 20 - index,
        ownershipToken: TOKEN,
      })),
    });
    mockState.mailboxes.set("Trash", { uidValidity: 42n, messages: [] });
    for (let uid = 12; uid <= 20; uid++) mockState.moveUidMap.set(uid, 100 + uid);
    mockState.moveReportedUidValidity = 42n;

    for (let remainingOwned = 8; remainingOwned >= 0; remainingOwned -= 1) {
      await expect(fixtures.moveOwnedToTrash(SOURCE, TOKEN)).resolves.toMatchObject({
        moved: 1,
        remainingOwned,
      });
    }

    expect(mockState.moveCalls.map(({ uids }) => uids)).toEqual(
      Array.from({ length: 9 }, (_, index) => [12 + index]),
    );
    expect(new Set(mockState.mutationClientIds).size).toBe(9);
    expect(mockState.logoutCalls).toBe(0);
  });

  it("batches fresh-session subject and flag observations by folder", async () => {
    mockState.mailboxes.set(SOURCE, {
      uidValidity: 11n,
      messages: [
        { uid: 9, subject: "alpha owned", flags: ["\\Seen"] },
        { uid: 4, subject: "beta owned", flags: ["\\Flagged"] },
      ],
    });
    const fixtures = new ImapFixtures(options);

    await expect(fixtures.searchSubjects(SOURCE, ["alpha", "beta", "alpha"]))
      .resolves.toEqual(new Map([
        ["alpha", [9]],
        ["beta", [4]],
      ]));
    expect(mockState.connectCalls).toBe(1);
    expect(mockState.lockCalls).toEqual([SOURCE]);

    mockState.lockCalls.length = 0;
    mockState.fetchCalls.length = 0;
    await expect(fixtures.getFlagsForUids(SOURCE, [9, 4, 99, 9]))
      .resolves.toEqual(new Map([
        [4, ["\\Flagged"]],
        [9, ["\\Seen"]],
        [99, null],
      ]));
    expect(mockState.connectCalls).toBe(2);
    expect(mockState.lockCalls).toEqual([SOURCE]);
    expect(mockState.fetchCalls).toEqual([{ folder: SOURCE, uids: [4, 9, 99] }]);
  });

  it("never dispatches MOVE when an ownership FETCH resolves after cleanup abort", async () => {
    const fixtures = seedMove(42n);
    mockState.deferredFetchFolders.add(SOURCE);
    const moving = fixtures.moveOwnedToTrash(SOURCE, TOKEN);

    await vi.waitFor(() => expect(mockState.fetchResolvers.has(SOURCE)).toBe(true));
    fixtures.abortCleanupSession("test absolute deadline");
    mockState.fetchResolvers.get(SOURCE)?.();

    await expect(moving).rejects.toThrow(/test absolute deadline/);
    expect(mockState.moveCalls).toEqual([]);
    expect(mockState.deleteCalls).toEqual([]);
    expect(mockState.mailboxes.get(SOURCE)?.messages).toHaveLength(1);
  });

  it("fails closed on a lost MOVE response and recovers from observed server state", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-13T00:00:00Z"));
    mockState.mailboxes.set(SOURCE, {
      uidValidity: 11n,
      messages: [
        { uid: 10, ownershipToken: TOKEN },
        { uid: 11, ownershipToken: TOKEN },
      ],
    });
    mockState.mailboxes.set("Trash", { uidValidity: 42n, messages: [{ uid: 501 }] });
    mockState.moveUidMap.set(10, 502);
    mockState.moveUidMap.set(11, 503);
    mockState.moveReportedUidValidity = 42n;
    mockState.hiddenOwnershipSearchFolders.add("Trash");
    const fixtures = new ImapFixtures(options);
    mockState.moveNeverSettlesAfterMutation = true;
    const moving = fixtures.moveOwnedToTrash(SOURCE, TOKEN);
    const failure = expect(moving).rejects.toMatchObject({
      code: "MAILPOUCH_E2E_CLEANUP_TIMEOUT",
    });

    await vi.advanceTimersByTimeAsync(BRIDGE_MUTATION_COMMAND_MS);
    await failure;

    expect(mockState.closeCalls).toBeGreaterThan(0);
    expect(mockState.moveCalls).toEqual([{ source: SOURCE, target: "Trash", uids: [10] }]);
    expect(mockState.deleteCalls).toEqual([]);
    expect(mockState.mailboxes.get(SOURCE)?.messages).toEqual([{ uid: 11, ownershipToken: TOKEN }]);

    // A later explicit recovery re-discovers the destination. It does not
    // replay the ambiguous source MOVE and deletes only the exact-owned UID.
    mockState.moveNeverSettlesAfterMutation = false;
    mockState.hiddenOwnershipSearchFolders.delete("Trash");
    const recovery = new ImapFixtures(options);
    await expect(recovery.purgeOwnedTrash(TOKEN)).resolves.toBe(1);
    expect(mockState.moveCalls).toHaveLength(1);
    expect(mockState.deleteCalls).toEqual([{ folder: "Trash", uids: [502] }]);
    expect(mockState.mailboxes.get("Trash")?.messages.map(({ uid }) => uid)).toEqual([501]);
  });

  it("stops before the next UID when ImapFlow returns false after a mutation", async () => {
    mockState.mailboxes.set(SOURCE, {
      uidValidity: 11n,
      messages: [
        { uid: 10, ownershipToken: TOKEN },
        { uid: 11, ownershipToken: TOKEN },
      ],
    });
    mockState.mailboxes.set("Trash", { uidValidity: 42n, messages: [] });
    mockState.moveUidMap.set(10, 502);
    mockState.moveUidMap.set(11, 503);
    mockState.moveReportedUidValidity = 42n;
    mockState.moveReturnsFalseAfterMutation = true;
    const fixtures = new ImapFixtures(options);

    await expect(fixtures.moveOwnedToTrash(SOURCE, TOKEN)).rejects.toMatchObject({
      code: "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN",
    });

    expect(mockState.moveCalls).toEqual([{ source: SOURCE, target: "Trash", uids: [10] }]);
    expect(mockState.closeCalls).toBeGreaterThan(0);
    expect(mockState.mailboxes.get(SOURCE)?.messages).toEqual([{ uid: 11, ownershipToken: TOKEN }]);
  });

  it("discards MOVE lineage when destination UIDVALIDITY does not match", async () => {
    const fixtures = seedMove(43n);

    await fixtures.moveOwnedToTrash(SOURCE, TOKEN);
    await expect(fixtures.purgeOwnedTrash(TOKEN)).resolves.toBe(0);

    expect(mockState.deleteCalls).toEqual([]);
    expect(mockState.mailboxes.get("Trash")!.messages.map(({ uid }) => uid)).toEqual([501, 502]);
  });

  it("refuses MOVE and DELETE from the unstable English All Mail projection", async () => {
    mockState.mailboxes.set("All Mail", {
      uidValidity: 21n,
      messages: [{ uid: 20, ownershipToken: TOKEN }],
    });
    mockState.mailboxes.set("Trash", { uidValidity: 22n, messages: [] });
    const fixtures = new ImapFixtures(options);

    await fixtures.listCleanupMailboxes();
    await expect(fixtures.moveOwnedToTrash("All Mail", TOKEN)).rejects.toThrow(/unstable All Mail/i);
    await expect(fixtures.deleteOwnedMessages("All Mail", TOKEN)).rejects.toThrow(/unstable All Mail/i);

    expect(mockState.moveCalls).toEqual([]);
    expect(mockState.deleteCalls).toEqual([]);
  });

  it("refuses mutation from a localized All Mail special-use mailbox", async () => {
    const localizedAllMail = "Tous les messages";
    mockState.mailboxes.set(localizedAllMail, {
      uidValidity: 21n,
      messages: [{ uid: 20, ownershipToken: TOKEN }],
    });
    mockState.mailboxes.set("Trash", { uidValidity: 22n, messages: [] });
    mockState.specialUse.set(localizedAllMail, "\\All");
    const fixtures = new ImapFixtures(options);

    await fixtures.listCleanupMailboxes();
    await expect(fixtures.moveOwnedToTrash(localizedAllMail, TOKEN)).rejects.toThrow(/unstable All Mail/i);
    await expect(fixtures.deleteOwnedMessages(localizedAllMail, TOKEN)).rejects.toThrow(/unstable All Mail/i);

    expect(mockState.moveCalls).toEqual([]);
    expect(mockState.deleteCalls).toEqual([]);
  });
});
