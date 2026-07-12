/**
 * AccountManager — keeps one SimpleIMAPService + SMTPService per account
 * alive concurrently, supports hot-swapping the "active" account without
 * a server restart, and lets the tool dispatcher route individual calls
 * to a specific account via its `account_id` argument.
 *
 * Design notes
 *   - One ImapFlow connection per account. imapflow's documented pattern
 *     is "N separate clients" (no built-in pool); IDLE auto-runs per
 *     client. Memory is bounded because mailpouch is single-user and
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
import type { AccountRegistry, AccountSpec } from "./types.js";
import {
  mailboxKeychainCredentialsAreQuarantined,
  readRegistry,
  readRegistryWithSecrets,
} from "./registry.js";
import { notifications as grantNotifications } from "../agents/notifications.js";
import { EventEmitter } from "events";
import { accountIdentityFingerprint, hasMaterialAccountIdentityChange } from "./identity.js";

export interface AccountServices {
  imap: SimpleIMAPService;
  smtp: SMTPService;
  spec: AccountSpec;
}

export interface AccountsRebuiltEvent {
  accountIds: string[];
  /** IDs removed from the live registry during this rebuild. */
  removedAccountIds: string[];
  /** IDs retained but repointed at a materially different mailbox/transport. */
  identityChangedAccountIds: string[];
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

/** Keep the manager's sensitive runtime copy independent from config callers. */
function cloneAccountSpec(spec: AccountSpec): AccountSpec {
  return { ...spec };
}

/** Fields passed to SimpleIMAPService.connect() which require a fresh client. */
function hasImapConnectionSettingsChange(previous: AccountSpec, next: AccountSpec): boolean {
  return previous.imapHost !== next.imapHost
    || previous.imapPort !== next.imapPort
    || previous.username !== next.username
    || previous.password !== next.password
    || previous.bridgeCertPath !== next.bridgeCertPath
    || (previous.tlsMode ?? "starttls") !== (next.tlsMode ?? "starttls")
    || !!previous.allowInsecureBridge !== !!next.allowInsecureBridge;
}

/** Fields consumed by SMTPService's transporter/TLS configuration. */
function hasSmtpConnectionSettingsChange(previous: AccountSpec, next: AccountSpec): boolean {
  return previous.smtpHost !== next.smtpHost
    || previous.smtpPort !== next.smtpPort
    || previous.username !== next.username
    || previous.password !== next.password
    || previous.smtpToken !== next.smtpToken
    || previous.bridgeCertPath !== next.bridgeCertPath
    || (previous.tlsMode ?? "starttls") !== (next.tlsMode ?? "starttls")
    || !!previous.allowInsecureBridge !== !!next.allowInsecureBridge;
}

export class AccountManager extends EventEmitter {
  private readonly perAccount = new Map<string, AccountServices>();
  /** Serial tail for each account's IMAP connect/reconnect operations. */
  private readonly connectTails = new Map<string, Promise<void>>();
  /** Bumped whenever a connect operation must no longer be allowed to win. */
  private readonly connectionVersions = new Map<string, number>();
  /** Services already retiring; prevents a queued connect from reviving one. */
  private readonly retiredServices = new WeakSet<AccountServices>();
  /** Outstanding best-effort retirement work, including removed services. */
  private readonly retirementTasks = new Set<Promise<void>>();
  /** Async registry reads are serialized so an older keychain read cannot win. */
  private rebuildTail: Promise<void> = Promise.resolve();
  /** Latest requested rebuild (sync or async); older snapshots are discarded. */
  private rebuildVersion = 0;
  /**
   * Set after a reset could not verify every OS-keychain deletion.  A normal
   * async rebuild prefers keychain credentials over the on-disk registry;
   * continuing to do that after such a reset could resurrect the mailbox
   * credentials the reset was meant to remove.  Keep the process fail-closed
   * until it is restarted (or an explicit, future remediation flow resumes
   * hydration).
   */
  private keychainHydrationSuspended = false;
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
   *
   * Synchronous variant that reads the on-disk state WITHOUT pulling
   * plaintext creds from the keychain — intended for the construction
   * path where we can't block on an async keychain call. Use
   * `rebuildFromRegistryAsync()` (below) when you need the creds
   * populated — main() calls the async version right after boot.
   */
  rebuildFromRegistry(): void {
    this.rebuildVersion += 1;
    this.applyRegistry(readRegistry());
  }

