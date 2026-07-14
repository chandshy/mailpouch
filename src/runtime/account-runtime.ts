/**
 * Account-owned runtime state.
 *
 * Mailbox data must never be shared merely because two accounts are served by
 * the same MCP process.  This registry owns the in-memory analytics cache and
 * the on-disk FTS index for each account, while the AccountManager continues
 * to own the IMAP/SMTP connections themselves.
 */

import { chmodSync, existsSync, mkdirSync, renameSync } from "fs";
import nodePath from "path";
import { createHash } from "crypto";
import { AnalyticsService } from "../services/analytics-service.js";
import { FtsIndexService, openFtsIndex } from "../services/fts-service.js";
import type { SimpleIMAPService } from "../services/simple-imap-service.js";
import type { EmailMessage } from "../types/index.js";
import { logger } from "../utils/logger.js";

export interface AccountAnalyticsCache {
  inbox: EmailMessage[];
  sent: EmailMessage[];
  fetchedAt: number;
}

/** Last known SMTP health for one account; never share this across mailboxes. */
export interface AccountSmtpStatus {
  connected: boolean;
  lastCheck: Date;
  error?: string;
}

interface AccountRuntime {
  analyticsService: AnalyticsService;
  analyticsCache: AccountAnalyticsCache | null;
  analyticsInflight: { generation: number; promise: Promise<{ inbox: EmailMessage[]; sent: EmailMessage[] }> } | null;
  generation: number;
  fts: FtsIndexService | null;
  smtpStatus: AccountSmtpStatus;
}

export interface AccountRuntimeRegistryOptions {
  /** The old, unowned single-account FTS filename. It is archived on first FTS use. */
  legacyFtsPath: string;
  analyticsCacheTtlMs?: number;
  createAnalyticsService?: () => AnalyticsService;
  openFtsIndex?: (path: string) => FtsIndexService;
  now?: () => number;
}

/**
 * One process can host several mailboxes.  Keep each account's derived data
 * in a separate runtime bucket so an explicit `account_id` never observes the
 * active/default account's cache or FTS rows.
 */
export class AccountRuntimeRegistry {
  private readonly runtimes = new Map<string, AccountRuntime>();
  private readonly analyticsCacheTtlMs: number;
  private readonly createAnalyticsService: () => AnalyticsService;
  private readonly openFts: (path: string) => FtsIndexService;
  private readonly now: () => number;
  private legacyFtsHandled = false;

  constructor(private readonly options: AccountRuntimeRegistryOptions) {
    this.analyticsCacheTtlMs = options.analyticsCacheTtlMs ?? 5 * 60 * 1000;
    this.createAnalyticsService = options.createAnalyticsService ?? (() => new AnalyticsService());
    this.openFts = options.openFtsIndex ?? openFtsIndex;
    this.now = options.now ?? Date.now;
  }

  private runtime(accountId: string): AccountRuntime {
    let runtime = this.runtimes.get(accountId);
    if (!runtime) {
      runtime = {
        analyticsService: this.createAnalyticsService(),
        analyticsCache: null,
        analyticsInflight: null,
        generation: 0,
        fts: null,
        smtpStatus: { connected: false, lastCheck: new Date(0) },
      };
      this.runtimes.set(accountId, runtime);
    }
    return runtime;
  }

  getAnalyticsService(accountId: string): AnalyticsService {
    return this.runtime(accountId).analyticsService;
  }

  getSmtpStatus(accountId: string): AccountSmtpStatus {
    const status = this.runtime(accountId).smtpStatus;
    return { ...status };
  }

  setSmtpStatus(accountId: string, status: AccountSmtpStatus): void {
    this.runtime(accountId).smtpStatus = { ...status };
  }

  /**
   * Fetch a mailbox's analytics source data.  The cache and in-flight promise
   * are account-owned, and an invalidation generation prevents a stale fetch
   * from repopulating the cache after a mutation.
   */
  async getAnalyticsEmails(
    accountId: string,
    imapService: Pick<SimpleIMAPService, "getEmails">,
    trim: (emails: EmailMessage[]) => EmailMessage[],
  ): Promise<{ inbox: EmailMessage[]; sent: EmailMessage[] }> {
    const runtime = this.runtime(accountId);
    const now = this.now();
    if (runtime.analyticsCache && now - runtime.analyticsCache.fetchedAt < this.analyticsCacheTtlMs) {
      return { inbox: runtime.analyticsCache.inbox, sent: runtime.analyticsCache.sent };
    }
    if (runtime.analyticsInflight && runtime.analyticsInflight.generation === runtime.generation) {
      return runtime.analyticsInflight.promise;
    }

    const generation = runtime.generation;
    let inflight!: NonNullable<AccountRuntime["analyticsInflight"]>;
    const promise = Promise.resolve().then(async () => {
      try {
        // A transient IMAP failure should not turn a read-only analytics tool
        // into a process-level error. The next call can refill the cache.
        const [inbox, sent] = await Promise.all([
          imapService.getEmails("INBOX", 200).catch(() => [] as EmailMessage[]),
          imapService.getEmails("Sent", 100).catch(() => [] as EmailMessage[]),
        ]);
        if (this.runtimes.get(accountId) === runtime && runtime.generation === generation) {
          const trimmedInbox = trim(inbox);
          const trimmedSent = trim(sent);
          runtime.analyticsCache = { inbox: trimmedInbox, sent: trimmedSent, fetchedAt: this.now() };
          runtime.analyticsService.updateEmails(trimmedInbox, trimmedSent);
        }
        return { inbox, sent };
      } finally {
        if (runtime.analyticsInflight === inflight) runtime.analyticsInflight = null;
      }
    });
    inflight = { generation, promise };
    runtime.analyticsInflight = inflight;
    return promise;
  }

