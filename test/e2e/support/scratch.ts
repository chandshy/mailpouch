/**
 * Scratch namespace and ownership guard for non-destructive Bridge E2E runs.
 *
 * Folder ownership and message ownership are deliberately independent:
 * folders must match the run's anchored Folders/Labels namespace, while every
 * message carries an exact, UUID-backed run header. Cleanup only moves and
 * purges messages carrying that header. A non-owned message in a scratch
 * folder therefore makes cleanup retain the folder instead of touching mail
 * which the run did not create.
 */

import { randomUUID } from "node:crypto";
import type { CreatedMailboxProof } from "./ownership-manifest.js";
import { raceWithDeadline } from "./deadline-race.mjs";
import { isFatalCleanupError } from "./mutation-result.mjs";

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const TOKEN_RE = new RegExp(`^mpE2E-${UUID_SOURCE}$`);

/** Header injected into every message owned by a safe E2E run. */
export const E2E_OWNERSHIP_HEADER = "X-MailPouch-E2E-Run";

/** A cryptographically random, path-safe token embeddable in folder names. */
export function runToken(): string {
  return `mpE2E-${randomUUID()}`;
}

export function isRunToken(token: string): boolean {
  return typeof token === "string" && TOKEN_RE.test(token);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** True only for a direct child of Folders/ or Labels/ in this run's grammar. */
export function isScratchPath(path: string, token: string): boolean {
  if (!isRunToken(token) || typeof path !== "string") return false;
  const tokenPart = escapeRegExp(token);
  return new RegExp(
    `^(?:Folders|Labels)/${tokenPart}(?:-[A-Za-z0-9][A-Za-z0-9._-]*| spaced [1-9][0-9]*)$`,
  ).test(path);
}

/** Refuse reserved/system paths, nested paths, malformed tokens, and other runs. */
export function assertScratch(path: string, token: string): void {
  if (!isScratchPath(path, token)) {
    throw new Error(
      `Scratch guard REFUSED "${path}": expected an anchored Folders/ or Labels/ path owned by run "${token}".`,
    );
  }
}

/** Deterministic discovery order for live cleanup. This is only a read-order
 * hint: every mutation is still authorized by a fresh exact-ownership proof. */
function cleanupSourceRank(path: string, token: string): number {
  if (isScratchPath(path, token)) return 0;
  const common = ["inbox", "archive", "drafts", "sent", "spam"];
  const normalized = path.trim().toLowerCase();
  const commonIndex = common.indexOf(normalized);
  if (commonIndex >= 0) return 10 + commonIndex;
  if (/^(?:starred|important)$/i.test(path.trim())) return 30;
  return 20;
}

/** Proton exposes these as projected category mailboxes. MOVE can hang or
 * return no explicit result even for an exact-owned UID, while UID DELETE is
 * the supported way to remove the exact E2E-created projection. */
function requiresDirectOwnedDelete(path: string): boolean {
  return /^(?:starred|important)$/i.test(path.trim());
}

export interface OwnedMoveResult {
  moved: number;
  remainingOwned: number;
  remainingTotal: number;
}

/** Minimal IMAP surface needed by ScratchSession. */
export interface ScratchImap {
  createMailbox(path: string, exclusive?: boolean): Promise<void>;
  listMailboxes(): Promise<string[]>;
  listCleanupMailboxes(): Promise<string[]>;
  trashMailbox(): Promise<string>;
  allMailMailbox?(paths?: string[]): Promise<string | null>;
  deleteMailbox(path: string, expectedUidValidity?: string): Promise<void>;
  /** Release the long-lived assertion session before disposable-server mailbox DELETEs. */
  prepareMailboxDeletion?(): Promise<void>;
  /** Reopen the IMAP session so eventually-consistent Bridge projections are
   * read from a fresh server session on each reconciliation round. */
  refreshCleanupSession?(): Promise<void>;
  /** Force-close the cleanup session so an in-flight IMAP command cannot
   * continue after the absolute convergence deadline. */
  abortCleanupSession(reason?: string): void;
  /** Activate automatic ownership-header injection for appendSeed(). */
  setOwnershipToken?(token: string): void;
  /** Remove the durable crash-cleanup manifest after verified cleanup. */
  completeOwnershipRun?(token: string): void;
  /** Pending tool-created messages need a full delivery grace before cleanup
   * may conclude that no later Sent/Inbox projection will arrive. */
  pendingOwnershipProofCount?(): number;
  /** Durably record and query positive mailbox-creation proof. */
  recordCreatedMailbox?(path: string, token: string): Promise<CreatedMailboxProof>;
  createdMailboxProof?(path: string, token: string): Promise<CreatedMailboxProof | undefined>;
  /** Move only exact run-owned messages from folder to Trash. */
  moveOwnedToTrash(folder: string, token: string): Promise<OwnedMoveResult>;
  deleteOwnedMessages(folder: string, token: string): Promise<OwnedMoveResult>;
  /** Permanently delete only exact run-owned messages from Trash. */
  purgeOwnedTrash(token: string): Promise<number>;
  countMessages(folder: string): Promise<number>;
  ownedMessageCount(folder: string, token: string): Promise<number>;
  trashOwnedMessageCount(token: string): Promise<number>;
}

export type ScratchKind = "folders" | "labels" | "spaced";

export interface ScratchCleanupReport {
  ok: boolean;
  deleted: string[];
  retained: string[];
  /** Positively-created, identity-matched, empty live-mail folders which were
   * deliberately retained because IMAP has no atomic delete-if-empty command. */
  manualFolderCleanup: string[];
  residue: string[];
  errors: string[];
  purgedMessages: number;
  ownedMessageResidue: Record<string, number>;
  /** Structured reason that requires a new process/session before cleanup may
   * continue. Callers must never infer this authority from error text. */
  fatalErrorCode?:
    | "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN"
    | "MAILPOUCH_E2E_CLEANUP_TIMEOUT"
    | "MAILPOUCH_E2E_ALL_MAIL_RESCUE_REQUIRED";
}

export interface ScratchCleanupOptions {
  /** Optional already-guarded deletion path (normally the MCP delete_folder
   * tool). Useful for servers that require deletion on the session which
   * created or most recently selected the mailbox. Refused by deadline-bound
   * Bridge cleanup because an external callback has no synchronous abort hook. */
  deleteMailbox?: (path: string) => Promise<void>;
  /** Disposable-server escape hatch for Greenmail's stale-selected-mailbox
   * DELETE bug. Messages are still removed and verified; only empty strict
   * token folders may remain until the container is restarted. Never enable
   * this for a live Bridge mailbox. */
  retainEmptyFolders?: boolean;
  /** Allow Bridge's virtual folders to converge after Trash expunge before
   * the final exact-ownership audit. */
  settleAfterPurgeMs?: number;
  /** Keep the crash manifest until the caller's independent baseline audit has
   * also succeeded. */
  deferOwnershipCompletion?: boolean;
}

/** Owns one run's strictly named scratch mailboxes. */
export class ScratchSession {
  readonly token: string;
  private seq = 0;
  private readonly created = new Map<string, string>();

  constructor(private readonly imap: ScratchImap, token: string = runToken()) {
    if (!isRunToken(token)) {
      throw new Error(`Invalid E2E run token "${token}"; expected mpE2E-<UUIDv4>.`);
    }
    this.token = token;
  }

  private bindOwnership(): void {
    this.imap.setOwnershipToken?.(this.token);
  }

  path(kind: ScratchKind = "folders"): string {
    const n = ++this.seq;
    if (kind === "labels") return `Labels/${this.token}-${n}`;
    if (kind === "spaced") return `Folders/${this.token} spaced ${n}`;
    return `Folders/${this.token}-${n}`;
  }

  /** Create exclusively so an EXISTS race can never be claimed by this run. */
  async create(kind: ScratchKind = "folders"): Promise<string> {
    this.bindOwnership();
    const path = this.path(kind);
    assertScratch(path, this.token);
    await this.imap.createMailbox(path, true);
    await this.claimCreated(path);
    return path;
  }

  /** Claim a mailbox only after its CREATE returned explicit created:true and
   * bind that claim to the selected mailbox's UIDVALIDITY. */
  async claimCreated(path: string): Promise<void> {
    assertScratch(path, this.token);
    this.bindOwnership();
    if (!this.imap.recordCreatedMailbox) {
      throw new Error("Scratch mailbox creation cannot be claimed without durable ownership storage");
    }
    const proof = await this.imap.recordCreatedMailbox(path, this.token);
    if (proof.path !== path || !proof.uidValidity) {
      throw new Error(`Scratch mailbox creation for ${path} returned no identity-bound proof`);
    }
    this.created.set(path, proof.uidValidity);
  }

  private async createdMailboxProof(path: string): Promise<CreatedMailboxProof | undefined> {
    const expectedUidValidity = this.created.get(path);
    if (!this.imap.createdMailboxProof) return undefined;
    const proof = await this.imap.createdMailboxProof(path, this.token);
    if (!proof || proof.path !== path) return undefined;
    return expectedUidValidity === undefined || proof.uidValidity === expectedUidValidity
      ? proof
      : undefined;
  }

  private async deleteProvenMailbox(
    path: string,
    proof: CreatedMailboxProof,
    options: ScratchCleanupOptions,
  ): Promise<void> {
    if (options.deleteMailbox) {
      await options.deleteMailbox(path);
      return;
    }
    await this.imap.deleteMailbox(path, proof.uidValidity);
  }

  /** Abort when this exact anchored namespace already exists. */
  async preflight(): Promise<void> {
    const existing = await this.imap.listMailboxes();
    const clash = existing.filter((path) => isScratchPath(path, this.token));
    if (clash.length) {
      throw new Error(`Scratch preflight: run token "${this.token}" already owns [${clash.join(", ")}] — aborting.`);
    }
  }

  /**
   * Remove only artifacts proven to belong to this run.
   *
   * For each scratch mailbox, remove only run-owned UIDs. Disposable-server
   * cleanup may delete a positively-created mailbox after proving it empty;
   * deadline-bound live cleanup instead retains and reports the verified-empty
   * folder because IMAP cannot atomically condition DELETE on emptiness. Any
   * unowned message leaves the mailbox standing. A final relist and ownership
   * count make partial failures visible instead of silently declaring success.
   */
  async cleanup(options: ScratchCleanupOptions = {}): Promise<ScratchCleanupReport> {
    const report: ScratchCleanupReport = {
      ok: false,
      deleted: [],
      retained: [],
      manualFolderCleanup: [],
      residue: [],
      errors: [],
      purgedMessages: 0,
      ownedMessageResidue: {},
    };

    // Start the Bridge deadline before the first LIST/Trash resolution. Those
    // network calls are part of cleanup and must not sit outside its budget.
    if ((options.settleAfterPurgeMs ?? 0) > 0) {
      return this.cleanupEventuallyConsistent(report, options);
    }

    let allMailboxes: string[];
    let mine: string[];
    let trash: string;
    let allMail: string | undefined;
    try {
      allMailboxes = await this.imap.listCleanupMailboxes();
      trash = await this.imap.trashMailbox();
      allMail = (await this.imap.allMailMailbox?.(allMailboxes))
        ?? allMailboxes.find((path) => /^all mail$/i.test(path.trim()));
      mine = allMailboxes
        .filter((path) => isScratchPath(path, this.token))
        .sort((a, b) => b.length - a.length);
    } catch (error) {
      report.errors.push(`list scratch mailboxes failed: ${errorMessage(error)}`);
      return report;
    }

    // Proton Bridge projects several eventually-consistent views of one
    // message (Folders, Labels, categories, Trash, and All Mail). A successful
    // exact-UID mutation can therefore remain visible when immediately
    // reselected. Reconcile those views until two complete ownership scans are
    // clean; never turn a transient first-pass count into a permanent failure.
    const mineSet = new Set(mine);
    const allowedEmptyResidue = new Set<string>();
    // Scratch folders first; virtual aggregate folders (especially All Mail)
    // last, after the owned messages have been removed from concrete folders.
    const work = allMailboxes
      .filter((path) => path !== trash)
      .sort((left, right) => {
        const leftRank = mineSet.has(left) ? 0 : left === allMail ? 2 : 1;
        const rightRank = mineSet.has(right) ? 0 : right === allMail ? 2 : 1;
        return leftRank - rightRank || right.length - left.length;
      });
    for (const path of work) {
      const scratchPath = mineSet.has(path);
      const allMailView = path === allMail;
      if (scratchPath) assertScratch(path, this.token);
      try {
        if (scratchPath && !options.retainEmptyFolders) {
          const totalBefore = await this.imap.countMessages(path);
          if (totalBefore === 0) {
            const creationProof = await this.createdMailboxProof(path);
            if (!creationProof) {
              report.errors.push(`${path}: retained because this run has no positive mailbox-creation proof`);
              report.retained.push(path);
              continue;
            }
            try {
              await this.deleteProvenMailbox(path, creationProof, options);
              report.deleted.push(path);
            } catch (error) {
              report.errors.push(`${path}: mailbox delete failed: ${errorMessage(error)}`);
              report.retained.push(path);
            }
            continue;
          }
        }
        // System folders can contain arbitrary real mail. Do not issue a move
        // at all unless an exact ownership query first proves this run has
        // UIDs. Bridge's All Mail and category folders may reject/no-op the
        // move; All Mail is deferred to the final post-purge audit, while
        // Starred/Important use exact-owned UID DELETE directly.
        if (!scratchPath && (await this.imap.ownedMessageCount(path, this.token)) === 0) continue;
        if (allMailView) continue;
        let cleaned: OwnedMoveResult;
        try {
          const primary = (): Promise<OwnedMoveResult> =>
            (options.retainEmptyFolders && scratchPath) || requiresDirectOwnedDelete(path)
              ? this.imap.deleteOwnedMessages(path, this.token)
              : this.imap.moveOwnedToTrash(path, this.token);
          // Mutations dispatch in single-UID batches (BRIDGE_MUTATION_UID_BATCH_SIZE),
          // so one call clears at most one owned message. Drain until an
          // ownership rescan reports zero or a call stops making progress;
          // a stalled scan falls through to the fail-closed residue report.
          cleaned = await primary();
          while (cleaned.remainingOwned > 0) {
            const next = await primary();
            cleaned = {
              moved: cleaned.moved + next.moved,
              remainingOwned: next.remainingOwned,
              remainingTotal: next.remainingTotal,
            };
            if (next.moved === 0) break;
          }
          // Proton can implement MOVE from folders/labels as a copy into Trash
          // while retaining the source association. Remove only the exact
          // owned UIDs from that source so Trash becomes the sole real mailbox;
          // All Mail is an immutable aggregate and is skipped above.
          while (cleaned.remainingOwned > 0) {
            const removed = await this.imap.deleteOwnedMessages(path, this.token);
            cleaned = {
              moved: cleaned.moved + removed.moved,
              remainingOwned: removed.remainingOwned,
              remainingTotal: removed.remainingTotal,
            };
            if (removed.moved === 0) break;
          }
        } catch (error) {
          if (!scratchPath) continue;
          throw error;
        }
        report.purgedMessages += cleaned.moved;
        if (cleaned.remainingOwned > 0) {
          if (!scratchPath) continue;
          report.errors.push(`${path}: ${cleaned.remainingOwned} owned message(s) could not be cleaned`);
          report.retained.push(path);
          continue;
        }
        if (!scratchPath) continue;
        // The folder may contain mail not created by this run. Never touch it.
        if (cleaned.remainingTotal > 0) {
          report.errors.push(`${path}: retained because it contains ${cleaned.remainingTotal} non-owned message(s)`);
          report.retained.push(path);
          continue;
        }
        // Verify independently rather than trusting MOVE's response counters.
        // ImapFixtures uses one connection, so keep mailbox selections serial.
        const owned = await this.imap.ownedMessageCount(path, this.token);
        const total = await this.imap.countMessages(path);
        if (owned !== 0 || total !== 0) {
          report.errors.push(`${path}: post-move verification found ${owned} owned / ${total} total message(s)`);
          report.retained.push(path);
          continue;
        }
        if (options.retainEmptyFolders) {
          allowedEmptyResidue.add(path);
          report.retained.push(path);
          continue;
        }
        const creationProof = await this.createdMailboxProof(path);
        if (!creationProof) {
          report.errors.push(`${path}: retained because this run has no positive mailbox-creation proof`);
          report.retained.push(path);
          continue;
        }
        // Delete immediately while the fixture still owns the selected empty
        // mailbox. Greenmail leaves a stale server-side handle if that session
        // moves on to another mailbox first, causing every later DELETE to
        // terminate without a response. The path and emptiness proofs above
        // still gate this operation exactly as before.
        try {
          await this.deleteProvenMailbox(path, creationProof, options);
          report.deleted.push(path);
        } catch (error) {
          report.errors.push(`${path}: mailbox delete failed: ${errorMessage(error)}`);
          report.retained.push(path);
        }
      } catch (error) {
        report.errors.push(`${path}: cleanup failed: ${errorMessage(error)}`);
        if (scratchPath) report.retained.push(path);
      }
    }

    try {
      // purgeOwnedTrash deletes at most one single-UID batch per call; drain
      // until a fresh ownership scan finds nothing left to purge.
      // Bridge propagation is asynchronous; the final all-folder audit below
      // is authoritative after the configured settle window.
      let purged: number;
      do {
        purged = await this.imap.purgeOwnedTrash(this.token);
        report.purgedMessages += purged;
      } while (purged > 0);
    } catch (error) {
      report.errors.push(`purge owned Trash messages failed: ${errorMessage(error)}`);
    }

    if (report.purgedMessages > 0 && (options.settleAfterPurgeMs ?? 0) > 0) {
      const convergencePaths = [
        trash,
        allMail,
      ].filter((path): path is string => typeof path === "string");
      const deadline = Date.now() + (options.settleAfterPurgeMs ?? 0);
      while (true) {
        let remaining = 0;
        for (const path of convergencePaths) {
          remaining += await this.imap.ownedMessageCount(path, this.token);
        }
        if (remaining === 0 || Date.now() >= deadline) break;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }

    try {
      report.residue = (await this.imap.listMailboxes())
        .filter((path) => isScratchPath(path, this.token))
        .sort();
    } catch (error) {
      report.errors.push(`post-cleanup mailbox verification failed: ${errorMessage(error)}`);
    }

    try {
      for (const path of await this.imap.listCleanupMailboxes()) {
        const count = await this.imap.ownedMessageCount(path, this.token);
        if (count > 0) report.ownedMessageResidue[path] = count;
      }
      if (Object.keys(report.ownedMessageResidue).length > 0) {
        report.errors.push(`owned message residue remains in ${Object.keys(report.ownedMessageResidue).join(", ")}`);
      }
    } catch (error) {
      report.errors.push(`post-cleanup message verification failed: ${errorMessage(error)}`);
    }

    report.retained = [...new Set([...report.retained, ...report.residue])].sort();
    const residueAllowed = options.retainEmptyFolders === true
      && report.residue.every((path) => allowedEmptyResidue.has(path));
    report.ok = report.errors.length === 0
      && (report.residue.length === 0 || residueAllowed)
      && Object.keys(report.ownedMessageResidue).length === 0;
    if (report.ok) {
      if (!options.deferOwnershipCompletion) this.imap.completeOwnershipRun?.(this.token);
      this.created.clear();
    }
    return report;
  }

  private async cleanupEventuallyConsistent(
    report: ScratchCleanupReport,
    options: ScratchCleanupOptions,
  ): Promise<ScratchCleanupReport> {
    const settleMs = options.settleAfterPurgeMs ?? 0;
    if (options.deleteMailbox) {
      report.errors.push(
        "deadline-bound Bridge cleanup refuses an external mailbox-delete callback without an abort hook",
      );
      return report;
    }
    if (typeof this.imap.refreshCleanupSession !== "function") {
      report.errors.push(
        "deadline-bound Bridge cleanup requires refreshCleanupSession so every confirmation round uses a fresh authenticated session",
      );
      return report;
    }
    const startedAt = Date.now();
    const pollMs = Math.min(1_000, Math.max(1, Math.floor(settleMs / 10)));
    const pendingAtStart = (this.imap.pendingOwnershipProofCount?.() ?? 0) > 0;
    const pendingGraceDeadline = pendingAtStart ? startedAt + settleMs : startedAt;
    // Pending sends can surface at any point during the full delivery grace.
    // Reserve another full settle window for the two authoritative all-folder
    // scans: a Bridge profile with many folders can take far longer than two
    // poll intervals to complete even one scan.
    const deadline = startedAt + settleMs + (pendingAtStart ? settleMs : 0);
    let consecutiveCleanScans = 0;
    let consecutiveEnvironmentCleanScans = 0;
    let consecutiveAllMailOnlyScans = 0;
    let lastRoundErrors: string[] = [];
    let lastPendingProofCount = this.imap.pendingOwnershipProofCount?.() ?? 0;
    const emptyScratchProofs = new Map<string, { uidValidity: string; count: number }>();
    let deadlineExpired = false;
    const expireDeadline = (): void => {
      if (deadlineExpired) return;
      deadlineExpired = true;
      try {
        this.imap.abortCleanupSession(`Bridge cleanup exceeded its ${deadline - startedAt}ms absolute deadline`);
      } catch {
        // The deadline state remains authoritative even if a test double or an
        // already-torn-down transport rejects the best-effort socket abort.
      }
    };
    const isDeadlineExpired = (): boolean => {
      if (!deadlineExpired && Date.now() >= deadline) expireDeadline();
      return deadlineExpired;
    };
    const waitForFreshRound = async (): Promise<void> => {
      const remainingMs = Math.max(1, deadline - Date.now());
      await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
    };
    let trash: string | undefined;
    let pendingSourcePurge: string | undefined;
    let completedReport: ScratchCleanupReport | undefined;

    try {
      completedReport = await raceWithDeadline(async () => {
        try {
          trash = await this.imap.trashMailbox();
        } catch (error) {
          if (isFatalCleanupError(error)) throw error;
          lastRoundErrors = [`resolve Trash mailbox failed: ${errorMessage(error)}`];
        }
        if (isDeadlineExpired()) return undefined;

        while (trash && !isDeadlineExpired()) {
          const roundErrors: string[] = [];
          let mailboxes: string[] = [];
          try {
            await this.imap.refreshCleanupSession();
            if (!isDeadlineExpired()) mailboxes = await this.imap.listCleanupMailboxes();
          } catch (error) {
            if (isFatalCleanupError(error)) throw error;
            roundErrors.push(`list cleanup mailboxes failed: ${errorMessage(error)}`);
          }
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }

          const allMail = (await this.imap.allMailMailbox?.(mailboxes))
            ?? mailboxes.find((path) => /^all mail$/i.test(path.trim()));
          // A resolver may ignore the transport abort and settle after the
          // caller has already received a timeout report. Fence that abandoned
          // continuation before it can reach any destructive operation.
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }
          // Keep a fail-closed lightweight checkpoint for deadline reporting.
          // This is not an ownership audit and never authorizes mutation.
          report.residue = mailboxes
            .filter((path) => isScratchPath(path, this.token))
            .sort();
          report.retained = [...report.residue];
          const work = mailboxes
            // All Mail is a virtual projection whose UIDs Proton Bridge may
            // remap without changing UIDVALIDITY. Observe it during the final
            // audit, but never use one of its UIDs as a mutation operand.
            .filter((path) => path !== trash && path !== allMail)
            .sort((left, right) => {
              return cleanupSourceRank(left, this.token) - cleanupSourceRank(right, this.token)
                || right.length - left.length;
            });
          const touchedScratch = new Set<string>();
          // Rebuild this set from current-round observations. A path classified
          // as empty in an earlier session must not remain eligible after a
          // skipped or failed verification round.
          const manualFolderCleanup = new Set<string>();
          let roundMutated = false;

          // Trash is the highest-value concrete checkpoint. Clear an exact
          // owned Trash UID before either a remembered source checkpoint or a
          // broad source scan. A successful purge deliberately leaves the
          // source checkpoint intact for the next fresh session.
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }
          try {
            const purged = await this.imap.purgeOwnedTrash(this.token);
            if (!isDeadlineExpired()) {
              report.purgedMessages += purged;
              roundMutated = purged > 0;
            }
          } catch (error) {
            if (isFatalCleanupError(error)) throw error;
            roundErrors.push(`purge owned Trash messages failed: ${errorMessage(error)}`);
          }
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }
          if (roundMutated) {
            emptyScratchProofs.clear();
            consecutiveCleanScans = 0;
            consecutiveEnvironmentCleanScans = 0;
            consecutiveAllMailOnlyScans = 0;
            lastRoundErrors = roundErrors;
            await waitForFreshRound();
            continue;
          }

          // A source which just produced an owned mutation remains the first
          // reconciliation target until a fresh session proves it clean. This
          // avoids scanning every ordinary mailbox between singleton source
          // mutations while granting no authority beyond a new exact proof.
          if (pendingSourcePurge && !work.includes(pendingSourcePurge)) {
            pendingSourcePurge = undefined;
          }
          if (pendingSourcePurge) {
            const path = pendingSourcePurge;
            try {
              const removed = await this.imap.deleteOwnedMessages(path, this.token);
              if (isDeadlineExpired()) break;
              report.purgedMessages += removed.moved;
              if (removed.moved > 0) {
                roundMutated = true;
                if (isScratchPath(path, this.token)) touchedScratch.add(path);
              }
              if (removed.remainingOwned > 0) {
                report.ownedMessageResidue[path] = removed.remainingOwned;
              } else {
                delete report.ownedMessageResidue[path];
              }
              if (removed.remainingOwned === 0) pendingSourcePurge = undefined;
            } catch (error) {
              if (isFatalCleanupError(error)) throw error;
              roundErrors.push(`${path}: retained-source purge failed: ${errorMessage(error)}`);
            }
          }
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }
          if (roundMutated || pendingSourcePurge) {
            // Mutation methods checkpoint and rotate their one-shot session.
            // Start the next fresh round immediately; a comprehensive audit of
            // the old view is both correlated and prohibitively expensive.
            emptyScratchProofs.clear();
            consecutiveCleanScans = 0;
            consecutiveEnvironmentCleanScans = 0;
            consecutiveAllMailOnlyScans = 0;
            lastRoundErrors = roundErrors;
            await waitForFreshRound();
            continue;
          }

          for (const path of work) {
            if (isDeadlineExpired()) break;
            const scratchPath = isScratchPath(path, this.token);
            let sourceMutated = false;
            try {
              const ownedBefore = await this.imap.ownedMessageCount(path, this.token);
              // A read may settle after abort even when its transport ignored
              // close. Re-check before authorizing the next mutation.
              if (isDeadlineExpired()) break;
              if (ownedBefore > 0) {
                report.ownedMessageResidue[path] = ownedBefore;
                // Exact ownership has already been proven by the header/Message-ID
                // query. MOVE first gives Bridge a concrete Trash association that
                // a later reconciliation round can observe and expunge.
                const removed = requiresDirectOwnedDelete(path)
                  ? await this.imap.deleteOwnedMessages(path, this.token)
                  : await this.imap.moveOwnedToTrash(path, this.token);
                if (isDeadlineExpired()) break;
                report.purgedMessages += removed.moved;
                sourceMutated = removed.moved > 0;
                roundMutated = roundMutated || sourceMutated;
                if (sourceMutated || removed.remainingOwned > 0) {
                  pendingSourcePurge = path;
                }
                if (removed.remainingOwned > 0) {
                  report.ownedMessageResidue[path] = removed.remainingOwned;
                } else {
                  delete report.ownedMessageResidue[path];
                }
                if (scratchPath) {
                  touchedScratch.add(path);
                  emptyScratchProofs.delete(path);
                }
              }
              else {
                delete report.ownedMessageResidue[path];
              }

              if (!scratchPath) {
                if (sourceMutated) break;
                continue;
              }
              assertScratch(path, this.token);
              // Never classify a mailbox as verified-empty in the same round
              // that changed it. Bridge can briefly report zero before a
              // mutation reaches every view; the next round supplies an
              // independent emptiness proof.
              if (touchedScratch.has(path)) {
                emptyScratchProofs.delete(path);
                if (sourceMutated) break;
                continue;
              }
              const ownedAfter = await this.imap.ownedMessageCount(path, this.token);
              if (isDeadlineExpired()) break;
              const totalAfter = await this.imap.countMessages(path);
              if (isDeadlineExpired()) break;
              if (ownedAfter === 0 && totalAfter === 0) {
                const creationProof = await this.createdMailboxProof(path);
                if (!creationProof) {
                  emptyScratchProofs.delete(path);
                  roundErrors.push(`${path}: retained because this run has no positive mailbox-creation proof`);
                  continue;
                }
                const priorProof = emptyScratchProofs.get(path);
                const proofs = priorProof?.uidValidity === creationProof.uidValidity
                  ? priorProof.count + 1
                  : 1;
                emptyScratchProofs.set(path, { uidValidity: creationProof.uidValidity, count: proofs });
                // Each round begins with refreshCleanupSession(), so two
                // proofs here are observations from independent Bridge
                // sessions rather than one stale SELECT cache. Even then IMAP
                // cannot atomically condition DELETE on the folder remaining
                // empty. Live cleanup therefore retains and reports the folder
                // instead of opening a final-check-to-DELETE race over foreign
                // mail which may arrive from another client.
                if (proofs >= 2) manualFolderCleanup.add(path);
              } else {
                emptyScratchProofs.delete(path);
              }
              // A non-empty scratch folder is deliberately retained. It may be a
              // stale owned view or foreign contamination; the final scan reports
              // the exact state without ever making the foreign message an operand.
            } catch (error) {
              if (isFatalCleanupError(error)) throw error;
              emptyScratchProofs.delete(path);
              roundErrors.push(`${path}: reconciliation failed: ${errorMessage(error)}`);
            }
            if (sourceMutated || pendingSourcePurge === path) break;
          }
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }

          if (roundMutated || pendingSourcePurge) {
            emptyScratchProofs.clear();
            consecutiveCleanScans = 0;
            consecutiveEnvironmentCleanScans = 0;
            consecutiveAllMailOnlyScans = 0;
            lastRoundErrors = roundErrors;
            await waitForFreshRound();
            continue;
          }

          const ownedResidue: Record<string, number> = {};
          let scratchResidue: string[] = [];
          try {
            const finalMailboxes = await this.imap.listCleanupMailboxes();
            if (!isDeadlineExpired()) {
              scratchResidue = finalMailboxes
                .filter((path) => isScratchPath(path, this.token))
                .sort();
            }
            for (const path of finalMailboxes) {
              if (isDeadlineExpired()) break;
              try {
                const count = await this.imap.ownedMessageCount(path, this.token);
                if (isDeadlineExpired()) break;
                if (count > 0) ownedResidue[path] = count;
              } catch (error) {
                if (isFatalCleanupError(error)) throw error;
                roundErrors.push(`${path}: ownership scan failed: ${errorMessage(error)}`);
              }
            }
          } catch (error) {
            if (isFatalCleanupError(error)) throw error;
            roundErrors.push(`post-cleanup mailbox verification failed: ${errorMessage(error)}`);
          }
          if (isDeadlineExpired()) {
            lastRoundErrors = roundErrors;
            break;
          }

          // Revalidate every retained-empty classification during the
          // authoritative audit. This affects reporting/convergence only; no
          // mailbox DELETE is ever dispatched by live Bridge cleanup.
          for (const path of [...manualFolderCleanup]) {
            try {
              const creationProof = await this.createdMailboxProof(path);
              const total = await this.imap.countMessages(path);
              if (isDeadlineExpired()) break;
              if (!creationProof || total !== 0) manualFolderCleanup.delete(path);
            } catch (error) {
              if (isFatalCleanupError(error)) throw error;
              manualFolderCleanup.delete(path);
              roundErrors.push(`${path}: retained-folder verification failed: ${errorMessage(error)}`);
            }
          }
          const manualPaths = scratchResidue
            .filter((path) => manualFolderCleanup.has(path))
            .sort();
          const unsafeScratchResidue = scratchResidue
            .filter((path) => !manualFolderCleanup.has(path));
          const environmentClean = roundErrors.length === 0
            && unsafeScratchResidue.length === 0
            && Object.keys(ownedResidue).length === 0;
          const pendingGraceElapsed = Date.now() >= pendingGraceDeadline;
          lastPendingProofCount = this.imap.pendingOwnershipProofCount?.() ?? 0;
          consecutiveEnvironmentCleanScans = environmentClean && pendingGraceElapsed
            ? consecutiveEnvironmentCleanScans + 1
            : 0;
          consecutiveCleanScans = environmentClean && pendingGraceElapsed && lastPendingProofCount === 0
            ? consecutiveCleanScans + 1
            : 0;
          report.residue = scratchResidue;
          report.retained = [...scratchResidue];
          report.manualFolderCleanup = manualPaths;
          report.ownedMessageResidue = ownedResidue;
          lastRoundErrors = roundErrors;

          // Two complete fresh-session audits which agree that the only
          // remaining exact-owned records are in All Mail are enough to stop
          // this in-process path early. It cannot safely mutate that unstable
          // projection; the standalone recovery process owns the durable
          // COPY-only rescue lifecycle. Do not burn the remaining 180-second
          // convergence window rediscovering the same virtual residue.
          const ownedPaths = Object.keys(ownedResidue);
          const allMailOnly = typeof allMail === "string"
            && ownedPaths.length === 1
            && ownedPaths[0] === allMail
            && unsafeScratchResidue.length === 0
            && roundErrors.length === 0;
          consecutiveAllMailOnlyScans = allMailOnly
            ? consecutiveAllMailOnlyScans + 1
            : 0;
          if (consecutiveAllMailOnlyScans >= 2) {
            report.fatalErrorCode = "MAILPOUCH_E2E_ALL_MAIL_RESCUE_REQUIRED";
            report.errors = [
              `exact-owned residue remains only in ${allMail}; fresh-process COPY rescue is required`,
            ];
            return report;
          }

          if (lastPendingProofCount > 0 && consecutiveEnvironmentCleanScans >= 2) {
            lastRoundErrors.push(
              `${lastPendingProofCount} unresolved pending ownership proof(s) remain after the delivery grace`,
            );
            break;
          }

          if (consecutiveCleanScans >= 2) {
            if (isDeadlineExpired()) break;
            report.ok = true;
            report.errors = [];
            if (!options.deferOwnershipCompletion) this.imap.completeOwnershipRun?.(this.token);
            this.created.clear();
            return report;
          }
          if (isDeadlineExpired()) break;
          const remainingMs = Math.max(1, deadline - Date.now());
          await new Promise((resolve) => setTimeout(resolve, Math.min(pollMs, remainingMs)));
        }
        return undefined;
      }, {
        deadline,
        label: "Bridge cleanup convergence",
        onDeadline: expireDeadline,
      });
    } catch (error) {
      if (!isFatalCleanupError(error)) throw error;
      deadlineExpired = true;
      report.fatalErrorCode = fatalCleanupCode(error);
      lastRoundErrors.push(errorMessage(error));
    }
    if (completedReport) return completedReport;

    report.retained = [...report.residue];
    report.errors = [...lastRoundErrors];
    // Once the deadline closes the socket, do not start a fresh audit outside
    // the budget. The durable manifest remains for an explicit recovery run.
    if (!deadlineExpired) {
      for (const path of report.residue) {
        try {
          const owned = await this.imap.ownedMessageCount(path, this.token);
          const total = await this.imap.countMessages(path);
          if (total > owned) {
            report.errors.push(`${path}: retained because it contains ${total - owned} non-owned message(s)`);
          }
        } catch (error) {
          report.errors.push(`${path}: final retained-folder audit failed: ${errorMessage(error)}`);
        }
      }
    }
    if (Object.keys(report.ownedMessageResidue).length > 0) {
      report.errors.push(`owned message residue remains in ${Object.keys(report.ownedMessageResidue).join(", ")}`);
    }
    if (lastPendingProofCount > 0
      && !report.errors.some((message) => message.includes("pending ownership proof"))) {
      report.errors.push(`${lastPendingProofCount} unresolved pending ownership proof(s) remain`);
    }
    if (report.residue.length > 0 && !report.errors.some((message) => message.includes("retained"))) {
      report.errors.push(`scratch folder residue remains after convergence deadline`);
    }
    if (report.fatalErrorCode === "MAILPOUCH_E2E_CLEANUP_TIMEOUT" || Date.now() >= deadline) {
      report.errors.push(`cleanup did not reach two consecutive clean ownership scans before the absolute deadline`);
    } else if (!trash) {
      report.errors.push("cleanup could not resolve the Trash mailbox");
    }
    report.ok = false;
    return report;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function fatalCleanupCode(
  error: unknown,
): ScratchCleanupReport["fatalErrorCode"] {
  const code = error && typeof error === "object"
    ? (error as { code?: unknown }).code
    : undefined;
  if (code === "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN"
    || code === "MAILPOUCH_E2E_CLEANUP_TIMEOUT"
    || code === "MAILPOUCH_E2E_ALL_MAIL_RESCUE_REQUIRED") return code;
  return undefined;
}
