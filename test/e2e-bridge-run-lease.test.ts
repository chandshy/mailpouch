import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { acquireBridgeRunLease } from "./e2e/support/bridge-run-lease.js";

const roots: string[] = [];

function leaseRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mailpouch-bridge-lease-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bridge full-lifetime run lease", () => {
  it("allows exactly one contender until the exact owner releases", () => {
    const root = leaseRoot();
    const first = acquireBridgeRunLease({ leaseRoot: root, pid: 101 });

    let conflict: unknown;
    try {
      acquireBridgeRunLease({ leaseRoot: root, pid: 202 });
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toBeInstanceOf(Error);
    expect(String(conflict)).toMatch(
      /run lease already exists.*PID 101.*automatic age- or PID-based reclaim is disabled.*manually remove/i,
    );
    expect(String(conflict)).not.toContain(first.ownerToken);
    expect(existsSync(first.path)).toBe(true);

    first.release();
    expect(existsSync(first.path)).toBe(false);
    const second = acquireBridgeRunLease({ leaseRoot: root, pid: 202 });
    expect(second.ownerToken).not.toBe(first.ownerToken);
    second.release();
  });

  it("does not let an old owner release a replaced owner record", () => {
    const root = leaseRoot();
    const first = acquireBridgeRunLease({ leaseRoot: root, pid: 101 });
    const replacement = {
      version: 1,
      pid: 202,
      token: "replacement-owner-token-00000000",
      createdAt: new Date().toISOString(),
    };
    writeFileSync(first.path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

    first.release();

    expect(existsSync(first.path)).toBe(true);
    expect(JSON.parse(readFileSync(first.path, "utf8"))).toEqual(replacement);
  });

  it("never reclaims a stale-looking or malformed lease automatically", () => {
    const root = leaseRoot();
    const path = join(root, "bridge-run.lease.json");
    const oldOwner = {
      version: 1,
      pid: 2_147_483_647,
      token: "old-owner-token-0000000000000000",
      createdAt: "2000-01-01T00:00:00.000Z",
    };
    writeFileSync(path, `${JSON.stringify(oldOwner)}\n`, { mode: 0o600 });

    expect(() => acquireBridgeRunLease({ leaseRoot: root, pid: 303 })).toThrow(
      /PID 2147483647.*created 2000-01-01.*automatic age- or PID-based reclaim is disabled/i,
    );
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(oldOwner);

    writeFileSync(path, "malformed", { mode: 0o600 });

    expect(() => acquireBridgeRunLease({ leaseRoot: root, pid: 303 })).toThrow(
      /owner record is missing, unreadable, or malformed.*manually remove/i,
    );
    expect(readFileSync(path, "utf8")).toBe("malformed");
  });

  it("contends across different worktree cwd roots for one canonical config profile", () => {
    const root = leaseRoot();
    const homeRoot = join(root, "home");
    const sourceConfigPath = join(root, "operator-config.json");
    const worktreeA = join(root, "checkout-a");
    const worktreeB = join(root, "checkout-b");
    mkdirSync(homeRoot);
    mkdirSync(worktreeA);
    mkdirSync(worktreeB);
    writeFileSync(sourceConfigPath, JSON.stringify({
      connection: { imapHost: "localhost", imapPort: 1143, username: "owner@proton.test" },
    }), { mode: 0o600 });
    const cwd = vi.spyOn(process, "cwd").mockReturnValue(worktreeA);

    const first = acquireBridgeRunLease({
      authorityConfigPath: sourceConfigPath,
      homeRoot,
      pid: 101,
    });
    cwd.mockReturnValue(worktreeB);

    expect(() => acquireBridgeRunLease({
      authorityConfigPath: sourceConfigPath,
      homeRoot,
      pid: 202,
    })).toThrow(/run lease already exists.*PID 101/i);
    expect(first.path).toContain(join(homeRoot, ".mailpouch-e2e-authority"));

    first.release();
  });

  it("contends across distinct profiles selecting the same mailbox", () => {
    const root = leaseRoot();
    const homeRoot = join(root, "home");
    const firstConfigPath = join(root, "first.json");
    const secondConfigPath = join(root, "second.json");
    mkdirSync(homeRoot);
    writeFileSync(firstConfigPath, JSON.stringify({
      connection: { imapHost: "localhost", imapPort: 1143, username: "Owner@Proton.Test" },
    }));
    writeFileSync(secondConfigPath, JSON.stringify({
      connection: { imapHost: "127.0.0.1", imapPort: 1143, username: "owner@proton.test" },
    }));

    const first = acquireBridgeRunLease({
      authorityConfigPath: firstConfigPath,
      homeRoot,
      pid: 101,
    });
    expect(() => acquireBridgeRunLease({
      authorityConfigPath: secondConfigPath,
      homeRoot,
      pid: 202,
    })).toThrow(/run lease already exists.*PID 101/i);
    first.release();
  });
});
