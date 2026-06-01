import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentGrantStore } from "./grant-store.js";
import { rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

function tmpPath(): string {
  return join(tmpdir(), `mailpouch-agents-${randomBytes(6).toString("hex")}.json`);
}

describe("AgentGrantStore", () => {
  let path: string;

  beforeEach(() => { path = tmpPath(); });
  afterEach(() => { if (existsSync(path)) rmSync(path, { force: true }); });

  it("starts empty when no file exists", () => {
    const s = new AgentGrantStore(path);
    expect(s.list()).toEqual([]);
  });

  it("createPending seeds a pending grant and persists it", () => {
    const s1 = new AgentGrantStore(path);
    const g = s1.createPending({ clientId: "pmc_1", clientName: "Claude Desktop" });
    expect(g.status).toBe("pending");
    expect(g.totalCalls).toBe(0);

    const s2 = new AgentGrantStore(path);
    expect(s2.get("pmc_1")?.status).toBe("pending");
  });

  it("createPending records and persists the registering IP for the approval card", () => {
    const s1 = new AgentGrantStore(path);
    const g = s1.createPending({ clientId: "pmc_ip", clientName: "Remote Agent", registeredFromIp: "192.168.1.50" });
    expect(g.registeredFromIp).toBe("192.168.1.50");
    const s2 = new AgentGrantStore(path);
    expect(s2.get("pmc_ip")?.registeredFromIp).toBe("192.168.1.50");
  });

  it("a peer's status change is not reverted by a later local mutation (reloadMerge refresh)", () => {
    // Two store instances over the same file (two processes). B holds a stale
    // `pending` copy; A approves the grant; then B mutates an UNRELATED grant.
    // Before the fix, B's whole-file persist() rewrote pmc_1 as pending again.
    const a = new AgentGrantStore(path);
    const b = new AgentGrantStore(path);
    a.createPending({ clientId: "pmc_1", clientName: "X" });
    b.createPending({ clientId: "pmc_2", clientName: "Y" }); // B now has pmc_1=pending in memory too
    a.approve({ clientId: "pmc_1", preset: "supervised" });  // A: pmc_1 -> active on disk
    b.approve({ clientId: "pmc_2", preset: "read_only" });   // B mutates -> reload+persist

    const fresh = new AgentGrantStore(path);
    expect(fresh.get("pmc_1")?.status).toBe("active");        // A's change survives
    expect(fresh.get("pmc_2")?.status).toBe("active");
  });

  it("flushCounters preserves local call counts without reverting a peer's status change", () => {
    const a = new AgentGrantStore(path);
    const b = new AgentGrantStore(path);
    a.createPending({ clientId: "pmc_1", clientName: "X" });
    b.get("pmc_1");                      // B doesn't know pmc_1 yet; load it
    const b2 = new AgentGrantStore(path); // B-process view that has pmc_1 loaded
    b2.recordCall("pmc_1");              // local counter bump, unflushed
    a.approve({ clientId: "pmc_1", preset: "full" }); // peer flips status on disk
    b2.flushCounters();                  // must not revert status to pending

    const fresh = new AgentGrantStore(path);
    expect(fresh.get("pmc_1")?.status).toBe("active");
    expect(fresh.get("pmc_1")?.totalCalls).toBe(1); // local increment preserved
  });

  it("createPending is idempotent for the same clientId", () => {
    const s = new AgentGrantStore(path);
    const a = s.createPending({ clientId: "pmc_1", clientName: "A" });
    const b = s.createPending({ clientId: "pmc_1", clientName: "Different Name" });
    expect(b.clientId).toBe(a.clientId);
    expect(b.clientName).toBe("A");                 // original record preserved
    expect(s.list()).toHaveLength(1);
  });

  it("approve flips a pending grant to active and records preset + conditions", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "C" });
    const g = s.approve({
      clientId: "pmc_1",
      preset: "supervised",
      conditions: { expiresAt: "2026-12-31T00:00:00Z", folderAllowlist: ["INBOX"] },
      note: "approved for testing",
    });
    expect(g?.status).toBe("active");
    expect(g?.preset).toBe("supervised");
    expect(g?.conditions?.folderAllowlist).toEqual(["INBOX"]);
    expect(g?.approvedAt).toBeTruthy();
    expect(g?.note).toBe("approved for testing");
  });

  it("approve returns null for an unknown clientId", () => {
    const s = new AgentGrantStore(path);
    expect(s.approve({ clientId: "pmc_missing", preset: "read_only" })).toBeNull();
  });

  it("deny / revoke set status to revoked and persist", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "C" });
    const g = s.deny("pmc_1", "user rejected");
    expect(g?.status).toBe("revoked");
    expect(g?.revokedAt).toBeTruthy();

    // Reload and re-check
    const s2 = new AgentGrantStore(path);
    expect(s2.get("pmc_1")?.status).toBe("revoked");
  });

  it("markExpired flips an active grant without double-persisting", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "C" });
    s.approve({ clientId: "pmc_1", preset: "read_only" });
    s.markExpired("pmc_1");
    expect(s.get("pmc_1")?.status).toBe("expired");
    // Calling again is a no-op.
    expect(s.markExpired("pmc_1")?.status).toBe("expired");
  });

  it("list with status filter returns only matching grants", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "A" });
    s.createPending({ clientId: "pmc_2", clientName: "B" });
    s.approve({ clientId: "pmc_2", preset: "supervised" });
    expect(s.list({ status: "pending" }).map(g => g.clientId)).toEqual(["pmc_1"]);
    expect(s.list({ status: "active" }).map(g => g.clientId)).toEqual(["pmc_2"]);
  });

  it("recordCall bumps totalCalls without immediately persisting", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "A" });
    s.approve({ clientId: "pmc_1", preset: "full" });
    s.recordCall("pmc_1");
    s.recordCall("pmc_1");
    expect(s.get("pmc_1")?.totalCalls).toBe(2);
    // In-memory only; disk still has 0 until flushCounters.
    const diskRaw = readFileSync(path, "utf-8");
    expect(diskRaw).toContain('"totalCalls": 0');
    s.flushCounters();
    expect(readFileSync(path, "utf-8")).toContain('"totalCalls": 2');
  });

  it("prune drops revoked/expired grants older than the retention window", () => {
    // TEST-017: anchor "now" and the backdated timestamp to fixed instants and
    // pass the anchor into prune(now) instead of deriving from Date.now() — no
    // wall-clock drift between the backdate and the cutoff calculation.
    const NOW = Date.parse("2026-05-01T00:00:00Z");
    const REVOKED_AT = new Date(NOW - 120 * 86_400_000).toISOString();
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "A" });
    s.deny("pmc_1");
    // Backdate the revoke ON DISK so it falls outside the 30-day window; prune()
    // reloads from disk under the lock (disk is the source of truth), so an
    // in-memory-only edit would be refreshed away before prune evaluates it.
    const raw = JSON.parse(readFileSync(path, "utf-8")) as { grants: { revokedAt?: string }[] };
    raw.grants[0].revokedAt = REVOKED_AT;
    writeFileSync(path, JSON.stringify(raw, null, 2));
    const removed = s.prune(30, NOW);
    expect(removed).toBe(1);
    expect(s.get("pmc_1")).toBeUndefined();
  });

  it("prune leaves pending/active grants untouched regardless of age", () => {
    // TEST-017: fixed anchor, explicit prune(now).
    const NOW = Date.parse("2026-05-01T00:00:00Z");
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "Ancient" });
    const g = s.get("pmc_1")!;
    g.createdAt = new Date(NOW - 365 * 86_400_000).toISOString();
    expect(s.prune(30, NOW)).toBe(0);
    expect(s.get("pmc_1")).toBeDefined();
  });

  it("recovers from a malformed file by starting empty", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(path, "not json", "utf-8");
    const s = new AgentGrantStore(path);
    expect(s.list()).toEqual([]);
  });

  // PERM-006: two store instances over the same file model the MCP server and
  // the settings server. A grant created by one must not be dropped when the
  // other writes — reloadMerge under the lock recovers it before persist.
  it("does not drop a grant another process created when this process mutates", () => {
    const a = new AgentGrantStore(path); // e.g. the MCP server
    const b = new AgentGrantStore(path); // e.g. the settings server
    a.createPending({ clientId: "pmc_a", clientName: "A" });
    // b knows nothing about pmc_a yet (loaded before a's write). When b
    // creates its own grant, the lost-update bug would clobber pmc_a.
    b.createPending({ clientId: "pmc_b", clientName: "B" });
    // A fresh reader sees BOTH grants on disk.
    const reader = new AgentGrantStore(path);
    expect(reader.get("pmc_a")).toBeDefined();
    expect(reader.get("pmc_b")).toBeDefined();
  });
});
