/**
 * Regression: `mailpouch --settings-only` must run JUST the settings UI and
 * STAY ALIVE when launched without a live MCP client holding stdin open
 * (autostart, nohup, a wrapper — i.e. stdin is immediately EOF).
 *
 * The bug: `--settings-only` was an UNRECOGNISED flag, so the process fell
 * through to the stdio MCP server, whose lifetime is bound to
 * `process.stdin.on("close", ...)`. With stdin closed at launch the handler
 * fired within seconds and the process shut itself down — which the operator
 * experienced as "it keeps crashing." This test pins the fix: with stdin
 * closed the settings-only process keeps serving rather than exiting.
 *
 * Greenmail is not involved — this exercises the standalone settings launcher
 * path only. It runs under the e2e config because it spawns the built
 * dist/index.js.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcess } from "child_process";
import { chmodSync, mkdirSync, rmSync, writeFileSync } from "fs";
import { homedir } from "node:os";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runToken } from "../support/scratch.js";
import {
  buildSettingsOnlyIsolation,
  type SettingsOnlyIsolation,
} from "../support/settings-only-isolation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "..", "..", "dist", "index.js");
const HOME = homedir();

/** Publish the exact-token config inside a private, run-owned directory. */
function writeSettingsOnlyConfig(port: number): SettingsOnlyIsolation {
  const isolation = buildSettingsOnlyIsolation(process.env, HOME, port, runToken());
  mkdirSync(isolation.stateRoot, { recursive: false, mode: 0o700 });
  try { chmodSync(isolation.stateRoot, 0o700); } catch { /* non-POSIX platform */ }
  writeFileSync(isolation.configPath, JSON.stringify(isolation.config, null, 2), {
    flag: "wx",
    mode: 0o600,
  });
  return isolation;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitForExit(proc: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(false);
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}

async function terminateChild(proc: ChildProcess): Promise<boolean> {
  if (proc.exitCode !== null || proc.signalCode !== null) return true;
  try { proc.kill("SIGTERM"); } catch { /* verify below */ }
  if (await waitForExit(proc, 5_000)) return true;
  try { proc.kill("SIGKILL"); } catch { /* verify below */ }
  return waitForExit(proc, 5_000);
}

describe("settings-only lifecycle (stdin-EOF survival)", () => {
  let child: ChildProcess | undefined;
  let isolation: SettingsOnlyIsolation | undefined;
  let childStderr = "";

  afterEach(async () => {
    const stopped = child ? await terminateChild(child) : true;
    child = undefined;
    childStderr = "";
    // Never delete a runtime namespace while its child may still be writing.
    // A failed termination intentionally retains the exact-token directory for
    // inspection instead of racing an unconfirmed process.
    if (stopped && isolation) rmSync(isolation.stateRoot, { recursive: true, force: true });
    isolation = undefined;
    expect(stopped, "settings-only child termination must be confirmed before artifact cleanup").toBe(true);
  });

  it("stays alive and serves the settings UI after its stdin pipe closes", async () => {
    // A high, test-unique port to avoid colliding with any real instance.
    const port = 8900 + Math.floor(Math.random() * 90);
    isolation = writeSettingsOnlyConfig(port);

    // A real stdin PIPE (not /dev/null) is what reproduces the bug: when the
    // launcher/wrapper closes the pipe (or exits), the stdio MCP transport's
    // `process.stdin.on("close")` handler fired and shut the process down.
    // /dev/null never emits 'close', so it would NOT exercise the regression.
    child = spawn("node", [SERVER, "--settings-only", "--no-tray"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: isolation.env,
    });
    child.stderr?.on("data", (chunk: Buffer | string) => {
      childStderr += chunk.toString();
    });

    const exited = new Promise<number | null>((resolve) => {
      child!.on("exit", (code) => resolve(code));
    });

    // Wait for the settings server to bind.
    await sleep(2000);
    expect(child.exitCode, `settings-only child exited during startup:\n${childStderr}`).toBeNull();
    const booted = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(booted.status).toBe(200);

    // Close stdin — pre-fix this is exactly what triggered self-shutdown.
    child.stdin?.end();

    const stayedAlive = await Promise.race([
      exited.then(() => false),
      sleep(3000).then(() => true),
    ]);
    expect(stayedAlive).toBe(true);
    expect(child.exitCode).toBeNull();

    // Still serving — not merely hung.
    const after = await fetch(`http://127.0.0.1:${port}/api/status`);
    expect(after.status).toBe(200);

    // A SIGTERM (or tray Quit) is the intended way to stop it.
    child.kill("SIGTERM");
    const code = await Promise.race([exited, sleep(5000).then(() => "timeout" as const)]);
    expect(code).not.toBe("timeout");
  }, 20_000);
});
