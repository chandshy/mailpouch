/**
 * Persistence for service-account credentials — the non-interactive half of
 * the agent-auth model.
 *
 * A service account is an OAuth client restricted to the `client_credentials`
 * grant: it carries its own `client_id` + `client_secret` and is pre-approved
 * at issuance, so a headless agent (cron, scheduled, CI) can log in without an
 * interactive Approve/Deny. Each account is mirrored by an *active*
 * {@link AgentGrant} so it flows through {@link GrantManager} exactly like an
 * interactively-approved agent — same gate, same audit, same revocation.
 *
 * Storage mirrors {@link AgentGrantStore}: a single JSON file
 * (`~/.mailpouch-service-accounts.json`, mode 0600), whole-file atomic writes
 * via tmp→rename under a cross-process advisory lock. We persist ONLY a salted
 * SHA-256 of the secret — the plaintext is returned once at issuance and never
 * stored. The secret is 256 bits of CSPRNG output, so a salted single-round
 * SHA-256 is sufficient (no low-entropy password to slow-hash).
 */

import { readFileSync, existsSync } from "fs";
import { randomBytes, randomUUID, createHash } from "crypto";
import type { GrantConditions } from "./types.js";
import type { PermissionPreset } from "../config/schema.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { withFileLock } from "../utils/file-lock.js";
import { writeOwnerOnlyJsonAtomically } from "../utils/atomic-json.js";
import { isValidAgentToolHourlyCap, sanitizeGrantConditions } from "./grant-conditions.js";

export interface ServiceAccount {
  /** OAuth client_id, `pmc_<32-hex>` — same scheme as DCR clients. */
  clientId: string;
  clientName: string;
  /** hex SHA-256 of (secretSalt + clientSecret). Plaintext is never stored. */
  secretHash: string;
  /** hex random salt mixed into secretHash. */
  secretSalt: string;
  /** Permission preset the issued grant is approved at. */
  preset: PermissionPreset;
  /** Optional grant conditions (folder allowlist, expiry, ip pins, …). */
  conditions?: GrantConditions;
  /** ISO-8601 issuance time. */
  createdAt: string;
}

/** A freshly-issued account plus the one-time plaintext secret. */
export interface IssuedServiceAccount {
  account: ServiceAccount;
  /** Plaintext client secret — shown ONCE, never persisted. */
  clientSecret: string;
}

export interface IssueArgs {
  name: string;
  preset: PermissionPreset;
  conditions?: GrantConditions;
}

interface StoreFile {
  version: 1;
  accounts: ServiceAccount[];
}

/** Fresh disk-backed credential view used by authorization decisions. */
export type ServiceAccountAuthorizationSnapshot =
  | { kind: "present"; account: ServiceAccount }
  | { kind: "missing" }
  | { kind: "unavailable" };

const SERVICE_ACCOUNT_PRESETS = new Set<PermissionPreset>(["full", "read_only", "supervised", "send_only", "custom"]);

/** hex SHA-256 of salt+secret — the value persisted and compared against. */
function hashSecret(salt: string, secret: string): string {
  return createHash("sha256").update(salt, "utf-8").update(secret, "utf-8").digest("hex");
}

