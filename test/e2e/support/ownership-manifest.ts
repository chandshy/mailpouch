import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { isRunToken, isScratchPath } from "./scratch.js";
import { resolveBridgeAuthorityScope } from "./bridge-authority-root.mjs";

export interface PendingSentProof {
  id: string;
  kind: "pending-sent";
  subject: string;
  bodyToken?: string;
}

export interface PendingDraftProof {
  id: string;
  kind: "pending-draft";
  folder: string;
  subject: string;
}

export type PendingOwnershipProof = PendingSentProof | PendingDraftProof;

export interface MessageOwnershipProof {
  kind: "message-id";
  messageId: string;
  subject: string;
  bodyToken?: string;
}

export type OwnershipProof = MessageOwnershipProof;

export interface BaselineMessageProof {
  uid: number;
  flags: string[];
  messageIdHash?: string;
}

export interface BaselineMailboxProof {
  path: string;
  uidValidity: string;
  messages: BaselineMessageProof[];
}

export interface OwnershipBaselineProof {
  algorithm: "sha256";
  mailboxPaths: string[];
  mailboxes: BaselineMailboxProof[];
}

/** Identity-bound proof for a mailbox whose CREATE returned created:true.
 * The path alone is never deletion authority because it can be deleted and
 * recreated by another actor while a run or crash recovery is still active. */
export interface CreatedMailboxProof {
  path: string;
  uidValidity: string;
}

export type AllMailRescuePhase = "create-pending" | "copy-pending" | "payload-observed" | "complete";

export interface OwnershipCleanupState {
  /** Lifecycle metadata only. This field never grants message ownership. */
  allMailRescue: AllMailRescuePhase;
  /** SHA-256 replay barriers for operator rescue-COPY nonces. The plaintext
   * nonce is never persisted and each hash is append-only for this run. */
  rescueRearmConsumedHashes?: string[];
}

export interface OwnershipManifest {
  version: 2;
  token: string;
  pending: PendingOwnershipProof[];
  proofs: OwnershipProof[];
  /** Search hints for fixture APPENDs. These never grant ownership by
   * themselves; a fetched message must still carry the exact run header. */
  headerMessageIds: string[];
  /** Mailboxes positively created by this run, bound to their server identity.
   * Token-shaped paths which were merely observed never enter this list. */
  createdMailboxes: CreatedMailboxProof[];
  baseline?: OwnershipBaselineProof;
  cleanup?: OwnershipCleanupState;
}

export interface OwnershipCandidate {
  folder: string;
  uid: number;
  messageId?: string;
  subject: string;
  source?: string;
}

export function ownershipManifestPath(
  token: string,
  options: { authorityConfigPath?: string; mailboxScopeKey?: string; homeRoot?: string } = {},
): string {
  const bridgeAuthorityRequested = options.authorityConfigPath !== undefined
    || process.env.MAILPOUCH_E2E_AUTHORITY_CONFIG !== undefined
    || process.env.MAILPOUCH_E2E_BACKEND === "bridge";
  if (bridgeAuthorityRequested) {
    const scope = resolveBridgeAuthorityScope(options);
    return resolve(scope.scopeRoot, `bridge-run-${token}.json`);
  }
  return resolve(process.cwd(), "test", "e2e", ".tmp", `bridge-run-${token}.json`);
}

export function canonicalMessageId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (/\r|\n|\s/.test(trimmed)) return undefined;
  const unwrapped = trimmed.startsWith("<") && trimmed.endsWith(">")
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!unwrapped || !unwrapped.includes("@") || /[<>]/.test(unwrapped)) return undefined;
  return unwrapped;
}

export function hashOwnershipMessageId(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function safeText(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 998 || /[\r\n\0]/.test(value)) {
    throw new Error(`Invalid E2E ownership ${name}`);
  }
  return value;
}

function tokenizedSubject(value: unknown, token: string): string {
  const subject = safeText(value, "subject");
  if (!subject.includes(token)) throw new Error(`E2E ownership subject does not contain run token ${token}`);
  return subject;
}

function safeFolder(value: unknown): string {
  return safeText(value, "folder");
}

