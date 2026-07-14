import { afterEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  selected: "",
  locks: [] as string[],
  messageId: "delivery@example.test",
  subject: "",
  labelCount: 1,
  inboxSearches: 0,
  inboxSearchesBeforeMatch: 0,
}));

vi.mock("imapflow", () => ({
  ImapFlow: class MockImapFlow {
    mailbox: { exists: number } | null = null;

    async list() {
      // Deliberately put a large-label shape first. Adoption must prioritize
      // the delivery mailbox and stop after its first exact proof.
      const labels = Array.from({ length: mockState.labelCount }, (_, index) => `Labels/Bulk-${index}`);
      return [...labels, "All Mail", "Sent", "INBOX"].map((path) => ({
        path,
        flags: new Set<string>(),
      }));
    }

    async getMailboxLock(folder: string) {
      mockState.selected = folder;
      mockState.locks.push(folder);
      this.mailbox = { exists: 1 };
      return { release: vi.fn() };
    }

    async search() {
      if (mockState.selected !== "INBOX") return [];
      mockState.inboxSearches += 1;
      return mockState.inboxSearches > mockState.inboxSearchesBeforeMatch ? [17] : [];
    }

    async *fetch() {
      if (mockState.selected === "INBOX") {
        yield {
          uid: 17,
          envelope: { messageId: mockState.messageId, subject: mockState.subject },
        };
      }
    }

    async connect() {}
    async logout() {}
  },
}));

import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";

const TOKEN = "mpE2E-12345678-1234-4abc-8def-1234567890ab";

describe("ImapFixtures sent-message adoption", () => {
  let fixture: ImapFixtures | undefined;

  afterEach(() => {
    if (fixture) fixture.completeOwnershipRun(TOKEN);
    fixture = undefined;
    mockState.selected = "";
    mockState.locks.length = 0;
    mockState.labelCount = 1;
    mockState.inboxSearches = 0;
    mockState.inboxSearchesBeforeMatch = 0;
  });

  it("prioritizes INBOX and stops after the first exact ownership proof", async () => {
    mockState.subject = `${TOKEN} self-send`;
    fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 1143,
      user: "owner@example.test",
      pass: "secret",
    });
    const pendingId = fixture.beginSentMessageAdoption(mockState.subject, TOKEN);

    await expect(fixture.adoptSentMessage(
      `<${mockState.messageId}>`,
      mockState.subject,
      TOKEN,
      undefined,
      pendingId,
    )).resolves.toBe(1);

    expect(mockState.locks).toEqual(["INBOX"]);
    expect(fixture.pendingOwnershipProofCount()).toBe(0);
  });

  it("rechecks likely delivery folders before exhausting a large label tree", async () => {
    mockState.subject = `${TOKEN} delayed self-send`;
    mockState.labelCount = 162;
    mockState.inboxSearchesBeforeMatch = 1;
    fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 1143,
      user: "owner@example.test",
      pass: "secret",
    });
    const pendingId = fixture.beginSentMessageAdoption(mockState.subject, TOKEN);

    await expect(fixture.adoptSentMessage(
      `<${mockState.messageId}>`,
      mockState.subject,
      TOKEN,
      undefined,
      pendingId,
    )).resolves.toBe(1);

    const secondInbox = mockState.locks.indexOf("INBOX", 1);
    expect(secondInbox).toBeGreaterThan(0);
    expect(secondInbox).toBeLessThan(16);
    expect(mockState.locks).not.toContain("Labels/Bulk-161");
    expect(fixture.pendingOwnershipProofCount()).toBe(0);
  });
});
