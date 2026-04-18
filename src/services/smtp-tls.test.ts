/**
 * Tests for SMTPService TLS hardening — strict default + allowInsecureBridge opt-in.
 * Isolated from other SMTP tests so vi.mock('fs') does not bleed across suites.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SMTPService } from "./smtp-service.js";
import type { ProtonMailConfig } from "../types/index.js";

vi.mock("nodemailer", () => ({
  default: {
    createTransport: vi.fn(() => ({
      verify: vi.fn().mockResolvedValue(true),
      sendMail: vi.fn(),
      close: vi.fn(),
    })),
  },
}));

vi.mock("fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("fs")>();
  return {
    ...original,
    statSync: vi.fn(),
    readFileSync: vi.fn(),
  };
});

function baseConfig(overrides: Partial<ProtonMailConfig["smtp"]> = {}): ProtonMailConfig {
  return {
    smtp: {
      host: "127.0.0.1",
      port: 1025,
      secure: false,
      username: "user@example.com",
      password: "bridge-pass",
      ...overrides,
    },
    imap: {
      host: "127.0.0.1",
      port: 1143,
      secure: false,
      username: "user@example.com",
      password: "bridge-pass",
    },
  };
}

describe("SMTPService TLS strict mode (no allowInsecureBridge)", () => {
  const ENV_KEYS = ["MAILPOUCH_INSECURE_BRIDGE", "PM_BRIDGE_MCP_INSECURE_BRIDGE", "PROTONMAIL_MCP_INSECURE_BRIDGE"] as const;
  let prev: Record<string, string | undefined> = {};

  beforeEach(() => {
    prev = {};
    for (const k of ENV_KEYS) { prev[k] = process.env[k]; delete process.env[k]; }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (prev[k] !== undefined) process.env[k] = prev[k];
      else delete process.env[k];
    }
  });

  it("throws when localhost has credentials but no cert path and no opt-in", () => {
    expect(() => new SMTPService(baseConfig())).toThrow(/No Bridge certificate configured/);
  });

  it("throws when cert path is configured but the file cannot be loaded", async () => {
    const fs = await import("fs");
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => false });
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    expect(() => new SMTPService(baseConfig({ bridgeCertPath: "/bad/cert.pem" }))).toThrow(
      /could not be loaded and allowInsecureBridge is not set/
    );
  });

  it("pre-config constructor (no username yet) does not throw even without cert", () => {
    // Mirrors the module-load-time construction before main() populates config.
    const cfg = baseConfig({ username: "", password: "" });
    expect(() => new SMTPService(cfg)).not.toThrow();
  });

  it("connects when cert loads cleanly (strict default)", async () => {
    const fs = await import("fs");
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => false });
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from("CERT"));

    const svc = new SMTPService(baseConfig({ bridgeCertPath: "/ok/cert.pem" }));
    expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(false);
  });

  it("resolves cert.pem inside a directory when bridgeCertPath points to a folder", async () => {
    const fs = await import("fs");
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => true });
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockReturnValue(Buffer.from("CERT"));

    const svc = new SMTPService(baseConfig({ bridgeCertPath: "/bridge/data" }));
    expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(false);
    expect((fs.readFileSync as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.stringContaining("cert.pem")
    );
  });

  it("uses full TLS validation (no cert wrangling) for non-localhost SMTP hosts", () => {
    const svc = new SMTPService(baseConfig({ host: "smtp.protonmail.ch", port: 587, smtpToken: "tok" }));
    // Non-localhost never enters the bridge-cert branch; insecureTls must stay false.
    expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(false);
  });
});

describe("SMTPService TLS insecure opt-in", () => {
  it("runs in insecure mode when allowInsecureBridge is set in config", () => {
    const svc = new SMTPService(baseConfig({ allowInsecureBridge: true }));
    expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(true);
  });

  it("runs in insecure mode when MAILPOUCH_INSECURE_BRIDGE=1 is set in env", () => {
    const prev = process.env.MAILPOUCH_INSECURE_BRIDGE;
    process.env.MAILPOUCH_INSECURE_BRIDGE = "1";
    try {
      const svc = new SMTPService(baseConfig());
      expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(true);
    } finally {
      if (prev !== undefined) process.env.MAILPOUCH_INSECURE_BRIDGE = prev;
      else delete process.env.MAILPOUCH_INSECURE_BRIDGE;
    }
  });

  it("still honors legacy PROTONMAIL_MCP_INSECURE_BRIDGE=1 as an env alias", () => {
    const prev = process.env.PROTONMAIL_MCP_INSECURE_BRIDGE;
    process.env.PROTONMAIL_MCP_INSECURE_BRIDGE = "1";
    try {
      const svc = new SMTPService(baseConfig());
      expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(true);
    } finally {
      if (prev !== undefined) process.env.PROTONMAIL_MCP_INSECURE_BRIDGE = prev;
      else delete process.env.PROTONMAIL_MCP_INSECURE_BRIDGE;
    }
  });

  it("falls back to insecure mode when cert fails to load and allowInsecureBridge is set", async () => {
    const fs = await import("fs");
    (fs.statSync as ReturnType<typeof vi.fn>).mockReturnValue({ isDirectory: () => false });
    (fs.readFileSync as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error("ENOENT");
    });

    const svc = new SMTPService(baseConfig({ bridgeCertPath: "/bad/cert.pem", allowInsecureBridge: true }));
    expect((svc as unknown as { insecureTls: boolean }).insecureTls).toBe(true);
  });
});
