import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join, sep } from "path";
import {
  acquireSingletonLock,
  releaseSingletonLock,
  lockPathForAccount,
} from "./singleton-lock.js";

// Drive the lock path through the MAILPOUCH_LOCK_PATH override (homeFile
// requires it stay within $HOME) so the suite writes into a temp dir under
// HOME instead of the real ~/.mailpouch-*.lock.
describe("singleton-lock", () => {
  const ENV = "MAILPOUCH_LOCK_PATH";
  // os.homedir() (which homeFile uses) reads HOME on POSIX but USERPROFILE on
  // Windows — override BOTH so the temp dir is "home" on every platform.
  const HOME_VARS = ["HOME", "USERPROFILE"] as const;
  const origEnv = process.env[ENV];
  const origHome: Record<string, string | undefined> = {};
  for (const v of HOME_VARS) origHome[v] = process.env[v];
  let dir: string;
  let lockFile: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "mp-lock-"));
    // Point homedir() at our temp dir (HOME on POSIX, USERPROFILE on Windows)
    // so homeFile considers the MAILPOUCH_LOCK_PATH override "inside HOME".
    for (const v of HOME_VARS) process.env[v] = dir;
    lockFile = join(dir, "test.lock");
    process.env[ENV] = lockFile;
  });

  afterEach(() => {
    if (origEnv === undefined) delete process.env[ENV]; else process.env[ENV] = origEnv;
    for (const v of HOME_VARS) {
      if (origHome[v] === undefined) delete process.env[v]; else process.env[v] = origHome[v];
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("acquires when the lock is free and records our pid", () => {
    const r = acquireSingletonLock("user@proton.me", 4321);
    expect(r.status).toBe("acquired");
    if (r.status === "acquired") expect(r.reclaimed).toBe(false);
    expect(readFileSync(lockFile, "utf8")).toBe("4321");
  });

  it("signals held-by-live-instance when a LIVE pid holds the lock", () => {
    // process.pid is, by definition, alive.
    writeFileSync(lockFile, String(process.pid));
    const r = acquireSingletonLock("user@proton.me", process.pid + 1);
    expect(r.status).toBe("held-by-live-instance");
    if (r.status === "held-by-live-instance") expect(r.pid).toBe(process.pid);
  });

  it("fails closed for a stale lock whose recorded pid is dead", () => {
    // PID 2^31-1 is effectively never a live process. It remains on disk:
    // automatic PID-check + unlink is racy against another daemon reclaiming
    // that same pathname between those two operations.
    writeFileSync(lockFile, "2147483646");
    const r = acquireSingletonLock("user@proton.me", 777);
    expect(r).toMatchObject({ status: "stale-lock", path: lockFile, pid: 2147483646 });
    expect(readFileSync(lockFile, "utf8")).toBe("2147483646");
  });

  it("fails closed for a garbage/non-numeric lock file", () => {
    writeFileSync(lockFile, "not-a-pid");
    const r = acquireSingletonLock("user@proton.me", 999);
    expect(r).toMatchObject({ status: "stale-lock", path: lockFile, pid: null });
    expect(readFileSync(lockFile, "utf8")).toBe("not-a-pid");
  });

  it("never unlinks a newly acquired lock after another contender observed an old stale owner", () => {
    // Contender A observes a stale record and returns fail-closed. An operator
    // (or a future explicitly-authorized recovery tool) then replaces it with
    // B's live lock. A later acquisition attempt must only observe B; it must
    // not perform the old implementation's stale unlink against this pathname.
    writeFileSync(lockFile, "2147483646");
    const staleObserver = acquireSingletonLock("user@proton.me", 777);
    expect(staleObserver.status).toBe("stale-lock");

    writeFileSync(lockFile, String(process.pid));
    const rival = acquireSingletonLock("user@proton.me", process.pid + 1);

    expect(rival).toMatchObject({ status: "held-by-live-instance", pid: process.pid });
    expect(readFileSync(lockFile, "utf8")).toBe(String(process.pid));
  });

  it("release removes the lock when we still own it", () => {
    const r = acquireSingletonLock("user@proton.me", 4321);
    expect(r.status).toBe("acquired");
    if (r.status !== "acquired") throw new Error("unexpected");
    releaseSingletonLock(r.path, 4321);
    expect(existsSync(lockFile)).toBe(false);
  });

  it("release does NOT remove a lock another pid re-took", () => {
    const r = acquireSingletonLock("user@proton.me", 4321);
    if (r.status !== "acquired") throw new Error("unexpected");
    // Simulate another instance re-acquiring after we were considered stale.
    writeFileSync(lockFile, "5555");
    releaseSingletonLock(r.path, 4321);
    expect(existsSync(lockFile)).toBe(true);
    expect(readFileSync(lockFile, "utf8")).toBe("5555");
  });

  it("release requires an exact PID record and does not parse a malformed successor as ours", () => {
    const r = acquireSingletonLock("user@proton.me", 4321);
    if (r.status !== "acquired") throw new Error("unexpected");
    writeFileSync(lockFile, "4321-not-our-lock");

    releaseSingletonLock(r.path, 4321);

    expect(readFileSync(lockFile, "utf8")).toBe("4321-not-our-lock");
  });

  it("release is a no-op when the lock is already gone", () => {
    expect(() => releaseSingletonLock(lockFile, 4321)).not.toThrow();
  });

  describe("lockPathForAccount", () => {
    it("derives a stable, hashed, HOME-relative path per identity", () => {
      delete process.env[ENV]; // exercise the non-override branch
      const a = lockPathForAccount("user@proton.me");
      const b = lockPathForAccount("user@proton.me");
      const c = lockPathForAccount("other@proton.me");
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      expect(a.startsWith(dir + sep)).toBe(true);
      expect(a).not.toContain("user@proton.me"); // identity is hashed, not leaked
    });

    it("normalizes case/whitespace and buckets empty identity to default", () => {
      delete process.env[ENV];
      expect(lockPathForAccount("  User@Proton.ME ")).toBe(lockPathForAccount("user@proton.me"));
      expect(lockPathForAccount("")).toBe(lockPathForAccount(null));
      expect(lockPathForAccount(undefined)).toBe(lockPathForAccount(""));
    });
  });
});
