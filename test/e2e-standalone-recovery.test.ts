import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { recoverBridgeRunStandalone } from "./e2e/support/standalone-recovery.js";

const TOKEN = "mpE2E-00000000-0000-4000-8000-000000000001";
const roots: string[] = [];

function fixture(script: string): {
  root: string;
  authorityConfigPath: string;
  configPath: string;
  manifestPath: string;
  scriptPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), "mailpouch-standalone-recovery-"));
  roots.push(root);
  const authorityConfigPath = join(root, "operator-config.json");
  const configPath = join(root, `.mailpouch-e2e-bridge-${TOKEN}.json`);
  const manifestPath = join(root, `bridge-run-${TOKEN}.json`);
  const scriptPath = join(root, "cleanup.mjs");
  writeFileSync(authorityConfigPath, "{}", { mode: 0o600 });
  writeFileSync(configPath, "{}", { mode: 0o600 });
  writeFileSync(manifestPath, "{}", { mode: 0o600 });
  writeFileSync(scriptPath, script, { mode: 0o700 });
  return { root, authorityConfigPath, configPath, manifestPath, scriptPath };
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock("node:child_process");
  vi.resetModules();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("standalone Bridge recovery process boundary", () => {
  it("rejects invalid token and timeout inputs before spawning", async () => {
    const f = fixture("process.exitCode = 0;");
    await expect(recoverBridgeRunStandalone({
      token: "not-a-run-token",
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 2_000,
    })).rejects.toThrow(/invalid run token/i);
    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 0,
    })).rejects.toThrow(/positive integer timeout/i);
  });

  it("requires an explicit profile and lease-owner handoff for the production cleanup child", async () => {
    const f = fixture("process.exitCode = 0;");
    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      timeoutMs: 2_000,
    })).rejects.toThrow(/authority config.*owner-token handoff/i);
  });

  it("rejects a missing exact config or cleanup script before spawning", async () => {
    const f = fixture("process.exitCode = 0;");
    rmSync(f.configPath);
    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 2_000,
    })).rejects.toThrow(/config is missing/i);

    writeFileSync(f.configPath, "{}", { mode: 0o600 });
    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: join(f.root, "missing-cleanup.mjs"),
      timeoutMs: 2_000,
    })).rejects.toThrow(/cleanup script is missing/i);
  });

  it("rejects a missing exact ownership manifest before spawning", async () => {
    const f = fixture("process.exitCode = 0;");
    rmSync(f.manifestPath);
    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 2_000,
    })).rejects.toThrow(/manifest is missing/i);
  });

  it("passes exact run authority, strips peer authority, and requires manifest removal", async () => {
    vi.stubEnv("MAILPOUCH_E2E_RECOVERY_PEER_TOKENS", "mpE2E-ffffffff-ffff-4fff-8fff-ffffffffffff");
    vi.stubEnv("MAILPOUCH_E2E_RECOVERY_APPEND_HASHES", "a".repeat(64));
    vi.stubEnv("MAILPOUCH_E2E_CLEANUP_VERBOSE", "1");
    vi.stubEnv("MAILPOUCH_E2E_REARM_RESCUE_COPY", TOKEN);
    vi.stubEnv("MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE", "ab".repeat(32));
    const f = fixture("");
    const observedPath = join(f.root, "observed.json");
    writeFileSync(f.scriptPath, `
      import { unlinkSync, writeFileSync } from "node:fs";
      writeFileSync(${JSON.stringify(observedPath)}, JSON.stringify({
        backend: process.env.MAILPOUCH_E2E_BACKEND,
        config: process.env.MAILPOUCH_E2E_BRIDGE_CONFIG,
        token: process.env.MAILPOUCH_E2E_RUN_TOKEN,
        peers: process.env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS,
        hashes: process.env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES,
        verbose: process.env.MAILPOUCH_E2E_CLEANUP_VERBOSE,
        rescueCopyRearm: process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY,
        rescueCopyRearmNonce: process.env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE,
        authorityConfig: process.env.MAILPOUCH_E2E_AUTHORITY_CONFIG,
        leaseOwnerToken: process.env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN,
      }));
      unlinkSync(${JSON.stringify(f.manifestPath)});
    `);

    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      authorityConfigPath: f.authorityConfigPath,
      leaseOwnerToken: "11111111-2222-4333-8444-555555555555",
      timeoutMs: 2_000,
    })).resolves.toEqual({ stdout: "", stderr: "" });

    expect(JSON.parse(readFileSync(observedPath, "utf8"))).toEqual({
      backend: "bridge",
      config: f.configPath,
      token: TOKEN,
      authorityConfig: f.authorityConfigPath,
      leaseOwnerToken: "11111111-2222-4333-8444-555555555555",
    });
  });

  it("rejects an exit-zero child that leaves the exact manifest behind", async () => {
    const f = fixture("process.exitCode = 0;");

    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 2_000,
    })).rejects.toThrow(/exited successfully but retained the ownership manifest/);
  });

  it("does not accept production cleanup success while its credential clone remains", async () => {
    const f = fixture("process.exitCode = 0;");
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    vi.doMock("node:child_process", () => ({ spawn: () => child }));
    vi.resetModules();
    const recovery = await import("./e2e/support/standalone-recovery.js");

    const attempt = recovery.recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      authorityConfigPath: f.authorityConfigPath,
      leaseOwnerToken: "11111111-2222-4333-8444-555555555555",
      manifestPath: f.manifestPath,
      timeoutMs: 2_000,
    }).catch((caught: unknown) => caught);
    rmSync(f.manifestPath);
    child.emit("close", 0, null);
    const error = await attempt;

    expect(error).toBeInstanceOf(recovery.StandaloneBridgeRecoveryError);
    expect((error as Error).message).toMatch(/retained the exact encrypted recovery clone/i);
    expect(error).toMatchObject({ terminationConfirmed: true });
  });

  it("refuses a config which is not the exact token-bound recovery clone", async () => {
    const f = fixture("process.exitCode = 0;");
    const wrongConfig = join(f.root, "source-config.json");
    writeFileSync(wrongConfig, "{}", { mode: 0o600 });

    await expect(recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: wrongConfig,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 2_000,
    })).rejects.toThrow(/expected the exact run clone/);
  });

  it("rejects a non-zero exit and bounds captured child output", async () => {
    const f = fixture(`
      import { writeSync } from "node:fs";
      writeSync(1, "x".repeat(100_000));
      writeSync(2, "cleanup failed");
      process.exitCode = 7;
    `);

    const error = await recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 2_000,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("exited with code 7");
    expect((error as Error).message).toContain("...[output truncated]");
    expect((error as Error).message).toContain("cleanup failed");
    expect(Buffer.byteLength((error as Error).message)).toBeLessThan(70_000);
  });

  it("kills and rejects a child which exceeds the hard timeout", async () => {
    const f = fixture("");
    const delayedMarker = join(f.root, "delayed-marker");
    writeFileSync(f.scriptPath, `
      import { writeFileSync } from "node:fs";
      setTimeout(() => writeFileSync(${JSON.stringify(delayedMarker)}, "still alive"), 300);
      setInterval(() => undefined, 1_000);
    `);
    const startedAt = Date.now();

    const error = await recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/hard timeout and was killed/);
    expect((error as { terminationConfirmed?: unknown }).terminationConfirmed).toBe(true);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await new Promise((resolveWait) => setTimeout(resolveWait, 350));
    expect(() => readFileSync(delayedMarker, "utf8")).toThrow();
  });

  it("marks timeout recovery unsafe when SIGKILL is not followed by observed process close", async () => {
    vi.useFakeTimers();
    const f = fixture("process.exitCode = 0;");
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    vi.doMock("node:child_process", () => ({ spawn: () => child }));
    vi.resetModules();
    const recovery = await import("./e2e/support/standalone-recovery.js");

    const attempt = recovery.recoverBridgeRunStandalone({
      token: TOKEN,
      configPath: f.configPath,
      manifestPath: f.manifestPath,
      scriptPath: f.scriptPath,
      timeoutMs: 100,
    }).catch((caught: unknown) => caught);
    await vi.advanceTimersByTimeAsync(1_101);
    const error = await attempt;

    expect(error).toBeInstanceOf(recovery.StandaloneBridgeRecoveryError);
    expect(error).toMatchObject({ terminationConfirmed: false });
    expect(recovery.standaloneRecoveryTerminationConfirmed(error)).toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });
});
