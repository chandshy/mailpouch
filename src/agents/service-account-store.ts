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

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { randomBytes, randomUUID, createHash } from "crypto";
import type { GrantConditions } from "./types.js";
import type { PermissionPreset } from "../config/schema.js";
import { constantTimeEqual } from "../utils/crypto.js";
import { logger } from "../utils/logger.js";
import { withFileLock } from "../utils/file-lock.js";

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
    // tmp next to the destination so rename(2) stays atomic across the same fs
    // (os.tmpdir() can be a separate mount → EXDEV). Matches AgentGrantStore.
    const tmp = `${this.path}.${randomBytes(8).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { encoding: "utf-8", mode: 0o600 });
    renameSync(tmp, this.path);
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
        conditions: args.conditions,
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
   * Reloads from disk first so a running daemon honors accounts issued (or
   * revoked) by a separate process since startup — re-auth needs no restart.
   * client_credentials logins are infrequent (24h token TTL) and the file is
   * tiny, so the per-verify read is negligible.
   */
  verify(clientId: string, secret: string): ServiceAccount | null {
    this.reloadMerge();
    const account = this.accounts.get(clientId);
    if (!account) return null;
    const candidate = hashSecret(account.secretSalt, secret);
    return constantTimeEqual(candidate, account.secretHash) ? account : null;
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