  /**
   * Fail-closed reset path for an incomplete credential cleanup.
   *
   * Rebuild from the durable, unhydrated registry immediately and permanently
   * suspend keychain hydration for this process.  Incrementing
   * `rebuildVersion` through `rebuildFromRegistry()` also invalidates any
   * in-flight async keychain read, so it cannot restore an old primary
   * credential after the reset returns.
   *
   * This is intentionally distinct from the ordinary synchronous rebuild:
   * callers should use it only after a reset has reported that OS-keychain
   * deletion was incomplete. The reset also persists a restart-safe
   * quarantine marker; a later verified reset is the explicit recovery path.
   */
  rebuildFromRegistryWithoutKeychain(): void {
    this.keychainHydrationSuspended = true;
    this.rebuildFromRegistry();
  }

  /**
   * Async rebuild that fills credentials from the OS keychain. Called
   * by main() right after boot and after any Accounts-tab mutation
   * that lands via the settings-UI server — ensures the in-memory
   * services have the passwords the user persisted, even though the
   * on-disk config blanks them.
   *
   * Calls are intentionally queued around the *read*, not only map
   * mutation. A keychain lookup can take long enough for a later settings
   * save to complete; the generation check then discards the stale snapshot
   * instead of restoring its old mailbox after the newer rebuild.
   */
  async rebuildFromRegistryAsync(): Promise<void> {
    const requestedVersion = ++this.rebuildVersion;
    const task = this.rebuildTail.then(async () => {
      // A later sync/async rebuild already has a newer view to apply.
      if (requestedVersion !== this.rebuildVersion) return;

      // After an incomplete reset, keep future in-process rebuilds on the
      // unhydrated registry too. The persisted quarantine covers a restarted
      // process; this in-memory suspension also invalidates an already-running
      // async read before reset returns. A settings save or delayed startup
      // task must not make a stale keychain entry usable again.
      const registry = this.keychainHydrationSuspended || mailboxKeychainCredentialsAreQuarantined()
        ? readRegistry()
        : await readRegistryWithSecrets();
      // The registry/keychain read yielded; never let an older result win.
      if (requestedVersion !== this.rebuildVersion) return;

      this.applyRegistry(registry);
    });

    // Keep the serialization chain usable after a caller observes a read
    // failure through its own returned promise.
    this.rebuildTail = task.catch(() => {});
    return task;
  }

