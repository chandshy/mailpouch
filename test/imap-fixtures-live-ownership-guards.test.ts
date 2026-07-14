import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  uidPlusEnabled: true,
  instances: [] as Array<{
    connect: ReturnType<typeof vi.fn>;
    append: ReturnType<typeof vi.fn>;
    mailboxCreate: ReturnType<typeof vi.fn>;
    mailboxDelete: ReturnType<typeof vi.fn>;
    messageMove: ReturnType<typeof vi.fn>;
    messageDelete: ReturnType<typeof vi.fn>;
  }>,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class MockImapFlow {
    mailbox: false | { path: string; exists: number; uidValidity: bigint } = false;
    isClosed = false;
    capabilities = new Map(mockState.uidPlusEnabled ? [["UIDPLUS", true]] : []);

    connect = vi.fn(async () => true);
    append = vi.fn(async () => ({ uid: 1 }));
    mailboxCreate = vi.fn(async (path: string) => ({ path, created: true }));
    mailboxDelete = vi.fn(async () => true);
    messageMove = vi.fn(async () => true);
    messageDelete = vi.fn(async () => true);
    getMailboxLock = vi.fn(async (path: string) => {
      this.mailbox = { path, exists: 0, uidValidity: 7n };
      return { release: vi.fn() };
    });

    constructor(_options: unknown) {
      mockState.instances.push(this);
    }
  },
}));

import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";
import { runToken } from "./e2e/support/scratch.js";

interface ActiveOwnershipRun {
  fixture: ImapFixtures;
  token: string;
}

const activeRuns: ActiveOwnershipRun[] = [];

function liveFixture(): ActiveOwnershipRun & { scratch: string } {
  const token = runToken();
  const fixture = new ImapFixtures({
    host: "127.0.0.1",
    port: 3143,
    user: "live@example.test",
    pass: "secret",
    allowCreateSystemFolders: false,
    requireUidPlusForMutations: true,
    ownershipToken: token,
  });
  activeRuns.push({ fixture, token });
  return { fixture, token, scratch: `Folders/${token}-guard` };
}

afterEach(() => {
  for (const { fixture, token } of activeRuns.splice(0)) {
    if (fixture.hasOwnershipRun(token)) fixture.completeOwnershipRun(token);
  }
  mockState.instances.length = 0;
  mockState.uidPlusEnabled = true;
});

describe("ImapFixtures live ownership guards", () => {
  it("refuses a live connection without UIDPLUS before any destructive wire command", async () => {
    mockState.uidPlusEnabled = false;
    const { fixture } = liveFixture();

    await expect(fixture.connect()).rejects.toThrow(/UIDPLUS/i);

    expect(mockState.instances).toHaveLength(1);
    expect(mockState.instances[0]?.messageMove).not.toHaveBeenCalled();
    expect(mockState.instances[0]?.messageDelete).not.toHaveBeenCalled();
  });

  it("refuses mailbox creation outside the run scratch namespace", async () => {
    const { fixture } = liveFixture();

    await expect(fixture.createMailbox("INBOX", true)).rejects.toThrow(/Scratch guard REFUSED/i);

    expect(mockState.instances[0]?.mailboxCreate).not.toHaveBeenCalled();
  });

  it("requires exclusive creation even for a valid run scratch mailbox", async () => {
    const { fixture, scratch } = liveFixture();

    await expect(fixture.createMailbox(scratch)).rejects.toThrow(
      /requires exclusive mailbox creation/i,
    );

    expect(mockState.instances[0]?.mailboxCreate).not.toHaveBeenCalled();
  });

  it("refuses the public raw APPEND escape hatch", async () => {
    const { fixture, scratch } = liveFixture();

    await expect(fixture.appendEmail(scratch, "Subject: unsafe\r\n\r\nbody")).rejects.toThrow(
      /Raw IMAP APPEND is disabled in ownership mode/i,
    );

    expect(mockState.instances[0]?.append).not.toHaveBeenCalled();
  });

  it("refuses live mailbox DELETE before consulting creation proof", async () => {
    const { fixture, scratch } = liveFixture();

    await expect(fixture.deleteMailbox(scratch, "7")).rejects.toThrow(
      /live Bridge mailbox DELETE is disabled/i,
    );

    expect(mockState.instances[0]?.mailboxDelete).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(1);
  });

  it("refuses live mailbox DELETE for missing or mismatched expected identities", async () => {
    const { fixture, scratch, token } = liveFixture();
    await fixture.recordCreatedMailbox(scratch, token);

    await expect(fixture.deleteMailbox(scratch)).rejects.toThrow(
      /live Bridge mailbox DELETE is disabled/i,
    );
    await expect(fixture.deleteMailbox(scratch, "8")).rejects.toThrow(
      /live Bridge mailbox DELETE is disabled/i,
    );

    expect(mockState.instances[0]?.mailboxDelete).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(1);
  });

  it("never reaches ImapFlow DELETE even with an exact durable creation identity", async () => {
    const { fixture, scratch, token } = liveFixture();
    await fixture.recordCreatedMailbox(scratch, token);

    await expect(fixture.deleteMailbox(scratch, "7")).rejects.toThrow(
      /retain the empty run-created folder for manual cleanup/i,
    );

    expect(mockState.instances[0]?.mailboxDelete).not.toHaveBeenCalled();
    expect(mockState.instances).toHaveLength(1);
  });
});
