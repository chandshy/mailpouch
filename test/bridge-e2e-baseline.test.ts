import { describe, expect, it, vi } from "vitest";
import {
  ImapFixtures,
  type MailboxSafetyMessage,
} from "./e2e/fixtures/imap-fixtures.js";

interface MockMailboxState {
  uidValidity: string;
  messages: MailboxSafetyMessage[];
}

interface SnapshotFixtureInternals {
  snapshotMailboxState(folder: string): Promise<MockMailboxState>;
}

function baselineFixture(initial: MockMailboxState, path = "INBOX") {
  const fixture = new ImapFixtures({
    host: "127.0.0.1",
    port: 1143,
    user: "unused",
    pass: "unused",
  });
  let state = structuredClone(initial);
  vi.spyOn(fixture, "listMailboxes").mockResolvedValue([path]);
  vi.spyOn(fixture, "listCleanupMailboxes").mockResolvedValue([path]);
  vi.spyOn(
    fixture as unknown as SnapshotFixtureInternals,
    "snapshotMailboxState",
  ).mockImplementation(async () => structuredClone(state));
  return {
    fixture,
    setState(next: MockMailboxState) {
      state = structuredClone(next);
    },
  };
}

const ORIGINAL: MockMailboxState = {
  uidValidity: "4107",
  messages: [
    { uid: 12, messageId: "original@example.test", flags: ["\\Seen"] },
    { uid: 18, flags: [] },
  ],
};

