import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    mailboxDelete: ReturnType<typeof vi.fn>;
    logout: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    getMailboxLock: ReturnType<typeof vi.fn>;
  }>,
  failDeleteForInstance: new Set<number>(),
  failLogoutForInstance: new Set<number>(),
  deferredConnectInstances: new Set<number>(),
  connectResolvers: new Map<number, () => void>(),
  nonEmptyDeleteInstances: new Set<number>(),
  uidValidityByInstance: new Map<number, bigint>(),
  deleteLockHeld: [] as boolean[],
}));

vi.mock("imapflow", () => ({
  ImapFlow: class MockImapFlow {
    mailbox: false | { path: string; exists: number; uidValidity: bigint } = false;
    private lockHeld = false;
    connect = vi.fn(async () => {
      const index = mockState.instances.indexOf(this);
      if (mockState.deferredConnectInstances.has(index)) {
        await new Promise<void>((resolve) => { mockState.connectResolvers.set(index, resolve); });
      }
    });
    mailboxDelete = vi.fn(async (_path: string) => {
      const index = mockState.instances.indexOf(this);
      mockState.deleteLockHeld.push(this.lockHeld);
      if (mockState.failDeleteForInstance.has(index)) {
        const error = new Error("Connection not available") as Error & { code?: string };
        error.code = "NoConnection";
        throw error;
      }
      return { path: _path };
    });
    logout = vi.fn(async () => {
      const index = mockState.instances.indexOf(this);
      if (mockState.failLogoutForInstance.has(index)) throw new Error("socket already closed");
    });
    close = vi.fn();
    getMailboxLock = vi.fn(async (path: string) => {
      const index = mockState.instances.indexOf(this);
      this.mailbox = {
        path,
        exists: mockState.nonEmptyDeleteInstances.has(index) ? 1 : 0,
        uidValidity: mockState.uidValidityByInstance.get(index) ?? 1n,
      };
      this.lockHeld = true;
      return { release: vi.fn(() => { this.lockHeld = false; }) };
    });

    constructor(_options: unknown) {
      mockState.instances.push(this);
    }
  },
}));

import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";

const options = {
  host: "127.0.0.1",
  port: 3143,
  user: "test@example.test",
  pass: "secret",
};

describe("ImapFixtures mailbox deletion lifecycle", () => {
  beforeEach(() => {
    mockState.instances.length = 0;
    mockState.failDeleteForInstance.clear();
    mockState.failLogoutForInstance.clear();
    mockState.deferredConnectInstances.clear();
    mockState.connectResolvers.clear();
    mockState.nonEmptyDeleteInstances.clear();
    mockState.uidValidityByInstance.clear();
    mockState.deleteLockHeld.length = 0;
  });

  it("uses an isolated connection and leaves the persistent fixture client untouched", async () => {
    const fixtures = new ImapFixtures(options);
    const persistent = mockState.instances[0]!;

    await fixtures.deleteMailbox("Folders/mpE2E-test-1");

    expect(mockState.instances).toHaveLength(2);
    expect(persistent.connect).not.toHaveBeenCalled();
    expect(persistent.mailboxDelete).not.toHaveBeenCalled();
    expect(persistent.logout).not.toHaveBeenCalled();
    expect(persistent.close).not.toHaveBeenCalled();

    const deletionClient = mockState.instances[1]!;
    expect(deletionClient.connect).toHaveBeenCalledOnce();
    expect(deletionClient.getMailboxLock).toHaveBeenCalledWith("Folders/mpE2E-test-1");
    expect(deletionClient.mailboxDelete).toHaveBeenCalledWith("Folders/mpE2E-test-1");
    expect(mockState.deleteLockHeld).toEqual([true]);
    expect(deletionClient.logout).toHaveBeenCalledOnce();
    expect(deletionClient.close).not.toHaveBeenCalled();
  });

  it("refuses DELETE when the final deletion session observes new content", async () => {
    const fixtures = new ImapFixtures(options);
    mockState.nonEmptyDeleteInstances.add(1);

    await expect(fixtures.deleteMailbox("Folders/mpE2E-test-foreign"))
      .rejects.toThrow(/final deletion-session emptiness proof failed/i);

    const deletionClient = mockState.instances[1]!;
    expect(deletionClient.mailboxDelete).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(2);
  });

  it("refuses DELETE when the final mailbox identity differs from the creation proof", async () => {
    const fixtures = new ImapFixtures(options);
    mockState.uidValidityByInstance.set(1, 2n);

    await expect(fixtures.deleteMailbox("Folders/mpE2E-test-recreated", "1"))
      .rejects.toThrow(/UIDVALIDITY changed from 1 to 2/i);

    const deletionClient = mockState.instances[1]!;
    expect(deletionClient.mailboxDelete).not.toHaveBeenCalled();
    expect(mockState.deleteLockHeld).toEqual([]);
  });

  it("never retries DELETE after an ambiguous post-dispatch failure", async () => {
    const fixtures = new ImapFixtures(options);
    // Instance 0 is the persistent fixture client; instance 1 is DELETE attempt 1.
    mockState.failDeleteForInstance.add(1);
    mockState.failLogoutForInstance.add(1);

    await expect(fixtures.deleteMailbox("Labels/mpE2E-test-2"))
      .rejects.toMatchObject({ code: "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN" });

    expect(mockState.instances).toHaveLength(2);
    const failedAttempt = mockState.instances[1]!;
    expect(failedAttempt.mailboxDelete).toHaveBeenCalledOnce();
    expect(failedAttempt.logout).toHaveBeenCalledOnce();
    expect(failedAttempt.close).toHaveBeenCalledOnce();
  });

  it("does not reuse a DELETE session across repeated scratch-folder removals", async () => {
    const fixtures = new ImapFixtures(options);

    await fixtures.deleteMailbox("Folders/mpE2E-test-1");
    await fixtures.deleteMailbox("Folders/mpE2E-test-2");

    expect(mockState.instances).toHaveLength(3);
    expect(mockState.instances[1]!.mailboxDelete).toHaveBeenCalledWith("Folders/mpE2E-test-1");
    expect(mockState.instances[2]!.mailboxDelete).toHaveBeenCalledWith("Folders/mpE2E-test-2");
    expect(mockState.instances[1]!.logout).toHaveBeenCalledOnce();
    expect(mockState.instances[2]!.logout).toHaveBeenCalledOnce();
  });

  it("closes an in-flight auxiliary DELETE client and never retries after abort", async () => {
    const fixtures = new ImapFixtures(options);
    mockState.deferredConnectInstances.add(1);
    const deleting = fixtures.deleteMailbox("Folders/mpE2E-test-timeout");

    await vi.waitFor(() => expect(mockState.connectResolvers.has(1)).toBe(true));
    const failedAttempt = mockState.instances[1]!;
    fixtures.abortCleanupSession("test absolute deadline");
    expect(failedAttempt.close).toHaveBeenCalledOnce();

    const assertion = expect(deleting).rejects.toThrow(/test absolute deadline/);
    mockState.connectResolvers.get(1)?.();
    await assertion;

    expect(failedAttempt.mailboxDelete).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(2);
  });
});
