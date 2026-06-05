import { describe, it, expect } from "vitest";
import { computeSetupStatus, type SetupStatusInput } from "./setup-status.js";

function base(overrides: Partial<SetupStatusInput> = {}): SetupStatusInput {
  return {
    configExists: true,
    configPath: "/home/u/.mailpouch.json",
    username: "me@proton.me",
    hasPassword: true,
    credentialStorage: "keychain",
    imap: { host: "127.0.0.1", port: 1143, reachable: true },
    smtp: { host: "127.0.0.1", port: 1025, reachable: true },
    allowInsecureBridge: false,
    bridgeCertConfigured: true,
    settingsPort: 8766,
    ...overrides,
  };
}

describe("computeSetupStatus", () => {
  it("unconfigured when no config file", () => {
    const r = computeSetupStatus(base({ configExists: false, username: "", hasPassword: false }));
    expect(r.state).toBe("unconfigured");
    expect(r.configured).toBe(false);
    expect(r.nextStep).toContain("mailpouch setup");
    expect(r.nextStep).toMatch(/BRIDGE password/);
  });

  it("unconfigured when username missing", () => {
    expect(computeSetupStatus(base({ username: "" })).state).toBe("unconfigured");
  });

  it("unconfigured when password missing", () => {
    expect(computeSetupStatus(base({ hasPassword: false })).state).toBe("unconfigured");
  });

  it("bridge-unreachable when configured but a port is down", () => {
    const r = computeSetupStatus(base({ imap: { host: "127.0.0.1", port: 1143, reachable: false } }));
    expect(r.state).toBe("bridge-unreachable");
    expect(r.bridgeReachable).toBe(false);
    expect(r.nextStep).toMatch(/IMAP 127\.0\.0\.1:1143/);
    expect(r.nextStep).toMatch(/127\.0\.0\.1, not localhost/);
  });

  it("pending-approval when grant is pending and everything else is ready", () => {
    const r = computeSetupStatus(base({ grant: { status: "pending", clientName: "claude" } }));
    expect(r.state).toBe("pending-approval");
    expect(r.nextStep).toMatch(/EXPECTED/);
    expect(r.nextStep).toContain("http://localhost:8766/#/agents");
  });

  it("revoked when grant was revoked or expired", () => {
    expect(computeSetupStatus(base({ grant: { status: "revoked" } })).state).toBe("revoked");
    expect(computeSetupStatus(base({ grant: { status: "expired" } })).state).toBe("revoked");
  });

  it("ready when configured, reachable, and grant active", () => {
    const r = computeSetupStatus(base({ grant: { status: "active" } }));
    expect(r.state).toBe("ready");
    expect(r.nextStep).toContain("get_connection_status");
  });

  it("ready (no grant gate) when grant is undefined", () => {
    expect(computeSetupStatus(base()).state).toBe("ready");
    expect(computeSetupStatus(base()).grantStatus).toBeNull();
  });

  it("flags insecure TLS when allowInsecure and no cert", () => {
    const r = computeSetupStatus(base({ allowInsecureBridge: true, bridgeCertConfigured: false }));
    expect(r.insecureTls).toBe(true);
    expect(r.summary).toMatch(/INSECURE/);
  });

  it("redacts username + config path for a non-active (pending/revoked) caller", () => {
    const r = computeSetupStatus(base({ grant: { status: "pending", clientName: "claude" } }));
    expect(r.username).toBe("***@proton.me");
    expect(r.configPath).toBe("~/.mailpouch.json");
    expect(r.summary).not.toContain("me@proton.me");
    expect(r.summary).not.toContain("/home/u/.mailpouch.json");
  });

  it("redacts the config path even when the config file does not exist yet (first-run leak)", () => {
    const r = computeSetupStatus(base({
      configExists: false,
      username: "",
      hasPassword: false,
      grant: { status: "pending" },
    }));
    // A pending caller on a fresh box must not receive the absolute home path.
    expect(r.configPath).toBe("~/.mailpouch.json");
    expect(r.summary).not.toContain("/home/u/.mailpouch.json");
  });

  it("does NOT redact for an active grant or when there is no grant gate", () => {
    expect(computeSetupStatus(base({ grant: { status: "active" } })).username).toBe("me@proton.me");
    expect(computeSetupStatus(base()).configPath).toBe("/home/u/.mailpouch.json");
  });

  it("reports a corrupt config distinctly (configError) and stays unconfigured", () => {
    const r = computeSetupStatus(base({ configError: true }));
    expect(r.state).toBe("unconfigured");
    expect(r.configured).toBe(false);
    expect(r.nextStep).toMatch(/could not be parsed/);
  });

  it("config gate precedes bridge gate precedes approval gate", () => {
    // Unconfigured wins even if the bridge is also down.
    expect(
      computeSetupStatus(base({ hasPassword: false, imap: { host: "h", port: 1, reachable: false } })).state,
    ).toBe("unconfigured");
    // Bridge-unreachable wins over a pending grant.
    expect(
      computeSetupStatus(base({ smtp: { host: "h", port: 1, reachable: false }, grant: { status: "pending" } })).state,
    ).toBe("bridge-unreachable");
  });
});
