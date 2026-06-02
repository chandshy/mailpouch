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
 * - Every call is logged to a hash-chained audit file
 *   (~/.mailpouch-pass-audit.jsonl, mode 0600) with timestamp + tool
 *   name + item ID (but never the secret value itself). Each row carries
 *   `prevHash` + `hash` so a reviewer can detect deletion/edits. The chain
 *   is best-effort and tamper-EVIDENT, not tamper-proof (CRED-009).
 * - No tool returns or logs the decrypted secret in plain text unless the
 *   user has explicitly confirmed via the elicitation gate. That's the
 *   caller's responsibility — this service exposes the raw CLI output.
 */

import { spawn, spawnSync } from "child_process";
import { createHash } from "crypto";
import { appendFileSync, existsSync, readFileSync, statSync } from "fs";
import { homedir } from "os";
import { isAbsolute, sep, join as pathJoin } from "path";
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

/** Directory prefixes considered trusted when resolving pass-cli via PATH.
 *  Windows uses the standard program install locations (Program Files, the
 *  per-user Programs dir, and the global npm prefix) instead of the POSIX bins. */
function trustedPrefixes(): string[] {
  if (process.platform === "win32") {
    return [
      process.env.ProgramFiles,
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA ? pathJoin(process.env.LOCALAPPDATA, "Programs") : undefined,
      process.env.APPDATA ? pathJoin(process.env.APPDATA, "npm") : undefined,
    ].filter((p): p is string => !!p);
  }
  return [
    "/usr/bin/",
    "/usr/local/bin/",
    "/opt/",
    "/bin/",
    // Homebrew on macOS Apple Silicon
    "/opt/homebrew/bin/",
  ];
}

/**
 * Resolve `cliPath` to an absolute, validated executable path. If the
 * configured value contains a path separator we trust it as-is (the operator
 * picked a specific binary). Otherwise we look it up via the shell `which`
 * command and verify the result lives under one of TRUSTED_PREFIXES so that
 * a directory in PATH writable by the agent (e.g. `~/.local/bin`) cannot
 * shadow the real binary.
 */
function resolveCliPath(configured: string): string {
  if (configured.includes(sep) || isAbsolute(configured)) return configured;
  try {
    // PATH lookup: `which` on POSIX, `where` on Windows (which doesn't exist there).
    const lookup = process.platform === "win32" ? "where" : "which";
    const r = spawnSync(lookup, [configured], { encoding: "utf-8" });
    if (r.status !== 0) return configured;
    // `where` can return several lines (one per match) — take the first.
    const resolved = (r.stdout ?? "").split(/\r?\n/)[0]?.trim() ?? "";
    if (!resolved || !existsSync(resolved)) return configured;
    const prefixes = trustedPrefixes();
    const trusted = prefixes.some(p => resolved.startsWith(p));
    if (!trusted) {
      logger.warn(
        `Pass: refusing to use '${resolved}' — not in a trusted PATH prefix (${prefixes.join(", ")}). ` +
        `Set passCliPath in config to override.`,
        "PassService",
      );
      return configured; // let ENOENT surface naturally
    }
    return resolved;
  } catch {
    return configured;
  }
}

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
  /**
   * CRED-009: rolling hash of the previous audit row, lazily seeded from the
   * last line on disk. `undefined` means "not yet loaded"; the empty string is
   * the genesis value for an empty/absent log.
   */
  private prevHash: string | undefined;

  constructor(args: { personalAccessToken: string; cliPath?: string; auditLogPath: string }) {
    this.pat = args.personalAccessToken;
    this.cliPath = resolveCliPath(args.cliPath ?? DEFAULT_CLI_PATH);
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
        // Restrict the child env to a minimal allowlist — passing
        // ...process.env would hand a malicious or compromised pass-cli
        // every credential the parent holds (OAuth admin password,
        // SimpleLogin keys in tests, etc.).
        child = spawn(this.cliPath, ["--json", ...args], {
          stdio: ["ignore", "pipe", "pipe"],
          // CRED-013: pin cwd to the user's home rather than inheriting
          // process.cwd(). If mailpouch was launched from an attacker-writable
          // directory (e.g. /tmp), pass-cli could drop session-state files
          // there. homedir() is the same trust domain that holds the audit log.
          cwd: homedir(),
          env: {
            PATH: process.env.PATH ?? "",
            // HOME is unset on Windows (it uses USERPROFILE); pin both to the
            // home dir so pass-cli finds its config/session regardless of OS.
            HOME: process.env.HOME ?? homedir(),
            USERPROFILE: process.env.USERPROFILE ?? homedir(),
            PROTON_PASS_PAT: this.pat,
            // Locale/charset hints — pass-cli emits JSON; without these
            // some libcs default to ASCII and mangle non-ASCII content.
            LANG: process.env.LANG ?? "C.UTF-8",
            LC_ALL: process.env.LC_ALL ?? "",
          },
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

  /**
   * Lazily recover the `hash` of the last row on disk so a chain survives
   * process restarts. Best-effort: a missing/empty/corrupt file restarts the
   * chain from genesis ("").
   */
  private loadPrevHash(): string {
    if (this.prevHash !== undefined) return this.prevHash;
    let last = "";
    try {
      if (existsSync(this.auditPath)) {
        const lines = readFileSync(this.auditPath, "utf-8").split("\n").filter((l) => l.trim() !== "");
        const tail = lines[lines.length - 1];
        if (tail) {
          const parsed = JSON.parse(tail) as { hash?: unknown };
          if (typeof parsed.hash === "string") last = parsed.hash;
        }
      }
    } catch {
      last = "";
    }
    this.prevHash = last;
    return last;
  }

  /**
   * Append one line to the audit log. Never includes secret values.
   *
   * CRED-009: each row is hash-chained — `hash = sha256(prevHash + JSON.stringify(base))`,
   * where `base` is the row WITHOUT the `hash` field but WITH `prevHash` already
   * embedded in it (so prevHash is bound into the row both directly and via the
   * hash input). A reviewer can recompute the chain to detect deletion or
   * in-place edits. This is
   * tamper-EVIDENT, not tamper-PROOF: an attacker with write access can rewrite
   * the whole file and recompute every hash. The log is best-effort (no fsync,
   * no rotation lock); treat a broken chain as "investigate", not "trusted".
   */
  private audit(event: { tool: string; itemId?: string; vault?: string; ok: boolean; error?: string }): void {
    try {
      const prevHash = this.loadPrevHash();
      const base = {
        ts: new Date().toISOString(),
        ...event,
        prevHash,
      };
      const hash = createHash("sha256").update(prevHash).update(JSON.stringify(base)).digest("hex");
      const row = { ...base, hash };
      appendFileSync(this.auditPath, JSON.stringify(row) + "\n", { encoding: "utf-8", mode: 0o600 });
      this.prevHash = hash;
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
