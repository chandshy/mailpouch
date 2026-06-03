/**
 * Tests the IDLE reconnect POLICY (the user's requirement):
 *   • a login/credential failure → surface a warning and STOP retrying
 *     (don't hammer a bad password into Bridge's "too many login attempts").
 *   • any other (transient) failure → keep retrying with backoff, recording
 *     the issue so it can be surfaced.
 *
 * Isolated file so its vi.mock('imapflow') doesn't bleed into other suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// connect() behaviour is toggled per test.
const state: { mode: "auth" | "throttle" | "conn" | "ok" } = { mode: "auth" };

vi.mock("imapflow", () => {
  const ImapFlow = vi.fn(function () {
    return {
      on: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      idle: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockImplementation(() => {
        if (state.mode === "ok") return Promise.resolve();
        if (state.mode === "auth") return Promise.reject(Object.assign(new Error("login"), { authenticationFailed: true }));
        if (state.mode === "throttle") return Promise.reject(Object.assign(new Error("NO too many login attempts"), { responseText: "too many login attempts" }));
        return Promise.reject(Object.assign(new Error("connect ECONNREFUSED"), { code: "ECONNREFUSED" }));
      }),
    };
  });
  return { ImapFlow };
});
vi.mock("mailparser", () => ({ simpleParser: vi.fn() }));

import { SimpleIMAPService } from "./simple-imap-service.js";
import { ConnectionStateError } from "../utils/error-classify.js";
import { ImapFlow } from "imapflow";

function primeConfig(svc: SimpleIMAPService) {
  (svc as unknown as { connectionConfig: unknown }).connectionConfig = {
    host: "localhost", port: 1143, username: "u", password: "p",
    bridgeCertPath: "", secure: false, allowInsecureBridge: true,
  };
}

describe("IDLE reconnect policy", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
    process.env.MAILPOUCH_INSECURE_BRIDGE = "1";
  });
  afterEach(() => {
    if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
    else delete process.env.MAILPOUCH_INSECURE_BRIDGE;
  });

  it("STOPS and surfaces on a credential/login failure (no endless retry)", async () => {
    state.mode = "auth";
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    await svc.startIdle();

    await vi.waitFor(() => {
      expect((svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure).not.toBeNull();
    }, { timeout: 2000, interval: 10 });

    // The loop must have halted — not be looping/retrying.
    expect((svc as unknown as { idleActive: boolean }).idleActive).toBe(false);
    const f = (svc as unknown as { idleAuthFailure: { message: string } }).idleAuthFailure;
    expect(f.message).toMatch(/authentication failed/i);
  });

  it("KEEPS retrying (does not stop) on a transient connection failure, recording the issue", async () => {
    state.mode = "conn";
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    await svc.startIdle();

    await vi.waitFor(() => {
      expect((svc as unknown as { idleLastIssue: unknown }).idleLastIssue).not.toBeNull();
    }, { timeout: 2000, interval: 10 });

    // Transient failure → still active (will retry on backoff), NOT auth-stopped.
    expect((svc as unknown as { idleActive: boolean }).idleActive).toBe(true);
    expect((svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure).toBeNull();

    svc.stopIdle(); // let the backoff sleep unwind
  });

  it("treats 'too many login attempts' as transient (backoff), NOT a permanent stop", async () => {
    state.mode = "throttle";
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    await svc.startIdle();

    await vi.waitFor(() => {
      expect((svc as unknown as { idleLastIssue: unknown }).idleLastIssue).not.toBeNull();
    }, { timeout: 2000, interval: 10 });

    expect((svc as unknown as { idleActive: boolean }).idleActive).toBe(true);
    expect((svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure).toBeNull();

    svc.stopIdle();
  });
});

describe("tool calls get an actionable error when the connection is bad", () => {
  let prev: string | undefined;
  beforeEach(() => {
    prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
    process.env.MAILPOUCH_INSECURE_BRIDGE = "1";
  });
  afterEach(() => {
    if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
    else delete process.env.MAILPOUCH_INSECURE_BRIDGE;
  });

  // ensureConnection is the chokepoint every IMAP tool passes through.
  const ensureConnection = (svc: SimpleIMAPService) =>
    (svc as unknown as { ensureConnection(): Promise<void> }).ensureConnection();

  it("fast-fails with actionable guidance and does NOT re-attempt login when a login failure is recorded", async () => {
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    (svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure = {
      message: "Mail server authentication failed. Check the mailbox credentials in Settings.",
      at: new Date(),
    };
    const ctor = ImapFlow as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    await expect(ensureConnection(svc)).rejects.toBeInstanceOf(ConnectionStateError);
    await expect(ensureConnection(svc)).rejects.toThrow(/Bridge password/i);
    // Crucially: it did NOT open a new connection (no lockout-feeding retry).
    expect(ctor).not.toHaveBeenCalled();
  });

  it("on a reconnect login failure: throws actionable error AND records the failure (so the tray blinks + later calls fast-fail)", async () => {
    state.mode = "auth";
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    await expect(ensureConnection(svc)).rejects.toThrow(/sign in to your Proton mailbox/i);
    expect((svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure).not.toBeNull();
  });

  it("on a reconnect connection failure: actionable 'Bridge not reachable' (does not record an auth failure)", async () => {
    state.mode = "conn";
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    await expect(ensureConnection(svc)).rejects.toThrow(/reach Proton Bridge/i);
    expect((svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure ?? null).toBeNull();
  });
});

describe("reloadCredentials (flush old, load new on a Settings save)", () => {
  let prev: string | undefined;
  beforeEach(() => { prev = process.env.MAILPOUCH_INSECURE_BRIDGE; process.env.MAILPOUCH_INSECURE_BRIDGE = "1"; });
  afterEach(() => {
    if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev; else delete process.env.MAILPOUCH_INSECURE_BRIDGE;
  });

  it("loads the new password into the live config, clears the auth-stop, and reconnects", async () => {
    state.mode = "ok";
    const svc = new SimpleIMAPService();
    primeConfig(svc); // starts with password "p"
    // Simulate a prior login failure that had halted the loop.
    (svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure = { message: "old failure", at: new Date() };

    await svc.reloadCredentials("NEW-PASS");

    expect((svc as unknown as { connectionConfig: { password: string } }).connectionConfig.password).toBe("NEW-PASS");
    expect((svc as unknown as { idleAuthFailure: unknown }).idleAuthFailure).toBeNull();
    expect(svc.isActive()).toBe(true); // reconnected with the new credentials
  });

  it("restarting the IDLE loop bumps the generation guard (no duplicate loops)", async () => {
    state.mode = "ok";
    const svc = new SimpleIMAPService();
    primeConfig(svc);
    await svc.startIdle();
    const gen1 = (svc as unknown as { _idleGen: number })._idleGen;
    await svc.reloadCredentials("NEW-PASS"); // stops + restarts IDLE
    const gen2 = (svc as unknown as { _idleGen: number })._idleGen;
    expect(gen2).toBeGreaterThan(gen1); // a fresh generation claimed; old loop self-exits
    svc.stopIdle();
  });
});