function safeUidValidity(value: unknown): string {
  const text = safeText(value, "UIDVALIDITY");
  if (!/^[1-9][0-9]*$/.test(text) || BigInt(text) > 0xffff_ffffn) {
    throw new Error("Invalid E2E ownership UIDVALIDITY");
  }
  return text;
}

function safeBodyToken(value: unknown, token: string): string | undefined {
  if (value === undefined) return undefined;
  if (value !== token) throw new Error("E2E ownership body proof must equal the exact run token");
  return value;
}

function safePendingId(value: unknown): string {
  if (typeof value !== "string" || !/^pending-[0-9a-f-]{36}$/.test(value)) {
    throw new Error("Invalid E2E pending ownership proof ID");
  }
  return value;
}

function parsePending(value: unknown, token: string): PendingOwnershipProof {
  if (!value || typeof value !== "object") throw new Error("Invalid E2E pending ownership proof");
  const item = value as Record<string, unknown>;
  const id = safePendingId(item.id);
  if (item.kind === "pending-sent") {
    const bodyToken = safeBodyToken(item.bodyToken, token);
    const subject = safeText(item.subject, "subject");
    if (!subject.includes(token) && bodyToken !== token) {
      throw new Error(`Pending sent proof is not constrained by run token ${token}`);
    }
    return { id, kind: "pending-sent", subject, ...(bodyToken ? { bodyToken } : {}) };
  }
  if (item.kind === "pending-draft") {
    return { id, kind: "pending-draft", folder: safeFolder(item.folder), subject: tokenizedSubject(item.subject, token) };
  }
  throw new Error("Unknown E2E pending ownership proof kind");
}

function parseProof(value: unknown, token: string): OwnershipProof {
  if (!value || typeof value !== "object") throw new Error("Invalid E2E ownership proof");
  const item = value as Record<string, unknown>;
  if (item.kind === "message-id") {
    const messageId = canonicalMessageId(typeof item.messageId === "string" ? item.messageId : undefined);
    if (!messageId) throw new Error("Invalid E2E ownership Message-ID proof");
    const bodyToken = safeBodyToken(item.bodyToken, token);
    const subject = safeText(item.subject, "subject");
    if (!subject.includes(token) && bodyToken !== token) {
      throw new Error(`Message-ID proof is not constrained by run token ${token}`);
    }
    return { kind: "message-id", messageId, subject, ...(bodyToken ? { bodyToken } : {}) };
  }
  throw new Error("Unknown E2E ownership proof kind");
}

function parseBaseline(value: unknown): OwnershipBaselineProof {
  if (!value || typeof value !== "object") throw new Error("Invalid E2E ownership baseline");
  const item = value as Record<string, unknown>;
  if (item.algorithm !== "sha256" || !Array.isArray(item.mailboxPaths) || !Array.isArray(item.mailboxes)) {
    throw new Error("Invalid E2E ownership baseline shape");
  }
  const mailboxPaths = item.mailboxPaths.map((path) => safeFolder(path));
  if (new Set(mailboxPaths).size !== mailboxPaths.length) {
    throw new Error("Duplicate E2E baseline mailbox path");
  }
  const pathSet = new Set(mailboxPaths);
  const seen = new Set<string>();
  const mailboxes = item.mailboxes.map((rawMailbox) => {
    if (!rawMailbox || typeof rawMailbox !== "object") throw new Error("Invalid E2E baseline mailbox");
    const mailbox = rawMailbox as Record<string, unknown>;
    const path = safeFolder(mailbox.path);
    if (!pathSet.has(path) || seen.has(path)) throw new Error("Invalid or duplicate E2E baseline mailbox path");
    seen.add(path);
    const uidValidity = safeUidValidity(mailbox.uidValidity);
    if (!Array.isArray(mailbox.messages)) throw new Error("Invalid E2E baseline messages");
    const uids = new Set<number>();
    const messages = mailbox.messages.map((rawMessage) => {
      if (!rawMessage || typeof rawMessage !== "object") throw new Error("Invalid E2E baseline message");
      const message = rawMessage as Record<string, unknown>;
      if (!Number.isSafeInteger(message.uid) || (message.uid as number) < 1 || uids.has(message.uid as number)) {
        throw new Error("Invalid or duplicate E2E baseline UID");
      }
      uids.add(message.uid as number);
      if (!Array.isArray(message.flags)) throw new Error("Invalid E2E baseline flags");
      const flags = message.flags.map((flag) => safeText(flag, "flag")).sort();
      const messageIdHash = message.messageIdHash;
      if (messageIdHash !== undefined
        && (typeof messageIdHash !== "string" || !/^[0-9a-f]{64}$/.test(messageIdHash))) {
        throw new Error("Invalid E2E baseline Message-ID hash");
      }
      return {
        uid: message.uid as number,
        flags,
        ...(typeof messageIdHash === "string" ? { messageIdHash } : {}),
      };
    });
    return { path, uidValidity, messages };
  });
  return { algorithm: "sha256", mailboxPaths, mailboxes };
}

