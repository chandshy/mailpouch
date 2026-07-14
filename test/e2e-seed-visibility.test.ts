import { describe, expect, it, vi } from "vitest";
import { ImapFixtures } from "./e2e/fixtures/imap-fixtures.js";

const TOKEN = "mpE2E-00000000-0000-4000-8000-000000000001";

function fixture(): ImapFixtures {
  return new ImapFixtures({
    host: "127.0.0.1",
    port: 1143,
    user: "test",
    pass: "test",
  });
}

describe("identified E2E seed projection", () => {
  it("assigns a canonical unique Message-ID before APPEND", async () => {
    const imap = fixture();
    const append = vi.spyOn(imap, "appendEmail").mockResolvedValue(42);

    const identity = await imap.appendIdentifiedSeed("INBOX", { subject: "visibility probe" });

    expect(identity).toMatchObject({ uid: 42, subject: "visibility probe" });
    expect(identity.messageId).toMatch(/^mailpouch-e2e-[0-9a-f-]{36}@test\.local$/);
    expect(append).toHaveBeenCalledOnce();
    expect(append.mock.calls[0]?.[1]).toContain(`Message-ID: <${identity.messageId}>`);
  });

  it("re-resolves only the exact Message-ID, subject, and ownership header", async () => {
    const imap = fixture();
    const correctHeaders = Buffer.from([
      "Message-ID: <probe@test.local>",
      "Subject: exact subject",
      `X-MailPouch-E2E-Run: ${TOKEN}`,
      "",
      "",
    ].join("\r\n"));
    const wrongOwnerHeaders = Buffer.from([
      "Message-ID: <probe@test.local>",
      "Subject: exact subject",
      "X-MailPouch-E2E-Run: mpE2E-00000000-0000-4000-8000-000000000002",
      "",
      "",
    ].join("\r\n"));
    const client = {
      mailbox: { exists: 2 },
      getMailboxLock: vi.fn(async () => ({ release: vi.fn() })),
      search: vi.fn(async () => [7, 8]),
      fetch: async function* () {
        yield { uid: 7, envelope: { messageId: "probe@test.local", subject: "exact subject" }, headers: correctHeaders };
        yield { uid: 8, envelope: { messageId: "probe@test.local", subject: "exact subject" }, headers: wrongOwnerHeaders };
      },
    };
    const internals = imap as unknown as {
      client: typeof client;
      withReconnect<T>(fn: () => Promise<T>): Promise<T>;
    };
    internals.client = client;
    internals.withReconnect = async <T>(fn: () => Promise<T>): Promise<T> => fn();

    await expect(imap.findSeedIdentityUids(
      "INBOX",
      "probe@test.local",
      "exact subject",
      TOKEN,
    )).resolves.toEqual([7]);
  });

  it("refreshes the fixture connection before a subject search", async () => {
    const imap = fixture();
    const release = vi.fn();
    const client = {
      getMailboxLock: vi.fn(async () => ({ release })),
      search: vi.fn(async () => [9]),
    };
    const internals = imap as unknown as {
      client: typeof client;
      reconnect(): Promise<void>;
      withReconnect<T>(fn: () => Promise<T>): Promise<T>;
    };
    internals.client = client;
    internals.reconnect = vi.fn(async () => undefined);
    internals.withReconnect = async <T>(fn: () => Promise<T>): Promise<T> => fn();

    await expect(imap.searchSubject("INBOX", "exact subject")).resolves.toEqual([9]);
    expect(internals.reconnect).toHaveBeenCalledOnce();
    expect(client.getMailboxLock).toHaveBeenCalledWith("INBOX");
    expect(client.search).toHaveBeenCalledWith(
      { header: { subject: "exact subject" } },
      { uid: true },
    );
    expect(release).toHaveBeenCalledOnce();
  });
});
