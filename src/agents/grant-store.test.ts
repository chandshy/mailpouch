import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentGrantStore, hourlyQuotaPathForGrantPath } from "./grant-store.js";
import { notifications } from "./notifications.js";
import { rmSync, existsSync, readFileSync, writeFileSync, statSync, mkdtempSync, symlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

function tmpPath(): string {
  return join(tmpdir(), `mailpouch-agents-${randomBytes(6).toString("hex")}.json`);
}

function removeStoreFiles(storePath: string): void {
  for (const suffix of ["", ".quota.sqlite", ".quota.sqlite-wal", ".quota.sqlite-shm", ".quota.sqlite-journal"]) {
    if (existsSync(storePath + suffix)) rmSync(storePath + suffix, { force: true });
  }
}

describe("AgentGrantStore", () => {
  let path: string;

  beforeEach(() => { path = tmpPath(); });
  afterEach(() => removeStoreFiles(path));

  it("starts empty when no file exists", () => {
    const s = new AgentGrantStore(path);
    expect(s.list()).toEqual([]);
    expect(s.getAuthorizationSnapshot("pmc_missing")).toEqual({ kind: "missing" });
  });

  it("reads a fresh authorization snapshot after another store revokes a grant", () => {
    const writer = new AgentGrantStore(path);
    writer.createPending({ clientId: "pmc_1", clientName: "A" });
    writer.approve({ clientId: "pmc_1", preset: "full" });
    const staleReader = new AgentGrantStore(path);
    try {
      expect(staleReader.get("pmc_1")?.status).toBe("active");
      writer.revoke("pmc_1");
      // The UI/cache accessor is intentionally stale; authorization must not
      // use it when another process changes the durable grant file.
      expect(staleReader.get("pmc_1")?.status).toBe("active");
      expect(staleReader.getAuthorizationSnapshot("pmc_1")).toMatchObject({
        kind: "present",
        grant: { status: "revoked" },
      });
    } finally {
      writer.close();
      staleReader.close();
    }
  });

  it("reports malformed durable grants as unavailable instead of missing", () => {
    writeFileSync(path, "{ definitely not JSON", "utf-8");
    const s = new AgentGrantStore(path);
    try {
      expect(s.getAuthorizationSnapshot("pmc_1")).toEqual({ kind: "unavailable" });
    } finally {
      s.close();
    }
  });

  it("treats non-ENOENT grant-file read failures as unavailable, not missing", () => {
    // readFileSync on a directory fails with EISDIR. This is portable enough
    // to exercise the security-relevant distinction without relying on
    // chmod, which privileged test runners can bypass.
    const directoryPath = mkdtempSync(join(tmpdir(), "mailpouch-agents-directory-"));
    const s = new AgentGrantStore(directoryPath);
    try {
      expect(s.getAuthorizationSnapshot("pmc_1")).toEqual({ kind: "unavailable" });
    } finally {
      s.close();
      rmSync(directoryPath, { recursive: true, force: true });
      for (const suffix of [".quota.sqlite", ".quota.sqlite-wal", ".quota.sqlite-shm", ".quota.sqlite-journal"]) {
        rmSync(directoryPath + suffix, { force: true });
      }
    }
  });

  it("treats duplicate durable client IDs as an unavailable authorization snapshot", () => {
    const grant = {
      clientId: "pmc_1",
      clientName: "A",
      status: "active",
      preset: "full",
      createdAt: "2026-01-01T00:00:00.000Z",
      totalCalls: 0,
    };
    writeFileSync(path, JSON.stringify({ version: 1, grants: [grant, { ...grant, status: "revoked" }] }), "utf-8");
    const s = new AgentGrantStore(path);
    try {
      expect(s.getAuthorizationSnapshot("pmc_1")).toEqual({ kind: "unavailable" });
    } finally {
      s.close();
    }
  });

  it("ensureActiveServiceGrant notifies once on create, NOT on every re-verify (no toast spam)", () => {
    const s = new AgentGrantStore(path);
    const kinds: string[] = [];
    const unsub = notifications.subscribe((ev) => kinds.push(ev.kind));
    try {
      const args = { clientId: "pmc_cc", clientName: "cowork", preset: "full" as const };
      s.ensureActiveServiceGrant(args); // first login → created
      s.ensureActiveServiceGrant(args); // client_credentials re-auth → no-op, silent
      s.ensureActiveServiceGrant(args); // again → still silent
      expect(kinds).toEqual(["grant-created"]);
      expect(s.get("pmc_cc")?.status).toBe("active");
    } finally { unsub(); }
  });

  it("ensureActiveServiceGrant preserves call counters across client_credentials re-auth", () => {
    const s = new AgentGrantStore(path);
    const args = { clientId: "pmc_cnt", clientName: "cron", preset: "full" as const };
    s.ensureActiveServiceGrant(args);
    s.recordCall("pmc_cnt");
    const afterCall = s.get("pmc_cnt");
    expect(afterCall?.lastCallAt).toBeDefined();
    s.ensureActiveServiceGrant(args); // re-auth must not reset "last used" to never
    expect(s.get("pmc_cnt")?.lastCallAt).toBe(afterCall?.lastCallAt);
    expect(s.get("pmc_cnt")?.totalCalls).toBe(1);
  });

  it("ensureActiveServiceGrant re-activating a non-active grant DOES notify (grant-approved)", () => {
    const s = new AgentGrantStore(path);
    s.createPending({ clientId: "pmc_cc2", clientName: "cowork" }); // pending, not active
    const kinds: string[] = [];
    const unsub = notifications.subscribe((ev) => kinds.push(ev.kind));
    try {
      s.ensureActiveServiceGrant({ clientId: "pmc_cc2", clientName: "cowork", preset: "full" });
      expect(kinds).toEqual(["grant-approved"]); // real transition pending→active
    } finally { unsub(); }
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

  it("recordConnection stores the MCP handshake info on an existing grant and persists it", () => {
    const s1 = new AgentGrantStore(path);
    s1.createPending({ clientId: "pmc_h", clientName: "DCR Name" });
    const updated = s1.recordConnection("pmc_h", {
      mcpClientName: "claude-ai", mcpClientVersion: "1.2.3", transport: "http", registeredFromIp: "10.0.0.9",
    });
    expect(updated?.mcpClientName).toBe("claude-ai");
    expect(updated?.mcpClientVersion).toBe("1.2.3");
    expect(updated?.transport).toBe("http");
    expect(updated?.lastConnectedAt).toBeTruthy();
    expect(updated?.status).toBe("pending"); // unchanged — display only
    const s2 = new AgentGrantStore(path);
    expect(s2.get("pmc_h")?.mcpClientName).toBe("claude-ai");
    expect(s2.get("pmc_h")?.lastConnectedAt).toBeTruthy();
  });

  it("recordConnection is a no-op for an unknown clientId", () => {
    const s = new AgentGrantStore(path);
    expect(s.recordConnection("pmc_missing", { mcpClientName: "x" })).toBeNull();
    expect(s.get("pmc_missing")).toBeUndefined();
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

  it("uses a strict rolling one-hour window for tool-call reservations", () => {
    const s = new AgentGrantStore(path);
    const startedAt = Date.parse("2026-07-11T12:00:00.000Z");

    try {
      expect(s.reserveHourlyToolCall("pmc_1", "get_emails", 1, startedAt)).toMatchObject({
        allowed: true,
        used: 1,
      });
      expect(s.reserveHourlyToolCall("pmc_1", "get_emails", 1, startedAt + 3_599_999).allowed).toBe(false);
      // At the exact one-hour boundary, the first call is no longer inside the
      // trailing window and the next call may reserve the slot.
      expect(s.reserveHourlyToolCall("pmc_1", "get_emails", 1, startedAt + 3_600_000)).toMatchObject({
        allowed: true,
        used: 1,
      });
    } finally {
      s.close();
    }
  });

  it("persists a reservation across a fresh AgentGrantStore after restart", () => {
    const startedAt = Date.parse("2026-07-11T12:00:00.000Z");
    const first = new AgentGrantStore(path);
    try {
      expect(first.reserveHourlyToolCall("pmc_1", "get_emails", 1, startedAt).allowed).toBe(true);
    } finally {
      first.close();
    }

    const restarted = new AgentGrantStore(path);
    try {
      expect(restarted.reserveHourlyToolCall("pmc_1", "get_emails", 1, startedAt + 1).allowed).toBe(false);
    } finally {
      restarted.close();
    }
  });

  it("shares one durable quota ledger between separate store instances", () => {
    const now = Date.parse("2026-07-11T12:00:00.000Z");
    const firstDaemon = new AgentGrantStore(path);
    const secondDaemon = new AgentGrantStore(path);
    try {
      expect(firstDaemon.reserveHourlyToolCall("pmc_1", "get_emails", 1, now).allowed).toBe(true);
      // Models two daemons over the same profile when the singleton is
      // intentionally disabled. Their distinct SQLite connections still see
      // one transactionally shared per-client/tool budget.
      expect(secondDaemon.reserveHourlyToolCall("pmc_1", "get_emails", 1, now + 1).allowed).toBe(false);
    } finally {
      firstDaemon.close();
      secondDaemon.close();
    }
  });

  it.runIf(process.platform !== "win32")("shares a quota ledger through grants-file symlink aliases", () => {
    const dir = mkdtempSync(join(tmpdir(), "mailpouch-quota-alias-"));
    const realGrantPath = join(dir, "real-grants.json");
    const aliasGrantPath = join(dir, "alias-grants.json");
    const firstDaemon = new AgentGrantStore(realGrantPath);
    let aliasDaemon: AgentGrantStore | undefined;
    try {
      // Materialize the target before making its file alias, mirroring an
      // existing MAILPOUCH_AGENTS override reached through a symlink.
      firstDaemon.createPending({ clientId: "pmc_1", clientName: "A" });
      symlinkSync(realGrantPath, aliasGrantPath);
      aliasDaemon = new AgentGrantStore(aliasGrantPath);
      expect(hourlyQuotaPathForGrantPath(aliasGrantPath)).toBe(hourlyQuotaPathForGrantPath(realGrantPath));

      const now = Date.parse("2026-07-11T12:00:00.000Z");
      expect(firstDaemon.reserveHourlyToolCall("pmc_1", "get_emails", 1, now).allowed).toBe(true);
      expect(aliasDaemon.reserveHourlyToolCall("pmc_1", "get_emails", 1, now + 1).allowed).toBe(false);
    } finally {
      aliasDaemon?.close();
      firstDaemon.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails closed when the durable quota ledger is malformed", () => {
    const quotaPath = hourlyQuotaPathForGrantPath(path);
    writeFileSync(quotaPath, "not a sqlite database", "utf-8");
    const s = new AgentGrantStore(path);
    try {
      expect(s.reserveHourlyToolCall("pmc_1", "get_emails", 1, Date.now())).toMatchObject({
        allowed: false,
        failure: "quota_store_unavailable",
      });
    } finally {
      s.close();
    }
  });

  it.runIf(process.platform !== "win32")("writes the quota database and SQLite sidecars owner-only", () => {
    const s = new AgentGrantStore(path);
    const quotaPath = hourlyQuotaPathForGrantPath(path);
    try {
      expect(s.reserveHourlyToolCall("pmc_1", "get_emails", 1, Date.now()).allowed).toBe(true);
      for (const suffix of ["", "-wal", "-shm"]) {
        const file = `${quotaPath}${suffix}`;
        expect(existsSync(file), `expected SQLite file ${file}`).toBe(true);
        expect(statSync(file).mode & 0o777).toBe(0o600);
      }
    } finally {
      s.close();
    }
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
