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
const state: { mode: "auth" | "throttle" | "conn" } = { mode: "auth" };

vi.mock("imapflow", () => {
  const ImapFlow = vi.fn(function () {
    return {
      on: vi.fn(),
      logout: vi.fn().mockResolvedValue(undefined),
      close: vi.fn(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      idle: vi.fn().mockResolvedValue(undefined),
      connect: vi.fn().mockImplementation(() => {
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