function parseCleanup(value: unknown): OwnershipCleanupState {
  if (!value || typeof value !== "object") throw new Error("Invalid E2E ownership cleanup state");
  const cleanup = value as Record<string, unknown>;
  const phase = cleanup.allMailRescue;
  if (phase !== "create-pending" && phase !== "copy-pending"
    && phase !== "payload-observed" && phase !== "complete") {
    throw new Error("Invalid E2E All Mail rescue phase");
  }
  const consumed = cleanup.rescueRearmConsumedHashes;
  if (consumed !== undefined && (!Array.isArray(consumed)
    || consumed.length > 64
    || consumed.some((hash) => typeof hash !== "string" || !/^[0-9a-f]{64}$/.test(hash))
    || new Set(consumed).size !== consumed.length)) {
    throw new Error("Invalid E2E rescue rearm replay barriers");
  }
  return {
    allMailRescue: phase,
    ...(consumed === undefined ? {} : { rescueRearmConsumedHashes: [...consumed] as string[] }),
  };
}

export function parseOwnershipManifest(raw: unknown, token: string): OwnershipManifest {
  if (!isRunToken(token)) throw new Error(`Invalid E2E ownership token: ${token}`);
  if (!raw || typeof raw !== "object") throw new Error("Invalid E2E ownership manifest");
  const value = raw as Record<string, unknown>;
  if (value.token !== token) throw new Error("E2E ownership manifest token mismatch");

  // Empty v1 manifests created before proof tuples contained no destructive
  // authority and are safe to upgrade. A bare adopted Message-ID can never be
  // upgraded because it lacks the subject/body proof needed to distinguish a
  // run artifact from pre-existing mail.
  if (value.version === 1) {
    if (!Array.isArray(value.adoptedMessageIds) || value.adoptedMessageIds.length !== 0) {
      throw new Error("Legacy E2E manifest contains unverified bare Message-ID claims");
    }
    return { version: 2, token, pending: [], proofs: [], headerMessageIds: [], createdMailboxes: [] };
  }
  if (value.version !== 2 || !Array.isArray(value.pending) || !Array.isArray(value.proofs)) {
    throw new Error("Invalid E2E ownership manifest version or shape");
  }
  const pending = value.pending.map((item) => parsePending(item, token));
  const ids = new Set<string>();
  for (const item of pending) {
    if (ids.has(item.id)) throw new Error(`Duplicate E2E pending proof ID ${item.id}`);
    ids.add(item.id);
  }
  const rawHeaderMessageIds = value.headerMessageIds ?? [];
  if (!Array.isArray(rawHeaderMessageIds)) throw new Error("Invalid E2E ownership header Message-ID hints");
  const headerMessageIds = rawHeaderMessageIds.map((item) => {
    const canonical = canonicalMessageId(typeof item === "string" ? item : undefined);
    if (!canonical) throw new Error("Invalid E2E ownership header Message-ID hint");
    return canonical;
  });
  const rawCreatedMailboxes = value.createdMailboxes ?? [];
  if (!Array.isArray(rawCreatedMailboxes)) throw new Error("Invalid E2E created mailbox proofs");
  const createdMailboxes: CreatedMailboxProof[] = [];
  for (const item of rawCreatedMailboxes) {
    // Early v2 WIP manifests stored only a path. Preserve their message
    // recovery authority but deliberately discard their folder-deletion
    // authority: no UIDVALIDITY means a recreated path cannot be distinguished.
    if (typeof item === "string") {
      const legacyPath = safeFolder(item);
      if (!isScratchPath(legacyPath, token)) {
        throw new Error(`Invalid E2E created mailbox path ${legacyPath}`);
      }
      continue;
    }
    if (!item || typeof item !== "object") throw new Error("Invalid E2E created mailbox proof");
    const rawProof = item as Record<string, unknown>;
    const path = safeFolder(rawProof.path);
    if (!isScratchPath(path, token)) throw new Error(`Invalid E2E created mailbox path ${path}`);
    createdMailboxes.push({ path, uidValidity: safeUidValidity(rawProof.uidValidity) });
  }
  if (new Set(createdMailboxes.map((proof) => proof.path)).size !== createdMailboxes.length) {
    throw new Error("Duplicate E2E created mailbox path proof");
  }
  const baseline = value.baseline === undefined ? undefined : parseBaseline(value.baseline);
  if (baseline && createdMailboxes.some((proof) => baseline.mailboxPaths.includes(proof.path))) {
    throw new Error("E2E created mailbox proof collides with the pre-run baseline");
  }
  return {
    version: 2,
    token,
    pending,
    proofs: value.proofs.map((item) => parseProof(item, token)),
    headerMessageIds: [...new Set(headerMessageIds)],
    createdMailboxes,
    ...(baseline === undefined ? {} : { baseline }),
    ...(value.cleanup === undefined ? {} : { cleanup: parseCleanup(value.cleanup) }),
  };
}

