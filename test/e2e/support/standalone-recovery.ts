/**
 * Launch the existing Bridge crash-cleanup program in a fresh Node process.
 *
 * This is deliberately a one-shot, shell-free boundary. The child receives
 * the exact run token and recovery config, but never inherits the optional
 * peer-run/hash authorities used during operator-assisted recovery.
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ownershipManifestPath } from "./ownership-manifest.js";
import { isRunToken } from "./scratch.js";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const CLEANUP_SCRIPT = resolve(MODULE_DIR, "cleanup-bridge.mjs");
const MAX_OUTPUT_BYTES = 64 * 1024;

export interface StandaloneBridgeRecoveryOptions {
  token: string;
  configPath: string;
  timeoutMs: number;
  /** Canonical source profile which owns the stable cross-worktree authority scope. */
  authorityConfigPath?: string;
  /** Exact random token from the parent harness's live run lease. */
  leaseOwnerToken?: string;
  /** Test-only override. Production callers must use cleanup-bridge.mjs. */
  scriptPath?: string;
  /** Test-only override for observing the exact manifest completion check. */
  manifestPath?: string;
}

export interface StandaloneBridgeRecoveryResult {
  stdout: string;
  stderr: string;
}

export class StandaloneBridgeRecoveryError extends Error {
  readonly terminationConfirmed: boolean;

  constructor(message: string, terminationConfirmed: boolean) {
    super(message);
    this.name = "StandaloneBridgeRecoveryError";
    this.terminationConfirmed = terminationConfirmed;
  }
}

function recoveryFailure(
  message: string,
  terminationConfirmed = true,
): StandaloneBridgeRecoveryError {
  return new StandaloneBridgeRecoveryError(message, terminationConfirmed);
}

export function standaloneRecoveryTerminationConfirmed(error: unknown): boolean {
  return error instanceof StandaloneBridgeRecoveryError && error.terminationConfirmed;
}

class BoundedOutput {
  private readonly chunks: Buffer[] = [];
  private length = 0;
  private truncated = false;

  append(chunk: string | Buffer): void {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const remaining = MAX_OUTPUT_BYTES - this.length;
    if (remaining > 0) {
      const kept = value.subarray(0, remaining);
      this.chunks.push(kept);
      this.length += kept.length;
    }
    if (value.length > remaining) this.truncated = true;
  }

  text(): string {
    const value = Buffer.concat(this.chunks, this.length).toString("utf8");
    return this.truncated ? `${value}\n...[output truncated]` : value;
  }
}

function childEnvironment(
  configPath: string,
  token: string,
  authorityConfigPath?: string,
  leaseOwnerToken?: string,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }

  // Peer-run exemptions are operator-granted authority. An automatic retry
  // may act only on the current run's own durable manifest.
  delete env.MAILPOUCH_E2E_RECOVERY_PEER_TOKENS;
  delete env.MAILPOUCH_E2E_RECOVERY_APPEND_HASHES;
  delete env.MAILPOUCH_E2E_REARM_RESCUE_COPY;
  delete env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE;
  // Keep automatic recovery output predictable and bounded even if an
  // interactive cleanup command previously enabled verbose diagnostics.
  delete env.MAILPOUCH_E2E_CLEANUP_VERBOSE;
  delete env.MAILPOUCH_E2E_AUTHORITY_CONFIG;
  delete env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN;

  env.MAILPOUCH_E2E_BACKEND = "bridge";
  env.MAILPOUCH_E2E_BRIDGE_CONFIG = configPath;
  env.MAILPOUCH_E2E_RUN_TOKEN = token;
  if (authorityConfigPath) env.MAILPOUCH_E2E_AUTHORITY_CONFIG = authorityConfigPath;
  if (leaseOwnerToken) env.MAILPOUCH_E2E_LEASE_OWNER_TOKEN = leaseOwnerToken;
  return env;
}

function diagnostic(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  return parts.length ? `\n${parts.join("\n")}` : "";
}

/**
 * Run one fresh-process cleanup attempt and accept it only when both the child
 * exits successfully and the exact durable ownership manifest is gone.
 */
