/**
 * Tests for SimpleIMAPService.connect() TLS certificate path handling.
 * Isolated in its own file so that vi.mock('fs') does not bleed into other suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimpleIMAPService } from "./simple-imap-service.js";

// ─── Module-level mocks ──────────────────────────────────────────────────────

vi.mock("imapflow", () => {
  const ImapFlow = vi.fn(function () {
    const listeners = new Map<string, (...args: unknown[]) => void>();
    return {
      connect: vi.fn().mockResolvedValue(undefined),
      logout: vi.fn().mockResolvedValue(undefined),
      list: vi.fn().mockResolvedValue([]),
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        listeners.set(event, listener);
      }),
      emitForTest: (event: string, ...args: unknown[]) => listeners.get(event)?.(...args),
    };
  });
  return { ImapFlow };
});

vi.mock("mailparser", () => ({
  simpleParser: vi.fn(),
}));

// Mock fs — statSync and readFileSync are the only fs calls in connect()
vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("SimpleIMAPService.connect() bridgeCertPath handling", () => {
  let statSync: ReturnType<typeof vi.fn>;
  let readFileSync: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const fs = await import("fs");
    statSync = fs.statSync as ReturnType<typeof vi.fn>;
    readFileSync = fs.readFileSync as ReturnType<typeof vi.fn>;
    statSync.mockReset();
    readFileSync.mockReset();
  });

  describe("with allowInsecureBridge opt-out in effect (env var)", () => {

  it("loads cert from file path when statSync says it is not a directory (lines 315-331)", async () => {
    statSync.mockReturnValue({ isDirectory: () => false });
    readFileSync.mockReturnValue(Buffer.from("CERT_DATA"));

    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");

    expect(readFileSync).toHaveBeenCalledWith("/path/to/cert.pem");
    expect((svc as any).insecureTls).toBeFalsy(); // cert loaded → TLS is verified
    expect((svc as any).isConnected).toBe(true);
  });

  it("Cluster-2 leak: a reconnect tears down the previous client before creating a new one", async () => {
    statSync.mockReturnValue({ isDirectory: () => false });
    readFileSync.mockReturnValue(Buffer.from("CERT_DATA"));
    const { ImapFlow } = await import("imapflow");
    const ctor = ImapFlow as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");
    const first = ctor.mock.results[0].value as { logout: ReturnType<typeof vi.fn> };
    expect(first.logout).not.toHaveBeenCalled(); // first connect: nothing to reap

    // Reconnecting must logout() the stale client so its socket isn't orphaned.
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");
    expect(first.logout).toHaveBeenCalledTimes(1);
    expect(ctor.mock.results.length).toBe(2); // a fresh client was created after reaping
  });

  it("ignores delayed close/error events from a retired client after replacement connects", async () => {
    statSync.mockReturnValue({ isDirectory: () => false });
    readFileSync.mockReturnValue(Buffer.from("CERT_DATA"));
    const { ImapFlow } = await import("imapflow");
    const ctor = ImapFlow as unknown as ReturnType<typeof vi.fn>;
    ctor.mockClear();

    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");
    const first = ctor.mock.results[0].value as { emitForTest: (event: string, ...args: unknown[]) => void };
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");
    const second = ctor.mock.results[1].value;
    expect((svc as any).client).toBe(second);
    expect(svc.isActive()).toBe(true);

    first.emitForTest("close");
    first.emitForTest("error", new Error("retired socket"));

    expect((svc as any).client).toBe(second);
    expect(svc.isActive()).toBe(true);
  });

  it("resolves cert.pem inside a directory when statSync says it is a directory (lines 317-319)", async () => {
    statSync.mockReturnValue({ isDirectory: () => true });
    readFileSync.mockReturnValue(Buffer.from("CERT_DATA"));

    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass", "/path/to/dir");

    // Should have read cert.pem inside the directory
    expect(readFileSync).toHaveBeenCalledWith(
      expect.stringContaining("cert.pem")
    );
  });

  it("falls back to insecure TLS when readFileSync throws (lines 332-340)", async () => {
    statSync.mockReturnValue({ isDirectory: () => false });
    readFileSync.mockImplementation(() => { throw new Error("ENOENT: no such file"); });

    const svc = new SimpleIMAPService();
    await svc.connect("localhost", 1143, "user", "pass", "/bad/cert.pem");

    expect((svc as any).insecureTls).toBe(true);
    expect((svc as any).isConnected).toBe(true);
  });

  it("falls back to insecure TLS when statSync throws (stat-fail path, line 321)", async () => {
    statSync.mockImplementation(() => { throw new Error("ENOENT"); });
    readFileSync.mockReturnValue(Buffer.from("CERT_DATA"));

    const svc = new SimpleIMAPService();
    // statSync failure is swallowed; readFileSync is tried with original path
    await svc.connect("localhost", 1143, "user", "pass", "/path/cert.pem");

    expect(readFileSync).toHaveBeenCalledWith("/path/cert.pem");
  });
  }); // end "with allowInsecureBridge opt-out"

  describe("strict mode (no allowInsecureBridge opt-in)", () => {
    // Tests in this block run with the env var temporarily cleared so that
    // the strict default (throw when no cert or cert load fails) is exercised.
    let prev: string | undefined;
    beforeEach(() => {
      prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
      delete process.env.MAILPOUCH_INSECURE_BRIDGE;
    });
    afterEach(() => {
      if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
      else delete process.env.MAILPOUCH_INSECURE_BRIDGE;
    });

    it("throws when localhost and no cert path is configured", async () => {
      const svc = new SimpleIMAPService();
      await expect(svc.connect("localhost", 1143, "user", "pass")).rejects.toThrow(
        /No Bridge certificate configured/
      );
      expect((svc as any).isConnected).toBe(false);
    });

    it("throws when cert path is configured but readFileSync fails", async () => {
      statSync.mockReturnValue({ isDirectory: () => false });
      readFileSync.mockImplementation(() => { throw new Error("ENOENT: no such file"); });

      const svc = new SimpleIMAPService();
      await expect(
        svc.connect("localhost", 1143, "user", "pass", "/bad/cert.pem")
      ).rejects.toThrow(/could not be loaded and allowInsecureBridge is not set/);
      expect((svc as any).isConnected).toBe(false);
    });

    it("connects successfully when cert loads cleanly (strict default)", async () => {
      statSync.mockReturnValue({ isDirectory: () => false });
      readFileSync.mockReturnValue(Buffer.from("CERT_DATA"));

      const svc = new SimpleIMAPService();
      await svc.connect("localhost", 1143, "user", "pass", "/path/to/cert.pem");

      expect((svc as any).insecureTls).toBeFalsy();
      expect((svc as any).isConnected).toBe(true);
    });

    it("respects allowInsecureBridge=true passed as explicit parameter", async () => {
      const svc = new SimpleIMAPService();
      // No cert + explicit opt-in via parameter → falls back to insecure, does not throw
      await svc.connect("localhost", 1143, "user", "pass", undefined, undefined, true);
      expect((svc as any).insecureTls).toBe(true);
      expect((svc as any).isConnected).toBe(true);
    });
  });
});
