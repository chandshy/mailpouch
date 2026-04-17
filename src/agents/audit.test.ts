import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AgentAuditLog, hashArgs } from "./audit.js";
import { existsSync, rmSync, readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { gunzipSync } from "zlib";

function tmpPath(): string {
  return join(tmpdir(), `pm-bridge-audit-${randomBytes(6).toString("hex")}.jsonl`);
}

describe("hashArgs", () => {
  it("returns empty string for null/undefined", () => {
    expect(hashArgs(null)).toBe("");
    expect(hashArgs(undefined)).toBe("");
  });

  it("is stable for the same input", () => {
    const a = hashArgs({ folder: "INBOX", limit: 50 });
    const b = hashArgs({ folder: "INBOX", limit: 50 });
    expect(a).toBe(b);
    expect(a).toHaveLength(16);
  });

  it("differs for different inputs", () => {
    expect(hashArgs({ folder: "INBOX" })).not.toBe(hashArgs({ folder: "Sent" }));
  });

  it("returns empty string when JSON.stringify throws (circular refs)", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(hashArgs(circular)).toBe("");
  });
});

describe("AgentAuditLog", () => {
  let path: string;

  beforeEach(() => { path = tmpPath(); });
  afterEach(() => {
    for (const p of [path, `${path}.1.gz`, `${path}.2.gz`, `${path}.3.gz`]) {
      if (existsSync(p)) rmSync(p, { force: true });
    }
  });

  it("appends rows as JSONL with a trailing newline each", () => {
    const a = new AgentAuditLog({ path });
    a.write({
      ts: "2026-04-17T18:00:00Z", clientId: "pmc_1", clientName: "C",
      tool: "get_emails", argHash: "abc", ok: true, durMs: 42,
    });
    a.write({
      ts: "2026-04-17T18:01:00Z", clientId: "pmc_1", clientName: "C",
      tool: "send_email", argHash: "def", ok: false, durMs: 12, blockedReason: "preset denies",
    });
    const raw = readFileSync(path, "utf-8");
    const lines = raw.split("\n").filter(l => l);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).tool).toBe("get_emails");
    expect(JSON.parse(lines[1]).ok).toBe(false);
  });

  it("readTail returns the most recent N rows", () => {
    const a = new AgentAuditLog({ path });
    for (let i = 0; i < 100; i++) {
      a.write({
        ts: `2026-04-17T18:${String(i).padStart(2, "0")}:00Z`,
        clientId: "pmc_1", tool: `t${i}`, argHash: "", ok: true, durMs: 1,
      });
    }
    const tail = a.readTail(5);
    expect(tail.map(r => r.tool)).toEqual(["t95", "t96", "t97", "t98", "t99"]);
  });

  it("readTail on a missing file returns []", () => {
    const a = new AgentAuditLog({ path });
    expect(a.readTail()).toEqual([]);
  });

  it("skips malformed rows in readTail", () => {
    writeFileSync(path, '{"tool":"ok","ts":"t","clientId":"c","argHash":"","durMs":1}\n{bogus\n', "utf-8");
    const a = new AgentAuditLog({ path });
    const rows = a.readTail();
    expect(rows).toHaveLength(1);
    expect(rows[0].tool).toBe("ok");
  });

  it("rotates when the file exceeds the byte threshold", () => {
    // Seed the file with > 10 MB of content so the next write triggers rotation.
    writeFileSync(path, "x".repeat(11 * 1024 * 1024), "utf-8");
    const a = new AgentAuditLog({ path });
    a.write({
      ts: "2026-04-17T18:00:00Z", clientId: "pmc_1", tool: "get_emails", argHash: "", ok: true, durMs: 1,
    });
    // The current file is now truncated (just the new row)
    const size = statSync(path).size;
    expect(size).toBeLessThan(1024);
    // A gzip archive of the old content sits next to it.
    expect(existsSync(`${path}.1.gz`)).toBe(true);
    const archived = gunzipSync(readFileSync(`${path}.1.gz`)).toString("utf-8");
    expect(archived.length).toBeGreaterThan(10 * 1024 * 1024);
  });

  it("ages existing .1.gz to .2.gz on a second rotation", () => {
    writeFileSync(path, "x".repeat(11 * 1024 * 1024), "utf-8");
    const a = new AgentAuditLog({ path });
    a.write({ ts: "t1", clientId: "c", tool: "t", argHash: "", ok: true, durMs: 1 });
    expect(existsSync(`${path}.1.gz`)).toBe(true);
    // Force another rotation.
    writeFileSync(path, "x".repeat(11 * 1024 * 1024), "utf-8");
    a.write({ ts: "t2", clientId: "c", tool: "t", argHash: "", ok: true, durMs: 1 });
    expect(existsSync(`${path}.1.gz`)).toBe(true);
    expect(existsSync(`${path}.2.gz`)).toBe(true);
  });
});