  /** Reconcile one already-read registry snapshot into the live service map. */
  private applyRegistry(reg: AccountRegistry): void {
    const seen = new Set<string>();
    const removedAccountIds: string[] = [];
    const identityChangedAccountIds: string[] = [];
    for (const spec of reg.accounts) {
      seen.add(spec.id);
      const existing = this.perAccount.get(spec.id);
      if (existing) {
        if (hasMaterialAccountIdentityChange(existing.spec, spec)) {
          // An ID can be edited to point at an entirely different mailbox.
          // Reusing a connected IMAP client or SMTP transporter would retain
          // the old endpoint/credentials until restart, so replace both
          // services atomically in the registry and tear the old pair down.
          identityChangedAccountIds.push(spec.id);
          this.invalidateConnection(spec.id);
          this.perAccount.set(spec.id, this.createServices(spec));
          void this.retireServices(existing);
          this.emit("account-services-replaced", { accountId: spec.id, services: this.getForAccount(spec.id) });
          continue;
        }
        // Patch the spec into the existing services so credential
        // changes propagate without a reconnect.
        const nextSpec = cloneAccountSpec(spec);
        const imapSettingsChanged = hasImapConnectionSettingsChange(existing.spec, nextSpec);
        const smtpSettingsChanged = hasSmtpConnectionSettingsChange(existing.spec, nextSpec);
        if (imapSettingsChanged) {
          // The service instance remains valid for a password/certificate
          // edit, but an in-flight connect must not start IDLE with the old
          // arguments after this newer spec has been applied. Stop the old
          // IDLE loop now and put its disconnect/wipe ahead of any fresh
          // connect queued by the settings server.
          this.invalidateConnection(spec.id);
          this.queueImapRefresh(spec.id, existing);
        }
        existing.spec = nextSpec;
        if (smtpSettingsChanged) {
          existing.smtp["config"] = specToRuntimeConfig(nextSpec);
          existing.smtp.reinitialize();
        }
        continue;
      }
      this.perAccount.set(spec.id, this.createServices(spec));
    }
    // Tear down services for deleted accounts.
    for (const [id, svcs] of this.perAccount) {
      if (seen.has(id)) continue;
      this.perAccount.delete(id);
      removedAccountIds.push(id);
      this.invalidateConnection(id);
      void this.retireServices(svcs);
      this.pruneConnectionState(id);
    }
    this.applyActiveAccountId(reg.activeAccountId);
    this.emit("accounts-rebuilt", {
      accountIds: [...this.perAccount.keys()],
      removedAccountIds,
      identityChangedAccountIds,
    } satisfies AccountsRebuiltEvent);
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

  /** Opaque durable identity for cache/queue ownership checks. */
  identityForAccount(accountId: string): string {
    return accountIdentityFingerprint(this.getForAccount(accountId).spec);
  }

  /** Enumerate all accounts the manager knows about. */
  list(): AccountServices[] { return [...this.perAccount.values()]; }

  /**
   * Connect/reconnect exactly one account using its current spec.
   *
   * A settings save can replace a service while its prior connect() is
   * awaiting the network. Queue connects by account and verify the service
   * identity/version after the await, so that old socket can never launch a
   * new IDLE loop after it has been retired or reconfigured.
   */
  async connectAccount(accountId: string): Promise<void> {
    // Preserve the public unknown-account failure before queuing any work.
    const services = this.getForAccount(accountId);
    const version = this.connectionVersions.get(accountId) ?? 0;
    return this.enqueueConnectionTask(accountId, () =>
      this.connectCurrentAccount(accountId, services, version),
    );
  }

  /**
   * Hot-swap the active account. Rewires the active pointer and emits
   * "active-changed" so any subscribers (module-level re-bindings, tray
   * updaters) can react. No service teardown — the prior account's
   * clients remain warm for future per-call routing.
   */
  async setActive(accountId: string): Promise<void> {
    if (!this.perAccount.has(accountId)) throw new Error(`Unknown account id: ${accountId}`);
    this.applyActiveAccountId(accountId);
  }

  /**
   * Keep rebuilds and explicit switches on the same transition path. A rebuild
   * can change the persisted active id before `setActive()` is called; emitting
   * here ensures subscribers still rebind their account-scoped dependencies.
   */
  private applyActiveAccountId(requestedId: string): void {
    const next = this.perAccount.has(requestedId)
      ? requestedId
      : this.perAccount.size > 0
        ? this.perAccount.keys().next().value ?? ""
        : "";
    const prev = this._activeAccountId;
    if (prev === next) return;

    this._activeAccountId = next;
    // Construction has no subscribers yet; avoid a misleading startup
    // transition/notification. Every later real account change emits.
    if (!prev || !next) return;

    logger.info(`Active account hot-swapped: ${prev} → ${next}`, "AccountManager");
    this.emit("active-changed", { prev, next, services: this.getActive() });
    // A grant-style notification so the tray/UI pick it up alongside agent events.
    grantNotifications.emit("active-account-changed", { prev, next });
  }

  /**
   * Cleanly retire every account's services. Called on shutdown.
   *
   * This also waits for a connect already in flight: it is invalidated before
   * retirement, then detects that it lost ownership when its network await
   * resolves. The process-level shutdown timeout remains the final guard for
   * a network implementation that never settles its connect/disconnect.
   */
  async closeAll(): Promise<void> {
    const retirements: Promise<void>[] = [];
    for (const [accountId, svcs] of this.perAccount) {
      this.invalidateConnection(accountId);
      retirements.push(this.retireServices(svcs));
    }
    // A failed connect is expected during shutdown when Bridge is unavailable;
    // cleanup must continue rather than rejecting before every service is
    // scrubbed and the process can release its singleton lock.
    await Promise.allSettled([...retirements, ...this.connectTails.values()]);
    // A stale connect can schedule one last retirement after the first set
    // settles; include it before declaring shutdown hygiene complete.
    await Promise.allSettled([...this.retirementTasks]);
  }

  /**
   * Synchronous, best-effort credential/cache scrub for last-resort exit
   * hooks. It deliberately does not await network shutdown; `closeAll()` is
   * the graceful path and should run first whenever possible.
   */
  wipeAll(): void {
    for (const [accountId, svcs] of this.perAccount) {
      this.invalidateConnection(accountId);
      this.retiredServices.add(svcs);
      this.stopIdle(svcs);
      this.wipeImap(svcs);
      this.wipeSmtp(svcs);
      this.scrubAccountSpec(svcs.spec);
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
    for (const [id] of this.perAccount) {
      try {
        await this.connectAccount(id);
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

  /** Run a connection only if its caller's service/version is still current. */
  private async connectCurrentAccount(
    accountId: string,
    services: AccountServices,
    version: number,
  ): Promise<void> {
    if (!this.isCurrentConnection(accountId, services, version)) return;

    const { imap, spec } = services;
    try {
      await imap.connect(
        spec.imapHost,
        spec.imapPort,
        spec.username,
        spec.password,
        spec.bridgeCertPath,
        spec.tlsMode === "ssl",
        !!spec.allowInsecureBridge,
      );
    } catch (error) {
      if (!this.isCurrentConnection(accountId, services, version)) {
        await this.cleanUpStaleConnect(accountId, services);
      }
      throw error;
    }

    if (!this.isCurrentConnection(accountId, services, version)) {
      await this.cleanUpStaleConnect(accountId, services);
      return;
    }

    try {
      void imap.startIdle().catch(err =>
        logger.debug(`IDLE startup failed for account "${accountId}"`, "AccountManager", err),
      );
    } catch (error) {
      // Service methods are async in production, but keep the manager robust
      // if a custom/test implementation throws before returning a promise.
      logger.debug(`IDLE startup failed for account "${accountId}"`, "AccountManager", error);
    }
  }

  private isCurrentConnection(accountId: string, services: AccountServices, version: number): boolean {
    return this.perAccount.get(accountId) === services
      && !this.retiredServices.has(services)
      && (this.connectionVersions.get(accountId) ?? 0) === version;
  }

  /** Stop the socket produced by a connection whose account state changed. */
  private async cleanUpStaleConnect(accountId: string, services: AccountServices): Promise<void> {
    if (this.perAccount.get(accountId) !== services || this.retiredServices.has(services)) {
      await this.retireServices(services);
      return;
    }

    // Same service, newer connection settings (for example a password
    // rotation). Keep the fresh AccountSpec/SMTP config, but clear the old
    // IMAP connection config and cache before the queued reconnect starts.
    this.stopIdle(services);
    await this.bestEffort(() => services.imap.disconnect());
    this.wipeImap(services);
  }

  private invalidateConnection(accountId: string): void {
    this.connectionVersions.set(accountId, (this.connectionVersions.get(accountId) ?? 0) + 1);
  }

  /**
   * Disconnect a still-current service after an operational IMAP setting
   * changes. It runs in the same per-account queue as connects, which keeps
   * a reconnect from racing the old client's logout/wipe.
   */
  private queueImapRefresh(accountId: string, services: AccountServices): void {
    this.stopIdle(services);
    void this.enqueueConnectionTask(accountId, async () => {
      if (this.perAccount.get(accountId) !== services || this.retiredServices.has(services)) {
        await this.retireServices(services);
        return;
      }
      await this.bestEffort(() => services.imap.disconnect());
      this.wipeImap(services);
    });
  }

  private enqueueConnectionTask(accountId: string, operation: () => Promise<void>): Promise<void> {
    const previous = this.connectTails.get(accountId);
    const afterPrevious = previous ? previous.catch(() => {}) : Promise.resolve();
    const task = afterPrevious.then(operation);
    this.connectTails.set(accountId, task);
    void task.then(
      () => this.finishConnectTask(accountId, task),
      () => this.finishConnectTask(accountId, task),
    );
    return task;
  }

  private finishConnectTask(accountId: string, task: Promise<void>): void {
    if (this.connectTails.get(accountId) !== task) return;
    this.connectTails.delete(accountId);
    this.pruneConnectionState(accountId);
  }

  /** Avoid retaining a generation counter for an account with no service or work. */
  private pruneConnectionState(accountId: string): void {
    if (!this.perAccount.has(accountId) && !this.connectTails.has(accountId)) {
      this.connectionVersions.delete(accountId);
    }
  }

  /** Fully retire a no-longer-current service pair and track its async closes. */
  private retireServices(services: AccountServices): Promise<void> {
    this.retiredServices.add(services);
    this.stopIdle(services);

    // Invoke the asynchronous closes first, then scrub synchronously. Both
    // services tolerate a second close, and immediate wiping means a hung
    // network logout cannot keep credentials/cached mail in process memory.
    const imapDisconnect = this.bestEffort(() => services.imap.disconnect());
    this.wipeImap(services);
    const smtpClose = this.bestEffort(() => services.smtp.close());
    this.wipeSmtp(services);
    this.scrubAccountSpec(services.spec);

    const task = Promise.all([imapDisconnect, smtpClose]).then(() => undefined);
    this.retirementTasks.add(task);
    void task.then(
      () => this.retirementTasks.delete(task),
      () => this.retirementTasks.delete(task),
    );
    return task;
  }

  private stopIdle(services: AccountServices): void {
    try { services.imap.stopIdle(); } catch { /* best effort */ }
  }

  private wipeImap(services: AccountServices): void {
    try { services.imap.wipeCache(); } catch { /* best effort */ }
  }

  private wipeSmtp(services: AccountServices): void {
    try { services.smtp.wipeCredentials(); } catch { /* best effort */ }

    // SMTPService owns a ProtonMailConfig containing an IMAP-shaped sibling
    // object as well. Its public wipeCredentials() scrubs SMTP auth; zero the
    // sibling and endpoint fields too so a retired service cannot retain the
    // old account through that runtime config object.
    const config = services.smtp["config"] as ProtonMailConfig | null | undefined;
    if (!config) return;
    if (config.smtp) {
      config.smtp.host = "";
      config.smtp.port = 0;
      config.smtp.secure = false;
      config.smtp.username = "";
      config.smtp.password = "";
      config.smtp.smtpToken = undefined;
      config.smtp.bridgeCertPath = undefined;
      config.smtp.allowInsecureBridge = undefined;
    }
    if (config.imap) {
      config.imap.host = "";
      config.imap.port = 0;
      config.imap.secure = false;
      config.imap.username = "";
      config.imap.password = "";
      config.imap.bridgeCertPath = undefined;
      config.imap.allowInsecureBridge = undefined;
    }
    config.autoStartBridge = undefined;
    config.bridgePath = undefined;
  }

  /** Zero the manager-owned spec after its service pair is no longer usable. */
  private scrubAccountSpec(spec: AccountSpec): void {
    spec.id = "";
    spec.name = "";
    spec.providerType = "imap";
    spec.smtpHost = "";
    spec.smtpPort = 0;
    spec.imapHost = "";
    spec.imapPort = 0;
    spec.username = "";
    spec.password = "";
    spec.smtpToken = undefined;
    spec.bridgeCertPath = undefined;
    spec.allowInsecureBridge = undefined;
    spec.tlsMode = undefined;
    spec.autoStartBridge = undefined;
    spec.bridgePath = undefined;
    spec.lastCheckedAt = undefined;
    spec.lastCheckResult = undefined;
  }

  private bestEffort(operation: () => Promise<void>): Promise<void> {
    try {
      return Promise.resolve(operation()).catch(() => {});
    } catch {
      return Promise.resolve();
    }
  }

  private createServices(spec: AccountSpec): AccountServices {
    const runtimeSpec = cloneAccountSpec(spec);
    return {
      spec: runtimeSpec,
      imap: new SimpleIMAPService(),
      smtp: new SMTPService(specToRuntimeConfig(runtimeSpec)),
    };
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
