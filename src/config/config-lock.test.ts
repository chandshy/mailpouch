/**
 * CRED-008 — exclusive file-lock around config read-modify-write.
 *
 * Unlike loader.test.ts (which mocks fs), this suite runs against the REAL
 * filesystem so the lock-directory ownership, dead-owner reclamation, and reentrancy are
 * exercised end-to-end. The config path is pointed at a throwaway file inside
 * the home directory (getConfigPath() refuses paths outside $HOME).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync, chmodSync, statSync, utimesSync, mkdirSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import { randomBytes } from "crypto";
import { saveConfig, withConfigWriteLock, withConfigWriteLockAsync, defaultConfig, invalidateConfigCache } from "./loader.js";

describe("config file lock (CRED-008)", () => {
  let dir: string;
  let cfgPath: string;
  let lockPath: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    // mkdtemp inside $HOME so getConfigPath()'s home-containment check passes.
    dir = mkdtempSync(join(homedir(), ".mailpouch-lock-test-"));
    cfgPath = join(dir, `cfg-${randomBytes(4).toString("hex")}.json`);
    lockPath = `${cfgPath}.lock`;
    savedEnv = process.env.MAILPOUCH_CONFIG;
    process.env.MAILPOUCH_CONFIG = cfgPath;
    invalidateConfigCache();
  });

  afterEach(() => {
    if (savedEnv !== undefined) process.env.MAILPOUCH_CONFIG = savedEnv;
    else delete process.env.MAILPOUCH_CONFIG;
    rmSync(dir, { recursive: true, force: true });
  });

  it("saveConfig writes the file and leaves no lock behind", () => {
    const cfg = defaultConfig();
    cfg.connection.username = "alice@example.com";
    saveConfig(cfg);
    expect(existsSync(cfgPath)).toBe(true);
    expect(existsSync(lockPath)).toBe(false); // released in finally
    expect(JSON.parse(readFileSync(cfgPath, "utf-8")).connection.username).toBe("alice@example.com");
  });

  // ─── CRED-007 (audit 2026-05-28): re-assert 0o600 on the config file ─────

  it.runIf(process.platform !== "win32")(
    "saveConfig re-asserts 0o600 on a config file left world-readable",
    () => {
      // Pre-create the destination with a wide mode (e.g. restored backup or a
      // prior loose umask). saveConfig must tighten it back to owner-only.
      writeFileSync(cfgPath, "{}", { mode: 0o644 });
      chmodSync(cfgPath, 0o644); // ensure the wide mode survives umask
      expect(statSync(cfgPath).mode & 0o777).toBe(0o644);

      const cfg = defaultConfig();
      cfg.connection.username = "carol@example.com";
      saveConfig(cfg);

      expect(statSync(cfgPath).mode & 0o077).toBe(0); // no group/world bits
      expect(statSync(cfgPath).mode & 0o777).toBe(0o600);
    },
  );

  it("reclaims a lock only after its recorded owner is known to be gone", () => {
    // Lock recovery is based on the recorded owner PID, not mtime. Mock the
    // OS liveness probe to model a process that exited after creating its
    // ownership record, without relying on a platform-specific unused PID.
    const deadOwner = { version: 1, pid: 42_424, token: "dead-owner-token-0001" };
    mkdirSync(lockPath, { mode: 0o700 });
    const ownerPath = join(lockPath, "owner.json");
    writeFileSync(ownerPath, JSON.stringify(deadOwner), { mode: 0o600 });
    const old = Date.now() / 1000 - 3600; // 1h ago, in seconds
    utimesSync(ownerPath, old, old);

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw Object.assign(new Error("process is gone"), { code: "ESRCH" });
    }) as typeof process.kill);

    const cfg = defaultConfig();
    cfg.connection.username = "bob@example.com";
    try {
      saveConfig(cfg);
    } finally {
      killSpy.mockRestore();
    }
    expect(JSON.parse(readFileSync(cfgPath, "utf-8")).connection.username).toBe("bob@example.com");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("does not reclaim a live async-owner record solely because its mtime is old", () => {
    // A keychain/reset await may exceed any arbitrary lease duration. The
    // process is still alive, so a contender must leave its lock untouched.
    const liveOwner = { version: 1, pid: process.pid, token: "live-owner-token-0001" };
    mkdirSync(lockPath, { mode: 0o700 });
    const ownerPath = join(lockPath, "owner.json");
    writeFileSync(ownerPath, JSON.stringify(liveOwner), { mode: 0o600 });
    const old = Date.now() / 1000 - 3600;
    utimesSync(ownerPath, old, old);

    const cfg = defaultConfig();
    cfg.connection.username = "must-not-write";
    // The retry delay is production backoff, not behavior under test. Hosted
    // macOS runners can oversleep each 20 ms Atomics.wait() under load and turn
    // this nominal one-second assertion into a Vitest timeout.
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    try {
      expect(() => saveConfig(cfg)).toThrow(/Could not acquire config lock/);
    } finally {
      waitSpy.mockRestore();
    }
    expect(JSON.parse(readFileSync(ownerPath, "utf-8"))).toEqual(liveOwner);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("does not take over an abandoned lock unless empty-directory removal succeeds", () => {
    // Two reclaimers can both observe a dead owner. The protocol first unlinks
    // its exact owner record and then relies on rmdir's empty-directory
    // guarantee as the winner election. Unknown concurrent contents make that
    // election fail, so the directory must remain blocking rather than letting
    // a caller create a successor over an incomplete reclaim.
    const deadOwner = { version: 1, pid: 42_425, token: "dead-owner-token-0002" };
    mkdirSync(lockPath, { mode: 0o700 });
    const ownerPath = join(lockPath, "owner.json");
    writeFileSync(ownerPath, JSON.stringify(deadOwner), { mode: 0o600 });
    writeFileSync(join(lockPath, "unexpected-content"), "present", { mode: 0o600 });

    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => {
      throw Object.assign(new Error("process is gone"), { code: "ESRCH" });
    }) as typeof process.kill);
    const waitSpy = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    try {
      expect(() => saveConfig(defaultConfig())).toThrow(/Could not acquire config lock/);
    } finally {
      waitSpy.mockRestore();
      killSpy.mockRestore();
    }

    expect(existsSync(lockPath)).toBe(true);
    expect(existsSync(join(lockPath, "unexpected-content"))).toBe(true);
    expect(existsSync(cfgPath)).toBe(false);
  });

  it("is reentrant: saveConfig inside withConfigWriteLock reuses the held lock", () => {
    const cfg = defaultConfig();
    cfg.connection.username = "carol@example.com";
    expect(() =>
      withConfigWriteLock(() => {
        saveConfig(cfg); // inner acquisition must not deadlock on the outer lock
      })
    ).not.toThrow();
    expect(JSON.parse(readFileSync(cfgPath, "utf-8")).connection.username).toBe("carol@example.com");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("serializes concurrent read-modify-write so neither writer clobbers the other (CRED-008)", async () => {
    // Seed a config with two independent fields.
    const seed = defaultConfig();
    seed.connection.username = "start";
    saveConfig(seed);

    // Two racing writers, each doing a full load→modify→save under the lock.
    // Writer A sets username, writer B sets smtpToken. With proper locking the
    // final file contains BOTH mutations (no last-writer-wins clobber).
    const writerA = withConfigWriteLockAsync(async () => {
      const c = JSON.parse(readFileSync(cfgPath, "utf-8"));
      await Promise.resolve(); // yield, widening the race window
      c.connection.username = "alice";
      saveConfig(c);
    });
    const writerB = withConfigWriteLockAsync(async () => {
      const c = JSON.parse(readFileSync(cfgPath, "utf-8"));
      await Promise.resolve();
      c.connection.smtpToken = "tokenB";
      saveConfig(c);
    });

    await Promise.all([writerA, writerB]);

    const final = JSON.parse(readFileSync(cfgPath, "utf-8"));
    // The later writer read the earlier writer's result (serialized), so both
    // fields survive.
    expect(final.connection.username).toBe("alice");
    expect(final.connection.smtpToken).toBe("tokenB");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("queues a later request that arrives while the first writer awaits async work", async () => {
    const seed = defaultConfig();
    seed.connection.username = "start";
    saveConfig(seed);

    let firstEntered!: () => void;
    const entered = new Promise<void>(resolve => { firstEntered = resolve; });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
    let secondEntered = false;

    const writerA = withConfigWriteLockAsync(async () => {
      const c = JSON.parse(readFileSync(cfgPath, "utf-8"));
      firstEntered();
      await firstGate; // model a keychain/I/O await while holding the lock
      c.connection.username = "alice";
      saveConfig(c);
    });

    await entered;
    // Start B only after A is demonstrably inside its awaited critical section.
    // A process-global lock-depth check used to mistake this for nested work.
    const writerB = withConfigWriteLockAsync(async () => {
      secondEntered = true;
      const c = JSON.parse(readFileSync(cfgPath, "utf-8"));
      c.connection.smtpToken = "tokenB";
      saveConfig(c);
    });

    await Promise.resolve();
    expect(secondEntered).toBe(false);

    releaseFirst();
    await Promise.all([writerA, writerB]);

    const final = JSON.parse(readFileSync(cfgPath, "utf-8"));
    expect(final.connection.username).toBe("alice");
    expect(final.connection.smtpToken).toBe("tokenB");
  });
});
