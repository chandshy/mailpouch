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

import { ImapFlow } from "imapflow";
import { buildMime, type SeedEmail } from "../support/mime-builder.js";

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
   *  Spam/Drafts and deletes every other folder — safe only against a
   *  disposable mailbox (Greenmail, or an explicitly-confirmed test account).
   *  Must be true for wipe() to run. */
  allowWipe?: boolean;
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

  constructor(opts: ImapFixturesOptions) {
    this.opts = opts;
    this.client = this.makeClient();
    this.protectedFolders = new Set([...DEFAULT_PROTECTED, ...(opts.protectedFolders ?? [])]);
  }

  private makeClient(): ImapFlow {
    return new ImapFlow({
      host: this.opts.host,
      port: this.opts.port,
      secure: false,
      auth: { user: this.opts.user, pass: this.opts.pass },
      logger: false,
      // Bridge's self-signed CN=127.0.0.1 cert (reached via localhost) needs
      // the production TLS handling (pin cert as CA + skip hostname); Greenmail
      // leaves this undefined.
      ...(this.opts.tls ? { tls: this.opts.tls } : {}),
    });
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect();
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    try {
      await this.client.logout();
    } catch {
      // ignore
    }
    this.connected = false;
  }

  /**
   * Self-heal a dead connection. Greenmail terminates IMAP sessions on
   * various edge cases (mailbox deletion of a SELECT'd folder, idle drift);
   * imapflow can't reuse a torn-down socket, so we reconstruct the client.
   */
  private async reconnect(): Promise<void> {
    try {
      await this.client.logout();
    } catch {
      // ignore — socket already dead
    }
    this.connected = false;
    this.client = this.makeClient();
    await this.client.connect();
    this.connected = true;
  }

  /**
   * Run `fn` with a one-shot reconnect on any IMAP error. Greenmail and the
   * mailpouch IMAP service share a single Greenmail instance and concurrently
   * lock/select mailboxes; this can leave imapflow's client in a "Command
   * failed" or "NoConnection" state. We reconnect once and retry — if the
   * second attempt still throws, the error propagates to the test.
   */
  private async withReconnect<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch {
      await this.reconnect();
      return await fn();
    }
  }

  /**
   * Create a mailbox. No-op if it already exists. Greenmail returns a generic
   * "Command failed" on an EXISTS condition rather than a parseable message,
   * so we treat any create error as benign provided the mailbox is present
   * afterward — and propagate only if it's still missing.
   */
  async createMailbox(path: string): Promise<void> {
    await this.withReconnect(async () => {
      try {
        await this.client.mailboxCreate(path);
        return;
      } catch (e: unknown) {
        // Check whether the mailbox is now visible; if yes, the original
        // failure was just "already exists" under a different wire spelling.
        const list = await this.client.list();
        if (list.some((m) => m.path === path)) return;
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

  /** Return all mailbox paths the server knows about (system + user). */
  async listMailboxes(): Promise<string[]> {
    return this.withReconnect(async () => {
      const list = await this.client.list();
      return list.map((m) => m.path);
    });
  }

  /** APPEND a raw MIME message to `folder`. Returns the assigned UID. */
  async appendEmail(folder: string, mime: string, flags: string[] = []): Promise<number> {
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
    return this.appendEmail(folder, buildMime(seed), flags);
  }

  /** Return the UIDs present in `folder`, sorted ascending. Reconnects
   *  before fetching so the SELECT sees the latest server state — mailpouch
   *  shares the same Greenmail user and its mutations would otherwise be
   *  invisible to a stale persistent SELECT. */
  async listUids(folder: string): Promise<number[]> {
    await this.reconnect();
    const lock = await this.client.getMailboxLock(folder);
    try {
      const uids: number[] = [];
      for await (const msg of this.client.fetch("1:*", { uid: true }, { uid: false })) {
        if (typeof msg.uid === "number") uids.push(msg.uid);
      }
      return uids.sort((a, b) => a - b);
    } finally {
      lock.release();
    }
  }

  /** Number of messages in `folder`. */
  async messageCount(folder: string): Promise<number> {
    return (await this.listUids(folder)).length;
  }

  /** Return the IMAP flags set on a specific UID in `folder`, or null if not found.
   *  Forces a fresh SELECT by reconnecting the client first — mailpouch
   *  operates on the same Greenmail user, so a long-lived ImapFixtures
   *  SELECT can show stale EXISTS counts and ghost UIDs after mailpouch
   *  mutates the mailbox. The reconnect is cheap (< 50 ms) and bulletproof. */
  async getFlags(folder: string, uid: number): Promise<string[] | null> {
    await this.reconnect();
    const lock = await this.client.getMailboxLock(folder);
    try {
      for await (const msg of this.client.fetch(
        `${uid}`,
        { flags: true, uid: true },
        { uid: true }
      )) {
        if (msg.uid === uid && msg.flags) {
          return Array.from(msg.flags);
        }
      }
      return null;
    } finally {
      lock.release();
    }
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
    // mailbox. Refuse unless the caller explicitly confirmed a disposable target
    // (Greenmail, or MAILPOUCH_E2E_ALLOW_WIPE=1 for a throwaway Proton account).
    if (this.opts.allowWipe !== true) {
      throw new Error(
        `ImapFixtures.wipe() refused: this empties INBOX/Sent/Archive/Trash/Spam/Drafts and ` +
        `deletes all other folders on ${this.opts.user}@${this.opts.host}. It only runs against a ` +
        `DISPOSABLE mailbox. Greenmail sets allowWipe automatically; for Bridge set ` +
        `MAILPOUCH_E2E_ALLOW_WIPE=1 ONLY when pointed at a throwaway test account — never your real one.`,
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
