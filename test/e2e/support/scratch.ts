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
}

export type ScratchKind = "folders" | "labels" | "allmail";

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

  /** A unique, token-bearing folder path. `allmail` keeps the space-in-name
   *  shape that exposed Bug A, still tagged so the guard recognizes it. */
  path(kind: ScratchKind = "folders"): string {
    const n = ++this.seq;
    if (kind === "labels") return `Labels/${this.token}-${n}`;
    if (kind === "allmail") return `${this.token} All Mail ${n}`;
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

  /** Delete every token-bearing folder, deepest-first. Each delete is guarded,
   *  so even a server listing bug cannot make this touch a non-token folder. */
  async cleanup(): Promise<void> {
    const all = await this.imap.listMailboxes();
    const mine = all.filter((m) => m.includes(this.token)).sort((a, b) => b.length - a.length);
    for (const p of mine) {
      assertScratch(p, this.token);
      try { await this.imap.deleteMailbox(p); } catch { /* best-effort cleanup */ }
    }
    this.created.clear();
  }
}
