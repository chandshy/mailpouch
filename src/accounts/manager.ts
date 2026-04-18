/**
 * AccountManager — keeps one SimpleIMAPService + SMTPService per account
 * alive concurrently, supports hot-swapping the "active" account without
 * a server restart, and lets the tool dispatcher route individual calls
 * to a specific account via its `account_id` argument.
 *
 * Design notes
 *   - One ImapFlow connection per account. imapflow's documented pattern
 *     is "N separate clients" (no built-in pool); IDLE auto-runs per
 *     client. Memory is bounded because pm-bridge-mcp is single-user and
 *     most users have ≤ 3 accounts.
 *   - Lazy connection: services are created per account at AccountManager
 *     construction, but the underlying IMAP socket only opens on first
 *     use. Same for the SMTP transporter (nodemailer is construct-cheap).
 *   - Hot-swap semantics: changing the active account rewires the module-
 *     level `imapService` / `smtpService` references via injected setters.
 *     Callers that were mid-flight keep their existing bindings — ALS or
 *     closure captures of the prior active services continue to work
 *     until the call completes.
 *   - Credential scope: each account's password/SMTP token stays scoped
 *     to its own service instances. Switching accounts never leaks
 *     creds across account boundaries.
 */

import { logger } from "../utils/logger.js";
import { SMTPService } from "../services/smtp-service.js";
import { SimpleIMAPService } from "../services/simple-imap-service.js";
import type { ProtonMailConfig } from "../types/index.js";
import type { AccountSpec } from "./types.js";
import { readRegistry } from "./registry.js";
import { notifications as grantNotifications } from "../agents/notifications.js";
import { EventEmitter } from "events";

export interface AccountServices {
  imap: SimpleIMAPService;
  smtp: SMTPService;
  spec: AccountSpec;
}

/** Build the runtime ProtonMailConfig shape the SMTPService ctor expects. */
function specToRuntimeConfig(spec: AccountSpec): ProtonMailConfig {
  return {
    smtp: {
      host: spec.smtpHost,
      port: spec.smtpPort,
      secure: spec.tlsMode === "ssl",
      username: spec.username,
      password: spec.password,
      smtpToken: spec.smtpToken,
      bridgeCertPath: spec.bridgeCertPath,
      allowInsecureBridge: spec.allowInsecureBridge,
    },
    imap: {
      host: spec.imapHost,
      port: spec.imapPort,
      secure: spec.tlsMode === "ssl",
      username: spec.username,
      password: spec.password,
      bridgeCertPath: spec.bridgeCertPath,
      allowInsecureBridge: spec.allowInsecureBridge,
    },
    debug: false,
    autoStartBridge: spec.autoStartBridge,
    bridgePath: spec.bridgePath,
  };
}

export class AccountManager extends EventEmitter {
  private readonly perAccount = new Map<string, AccountServices>();
  private _activeAccountId = "";

  constructor() {
    super();
    this.rebuildFromRegistry();
  }

  /**
   * Rebuild the account map from the persisted registry. Called at
   * construction and after any setActiveAccount / registry mutation.
   * Preserves in-flight service instances for accounts that still exist;
   * tears down instances for accounts that were deleted; constructs new
   * instances for accounts that were added.
   */
  rebuildFromRegistry(): void {
    const reg = readRegistry();
    const seen = new Set<string>();
    for (const spec of reg.accounts) {
      seen.add(spec.id);
      const existing = this.perAccount.get(spec.id);
      if (existing) {
        // Patch the spec into the existing services so credential
        // changes propagate without a reconnect.
        existing.spec = spec;
        existing.smtp["config"] = specToRuntimeConfig(spec);
        existing.smtp.reinitialize();
        continue;
      }
      const svcs: AccountServices = {
        spec,
        imap: new SimpleIMAPService(),
        smtp: new SMTPService(specToRuntimeConfig(spec)),
      };
      this.perAccount.set(spec.id, svcs);
    }
    // Tear down services for deleted accounts.
    for (const [id, svcs] of this.perAccount) {
      if (seen.has(id)) continue;
      this.perAccount.delete(id);
      svcs.smtp.close().catch(() => {});
      svcs.imap.disconnect().catch(() => {});
    }
    // Ensure activeAccountId points at a real entry.
    if (!this.perAccount.has(reg.activeAccountId) && this.perAccount.size > 0) {
      this._activeAccountId = [...this.perAccount.keys()][0];
    } else {
      this._activeAccountId = reg.activeAccountId;
    }
  }