describe("live Bridge baseline verification", () => {
  it("includes pre-existing E2E-marked mail in the protected baseline", async () => {
    const token = "mpE2E-12345678-1234-4abc-8def-1234567890ab";
    const fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 1143,
      user: "unused",
      pass: "unused",
    });
    const release = vi.fn();
    const fetch = vi.fn(() => (async function* () {
      yield {
        uid: 42,
        flags: new Set(["\\Seen"]),
        envelope: { messageId: "preexisting-e2e@example.test" },
        headers: Buffer.from(`Message-ID: <preexisting-e2e@example.test>\r\nX-MailPouch-E2E-Run: ${token}\r\n`),
      };
    })());
    (fixture as unknown as { client: unknown }).client = {
      mailbox: { uidValidity: 77n, exists: 1 },
      getMailboxLock: vi.fn(async () => ({ release })),
      fetch,
    };

    const state = await (fixture as unknown as SnapshotFixtureInternals)
      .snapshotMailboxState("INBOX");

    expect(state).toEqual({
      uidValidity: "77",
      messages: [{
        uid: 42,
        messageId: "preexisting-e2e@example.test",
        flags: ["\\Seen"],
      }],
    });
    expect(fetch).toHaveBeenCalledOnce();
    expect(release).toHaveBeenCalledOnce();
  });

  it("accepts an unchanged UIDVALIDITY, UID, Message-ID, and flag snapshot", async () => {
    const h = baselineFixture(ORIGINAL);
    const snapshot = await h.fixture.captureSafetySnapshot();

    expect(snapshot.uidValidity).toEqual({ INBOX: "4107" });
    await expect(h.fixture.verifySafetySnapshot(snapshot)).resolves.toEqual({ ok: true, errors: [] });
  });

  it("aborts an in-flight baseline audit at its absolute deadline", async () => {
    const h = baselineFixture(ORIGINAL);
    const snapshot = await h.fixture.captureSafetySnapshot();
    vi.spyOn(h.fixture, "listMailboxes").mockImplementation(
      () => new Promise<string[]>(() => undefined),
    );
    const abort = vi.spyOn(h.fixture, "abortCleanupSession").mockImplementation(() => undefined);
    const startedAt = Date.now();

    await expect(h.fixture.verifySafetySnapshot(snapshot, 25)).rejects.toThrow(/absolute deadline/i);

    expect(Date.now() - startedAt).toBeLessThan(250);
    expect(abort).toHaveBeenCalledOnce();
  });

  it("does not swallow a persistent cleanup abort as one mailbox error", async () => {
    const fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 1143,
      user: "unused",
      pass: "unused",
    });
    vi.spyOn(fixture, "listMailboxes").mockResolvedValue(["INBOX", "Archive"]);
    const visited: string[] = [];
    vi.spyOn(
      fixture as unknown as SnapshotFixtureInternals,
      "snapshotMailboxState",
    ).mockImplementation(async (path) => {
      visited.push(path);
      if (path === "INBOX") {
        fixture.abortCleanupSession("persistent baseline abort");
        throw new Error("transport closed");
      }
      return { uidValidity: "1", messages: [] };
    });
    const snapshot = {
      mailboxPaths: ["INBOX", "Archive"],
      uidValidity: { INBOX: "1", Archive: "1" },
      messages: { INBOX: [], Archive: [] },
    };

    await expect(fixture.verifySafetySnapshot(snapshot)).rejects.toThrow(/persistent baseline abort/);
    expect(visited).toEqual(["INBOX"]);
  });

  it("detects deleting and recreating a mailbox at the same path", async () => {
    const h = baselineFixture(ORIGINAL);
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({ ...ORIGINAL, uidValidity: "4108" });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(" ")).toMatch(/UIDVALIDITY changed.*deleted or recreated/i);
  });

  it("does not let a replacement copy with the same Message-ID and flags mask a missing baseline UID", async () => {
    const h = baselineFixture(ORIGINAL);
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({
      uidValidity: ORIGINAL.uidValidity,
      messages: [
        { uid: 99, messageId: "original@example.test", flags: ["\\Seen"] },
        ORIGINAL.messages[1]!,
      ],
    });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain("INBOX: baseline UID 12 is missing");
  });

  it("detects Message-ID and flag changes on the original UID", async () => {
    const h = baselineFixture(ORIGINAL);
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({
      uidValidity: ORIGINAL.uidValidity,
      messages: [
        { uid: 12, messageId: "replacement@example.test", flags: ["\\Flagged"] },
        ORIGINAL.messages[1]!,
      ],
    });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.errors).toContain(
      "INBOX: baseline UID 12 Message-ID changed from original@example.test to replacement@example.test",
    );
    expect(verification.errors).toContain("INBOX: baseline UID 12 flags changed");
  });

  it("accepts All Mail projection UID churn when stable Message-ID identities and flags survive", async () => {
    const h = baselineFixture(ORIGINAL, "All Mail");
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({
      // Bridge can rebuild this virtual projection without changing logical
      // membership or reliably advancing UIDVALIDITY.
      uidValidity: "different-virtual-generation",
      messages: [
        { uid: 91, messageId: "original@example.test", flags: ["\\Seen"] },
        ORIGINAL.messages[1]!,
        { uid: 100, messageId: "new-arrival@example.test", flags: [] },
      ],
    });

    await expect(h.fixture.verifySafetySnapshot(snapshot)).resolves.toEqual({ ok: true, errors: [] });
  });

  it("still detects a missing stable All Mail identity after UID churn", async () => {
    const h = baselineFixture(ORIGINAL, "All Mail");
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({
      uidValidity: ORIGINAL.uidValidity,
      messages: [{ uid: 91, messageId: "different@example.test", flags: ["\\Seen"] }, ORIGINAL.messages[1]!],
    });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.errors.join(" ")).toMatch(/All Mail.*original@example\.test.*missing/i);
  });

  it("accepts All Mail churn only when an unchanged concrete projection proves survival", async () => {
    const fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 1143,
      user: "unused",
      pass: "unused",
    });
    const states: Record<string, MockMailboxState> = {
      "All Mail": structuredClone(ORIGINAL),
      Archive: structuredClone(ORIGINAL),
    };
    vi.spyOn(fixture, "listMailboxes").mockResolvedValue(["All Mail", "Archive"]);
    vi.spyOn(fixture, "listCleanupMailboxes").mockResolvedValue(["All Mail", "Archive"]);
    vi.spyOn(
      fixture as unknown as SnapshotFixtureInternals,
      "snapshotMailboxState",
    ).mockImplementation(async (path) => structuredClone(states[path]!));
    const snapshot = await fixture.captureSafetySnapshot();
    states["All Mail"] = {
      uidValidity: "different-virtual-generation",
      messages: [ORIGINAL.messages[1]!],
    };

    const verification = await fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(true);
    expect(verification.errors).toHaveLength(0);
    expect(verification.drift?.join(" ")).toMatch(/All Mail.*original@example\.test.*missing/i);
  });

  it("correlates All Mail churn with the same out-of-scope concrete drift", async () => {
    const fixture = new ImapFixtures({
      host: "127.0.0.1",
      port: 1143,
      user: "unused",
      pass: "unused",
    });
    const states: Record<string, MockMailboxState> = {
      "All Mail": structuredClone(ORIGINAL),
      Spam: structuredClone(ORIGINAL),
    };
    vi.spyOn(fixture, "listMailboxes").mockResolvedValue(["All Mail", "Spam"]);
    vi.spyOn(fixture, "listCleanupMailboxes").mockResolvedValue(["All Mail", "Spam"]);
    vi.spyOn(
      fixture as unknown as SnapshotFixtureInternals,
      "snapshotMailboxState",
    ).mockImplementation(async (path) => structuredClone(states[path]!));
    const snapshot = await fixture.captureSafetySnapshot();
    states["All Mail"] = { ...states["All Mail"]!, messages: [ORIGINAL.messages[1]!] };
    states.Spam = { ...states.Spam!, messages: [ORIGINAL.messages[1]!] };

    const verification = await fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(true);
    expect(verification.errors).toHaveLength(0);
    expect(verification.drift?.join(" ")).toMatch(/All Mail.*Spam.*missing/i);
  });
  it("keeps discrepancies fatal in mailboxes the run could have mutated", async () => {
    // INBOX is always in scope: sends land there.
    const h = baselineFixture(ORIGINAL, "INBOX");
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({ uidValidity: ORIGINAL.uidValidity, messages: [ORIGINAL.messages[1]!] });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.drift ?? []).toHaveLength(0);
  });

  it("keeps All Mail fatal — it is the virtual union of everything the run creates", async () => {
    const h = baselineFixture(ORIGINAL, "All Mail");
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({
      uidValidity: ORIGINAL.uidValidity,
      messages: [{ uid: 91, messageId: "different@example.test", flags: ["\\Seen"] }, ORIGINAL.messages[1]!],
    });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(false);
    expect(verification.drift ?? []).toHaveLength(0);
  });

  it("reports drift instead of failing for a mailbox the run never mutated", async () => {
    // Spam is neither INBOX, nor All Mail, nor created by the run: Proton's own
    // auto-purge moves it, and that is not evidence the suite did anything.
    const h = baselineFixture(ORIGINAL, "Spam");
    const snapshot = await h.fixture.captureSafetySnapshot();
    h.setState({ uidValidity: ORIGINAL.uidValidity, messages: [ORIGINAL.messages[1]!] });

    const verification = await h.fixture.verifySafetySnapshot(snapshot);
    expect(verification.ok).toBe(true);
    expect(verification.errors).toHaveLength(0);
    // Narrowing must never be silent.
    expect(verification.drift?.join(" ")).toMatch(/Spam.*missing/i);
  });
});
