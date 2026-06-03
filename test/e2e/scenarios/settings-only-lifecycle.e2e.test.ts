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
import { writeFileSync, unlinkSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { buildPermissions } from "../../../src/config/loader.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "..", "..", "dist", "index.js");
const HOME = process.env.HOME ?? "/tmp";

/** Minimal valid config; Bridge is unreachable on purpose — settings-only
 *  never connects to it, so a dead Bridge must not affect the lifecycle. */
function writeSettingsOnlyConfig(port: number): string {
  const path = join(HOME, `.mailpouch-settings-only-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const config = {
    configVersion: 3,
    settingsPort: port,
    connection: {
      smtpHost: "127.0.0.1",
      smtpPort: 1, // unreachable on purpose
      imapHost: "127.0.0.1",
      imapPort: 1,
      username: `settings-only-${port}`,
      password: "x",
      smtpToken: "",
      bridgeCertPath: "",
      allowInsecureBridge: true,
      autoStartBridge: false,
      tlsMode: "starttls",
      simpleloginApiKey: "",
      passAccessToken: "",
    },
    permissions: buildPermissions("full"),
    credentialStorage: "config",
    requireDestructiveConfirm: true,
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("settings-only lifecycle (stdin-EOF survival)", () => {
  let child: ChildProcess | undefined;
  let configPath: string | undefined;

  afterEach(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await sleep(500);
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
    child = undefined;
    if (configPath) { try { unlinkSync(configPath); } catch { /* ignore */ } configPath = undefined; }
  });

  it("stays alive and serves the settings UI after its stdin pipe closes", async () => {
    // A high, test-unique port to avoid colliding with any real instance.
    const port = 8900 + Math.floor(Math.random() * 90);
    configPath = writeSettingsOnlyConfig(port);

    // A real stdin PIPE (not /dev/null) is what reproduces the bug: when the
    // launcher/wrapper closes the pipe (or exits), the stdio MCP transport's
    // `process.stdin.on("close")` handler fired and shut the process down.
    // /dev/null never emits 'close', so it would NOT exercise the regression.
    child = spawn("node", [SERVER, "--settings-only", "--no-tray"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        MAILPOUCH_CONFIG: configPath,
        MAILPOUCH_NO_SINGLETON: "1",
        MAILPOUCH_INSECURE_BRIDGE: "1",
      },
    });

    const exited = new Promise<number | null>((resolve) => {
      child!.on("exit", (code) => resolve(code));
    });

    // Wait for the settings server to bind.
    await sleep(2000);
    expect(child.exitCode).toBeNull();
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
