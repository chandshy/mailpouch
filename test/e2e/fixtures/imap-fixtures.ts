/**
 * ImapFixtures — direct IMAP fixture & assertion helpers for E2E scenarios.
 *
 * Uses `imapflow` (the same client mailpouch uses in production) to talk
 * directly to the Greenmail (or Bridge) test server. Lets each scenario seed
 * folders/messages, then verify *actual IMAP state* after a mailpouch tool
 * call — not just the tool's return value.
 *
 * This is what makes false-success bugs visible: the harness asserts on
 * server-side state, not on counters that mailpouch fabricated.
 */

import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { ImapFlow } from "imapflow";
import { buildMime, type SeedEmail } from "../support/mime-builder.js";
import {
  canonicalMessageId,
  hashOwnershipMessageId,
  OwnershipManifestStore,
  type CreatedMailboxProof,
  type OwnershipBaselineProof,
} from "../support/ownership-manifest.js";
import { DeadlineExceededError, raceWithDeadline } from "../support/deadline-race.mjs";
import { buildOwnershipDiscoveryQuery } from "../support/ownership-search.mjs";
import { bridgeMutationUidBatches } from "../support/uid-batches.mjs";
import { BRIDGE_MUTATION_COMMAND_MS } from "../support/time-budgets.mjs";
import {
  isFatalCleanupError,
  MutationOutcomeUnknownError,
  MutationRefusedError,
  requireMutationResult,
} from "../support/mutation-result.mjs";
import {
  assertScratch,
  E2E_OWNERSHIP_HEADER,
  isScratchPath,
  isRunToken,
  type OwnedMoveResult,
} from "../support/scratch.js";

function assertOwnershipToken(token: string): void {
  if (!isRunToken(token)) throw new Error(`Invalid E2E ownership token: ${token}`);
}

function injectOwnershipHeader(mime: string, token: string): string {
  assertOwnershipToken(token);
  const boundary = mime.indexOf("\r\n\r\n");
  if (boundary < 0) throw new Error("Owned E2E MIME is missing the RFC 5322 header boundary");
  const headers = mime.slice(0, boundary);
  const ownershipHeader = new RegExp(`^${E2E_OWNERSHIP_HEADER}:`, "im");
  if (ownershipHeader.test(headers)) {
    throw new Error(`Owned E2E MIME already contains ${E2E_OWNERSHIP_HEADER}`);
  }
  return `${headers}\r\n${E2E_OWNERSHIP_HEADER}: ${token}${mime.slice(boundary)}`;
}

function hasExactOwnershipHeader(headers: Buffer | undefined, token: string): boolean {
  if (!headers) return false;
  const unfolded = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const values = unfolded
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(`${E2E_OWNERSHIP_HEADER.toLowerCase()}:`))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  return values.length === 1 && values[0] === token;
}

function headerValue(headers: Buffer | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const unfolded = headers.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  const prefix = `${name.toLowerCase()}:`;
  const matches = unfolded
    .split(/\r?\n/)
    .filter((line) => line.toLowerCase().startsWith(prefix))
    .map((line) => line.slice(line.indexOf(":") + 1).trim());
  return matches.length === 1 ? matches[0] : undefined;
}

function stableFlags(flags: Iterable<string> | undefined): string[] {
  return [...(flags ?? [])]
    .filter((flag) => flag.toLowerCase() !== "\\recent")
    .sort();
}

/** Proton Bridge's All Mail mailbox is a virtual projection. Its UID mapping
 * can be rebuilt when unrelated messages are appended/removed without a
 * corresponding UIDVALIDITY change, so logical identity must not depend on
 * the projection UID. Concrete mailbox UIDs remain strict. */
function isEnglishAllMailPath(path: string): boolean {
  return /^all mail$/i.test(path.trim());
}

function stableVirtualMessageKey(message: MailboxSafetyMessage): string {
  const identity = message.messageId ? `mid:${message.messageId}` : `uid:${message.uid}`;
  return `${identity}|flags:${message.flags.join(",")}`;
}

export interface ImapFixturesOptions {
  host: string;
  port: number;
  user: string;
  pass: string;
  /** Folders that should never be deleted by wipe(). */
  protectedFolders?: string[];
  /** TLS options for the imapflow STARTTLS upgrade. Bridge serves a self-signed
   *  cert with CN=127.0.0.1 but is reached via host `localhost`, so a bare
   *  client fails (self-signed, then ALTNAME). Pass the production
   *  buildBridgeTlsOptions(cert) here in Bridge mode. Undefined = Greenmail
   *  (no special TLS needed). */
  tls?: Record<string, unknown>;
  /** Gate on the DESTRUCTIVE wipe(). wipe() empties INBOX/Sent/Archive/Trash/
   *  Spam/Drafts and deletes every other folder. Only disposable Greenmail may
   *  set this true; Bridge mode must always leave it false. */
  allowWipe?: boolean;
  /** Safe Greenmail runs may create a missing Trash mailbox. Keep false for a
   * live Bridge account: system folders there must already exist. */
  allowCreateSystemFolders?: boolean;
  /** Permit arbitrary fixture mailbox CREATE. This is true only for disposable
   * Greenmail. Live Bridge cannot safely pair CREATE with an atomic cleanup
   * DELETE, so its fixture refuses before sending the command. */
  allowMailboxCreate?: boolean;
  /** When set, appendSeed() automatically injects this run's ownership marker. */
  ownershipToken?: string;
  /** Live Bridge MOVE/DELETE must remain UID-scoped all the way to EXPUNGE.
   * Require this only for a non-disposable mailbox; Greenmail keeps its
   * independent compatibility coverage. */
  requireUidPlusForMutations?: boolean;
  /** Explicit durable manifest directory for live Bridge authority. Keeping
   * this fixed for the run prevents later source-profile edits from moving
   * cleanup authority to another mailbox scope. */
  ownershipManifestRoot?: string;
}

export interface MailboxSafetyMessage {
  uid: number;
  messageId?: string;
  flags: string[];
}

export interface MailboxSafetySnapshot {
  mailboxPaths: string[];
  uidValidity: Record<string, string>;
  messages: Record<string, MailboxSafetyMessage[]>;
}

interface MailboxSafetyState {
  uidValidity: string;
  messages: MailboxSafetyMessage[];
}

export interface MailboxSafetyVerification {
  ok: boolean;
  errors: string[];
  /** Discrepancies in mailboxes this run could not have mutated. Reported, but
   * never a reason to fail — see `mutationScopePaths`. */
  drift?: string[];
}

export interface AppendedSeedIdentity {
  uid: number;
  /** Canonical Message-ID without angle brackets. */
  messageId: string;
  subject: string;
}

/**
 * Default protected mailboxes — wipe() empties these rather than deleting
 * them. INBOX is universally reserved; the others are common system /
 * special-use folders that some IMAP servers (incl. Proton Bridge and
 * Greenmail) refuse to delete. Treating them as protected guarantees that
 * "Archive" / "Sent" / "Trash" / "Spam" / "Drafts" are always present and
 * empty at the start of each test.
 */
const DEFAULT_PROTECTED = ["INBOX", "Archive", "Sent", "Trash", "Spam", "Drafts"];

export class ImapFixtures {
  private client: ImapFlow;
  private readonly opts: ImapFixturesOptions;
  private readonly protectedFolders: Set<string>;
  private connected = false;
  private ownershipToken?: string;
  private ownershipManifest?: OwnershipManifestStore;
  private readonly ownershipUidProofs = new Map<string, { uidValidity: string; uids: Set<number> }>();
  private cleanupAbortError?: Error;
  private readonly auxiliaryCleanupClients = new Set<ImapFlow>();
  private readonly allMailPaths = new Set<string>();

  constructor(opts: ImapFixturesOptions) {
    this.opts = opts;
    this.client = this.makeClient();
    this.protectedFolders = new Set([...DEFAULT_PROTECTED, ...(opts.protectedFolders ?? [])]);
    if (opts.ownershipToken) this.setOwnershipToken(opts.ownershipToken);
  }