  /** The account currently wired into the module-level service references. */
  activeAccountId(): string { return this._activeAccountId; }

  /** Services for whichever account is currently active. */
  getActive(): AccountServices {
    const svcs = this.perAccount.get(this._activeAccountId);
    if (!svcs) throw new Error(`No account services for active id ${this._activeAccountId}`);
    return svcs;
  }

  /** Services for a specific account (by id). Throws on unknown id. */
  getForAccount(accountId: string): AccountServices {
    const svcs = this.perAccount.get(accountId);
    if (!svcs) throw new Error(`Unknown account id: ${accountId}`);
    return svcs;
  }

  /** Enumerate all accounts the manager knows about. */
  list(): AccountServices[] { return [...this.perAccount.values()]; }

  /**
   * Hot-swap the active account. Rewires the active pointer and emits
   * "active-changed" so any subscribers (module-level re-bindings, tray
   * updaters) can react. No service teardown — the prior account's
   * clients remain warm for future per-call routing.
   */
  async setActive(accountId: string): Promise<void> {
    if (!this.perAccount.has(accountId)) throw new Error(`Unknown account id: ${accountId}`);
    const prev = this._activeAccountId;
    if (prev === accountId) return;
    this._activeAccountId = accountId;
    logger.info(`Active account hot-swapped: ${prev} → ${accountId}`, "AccountManager");
    this.emit("active-changed", { prev, next: accountId, services: this.getActive() });
    // A grant-style notification so the tray/UI pick it up alongside agent events.
    grantNotifications.emit("active-account-changed", { prev, next: accountId });
  }

  /** Cleanly tear down every account's services. Called on shutdown. */
  async closeAll(): Promise<void> {
    for (const svcs of this.perAccount.values()) {
      try { await svcs.smtp.close(); } catch { /* ignore */ }
      try { await svcs.imap.disconnect(); } catch { /* ignore */ }
    }
  }

  /**
   * Warm IMAP connections for every known account. Called at boot so IDLE
   * runs against every configured mailbox — otherwise non-active accounts
   * only connect on their first per-tool call, which means new-mail events
   * sit in the Proton server until the agent asks for them.
   *
   * Failures are logged per-account but do not stop the loop; a single
   * broken account shouldn't block the others. Returns per-account
   * success/failure so the caller can surface a summary.
   */
  async connectAll(): Promise<Array<{ id: string; ok: boolean; error?: string }>> {
    const results: Array<{ id: string; ok: boolean; error?: string }> = [];
    for (const [id, svcs] of this.perAccount) {
      const s = svcs.spec;
      try {
        await svcs.imap.connect(
          s.imapHost,
          s.imapPort,
          s.username,
          s.password,
          s.bridgeCertPath,
          s.tlsMode === "ssl",
          !!s.allowInsecureBridge,
        );
        logger.info(`IMAP connected for account "${id}"`, "AccountManager");
        results.push({ id, ok: true });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warn(`IMAP connect failed for account "${id}": ${msg}`, "AccountManager");
        results.push({ id, ok: false, error: msg });
      }
    }
    return results;
  }
}

// ─── Module singleton accessor ────────────────────────────────────────────
// index.ts constructs the manager during server bootstrap; the settings
// server imports this getter so it can trigger hot-swaps on /api/accounts/
// activate without a circular dep or explicit wiring.

let _singleton: AccountManager | null = null;
export function registerAccountManager(mgr: AccountManager): void {
  _singleton = mgr;
}
export function getAccountManager(): AccountManager | null {
  return _singleton;
}
