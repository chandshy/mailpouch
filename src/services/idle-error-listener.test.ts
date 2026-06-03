/**
 * Regression: the IMAP IDLE client MUST attach an 'error' listener.
 *
 * imapflow extends EventEmitter. When the IDLE socket to Bridge resets
 * (routine: Bridge sleep/restart/session caps), imapflow emits 'error'. An
 * EventEmitter that emits 'error' with NO listener throws synchronously →
 * `process.on("uncaughtException")` → gracefulShutdown → the whole process
 * exits. That was a recurring "mailpouch keeps crashing." The reconnect loop
 * recovers from drops on its own; the listener only needs to exist so the
 * async socket error is handled rather than thrown.
 *
 * Isolated file so its vi.mock('imapflow') does not bleed into other suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Each constructed client records its event registrations so the test can
// assert which events the IDLE client subscribed to.
const constructed: Array<{ events: Set<string>; on: ReturnType<typeof vi.fn> }> = [];

vi.mock("imapflow", () => {
  const ImapFlow = vi.fn(function () {
    const events = new Set<string>();
    const on = vi.fn((evt: string) => { events.add(evt); });
    const client = {
      on,
      events,
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      list: vi.fn().mockResolvedValue([]),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      // idle() resolves immediately; the loop then sleeps on its backoff,
      // which gives the test a window to inspect the listeners before stopping.
      idle: vi.fn().mockResolvedValue(undefined),
      mailbox: { exists: 0 },
    };
    constructed.push({ events, on });
    return client;
  });
  return { ImapFlow };
});

vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));
vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return { ...original, statSync: vi.fn(() => ({ isDirectory: () => false })), readFileSync: vi.fn(() => Buffer.from("CERT")) };
});

import { SimpleIMAPService } from "./simple-imap-service.js";

describe("IDLE client error-listener (uncaughtException-crash regression)", () => {
  let prev: string | undefined;
  beforeEach(() => {
    constructed.length = 0;
    prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
    process.env.MAILPOUCH_INSECURE_BRIDGE = "1";
  });
  afterEach(() => {
    if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
    else delete process.env.MAILPOUCH_INSECURE_BRIDGE;
  });

  it("attaches an 'error' listener to the IDLE client so a socket error can't crash the process", async () => {
    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");
    const afterConnect = constructed.length; // main client(s) created during connect()

    void svc.startIdle();

    // Wait for the IDLE loop to construct its client and register listeners.
    await vi.waitFor(() => {
      const idle = constructed[afterConnect];
      expect(idle, "IDLE client was not constructed").toBeTruthy();
      expect(idle.events.has("error")).toBe(true);
    }, { timeout: 3000, interval: 10 });

    const idle = constructed[afterConnect];
    // 'error' is the crash-preventing one; 'close' is also expected for parity.
    expect(idle.events.has("error")).toBe(true);
    expect(idle.events.has("close")).toBe(true);

    svc.stopIdle();
  });
});