export function recoverBridgeRunStandalone(
  options: StandaloneBridgeRecoveryOptions,
): Promise<StandaloneBridgeRecoveryResult> {
  if (!isRunToken(options.token)) {
    return Promise.reject(recoveryFailure(`Standalone Bridge recovery refused invalid run token "${options.token}".`));
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    return Promise.reject(recoveryFailure("Standalone Bridge recovery requires a positive integer timeout."));
  }

  const hasAuthorityConfig = typeof options.authorityConfigPath === "string"
    && options.authorityConfigPath.trim() !== "";
  const hasLeaseOwnerToken = typeof options.leaseOwnerToken === "string"
    && options.leaseOwnerToken.trim() !== "";
  if (options.scriptPath === undefined && (!hasAuthorityConfig || !hasLeaseOwnerToken)) {
    return Promise.reject(recoveryFailure(
      "Standalone Bridge recovery requires the source authority config and exact lease owner-token handoff.",
    ));
  }
  if (hasAuthorityConfig !== hasLeaseOwnerToken) {
    return Promise.reject(recoveryFailure(
      "Standalone Bridge recovery requires the source authority config and lease owner-token handoff together.",
    ));
  }
  if (hasLeaseOwnerToken
    && !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(options.leaseOwnerToken!)) {
    return Promise.reject(recoveryFailure("Standalone Bridge recovery refused an invalid lease owner-token handoff."));
  }

  const configPath = resolve(options.configPath);
  const authorityConfigPath = hasAuthorityConfig ? resolve(options.authorityConfigPath!) : undefined;
  const productionCleanup = options.scriptPath === undefined;
  const scriptPath = resolve(options.scriptPath ?? CLEANUP_SCRIPT);
  const manifestPath = resolve(options.manifestPath ?? ownershipManifestPath(
    options.token,
    authorityConfigPath ? { authorityConfigPath } : undefined,
  ));
  const expectedConfigName = `.mailpouch-e2e-bridge-${options.token}.json`;
  if (basename(configPath) !== expectedConfigName) {
    return Promise.reject(recoveryFailure(
      `Standalone Bridge recovery refused config ${configPath}; expected the exact run clone ${expectedConfigName}.`,
    ));
  }
  if (!existsSync(configPath)) {
    return Promise.reject(recoveryFailure(`Standalone Bridge recovery config is missing at ${configPath}.`));
  }
  if (authorityConfigPath && !existsSync(authorityConfigPath)) {
    return Promise.reject(recoveryFailure(
      `Standalone Bridge recovery authority config is missing at ${authorityConfigPath}.`,
    ));
  }
  if (!existsSync(scriptPath)) {
    return Promise.reject(recoveryFailure(`Standalone Bridge cleanup script is missing at ${scriptPath}.`));
  }
  if (!existsSync(manifestPath)) {
    return Promise.reject(recoveryFailure(`Standalone Bridge recovery manifest is missing at ${manifestPath}.`));
  }

  return new Promise((resolveRecovery, rejectRecovery) => {
    const stdout = new BoundedOutput();
    const stderr = new BoundedOutput();
    let settled = false;
    let timedOut = false;
    let killGrace: NodeJS.Timeout | undefined;

    const child = spawn(process.execPath, [scriptPath], {
      cwd: process.cwd(),
      env: childEnvironment(
        configPath,
        options.token,
        authorityConfigPath,
        options.leaseOwnerToken,
      ),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killGrace) clearTimeout(killGrace);
      if (error) rejectRecovery(error);
      else resolveRecovery({ stdout: stdout.text(), stderr: stderr.text() });
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        // The close/error handler or bounded kill grace below resolves the
        // one-shot attempt; never report recovery while the child is live.
      }
      killGrace = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Report the failed close below; this second signal is best effort.
        }
        finish(recoveryFailure(
          `Standalone Bridge recovery exceeded its ${options.timeoutMs}ms hard timeout and did not close after SIGKILL.`
          + diagnostic(stdout.text(), stderr.text()),
          false,
        ));
      }, 1_000);
    }, options.timeoutMs);

    child.once("error", (error) => {
      // Node may emit error without a subsequent close. Treat termination as
      // unconfirmed unless the close latch below is the path which settles.
      finish(recoveryFailure(`Standalone Bridge recovery could not start: ${error.message}.`, false));
    });

    child.once("close", (code, signal) => {
      if (settled) return;
      if (timedOut) {
        finish(recoveryFailure(
          `Standalone Bridge recovery exceeded its ${options.timeoutMs}ms hard timeout and was killed${signal ? ` with ${signal}` : ""}.`
          + diagnostic(stdout.text(), stderr.text()),
        ));
        return;
      }
      const capturedStdout = stdout.text();
      const capturedStderr = stderr.text();
      if (code !== 0) {
        finish(recoveryFailure(
          `Standalone Bridge recovery exited with code ${String(code)}${signal ? ` (signal ${signal})` : ""}.`
          + diagnostic(capturedStdout, capturedStderr),
        ));
        return;
      }
      if (existsSync(manifestPath)) {
        finish(recoveryFailure(
          `Standalone Bridge recovery exited successfully but retained the ownership manifest at ${manifestPath}.`
          + diagnostic(capturedStdout, capturedStderr),
        ));
        return;
      }
      if (productionCleanup && existsSync(configPath)) {
        finish(recoveryFailure(
          `Standalone Bridge recovery exited successfully but retained the exact encrypted recovery clone at ${configPath}.`
          + diagnostic(capturedStdout, capturedStderr),
        ));
        return;
      }
      finish();
    });
  });
}
