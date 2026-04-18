/**
 * Proton Pass — CLI subprocess wrapper.
 *
 * Wraps the official `pass-cli` tool (protonpass/pass-cli). We deliberately
 * never accept or store a Proton account password for Pass; every call uses
 * a scoped **Personal Access Token** the user obtains from the Proton Pass
 * web app (Settings → Developer → Personal Access Tokens).
 *
 * ## Why a CLI subprocess, not a direct HTTP client
 *
 * Proton Pass's crypto envelope is non-trivial (SRP + per-item keys + bulk
 * export handling). The official CLI handles all of it; shelling out avoids
 * re-implementing the crypto in TypeScript and keeps the attack surface
 * small. The trade-off is an external dependency: if `pass-cli` is not
 * installed or not on PATH, all tools return a structured error directing
 * the user to install it.
 *
 * ## Security posture
 *
 * - PAT is read from the config file (mode 0600) OR keychain. Never from
 *   env vars the agent can inspect.
 * - Every call is logged to an append-only audit file
 *   (~/.pm-bridge-mcp-pass-audit.jsonl, mode 0600) with timestamp + tool
 *   name + item ID (but never the secret value itself).
 * - No tool returns or logs the decrypted secret in plain text unless the
 *   user has explicitly confirmed via the elicitation gate. That's the
 *   caller's responsibility — this service exposes the raw CLI output.
 */

import { spawn } from "child_process";
import { appendFileSync } from "fs";
import { logger } from "../utils/logger.js";

export interface PassItemSummary {
  id: string;
  /** e.g. "login", "note", "alias", "cc", "identity" */
  type: string;
  name: string;
  vault?: string;
  updatedAt?: string;
}

export interface PassItemDetail extends PassItemSummary {
  /** Present for login items. */
  username?: string;
  /** Password, TOTP, note body, etc. — shape depends on item type. */
  fields?: Record<string, string>;
  note?: string;
  url?: string;
}

const DEFAULT_CLI_PATH = "pass-cli";
const DEFAULT_TIMEOUT_MS = 15_000;

/** Thrown when `pass-cli` is not installed or the invocation times out. */
export class PassCliUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PassCliUnavailableError";
  }
}

export class PassService {
  private readonly cliPath: string;
  private readonly pat: string;
  private readonly auditPath: string;

  constructor(args: { personalAccessToken: string; cliPath?: string; auditLogPath: string }) {
    this.pat = args.personalAccessToken;
    this.cliPath = args.cliPath ?? DEFAULT_CLI_PATH;
    this.auditPath = args.auditLogPath;
  }

  isConfigured(): boolean {
    return !!this.pat;
  }

  /**
   * Spawn the pass-cli with the given args. Stdin is closed immediately.
   * Returns the decoded stdout on success. Times out after DEFAULT_TIMEOUT_MS.
   */
  private async run(args: string[], timeoutMs = DEFAULT_TIMEOUT_MS): Promise<string> {
    if (!this.pat) {
      throw new Error("Pass: no personal access token configured. Set passAccessToken in Settings → Pass.");
    }
    return new Promise<string>((resolve, reject) => {
      let settled = false;
      let stdout = "";
      let stderr = "";
      let child: ReturnType<typeof spawn>;
      try {
        // The PAT is passed via env, matching pass-cli's documented flow.
        // A child env keeps it out of parent process.env visibility.
        child = spawn(this.cliPath, ["--json", ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, PROTON_PASS_PAT: this.pat },
        });
      } catch (err: unknown) {
        reject(new PassCliUnavailableError(
          `Could not spawn '${this.cliPath}'. Install Proton Pass CLI (https://proton.me/blog/proton-pass-cli) or set passCliPath in config.`,
        ));
        return;
      }
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { child.kill("SIGTERM"); } catch { /* ignore */ }
        reject(new Error(`pass-cli timed out after ${timeoutMs} ms`));
      }, timeoutMs);

      child.stdout?.on("data", (c: Buffer) => { stdout += c.toString("utf-8"); });
      child.stderr?.on("data", (c: Buffer) => { stderr += c.toString("utf-8"); });
      child.on("error", (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if ("code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          reject(new PassCliUnavailableError(
            `'${this.cliPath}' not found on PATH. Install Proton Pass CLI (https://proton.me/blog/proton-pass-cli) or set passCliPath in config.`,
          ));
        } else {
          reject(err);
        }
      });
      child.on("close", (code: number) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout);
        } else {
          reject(new Error(`pass-cli exited ${code}: ${stderr.trim() || stdout.trim() || "unknown error"}`));
        }
      });
    });
  }

  /** Append one line to the audit log. Never includes secret values. */
  private audit(event: { tool: string; itemId?: string; vault?: string; ok: boolean; error?: string }): void {
    try {
      const row = {
        ts: new Date().toISOString(),
        ...event,
      };
      appendFileSync(this.auditPath, JSON.stringify(row) + "\n", { encoding: "utf-8", mode: 0o600 });
    } catch (err) {
      logger.warn(`Pass: could not write audit log at ${this.auditPath}`, "PassService", err);
    }
  }

  async listItems(vault?: string): Promise<PassItemSummary[]> {
    const args = ["list"];
    if (vault) args.push("--vault", vault);
    try {
      const out = await this.run(args);
      this.audit({ tool: "pass_list", vault, ok: true });
      return this.parseJsonArray<PassItemSummary>(out);
    } catch (err: unknown) {
      this.audit({ tool: "pass_list", vault, ok: false, error: (err as Error).message });
      throw err;
    }
  }

  async searchItems(query: string): Promise<PassItemSummary[]> {
    try {
      const out = await this.run(["search", "--query", query]);
      this.audit({ tool: "pass_search", ok: true });
      return this.parseJsonArray<PassItemSummary>(out);
    } catch (err: unknown) {
      this.audit({ tool: "pass_search", ok: false, error: (err as Error).message });
      throw err;
    }
  }

  async getItem(itemId: string): Promise<PassItemDetail> {
    if (!itemId) throw new Error("itemId is required");
    try {
      const out = await this.run(["get", "--id", itemId]);
      this.audit({ tool: "pass_get", itemId, ok: true });
      return this.parseJsonObject<PassItemDetail>(out);
    } catch (err: unknown) {
      this.audit({ tool: "pass_get", itemId, ok: false, error: (err as Error).message });
      throw err;
    }
  }

  private parseJsonArray<T>(raw: string): T[] {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    const parsed = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error("pass-cli returned non-array JSON for a list operation");
    }
    return parsed as T[];
  }

  private parseJsonObject<T>(raw: string): T {
    const trimmed = raw.trim();
    if (!trimmed) throw new Error("pass-cli returned empty output");
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("pass-cli returned non-object JSON for a get operation");
    }
    return parsed as T;
  }
}