  private makeClient(): ImapFlow {
    return new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: false,
      auth: { user: this.opts.user, pass: this.opts.pass },
      logger: false,
      // Cleanup owns a stricter absolute deadline which force-closes this
      // connection. These per-socket limits are defense in depth for setup,
      // baseline verification, and ordinary fixture calls outside that loop.
      connectionTimeout: 15_000,
      greetingTimeout: 15_000,
      socketTimeout: 30_000,
      // Bridge's self-signed CN=127.0.0.1 cert (reached via localhost) needs
      // the production TLS handling (pin cert as CA + skip hostname); Greenmail
      // leaves this undefined.
      ...(this.opts.tls ? { tls: this.opts.tls } : {}),
    });
  }

  private manifestPath(token: string): string | undefined {
    return this.opts.ownershipManifestRoot
      ? resolve(this.opts.ownershipManifestRoot, `bridge-run-${token}.json`)
      : undefined;
  }

  async connect(): Promise<void> {
    this.throwIfCleanupAborted();
    if (this.connected) return;
    await this.client.connect();
    this.throwIfCleanupAborted();
    this.assertUidPlusForMutation();
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    const client = this.client;
    const forceClose = setTimeout(() => client.close(), 5_000);
    forceClose.unref?.();
    try {
      await client.logout();
    } catch {
      // ignore
    } finally {
      clearTimeout(forceClose);
      client.close();
    }
    this.connected = false;
  }

  /**
   * Self-heal a dead connection. Greenmail terminates IMAP sessions on
   * various edge cases (mailbox deletion of a SELECT'd folder, idle drift);
   * imapflow can't reuse a torn-down socket, so we reconstruct the client.
   */
  private async reconnect(): Promise<void> {
    this.throwIfCleanupAborted();
    try {
      await this.client.logout();
    } catch {
      // ignore — socket already dead
    }
    this.throwIfCleanupAborted();
    this.connected = false;
    this.client = this.makeClient();
    this.throwIfCleanupAborted();
    await this.client.connect();
    this.throwIfCleanupAborted();
    this.assertUidPlusForMutation();
    this.connected = true;
  }

  /** Rotate a destructive cleanup transport without awaiting LOGOUT. Once a
   * Bridge session has been used for exact-owned MOVE/DELETE, teardown itself
   * must not re-enter a stalled command pipeline before rediscovery can start. */
  private async rotateCleanupSession(): Promise<void> {
    this.throwIfCleanupAborted();
    this.connected = false;
    try { this.client.close(); } catch { /* the prior cleanup socket may already be closed */ }
    this.throwIfCleanupAborted();
    this.client = this.makeClient();
    try {
      await this.client.connect();
      this.throwIfCleanupAborted();
      this.assertUidPlusForMutation();
      this.connected = true;
    } catch (error) {
      try { this.client.close(); } catch { /* fail closed if setup only partially opened */ }
      throw error;
    }
  }

  /** Cancel an in-flight cleanup command at its absolute deadline. Closing the
   * socket is intentional: Promise.race alone would let a destructive IMAP
   * command continue in the background after teardown had already failed. */
  abortCleanupSession(reason: string | Error = "Bridge cleanup deadline exceeded"): void {
    if (!this.cleanupAbortError) {
      this.cleanupAbortError = reason instanceof Error ? reason : new Error(reason);
    }
    this.connected = false;
    try { this.client.close(); } catch { /* the primary transport may already be torn down */ }
    for (const client of this.auxiliaryCleanupClients) {
      try { client.close(); } catch { /* close every remaining cleanup transport */ }
    }
    this.auxiliaryCleanupClients.clear();
  }

  private throwIfCleanupAborted(): void {
    if (this.cleanupAbortError) throw this.cleanupAbortError;
  }

  private async runCleanupMutation<T>(label: string, operation: () => Promise<T>): Promise<T> {
    this.throwIfCleanupAborted();
    try {
      const result = await raceWithDeadline(operation, {
        deadline: Date.now() + BRIDGE_MUTATION_COMMAND_MS,
        label,
        onDeadline: () => this.abortCleanupSession(new DeadlineExceededError(label)),
      });
      return requireMutationResult(result, label, {
        connectionUsable: this.client.usable === true,
      });
    } catch (error) {
      // A tagged NO with a usable connection is a definite single-UID no-op:
      // nothing was applied, so the session stays healthy and the bounded
      // convergence rounds retry after the server settles (Proton refuses
      // moves of freshly-sent Sent messages until its backend catches up).
      if (error instanceof MutationRefusedError) throw error;
      if (isFatalCleanupError(error)) {
        this.abortCleanupSession(error instanceof Error ? error : new Error(String(error)));
        throw error;
      }
      // An IMAP command rejection cannot prove whether the server applied the
      // mutation before returning the error. Poison the entire cleanup session
      // and retain the durable manifest for a later exact re-discovery.
      const fatal = new MutationOutcomeUnknownError(label);
      this.abortCleanupSession(fatal);
      throw fatal;
    }
  }

  private assertUidPlusForMutation(): void {
    if (this.opts.requireUidPlusForMutations !== true) return;
    if (!this.client.capabilities?.has("UIDPLUS")) {
      throw new Error(
        "Live Bridge E2E destructive mutation refused: IMAP server did not negotiate UIDPLUS",
      );
    }
  }

  /** Force a fresh IMAP session between Bridge cleanup rounds. Bridge can
   * retain stale virtual-folder projections on a long-lived connection even
   * after another session sees the mutation fully converged. */
  async refreshCleanupSession(): Promise<void> {
    await this.rotateCleanupSession();
  }

  /**
   * Run `fn` with a one-shot reconnect on any IMAP error. Greenmail and the
   * mailpouch IMAP service share a single Greenmail instance and concurrently
   * lock/select mailboxes; this can leave imapflow's client in a "Command
   * failed" or "NoConnection" state. We reconnect once and retry — if the
   * second attempt still throws, the error propagates to the test.
   */
  private async withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    this.throwIfCleanupAborted();
    try {
      const result = await fn();
      this.throwIfCleanupAborted();
      return result;
    } catch {
      this.throwIfCleanupAborted();
      await this.reconnect();
      this.throwIfCleanupAborted();
      const result = await fn();
      this.throwIfCleanupAborted();
      return result;
    }
  }

  /**
   * Create a mailbox. No-op if it already exists. Greenmail returns a generic
   * "Command failed" on an EXISTS condition rather than a parseable message,
   * so we treat any create error as benign provided the mailbox is present
   * afterward — and propagate only if it's still missing.
   */
  async createMailbox(path: string, exclusive = false): Promise<void> {
    if (this.opts.allowMailboxCreate === false) {
      throw new Error(`Live Bridge fixture mailbox creation is disabled: ${path}`);
    }
    if (this.ownershipToken && this.opts.allowCreateSystemFolders !== true) {
      assertScratch(path, this.ownershipToken);
      if (!exclusive) {
        throw new Error(
          `Live ownership mode requires exclusive mailbox creation for ${path}`,
        );
      }
    }
    await this.withReconnect(async () => {
      try {
        this.throwIfCleanupAborted();
        const result = await this.client.mailboxCreate(path);
        this.throwIfCleanupAborted();
        if (exclusive && result?.created !== true) {
          throw new Error(`Mailbox already exists or creation was not confirmed: ${path}`);
        }
        if (!exclusive && !result) {
          throw new Error(`Mailbox creation did not return an explicit result: ${path}`);
        }
        return;
      } catch (e: unknown) {
        this.throwIfCleanupAborted();
        // Check whether the mailbox is now visible; if yes, the original
        // failure was just "already exists" under a different wire spelling.
        const list = await this.client.list();
        this.throwIfCleanupAborted();
        if (list.some((m) => m.path === path)) {
          if (exclusive) throw new Error(`Mailbox already exists: ${path}`);
          return;
        }
        throw e;
      }
    });
  }

  /** True if the mailbox exists on the server (case-sensitive). */
  async mailboxExists(path: string): Promise<boolean> {
    return this.withReconnect(async () => {
      const list = await this.client.list();
      return list.some((m) => m.path === path);
    });
  }

  private rememberAllMailPaths(
    mailboxes: Array<{ path: string; specialUse?: string | false }>,
  ): void {
    for (const mailbox of mailboxes) {
      if (typeof mailbox.specialUse === "string" && mailbox.specialUse.toLowerCase() === "\\all") {
        this.allMailPaths.add(mailbox.path);
      }
    }
  }

  private isAllMailPath(path: string): boolean {
    return this.allMailPaths.has(path) || isEnglishAllMailPath(path);
  }

  /** Return all mailbox paths the server knows about (system + user). */
  async listMailboxes(): Promise<string[]> {
    return this.withReconnect(async () => {
      const list = await this.client.list();
      this.rememberAllMailPaths(list);
      return list.map((m) => m.path);
    });
  }

  /** Selectable mailboxes which may contain an owned message. */
  async listCleanupMailboxes(): Promise<string[]> {
    return this.withReconnect(async () => {
      const list = await this.client.list();
      this.rememberAllMailPaths(list);
      return list
        .filter((mailbox) => ![...mailbox.flags].some((flag) => flag.toLowerCase() === "\\noselect"))
        .map((mailbox) => mailbox.path);
    });
  }

  async trashMailbox(): Promise<string> {
    return this.resolveTrashMailbox();
  }

  async allMailMailbox(paths?: string[]): Promise<string | null> {
    const candidates = paths ?? await this.listCleanupMailboxes();
    return candidates.find((path) => this.isAllMailPath(path)) ?? null;
  }

  async isAllMailMailbox(path: string): Promise<boolean> {
    // Refresh special-use discovery before authorizing a live UID operand so a
    // localized or additional \All projection cannot evade the English-name
    // fallback or a stale one-path cache.
    await this.listMailboxes();
    return this.isAllMailPath(path);
  }

  /** Resolve the same Drafts special-use mailbox the production service uses. */
  async draftsMailbox(): Promise<string | null> {
    return this.withReconnect(async () => {
      const list = await this.client.list();
      const specialUse = list.find((mailbox) => mailbox.specialUse?.toLowerCase() === "\\drafts");
      if (specialUse) return specialUse.path;
      const names = new Set(["drafts", "draft", "[gmail]/drafts"]);
      return list.find((mailbox) => names.has(mailbox.path.toLowerCase()))?.path ?? null;
    });
  }

  /** Capture the pre-run mailbox/message state without setting \Seen. */
  async captureSafetySnapshot(): Promise<MailboxSafetySnapshot> {
    const mailboxPaths = (await this.listMailboxes()).sort();
    const selectable = new Set(await this.listCleanupMailboxes());
    const uidValidity: Record<string, string> = {};
    const messages: Record<string, MailboxSafetyMessage[]> = {};
    for (const path of mailboxPaths) {
      if (!selectable.has(path)) continue;
      const state = await this.snapshotMailboxState(path);
      uidValidity[path] = state.uidValidity;
      messages[path] = state.messages;
    }
    return { mailboxPaths, uidValidity, messages };
  }

  /** Verify every baseline folder/message/flag set survived. New folders and
   * newly arrived messages are allowed. */
  async verifySafetySnapshot(
    snapshot: MailboxSafetySnapshot,
    timeoutMs?: number,
  ): Promise<MailboxSafetyVerification> {
    if (!timeoutMs || timeoutMs <= 0) return this.verifySafetySnapshotUnchecked(snapshot);
    return raceWithDeadline(
      () => this.verifySafetySnapshotUnchecked(snapshot),
      {
        deadline: Date.now() + timeoutMs,
        label: "Bridge baseline verification",
        onDeadline: () => this.abortCleanupSession(
          `Bridge baseline verification exceeded its ${timeoutMs}ms absolute deadline`,
        ),
      },
    );
  }

  /**
   * Mailboxes this run could plausibly have mutated, derived from durable
   * manifest state rather than a hardcoded list so it cannot drift from what
   * the run actually did.
   *
   * The baseline snapshots every selectable mailbox in the account, which is
   * right for a disposable test account and wrong for a live personal one:
   * folders the suite never writes to (Spam, unrelated Labels) drift on their
   * own via Proton's auto-purge and ordinary mail movement, and that drift is
   * indistinguishable from E2E damage. Each false failure retains a run that
   * blocks every later run.
   *
   * INBOX and All Mail stay in scope: sends land in INBOX, and All Mail is the
   * virtual union containing everything the run creates.
   */
  private mutationScopePaths(): Set<string> {
    const scope = new Set<string>(["INBOX"]);
    for (const path of this.allMailPaths) scope.add(path);
    const manifest = this.ownershipManifest;
    if (manifest) {
      for (const proof of manifest.createdMailboxes()) scope.add(proof.path);
      for (const proof of manifest.pending()) {
        if ("folder" in proof && typeof proof.folder === "string" && proof.folder) {
          scope.add(proof.folder);
        }
      }
    }
    return scope;
  }

  /** True when `path` is outside everything this run could have mutated. */
  private isOutsideMutationScope(path: string, scope: Set<string>): boolean {
    if (scope.has(path)) return false;
    // Ask isAllMailPath rather than trusting the discovered set: All Mail is
    // also recognised by name, and a set populated only by a live LIST would
    // silently demote the virtual union to drift.
    if (this.isAllMailPath(path)) return false;
    // A token-shaped path is this run's own namespace even if the manifest lost
    // the created-mailbox proof — never treat it as somebody else's folder.
    return !(this.ownershipToken && path.includes(this.ownershipToken));
  }

  private async verifySafetySnapshotUnchecked(
    snapshot: MailboxSafetySnapshot,
  ): Promise<MailboxSafetyVerification> {
    // Collected with their mailbox so scope is applied once, at the end. The
    // checks below push from many branches; deciding per push site is how one
    // branch quietly lands on the wrong side of the boundary.
    const found: Array<{ path: string; message: string }> = [];
    const currentPaths = new Set(await this.listMailboxes());
    for (const path of snapshot.mailboxPaths) {
      if (!currentPaths.has(path)) {
        found.push({ path, message: `baseline mailbox was removed or renamed: ${path}` });
      }
    }

    for (const [path, baseline] of Object.entries(snapshot.messages)) {
      if (!currentPaths.has(path)) continue;
      let current: MailboxSafetyState;
      try {
        current = await this.snapshotMailboxState(path);
      } catch (error) {
        // A deadline abort is process-wide cleanup state, not a mailbox-level
        // verification failure. Never swallow it and continue into more FETCHes.
        this.throwIfCleanupAborted();
        found.push({ path, message: `could not verify baseline mailbox ${path}: ${error instanceof Error ? error.message : String(error)}` });
        continue;
      }

      const virtual = this.isAllMailPath(path);
      const baselineUidValidity = snapshot.uidValidity[path];
      if (!baselineUidValidity) {
        found.push({ path, message: `${path}: baseline snapshot has no UIDVALIDITY proof` });
        continue;
      }
      if (!virtual && current.uidValidity !== baselineUidValidity) {
        found.push({ path, message: `${path}: UIDVALIDITY changed from ${baselineUidValidity} to ${current.uidValidity} ` +
          `(mailbox was deleted or recreated)`, });
        continue;
      }

      if (virtual) {
        const available = new Map<string, number>();
        for (const message of current.messages) {
          const key = stableVirtualMessageKey(message);
          available.set(key, (available.get(key) ?? 0) + 1);
        }
        for (const message of baseline) {
          const key = stableVirtualMessageKey(message);
          const count = available.get(key) ?? 0;
          if (count === 0) {
            const identity = message.messageId ? `Message-ID ${message.messageId}` : `UID ${message.uid}`;
            found.push({ path, message: `${path}: baseline virtual ${identity} is missing or its flags changed` });
          } else {
            available.set(key, count - 1);
          }
        }
        continue;
      }

      const currentByUid = new Map(current.messages.map((message) => [message.uid, message]));
      for (const message of baseline) {
        const observed = currentByUid.get(message.uid);
        if (!observed) {
          found.push({ path, message: `${path}: baseline UID ${message.uid} is missing` });
          continue;
        }
        if (observed.messageId !== message.messageId) {
          found.push({ path, message: `${path}: baseline UID ${message.uid} Message-ID changed from ` +
            `${message.messageId ?? "(missing)"} to ${observed.messageId ?? "(missing)"}`, });
        }
        if (observed.flags.length !== message.flags.length
          || observed.flags.some((flag, index) => flag !== message.flags[index])) {
          found.push({ path, message: `${path}: baseline UID ${message.uid} flags changed` });
        }
      }
    }
    this.throwIfCleanupAborted();
    const scope = this.mutationScopePaths();
    const errors: string[] = [];
    const drift: string[] = [];
    for (const entry of found) {
      if (this.isOutsideMutationScope(entry.path, scope)) drift.push(entry.message);
      else errors.push(entry.message);
    }
    return { ok: errors.length === 0, errors, ...(drift.length > 0 ? { drift } : {}) };
  }

  /** APPEND a raw MIME message to `folder`. Returns the assigned UID.
   * Ownership mode refuses this public escape hatch; callers must use an
   * owned helper which injects and durably records the exact run identity. */
  async appendEmail(folder: string, mime: string, flags: string[] = []): Promise<number> {
    if (this.ownershipToken) {
      throw new Error(
        "Raw IMAP APPEND is disabled in ownership mode; use appendSeed(), appendIdentifiedSeed(), or appendOwnedEmail()",
      );
    }
    return this.appendRawEmail(folder, mime, flags);
  }

  private async appendRawEmail(folder: string, mime: string, flags: string[] = []): Promise<number> {
    return this.withReconnect(async () => {
      const res = await this.client.append(folder, mime, flags);
      if (!res || typeof res !== "object" || typeof (res as { uid?: number }).uid !== "number") {
        throw new Error(`IMAP APPEND to ${folder} returned no UID`);
      }
      return (res as { uid: number }).uid;
    });
  }

  /** Build a MIME message from a SeedEmail and APPEND it. Returns the UID. */
  async appendSeed(folder: string, seed: SeedEmail, flags: string[] = []): Promise<number> {
    if (this.ownershipToken) {
      return this.appendOwnedSeed(folder, this.ownershipToken, seed, flags);
    }
    return this.appendEmail(folder, buildMime(seed), flags);
  }

  /** APPEND a seed with a deterministic identity that can be re-resolved after
   * Bridge has projected the write onto its other IMAP sessions. Proton Bridge
   * may briefly make the APPENDUID unavailable to a separately selected
   * mailbox; Message-ID + exact subject + run header remain stable across that
   * projection and let the E2E harness discover the current folder-local UID. */
  async appendIdentifiedSeed(
    folder: string,
    seed: SeedEmail,
    flags: string[] = [],
  ): Promise<AppendedSeedIdentity> {
    const identified = seed.messageId
      ? seed
      : { ...seed, messageId: `mailpouch-e2e-${randomUUID()}` };
    const mime = buildMime(identified);
    const messageId = canonicalMessageId(headerValue(Buffer.from(mime, "utf8"), "message-id"));
    if (!messageId) throw new Error("Identified E2E seed did not produce a canonical Message-ID");
    const uid = this.ownershipToken
      ? await this.appendOwnedEmail(folder, this.ownershipToken, mime, flags)
      : await this.appendEmail(folder, mime, flags);
    return { uid, messageId, subject: identified.subject };
  }

  /** Resolve a seeded message's current UID from an exact identity tuple. In
   * ownership mode the run header is mandatory, so a coincidentally matching
   * pre-existing Message-ID/subject can never become an E2E assertion target. */
  async findSeedIdentityUids(
    folder: string,
    messageId: string,
    subject: string,
    token?: string,
  ): Promise<number[]> {
    const canonical = canonicalMessageId(messageId);
    if (!canonical) throw new Error(`Invalid identified seed Message-ID: ${messageId}`);
    if (token) assertOwnershipToken(token);
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        if (this.client.mailbox && (this.client.mailbox as { exists?: number }).exists === 0) return [];
        const candidates = await this.client.search({ header: { "message-id": canonical } }, { uid: true });
        if (!Array.isArray(candidates) || candidates.length === 0) return [];
        const exact: number[] = [];
        for await (const msg of this.client.fetch(
          candidates,
          { uid: true, envelope: true, headers: [E2E_OWNERSHIP_HEADER, "Message-ID", "Subject"] },
          { uid: true },
        )) {
          const actualId = canonicalMessageId(msg.envelope?.messageId ?? headerValue(msg.headers, "message-id"));
          const actualSubject = msg.envelope?.subject ?? headerValue(msg.headers, "subject") ?? "";
          if (typeof msg.uid === "number"
            && actualId === canonical
            && actualSubject === subject
            && (!token || hasExactOwnershipHeader(msg.headers, token))) {
            exact.push(msg.uid);
          }
        }
        return exact.sort((left, right) => left - right);
      } finally { lock.release(); }
    });
  }

  /** Enable ownership mode. Refuse token changes so one fixture cannot claim
   * messages from multiple concurrent runs. */
  setOwnershipToken(token: string): void {
    if (!isRunToken(token)) throw new Error(`Invalid E2E ownership token: ${token}`);
    if (this.ownershipToken && this.ownershipToken !== token) {
      throw new Error(`E2E ownership token is already ${this.ownershipToken}; refusing ${token}`);
    }
    if (!this.ownershipToken) {
      this.ownershipToken = token;
      this.ownershipManifest = new OwnershipManifestStore(token, this.manifestPath(token));
    }
  }

  completeOwnershipRun(token: string): void {
    if (this.ownershipToken !== token) throw new Error(`Cannot complete inactive ownership run ${token}`);
    this.ownershipManifest?.complete();
    this.ownershipManifest = undefined;
    this.ownershipToken = undefined;
    this.ownershipUidProofs.clear();
  }

  hasOwnershipRun(token: string): boolean {
    return this.ownershipToken === token && this.ownershipManifest !== undefined;
  }

  pendingOwnershipProofCount(): number {
    return this.ownershipManifest?.pending().length ?? 0;
  }

  async recordCreatedMailbox(path: string, token: string): Promise<CreatedMailboxProof> {
    assertOwnershipToken(token);
    assertScratch(path, token);
    this.setOwnershipToken(token);
    const uidValidity = await this.mailboxUidValidity(path);
    this.requireOwnershipManifest().recordCreatedMailbox(path, uidValidity);
    return { path, uidValidity };
  }

  async createdMailboxProof(path: string, token: string): Promise<CreatedMailboxProof | undefined> {
    assertOwnershipToken(token);
    if (this.ownershipToken !== token) return undefined;
    const proof = this.ownershipManifest?.createdMailbox(path);
    if (!proof) return undefined;
    const currentUidValidity = await this.mailboxUidValidity(path);
    return currentUidValidity === proof.uidValidity ? proof : undefined;
  }

  async isCreatedMailbox(path: string, token: string): Promise<boolean> {
    return (await this.createdMailboxProof(path, token)) !== undefined;
  }

  private async mailboxUidValidity(path: string): Promise<string> {
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(path);
      try {
        const uidValidity = this.selectedUidValidity();
        if (!uidValidity) throw new Error(`Selected mailbox ${path} did not expose UIDVALIDITY`);
        return uidValidity;
      } finally {
        lock.release();
      }
    });
  }

  /** Persist only the identifiers needed to prove the pre-run mailbox state.
   * Raw Message-IDs and message content never enter the crash manifest. */
  persistSafetyBaseline(snapshot: MailboxSafetySnapshot, token: string): void {
    const baseline: OwnershipBaselineProof = {
      algorithm: "sha256",
      mailboxPaths: [...snapshot.mailboxPaths],
      mailboxes: Object.entries(snapshot.messages).map(([path, messages]) => {
        const uidValidity = snapshot.uidValidity[path];
        if (!uidValidity) throw new Error(`Cannot persist baseline without UIDVALIDITY for ${path}`);
        return {
          path,
          uidValidity,
          messages: messages.map((message) => ({
            uid: message.uid,
            flags: [...message.flags],
            ...(message.messageId
              ? { messageIdHash: hashOwnershipMessageId(message.messageId) }
              : {}),
          })),
        };
      }),
    };
    if (this.ownershipToken && this.ownershipToken !== token) {
      throw new Error(`E2E ownership token is already ${this.ownershipToken}; refusing ${token}`);
    }
    if (!this.ownershipToken) {
      // Create the first durable manifest with its required recovery baseline
      // in one fsync+rename. A crash can no longer leave a v2 manifest that
      // standalone cleanup must reject as unrecoverable.
      this.ownershipToken = token;
      this.ownershipManifest = new OwnershipManifestStore(
        token,
        this.manifestPath(token),
        baseline,
      );
      return;
    }
    this.requireOwnershipManifest().setBaseline(baseline);
  }

  /** Persist a constrained recovery proof before an SMTP tool is dispatched.
   * If the call or response handling crashes, standalone cleanup can still
   * identify only the exact tokenized artifact. */
  beginSentMessageAdoption(expectedSubject: string, token: string, expectedBodyToken?: string): string {
    this.setOwnershipToken(token);
    return this.requireOwnershipManifest().beginSent(expectedSubject, expectedBodyToken);
  }

  /** Persist a constrained recovery proof before save_draft APPEND is
   * dispatched. The pending claim is limited to the resolved Drafts mailbox
   * and exact tokenized subject. */
  beginDraftMessageAdoption(folder: string, expectedSubject: string, token: string): string {
    this.setOwnershipToken(token);
    return this.requireOwnershipManifest().beginDraft(folder, expectedSubject);
  }

  /** Append raw MIME carrying an exact per-run ownership header. */
  async appendOwnedEmail(folder: string, token: string, mime: string, flags: string[] = []): Promise<number> {
    this.setOwnershipToken(token);
    const ownedMime = injectOwnershipHeader(mime, token);
    const boundary = ownedMime.indexOf("\r\n\r\n");
    const messageId = canonicalMessageId(headerValue(
      Buffer.from(ownedMime.slice(0, boundary), "utf8"),
      "message-id",
    ));
    // Persist only a discovery hint before APPEND. Cleanup still fetches the
    // candidate and requires the exact ownership header, so a duplicate
    // pre-existing Message-ID can never become a destructive operand.
    if (messageId) this.requireOwnershipManifest().recordHeaderMessageId(messageId);
    return this.appendRawEmail(folder, ownedMime, flags);
  }

  /** Build and append a run-owned seed. Used for scratch and system-folder
   * seeds in non-destructive Bridge mode. */
  async appendOwnedSeed(folder: string, token: string, seed: SeedEmail, flags: string[] = []): Promise<number> {
    return this.appendOwnedEmail(folder, token, buildMime(seed), flags);
  }

  /** Delete a mailbox on a disposable server. Live ownership mode refuses
   * before any IMAP DELETE can be dispatched. */
  async deleteMailbox(path: string, expectedUidValidity?: string): Promise<void> {
    this.throwIfCleanupAborted();
    if (this.ownershipToken && this.opts.allowCreateSystemFolders !== true) {
      assertScratch(path, this.ownershipToken);
      // UIDVALIDITY and repeated empty observations prove which folder was
      // inspected, but IMAP offers no atomic DELETE-if-empty operation. A
      // foreign message can arrive after the final check and before DELETE.
      // Live Bridge cleanup therefore never dispatches mailbox DELETE at all.
      throw new Error(
        `${path}: live Bridge mailbox DELETE is disabled; retain the empty run-created folder for manual cleanup`,
      );
    }
    // The cleanup loop calls this immediately after selecting and proving the
    // mailbox empty. Close that selection and DELETE on the same live session;
    // Greenmail otherwise retains a stale handle and drops other sessions that
    // attempt to delete the mailbox.
    if (this.connected && !this.client.isClosed && this.client.mailbox?.path === path) {
      const currentUidValidity = this.selectedUidValidity();
      if (expectedUidValidity !== undefined && currentUidValidity !== expectedUidValidity) {
        throw new Error(
          `${path}: UIDVALIDITY changed from ${expectedUidValidity} to ${currentUidValidity ?? "(missing)"}; refusing mailbox DELETE`,
        );
      }
      if (this.client.mailbox.exists !== 0) {
        throw new Error(`${path}: final same-session emptiness proof failed; refusing mailbox DELETE`);
      }
      // ImapFlow's DELETE command closes the selected target internally and
      // immediately issues DELETE on the same connection. Calling CLOSE here
      // would introduce an avoidable recreation window between the final
      // UIDVALIDITY/emptiness proof and the destructive command.
      await this.runCleanupMutation(
        "twice-proven empty run mailbox DELETE",
        () => this.client.mailboxDelete(path),
      );
      this.throwIfCleanupAborted();
      return;
    }

    // Keep destructive mailbox removal off the long-lived fixture session.
    // Greenmail can mark that session LOGOUT asynchronously after MOVE/EXPUNGE;
    // assigning another client to `this.client` immediately afterward still
    // raced the stale close and made every DELETE report NoConnection. A
    // short-lived, locally owned connection makes each guarded delete
    // independent. Never retry DELETE here: success followed by a lost
    // response is ambiguous, and a recreated path needs two new empty proofs
    // in later cleanup rounds before it can become an operand again.
    this.throwIfCleanupAborted();
    const deletionClient = this.makeClient();
    this.auxiliaryCleanupClients.add(deletionClient);
    try {
      await deletionClient.connect();
      this.throwIfCleanupAborted();
      const finalProof = await deletionClient.getMailboxLock(path);
      try {
        this.throwIfCleanupAborted();
        const currentUidValidity = deletionClient.mailbox?.uidValidity === undefined
          ? undefined
          : String(deletionClient.mailbox.uidValidity);
        if (expectedUidValidity !== undefined && currentUidValidity !== expectedUidValidity) {
          throw new Error(
            `${path}: UIDVALIDITY changed from ${expectedUidValidity} to ${currentUidValidity ?? "(missing)"}; refusing mailbox DELETE`,
          );
        }
        if (deletionClient.mailbox?.exists !== 0) {
          throw new Error(`${path}: final deletion-session emptiness proof failed; refusing mailbox DELETE`);
        }
        this.throwIfCleanupAborted();
        await this.runCleanupMutation(
          "twice-proven empty run mailbox DELETE",
          () => deletionClient.mailboxDelete(path),
        );
        this.throwIfCleanupAborted();
      } finally {
        finalProof.release();
      }
      try {
        await deletionClient.logout();
        this.throwIfCleanupAborted();
      } catch {
        if (this.auxiliaryCleanupClients.has(deletionClient)) {
          try { deletionClient.close(); } catch { /* transport already closed */ }
        }
        this.throwIfCleanupAborted();
      }
    } catch (error) {
      try {
        await deletionClient.logout();
        this.throwIfCleanupAborted();
      } catch {
        if (this.auxiliaryCleanupClients.has(deletionClient)) {
          try { deletionClient.close(); } catch { /* transport already closed */ }
        }
        this.throwIfCleanupAborted();
      }
      throw error;
    } finally {
      this.auxiliaryCleanupClients.delete(deletionClient);
    }
  }

  /** Free the persistent fixture connection before opening isolated DELETE
   * sessions. Greenmail enforces a small per-user connection budget and the
   * MCP process may only just have released its IMAP/IDLE sockets. */
  async prepareMailboxDeletion(): Promise<void> {
    await this.close();
  }

  /** SAFE seed: APPEND only into a token-bearing scratch folder. Refuses any
   *  non-scratch folder so the safe gate can never write into real mail. */
  async appendScratch(folder: string, token: string, seed: SeedEmail, flags: string[] = []): Promise<number> {
    assertScratch(folder, token);
    return this.appendOwnedSeed(folder, token, seed, flags);
  }

  /** UIDs whose ownership header exactly equals token. The IMAP SEARCH narrows
   * candidates; a header fetch verifies equality rather than trusting SEARCH's
   * substring semantics. */
  async ownedUids(folder: string, token: string): Promise<number[]> {
    assertOwnershipToken(token);
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        return await this.ownedUidsInSelectedMailbox(token, folder);
      } finally { lock.release(); }
    });
  }

  async isOwnedUid(folder: string, uid: number, token: string): Promise<boolean> {
    assertOwnershipToken(token);
    if (!Number.isSafeInteger(uid) || uid <= 0) return false;
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        return (await this.ownedUidsInSelectedMailbox(token, folder)).includes(uid);
      } finally { lock.release(); }
    });
  }

  /** Prove the current mailbox identity and every exact UID operand while one
   * mailbox selection is held. Token scratch folders additionally require the
   * durable CREATE/UIDVALIDITY proof; existing system folders (currently only
   * INBOX is admitted by the caller) bind directly to their selected
   * UIDVALIDITY and exact run-owned UIDs. */
  async proveOwnedMutation(
    folder: string,
    uids: number[],
    token: string,
  ): Promise<
    | { ok: true; uidValidity: string }
    | { ok: false; reason: "mailbox-identity" }
    | { ok: false; reason: "unowned"; uid: number }
  > {
    assertOwnershipToken(token);
    if (this.ownershipToken !== token || uids.length === 0
      || uids.some((uid) => !Number.isSafeInteger(uid) || uid <= 0 || uid > 0xffff_ffff)) {
      return { ok: false, reason: "mailbox-identity" };
    }
    const creationProof = this.ownershipManifest?.createdMailbox(folder);
    if (isScratchPath(folder, token) && !creationProof) {
      return { ok: false, reason: "mailbox-identity" };
    }

    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        const currentUidValidity = this.selectedUidValidity();
        if (!currentUidValidity
          || (creationProof !== undefined && currentUidValidity !== creationProof.uidValidity)) {
          return { ok: false, reason: "mailbox-identity" } as const;
        }
        const owned = new Set(await this.ownedUidsInSelectedMailbox(token, folder));
        for (const uid of uids) {
          if (!owned.has(uid)) return { ok: false, reason: "unowned", uid } as const;
        }
        return { ok: true, uidValidity: currentUidValidity } as const;
      } finally {
        lock.release();
      }
    });
  }

  /** Compatibility alias used by the safe MCP mutation guard. */
  async isOwnedMessage(folder: string, uid: number, token: string): Promise<boolean> {
    return this.isOwnedUid(folder, uid, token);
  }

  /** Adopt a tool-created SMTP/draft message which could not carry the fixture
   * header. The subject must contain this run's UUID token; only then is its
   * exact Message-ID recorded for ownership checks and cleanup of every copy. */
  async adoptOwnedUid(
    folder: string,
    uid: number,
    token: string,
    expectedSubject: string,
    pendingId: string,
  ): Promise<void> {
    assertOwnershipToken(token);
    this.setOwnershipToken(token);
    if (!Number.isSafeInteger(uid) || uid <= 0) throw new Error(`Invalid UID for adoption: ${uid}`);
    await this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        for await (const msg of this.client.fetch(
          String(uid),
          { uid: true, envelope: true, headers: [E2E_OWNERSHIP_HEADER, "Message-ID", "Subject"] },
          { uid: true },
        )) {
          if (msg.uid !== uid) continue;
          const subject = msg.envelope?.subject ?? headerValue(msg.headers, "subject") ?? "";
          if (subject !== expectedSubject || !subject.includes(token)) {
            throw new Error(`UID ${uid} in ${folder} does not have the exact pending run subject`);
          }
          const messageId = canonicalMessageId(msg.envelope?.messageId ?? headerValue(msg.headers, "message-id"));
          if (!messageId) throw new Error(`UID ${uid} in ${folder} has no Message-ID and cannot be safely adopted`);
          this.requireOwnershipManifest().finalizeMessage(pendingId, { messageId, subject });
          return;
        }
        throw new Error(`UID ${uid} does not exist in ${folder}`);
      } finally { lock.release(); }
    });
  }

  /** Adopt a self-sent tool result by exact Message-ID plus either a tokenized
   * subject or a tokenized body. The server is queried before registration, so
   * an arbitrary ID can never turn pre-existing mail into a cleanup target. */
  async adoptSentMessage(
    messageId: string,
    expectedSubject: string,
    token: string,
    expectedBodyToken?: string,
    pendingId?: string,
  ): Promise<number> {
    assertOwnershipToken(token);
    this.setOwnershipToken(token);
    const canonical = canonicalMessageId(messageId);
    if (!canonical) throw new Error(`Invalid sent Message-ID: ${messageId}`);
    if (!expectedSubject.includes(token) && !expectedBodyToken?.includes(token)) {
      throw new Error(`Sent-message subject or exact body proof must contain run token ${token}`);
    }

    // Proton Bridge can acknowledge SMTP before the delivered message becomes
    // searchable through its IMAP projection. Ten seconds was too short on a
    // mailbox with many labels, especially because one adoption pass may need
    // several seconds of SEARCH calls. Keep the wait bounded, but give Bridge
    // a realistic convergence window.
    const deadline = Date.now() + 45_000;
    const deliveryMailboxRank = (folder: string): number => {
      const normalized = folder.trim().toLowerCase();
      if (normalized === "inbox") return 0;
      if (normalized === "sent" || normalized.endsWith("/sent")) return 1;
      if (this.isAllMailPath(folder)) return 2;
      return 3;
    };
    // Delivery folders are stable for the lifetime of this adoption. Resolve
    // them once and put the likely self-send projections first. We need one
    // authoritative proof to bind the Message-ID; cleanup later searches every
    // folder using that exact ID, so continuing through hundreds of labels
    // after a verified match adds latency without adding ownership safety.
    const folders = (await this.listCleanupMailboxes())
      .map((folder, index) => ({ folder, index }))
      .sort((left, right) => deliveryMailboxRank(left.folder) - deliveryMailboxRank(right.folder)
        || left.index - right.index)
      .map(({ folder }) => folder);
    const likelyDeliveryFolders = folders.filter((folder) => deliveryMailboxRank(folder) < 3);
    const fallbackFolders = folders.filter((folder) => deliveryMailboxRank(folder) === 3);
    let fallbackCursor = 0;
    const verifyFolder = async (folder: string): Promise<boolean> => {
      try {
        return await this.withReconnect(async () => {
          const lock = await this.client.getMailboxLock(folder);
          try {
            if (this.client.mailbox && (this.client.mailbox as { exists?: number }).exists === 0) return false;
            const candidates = await this.client.search({ header: { "message-id": canonical } }, { uid: true });
            if (!Array.isArray(candidates) || candidates.length === 0) return false;
            for await (const msg of this.client.fetch(
              candidates,
              {
                uid: true,
                envelope: true,
                headers: ["Message-ID", "Subject"],
                ...(expectedBodyToken ? { source: true } : {}),
              },
              { uid: true },
            )) {
              const actualId = canonicalMessageId(msg.envelope?.messageId ?? headerValue(msg.headers, "message-id"));
              const subject = msg.envelope?.subject ?? headerValue(msg.headers, "subject") ?? "";
              const source = msg.source ? Buffer.from(msg.source).toString("utf8") : "";
              const bodyProof = !expectedBodyToken || source.includes(expectedBodyToken);
              if (actualId === canonical && subject === expectedSubject && bodyProof) return true;
            }
            return false;
          } finally { lock.release(); }
        });
      } catch {
        // Some virtual folders reject SEARCH. Other selectable folders still
        // provide enough proof; cleanup reports any later residue.
        return false;
      }
    };
    const finalizeAdoption = (): number => {
      if (!pendingId) throw new Error("Sent-message adoption requires its durable pending proof ID");
      this.requireOwnershipManifest().finalizeMessage(pendingId, {
        messageId: canonical,
        subject: expectedSubject,
        ...(expectedBodyToken ? { bodyToken: expectedBodyToken } : {}),
      });
      return 1;
    };

    // Recheck the likely delivery projections every round. Scanning all labels
    // before returning to INBOX allowed a mailbox with ~160 folders to consume
    // the entire deadline in one pass. Unlikely folders still receive bounded,
    // rotating coverage for localized/custom server layouts.
    const FALLBACK_BATCH_SIZE = 8;
    do {
      for (const folder of likelyDeliveryFolders) {
        if (Date.now() >= deadline) break;
        if (await verifyFolder(folder)) return finalizeAdoption();
      }
      const fallbackBatch = Math.min(FALLBACK_BATCH_SIZE, fallbackFolders.length);
      for (let scanned = 0; scanned < fallbackBatch; scanned++) {
        if (Date.now() >= deadline) break;
        const folder = fallbackFolders[fallbackCursor % fallbackFolders.length]!;
        fallbackCursor = (fallbackCursor + 1) % fallbackFolders.length;
        if (await verifyFolder(folder)) return finalizeAdoption();
      }
      const remainingMs = deadline - Date.now();
      if (remainingMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, remainingMs)));
      }
    } while (Date.now() < deadline);
    throw new Error(`Sent Message-ID ${messageId} with subject "${expectedSubject}" was not found for adoption`);
  }

  /** Harness-compatible wrapper. Registration still requires server-side
   * proof of the exact subject and run token; it never blindly trusts an ID. */
  async registerSentMessageId(
    messageId: string,
    token: string,
    expectedSubject?: string,
    expectedBodyToken?: string,
    pendingId?: string,
  ): Promise<void> {
    if (!expectedSubject) throw new Error("Sent-message adoption requires the exact expected subject");
    await this.adoptSentMessage(messageId, expectedSubject, token, expectedBodyToken, pendingId);
  }

  async ownedMessageCount(folder: string, token: string): Promise<number> {
    return (await this.ownedUids(folder, token)).length;
  }

  /** Return currently absent positive UIDs for negative-path tests. */
  async provenMissingUids(folder: string, count = 2): Promise<number[]> {
    if (!Number.isSafeInteger(count) || count < 1 || count > 100) {
      throw new Error(`Invalid missing UID count: ${count}`);
    }
    const present = new Set(await this.listUids(folder));
    const missing: number[] = [];
    for (let uid = 1; missing.length < count; uid++) {
      if (!present.has(uid)) missing.push(uid);
    }
    return missing;
  }

  async missingUid(folder: string): Promise<number> {
    return (await this.provenMissingUids(folder, 1))[0]!;
  }

  /** Move only run-owned messages to Trash, then report verified residue. */
  async moveOwnedToTrash(folder: string, token: string): Promise<OwnedMoveResult> {
    assertOwnershipToken(token);
    if (this.isAllMailPath(folder)) {
      throw new Error(`Refusing to mutate unstable All Mail projection '${folder}'`);
    }
    const trash = await this.resolveTrashMailbox();
    this.throwIfCleanupAborted();
    let moved = 0;
    // A Bridge cleanup session is single-mutation-use. Start from a fresh
    // authenticated view, prove ownership under the selected-mailbox lock,
    // and dispatch at most one exact UID before forcing rediscovery below.
    await this.rotateCleanupSession();
    const lock = await this.client.getMailboxLock(folder);
    let mutationConfirmed = false;
    try {
      this.throwIfCleanupAborted();
      const owned = await this.ownedUidsInSelectedMailbox(token, folder);
      this.throwIfCleanupAborted();
      const batch = bridgeMutationUidBatches(owned)[0];
      if (batch) {
        this.assertUidPlusForMutation();
        const result = await this.runCleanupMutation(
          "exact-owned UID MOVE",
          () => this.client.messageMove(batch, trash, { uid: true }),
        );
        mutationConfirmed = true;
        this.throwIfCleanupAborted();
        this.rememberDestinationUids(trash, result);
        moved = batch.length;
      }
    } catch (error) {
      if (mutationConfirmed && !isFatalCleanupError(error)) {
        const fatal = new MutationOutcomeUnknownError("post-MOVE ownership cleanup");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
      throw error;
    } finally {
      try {
        lock.release();
      } catch (error) {
        if (!mutationConfirmed) throw error;
        const fatal = new MutationOutcomeUnknownError("post-MOVE mailbox lock release");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
    }
    try {
      if (moved > 0) await this.refreshCleanupSession();
      const remainingOwned = await this.ownedMessageCount(folder, token);
      this.throwIfCleanupAborted();
      const remainingTotal = await this.countMessages(folder);
      this.throwIfCleanupAborted();
      return { moved, remainingOwned, remainingTotal };
    } catch (error) {
      if (moved > 0 && !isFatalCleanupError(error)) {
        const fatal = new MutationOutcomeUnknownError("post-MOVE ownership verification");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
      throw error;
    }
  }

  /** Permanently delete only exact run-owned UIDs from one selected mailbox.
   * This is required for Proton virtual/category folders where MOVE can be a
   * no-op. Baseline mail is never an operand. */
  async deleteOwnedMessages(folder: string, token: string): Promise<OwnedMoveResult> {
    assertOwnershipToken(token);
    if (this.isAllMailPath(folder)) {
      throw new Error(`Refusing to mutate unstable All Mail projection '${folder}'`);
    }
    let deleted = 0;
    await this.rotateCleanupSession();
    const lock = await this.client.getMailboxLock(folder);
    let mutationConfirmed = false;
    try {
      this.throwIfCleanupAborted();
      const owned = await this.ownedUidsInSelectedMailbox(token, folder);
      this.throwIfCleanupAborted();
      const batch = bridgeMutationUidBatches(owned)[0];
      if (batch) {
        this.assertUidPlusForMutation();
        await this.runCleanupMutation(
          "exact-owned UID DELETE",
          () => this.client.messageDelete(batch, { uid: true }),
        );
        mutationConfirmed = true;
        this.throwIfCleanupAborted();
        deleted = batch.length;
      }
    } catch (error) {
      if (mutationConfirmed && !isFatalCleanupError(error)) {
        const fatal = new MutationOutcomeUnknownError("post-DELETE ownership cleanup");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
      throw error;
    } finally {
      try {
        lock.release();
      } catch (error) {
        if (!mutationConfirmed) throw error;
        const fatal = new MutationOutcomeUnknownError("post-DELETE mailbox lock release");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
    }
    try {
      if (deleted > 0) await this.refreshCleanupSession();
      const remainingOwned = await this.ownedMessageCount(folder, token);
      this.throwIfCleanupAborted();
      const remainingTotal = await this.countMessages(folder);
      this.throwIfCleanupAborted();
      return { moved: deleted, remainingOwned, remainingTotal };
    } catch (error) {
      if (deleted > 0 && !isFatalCleanupError(error)) {
        const fatal = new MutationOutcomeUnknownError("post-DELETE ownership verification");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
      throw error;
    }
  }

  /** Permanently delete only messages owned by this exact run from Trash. */
  async purgeOwnedTrash(token: string): Promise<number> {
    assertOwnershipToken(token);
    const trash = await this.resolveTrashMailbox();
    this.throwIfCleanupAborted();
    let purged = 0;
    await this.rotateCleanupSession();
    const lock = await this.client.getMailboxLock(trash);
    let mutationConfirmed = false;
    try {
      this.throwIfCleanupAborted();
      const owned = await this.ownedUidsInSelectedMailbox(token, trash);
      this.throwIfCleanupAborted();
      const batch = bridgeMutationUidBatches(owned)[0];
      if (batch) {
        this.assertUidPlusForMutation();
        await this.runCleanupMutation(
          "exact-owned Trash UID DELETE",
          () => this.client.messageDelete(batch, { uid: true }),
        );
        mutationConfirmed = true;
        this.throwIfCleanupAborted();
        purged = batch.length;
      }
    } catch (error) {
      if (mutationConfirmed && !isFatalCleanupError(error)) {
        const fatal = new MutationOutcomeUnknownError("post-Trash-DELETE ownership cleanup");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
      throw error;
    } finally {
      try {
        lock.release();
      } catch (error) {
        if (!mutationConfirmed) throw error;
        const fatal = new MutationOutcomeUnknownError("post-Trash-DELETE mailbox lock release");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
    }
    try {
      if (purged > 0) {
        await this.refreshCleanupSession();
        await this.ownedMessageCount(trash, token);
        this.throwIfCleanupAborted();
      }
      return purged;
    } catch (error) {
      if (purged > 0 && !isFatalCleanupError(error)) {
        const fatal = new MutationOutcomeUnknownError("post-Trash-DELETE ownership verification");
        this.abortCleanupSession(fatal);
        throw fatal;
      }
      throw error;
    }
  }

  async trashOwnedMessageCount(token: string): Promise<number> {
    const trash = await this.resolveTrashMailbox();
    return this.ownedMessageCount(trash, token);
  }

  /** Caller must hold a lock/select on the target mailbox. */
  private async ownedUidsInSelectedMailbox(token: string, folder: string): Promise<number[]> {
    this.throwIfCleanupAborted();
    if (this.client.mailbox && (this.client.mailbox as { exists?: number }).exists === 0) return [];
    const uidValidity = this.selectedUidValidity();
    const manifest = this.ownershipManifest;
    const ownershipQuery = buildOwnershipDiscoveryQuery(
      E2E_OWNERSHIP_HEADER,
      token,
      manifest?.searchMessageIds() ?? [],
      manifest?.searchSubjects(folder) ?? [],
    );
    const discoveryQuery = isScratchPath(folder, token)
      ? { or: [ownershipQuery, { all: true }] }
      : ownershipQuery;
    const discoveryCandidates = await this.client.search(discoveryQuery, { uid: true });
    this.throwIfCleanupAborted();
    const candidates = new Set(Array.isArray(discoveryCandidates) ? discoveryCandidates : []);
    const priorProof = this.ownershipUidProofs.get(folder);
    if (uidValidity && priorProof?.uidValidity === uidValidity) {
      for (const uid of priorProof.uids) {
        candidates.add(uid);
      }
    }
    // Bridge can lag or omit custom-header SEARCH indexing immediately after
    // COPY into a new mailbox. Only for this run's strictly guarded scratch
    // namespace, enumerate every UID and then fetch/verify the exact header.
    // Foreign messages become read-only candidates and never pass the gate.
    if (candidates.size === 0) return [];

    const exact: number[] = [];
    for await (const msg of this.client.fetch(
      [...candidates],
      {
        uid: true,
        envelope: true,
        headers: [E2E_OWNERSHIP_HEADER, "Message-ID", "Subject"],
        ...(manifest?.needsSource() ? { source: true } : {}),
      },
      { uid: true },
    )) {
      this.throwIfCleanupAborted();
      const messageId = canonicalMessageId(msg.envelope?.messageId ?? headerValue(msg.headers, "message-id"));
      const subject = msg.envelope?.subject ?? headerValue(msg.headers, "subject") ?? "";
      if (typeof msg.uid === "number") {
        const exactHeader = hasExactOwnershipHeader(msg.headers, token);
        const candidate = {
          folder,
          uid: msg.uid,
          ...(messageId ? { messageId } : {}),
          subject,
          ...(msg.source ? { source: Buffer.from(msg.source).toString("utf8") } : {}),
        };
        let manifestOwned = !exactHeader && manifest?.matchesFinalized(candidate) === true;
        if (!exactHeader && !manifestOwned) {
          // A lost SMTP/APPEND response leaves only pending subject/body
          // authority. Bind the fetched artifact to its stable Message-ID and
          // fsync that proof before its UID can become a mutation operand.
          manifestOwned = manifest?.promoteObservedPending(candidate) === true;
        }
        if (exactHeader || manifestOwned) exact.push(msg.uid);
      }
    }
    this.throwIfCleanupAborted();
    const sorted = exact.sort((a, b) => a - b);
    if (uidValidity) {
      this.ownershipUidProofs.set(folder, { uidValidity, uids: new Set(sorted) });
    }
    return sorted;
  }

  private selectedUidValidity(): string | undefined {
    const value = this.client.mailbox
      ? (this.client.mailbox as { uidValidity?: bigint | number | string }).uidValidity
      : undefined;
    return value === undefined ? undefined : String(value);
  }

  private rememberDestinationUids(
    folder: string,
    result: false | { uidValidity?: bigint; uidMap?: Map<number, number> },
  ): void {
    if (!result || result.uidValidity === undefined || !result.uidMap?.size) return;
    const uidValidity = String(result.uidValidity);
    const existing = this.ownershipUidProofs.get(folder);
    const uids = existing?.uidValidity === uidValidity ? new Set(existing.uids) : new Set<number>();
    for (const uid of result.uidMap.values()) uids.add(uid);
    this.ownershipUidProofs.set(folder, { uidValidity, uids });
  }

  private async resolveTrashMailbox(): Promise<string> {
    const list = await this.withReconnect(() => this.client.list());
    const specialUse = list.find((mailbox) => mailbox.specialUse?.toLowerCase() === "\\trash");
    if (specialUse) return specialUse.path;
    const named = list.find((mailbox) => mailbox.path.toLowerCase() === "trash");
    if (named) return named.path;
    if (this.opts.allowCreateSystemFolders !== true) {
      throw new Error("No \\Trash special-use mailbox exists; refusing to create a system folder on a live account");
    }
    await this.createMailbox("Trash", true);
    return "Trash";
  }

  private async snapshotMailboxState(folder: string): Promise<MailboxSafetyState> {
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        const uidValidity = this.selectedUidValidity();
        if (!uidValidity) {
          throw new Error(`Selected mailbox ${folder} did not expose UIDVALIDITY`);
        }
        if (this.client.mailbox && (this.client.mailbox as { exists?: number }).exists === 0) {
          return { uidValidity, messages: [] };
        }
        const messages: MailboxSafetyMessage[] = [];
        for await (const msg of this.client.fetch(
          "1:*",
          { uid: true, flags: true, envelope: true, headers: ["Message-ID"] },
          { uid: false },
        )) {
          if (typeof msg.uid !== "number") continue;
          const messageId = canonicalMessageId(msg.envelope?.messageId ?? headerValue(msg.headers, "message-id"));
          messages.push({
            uid: msg.uid,
            ...(messageId ? { messageId } : {}),
            flags: stableFlags(msg.flags),
          });
        }
        return { uidValidity, messages };
      } finally { lock.release(); }
    });
  }

  private requireOwnershipManifest(): OwnershipManifestStore {
    if (!this.ownershipManifest) throw new Error("E2E ownership manifest is not initialized");
    return this.ownershipManifest;
  }

  /** Return the UIDs present in `folder`, sorted ascending. Reconnects
   *  before fetching so the SELECT sees the latest server state — mailpouch
   *  shares the same Greenmail user and its mutations would otherwise be
   *  invisible to a stale persistent SELECT. */
  async listUids(folder: string): Promise<number[]> {
    // withReconnect retries once on a transient "Command failed"/"NoConnection"
    // — Bridge can leave the client wedged right after mailpouch mutates the
    // folder (move/expunge). reconnect() first forces a fresh SELECT so we see
    // the latest server state.
    return this.withReconnect(async () => {
      await this.reconnect();
      const lock = await this.client.getMailboxLock(folder);
      try {
        // Bridge throws "Command failed" on FETCH 1:* against an EMPTY mailbox
        // (the state of a move SOURCE after a successful relocation). The SELECT
        // that getMailboxLock just performed gives the count — short-circuit.
        if ((this.client.mailbox && (this.client.mailbox as { exists?: number }).exists === 0)) return [];
        const uids: number[] = [];
        for await (const msg of this.client.fetch("1:*", { uid: true }, { uid: false })) {
          if (typeof msg.uid === "number") uids.push(msg.uid);
        }
        return uids.sort((a, b) => a - b);
      } finally {
        lock.release();
      }
    });
  }

  /** Number of messages in `folder`. */
  async messageCount(folder: string): Promise<number> {
    return (await this.listUids(folder)).length;
  }

  /** ScratchImap alias for messageCount — used by cleanup to verify a folder is
   *  empty before deleting it (so a no-op move can never orphan mail). STATUS
   *  deliberately avoids the reconnect+SELECT used by listUids(): logging out
   *  while Greenmail has the scratch mailbox selected leaves a stale handle
   *  that makes its later DELETE terminate the connection. */
  async countMessages(folder: string): Promise<number> {
    return this.withReconnect(async () => {
      const status = await this.client.status(folder, { messages: true });
      return status.messages ?? 0;
    });
  }

  /** UIDs in `folder` whose Subject header contains `substr` (server-side
   *  SEARCH). Force a fresh connection first: another IMAP session may have
   *  moved/expunged the message, while Bridge can leave this fixture's prior
   *  SELECT view stale without surfacing an error that withReconnect can see. */
  async searchSubjects(folder: string, substrings: readonly string[]): Promise<Map<string, number[]>> {
    const subjects = [...new Set(substrings)];
    if (subjects.length === 0) return new Map();
    return this.withReconnect(async () => {
      await this.reconnect();
      const lock = await this.client.getMailboxLock(folder);
      try {
        const observed = new Map(subjects.map((subject) => [subject, [] as number[]]));
        for (const subject of subjects) {
          const uids = await this.client.search({ header: { subject } }, { uid: true });
          observed.set(
            subject,
            Array.isArray(uids) ? [...uids].sort((left, right) => left - right) : [],
          );
        }
        return observed;
      } finally {
        lock.release();
      }
    });
  }

  async searchSubject(folder: string, substr: string): Promise<number[]> {
    return (await this.searchSubjects(folder, [substr])).get(substr) ?? [];
  }

  /** Locate a delivered tool-created message by its complete constrained
   * proof. This is read-only and does not trust Message-ID alone. */
  async findMessageByProof(
    folder: string,
    messageId: string,
    subject: string,
    bodyToken: string,
  ): Promise<number[]> {
    const canonical = canonicalMessageId(messageId);
    if (!canonical) throw new Error(`Invalid delivery Message-ID: ${messageId}`);
    if (!bodyToken || !this.ownershipToken || !bodyToken.includes(this.ownershipToken)) {
      throw new Error("Delivery body proof must contain the active run token");
    }
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        const matches = await this.client.search({ header: { "message-id": canonical } }, { uid: true });
        if (!Array.isArray(matches) || matches.length === 0) return [];
        const verified: number[] = [];
        for await (const msg of this.client.fetch(
          matches,
          { uid: true, envelope: true, headers: ["Message-ID", "Subject"], source: true },
          { uid: true },
        )) {
          const actualId = canonicalMessageId(msg.envelope?.messageId ?? headerValue(msg.headers, "message-id"));
          const actualSubject = msg.envelope?.subject ?? headerValue(msg.headers, "subject") ?? "";
          const source = msg.source ? Buffer.from(msg.source).toString("utf8") : "";
          if (typeof msg.uid === "number"
            && actualId === canonical
            && actualSubject === subject
            && source.includes(bodyToken)) {
            verified.push(msg.uid);
          }
        }
        return verified.sort((left, right) => left - right);
      } finally { lock.release(); }
    });
  }

  /** Return the IMAP flags set on a specific UID in `folder`, or null if not found.
   *  Forces a fresh SELECT by reconnecting the client first — mailpouch
   *  operates on the same Greenmail user, so a long-lived ImapFixtures
   *  SELECT can show stale EXISTS counts and ghost UIDs after mailpouch
   *  mutates the mailbox. The reconnect is cheap (< 50 ms) and bulletproof. */
  async getFlagsForUids(
    folder: string,
    uids: readonly number[],
  ): Promise<Map<number, string[] | null>> {
    const requested = [...new Set(uids)].sort((left, right) => left - right);
    if (requested.length === 0) return new Map();
    return this.withReconnect(async () => {
      await this.reconnect();
      const lock = await this.client.getMailboxLock(folder);
      try {
        const observed = new Map(requested.map((uid) => [uid, null as string[] | null]));
        for await (const msg of this.client.fetch(
          requested,
          { flags: true, uid: true },
          { uid: true },
        )) {
          if (typeof msg.uid === "number" && observed.has(msg.uid) && msg.flags) {
            observed.set(msg.uid, Array.from(msg.flags));
          }
        }
        return observed;
      } finally {
        lock.release();
      }
    });
  }

  async getFlags(folder: string, uid: number): Promise<string[] | null> {
    return (await this.getFlagsForUids(folder, [uid])).get(uid) ?? null;
  }

  /** True if the UID exists in `folder`. */
  async uidExists(folder: string, uid: number): Promise<boolean> {
    return (await this.getFlags(folder, uid)) !== null;
  }

  /** Return Subject header for `uid` in `folder`, or null if absent. */
  async getSubject(folder: string, uid: number): Promise<string | null> {
    return this.withReconnect(async () => {
      const lock = await this.client.getMailboxLock(folder);
      try {
        for await (const msg of this.client.fetch(
          `${uid}`,
          { envelope: true, uid: true },
          { uid: true }
        )) {
          if (msg.uid === uid) {
            return msg.envelope?.subject ?? null;
          }
        }
        return null;
      } finally {
        lock.release();
      }
    });
  }

  /**
   * Wipe all user-created mailboxes and clear protected ones (e.g. INBOX) of
   * their contents. Intended for `beforeEach` to give every test a clean slate.
   *
   * Order matters: we delete the deepest paths first so parent mailboxes go
   * last. We never delete protected names.
   */
  async wipe(): Promise<void> {
    // SAFETY: wipe() is destructive — it empties INBOX/Sent/Archive/Trash/Spam/
    // Drafts and deletes every other folder. It must NEVER run against a real
    // mailbox. Bridge mode never enables this; only the disposable Greenmail
    // harness may opt in.
    if (this.opts.allowWipe !== true) {
      throw new Error(
        `ImapFixtures.wipe() refused: this empties INBOX/Sent/Archive/Trash/Spam/Drafts and ` +
        `deletes all other folders on ${this.opts.user}@${this.opts.host}. It only runs against a ` +
        `DISPOSABLE mailbox. Only the Greenmail harness may enable allowWipe.`,
      );
    }
    // Ensure each protected mailbox exists, then empty it. Greenmail starts
    // with only INBOX — the rest are created lazily by tests, so we create
    // them here so subsequent assertions can lock/list them safely.
    for (const folder of this.protectedFolders) {
      try {
        await this.withReconnect(async () => { await this.client.mailboxCreate(folder); });
      } catch {
        // already exists — ignore
      }
    }

    await this.withReconnect(async () => {
      for (const folder of this.protectedFolders) {
        try {
          const lock = await this.client.getMailboxLock(folder);
          try {
            const uids: number[] = [];
            for await (const msg of this.client.fetch("1:*", { uid: true }, { uid: false })) {
              if (typeof msg.uid === "number") uids.push(msg.uid);
            }
            if (uids.length > 0) {
              await this.client.messageDelete(uids.join(","), { uid: true });
            }
          } finally {
            lock.release();
          }
        } catch {
          // folder may not exist on this server — skip
        }
      }
    });

    await this.withReconnect(async () => {
      const all = await this.client.list();
      const deletable = all
        .map((m) => m.path)
        .filter((p) => !this.protectedFolders.has(p))
        .sort((a, b) => b.length - a.length);
      for (const path of deletable) {
        try {
          await this.client.mailboxDelete(path);
        } catch {
          // ignore — placeholder/\Noselect parents and stale entries may fail
        }
      }
    });
  }
}
