import { describe, it, expect, afterEach, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import { withFileLock } from "./file-lock.js";

function tmpTarget(): string {
  return join(tmpdir(), `mailpouch-lock-${randomBytes(6).toString("hex")}.json`);
}

describe("withFileLock", () => {
  const cleanup: string[] = [];
  afterEach(() => {
    for (const t of cleanup.splice(0)) {
      rmSync(t, { force: true });
      rmSync(`${t}.lock`, { recursive: true, force: true });
    }
  });

  it("runs fn and returns its value", () => {
    const t = tmpTarget(); cleanup.push(t);
    const r = withFileLock(t, () => 42);
    expect(r).toBe(42);
  });

  it("releases the lock dir after fn completes", () => {
    const t = tmpTarget(); cleanup.push(t);
    withFileLock(t, () => { /* no-op */ });
    expect(existsSync(`${t}.lock`)).toBe(false);
  });

  it("releases the lock even when fn throws", () => {
    const t = tmpTarget(); cleanup.push(t);
    expect(() => withFileLock(t, () => { throw new Error("boom"); })).toThrow("boom");
    expect(existsSync(`${t}.lock`)).toBe(false);
  });

  it("reclaims a lock only when its recorded owner is conclusively gone", () => {
    const t = tmpTarget(); cleanup.push(t);
    const lockDir = `${t}.lock`;
    const deadOwner = { version: 1, pid: 42_424, token: "dead-owner-token-0001" };
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, "owner.json"), JSON.stringify(deadOwner), { mode: 0o600 });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    try {
      expect(withFileLock(t, () => "ran")).toBe("ran");
    } finally {
      killSpy.mockRestore();
    }
  });

  it("never reclaims a live owner solely because the lock is old", () => {
    const t = tmpTarget(); cleanup.push(t);
    const lockDir = `${t}.lock`;
    const liveOwner = { version: 1, pid: process.pid, token: "live-owner-token-0001" };
    mkdirSync(lockDir, { mode: 0o700 });
    const record = join(lockDir, "owner.json");
    writeFileSync(record, JSON.stringify(liveOwner), { mode: 0o600 });
    const old = Date.now() / 1000 - 3600;
    utimesSync(record, old, old);

    expect(() => withFileLock(t, () => "must-not-run")).toThrow(/Could not acquire security-store lock/);
    expect(JSON.parse(readFileSync(record, "utf8"))).toEqual(liveOwner);
  });

  it("fails closed when ownership is unknown", () => {
    const t = tmpTarget(); cleanup.push(t);
    const lockDir = `${t}.lock`;
    mkdirSync(lockDir, { mode: 0o700 });
    writeFileSync(join(lockDir, "owner.json"), "not-json", { mode: 0o600 });
    let ran = false;
    expect(() => withFileLock(t, () => { ran = true; })).toThrow(/Could not acquire security-store lock/);
    expect(ran).toBe(false);
  });

  it.runIf(process.platform !== "win32")("serializes an existing store and its file-symlink alias through one lock", () => {
    const directory = mkdtempSync(join(tmpdir(), "mailpouch-lock-alias-"));
    const target = join(directory, "grants.json");
    const alias = join(directory, "grants-alias.json");
    writeFileSync(target, "[]", { mode: 0o600 });
    symlinkSync(target, alias);

    try {
      withFileLock(target, () => {
        expect(existsSync(`${target}.lock`)).toBe(true);
        expect(existsSync(`${alias}.lock`)).toBe(false);
        expect(() => withFileLock(alias, () => "must-not-run"))
          .toThrow(/Could not acquire security-store lock/);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("serializes new stores reached through a symlinked parent", () => {
    const directory = mkdtempSync(join(tmpdir(), "mailpouch-lock-parent-alias-"));
    const physicalParent = join(directory, "physical");
    const aliasParent = join(directory, "alias");
    mkdirSync(physicalParent);
    symlinkSync(physicalParent, aliasParent, "dir");
    const target = join(physicalParent, "pending.json");
    const alias = join(aliasParent, "pending.json");

    try {
      withFileLock(target, () => {
        expect(existsSync(`${target}.lock`)).toBe(true);
        expect(realpathSync(`${alias}.lock`)).toBe(realpathSync(`${target}.lock`));
        expect(() => withFileLock(alias, () => "must-not-run"))
          .toThrow(/Could not acquire security-store lock/);
      });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
