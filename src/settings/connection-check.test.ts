/**
 * Tests for the shared connection check (browser /api/test-connection + TUI).
 *
 * The contract that matters: a port that is OPEN but failing AUTH (e.g. a
 * Bridge 454) must report { reachable: true, authenticated: false } — never a
 * green "reachable". And an unreachable port reports authenticated: null
 * (auth not attempted), not false.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Toggle network behaviour per test via globals the mocks read.
declare global {
  // eslint-disable-next-line no-var
  var __tcpOk: boolean; var __imapAuthOk: boolean; var __smtpAuthOk: boolean; var __imapHang: boolean;
}

vi.mock("net", () => {
  class Socket {
    private h: Record<string, (arg?: unknown) => void> = {};
    setTimeout() { /* noop */ }
    on(ev: string, fn: (arg?: unknown) => void) { this.h[ev] = fn; return this; }
    destroy() { /* noop */ }
    connect() {
      queueMicrotask(() => {
        if (globalThis.__tcpOk) this.h["connect"]?.();
        else this.h["error"]?.(new Error("ECONNREFUSED"));
      });
    }
  }
  return { Socket };
});

vi.mock("imapflow", () => {
  const ImapFlow = vi.fn(function () {
    return {
      connect: () => globalThis.__imapHang
        ? new Promise(() => { /* never settles — simulates Bridge stalling mid-AUTH */ })
        : globalThis.__imapAuthOk
          ? Promise.resolve()
          : Promise.reject(Object.assign(new Error("auth"), { responseText: "AUTHENTICATIONFAILED" })),
      logout: () => Promise.resolve(),
      close: () => { /* noop */ },
    };
  });
  return { ImapFlow };
});

vi.mock("nodemailer", () => ({
  default: {
    createTransport: () => ({
      verify: () => globalThis.__smtpAuthOk
        ? Promise.resolve(true)
        : Promise.reject(Object.assign(new Error("Invalid login"), { responseCode: 454, response: "454 4.7.0 invalid username or password" })),
      close: () => { /* noop */ },
    }),
  },
}));

import { probeImap, probeSmtp, isAllowedProbeHost } from "./connection-check.js";

beforeEach(() => {
  globalThis.__tcpOk = true;
  globalThis.__imapAuthOk = true;
  globalThis.__smtpAuthOk = true;
  globalThis.__imapHang = false;
});

describe("probeImap", () => {
  it("unreachable port → reachable:false, authenticated NOT attempted (null)", async () => {
    globalThis.__tcpOk = false;
    const r = await probeImap("localhost", 1143, "u", "p", "", true);
    expect(r).toEqual({ reachable: false, authenticated: null, error: null });
  });

  it("port open + auth OK → connected", async () => {
    const r = await probeImap("localhost", 1143, "u", "p", "", true);
    expect(r.reachable).toBe(true);
    expect(r.authenticated).toBe(true);
  });

  it("port open + auth FAILS (the 454 case) → reachable:true but authenticated:false, never green", async () => {
    globalThis.__imapAuthOk = false;
    const r = await probeImap("localhost", 1143, "u", "p", "", true);
    expect(r.reachable).toBe(true);
    expect(r.authenticated).toBe(false);
    expect(r.error).toContain("AUTHENTICATIONFAILED");
  });

  it("no credentials → reachable:true, authenticated null (not tested)", async () => {
    const r = await probeImap("localhost", 1143, "", "", "", true);
    expect(r.reachable).toBe(true);
    expect(r.authenticated).toBeNull();
    expect(r.error).toMatch(/no credentials/i);
  });

  it("auth stalls forever → bounded by the hard timeout, returns authenticated:false (never hangs)", async () => {
    globalThis.__imapHang = true;
    const t = Date.now();
    const r = await probeImap("localhost", 1143, "u", "p", "", true, 60); // 60ms cap
    expect(Date.now() - t).toBeLessThan(2000);
    expect(r.reachable).toBe(true);
    expect(r.authenticated).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  });
});

describe("probeSmtp", () => {
  it("unreachable → reachable:false, authenticated null", async () => {
    globalThis.__tcpOk = false;
    const r = await probeSmtp("localhost", 1025, "u", "p", "", true);
    expect(r).toEqual({ reachable: false, authenticated: null, error: null });
  });

  it("port open + auth OK → connected", async () => {
    const r = await probeSmtp("localhost", 1025, "u", "p", "", true);
    expect(r.reachable).toBe(true);
    expect(r.authenticated).toBe(true);
  });

  it("port open + 454 auth failure → authenticated:false with the 454 surfaced", async () => {
    globalThis.__smtpAuthOk = false;
    const r = await probeSmtp("localhost", 1025, "u", "p", "", true);
    expect(r.reachable).toBe(true);
    expect(r.authenticated).toBe(false);
    expect(r.error).toContain("454");
  });
});

describe("SSRF guard — connection probes only target localhost / private LAN", () => {
  it("allows localhost and RFC1918 private-LAN hosts", () => {
    for (const h of ["localhost", "127.0.0.1", "::1", "192.168.1.178", "10.0.0.5", "172.16.0.1", "172.31.255.254"]) {
      expect(isAllowedProbeHost(h)).toBe(true);
    }
  });
  it("blocks public hosts, names, and the link-local cloud-metadata range", () => {
    for (const h of ["169.254.169.254", "8.8.8.8", "evil.example.com", "metadata.google.internal", "172.32.0.1", "11.0.0.1", "", 123 as unknown as string]) {
      expect(isAllowedProbeHost(h)).toBe(false);
    }
  });
  it("probeImap/probeSmtp refuse a disallowed host without attempting a connection", async () => {
    const im = await probeImap("169.254.169.254", 1143, "u", "p", "", true);
    const sm = await probeSmtp("8.8.8.8", 25, "u", "p", "", true);
    expect(im).toEqual({ reachable: false, authenticated: null, error: "host not permitted (must be localhost or private LAN)" });
    expect(sm.reachable).toBe(false);
    expect(sm.authenticated).toBe(null);
  });
});