function writeDurable(path: string, manifest: OwnershipManifest): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameSync(temp, path);
    // POSIX needs the directory entry flushed as well as the file contents.
    // Windows does not permit opening directories this way; renameSync still
    // provides the platform's replace semantics there.
    if (process.platform !== "win32") {
      const dirFd = openSync(dirname(path), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* rename or failed create removed it */ }
  }
}

function sameProof(left: OwnershipProof, right: OwnershipProof): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function pendingMatchesCandidate(
  proof: PendingOwnershipProof,
  candidate: OwnershipCandidate,
): boolean {
  if (proof.kind === "pending-sent") {
    return candidate.subject === proof.subject
      && (!proof.bodyToken || candidate.source?.includes(proof.bodyToken) === true);
  }
  return candidate.folder === proof.folder && candidate.subject === proof.subject;
}

/** Pending IDs distinguish dispatch attempts, while this key distinguishes
 * their destructive authority. Identical same-kind attempts are
 * interchangeable and may be retired one distinct Message-ID at a time;
 * different constraints (especially sent vs draft) are ambiguous. */
function pendingConstraintKey(proof: PendingOwnershipProof): string {
  return proof.kind === "pending-sent"
    ? JSON.stringify([proof.kind, proof.subject, proof.bodyToken ?? null])
    : JSON.stringify([proof.kind, proof.folder, proof.subject]);
}

export class OwnershipManifestStore {
  private state: OwnershipManifest;

  constructor(
    readonly token: string,
    readonly path: string = ownershipManifestPath(token),
    initialBaseline?: OwnershipBaselineProof,
  ) {
    if (!isRunToken(token)) throw new Error(`Invalid E2E ownership token: ${token}`);
    if (initialBaseline && existsSync(path)) {
      throw new Error(`Ownership manifest already exists for ${token}; refusing baseline replacement`);
    }
    this.state = existsSync(path)
      ? parseOwnershipManifest(JSON.parse(readFileSync(path, "utf8")) as unknown, token)
      : {
        version: 2,
        token,
        pending: [],
        proofs: [],
        headerMessageIds: [],
        createdMailboxes: [],
        ...(initialBaseline ? { baseline: structuredClone(initialBaseline) } : {}),
      };
    this.persist();
  }

  snapshot(): OwnershipManifest {
    return structuredClone(this.state);
  }