export class ServiceAccountStore {
  private accounts = new Map<string, ServiceAccount>();
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
    this.load();
  }

  private load(): void {
    if (!existsSync(this.path)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreFile>;
      const list = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      for (const a of list) {
        if (a && typeof a.clientId === "string") this.accounts.set(a.clientId, a);
      }
    } catch (err) {
      logger.warn(`ServiceAccountStore: failed to parse ${this.path}, starting empty`, "ServiceAccountStore", err);
      this.accounts.clear();
    }
  }

  /** Reload-merge under the lock so a peer process's issue/revoke isn't clobbered
   *  by our whole-file rewrite (mirrors AgentGrantStore PERM-006). */
  private mutate<T>(fn: () => T): T {
    return withFileLock(this.path, () => {
      this.reloadMerge();
      return fn();
    });
  }

  private reloadMerge(): void {
    if (!existsSync(this.path)) {
      this.accounts.clear();
      return;
    }
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreFile>;
      const list = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      this.accounts.clear();
      for (const a of list) {
        if (a && typeof a.clientId === "string") this.accounts.set(a.clientId, a);
      }
    } catch (err) {
      logger.warn(`ServiceAccountStore: reloadMerge failed for ${this.path}`, "ServiceAccountStore", err);
    }
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, accounts: [...this.accounts.values()] };
    writeOwnerOnlyJsonAtomically(this.path, payload);
  }

  /**
   * Mint a new service account. Generates a `pmc_` client id and a 256-bit
   * secret, persists the salted hash, and returns the plaintext secret ONCE.
   */
  issue(args: IssueArgs): IssuedServiceAccount {
    return this.mutate(() => {
      const clientId = `pmc_${randomUUID().replace(/-/g, "")}`;
      const clientSecret = randomBytes(32).toString("base64url");
      const secretSalt = randomBytes(16).toString("hex");
      const account: ServiceAccount = {
        clientId,
        clientName: args.name,
        secretHash: hashSecret(secretSalt, clientSecret),
        secretSalt,
        preset: args.preset,
        // Defend the programmatic/CLI issuance path too. Persisted legacy
        // records are intentionally left untouched on load so GrantManager can
        // fail closed on malformed caps rather than silently dropping them.
        conditions: sanitizeGrantConditions(args.conditions),
        createdAt: new Date().toISOString(),
      };
      this.accounts.set(clientId, account);
      this.persist();
      return { account, clientSecret };
    });
  }

  /** Reload the on-disk state into memory. Public so a long-lived daemon can
   *  pick up accounts issued/revoked by a separate `mailpouch agent` process
   *  without a restart. Reads are safe without a lock: persist() writes
   *  atomically (tmp→rename), so a reader sees the old or new file, never a
   *  partial one. */
  reload(): void {
    this.reloadMerge();
  }

  /**
   * Constant-time verification of a client_id + secret pair. Returns the
   * account on success, null otherwise. Never distinguishes unknown-client from
   * wrong-secret to the caller (the OAuth handler collapses both to
   * `invalid_client`).
   *
   * Reads a validated disk snapshot so a running daemon honors accounts issued
   * (or revoked) by a separate process since startup — and cannot mint a new
   * bearer from a stale map while the credential file is malformed or
   * unreadable. client_credentials logins are infrequent (24h token TTL) and
   * the file is tiny, so the per-verify read is negligible.
   */
  verify(clientId: string, secret: string): ServiceAccount | null {
    const snapshot = this.getAuthorizationSnapshot(clientId);
    if (snapshot.kind !== "present") return null;
    const account = snapshot.account;
    const candidate = hashSecret(account.secretSalt, secret);
    return constantTimeEqual(candidate, account.secretHash) ? account : null;
  }

  /**
   * Read a credential record directly from disk for a security decision.
   *
   * The in-memory map remains appropriate for settings rendering, but neither
   * bearer authorization nor credential exchange can use it: a separate
   * CLI/settings process may have removed the account while this daemon is
   * alive. Only a real ENOENT is a definitive absence; malformed or unreadable
   * storage is unavailable and must be handled fail-closed.
   */
  getAuthorizationSnapshot(clientId: string): ServiceAccountAuthorizationSnapshot {
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf-8")) as Partial<StoreFile>;
      if (parsed.version !== 1 || !Array.isArray(parsed.accounts) || !parsed.accounts.every(isValidAuthorizationAccount)) {
        logger.warn("ServiceAccountStore: authorization snapshot is malformed; denying access", "ServiceAccountStore");
        return { kind: "unavailable" };
      }
      const ids = new Set<string>();
      for (const account of parsed.accounts) {
        if (ids.has(account.clientId)) {
          logger.warn("ServiceAccountStore: authorization snapshot has duplicate client IDs; denying access", "ServiceAccountStore");
          return { kind: "unavailable" };
        }
        ids.add(account.clientId);
      }
      const account = parsed.accounts.find(entry => entry.clientId === clientId);
      return account ? { kind: "present", account } : { kind: "missing" };
    } catch (error) {
      if (isNoEntryError(error)) return { kind: "missing" };
      logger.warn("ServiceAccountStore: authorization snapshot could not be read; denying access", "ServiceAccountStore", error);
      return { kind: "unavailable" };
    }
  }

  get(clientId: string): ServiceAccount | undefined {
    return this.accounts.get(clientId);
  }

  /** All accounts (secret material included only as the stored hash). */
  list(): ServiceAccount[] {
    return [...this.accounts.values()];
  }

  /** Remove an account. Returns true if it existed. Token revocation for any
   *  live access tokens is the caller's job (OAuthStore.revokeTokensForClient). */
  revoke(clientId: string): boolean {
    return this.mutate(() => {
      const existed = this.accounts.delete(clientId);
      if (existed) this.persist();
      return existed;
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function isNoEntryError(error: unknown): boolean {
  return isRecord(error) && error.code === "ENOENT";
}

/** Validate persisted records before letting their mere presence authorize a grant. */
function isValidAuthorizationAccount(value: unknown): value is ServiceAccount {
  if (!isRecord(value)) return false;
  if (typeof value.clientId !== "string" || !value.clientId) return false;
  if (typeof value.clientName !== "string") return false;
  if (typeof value.secretHash !== "string" || !/^[a-f0-9]{64}$/i.test(value.secretHash)) return false;
  if (typeof value.secretSalt !== "string" || !/^[a-f0-9]{32}$/i.test(value.secretSalt)) return false;
  if (typeof value.preset !== "string" || !SERVICE_ACCOUNT_PRESETS.has(value.preset as PermissionPreset)) return false;
  if (typeof value.createdAt !== "string" || !value.createdAt) return false;
  return validConditions(value.conditions);
}

function validConditions(value: unknown): boolean {
  if (value === undefined) return true;
  if (!isRecord(value)) return false;
  if (value.expiresAt !== undefined && (typeof value.expiresAt !== "string" || !Number.isFinite(Date.parse(value.expiresAt)))) return false;
  if (value.accountId !== undefined && typeof value.accountId !== "string") return false;
  if (value.folderAllowlist !== undefined && (!Array.isArray(value.folderAllowlist) || !value.folderAllowlist.every(folder => typeof folder === "string"))) return false;
  if (value.ipPins !== undefined && (!Array.isArray(value.ipPins) || !value.ipPins.every(ip => typeof ip === "string"))) return false;
  if (value.maxCallsPerHourByTool !== undefined) {
    if (!isRecord(value.maxCallsPerHourByTool) || !Object.values(value.maxCallsPerHourByTool).every(isValidAgentToolHourlyCap)) return false;
  }
  return true;
}
