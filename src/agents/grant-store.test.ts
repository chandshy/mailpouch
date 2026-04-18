import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentGrantStore } from "./grant-store.js";
import { rmSync, existsSync, readFileSync } from "fs";
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
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "A" });
    s.deny("pmc_1");
    // Backdate the revoke so it falls outside the 30-day window.
    const g = s.get("pmc_1")!;
    g.revokedAt = new Date(Date.now() - 120 * 86_400_000).toISOString();
    const removed = s.prune(30);
    expect(removed).toBe(1);
    expect(s.get("pmc_1")).toBeUndefined();
  });

  it("prune leaves pending/active grants untouched regardless of age", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_1", clientName: "Ancient" });
    const g = s.get("pmc_1")!;
    g.createdAt = new Date(Date.now() - 365 * 86_400_000).toISOString();
    expect(s.prune(30)).toBe(0);
    expect(s.get("pmc_1")).toBeDefined();
  });

  it("recovers from a malformed file by starting empty", async () => {
    const { writeFileSync } = await import("fs");
    writeFileSync(path, "not json", "utf-8");
    const s = new AgentGrantStore(path);
    expect(s.list()).toEqual([]);
  });
});