  beginSent(subject: string, bodyToken?: string): string {
    const parsed = parsePending({
      id: `pending-${randomUUID()}`,
      kind: "pending-sent",
      subject,
      ...(bodyToken ? { bodyToken } : {}),
    }, this.token);
    this.state.pending.push(parsed);
    this.persist();
    return parsed.id;
  }

  beginDraft(folder: string, subject: string): string {
    const parsed = parsePending({ id: `pending-${randomUUID()}`, kind: "pending-draft", folder, subject }, this.token);
    this.state.pending.push(parsed);
    this.persist();
    return parsed.id;
  }

  finalizeMessage(pendingId: string, proof: Omit<MessageOwnershipProof, "kind">): void {
    const pending = this.requirePending(pendingId);
    const parsed = parseProof({ kind: "message-id", ...proof }, this.token) as MessageOwnershipProof;
    if (pending.subject !== parsed.subject) throw new Error("Final ownership subject does not match pending proof");
    if (pending.kind === "pending-sent" && pending.bodyToken !== parsed.bodyToken) {
      throw new Error("Final ownership body token does not match pending proof");
    }
    this.state.proofs = this.state.proofs.some((item) => sameProof(item, parsed))
      ? this.state.proofs
      : [...this.state.proofs, parsed];
    this.state.pending = this.state.pending.filter((item) => item.id !== pendingId);
    this.persist();
  }

  /** Convert one exactly observed, headerless pending artifact into durable
   * Message-ID authority before cleanup is allowed to mutate its UID.
   *
   * A fixture seed's Message-ID is a search hint, never pending authority. A
   * Message-ID already present in `proofs` is also refused so one projection
   * cannot consume multiple pending dispatches across cleanup rounds. When
   * several matching pending entries have the same semantic constraint, one
   * is retired for this distinct Message-ID; differing constraints remain
   * fail-closed because the fetched artifact cannot identify which dispatch
   * it represents.
   */
  promoteObservedPending(candidate: OwnershipCandidate): boolean {
    const messageId = canonicalMessageId(candidate.messageId);
    if (!messageId
      || this.state.headerMessageIds.includes(messageId)
      || this.state.proofs.some((proof) => proof.kind === "message-id" && proof.messageId === messageId)) {
      return false;
    }

    const matching = this.state.pending.filter((proof) => pendingMatchesCandidate(proof, candidate));
    if (matching.length === 0) return false;
    const constraint = pendingConstraintKey(matching[0]!);
    if (matching.some((proof) => pendingConstraintKey(proof) !== constraint)) return false;

    const pending = matching[0]!;
    const proof = parseProof({
      kind: "message-id",
      messageId,
      subject: pending.subject,
      ...(pending.kind === "pending-sent" && pending.bodyToken
        ? { bodyToken: pending.bodyToken }
        : {}),
    }, this.token) as MessageOwnershipProof;
    const next: OwnershipManifest = {
      ...this.state,
      proofs: [...this.state.proofs, proof],
      pending: this.state.pending.filter((item) => item.id !== pending.id),
    };

    // Commit durability before publishing the new in-memory authority. If the
    // fsync/rename fails, this throws and the caller never receives the UID as
    // an authorized mutation operand.
    writeDurable(this.path, next);
    this.state = next;
    return true;
  }

  proofs(): readonly OwnershipProof[] {
    return this.state.proofs;
  }

  pending(): readonly PendingOwnershipProof[] {
    return this.state.pending;
  }

  recordCreatedMailbox(path: string, uidValidity: string): void {
    if (!isScratchPath(path, this.token)) {
      throw new Error(`Invalid E2E created mailbox path ${path}`);
    }
    if (this.state.baseline?.mailboxPaths.includes(path)) {
      throw new Error(`Cannot claim baseline mailbox ${path} as E2E-created`);
    }
    const proof: CreatedMailboxProof = { path, uidValidity: safeUidValidity(uidValidity) };
    const existing = this.state.createdMailboxes.find((item) => item.path === path);
    if (existing && existing.uidValidity !== proof.uidValidity) {
      throw new Error(
        `Created mailbox ${path} changed UIDVALIDITY from ${existing.uidValidity} to ${proof.uidValidity}; refusing to replace ownership proof`,
      );
    }
    if (!existing) {
      this.state.createdMailboxes.push(proof);
      this.state.createdMailboxes.sort((left, right) => left.path.localeCompare(right.path));
      this.persist();
    }
  }

