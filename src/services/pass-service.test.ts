/**
 * Tests for the PassService subprocess wrapper. We mock child_process.spawn
 * to avoid requiring pass-cli on the test machine — the assertions verify
 * we (a) build the right argv, (b) parse JSON output, (c) audit every call,
 * and (d) surface a clear error when the CLI is missing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { PassService, PassCliUnavailableError } from "./pass-service.js";
import { EventEmitter } from "events";
import { rmSync, existsSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

vi.mock("child_process", () => ({
  spawn: vi.fn(),
}));

function tmpPath(): string {
  return join(tmpdir(), `mailpouch-pass-audit-${randomBytes(6).toString("hex")}.jsonl`);
}

type FakeChild = EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: (sig?: string) => void;
};

function makeFakeChild(): FakeChild {
  const e: FakeChild = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: () => undefined,
  });
  return e;
}

describe("PassService", () => {
  let auditPath: string;
  let spawn: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    auditPath = tmpPath();
    const cp = await import("child_process");
    spawn = cp.spawn as ReturnType<typeof vi.fn>;
    spawn.mockReset();
  });

  afterEach(() => {
    if (existsSync(auditPath)) rmSync(auditPath, { force: true });
  });

  it("isConfigured() reflects whether a PAT was supplied", () => {
    expect(new PassService({ personalAccessToken: "", auditLogPath: auditPath }).isConfigured()).toBe(false);
    expect(new PassService({ personalAccessToken: "t", auditLogPath: auditPath }).isConfigured()).toBe(true);
  });

  it("listItems parses a JSON array and writes an audit row", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit("data", Buffer.from(JSON.stringify([
          { id: "i1", type: "login", name: "Gmail" },
          { id: "i2", type: "note", name: "Wifi" },
        ])));
        c.emit("close", 0);
      });
      return c;
    });

    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    const items = await svc.listItems();

    expect(items).toHaveLength(2);
    expect(items[0].id).toBe("i1");
    expect(existsSync(auditPath)).toBe(true);
    const row = JSON.parse(readFileSync(auditPath, "utf-8").trim());
    expect(row.tool).toBe("pass_list");
    expect(row.ok).toBe(true);
    expect(row.ts).toMatch(/T.*Z$/);
  });

  it("passes the --vault flag when specified", async () => {
    let capturedArgs: string[] = [];
    spawn.mockImplementation((_cli, args: string[]) => {
      capturedArgs = args;
      const c = makeFakeChild();
      setImmediate(() => { c.stdout.emit("data", Buffer.from("[]")); c.emit("close", 0); });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await svc.listItems("Work");
    // Official CLI: `item list [VAULT_NAME] --output json` (vault positional).
    expect(capturedArgs).toEqual(["item", "list", "Work", "--output", "json"]);
  });

  it("searchItems filters `item list` client-side (no CLI search subcommand)", async () => {
    let capturedArgs: string[] = [];
    spawn.mockImplementation((_cli, args: string[]) => {
      capturedArgs = args;
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit("data", Buffer.from(JSON.stringify([
          { id: "x", type: "login", name: "Acme Corp" },
          { id: "y", type: "login", name: "Gmail", url: "https://mail.google.com" },
        ])));
        c.emit("close", 0);
      });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    const res = await svc.searchItems("acme");
    // Uses `item list`, not a (non-existent) search subcommand.
    expect(capturedArgs).toEqual(["item", "list", "--output", "json"]);
    expect(res).toHaveLength(1);
    expect(res[0].name).toBe("Acme Corp");
    // Case-insensitive across any string field (url match too):
    expect(await svc.searchItems("google")).toHaveLength(1);
  });

  it("getItem parses a JSON object", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit("data", Buffer.from(JSON.stringify({
          id: "i1", type: "login", name: "Gmail",
          username: "me@example.com", fields: { password: "s3cret" },
        })));
        c.emit("close", 0);
      });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    let capturedArgs: string[] = [];
    spawn.mockImplementation((_cli, args: string[]) => {
      capturedArgs = args;
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit("data", Buffer.from(JSON.stringify({
          id: "i1", type: "login", name: "Gmail",
          username: "me@example.com", fields: { password: "s3cret" },
        })));
        c.emit("close", 0);
      });
      return c;
    });
    const item = await svc.getItem("i1");
    // Official CLI: `item view --item-id <id> --output json`.
    expect(capturedArgs).toEqual(["item", "view", "--item-id", "i1", "--output", "json"]);
    expect(item.id).toBe("i1");
    expect(item.username).toBe("me@example.com");
    expect(item.fields?.password).toBe("s3cret");
  });

  it("getTotp calls `item totp --item-id ... --output json` and audits as pass_totp", async () => {
    let capturedArgs: string[] = [];
    spawn.mockImplementation((_cli, args: string[]) => {
      capturedArgs = args;
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit("data", Buffer.from(JSON.stringify({ code: "123456" })));
        c.emit("close", 0);
      });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    const totp = await svc.getTotp("i1");
    expect(capturedArgs).toEqual(["item", "totp", "--item-id", "i1", "--output", "json"]);
    expect(totp.code).toBe("123456");
    const rows = readFileSync(auditPath, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(rows[rows.length - 1].tool).toBe("pass_totp");
  });

  it("propagates non-zero exit codes as errors AND audits the failure", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => {
        c.stderr.emit("data", Buffer.from("unauthorized"));
        c.emit("close", 1);
      });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.listItems()).rejects.toThrow(/unauthorized/);
    const row = JSON.parse(readFileSync(auditPath, "utf-8").trim());
    expect(row.ok).toBe(false);
  });

  it("translates ENOENT into PassCliUnavailableError", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => {
        const err: NodeJS.ErrnoException = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
        c.emit("error", err);
      });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.listItems()).rejects.toBeInstanceOf(PassCliUnavailableError);
  });

  it("rejects when no PAT is configured", async () => {
    const svc = new PassService({ personalAccessToken: "", auditLogPath: auditPath });
    await expect(svc.listItems()).rejects.toThrow(/no personal access token/);
  });

  it("throws when output is not a JSON array for a list operation", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => {
        c.stdout.emit("data", Buffer.from('{"not":"an array"}'));
        c.emit("close", 0);
      });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.listItems()).rejects.toThrow(/non-array JSON/);
  });

  it("throws when getItem receives empty stdout", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => { c.emit("close", 0); });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.getItem("x")).rejects.toThrow(/empty output/);
  });

  it("getItem rejects empty itemId", async () => {
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.getItem("")).rejects.toThrow(/itemId is required/);
  });

  it("wraps spawn constructor throws as PassCliUnavailableError", async () => {
    spawn.mockImplementation(() => { throw new Error("spawn failed hard"); });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.listItems()).rejects.toBeInstanceOf(PassCliUnavailableError);
  });

  it("propagates error events that are not ENOENT as-is", async () => {
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => { c.emit("error", new Error("EACCES")); });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await expect(svc.listItems()).rejects.toThrow("EACCES");
  });

  // ── CRED-009 — audit rows are hash-chained ───────────────────────────────
  it("writes a verifiable prevHash/hash chain across audit rows", async () => {
    const { createHash } = await import("crypto");
    spawn.mockImplementation(() => {
      const c = makeFakeChild();
      setImmediate(() => { c.stdout.emit("data", Buffer.from("[]")); c.emit("close", 0); });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await svc.listItems();
    await svc.listItems();

    const lines = readFileSync(auditPath, "utf-8").split("\n").filter((l) => l.trim() !== "");
    expect(lines).toHaveLength(2);
    const r1 = JSON.parse(lines[0]);
    const r2 = JSON.parse(lines[1]);
    // Genesis row chains from "".
    expect(r1.prevHash).toBe("");
    // Second row chains from the first row's hash.
    expect(r2.prevHash).toBe(r1.hash);
    // Each row's hash recomputes from prevHash + the row sans hash.
    const recompute = (row: Record<string, unknown>) => {
      const { hash: _h, ...base } = row;
      return createHash("sha256").update(String(base.prevHash)).update(JSON.stringify(base)).digest("hex");
    };
    expect(recompute(r1)).toBe(r1.hash);
    expect(recompute(r2)).toBe(r2.hash);
  });

  // ── CRED-013 — child cwd is pinned to homedir, not process.cwd() ─────────
  it("spawns pass-cli with cwd pinned to the user's home directory", async () => {
    const { homedir } = await import("os");
    let capturedOpts: { cwd?: string } = {};
    spawn.mockImplementation((_cli: string, _args: string[], opts: { cwd?: string }) => {
      capturedOpts = opts;
      const c = makeFakeChild();
      setImmediate(() => { c.stdout.emit("data", Buffer.from("[]")); c.emit("close", 0); });
      return c;
    });
    const svc = new PassService({ personalAccessToken: "pat", auditLogPath: auditPath });
    await svc.listItems();
    expect(capturedOpts.cwd).toBe(homedir());
  });
});
