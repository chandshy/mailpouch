import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentGrantStore } from "./grant-store.js";
import { GrantManager } from "./grant-manager.js";
import { rmSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

function tmpPath(): string {
  return join(tmpdir(), `pm-bridge-grant-mgr-${randomBytes(6).toString("hex")}.json`);
}

describe("GrantManager.check", () => {
  let path: string;
  let store: AgentGrantStore;
  let mgr: GrantManager;

  beforeEach(() => {
    path = tmpPath();
    store = new AgentGrantStore(path);
    mgr = new GrantManager(store);
  });

  afterEach(() => { if (existsSync(path)) rmSync(path, { force: true }); });

  it("denies when no grant exists", () => {
    const r = mgr.check({ clientId: "pmc_unknown", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no grant registered/i);
  });

  it("denies a pending grant with a clear message", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/pending user approval/i);
  });

  it("denies a revoked grant", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.deny("pmc_1");
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/revoked/i);
  });

  it("allows an active grant for a tool inside the effective preset", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full" });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(true);
    expect(r.effectivePreset).toBe("full");
  });

  it("intersects grant preset with global preset (global wins when stricter)", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({ clientId: "pmc_1", preset: "full" });
    // Global preset is read_only — delete_email is not in read_only.
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "read_only" });
    expect(r.allowed).toBe(false);
  });

  it("honors explicit tool allow override even when preset would deny", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      toolOverrides: { send_email: true },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "send_email", globalPreset: "full" });
    expect(r.allowed).toBe(true);
  });

  it("refuses a tool allow override when the global preset does not permit the tool", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      toolOverrides: { delete_email: true },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "read_only" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/global preset/i);
  });

  it("honors explicit tool deny override even when preset would allow", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "full",
      toolOverrides: { delete_email: false },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "delete_email", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/explicitly denied/i);
  });

  it("auto-expires a grant whose expiresAt has passed", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { expiresAt: new Date(Date.now() - 1_000).toISOString() },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full" });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/expired/i);
    expect(store.get("pmc_1")?.status).toBe("expired");
  });

  it("honors IP pins: allow matching, deny mismatched", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { ipPins: ["10.0.0.5"] },
    });
    expect(
      mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full", callerIp: "10.0.0.5" }).allowed,
    ).toBe(true);
    expect(
      mgr.check({ clientId: "pmc_1", tool: "get_emails", globalPreset: "full", callerIp: "10.0.0.6" }).allowed,
    ).toBe(false);
  });

  it("enforces folderAllowlist against the call's folder arg", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { folderAllowlist: ["INBOX", "Sent"] },
    });
    expect(
      mgr.check({
        clientId: "pmc_1", tool: "get_emails", globalPreset: "full",
        args: { folder: "INBOX" },
      }).allowed,
    ).toBe(true);
    expect(
      mgr.check({
        clientId: "pmc_1", tool: "get_emails", globalPreset: "full",
        args: { folder: "Secret" },
      }).allowed,
    ).toBe(false);
  });

  it("skips folder check when the call has no folder-like arg (tool not folder-scoped)", () => {
    store.createPending({ clientId: "pmc_1", clientName: "A" });
    store.approve({
      clientId: "pmc_1",
      preset: "read_only",
      conditions: { folderAllowlist: ["INBOX"] },
    });
    const r = mgr.check({ clientId: "pmc_1", tool: "get_connection_status", globalPreset: "full" });
    expect(r.allowed).toBe(true);
  });
});