  /** Update analytics from a background sync without claiming it is a full cache fill. */
  updateAnalytics(accountId: string, inbox: EmailMessage[], sent: EmailMessage[], trim: (emails: EmailMessage[]) => EmailMessage[]): void {
    const runtime = this.runtime(accountId);
    runtime.analyticsService.updateEmails(trim(inbox), trim(sent));
  }

  /** Invalidate only the mailbox that was changed by a tool call. */
  invalidateAnalytics(accountId: string): void {
    const runtime = this.runtime(accountId);
    runtime.generation++;
    runtime.analyticsCache = null;
    runtime.analyticsInflight = null;
    runtime.analyticsService.clearCache();
  }

  /** Snapshot token for a background read before it starts touching a mailbox. */
  generationFor(accountId: string): number {
    return this.runtime(accountId).generation;
  }

  /** Whether an asynchronous read still belongs to the current mailbox identity. */
  isCurrentGeneration(accountId: string, generation: number): boolean {
    return this.runtimes.get(accountId)?.generation === generation;
  }

  /**
   * Forget data derived from a mailbox whose account ID was repointed.
   *
   * The FTS owner marker protects reopen-after-restart. Clear only through
   * the current owner's SQLite transaction: deleting the shared DB pathname
   * directly could erase a successor process's newly rebound index.
   */
  resetMailbox(accountId: string): void {
    const runtime = this.runtime(accountId);
    runtime.generation++;
    runtime.analyticsCache = null;
    runtime.analyticsInflight = null;
    runtime.analyticsService.wipeData();
    // A repointed (including non-active) account must not retain the prior
    // mailbox's health result in diagnostics after its services are replaced.
    runtime.smtpStatus = { connected: false, lastCheck: new Date(0) };

    if (runtime.fts) {
      try { runtime.fts.clear(); }
      catch (err: unknown) {
        // A different process may already own this on-disk index. Its durable
        // marker blocks reads/writes from this stale instance, so closing it is
        // safe; never unlink a path we no longer own.
        logger.warn(`Could not clear account FTS during mailbox reset for ${accountId}`, "AccountRuntime", err);
      }
      runtime.fts.close();
      runtime.fts = null;
    }
  }

  /**
   * Return an account-specific FTS database.  The former singleton database
   * contained untagged plaintext mail, so it is deliberately archived instead
   * of being assigned to whichever account happens to be active at migration.
   * A normal sync/rebuild repopulates the new account-owned index.
   */
  getFts(accountId: string, accountIdentity: string): FtsIndexService {
    const runtime = this.runtime(accountId);
    if (!runtime.fts) {
      this.archiveLegacyFtsOnce();
      const path = this.ftsPathFor(accountId);
      runtime.fts = this.openFts(path);
    }
    runtime.fts.ensureOwnerIdentity(accountIdentity);
    return runtime.fts;
  }

  /** Stable opaque filename: avoids account IDs becoming path syntax or metadata leaks. */
  ftsPathFor(accountId: string): string {
    const legacyPath = this.options.legacyFtsPath;
    const parsed = nodePath.parse(legacyPath);
    const suffix = parsed.ext || ".db";
    const dir = nodePath.join(parsed.dir, `${parsed.name}.accounts`);
    this.ensurePrivateDirectory(dir);
    const hash = createHash("sha256").update(accountId).digest("hex").slice(0, 32);
    return nodePath.join(dir, `${hash}${suffix}`);
  }

  private ensurePrivateDirectory(dir: string): void {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    try { chmodSync(dir, 0o700); } catch { /* best effort on platforms without POSIX modes */ }
  }

  private archiveLegacyFtsOnce(): void {
    if (this.legacyFtsHandled) return;
    this.legacyFtsHandled = true;
    const legacyPath = this.options.legacyFtsPath;
    if (!existsSync(legacyPath)) return;

    // The WAL and shared-memory files are part of the same sensitive index.
    // Keep them beside the archived DB for forensic recovery, but never reopen
    // them as a live index because no account ownership exists in that schema.
    const stamp = new Date(this.now()).toISOString().replace(/[:.]/g, "-");
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      const source = `${legacyPath}${suffix}`;
      if (!existsSync(source)) continue;
      const target = `${legacyPath}.legacy-unowned-${stamp}${suffix}`;
      try {
        renameSync(source, target);
        try { chmodSync(target, 0o600); } catch { /* best effort */ }
      } catch (err: unknown) {
        // Do not fall back to the unowned index: a failed archive can only
        // delay cleanup, whereas reusing it could expose another mailbox.
        logger.warn(`Could not archive legacy unowned FTS file ${source}; it will not be used`, "AccountRuntime", err);
      }
    }
    logger.info("Archived legacy unowned FTS index; rebuild account indexes to repopulate search", "AccountRuntime");
  }

  /** Drop one deleted account's derived state and scrub its in-memory analytics. */
  disposeAccount(accountId: string): void {
    const runtime = this.runtimes.get(accountId);
    if (!runtime) return;
    runtime.analyticsService.wipeData();
    runtime.fts?.close();
    this.runtimes.delete(accountId);
  }

  /** Scrub runtimes for accounts removed from the persisted registry. */
  disposeAccountsExcept(accountIds: Iterable<string>): void {
    const live = new Set(accountIds);
    for (const accountId of this.runtimes.keys()) {
      if (!live.has(accountId)) this.disposeAccount(accountId);
    }
  }

  /** Shutdown hygiene for all derived mailbox data held in this process. */
  disposeAll(): void {
    for (const accountId of this.runtimes.keys()) this.disposeAccount(accountId);
  }
}