  createdMailboxes(): readonly CreatedMailboxProof[] {
    return structuredClone(this.state.createdMailboxes);
  }

  createdMailbox(path: string): CreatedMailboxProof | undefined {
    const proof = this.state.createdMailboxes.find((item) => item.path === path);
    return proof ? structuredClone(proof) : undefined;
  }

  setBaseline(baseline: OwnershipBaselineProof): void {
    const parsed = parseBaseline(baseline);
    if (this.state.baseline && JSON.stringify(this.state.baseline) !== JSON.stringify(parsed)) {
      throw new Error("E2E ownership baseline is already recorded and cannot be replaced");
    }
    this.state.baseline = parsed;
    this.persist();
  }

  baseline(): OwnershipBaselineProof | undefined {
    return this.state.baseline ? structuredClone(this.state.baseline) : undefined;
  }

  allMailRescuePhase(): "idle" | AllMailRescuePhase {
    return this.state.cleanup?.allMailRescue ?? "idle";
  }

  setAllMailRescuePhase(phase: AllMailRescuePhase): void {
    const current = this.allMailRescuePhase();
    const rank: Record<"idle" | AllMailRescuePhase, number> = {
      idle: 0,
      "create-pending": 1,
      "copy-pending": 2,
      "payload-observed": 3,
      complete: 4,
    };
    if (rank[phase] < rank[current]) {
      throw new Error(`All Mail rescue phase cannot move backward from ${current} to ${phase}`);
    }
    if (phase !== current) {
      this.state.cleanup = { ...this.state.cleanup, allMailRescue: phase };
      this.persist();
    }
  }

  recordHeaderMessageId(messageId: string): void {
    const canonical = canonicalMessageId(messageId);
    if (!canonical) throw new Error("Invalid fixture ownership Message-ID hint");
    if (!this.state.headerMessageIds.includes(canonical)) {
      this.state.headerMessageIds.push(canonical);
      this.persist();
    }
  }

  searchMessageIds(): string[] {
    return [...new Set([
      ...this.state.headerMessageIds,
      ...this.state.proofs
      .filter((item): item is MessageOwnershipProof => item.kind === "message-id")
      .map((item) => item.messageId),
    ])];
  }

  searchSubjects(folder: string): string[] {
    const subjects: string[] = [];
    for (const item of this.state.pending) {
      if (item.kind === "pending-sent" || item.folder === folder) subjects.push(item.subject);
    }
    return [...new Set(subjects)];
  }

  needsSource(): boolean {
    return this.state.pending.some((item) => item.kind === "pending-sent" && item.bodyToken !== undefined)
      || this.state.proofs.some((item) => item.kind === "message-id" && item.bodyToken !== undefined);
  }

  matchesFinalized(candidate: OwnershipCandidate): boolean {
    const messageId = canonicalMessageId(candidate.messageId);
    for (const proof of this.state.proofs) {
      if (proof.kind === "message-id") {
        if (messageId === proof.messageId
          && candidate.subject === proof.subject
          && (!proof.bodyToken || candidate.source?.includes(proof.bodyToken) === true)) return true;
      }
    }
    return false;
  }

  matches(candidate: OwnershipCandidate): boolean {
    if (this.matchesFinalized(candidate)) return true;
    for (const proof of this.state.pending) {
      if (pendingMatchesCandidate(proof, candidate)) return true;
    }
    return false;
  }

  complete(): void {
    let removed = false;
    try {
      unlinkSync(this.path);
      removed = true;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (removed && process.platform !== "win32") {
      const fd = openSync(dirname(this.path), "r");
      try { fsyncSync(fd); } finally { closeSync(fd); }
    }
  }

  private requirePending(id: string): PendingOwnershipProof {
    const pending = this.state.pending.find((item) => item.id === id);
    if (!pending) throw new Error(`Unknown pending ownership proof ${id}`);
    return pending;
  }

  private persist(): void {
    writeDurable(this.path, this.state);
  }
}
