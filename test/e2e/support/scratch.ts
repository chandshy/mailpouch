/**
 * Scratch namespace + hard guard for the SAFE (non-destructive) Bridge E2E.
 *
 * The destructive harness (ImapFixtures.wipe) empties system folders and
 * deletes everything — fatal against a real account. The safe gate instead
 * confines ALL of its activity to folders whose NAME carries a unique per-run
 * token (`mpE2E-<ts>-<rand>`). The single invariant — enforced by
 * `assertScratch` on every create / append / delete — is that nothing without
 * the token is ever touched. The operator's real mailbox contains no such
 * folder, so the safe gate is provably incapable of altering existing mail.
 */

/** A fresh, unique, space-free run token embeddable in folder names. */
export function runToken(): string {
  return `mpE2E-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The Message-ID suffix every E2E seed carries (buildMime → `<id>@test.local`).
 * Real Proton mail never has it, so it's the safe marker for purging test
 * MESSAGES from Trash — the message-level analog of the folder-level run token.
 */
export const TEST_MESSAGE_ID_MARKER = "@test.local";

/** Refuse to touch any path that does not carry the run token. This is the one
 *  line that makes the safe gate safe — call it before EVERY create/append/
 *  delete. */
export function assertScratch(path: string, token: string): void {
  if (!token || typeof path !== "string" || !path.includes(token)) {
    throw new Error(
      `Scratch guard REFUSED "${path}": not a scratch folder (missing run token "${token}"). ` +
      `The safe E2E only ever creates, writes, or deletes its own ${token ? token : "mpE2E"}-tagged folders — never existing mail.`,
    );
  }
}

/** The minimal IMAP surface the ScratchSession needs. ImapFixtures satisfies
 *  this; tests can pass a fake to exercise the guard with no server. */
export interface ScratchImap {
  createMailbox(path: string): Promise<void>;
  listMailboxes(): Promise<string[]>;
  deleteMailbox(path: string): Promise<void>;
  /** Move every message in `folder` to Trash (never EXPUNGE-in-place — on
   *  Proton, deleting a folder strands its messages in the unpurgeable All Mail
   *  union; moving to Trash keeps them deletable). */
  emptyToTrash(folder: string): Promise<void>;
  /** Permanently delete messages in Trash whose Message-ID contains `marker`. */
  purgeTrash(marker: string): Promise<void>;
}

export type ScratchKind = "folders" | "labels" | "spaced";

/**
 * Owns a run's scratch folders. Every path it hands out carries the token;
 * create/cleanup are guarded; cleanup deletes ONLY token-bearing folders.
 */
export class ScratchSession {
  readonly token: string;
  private seq = 0;
  private readonly created = new Set<string>();

  constructor(private readonly imap: ScratchImap, token: string = runToken()) {
    this.token = token;
  }

  /** A unique, token-bearing folder path under a system prefix (Folders/ or
   *  Labels/ — never a top-level or reserved name, which Proton rejects).
   *  `spaced` keeps the space-in-name shape that exposed Bug A, tagged so the
   *  guard recognizes it. */
  path(kind: ScratchKind = "folders"): string {
    const n = ++this.seq;
    if (kind === "labels") return `Labels/${this.token}-${n}`;
    if (kind === "spaced") return `Folders/${this.token} spaced ${n}`;
    return `Folders/${this.token}-${n}`;
  }

  /** Create a fresh scratch folder (guarded) and track it. */
  async create(kind: ScratchKind = "folders"): Promise<string> {
    const p = this.path(kind);
    assertScratch(p, this.token);
    await this.imap.createMailbox(p);
    this.created.add(p);
    return p;
  }

  /** Pre-flight: abort if the token somehow already exists on the server, so a
   *  token collision can never make us treat real mail as scratch. */
  async preflight(): Promise<void> {
    const existing = await this.imap.listMailboxes();
    const clash = existing.filter((m) => m.includes(this.token));
    if (clash.length) {
      throw new Error(`Scratch preflight: run token "${this.token}" already present on [${clash.join(", ")}] — aborting.`);
    }
  }

  /**
   * Remove everything this run created, leaving zero residue and never touching
   * real mail. Per Proton's model (deleting a folder strands its messages in the
   * unpurgeable All Mail union), we must purge the MESSAGES first:
   *   1. move each token folder's messages to Trash (never EXPUNGE-in-place),
   *   2. permanently delete the test messages from Trash (clears All Mail too),
   *   3. delete the now-empty token folders.
   * Every step is guarded — only token-bearing folders are emptied/deleted, and
   * only `@test.local` messages are purged from Trash.
   */
  async cleanup(marker: string = TEST_MESSAGE_ID_MARKER): Promise<void> {
    const all = await this.imap.listMailboxes();
    const mine = all.filter((m) => m.includes(this.token)).sort((a, b) => b.length - a.length);
    for (const p of mine) {
      assertScratch(p, this.token);
      try { await this.imap.emptyToTrash(p); } catch { /* best-effort */ }
    }
    try { await this.imap.purgeTrash(marker); } catch { /* best-effort */ }
    for (const p of mine) {
      assertScratch(p, this.token);
      try { await this.imap.deleteMailbox(p); } catch { /* best-effort */ }
    }
    this.created.clear();
  }
}
