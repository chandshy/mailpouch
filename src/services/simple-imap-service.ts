/**
 * IMAP Service for reading emails via Proton Bridge
 */

import { ImapFlow, type SearchObject } from 'imapflow';
import { readFileSync, statSync } from 'fs';
import { join as pathJoin } from 'path';
import type { ParsedMail, Attachment, AddressObject } from 'mailparser';
import { simpleParser } from 'mailparser';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { EmailMessage, EmailFolder, SearchEmailOptions, SaveDraftOptions } from '../types/index.js';
import { logger } from '../utils/logger.js';
import {
  validateImapPath,
  attachmentByteSize,
  MAX_ATTACHMENT_COUNT,
  MAX_ATTACHMENT_BYTES,
  MAX_TOTAL_ATTACHMENT_BYTES,
} from '../utils/helpers.js';
import { buildBridgeTlsOptions, readPinnedBridgeCert } from './bridge-tls.js';
import { classifyError, ConnectionStateError } from '../utils/error-classify.js';
import { tracer, type SpanTags } from '../utils/tracer.js';
import { BRIDGE_MIN_VERSION } from '../config/schema.js';

/**
 * Compare two dotted numeric version strings ("3.22.1" vs "3.22.0").
 * Returns negative, zero, or positive in strcmp fashion.
 * Non-numeric segments and missing trailing segments compare as 0.
 */
function compareSemver(a: string, b: string): number {
  const parse = (s: string) => s.split('.').map(p => parseInt(p, 10) || 0);
  const aa = parse(a);
  const bb = parse(b);
  const len = Math.max(aa.length, bb.length);
  for (let i = 0; i < len; i++) {
    const diff = (aa[i] ?? 0) - (bb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** imapflow's append() return value includes uid at runtime but it is omitted from the type declaration. */
interface AppendResult { uid?: number }

/**
 * Thrown when an IMAP read path cannot reach the server. IMAP-012: read
 * methods used to catch the connection failure and return `[]`, which a caller
 * (or a model summarising "you have 0 emails") could not distinguish from a
 * genuinely empty folder. Surfacing a typed error lets the MCP dispatcher
 * serialise it as a structured error response instead of silent misinformation.
 */
export class IMAPNotConnectedError extends Error {
  constructor(message = 'IMAP connection unavailable') {
    super(message);
    this.name = 'IMAPNotConnectedError';
  }
}

/**
 * imapflow bodyStructure tree node — the shape of each node returned by
 * `FetchQueryObject.bodyStructure`.  Only the properties accessed by
 * `countAttachments()` and `extractAttachmentMeta()` are declared here.
 */
interface ImapBodyNode {
  childNodes?: ImapBodyNode[];
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  parameters?: Record<string, string>;
  type?: string;
  subtype?: string;
  size?: number;
  id?: string;
}

// ImapSearchCriteria is provided by imapflow as SearchObject (imported above).

/**
 * Truncate email body to a reasonable length for list views
 * @param body The full email body
 * @param maxLength Maximum length (default: 300 characters)
 * @returns Truncated body with ellipsis if needed
 */
export function stripHtml(html: string): string {
  if (!html) return '';
  // Decode entities BEFORE stripping tags (PARSE-008). The old order stripped
  // tags first then decoded, so an encoded `&lt;script&gt;...&lt;/script&gt;`
  // emerged as a literal `<script>...</script>` in the FTS body / bodyPreview —
  // stored-XSS if any consumer rendered those fields as HTML. Decoding first
  // turns the encoded markup into real tags that the tag-strip then removes.
  // HTML comments are dropped up front (PARSE-009) so their inner text (e.g.
  // `<!-- secret: pw123 -->`) doesn't survive as tag-stripped prose.
  const decodeEntities = (s: string): string =>
    s
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      // Numeric entities (decimal &#60; and hex &#x3c;) for parity, so
      // `&#60;script&#62;` is also neutralised by the subsequent tag-strip.
      .replace(/&#(\d{1,7});/g, (_m, d) => String.fromCodePoint(Number(d)))
      .replace(/&#x([0-9a-f]{1,6});/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
      .replace(/&amp;/g, '&');

  return decodeEntities(html.replace(/<!--[\s\S]*?-->/g, ' '))
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function truncateBody(body: string, maxLength: number = 300): string {
  if (!body) return '';

  // Remove excessive whitespace and newlines
  const cleaned = body.replace(/\s+/g, ' ').trim();

  if (cleaned.length <= maxLength) {
    return cleaned;
  }

  // Truncate at the last space before maxLength to avoid cutting words
  const truncated = cleaned.substring(0, maxLength);
  const lastSpace = truncated.lastIndexOf(' ');

  if (lastSpace > maxLength * 0.8) {
    return truncated.substring(0, lastSpace) + '...';
  }

  return truncated + '...';
}

/**
 * Normalise a mailparser address field into a flat array of display strings.
 *
 * IMAP-007: `ParsedMail.to` / `.cc` are typed `AddressObject | AddressObject[]
 * | undefined`. When a message carries multiple separate `To:` header lines
 * (legal per RFC 5322 §3.6.3, and emitted by Proton on bridged forwards) the
 * field becomes an array; the old `parsed.to?.text ? [parsed.to.text] : []`
 * shape then collapsed to `[]` and the recipient list silently disappeared.
 */
export function normalizeAddressList(
  field: AddressObject | AddressObject[] | undefined,
): string[] {
  if (!field) return [];
  const objs = Array.isArray(field) ? field : [field];
  const result: string[] = [];
  for (const obj of objs) {
    if (obj?.text) result.push(obj.text);
  }
  return result;
}

/**
 * Split a list of UID strings into wire-bounded chunks suitable for a single
 * IMAP command. Proton Bridge (and other servers) cap command lines around
 * 8 KB; ~800 nine-digit UIDs already exceed that, and IMAP-002 from the
 * 2026-05-28 audit observed the bulk paths silently degrading to per-UID
 * fallback (and minutes of held mailbox lock). This helper caps each chunk
 * at `maxLen` bytes of `,`-joined UIDs, leaving headroom for the IMAP tag,
 * command verb, and surrounding syntax.
 *
 * No sequence-set compression (`1:5,10`) — the runs aren't usually present
 * in production UID lists and the simpler flat representation keeps the
 * fallback behaviour identical.
 */
export function chunkUidsForWire(uids: string[], maxLen: number = 7500): string[] {
  if (uids.length === 0) return [];
  const chunks: string[] = [];
  let cur: string[] = [];
  let curLen = 0;
  for (const id of uids) {
    // Project the cost of adding this UID to the current chunk: the UID's
    // own length plus a leading comma if the chunk already has content.
    const sep = cur.length === 0 ? 0 : 1;
    if (cur.length > 0 && curLen + sep + id.length > maxLen) {
      chunks.push(cur.join(','));
      cur = [];
      curLen = 0;
    }
    // Recompute the separator *after* a potential flush so the first UID in
    // a fresh chunk doesn't carry the previous chunk's comma cost.
    curLen += (cur.length === 0 ? 0 : 1) + id.length;
    cur.push(id);
  }
  if (cur.length > 0) chunks.push(cur.join(','));
  return chunks;
}

/**
 * IMAP-011: expand an IMAP sequence-set string (`1`, `1:5`, `1,3,7:9`) into a
 * flat number array. Guards added:
 *  - reject non-numeric / `*` parts (NaN) so `'1:*'` no longer silently yields
 *    `[1]` and `'a:b'` no longer yields `[NaN]`;
 *  - cap the produced count so a hostile/buggy `1:1000000000` can't allocate a
 *    billion-element array and OOM the process.
 */
const MAX_EXPANDED_SEQUENCE = 10_000;
export function expandImapSequence(range: string): number[] {
  const nums: number[] = [];
  for (const part of range.split(',')) {
    const segs = part.split(':');
    // IMAP sequence-set grammar allows at most one ':' per part; "1:2:3" is
    // malformed and must be rejected, not silently truncated to "1:2".
    if (segs.length > 2) {
      throw new Error(`Invalid IMAP sequence part: ${JSON.stringify(part)}`);
    }
    const [a, b] = segs.map(Number);
    if (!Number.isInteger(a) || a < 1) {
      throw new Error(`Invalid IMAP sequence part: ${JSON.stringify(part)}`);
    }
    if (b === undefined) {
      nums.push(a);
    } else {
      if (!Number.isInteger(b) || b < a) {
        throw new Error(`Invalid IMAP sequence range: ${JSON.stringify(part)}`);
      }
      // Check the projected size BEFORE expanding so a hostile `1:1000000000`
      // can't OOM (or hit "Invalid array length") while growing the array.
      if (nums.length + (b - a + 1) > MAX_EXPANDED_SEQUENCE) {
        throw new Error(`IMAP sequence too large (> ${MAX_EXPANDED_SEQUENCE} UIDs): ${JSON.stringify(range)}`);
      }
      for (let i = a; i <= b; i++) nums.push(i);
    }
    if (nums.length > MAX_EXPANDED_SEQUENCE) {
      throw new Error(`IMAP sequence too large (> ${MAX_EXPANDED_SEQUENCE} UIDs): ${JSON.stringify(range)}`);
    }
  }
  return nums;
}

/** Maximum number of emails held in the in-process cache (count-based guard). */
const MAX_EMAIL_CACHE_SIZE = 500;
/**
 * Maximum total byte estimate for the email cache (byte-size guard).
 * Large HTML marketing emails can exceed 500 KB each; 500 × 500 KB = 250 MB is
 * too much for a background MCP server.  50 MB is a practical upper bound that
 * still allows hundreds of typical messages while preventing memory exhaustion.
 */
const MAX_EMAIL_CACHE_BYTES = 50 * 1024 * 1024; // 50 MB

export class SimpleIMAPService {
  private client: ImapFlow | null = null;
  private isConnected: boolean = false;
  private emailCache: Map<string, { email: EmailMessage; cachedAt: number }> = new Map();
  /** Running byte estimate for emailCache — updated by evictCacheEntry/clearCacheAll/setCacheEntry. */
  private cacheByteEstimate = 0;
  private folderCache: Map<string, EmailFolder> = new Map();
  /** Timestamp (ms) of the last successful folderCache refresh. 0 = never. */
  private folderCachedAt = 0;
  /** TTL for folderCache entries. After expiry, getFolders() fetches fresh data from IMAP. */
  private static readonly FOLDER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
  private connectionConfig: { host: string; port: number; username?: string; password?: string; bridgeCertPath?: string; secure?: boolean; allowInsecureBridge?: boolean } | null = null;
  /** Tracks UIDVALIDITY per folder path to detect server-side mailbox rebuilds. */
  private uidValidityMap: Map<string, bigint> = new Map();
  /** True when TLS certificate validation is disabled (no Bridge cert configured). */
  insecureTls = false;

  /**
   * Rough byte estimate for a single cached EmailMessage.
   * Counts only the variable-length string fields; constant overhead is negligible.
   */
  private static estimateCacheBytes(email: EmailMessage): number {
    return (
      (email.body?.length    ?? 0) +
      (email.subject?.length ?? 0) +
      (email.from?.length    ?? 0) +
      email.to.reduce((s, a) => s + a.length, 0) +
      200 // fixed overhead for id, folder, flags, dates, headers
    );
  }

  /**
   * Remove one entry from emailCache and decrement the byte estimate.
   * Use in place of direct `this.emailCache.delete(id)` everywhere.
   */
  private evictCacheEntry(cacheKey: string): void {
    const entry = this.emailCache.get(cacheKey);
    if (entry) {
      this.cacheByteEstimate -= SimpleIMAPService.estimateCacheBytes(entry.email);
      this.emailCache.delete(cacheKey);
    }
  }

  /**
   * Evict every cached INBOX entry. Called from the IDLE EXISTS/EXPUNGE
   * handlers. IMAP-005: snapshot the keys first (`Array.from`) so a concurrent
   * `setCacheEntry` from a parallel main-client fetch cannot corrupt the
   * iteration, and match the folder case-insensitively so entries cached under
   * an aliased INBOX path (`Inbox`, `inbox`) are still invalidated.
   */
  private evictInboxCacheEntries(): void {
    for (const cacheKey of Array.from(this.emailCache.keys())) {
      const entry = this.emailCache.get(cacheKey);
      if (entry && entry.email.folder.toLowerCase() === 'inbox') {
        this.evictCacheEntry(cacheKey);
      }
    }
  }

  /**
   * Clear the entire emailCache and reset the byte estimate to zero.
   * Use in place of direct `this.emailCache.clear()` everywhere.
   */
  private clearCacheAll(): void {
    this.emailCache.clear();
    this.cacheByteEstimate = 0;
  }

  /**
   * Write an entry to emailCache, evicting oldest entries (FIFO) when either
   * the count cap (500) or the byte cap (50 MB) is reached.
   * Attachment binary content is stripped before caching to avoid multi-MB
   * buffers accumulating in memory (GAP 7.5).
   */
  private setCacheEntry(id: string, email: EmailMessage): void {
    // Cache key is folder-qualified to prevent UID collisions across folders
    const key = `${email.folder}:${id}`;
    // Strip attachment binary content before caching — content is re-fetched on demand
    const toCache: EmailMessage = {
      ...email,
      attachments: email.attachments?.map(a => ({ ...a, content: undefined })),
    };
    const entryBytes = SimpleIMAPService.estimateCacheBytes(toCache);

    // Evict oldest entries until both size and byte limits are satisfied
    while (
      this.emailCache.size > 0 &&
      !this.emailCache.has(key) && // don't evict when updating an existing entry
      (this.emailCache.size >= MAX_EMAIL_CACHE_SIZE ||
       this.cacheByteEstimate + entryBytes > MAX_EMAIL_CACHE_BYTES)
    ) {
      const oldest = this.emailCache.keys().next().value;
      if (oldest === undefined) break;
      this.evictCacheEntry(oldest);
    }

    // If updating an existing entry, subtract its old byte contribution first
    if (this.emailCache.has(key)) {
      const old = this.emailCache.get(key)!;
      this.cacheByteEstimate -= SimpleIMAPService.estimateCacheBytes(old.email);
    }

    this.emailCache.set(key, { email: toCache, cachedAt: Date.now() });
    this.cacheByteEstimate += entryBytes;
  }

  /**
   * Check if the UIDVALIDITY for a folder has changed since we last opened it.
   * If it has, the cached UIDs for that folder are stale — clear the email cache
   * and update the stored value (GAP 7.4).
   */
  private checkAndUpdateUidValidity(folder: string): void {
    try {
      const mailbox = this.client?.mailbox;
      if (!mailbox || typeof mailbox === 'boolean') return;
      const currentValidity = (mailbox as { uidValidity?: bigint }).uidValidity;
      if (currentValidity === undefined) return;

      const stored = this.uidValidityMap.get(folder);
      if (stored !== undefined && stored !== currentValidity) {
        logger.warn(
          `UIDVALIDITY changed for folder "${folder}" (was ${stored}, now ${currentValidity}) — invalidating email cache`,
          'IMAPService'
        );
        // Safe fallback: clear the entire email cache
        this.clearCacheAll();
      }
      this.uidValidityMap.set(folder, currentValidity);
    } catch (error) {
      // IMAP-010: UIDVALIDITY tracking failing is exactly when stale cache is
      // most dangerous (a server-side mailbox rebuild we can't observe). Drop
      // the whole cache conservatively and surface the error at warn so the
      // failure is debuggable instead of silently swallowed.
      logger.warn(
        `UIDVALIDITY check failed for folder "${folder}" — clearing email cache as a precaution`,
        'IMAPService',
        error,
      );
      this.clearCacheAll();
    }
  }

  /**
   * Walk an imapflow bodyStructure tree and count attachment parts.
   * A part is considered an attachment if its disposition is 'attachment'
   * or if its type is neither 'text' nor 'multipart' (GAP 2.4).
   */
  private countAttachments(structure: ImapBodyNode | null | undefined): number {
    if (!structure) return 0;
    // Multipart node — recurse into childNodes
    if (structure.childNodes && Array.isArray(structure.childNodes)) {
      return structure.childNodes.reduce(
        (sum: number, child: ImapBodyNode) => sum + this.countAttachments(child),
        0
      );
    }
    // Leaf node
    const disp = (structure.disposition ?? '').toLowerCase();
    const type = (structure.type ?? '').toLowerCase();
    if (disp === 'attachment') return 1;
    if (type !== 'text' && type !== 'multipart' && type !== '') return 1;
    return 0;
  }

  private static readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** PARSE-014: upper bound on a single attachment download. Raw + base64 +
   *  parser overhead are held in memory simultaneously, so the effective peak
   *  is ~2.5x this. 25 MB matches Proton's own attachment limit. */
  private static readonly MAX_ATTACHMENT_DOWNLOAD_BYTES = 25 * 1024 * 1024;

  private getCacheEntry(uid: string, folder: string): EmailMessage | undefined {
    const key = `${folder}:${uid}`;
    const entry = this.emailCache.get(key);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > SimpleIMAPService.CACHE_TTL_MS) {
      this.evictCacheEntry(key);
      return undefined;
    }
    return entry.email;
  }

  /** Folder-agnostic cache lookup — scans all entries for a matching UID. */
  private findCacheEntryByUid(uid: string): EmailMessage | undefined {
    const suffix = `:${uid}`;
    for (const [key, entry] of this.emailCache.entries()) {
      if (!key.endsWith(suffix)) continue;
      if (Date.now() - entry.cachedAt > SimpleIMAPService.CACHE_TTL_MS) {
        this.evictCacheEntry(key);
        continue;
      }
      return entry.email;
    }
    return undefined;
  }

  /** Validate that an email ID is a numeric UID string (prevents IMAP injection) */
  private validateEmailId(id: string): void {
    // IMAP-015: IMAP UIDs are 32-bit unsigned (1..4_294_967_295). Reject
    // arbitrary-length decimal strings (e.g. 50 nines) that pass `\d+` but are
    // structurally not UIDs — they only ever resolve to "UID not found" while
    // bloating log lines with attacker-controlled digits.
    if (!/^[1-9]\d{0,9}$/.test(id) || Number(id) > 4_294_967_295) {
      throw new Error(`Invalid email ID format: ${JSON.stringify(id)}`);
    }
  }

  /**
   * Issue a UID FETCH within the currently locked folder and return the set of
   * UIDs that actually exist there. Caller must already hold a mailbox lock on
   * the folder. UIDs not returned by the server are absent from the folder —
   * mutations against them would be silent no-ops, so callers should treat
   * them as failed rather than reporting false success.
   *
   * Throws on transport errors (network reset, BAD response, command-too-long).
   * Bulk callers must distinguish "UID not in folder" from "I couldn't even
   * check" — collapsing both into `failed` lies to the caller and recreates
   * the v3.0.41 false-success pattern (IMAP-006 from the 2026-05-28 audit).
   */
  /**
   * Chunked batch IMAP op + per-UID fallback. Centralises the IMAP-002
   * wire-line-cap handling so every bulk path (move/delete/copy/flag) shares
   * one chunking implementation. The per-chunk `perChunk` callback receives
   * a comma-joined UID set bounded by `chunkUidsForWire`; if a chunk fails,
   * its UIDs fall back to the per-UID `perUid` callback. `onSuccess` /
   * `onFailure` let callers update their own counters and cache.
   *
   * IMAP-016: `finalize` (optional) runs exactly once after all chunks, and
   * only if the per-UID fallback was actually exercised. Delete callers pass a
   * single trailing `expunge()` here and make `perUid` a cheap `STORE +FLAGS
   * \Deleted` — so a failed bulk delete degrades to N STOREs + 1 EXPUNGE
   * instead of N serial EXPUNGE round-trips that hold the mailbox lock (and
   * block IDLE) for minutes on Bridge.
   */
  private async chunkedBatchOp(
    present: string[],
    perChunk: (uidSet: string) => Promise<unknown>,
    perUid: (uid: string) => Promise<unknown>,
    onSuccess: (uid: string) => void,
    onFailure: (uid: string, msg: string) => void,
    opName: string,
    folder: string,
    finalize?: () => Promise<unknown>,
  ): Promise<void> {
    const chunks = chunkUidsForWire(present);
    let fallbackUsed = false;
    for (const uidSet of chunks) {
      const chunkUids = uidSet.split(',');
      try {
        await perChunk(uidSet);
        for (const id of chunkUids) onSuccess(id);
      } catch (batchErr: unknown) {
        logger.warn(
          `${opName} batch failed for folder ${folder} (chunk size=${chunkUids.length}), falling back to per-email`,
          'IMAPService',
          batchErr
        );
        for (const id of chunkUids) {
          try {
            await perUid(id);
            fallbackUsed = true;
            onSuccess(id);
          } catch (e: unknown) {
            const m = e instanceof Error ? e.message : String(e);
            onFailure(id, m);
            logger.warn(`${opName} failed for UID ${id} in folder ${folder}`, 'IMAPService', e);
          }
        }
      }
    }
    if (fallbackUsed && finalize) {
      await finalize();
    }
  }

  private async findExistingUidsInLockedFolder(uids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (!this.client || uids.length === 0) return found;
    // IMAP-002: chunk the UID set so a 2000-element preflight doesn't trip
    // Bridge's command-line cap (which would otherwise be misreported by the
    // bulk caller as "every UID missing").
    for (const chunk of chunkUidsForWire(uids)) {
      for await (const msg of this.client.fetch(chunk, { uid: true }, { uid: true })) {
        if (msg && typeof msg.uid === 'number') {
          found.add(msg.uid.toString());
        }
      }
    }
    return found;
  }

  /**
   * Fetch the Message-ID header for a set of UIDs in the CURRENTLY-LOCKED
   * mailbox. Returns uid → Message-ID. Used to verify, after a copy/move, that
   * a message actually landed in the target — UIDs are per-mailbox, so
   * Message-ID is the only stable cross-mailbox identity.
   * MUST be called while the source mailbox is held by getMailboxLock().
   */
  private async fetchMessageIdsForUids(uids: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (!this.client || uids.length === 0) return map;
    for (const chunk of chunkUidsForWire(uids)) {
      for await (const msg of this.client.fetch(chunk, { uid: true, envelope: true }, { uid: true })) {
        const mid = msg?.envelope?.messageId;
        if (msg && typeof msg.uid === 'number' && typeof mid === 'string' && mid) {
          map.set(msg.uid.toString(), mid);
        }
      }
    }
    return map;
  }

  /**
   * Return the subset of `messageIds` that are actually present in
   * `targetFolder`, by searching `HEADER MESSAGE-ID` per id. Locks the target
   * mailbox, so the caller must NOT hold another mailbox lock when calling.
   *
   * This is the honest-counts backstop: a copy/move is only counted as a
   * success once the message is verifiably in the destination. Proton Bridge
   * can answer COPY/MOVE from the All Mail union with OK while doing nothing
   * (RFC-strict servers like Greenmail reject it, which is why this class of
   * silent false-success never surfaced in CI) — verification turns that into
   * an honest failure instead of a lie.
   */
  private async findMessageIdsInFolder(targetFolder: string, messageIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    if (!this.client) return found;
    const unique = [...new Set(messageIds.filter((m): m is string => typeof m === 'string' && m.length > 0))];
    if (unique.length === 0) return found;
    const lock = await this.client.getMailboxLock(targetFolder);
    try {
      for (const mid of unique) {
        try {
          const hits = await this.client.search({ header: { 'message-id': mid } }, { uid: true });
          if (Array.isArray(hits) && hits.length > 0) found.add(mid);
        } catch {
          // a single search miss / transient error → treat as not-found for this
          // id; the caller reports it as an unverified (failed) copy/move.
        }
      }
    } finally {
      lock.release();
    }
    return found;
  }

  /**
   * Record, from an imapflow COPY/MOVE response, which SOURCE uids the server
   * confirmed it relocated. UIDPLUS (advertised by Proton Bridge and Greenmail)
   * returns a COPYUID `uidMap` (source uid → destination uid); its presence is
   * a per-message, identity-independent proof the message landed — cheaper than
   * a Message-ID search and it works even for messages with no Message-ID.
   *
   * Returns true if the response carried a `uidMap` (i.e. the server supports
   * UIDPLUS, so its verdict is authoritative and a Message-ID fallback is not
   * needed). An empty uidMap means the server reported relocating nothing — a
   * no-op — so those uids stay unconfirmed and will be counted as failures.
   */
  private recordRelocatedUids(res: unknown, into: Set<string>): boolean {
    const um = (res as { uidMap?: unknown } | null)?.uidMap;
    if (um instanceof Map) {
      for (const src of um.keys()) into.add(String(src));
      return true;
    }
    return false;
  }

  /** Validate a folder name — reject empty, whitespace-only, overly long, or
   *  names with control characters.
   *
   *  IMAP folder names are encoded as UTF-7 modified strings in IMAP commands.
   *  There is no RFC-mandated maximum, but imapflow serialises the name into an
   *  IMAP command literal; an unbounded name causes excessive command-buffer
   *  allocation in the client and bloats log output.  A 1 000-character limit
   *  is well above any real-world folder name and caps the DoS surface.
   */
  private validateFolderName(name: string): void {
    // VALID-003: delegate to the shared full-path validator in helpers.ts so the
    // service no longer carries a second, drifting copy of the rules (empty /
    // length-1000 / C0-control / ".." traversal). This is a `targetFolder`-style
    // full path (separators allowed), NOT the leaf-only validateFolderName in
    // helpers — hence validateImapPath, the unified full-path check.
    const err = validateImapPath(name);
    if (err) {
      throw new Error(`Invalid folder path: ${err} ${JSON.stringify(String(name).slice(0, 80))}`);
    }
  }

  /**
   * Walk an imapflow bodyStructure tree and extract attachment metadata
   * (filename, contentType, size, contentId) without downloading binary content.
   * Used by getEmails() list view (GAP 2.4).
   */
  private extractAttachmentMeta(structure: ImapBodyNode | null | undefined): Array<{ filename: string; contentType: string; size: number; contentId?: string }> {
    const results: Array<{ filename: string; contentType: string; size: number; contentId?: string }> = [];
    if (!structure) return results;

    if (structure.childNodes && Array.isArray(structure.childNodes)) {
      for (const child of structure.childNodes) {
        results.push(...this.extractAttachmentMeta(child));
      }
      return results;
    }

    const disp = (structure.disposition ?? '').toLowerCase();
    const type = (structure.type ?? '').toLowerCase();
    const isAttachment = disp === 'attachment' ||
      (type !== 'text' && type !== 'multipart' && type !== '');
    if (isAttachment) {
      const params = structure.dispositionParameters ?? structure.parameters ?? {};
      results.push({
        filename: params.filename ?? params.name ?? 'unnamed',
        contentType: structure.type
          ? `${structure.type}/${structure.subtype ?? '*'}`
          : 'application/octet-stream',
        size: structure.size ?? 0,
        contentId: structure.id,
      });
    }
    return results;
  }

  /**
   * Establish an authenticated IMAP connection to the Proton Bridge.
   * @param host Bridge hostname (default: localhost)
   * @param port Bridge IMAP port (default: 1143)
   * @param username Bridge login username
   * @param password Bridge login password
   * @param bridgeCertPath Optional path to a Bridge TLS certificate for localhost trust
   * @param secure Whether to use implicit TLS (true) or STARTTLS (false, default for Bridge)
   * @param allowInsecureBridge Explicit opt-in to run localhost without a pinned cert (default false)
   */
  async connect(host: string = 'localhost', port: number = 1143, username?: string, password?: string, bridgeCertPath?: string, secure?: boolean, allowInsecureBridge: boolean = false): Promise<void> {
    return tracer.span('imap.connect', { host, port, hasCert: !!bridgeCertPath }, async () => {
    logger.debug('Connecting to IMAP server', 'IMAPService', { host, port });

    try {
      // Store connection config for reconnection
      this.connectionConfig = { host, port, username, password, bridgeCertPath, secure, allowInsecureBridge };

      // Check if using localhost (Proton Bridge)
      const isLocalhost = host === 'localhost' || host === '127.0.0.1';
      const allowInsecure = allowInsecureBridge
        || process.env.MAILPOUCH_INSECURE_BRIDGE === '1';

      // Build TLS options
      let tlsOptions: Record<string, unknown> | undefined;
      if (isLocalhost) {
        if (bridgeCertPath) {
          // If a directory was given, look for cert.pem inside it
          let resolvedCertPath = bridgeCertPath;
          try {
            if (statSync(bridgeCertPath).isDirectory()) {
              resolvedCertPath = pathJoin(bridgeCertPath, 'cert.pem');
              logger.info(`IMAP: Directory given for cert path — resolved to ${resolvedCertPath}`, 'IMAPService');
            }
          } catch { /* stat failed — let readFileSync produce the real error below */ }
          try {
            const bridgeCert = readPinnedBridgeCert(resolvedCertPath);
            tlsOptions = buildBridgeTlsOptions(bridgeCert);
            logger.info(`IMAP: Using exported Bridge certificate for TLS trust (${resolvedCertPath})`, 'IMAPService');
          } catch (err) {
            if (!allowInsecure) {
              throw new Error(
                `IMAP: Bridge cert at "${resolvedCertPath}" could not be loaded and allowInsecureBridge is not set. ` +
                `Fix the cert path in Settings → Connection, or set allowInsecureBridge: true ` +
                `(or MAILPOUCH_INSECURE_BRIDGE=1) to opt into the legacy insecure behavior. ` +
                `Underlying error: ${(err as Error).message}`
              );
            }
            logger.warn(
              `IMAP: Failed to load Bridge cert at "${resolvedCertPath}" — running with TLS validation DISABLED (allowInsecureBridge is set). ` +
              `Export a fresh cert from Bridge → Help → Export TLS Certificate and update Settings → Connection to re-secure.`,
              'IMAPService',
              err
            );
            tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
            this.insecureTls = true;
          }
        } else {
          if (!allowInsecure) {
            throw new Error(
              'IMAP: No Bridge certificate configured. Export the cert from Bridge → Help → Export TLS Certificate ' +
              "and set 'bridgeCertPath' in Settings → Connection. To opt into the legacy behavior (TLS validation " +
              'disabled for localhost), set allowInsecureBridge: true or launch with MAILPOUCH_INSECURE_BRIDGE=1.'
            );
          }
          logger.warn(
            'IMAP: No Bridge certificate configured and allowInsecureBridge is set — ' +
            'TLS certificate validation DISABLED for localhost. Export the cert from Bridge → Help → ' +
            'Export TLS Certificate and clear the insecure flag to re-secure.',
            'IMAPService'
          );
          tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
          this.insecureTls = true;
        }
      } else {
        // Non-localhost: full certificate validation required
        tlsOptions = { minVersion: 'TLSv1.2' };
      }

      // Use caller-supplied secure flag if provided; otherwise default to false for
      // localhost (Bridge uses STARTTLS on 1143) and true for non-localhost connections.
      const useSecure = secure !== undefined ? secure : !isLocalhost;

      // Cluster-2 connection leak: tear down any existing client BEFORE we
      // replace the reference. A reconnect() (or a re-connect after a half-open
      // drop) used to overwrite `this.client` and orphan the previous socket —
      // over a long-running process that leaks one FD per reconnect, eventually
      // exhausting Bridge's per-user IMAP session limit.
      if (this.client) {
        const stale = this.client;
        this.client = null;
        this.isConnected = false;
        try { await stale.logout(); }
        catch { try { (stale as unknown as { close?: () => void }).close?.(); } catch { /* already gone */ } }
      }

      this.client = new ImapFlow({
        host,
        port,
        secure: useSecure,
        auth: username && password ? {
          user: username,
          pass: password
        } : undefined,
        logger: false,
        tls: tlsOptions,
        connectionTimeout: 30000,
      });

      // Setup connection event handlers (only if client has event emitter methods)
      if (typeof this.client.on === 'function') {
        this.client.on('close', () => {
          logger.warn('IMAP connection closed', 'IMAPService');
          this.isConnected = false;
        });

        this.client.on('error', (err) => {
          logger.error('IMAP connection error', 'IMAPService', err);
          this.isConnected = false;
        });
      }

      await this.client.connect();
      this.isConnected = true;

      logger.info('IMAP connection established', 'IMAPService');

      // Fire-and-forget Bridge version probe — never block connect on this.
      void this.checkBridgeVersion();
    } catch (error) {
      this.isConnected = false;
      logger.error('IMAP connection failed', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.connect')
  }

  /** Version detected from the IMAP ID response, populated after connect. */
  bridgeVersion: string | null = null;

  /**
   * Issue an IMAP ID (RFC 2971) command and compare the reported Bridge
   * version against BRIDGE_MIN_VERSION. Logs a warning if the running
   * Bridge is older than the floor. Never throws — version detection is
   * best-effort and must not break the connection path.
   *
   * Intentionally warn-only, not a hard block: Bridge occasionally
   * misreports its version via ID (macOS vendor strings sometimes elide
   * the patch component, and some distributions carry security patches
   * into older-looking version strings). Refusing to connect on a false
   * "too old" signal would be worse than a noisy log — Proton's own
   * release notes are the authoritative source. A user who wants a hard
   * gate can wrap the server launch in their own pre-flight check.
   */
  private async checkBridgeVersion(): Promise<void> {
    if (!this.client || !this.isConnected) return;
    try {
      // imapflow exposes id() on ImapFlow; older builds may not. Guard and
      // swallow any failure — a missing ID response is not actionable.
      const idFn = (this.client as unknown as { id?: (info?: Record<string, string>) => Promise<Record<string, string>> }).id;
      if (typeof idFn !== 'function') return;
      const info = await idFn.call(this.client, { name: 'mailpouch' });
      const name = String(info?.name ?? '');
      const version = String(info?.version ?? '');
      if (!version) return;
      this.bridgeVersion = version;
      if (/bridge/i.test(name) && compareSemver(version, BRIDGE_MIN_VERSION) < 0) {
        logger.warn(
          `Proton Bridge ${version} is older than the recommended minimum ${BRIDGE_MIN_VERSION}. ` +
          'Upgrade Bridge for current TLS hardening (v3.21.2) and FIDO2 support (v3.22.0).',
          'IMAPService'
        );
      } else {
        logger.info(`Bridge version ${version} detected (${name || 'unknown vendor'})`, 'IMAPService');
      }
    } catch (err) {
      logger.debug('Bridge version probe failed (non-fatal)', 'IMAPService', err);
    }
  }

  /** Log out and close the IMAP connection gracefully. */
  async disconnect(): Promise<void> {
    return tracer.span('imap.disconnect', {}, async () => {
    if (this.client && this.isConnected) {
      logger.debug('Disconnecting from IMAP server', 'IMAPService');
      // IMAP-019: a rejected logout() (Bridge ungracefully closing the socket
      // during shutdown is common) must NOT leave client/isConnected stale —
      // ensureConnection() would then trust a dead socket. Always tear down.
      try {
        await this.client.logout();
      } catch (error) {
        logger.warn('IMAP logout() failed; forcing local disconnect', 'IMAPService', error);
      } finally {
        this.client = null;
        this.isConnected = false;
      }
      logger.info('IMAP disconnected', 'IMAPService');
    }
    }); // end tracer.span('imap.disconnect')
  }

  /**
   * Attempt to reconnect to IMAP server if connection was lost
   */
  private async reconnect(): Promise<void> {
    if (!this.connectionConfig) {
      throw new Error('Cannot reconnect: no connection config stored');
    }

    logger.info('Attempting to reconnect to IMAP server', 'IMAPService');

    const { host, port, username, password, bridgeCertPath, secure, allowInsecureBridge } = this.connectionConfig;
    await this.connect(host, port, username, password, bridgeCertPath, secure, allowInsecureBridge ?? false);
  }

  /**
   * Ensure connection is active, reconnect if needed
   */
  private async ensureConnection(): Promise<void> {
    // Known login failure → fail fast with operator-actionable guidance and do
    // NOT re-attempt (another bad-password login just re-trips Bridge's "too
    // many login attempts" lockout). This is what an agent's tool call gets, so
    // the user is told exactly what to fix rather than an opaque failure.
    if (this.idleAuthFailure) {
      throw new ConnectionStateError(
        `mailpouch can't sign in to your Proton mailbox — ${this.idleAuthFailure.message} ` +
        `Open the mailpouch Settings UI → Connection, update the Bridge password, then restart mailpouch. ` +
        `Mailbox tools won't work until this is fixed.`,
      );
    }
    if (!this.isConnected || !this.client) {
      logger.warn('IMAP connection lost, attempting to reconnect', 'IMAPService');
      try {
        await this.reconnect();
      } catch (err) {
        const cls = classifyError(err);
        if (cls.category === 'auth') {
          // Record it so further calls fail fast (no repeated lockout-feeding
          // attempts) and the tray surfaces the warning blink.
          this.idleAuthFailure = { message: cls.message, at: new Date() };
          throw new ConnectionStateError(
            `mailpouch can't sign in to your Proton mailbox — ${cls.message} ` +
            `Open the mailpouch Settings UI → Connection, update the Bridge password, then restart mailpouch.`,
          );
        }
        throw new ConnectionStateError(
          `mailpouch couldn't reach Proton Bridge — ${cls.message} ` +
          `Make sure Proton Bridge is running and signed in, then try again.`,
        );
      }
    }
  }

  /** Returns true if the IMAP connection is currently active. */
  isActive(): boolean {
    return this.isConnected && this.client !== null;
  }

  /**
   * Probe the IMAP connection by sending a NOOP command.
   *
   * Unlike `isActive()`, which only inspects the in-memory `isConnected` flag,
   * this method performs a real round-trip to the server so it can detect
   * silent TCP drops where the socket is dead but the flag still reads true.
   *
   * @returns `true` if the server acknowledged the NOOP, `false` otherwise.
   *   Never throws — failures are caught and returned as `false`.
   */
  async healthCheck(): Promise<boolean> {
    const wasConnected = this.isConnected;
    return tracer.span('imap.healthCheck', { wasConnected }, async () => {
    if (!this.client || !this.isConnected) {
      return false;
    }
    try {
      await this.client.noop();
      return true;
    } catch {
      return false;
    }
    }); // end tracer.span('imap.healthCheck')
  }

  /**
   * Clear folderCache and reset the TTL timestamp so the next getFolders() call
   * fetches fresh data from IMAP.  Use in place of direct `this.folderCache.clear()`.
   */
  private clearFolderCache(): void {
    this.folderCache.clear();
    this.folderCachedAt = 0;
  }

  /** Fetch all IMAP folders with message and unseen counts. Results are cached for {@link FOLDER_CACHE_TTL_MS}. */
  async getFolders(): Promise<EmailFolder[]> {
    const tags: SpanTags = {};
    return tracer.span('imap.getFolders', tags, async () => {
    logger.debug('Fetching folders', 'IMAPService');

    // Return cached data if it is still fresh (avoids an IMAP round-trip per call)
    const cacheAge = Date.now() - this.folderCachedAt;
    if (this.folderCache.size > 0 && cacheAge < SimpleIMAPService.FOLDER_CACHE_TTL_MS) {
      logger.debug('Returning cached folders (TTL not expired)', 'IMAPService');
      const cached = Array.from(this.folderCache.values());
      tags.resultCount = cached.length;
      return cached;
    }

    try {
      await this.ensureConnection();
    } catch (error) {
      logger.warn('IMAP not connected, returning cached folders', 'IMAPService');
      const cached = Array.from(this.folderCache.values());
      tags.resultCount = cached.length;
      return cached;
    }

    if (!this.client) {
      logger.warn('IMAP client not available, returning cached folders', 'IMAPService');
      const cached = Array.from(this.folderCache.values());
      tags.resultCount = cached.length;
      return cached;
    }

    try {
      const folders = await this.client.list();
      const result: EmailFolder[] = [];

      const SYSTEM_PATHS = new Set(['inbox','sent','drafts','trash','spam','archive','all mail','starred']);

      // IMAP-022: issue the per-folder STATUS probes concurrently. The previous
      // serial `await` loop cost one full round-trip per folder (30+ on a
      // label-heavy Proton account => >1s per cache miss). imapflow pipelines
      // STATUS commands fine, so Promise.all collapses this to ~one round-trip.
      const client = this.client;
      const statuses = await Promise.all(
        folders.map(folder => client.status(folder.path, { messages: true, unseen: true })),
      );

      folders.forEach((folder, i) => {
        const status = statuses[i];

        let folderType: 'system' | 'user-folder' | 'label';
        if (folder.path.startsWith('Labels/')) {
          folderType = 'label';
        } else if (folder.specialUse || SYSTEM_PATHS.has(folder.path.toLowerCase())) {
          folderType = 'system';
        } else {
          folderType = 'user-folder';
        }

        const emailFolder: EmailFolder = {
          name: folder.name,
          path: folder.path,
          totalMessages: status.messages || 0,
          unreadMessages: status.unseen || 0,
          specialUse: folder.specialUse,
          folderType,
        };

        result.push(emailFolder);
        this.folderCache.set(folder.path, emailFolder);
      });

      // Record the timestamp of this successful refresh
      this.folderCachedAt = Date.now();
      tags.resultCount = result.length;
      logger.info(`Retrieved ${result.length} folders`, 'IMAPService');
      return result;
    } catch (error) {
      logger.error('Failed to fetch folders', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.getFolders')
  }

  /**
   * Fetch a paginated list of emails from an IMAP folder.
   * @param folder Folder path (default: INBOX)
   * @param limit Max emails to return, clamped to 1–200 (default: 50)
   * @param offset Zero-based start index within the folder (default: 0)
   * @returns Array of EmailMessage objects, newest first
   */
  async getEmails(folder: string = 'INBOX', limit: number = 50, offset: number = 0): Promise<EmailMessage[]> {
    this.validateFolderName(folder);
    limit = Math.min(Math.max(1, limit ?? 50), 200);
    offset = Math.max(0, offset ?? 0);
    const tags: SpanTags = { folder, limit, offset };
    return tracer.span('imap.getEmails', tags, async () => {
    logger.debug('Fetching emails', 'IMAPService', { folder, limit, offset });

    try {
      await this.ensureConnection();
    } catch (error) {
      // IMAP-012: do NOT return [] here — an empty array is indistinguishable
      // from a genuinely empty folder. Surface the connection failure.
      logger.warn('IMAP not connected for getEmails', 'IMAPService', error);
      throw new IMAPNotConnectedError(
        `Cannot fetch emails from "${folder}": IMAP connection unavailable`,
      );
    }

    if (!this.client) {
      logger.warn('IMAP client not available for getEmails', 'IMAPService');
      throw new IMAPNotConnectedError(
        `Cannot fetch emails from "${folder}": IMAP client not available`,
      );
    }

    try {
      const lock = await this.client.getMailboxLock(folder);

      try {
        // GAP 7.4: check for UIDVALIDITY changes after opening the mailbox
        this.checkAndUpdateUidValidity(folder);

        const mailbox = this.client.mailbox;
        const total = (mailbox && typeof mailbox !== 'boolean' ? mailbox.exists : 0) || 0;
        const start = Math.max(1, total - offset - limit + 1);
        const end = Math.max(1, total - offset);

        if (start > end || total === 0) {
          return [];
        }

        const messages: EmailMessage[] = [];

        // GAP 2.4 / 5.1: fetch envelope + bodyStructure + text preview only.
        // Do NOT fetch source: true here — that downloads the full RFC 2822 message
        // including all attachment binaries just to render a 300-char preview.
        for await (const message of this.client.fetch(`${start}:${end}`, {
          uid: true,
          flags: true,
          envelope: true,
          bodyStructure: true,
          bodyParts: ['1'],   // TEXT part only (part 1 of multipart, whole body for simple)
        })) {
          try {
            const env = message.envelope;
            if (!env) continue;

            // Decode the text preview from bodyPart '1'
            const rawPart = message.bodyParts?.get('1');
            const bodyText = rawPart ? rawPart.toString('utf-8') : '';
            // IMAP-018: for `multipart/related` (and similar) messages, part '1'
            // is the nested `multipart/*` root, so the fetched bytes are MIME
            // boundary markers + part headers rather than readable text. Detect
            // that shape and suppress it instead of shipping "----=_Part…" noise
            // into the list-view preview. (Pure preview-quality; not data loss.)
            const looksLikeMimeNoise =
              /^\s*--[-=_]/.test(bodyText) ||
              /Content-Type:\s*(multipart|text|application)\//i.test(bodyText);
            const previewSource = looksLikeMimeNoise ? '' : bodyText;
            const looksLikeHtml = /<[a-z][\s\S]*>/i.test(previewSource);
            const bodyPreview = truncateBody(looksLikeHtml ? stripHtml(previewSource) : previewSource);

            // Determine attachment count from bodyStructure without downloading content
            const attachmentCount = this.countAttachments(message.bodyStructure);

            // Build address strings from envelope
            const fromAddr = env.from?.[0]
              ? (env.from[0].name
                  ? `${env.from[0].name} <${env.from[0].address ?? ''}>`
                  : (env.from[0].address ?? ''))
              : '';
            type EnvAddr = { name?: string; address?: string };
            const toAddrs = (env.to ?? []).map((a: EnvAddr) =>
              a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')
            );
            const ccAddrs = (env.cc ?? []).map((a: EnvAddr) =>
              a.name ? `${a.name} <${a.address ?? ''}>` : (a.address ?? '')
            );

            // Build stub attachment metadata from bodyStructure (no content buffers)
            const attachmentMeta = attachmentCount > 0
              ? this.extractAttachmentMeta(message.bodyStructure)
              : undefined;

            const listEmail: EmailMessage = {
              id: message.uid.toString(),
              from: fromAddr,
              to: toAddrs,
              cc: ccAddrs,
              subject: env.subject || '(No Subject)',
              body: bodyPreview,
              bodyPreview,
              isHtml: looksLikeHtml,
              date: env.date ?? new Date(),
              folder,
              isRead: message.flags?.has('\\Seen') ?? false,
              isStarred: message.flags?.has('\\Flagged') ?? false,
              hasAttachment: attachmentCount > 0,
              attachments: attachmentMeta,
              isAnswered: message.flags?.has('\\Answered') ?? false,
              isForwarded: message.flags?.has('\\Forward') ?? false,
            };

            // GAP 2.4: do NOT cache list-view emails — they only have a preview body
            // and stub attachment metadata.  getEmailById() populates the full cache.
            messages.push(listEmail);
          } catch (parseError) {
            logger.warn('Failed to parse email', 'IMAPService', parseError);
          }
        }

        tags.resultCount = messages.length;
        logger.info(`Retrieved ${messages.length} emails from ${folder}`, 'IMAPService');
        return messages.reverse(); // Most recent first
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to fetch emails', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.getEmails')
  }

  /**
   * Fetch a single email by its IMAP UID. Searches all folders; results are cached.
   * @param emailId Numeric UID string (e.g. "12345")
   * @returns The EmailMessage, or null if not found
   */
  async getEmailById(emailId: string, folderHint?: string): Promise<EmailMessage | null> {
    this.validateEmailId(emailId);
    // VALID-001 from the 2026-05-28 audit: callers (six tool handlers)
    // forward args.folder raw via `as string | undefined`. Validate here so
    // a CRLF/path-traversal/quote-injected folder name can't reach
    // getMailboxLock.
    if (folderHint !== undefined) this.validateFolderName(folderHint);
    const tags: SpanTags = { emailId };
    return tracer.span('imap.getEmailById', tags, async () => {
    logger.debug('Fetching email by ID', 'IMAPService', { emailId, folderHint });

    // Check cache first — use folder-qualified key when hint is available
    const cachedEntry = folderHint
      ? this.getCacheEntry(emailId, folderHint)
      : this.findCacheEntryByUid(emailId);
    if (cachedEntry) {
      tags.hasAttachments = !!(cachedEntry.attachments?.length);
      tags.attachmentCount = cachedEntry.attachments?.length ?? 0;
      return cachedEntry;
    }

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return null;
    }

    try {
      // If a folder hint is provided, only look there; otherwise scan all
      // folders — but search the "All Mail" union LAST. All Mail holds every
      // message, so scanning it first reports `folder:"All Mail"` for messages
      // that actually live in a real folder (the union masks the true
      // location). Real folders win; All Mail is the fallback only for mail
      // that genuinely exists nowhere else (true archive).
      const foldersToSearch = folderHint
        ? [{ path: folderHint } as { path: string; specialUse?: string | null }]
        : [...await this.getFolders()].sort(
            (a, b) => (this.isAllMailFolder(a) ? 1 : 0) - (this.isAllMailFolder(b) ? 1 : 0),
          );

      for (const folder of foldersToSearch) {
        const lock = await this.client.getMailboxLock(folder.path);

        try {
          // GAP 7.4: check for UIDVALIDITY changes after opening the mailbox
          this.checkAndUpdateUidValidity(folder.path);

          for await (const message of this.client.fetch(emailId, {
            envelope: true,
            bodyStructure: true,
            flags: true,
            uid: true,
            source: true
          }, { uid: true })) {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);

            const fullBody = parsed.text || parsed.html || '';
            const plainBody = parsed.text || stripHtml(parsed.html || '');

            // Extract content-type for PGP detection
            const contentType = parsed.headers?.get('content-type');
            const ctStr = typeof contentType === 'string' ? contentType : ((contentType as unknown as { value?: string } | null)?.value ?? '');

            // Extract X-Pm-Internal-Id for stable Proton message ID
            const pmId = parsed.headers?.get('x-pm-internal-id');

            const emailMessage: EmailMessage = {
              id: message.uid.toString(),
              from: parsed.from?.text || '',
              to: normalizeAddressList(parsed.to),
              cc: normalizeAddressList(parsed.cc),
              subject: parsed.subject || '(No Subject)',
              body: fullBody, // Full body for individual email view
              bodyPreview: truncateBody(plainBody),
              isHtml: !!parsed.html,
              date: parsed.date || new Date(),
              folder: folder.path,
              isRead: message.flags?.has('\\Seen') || false,
              isStarred: message.flags?.has('\\Flagged') || false,
              hasAttachment: (parsed.attachments?.length || 0) > 0,
              attachments: parsed.attachments?.map((att: Attachment) => ({
                filename: att.filename || 'unnamed',
                contentType: att.contentType,
                size: att.size,
                content: att.content,
                contentId: att.cid
              })),
              headers: parsed.headers
                ? Object.fromEntries(
                    Array.from(parsed.headers.entries()).map(([k, v]) => [
                      k,
                      Array.isArray(v) ? v.join(', ') : String(v),
                    ])
                  )
                : undefined,
              inReplyTo: parsed.inReplyTo,
              references: parsed.references,
              // IMAP flags
              isAnswered: message.flags?.has('\\Answered') ?? false,
              isForwarded: message.flags?.has('\\Forward') ?? false,
              // MIME-level PGP detection
              isSignedPGP: ctStr.includes('multipart/signed') && ctStr.includes('application/pgp-signature'),
              isEncryptedPGP: ctStr.includes('multipart/encrypted') && ctStr.includes('application/pgp-encrypted'),
              // Proton-specific stable ID
              protonId: typeof pmId === 'string' ? pmId.trim() : undefined,
            };

            // GAP 7.5: setCacheEntry strips attachment binary content before storing
            this.setCacheEntry(emailMessage.id, emailMessage);

            tags.hasAttachments = emailMessage.hasAttachment;
            tags.attachmentCount = emailMessage.attachments?.length ?? 0;

            // Return without binary attachment content to caller
            return {
              ...emailMessage,
              attachments: emailMessage.attachments?.map(att => ({
                filename: att.filename,
                contentType: att.contentType,
                size: att.size,
                contentId: att.contentId
                // content intentionally omitted from returned value
              }))
            };
          }
        } finally {
          lock.release();
        }
      }

      return null;
    } catch (error) {
      logger.error('Failed to fetch email by ID', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.getEmailById')
  }

  /**
   * Search a single folder — extracted so multi-folder search can call it per folder.
   * Caller is responsible for ensuring the IMAP client is connected.
   */
  private async searchSingleFolder(folder: string, options: SearchEmailOptions, limit: number): Promise<EmailMessage[]> {
    if (!this.client) return [];
    const lock = await this.client.getMailboxLock(folder);

    try {
      const searchCriteria: SearchObject = {};

      // Strip IMAP search-unsafe characters (quote and backslash) to prevent
      // search criteria injection.  imapflow passes these as quoted strings
      // in the IMAP SEARCH command, so an unescaped '"' would close the
      // quoted string early, and '\' could escape the closing quote.
      // VALID-002: also strip CR/LF/NUL — a value like "x\r\nA002 LOGOUT" would
      // otherwise smuggle a command line into the IMAP stream.
      const sanitizeImapStr = (s: string) => s.replace(/["\\\r\n\x00]/g, "");
      if (options.from) searchCriteria.from = sanitizeImapStr(options.from);
      if (options.to) searchCriteria.to = sanitizeImapStr(options.to);
      if (options.subject) searchCriteria.subject = sanitizeImapStr(options.subject);
      if (options.dateFrom) {
        const d = new Date(options.dateFrom);
        if (!isNaN(d.getTime())) searchCriteria.since = d;
      }
      if (options.dateTo) {
        const d = new Date(options.dateTo);
        if (!isNaN(d.getTime())) searchCriteria.before = d;
      }

      // imapflow SearchObject uses a single boolean for seen/unseen, answered/unanswered,
      // and draft/undraft — `seen: false` means "unseen", etc.
      if (options.isRead    !== undefined) searchCriteria.seen     = options.isRead;
      if (options.isStarred !== undefined) searchCriteria.flagged  = options.isStarred;

      // Body/text search
      if (options.body) searchCriteria.body = sanitizeImapStr(options.body);
      if (options.text) searchCriteria.text = sanitizeImapStr(options.text);

      // Additional header fields
      if (options.bcc) searchCriteria.bcc = sanitizeImapStr(options.bcc);
      // header is { [field]: value } in the SearchObject API (not a tuple).
      // IMAP-004: the field+value here were the only SEARCH inputs not passed
      // through sanitizeImapStr. A raw '"' in the value closes imapflow's
      // quoted string early; a malformed field name breaks the
      // `SEARCH HEADER <field-name> <value>` grammar. Sanitise the value and
      // enforce the RFC 5322 field-name grammar on the field.
      if (options.header) {
        const field = options.header.field;
        if (!/^[A-Za-z][A-Za-z0-9-]*$/.test(field)) {
          throw new Error(`Invalid header field name: ${JSON.stringify(field)}`);
        }
        searchCriteria.header = { [field]: sanitizeImapStr(options.header.value) };
      }

      // Flag criteria — imapflow uses boolean: true = flag set, false = flag not set
      if (options.answered !== undefined) searchCriteria.answered = options.answered;
      if (options.isDraft  !== undefined) searchCriteria.draft    = options.isDraft;

      // Size criteria
      if (options.larger !== undefined)  searchCriteria.larger = options.larger;
      if (options.smaller !== undefined) searchCriteria.smaller = options.smaller;

      // Sent-date criteria (Date: header vs INTERNALDATE)
      if (options.sentBefore) searchCriteria.sentBefore = options.sentBefore;
      if (options.sentSince)  searchCriteria.sentSince  = options.sentSince;

      // Request ESEARCH PARTIAL so the server returns only the first `limit` UIDs
      // rather than the full result set. Falls back transparently to a plain number[]
      // on servers that lack ESEARCH capability (e.g. older Proton Bridge builds),
      // in which case we slice client-side as before.
      const searchResult = await this.client.search(searchCriteria, {
        uid: true,
        returnOptions: [{ partial: `1:${limit}` }],
      });
      const results: EmailMessage[] = [];

      let limitedUids: number[];
      if (Array.isArray(searchResult)) {
        limitedUids = (searchResult as number[]).slice(0, limit);
      } else if (searchResult && typeof searchResult === 'object' && 'partial' in searchResult) {
        const { messages } = (searchResult as { partial: { messages?: string } }).partial;
        limitedUids = messages ? expandImapSequence(messages) : [];
      } else {
        limitedUids = [];
      }

      for (const uid of limitedUids) {
        const uidStr = uid.toString();

        // Serve from cache when possible (folder-qualified to prevent cross-folder collisions)
        const cached = this.getCacheEntry(uidStr, folder);
        if (cached) {
          results.push({
            ...cached,
            body: truncateBody(cached.body),
            attachments: cached.attachments?.map(att => ({
              filename: att.filename,
              contentType: att.contentType,
              size: att.size,
              contentId: att.contentId
            }))
          });
          continue;
        }

        // Fetch directly within this already-held lock — avoids re-acquiring
        // the mailbox lock and the cross-folder UID collision in getEmailById.
        for await (const message of this.client.fetch(uidStr, {
          envelope: true,
          bodyStructure: true,
          flags: true,
          uid: true,
          source: true,
        }, { uid: true })) {
          if (!message.source) continue;
          const parsed = await simpleParser(message.source);

          const fullBody = parsed.text || parsed.html || '';
          const plainBody = parsed.text || stripHtml(parsed.html || '');
          const contentType = parsed.headers?.get('content-type');
          const ctStr = typeof contentType === 'string' ? contentType : ((contentType as unknown as { value?: string } | null)?.value ?? '');
          const pmId = parsed.headers?.get('x-pm-internal-id');

          const emailMessage: EmailMessage = {
            id: message.uid.toString(),
            from: parsed.from?.text || '',
            to: normalizeAddressList(parsed.to),
            cc: normalizeAddressList(parsed.cc),
            subject: parsed.subject || '(No Subject)',
            body: fullBody,
            bodyPreview: truncateBody(plainBody),
            isHtml: !!parsed.html,
            date: parsed.date || new Date(),
            folder,
            isRead: message.flags?.has('\\Seen') || false,
            isStarred: message.flags?.has('\\Flagged') || false,
            hasAttachment: (parsed.attachments?.length || 0) > 0,
            attachments: parsed.attachments?.map((att: Attachment) => ({
              filename: att.filename || 'unnamed',
              contentType: att.contentType,
              size: att.size,
              content: att.content,
              contentId: att.cid
            })),
            headers: parsed.headers
              ? Object.fromEntries(
                  Array.from(parsed.headers.entries()).map(([k, v]) => [
                    k,
                    Array.isArray(v) ? v.join(', ') : String(v),
                  ])
                )
              : undefined,
            inReplyTo: parsed.inReplyTo,
            references: parsed.references,
            isAnswered: message.flags?.has('\\Answered') ?? false,
            isForwarded: message.flags?.has('\\Forward') ?? false,
            isSignedPGP: ctStr.includes('multipart/signed') && ctStr.includes('application/pgp-signature'),
            isEncryptedPGP: ctStr.includes('multipart/encrypted') && ctStr.includes('application/pgp-encrypted'),
            protonId: typeof pmId === 'string' ? pmId.trim() : undefined,
          };

          this.setCacheEntry(emailMessage.id, emailMessage);

          results.push({
            ...emailMessage,
            attachments: emailMessage.attachments?.map(att => ({
              filename: att.filename,
              contentType: att.contentType,
              size: att.size,
              contentId: att.contentId
            }))
          });
        }
      }

      return results;
    } finally {
      lock.release();
    }
  }

  /**
   * Search emails across one or more folders using IMAP SEARCH criteria.
   * @param options Search filters (from, to, subject, dateFrom, dateTo, isRead, isStarred, folders)
   * @returns Array of matching EmailMessage objects, up to the configured per-folder limit
   */
  async searchEmails(options: SearchEmailOptions): Promise<EmailMessage[]> {
    const tags: SpanTags = {
      folder: options.folder || 'INBOX',
      hasSubjectFilter: !!options.subject,
      hasFromFilter: !!options.from,
      hasBodyFilter: !!options.body || !!options.text,
      hasDateFilter: !!(options.dateFrom || options.dateTo),
      hasAnsweredFilter: options.answered !== undefined,
      limit: options.limit || 50,
    };
    return tracer.span('imap.searchEmails', tags, async () => {
    logger.debug('Searching emails', 'IMAPService', options);

    try {
      await this.ensureConnection();
    } catch (error) {
      logger.warn('IMAP not connected', 'IMAPService');
      return [];
    }

    if (!this.client) {
      logger.warn('IMAP client not available', 'IMAPService');
      return [];
    }

    const limit = Math.min(Math.max(1, options.limit || 100), 200);

    // Determine which folders to search
    let foldersToSearch: string[];
    if (options.folders && options.folders.length > 0) {
      if (options.folders[0] === '*' || options.folders[0] === 'all') {
        // Search all available folders (capped at 20 to prevent abuse)
        const allFolders = await this.getFolders();
        foldersToSearch = allFolders.slice(0, 20).map(f => f.path);
      } else {
        // Cap at 20 explicit folders
        foldersToSearch = options.folders.slice(0, 20);
      }
    } else {
      // Single folder — original behaviour (defaults to INBOX)
      foldersToSearch = [options.folder || 'INBOX'];
    }

    // Validate all folder names before starting
    for (const f of foldersToSearch) {
      this.validateFolderName(f);
    }

    try {
      if (foldersToSearch.length === 1) {
        // Fast path: no merging needed
        const results = await this.searchSingleFolder(foldersToSearch[0], options, limit);
        const filtered = options.hasAttachment !== undefined
          ? results.filter(e => e.hasAttachment === options.hasAttachment)
          : results;
        tags.resultCount = filtered.length;
        logger.info(`Search found ${filtered.length} emails`, 'IMAPService');
        return filtered;
      }

      // Multi-folder: search each, merge, sort by date desc, apply limit
      const settled = await Promise.allSettled(
        foldersToSearch.map(f => this.searchSingleFolder(f, options, limit))
      );

      const merged: EmailMessage[] = [];
      for (const r of settled) {
        if (r.status === 'fulfilled') merged.push(...r.value);
      }

      merged.sort((a, b) => b.date.getTime() - a.date.getTime());

      const limited = merged.slice(0, limit);
      const filtered = options.hasAttachment !== undefined
        ? limited.filter(e => e.hasAttachment === options.hasAttachment)
        : limited;

      tags.resultCount = filtered.length;
      logger.info(`Multi-folder search found ${filtered.length} emails across ${foldersToSearch.length} folders`, 'IMAPService');
      return filtered;
    } catch (error) {
      logger.error('Failed to search emails', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.searchEmails')
  }

  /**
   * Download the binary content of an attachment.
   * The content is sourced from the in-process email cache (populated by
   * getEmailById / getEmails). If the email is not yet cached, a fetch is
   * triggered first.
   *
   * Returns null if the email or attachment index is not found.
   */
  async downloadAttachment(emailId: string, attachmentIndex: number): Promise<{
    filename: string;
    contentType: string;
    size: number;
    content: string;
    encoding: "base64";
  } | null> {
    this.validateEmailId(emailId);
    const tags: SpanTags = { emailId, attachmentIndex };
    return tracer.span('imap.downloadAttachment', tags, async () => {
    logger.debug('Downloading attachment', 'IMAPService', { emailId, attachmentIndex });

    // Get email metadata — prefer cache hit, then fall through to IMAP fetch
    let emailMeta: EmailMessage | null | undefined = this.findCacheEntryByUid(emailId);
    if (!emailMeta) {
      emailMeta = await this.getEmailById(emailId);
    }

    if (!emailMeta || !emailMeta.attachments || emailMeta.attachments.length === 0) {
      return null;
    }

    const idx = Math.trunc(attachmentIndex);
    if (idx < 0 || idx >= emailMeta.attachments.length) {
      return null;
    }

    let att = emailMeta.attachments[idx];

    // PARSE-014: downloading re-fetches the full RFC822 source then base64-
    // encodes the whole attachment in memory (~raw + ~1.33x base64 + parser
    // overhead held simultaneously). True streaming is a larger refactor;
    // until then a bounded-size guard rejects oversize attachments before we
    // commit that memory, with a clear error instead of an OOM.
    if (typeof att.size === 'number' && att.size > SimpleIMAPService.MAX_ATTACHMENT_DOWNLOAD_BYTES) {
      throw new Error(
        `Attachment is too large to download (${Math.round(att.size / (1024 * 1024))} MB; ` +
        `limit ${Math.round(SimpleIMAPService.MAX_ATTACHMENT_DOWNLOAD_BYTES / (1024 * 1024))} MB).`,
      );
    }

    // GAP 7.5: attachment content is stripped from cache — re-fetch full source on demand
    if (!att.content) {
      logger.debug('Attachment content not in cache, re-fetching full email source', 'IMAPService', { emailId, attachmentIndex });
      const fresh = await this.fetchEmailFullSource(emailId, emailMeta.folder);
      const freshAtt = fresh?.attachments?.[idx];
      if (!freshAtt?.content) {
        logger.warn('Attachment content unavailable after re-fetch', 'IMAPService', { emailId, attachmentIndex });
        return null;
      }
      att = freshAtt;
    }

    let content: string;
    if (Buffer.isBuffer(att.content)) {
      content = att.content.toString('base64');
    } else {
      // Already a base64 string
      content = att.content as string;
    }

    tags.sizeBytes = att.size;
    return {
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      content,
      encoding: "base64",
    };
    }); // end tracer.span('imap.downloadAttachment')
  }

  /**
   * Fetch a single email's full RFC 2822 source WITHOUT caching the result.
   * Used by downloadAttachment() to retrieve attachment binary content on demand
   * when the cache entry has had its attachment content stripped (GAP 7.5).
   */
  private async fetchEmailFullSource(emailId: string, folderHint?: string): Promise<EmailMessage | null> {
    if (!this.client || !this.isConnected) return null;
    try {
      const foldersToSearch = folderHint ? [{ path: folderHint }] : await this.getFolders();
      for (const folder of foldersToSearch) {
        const lock = await this.client.getMailboxLock(folder.path);
        try {
          for await (const message of this.client.fetch(emailId, {
            uid: true,
            flags: true,
            source: true,
          }, { uid: true })) {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);
            const fullBody = parsed.text || parsed.html || '';
            const plainBody = parsed.text || stripHtml(parsed.html || '');
            return {
              id: message.uid.toString(),
              from: parsed.from?.text || '',
              to: normalizeAddressList(parsed.to),
              cc: normalizeAddressList(parsed.cc),
              subject: parsed.subject || '(No Subject)',
              body: fullBody,
              bodyPreview: truncateBody(plainBody),
              isHtml: !!parsed.html,
              date: parsed.date || new Date(),
              folder: folder.path,
              isRead: message.flags?.has('\\Seen') || false,
              isStarred: message.flags?.has('\\Flagged') || false,
              hasAttachment: (parsed.attachments?.length || 0) > 0,
              attachments: parsed.attachments?.map((att: Attachment) => ({
                filename: att.filename || 'unnamed',
                contentType: att.contentType,
                size: att.size,
                content: att.content,
                contentId: att.cid,
              })),
            };
          }
        } finally {
          lock.release();
        }
      }
    } catch (error) {
      logger.error('Failed to fetch full email source for attachment download', 'IMAPService', error);
    }
    return null;
  }

  /**
   * Resolve the server-side Drafts folder path.
   * Prefers the folder with specialUse === '\\Drafts'; falls back to a
   * case-insensitive name match against common names.
   *
   * SMTP-011: returns `null` when no Drafts folder can be resolved instead of a
   * literal "Drafts" string. The old fallback caused `append("Drafts", ...)` to
   * fail late with an opaque server error on accounts where Drafts was renamed
   * (e.g. "Brouillons"), localised, or deleted. `saveDraft` turns the null into
   * an actionable error.
   */
  private async findDraftsFolder(): Promise<string | null> {
    // Check folder cache first (populated by getFolders / markEmailRead etc.)
    const cached = Array.from(this.folderCache.values());
    const fromCache = this.pickDraftsFolder(cached);
    if (fromCache) return fromCache;

    // Cache miss — refresh and retry
    try {
      const folders = await this.getFolders();
      const found = this.pickDraftsFolder(folders);
      if (found) return found;
    } catch (error) {
      // IMAP-013: folder discovery itself failed (network/auth) — this is NOT
      // the same as "no Drafts folder exists". Log the actionable cause so the
      // caller's "no Drafts folder" message isn't the only signal.
      logger.warn('findDraftsFolder: folder discovery failed; treating as no Drafts folder', 'IMAPService', error);
    }

    return null;
  }

  private pickDraftsFolder(folders: EmailFolder[]): string | null {
    // IMAP special-use attribute wins
    const bySpecialUse = folders.find(f => f.specialUse === '\\Drafts');
    if (bySpecialUse) return bySpecialUse.path;

    // Case-insensitive name / path match
    const names = ['drafts', 'draft', '[gmail]/drafts'];
    const byName = folders.find(f =>
      names.includes(f.name.toLowerCase()) || names.includes(f.path.toLowerCase())
    );
    if (byName) return byName.path;

    return null;
  }

  /**
   * Save an email as a draft in the Drafts folder via IMAP APPEND.
   * Builds the raw MIME message using nodemailer's stream transport, then
   * appends it with the \Draft flag set.
   *
   * Returns the UID assigned by the server, or undefined if the server does
   * not report one.
   */
  async saveDraft(options: SaveDraftOptions): Promise<{ success: boolean; uid?: number; error?: string }> {
    return tracer.span('imap.saveDraft', { hasAttachments: !!(options.attachments?.length), attachmentCount: options.attachments?.length || 0 }, async () => {
    logger.debug('Saving draft', 'IMAPService', { subject: options.subject });

    if (!this.client || !this.isConnected) {
      return { success: false, error: 'IMAP not connected' };
    }

    try {
      // SMTP-012: strip CR/LF/NUL from header-bound fields (subject, to, cc,
      // bcc) before handing them to nodemailer, mirroring stripHeaderInjection()
      // in smtp-service.ts. The previous comment claimed parity but only the
      // inReplyTo/references/attachment paths were sanitised — subject/to/cc/bcc
      // flowed through raw, so "Hello\r\nBcc: leak@evil.com" could inject a
      // header line into the appended MIME.
      const stripCrlf = (s: string) => s.replace(/[\r\n\x00]/g, "");
      // VALID-013: inReplyTo and references are sibling Message-ID header
      // fields and must share ONE sanitiser. The reference list historically
      // stripped the full C0/C1+DEL range; inReplyTo only stripped CR/LF/NUL.
      // Unify on the broader mask (strictly safer than CRLF-only) for both —
      // C0 (0x00–0x1f), DEL and C1 (0x7f–0x9f).
      const stripHeaderField = (s: string) => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

      // Build the raw MIME message using nodemailer's buffer transport
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });

      const joinAddrs = (v: string | string[] | undefined) =>
        !v ? undefined : stripCrlf(Array.isArray(v) ? v.join(', ') : v);
      const toAddresses = joinAddrs(options.to);
      const ccAddresses = joinAddrs(options.cc);
      const bccAddresses = joinAddrs(options.bcc);

      const mailOptions: SendMailOptions = {
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject: stripCrlf(options.subject || '(No Subject)'),
        text: options.isHtml ? undefined : (options.body || ''),
        html: options.isHtml ? (options.body || '') : undefined,
        // VALID-013: both Message-ID header fields use the same broad mask.
        inReplyTo: options.inReplyTo ? stripHeaderField(options.inReplyTo) : undefined,
        references: options.references?.map(stripHeaderField).join(' '),
      };

      if (options.attachments && options.attachments.length > 0) {
        // VALID-005: enforce the SAME count/size caps as the SMTP send path
        // (smtp-service.ts). saveDraft previously mirrored only the sanitisation,
        // so an unbounded base64 payload could OOM the process before append.
        if (options.attachments.length > MAX_ATTACHMENT_COUNT) {
          return { success: false, error: `Too many attachments: ${options.attachments.length} supplied, max ${MAX_ATTACHMENT_COUNT} allowed.` };
        }
        let totalBytes = 0;
        for (const att of options.attachments) {
          const bytes = attachmentByteSize(att.content);
          if (bytes === null) {
            return { success: false, error: `Attachment '${att.filename ?? "unnamed"}': content must be a Buffer or base64 string.` };
          }
          if (bytes > MAX_ATTACHMENT_BYTES) {
            return { success: false, error: `Attachment '${att.filename ?? "unnamed"}' is too large: ${Math.round(bytes / 1024 / 1024)}MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB per-file limit.` };
          }
          totalBytes += bytes;
          if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
            return { success: false, error: `Total attachment size exceeds the ${MAX_TOTAL_ATTACHMENT_BYTES / 1024 / 1024}MB limit.` };
          }
        }

        // Mirror the sanitization performed in smtp-service.ts sendEmail() to prevent
        // MIME header injection via crafted attachment filenames or content-type values.
        // A filename like "a.pdf\r\nContent-Type: text/html" or a contentType like
        // "text/html\r\nX-Injected: yes" could break the MIME structure of the draft.
        mailOptions.attachments = options.attachments.map(att => {
          // Strip CRLF/NUL from filename to prevent Content-Disposition header injection.
          const safeFilename = att.filename
            ? att.filename.replace(/[\r\n\x00]/g, "").slice(0, 255) || "attachment"
            : undefined;

          // Strip CRLF/NUL from contentType and validate it matches type/subtype format.
          // An unsanitized contentType is placed directly in the Content-Type MIME header.
          const rawCt = att.contentType ? att.contentType.replace(/[\r\n\x00]/g, "").trim() : undefined;
          const safeContentType =
            rawCt && /^[\w!#$&\-^]+\/[\w!#$&\-^+.]+$/.test(rawCt) ? rawCt : undefined;

          return {
            filename:    safeFilename,
            content:     att.content,
            contentType: safeContentType,
            cid:         att.contentId,
          };
        });
      }

      const info = await transport.sendMail(mailOptions);
      const rawMime = info.message as Buffer;

      // Append to Drafts folder with the \Draft IMAP flag.
      // SMTP-011: surface an actionable error when no Drafts mailbox exists
      // instead of appending to a literal "Drafts" path that the server rejects.
      const draftsPath = await this.findDraftsFolder();
      if (!draftsPath) {
        logger.warn('No Drafts folder found for this account', 'IMAPService');
        return { success: false, error: 'No Drafts folder found for this account; create or configure a Drafts mailbox.' };
      }
      const result = await this.client.append(draftsPath, rawMime, ['\\Draft']);

      const uid = result && typeof result === 'object' ? (result as AppendResult).uid : undefined;
      logger.info('Draft saved', 'IMAPService', { uid });
      return { success: true, uid };
    } catch (error: unknown) {
      logger.error('Failed to save draft', 'IMAPService', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
    }); // end tracer.span('imap.saveDraft')
  }

  /**
   * Set the \Seen flag on an email.
   * @param emailId Numeric UID string of the email to update
   * @param isRead true to mark as read, false to mark as unread (default: true)
   * @param sourceFolder When provided, operate directly on this folder. Skips
   *   the cache lookup that can collide on cross-folder UIDs. Strongly
   *   recommended whenever the UID came from a folder other than INBOX.
   * @returns true on success, false if not connected. Throws if the UID does
   *   not exist in the resolved folder.
   */
  async markEmailRead(emailId: string, isRead: boolean = true, sourceFolder?: string): Promise<boolean> {
    this.validateEmailId(emailId);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    return tracer.span('imap.markEmailRead', { emailId, isRead, sourceFolder }, async () => {
    logger.debug('Marking email read status', 'IMAPService', { emailId, isRead, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      let folder: string;
      if (sourceFolder) {
        folder = sourceFolder;
      } else {
        const email = await this.getEmailById(emailId);
        if (!email) {
          throw new Error(`Email ${emailId} not found`);
        }
        folder = email.folder;
      }

      const lock = await this.client.getMailboxLock(folder);

      try {
        const existing = await this.findExistingUidsInLockedFolder([emailId]);
        if (!existing.has(emailId)) {
          throw new Error(`Email ${emailId} not found in folder ${folder}`);
        }

        if (isRead) {
          await this.client.messageFlagsAdd(emailId, ['\\Seen'], { uid: true });
        } else {
          await this.client.messageFlagsRemove(emailId, ['\\Seen'], { uid: true });
        }

        // Update cache
        const cachedForRead = this.getCacheEntry(emailId, folder);
        if (cachedForRead) {
          cachedForRead.isRead = isRead;
        }

        logger.info(`Email ${emailId} marked as ${isRead ? 'read' : 'unread'}`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to mark email read', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.markEmailRead')
  }

  /**
   * Set the \Flagged (starred) flag on an email.
   * @param emailId Numeric UID string of the email to update
   * @param isStarred true to star, false to unstar (default: true)
   * @param sourceFolder Folder containing the UID. See markEmailRead for why
   *   passing this avoids cross-folder UID collisions.
   * @returns true on success, false if not connected. Throws if the UID does
   *   not exist in the resolved folder.
   */
  async starEmail(emailId: string, isStarred: boolean = true, sourceFolder?: string): Promise<boolean> {
    this.validateEmailId(emailId);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    return tracer.span('imap.starEmail', { emailId, isStarred, sourceFolder }, async () => {
    logger.debug('Starring email', 'IMAPService', { emailId, isStarred, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      let folder: string;
      if (sourceFolder) {
        folder = sourceFolder;
      } else {
        const email = await this.getEmailById(emailId);
        if (!email) {
          throw new Error(`Email ${emailId} not found`);
        }
        folder = email.folder;
      }

      const lock = await this.client.getMailboxLock(folder);

      try {
        const existing = await this.findExistingUidsInLockedFolder([emailId]);
        if (!existing.has(emailId)) {
          throw new Error(`Email ${emailId} not found in folder ${folder}`);
        }

        if (isStarred) {
          await this.client.messageFlagsAdd(emailId, ['\\Flagged'], { uid: true });
        } else {
          await this.client.messageFlagsRemove(emailId, ['\\Flagged'], { uid: true });
        }

        const cachedForStar = this.getCacheEntry(emailId, folder);
        if (cachedForStar) {
          cachedForStar.isStarred = isStarred;
        }

        logger.info(`Email ${emailId} ${isStarred ? 'starred' : 'unstarred'}`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to star email', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.starEmail')
  }

  /**
   * Move an email to a different IMAP folder.
   * @param emailId Numeric UID string of the email to move
   * @param targetFolder Destination folder path (e.g. "Trash", "Folders/Work")
   * @param sourceFolder Folder currently holding the UID. Strongly recommended
   *   whenever the UID came from a folder other than INBOX — IMAP UIDs are
   *   folder-scoped, so without this the wrong folder may be selected.
   * @returns true on success, false if not connected. Throws if the UID does
   *   not exist in the resolved source folder.
   */
  async moveEmail(emailId: string, targetFolder: string, sourceFolder?: string): Promise<boolean> {
    this.validateEmailId(emailId);
    this.validateFolderName(targetFolder);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    return tracer.span('imap.moveEmail', { emailId, targetFolder, sourceFolder }, async () => {
    logger.debug('Moving email', 'IMAPService', { emailId, targetFolder, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      let folder: string;
      if (sourceFolder) {
        folder = sourceFolder;
      } else {
        const email = await this.getEmailById(emailId);
        if (!email) {
          throw new Error(`Email ${emailId} not found`);
        }
        folder = email.folder;
      }

      // Source == target → no-op. Moving within the same mailbox does nothing,
      // and from the All Mail union it "succeeds" silently while moving nothing.
      if (this.isSameLocation(folder, targetFolder)) {
        logger.info(`Email ${emailId} is already in ${targetFolder}; move is a no-op (same location)`, 'IMAPService');
        return true;
      }

      let movedMid: string | undefined;
      const relocated = new Set<string>();
      let uidplus = false;
      const lock = await this.client.getMailboxLock(folder);

      try {
        const existing = await this.findExistingUidsInLockedFolder([emailId]);
        if (!existing.has(emailId)) {
          throw new Error(`Email ${emailId} not found in folder ${folder}`);
        }

        // Capture the Message-ID BEFORE the move (it removes the UID) as a
        // no-UIDPLUS fallback identity.
        movedMid = (await this.fetchMessageIdsForUids([emailId])).get(emailId);

        uidplus = this.recordRelocatedUids(await this.client.messageMove(emailId, targetFolder, { uid: true }), relocated);

        // Evict old cache entry — after MOVE the UID in the target folder may differ
        this.evictCacheEntry(`${folder}:${emailId}`);
      } finally {
        lock.release();
      }

      // Honest counts: confirm the message is actually in the target. Primary
      // signal is the UIDPLUS COPYUID map; Message-ID search is the no-UIDPLUS
      // fallback. Bridge answering MOVE from the All Mail union with OK while
      // doing nothing must be an error, not a silent success.
      let landed = relocated.has(emailId);
      if (!landed && !uidplus && movedMid) {
        const found = await this.findMessageIdsInFolder(targetFolder, [movedMid]);
        landed = found.has(movedMid);
      }
      if (!landed) {
        throw new Error(`Move of email ${emailId} from ${folder} to ${targetFolder} was accepted but could not be verified present in the target — likely a no-op from a union mailbox (e.g. All Mail). Pass the message's real source folder.`);
      }

      logger.info(`Email ${emailId} moved from ${folder} to ${targetFolder}`, 'IMAPService');
      return true;
    } catch (error) {
      logger.error('Failed to move email', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.moveEmail')
  }

  /**
   * Copy an email to a target folder using IMAP COPY (message stays in original folder).
   * Use this for label operations in Proton Bridge's label model.
   * @param emailId Numeric UID string of the email to copy
   * @param targetFolder Destination folder path (e.g. "Labels/Work")
   * @param sourceFolder Folder currently holding the UID. Strongly recommended
   *   whenever the UID came from a folder other than INBOX.
   * @returns true on success, false if not connected. Throws if the UID does
   *   not exist in the resolved source folder.
   */
  async copyEmailToFolder(emailId: string, targetFolder: string, sourceFolder?: string): Promise<boolean> {
    this.validateEmailId(emailId);
    this.validateFolderName(targetFolder);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    return tracer.span('imap.copyEmailToFolder', { emailId, targetFolder, sourceFolder }, async () => {
    logger.debug('Copying email to folder', 'IMAPService', { emailId, targetFolder, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      let folder: string;
      if (sourceFolder) {
        folder = sourceFolder;
      } else {
        const email = await this.getEmailById(emailId);
        if (!email) {
          throw new Error(`Email ${emailId} not found`);
        }
        folder = email.folder;
      }

      let copiedMid: string | undefined;
      const relocated = new Set<string>();
      let uidplus = false;
      const lock = await this.client.getMailboxLock(folder);

      try {
        const existing = await this.findExistingUidsInLockedFolder([emailId]);
        if (!existing.has(emailId)) {
          throw new Error(`Email ${emailId} not found in folder ${folder}`);
        }

        copiedMid = (await this.fetchMessageIdsForUids([emailId])).get(emailId);
        uidplus = this.recordRelocatedUids(await this.client.messageCopy(emailId, targetFolder, { uid: true }), relocated);
      } finally {
        lock.release();
      }

      // Honest counts: confirm the copy actually landed in the target (e.g. the
      // label mailbox). Primary signal is the UIDPLUS COPYUID map; Message-ID
      // search is the no-UIDPLUS fallback. Bridge answering COPY from the All
      // Mail union with OK while doing nothing must be an error, not a success.
      let landed = relocated.has(emailId);
      if (!landed && !uidplus && copiedMid) {
        const found = await this.findMessageIdsInFolder(targetFolder, [copiedMid]);
        landed = found.has(copiedMid);
      }
      if (!landed) {
        throw new Error(`Copy of email ${emailId} to ${targetFolder} was accepted but could not be verified present there — likely a no-op from a union mailbox (e.g. All Mail), or the target does not exist. Pass the message's real source folder.`);
      }
      logger.info(`Email ${emailId} copied from ${folder} to ${targetFolder}`, 'IMAPService');
      return true;
    } catch (error) {
      logger.error('Failed to copy email to folder', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.copyEmailToFolder')
  }

  /**
   * Delete an email from a specific folder (used for label removal).
   * Opens a lock on the given folder and deletes the message there.
   * @param emailId Numeric UID string
   * @param folder The folder from which to delete (e.g. "Labels/Work")
   * @returns true on success, false if not connected
   */
  async deleteFromFolder(emailId: string, folder: string): Promise<boolean> {
    this.validateEmailId(emailId);
    this.validateFolderName(folder);
    return tracer.span('imap.deleteFromFolder', { emailId, folder }, async () => {
    logger.debug('Deleting email from folder', 'IMAPService', { emailId, folder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      const lock = await this.client.getMailboxLock(folder);

      try {
        const existing = await this.findExistingUidsInLockedFolder([emailId]);
        if (!existing.has(emailId)) {
          throw new Error(`Email ${emailId} not found in folder ${folder}`);
        }

        await this.client.messageDelete(emailId, { uid: true });
        // Remove from cache using folder-qualified key
        this.evictCacheEntry(`${folder}:${emailId}`);
        logger.info(`Email ${emailId} deleted from ${folder}`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to delete email from folder', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.deleteFromFolder')
  }

  /**
   * Set or clear an IMAP flag on an email.
   * @param emailId Numeric UID string of the email
   * @param flag The IMAP flag to set/clear (e.g. '\\Answered', '$Forwarded')
   * @param set true to add the flag, false to remove it (default: true)
   * @param sourceFolder Folder containing the UID. Strongly recommended
   *   whenever the UID came from a folder other than INBOX — IMAP UIDs are
   *   folder-scoped, and without this the all-folders scan can pick a
   *   colliding UID in the wrong mailbox (IMAP-009 from the 2026-05-28 audit).
   * @returns true on success. Throws if the UID does not exist in the
   *   resolved source folder (IMAP-008 from the 2026-05-28 audit).
   */
  async setFlag(emailId: string, flag: string, set: boolean = true, sourceFolder?: string): Promise<boolean> {
    this.validateEmailId(emailId);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    return tracer.span('imap.setFlag', { emailId, flag, set, sourceFolder }, async () => {
    logger.debug('Setting flag on email', 'IMAPService', { emailId, flag, set, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      let folder: string | undefined;
      if (sourceFolder) {
        folder = sourceFolder;
      } else {
        const cached = this.findCacheEntryByUid(emailId);
        if (cached) {
          folder = cached.folder;
        } else {
          const folders = await this.getFolders();
          for (const f of folders) {
            const lock = await this.client.getMailboxLock(f.path);
            try {
              let found = false;
              for await (const msg of this.client.fetch(emailId, { uid: true }, { uid: true })) {
                if (msg.uid.toString() === emailId) { found = true; break; }
              }
              if (found) { folder = f.path; break; }
            } catch (scanErr: unknown) {
              // We can't reliably distinguish "UID not present in this folder"
              // from a transport error here — imapflow surfaces both as throws
              // depending on the server. Log at warn level so silent transport
              // failures aren't invisible, then continue to the next folder.
              // Callers that need certainty should pass `sourceFolder` and
              // bypass this scan entirely.
              logger.warn(
                `setFlag folder-scan: fetch on ${f.path} for UID ${emailId} threw — ` +
                `treating as "not in this folder": ${scanErr instanceof Error ? scanErr.message : String(scanErr)}`,
                'IMAPService'
              );
            } finally {
              lock.release();
            }
          }
        }
      }

      if (!folder) {
        throw new Error(`Email ${emailId} not found in any folder`);
      }

      const lock = await this.client.getMailboxLock(folder);
      try {
        const existing = await this.findExistingUidsInLockedFolder([emailId]);
        if (!existing.has(emailId)) {
          throw new Error(`Email ${emailId} not found in folder ${folder}`);
        }
        if (set) {
          await this.client.messageFlagsAdd(emailId, [flag], { uid: true });
        } else {
          await this.client.messageFlagsRemove(emailId, [flag], { uid: true });
        }
        logger.info(`Flag ${flag} ${set ? 'set' : 'cleared'} on email ${emailId} in ${folder}`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to set flag on email', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.setFlag')
  }

  /**
   * Move many emails to `targetFolder` in one IMAP UID MOVE per source folder.
   *
   * @param sourceFolder When provided, all `emailIds` are assumed to live in
   *   this folder; cache lookup is skipped. Strongly recommended whenever the
   *   UIDs came from anything other than INBOX — IMAP UIDs are folder-scoped
   *   and silent no-ops are otherwise possible.
   *
   * Before each batch IMAP MOVE the method does a UID FETCH inside the lock to
   * determine which UIDs actually exist in the folder. UIDs that don't exist
   * are reported in `results.failed` rather than silently counted as success.
   */
  async bulkMoveEmails(emailIds: string[], targetFolder: string, sourceFolder?: string): Promise<{ success: number; failed: number; errors: string[] }> {
    this.validateFolderName(targetFolder);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    const tags: SpanTags = { count: emailIds.length, targetFolder, sourceFolder };
    return tracer.span('imap.bulkMoveEmails', tags, async () => {
    logger.debug('Bulk moving emails', 'IMAPService', { count: emailIds.length, targetFolder, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      throw new Error('IMAP client not connected');
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[]
    };

    const emailsByFolder = new Map<string, string[]>();

    if (sourceFolder) {
      const validIds: string[] = [];
      for (const emailId of emailIds) {
        try {
          this.validateEmailId(emailId);
          validIds.push(emailId);
        } catch (error: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (validIds.length > 0) emailsByFolder.set(sourceFolder, validIds);
    } else {
      for (const emailId of emailIds) {
        try {
          this.validateEmailId(emailId);
          const cachedEmail = this.findCacheEntryByUid(emailId);
          let folder: string;
          if (cachedEmail) {
            folder = cachedEmail.folder;
          } else {
            const discovered = await this.getEmailById(emailId);
            if (!discovered) {
              results.failed++;
              results.errors.push(`Email ${emailId} not found in any folder`);
              continue;
            }
            folder = discovered.folder;
          }
          if (!emailsByFolder.has(folder)) emailsByFolder.set(folder, []);
          emailsByFolder.get(folder)!.push(emailId);
        } catch (error: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    // Capture Message-IDs + which UIDs the MOVE verb accepted per source folder,
    // then verify (below) the messages actually landed in the target. A move the
    // server "accepts" from the All Mail union but doesn't perform would
    // otherwise count as a false success.
    const verifyJobs: Array<{ folder: string; accepted: string[]; midMap: Map<string, string>; relocated: Set<string>; uidplus: boolean }> = [];
    for (const [folder, ids] of emailsByFolder.entries()) {
      // Source == target → no-op (incl. the All Mail union, which "accepts" the
      // move silently while moving nothing). Count as success, don't issue it.
      if (this.isSameLocation(folder, targetFolder)) {
        for (let i = 0; i < ids.length; i++) results.success++;
        continue;
      }
      const lock = await this.client.getMailboxLock(folder);
      try {
        let existing: Set<string>;
        try {
          existing = await this.findExistingUidsInLockedFolder(ids);
        } catch (e: unknown) {
          // IMAP-006: transport error during pre-flight. Surface the real
          // failure mode rather than collapsing into "UIDs not found" — the
          // caller needs to distinguish "definitely absent" from "couldn't
          // verify" so a retry is meaningful.
          const msg = e instanceof Error ? e.message : String(e);
          for (const id of ids) {
            results.failed++;
            results.errors.push(`UID ${id} existence check failed in folder ${folder}: ${msg}`);
          }
          continue;
        }
        const present: string[] = [];
        for (const id of ids) {
          if (existing.has(id)) {
            present.push(id);
          } else {
            results.failed++;
            results.errors.push(`UID ${id} not found in folder ${folder}`);
          }
        }
        if (present.length === 0) continue;

        // Capture Message-IDs BEFORE the move (it removes them from the source).
        const midMap = await this.fetchMessageIdsForUids(present);
        const accepted: string[] = [];
        const relocated = new Set<string>(); // source uids the server (UIDPLUS) confirmed moved
        let uidplus = false;
        await this.chunkedBatchOp(
          present,
          async (uidSet) => { uidplus = this.recordRelocatedUids(await this.client!.messageMove(uidSet, targetFolder, { uid: true }), relocated) || uidplus; },
          async (id) => { uidplus = this.recordRelocatedUids(await this.client!.messageMove(id, targetFolder, { uid: true }), relocated) || uidplus; },
          (id) => { this.evictCacheEntry(`${folder}:${id}`); accepted.push(id); },
          (id, msg) => { results.failed++; results.errors.push(`Failed to move email ${id}: ${msg}`); },
          'Bulk move',
          folder,
        );
        verifyJobs.push({ folder, accepted, midMap, relocated, uidplus });
      } finally {
        lock.release();
      }
    }

    // Verify each move actually landed in the target. Primary signal: the
    // server's UIDPLUS COPYUID map; Message-ID search only as a no-UIDPLUS
    // fallback. Unverifiable → failure, never an assumed success.
    for (const job of verifyJobs) {
      if (job.accepted.length === 0) continue;
      let found = new Set<string>();
      if (!job.uidplus) {
        const mids = job.accepted.filter(u => !job.relocated.has(u)).map(u => job.midMap.get(u)).filter((m): m is string => !!m);
        if (mids.length > 0) {
          try { found = await this.findMessageIdsInFolder(targetFolder, mids); } catch { /* unverifiable → failure below */ }
        }
      }
      for (const uid of job.accepted) {
        const mid = job.midMap.get(uid);
        if (job.relocated.has(uid) || (!job.uidplus && mid && found.has(mid))) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push(`Move of UID ${uid} from ${job.folder} to ${targetFolder} was accepted but could not be verified present in the target — likely a no-op from a union mailbox (e.g. All Mail). Pass the message's real source folder.`);
        }
      }
    }

    tags.successCount = results.success;
    tags.failCount = results.failed;
    logger.info(`Bulk move completed: ${results.success} succeeded, ${results.failed} failed`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkMoveEmails')
  }

  /**
   * Resolve the Trash mailbox path. Prefers the server-reported specialUse
   * `\\Trash` (so localised names like `Papelera` resolve correctly), falls
   * back to a folder literally named "Trash", then the bare path "Trash".
   */
  private async resolveTrashPath(): Promise<string> {
    try {
      const folders = await this.getFolders();
      const byUse = folders.find(f => f.specialUse === '\\Trash');
      if (byUse) return byUse.path;
      const byName = folders.find(f => f.path.toLowerCase() === 'trash');
      if (byName) return byName.path;
    } catch {
      logger.warn('Could not resolve Trash from the folder list; defaulting to "Trash"', 'IMAPService');
    }
    return 'Trash';
  }

  /** True if `folder` is the Trash mailbox — a delete there is a no-op, because
   *  we never permanently delete (EXPUNGE) mail. */
  private isTrashFolder(folder: string, trashPath: string): boolean {
    return folder === trashPath || folder.toLowerCase() === 'trash';
  }

  /** True if two folder paths refer to the same mailbox. Moving from/to the
   *  identical location is a no-op — and critically, the "All Mail" union
   *  (which holds every message from every folder) "accepts" such a move
   *  silently while doing nothing, so we must short-circuit it rather than
   *  issue the move. */
  private isSameLocation(a: string, b: string): boolean {
    return a.trim() === b.trim();
  }

  /** True if a folder is the "All Mail" union (specialUse \All, or the literal
   *  path). All Mail holds EVERY message, so it must be searched LAST when
   *  resolving a message's folder — otherwise it masks the real location. */
  private isAllMailFolder(f: { path?: string; specialUse?: string | null }): boolean {
    return f.specialUse === "\\All" || (f.path ?? "").trim() === "All Mail";
  }

  /**
   * Delete an email — implemented as a MOVE TO TRASH, never an EXPUNGE. Mail is
   * always recoverable from Trash (and Proton purges Trash on its own schedule);
   * mailpouch never directly/permanently deletes a message. An email already in
   * Trash is left in place (the delete is a no-op success).
   */
  async deleteEmail(emailId: string, sourceFolder?: string): Promise<boolean> {
    this.validateEmailId(emailId);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    return tracer.span('imap.deleteEmail', { emailId, sourceFolder }, async () => {
    logger.debug('Deleting email (move to Trash)', 'IMAPService', { emailId, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    const trash = await this.resolveTrashPath();

    let folder: string;
    if (sourceFolder) {
      folder = sourceFolder;
    } else {
      const email = await this.getEmailById(emailId);
      if (!email) {
        throw new Error(`Email ${emailId} not found`);
      }
      folder = email.folder;
    }

    if (this.isTrashFolder(folder, trash)) {
      logger.info(`Email ${emailId} is already in Trash (${folder}); delete is a no-op — mail is never permanently deleted`, 'IMAPService');
      return true;
    }

    // MOVE to Trash (verified-landing via moveEmail) instead of EXPUNGE.
    return this.moveEmail(emailId, trash, folder);
    }); // end tracer.span('imap.deleteEmail')
  }

  /**
   * Delete many emails — implemented as a MOVE TO TRASH per source folder, never
   * an EXPUNGE. Mail is always recoverable from Trash; mailpouch never directly/
   * permanently deletes. Messages already in Trash are counted as success no-ops.
   *
   * @param sourceFolder When provided, all UIDs are assumed to live in this
   *   folder; cache lookup is skipped. Strongly recommended whenever the UIDs
   *   came from anything other than INBOX. Move-to-Trash is verified-landing
   *   (via bulkMoveEmails) so a union-mailbox no-op is reported as failure.
   */
  async bulkDeleteEmails(emailIds: string[], sourceFolder?: string): Promise<{ success: number; failed: number; errors: string[] }> {
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    const tags: SpanTags = { count: emailIds.length, sourceFolder };
    return tracer.span('imap.bulkDeleteEmails', tags, async () => {
    logger.debug('Bulk deleting emails', 'IMAPService', { count: emailIds.length, sourceFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      throw new Error('IMAP client not connected');
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[]
    };

    const emailsByFolder2 = new Map<string, string[]>();

    if (sourceFolder) {
      const validIds: string[] = [];
      for (const emailId of emailIds) {
        try {
          this.validateEmailId(emailId);
          validIds.push(emailId);
        } catch (error: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if (validIds.length > 0) emailsByFolder2.set(sourceFolder, validIds);
    } else {
      for (const emailId of emailIds) {
        try {
          this.validateEmailId(emailId);
          const cachedEmail = this.findCacheEntryByUid(emailId);
          let folder: string;
          if (cachedEmail) {
            folder = cachedEmail.folder;
          } else {
            const discovered = await this.getEmailById(emailId);
            if (!discovered) {
              results.failed++;
              results.errors.push(`Email ${emailId} not found in any folder`);
              continue;
            }
            folder = discovered.folder;
          }
          if (!emailsByFolder2.has(folder)) emailsByFolder2.set(folder, []);
          emailsByFolder2.get(folder)!.push(emailId);
        } catch (error: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }

    const trash = await this.resolveTrashPath();

    for (const [folder, ids] of emailsByFolder2.entries()) {
      // Already in Trash → deletion is a no-op; we never permanently delete.
      if (this.isTrashFolder(folder, trash)) {
        for (let i = 0; i < ids.length; i++) results.success++;
        continue;
      }
      // Delete = move to Trash, with verified landing (so a union-mailbox no-op
      // is an honest failure, not a silent success). Per-folder so each group's
      // UIDs resolve correctly.
      const moved = await this.bulkMoveEmails(ids, trash, folder);
      results.success += moved.success;
      results.failed += moved.failed;
      results.errors.push(...moved.errors);
    }

    tags.successCount = results.success;
    tags.failCount = results.failed;
    logger.info(`Bulk delete completed: ${results.success} succeeded, ${results.failed} failed`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkDeleteEmails')
  }

  /**
   * Bulk-toggle the \Seen flag on many emails using a single IMAP UID STORE
   * per folder. Mirrors the bulkDeleteEmails / bulkMoveEmails pattern:
   * group by cached folder, lock once, batch flag-set, fall back to per-UID
   * on a batch error.
   */
  async bulkMarkRead(emailIds: string[], isRead: boolean = true, sourceFolder?: string): Promise<{ success: number; failed: number; errors: string[] }> {
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    const tags: SpanTags = { count: emailIds.length, isRead, sourceFolder };
    return tracer.span('imap.bulkMarkRead', tags, async () => {
    logger.debug('Bulk marking read status', 'IMAPService', { count: emailIds.length, isRead, sourceFolder });
    if (!this.client || !this.isConnected) throw new Error('IMAP client not connected');

    const results = { success: 0, failed: 0, errors: [] as string[] };
    const grouped = new Map<string, string[]>();
    if (sourceFolder) {
      const validIds: string[] = [];
      for (const id of emailIds) {
        try {
          this.validateEmailId(id);
          validIds.push(id);
        } catch (e: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (validIds.length > 0) grouped.set(sourceFolder, validIds);
    } else {
      // No explicit sourceFolder — discover per UID. IMAP-003 from the
      // 2026-05-28 audit: this used to fall back to 'INBOX' on cache miss,
      // recreating the v3.0.41 false-success class. Now mirrors the
      // bulkMoveEmails pattern: cache lookup, then full discovery via
      // getEmailById, then explicit failure if still not found.
      for (const id of emailIds) {
        try {
          this.validateEmailId(id);
          const cached = this.findCacheEntryByUid(id);
          let folder: string;
          if (cached) {
            folder = cached.folder;
          } else {
            const discovered = await this.getEmailById(id);
            if (!discovered) {
              results.failed++;
              results.errors.push(`Email ${id} not found in any folder`);
              continue;
            }
            folder = discovered.folder;
          }
          if (!grouped.has(folder)) grouped.set(folder, []);
          grouped.get(folder)!.push(id);
        } catch (e: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    for (const [folder, ids] of grouped.entries()) {
      const lock = await this.client.getMailboxLock(folder);
      try {
        let existing: Set<string>;
        try {
          existing = await this.findExistingUidsInLockedFolder(ids);
        } catch (e: unknown) {
          // IMAP-006: transport error during pre-flight. Surface the real
          // failure mode rather than collapsing into "UIDs not found" — the
          // caller needs to distinguish "definitely absent" from "couldn't
          // verify" so a retry is meaningful.
          const msg = e instanceof Error ? e.message : String(e);
          for (const id of ids) {
            results.failed++;
            results.errors.push(`UID ${id} existence check failed in folder ${folder}: ${msg}`);
          }
          continue;
        }
        const present: string[] = [];
        for (const id of ids) {
          if (existing.has(id)) {
            present.push(id);
          } else {
            results.failed++;
            results.errors.push(`UID ${id} not found in folder ${folder}`);
          }
        }
        if (present.length === 0) continue;

        await this.chunkedBatchOp(
          present,
          (uidSet) => isRead
            ? this.client!.messageFlagsAdd(uidSet, ['\\Seen'], { uid: true })
            : this.client!.messageFlagsRemove(uidSet, ['\\Seen'], { uid: true }),
          (id) => isRead
            ? this.client!.messageFlagsAdd(id, ['\\Seen'], { uid: true })
            : this.client!.messageFlagsRemove(id, ['\\Seen'], { uid: true }),
          (id) => {
            const c = this.getCacheEntry(id, folder); if (c) c.isRead = isRead;
            results.success++;
          },
          (id, msg) => { results.failed++; results.errors.push(`Failed to mark ${id}: ${msg}`); },
          'Bulk mark-read',
          folder,
        );
      } finally { lock.release(); }
    }
    tags.successCount = results.success; tags.failCount = results.failed;
    logger.info(`Bulk mark-read completed: ${results.success}/${results.failed}`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkMarkRead')
  }

  /** Bulk-toggle the \Flagged (starred) flag on many emails. Same shape as bulkMarkRead. */
  async bulkStar(emailIds: string[], isStarred: boolean = true, sourceFolder?: string): Promise<{ success: number; failed: number; errors: string[] }> {
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    const tags: SpanTags = { count: emailIds.length, isStarred, sourceFolder };
    return tracer.span('imap.bulkStar', tags, async () => {
    logger.debug('Bulk starring', 'IMAPService', { count: emailIds.length, isStarred, sourceFolder });
    if (!this.client || !this.isConnected) throw new Error('IMAP client not connected');

    const results = { success: 0, failed: 0, errors: [] as string[] };
    const grouped = new Map<string, string[]>();
    if (sourceFolder) {
      const validIds: string[] = [];
      for (const id of emailIds) {
        try {
          this.validateEmailId(id);
          validIds.push(id);
        } catch (e: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (validIds.length > 0) grouped.set(sourceFolder, validIds);
    } else {
      // No sourceFolder — discover per UID (IMAP-003 from 2026-05-28 audit).
      for (const id of emailIds) {
        try {
          this.validateEmailId(id);
          const cached = this.findCacheEntryByUid(id);
          let folder: string;
          if (cached) {
            folder = cached.folder;
          } else {
            const discovered = await this.getEmailById(id);
            if (!discovered) {
              results.failed++;
              results.errors.push(`Email ${id} not found in any folder`);
              continue;
            }
            folder = discovered.folder;
          }
          if (!grouped.has(folder)) grouped.set(folder, []);
          grouped.get(folder)!.push(id);
        } catch (e: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    for (const [folder, ids] of grouped.entries()) {
      const lock = await this.client.getMailboxLock(folder);
      try {
        let existing: Set<string>;
        try {
          existing = await this.findExistingUidsInLockedFolder(ids);
        } catch (e: unknown) {
          // IMAP-006: transport error during pre-flight. Surface the real
          // failure mode rather than collapsing into "UIDs not found" — the
          // caller needs to distinguish "definitely absent" from "couldn't
          // verify" so a retry is meaningful.
          const msg = e instanceof Error ? e.message : String(e);
          for (const id of ids) {
            results.failed++;
            results.errors.push(`UID ${id} existence check failed in folder ${folder}: ${msg}`);
          }
          continue;
        }
        const present: string[] = [];
        for (const id of ids) {
          if (existing.has(id)) {
            present.push(id);
          } else {
            results.failed++;
            results.errors.push(`UID ${id} not found in folder ${folder}`);
          }
        }
        if (present.length === 0) continue;

        await this.chunkedBatchOp(
          present,
          (uidSet) => isStarred
            ? this.client!.messageFlagsAdd(uidSet, ['\\Flagged'], { uid: true })
            : this.client!.messageFlagsRemove(uidSet, ['\\Flagged'], { uid: true }),
          (id) => isStarred
            ? this.client!.messageFlagsAdd(id, ['\\Flagged'], { uid: true })
            : this.client!.messageFlagsRemove(id, ['\\Flagged'], { uid: true }),
          (id) => {
            const c = this.getCacheEntry(id, folder); if (c) c.isStarred = isStarred;
            results.success++;
          },
          (id, msg) => { results.failed++; results.errors.push(`Failed to star ${id}: ${msg}`); },
          'Bulk star',
          folder,
        );
      } finally { lock.release(); }
    }
    tags.successCount = results.success; tags.failCount = results.failed;
    logger.info(`Bulk star completed: ${results.success}/${results.failed}`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkStar')
  }

  /** Copy many emails into `targetFolder` in a single IMAP UID COPY per source folder.
   *  Used by bulk_move_to_label (the target is the Labels/<name> pseudo-folder). */
  async bulkCopyToFolder(emailIds: string[], targetFolder: string, sourceFolder?: string): Promise<{ success: number; failed: number; errors: string[] }> {
    this.validateFolderName(targetFolder);
    if (sourceFolder !== undefined) this.validateFolderName(sourceFolder);
    const tags: SpanTags = { count: emailIds.length, targetFolder, sourceFolder };
    return tracer.span('imap.bulkCopyToFolder', tags, async () => {
    logger.debug('Bulk copy to folder', 'IMAPService', { count: emailIds.length, targetFolder, sourceFolder });
    if (!this.client || !this.isConnected) throw new Error('IMAP client not connected');

    const results = { success: 0, failed: 0, errors: [] as string[] };
    const grouped = new Map<string, string[]>();
    if (sourceFolder) {
      const validIds: string[] = [];
      for (const id of emailIds) {
        try {
          this.validateEmailId(id);
          validIds.push(id);
        } catch (e: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      if (validIds.length > 0) grouped.set(sourceFolder, validIds);
    } else {
      // No sourceFolder — discover per UID (IMAP-003 from 2026-05-28 audit).
      for (const id of emailIds) {
        try {
          this.validateEmailId(id);
          const cached = this.findCacheEntryByUid(id);
          let folder: string;
          if (cached) {
            folder = cached.folder;
          } else {
            const discovered = await this.getEmailById(id);
            if (!discovered) {
              results.failed++;
              results.errors.push(`Email ${id} not found in any folder`);
              continue;
            }
            folder = discovered.folder;
          }
          if (!grouped.has(folder)) grouped.set(folder, []);
          grouped.get(folder)!.push(id);
        } catch (e: unknown) {
          results.failed++;
          results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }

    // Per source folder: pre-flight, capture Message-IDs, issue the copy. We do
    // NOT count success here — only which UIDs the COPY verb accepted. Whether
    // the message actually landed in the target is verified afterward (below),
    // because Bridge can answer COPY from the All Mail union with OK while doing
    // nothing. Verification needs to lock the target, so it can't run while the
    // source lock is held — collect jobs and verify after the loop.
    const verifyJobs: Array<{ accepted: string[]; midMap: Map<string, string>; relocated: Set<string>; uidplus: boolean }> = [];
    for (const [folder, ids] of grouped.entries()) {
      const lock = await this.client.getMailboxLock(folder);
      try {
        let existing: Set<string>;
        try {
          existing = await this.findExistingUidsInLockedFolder(ids);
        } catch (e: unknown) {
          // IMAP-006: transport error during pre-flight. Surface the real
          // failure mode rather than collapsing into "UIDs not found" — the
          // caller needs to distinguish "definitely absent" from "couldn't
          // verify" so a retry is meaningful.
          const msg = e instanceof Error ? e.message : String(e);
          for (const id of ids) {
            results.failed++;
            results.errors.push(`UID ${id} existence check failed in folder ${folder}: ${msg}`);
          }
          continue;
        }
        const present: string[] = [];
        for (const id of ids) {
          if (existing.has(id)) {
            present.push(id);
          } else {
            results.failed++;
            results.errors.push(`UID ${id} not found in folder ${folder}`);
          }
        }
        if (present.length === 0) continue;

        const midMap = await this.fetchMessageIdsForUids(present);
        const accepted: string[] = [];
        const relocated = new Set<string>(); // source uids the server (UIDPLUS) confirmed copied
        let uidplus = false;
        await this.chunkedBatchOp(
          present,
          async (uidSet) => { uidplus = this.recordRelocatedUids(await this.client!.messageCopy(uidSet, targetFolder, { uid: true }), relocated) || uidplus; },
          async (id) => { uidplus = this.recordRelocatedUids(await this.client!.messageCopy(id, targetFolder, { uid: true }), relocated) || uidplus; },
          (id) => { accepted.push(id); },
          (id, msg) => { results.failed++; results.errors.push(`Failed to copy ${id} to ${targetFolder}: ${msg}`); },
          `Bulk copy →${targetFolder}`,
          folder,
        );
        verifyJobs.push({ accepted, midMap, relocated, uidplus });
      } finally { lock.release(); }
    }

    // Verify each copy actually landed in the target. Primary signal: the
    // server's UIDPLUS COPYUID map (per-message, no Message-ID needed). Only
    // when the server returned no UIDPLUS data do we fall back to a Message-ID
    // search. A copy the server "accepted" but didn't perform (the silent
    // All-Mail no-op) is an honest failure, never a false success — and a
    // message we simply cannot verify is also a failure, not an assumed success.
    for (const job of verifyJobs) {
      if (job.accepted.length === 0) continue;
      let found = new Set<string>();
      if (!job.uidplus) {
        const mids = job.accepted.filter(u => !job.relocated.has(u)).map(u => job.midMap.get(u)).filter((m): m is string => !!m);
        if (mids.length > 0) {
          try { found = await this.findMessageIdsInFolder(targetFolder, mids); } catch { /* unverifiable → failure below */ }
        }
      }
      for (const uid of job.accepted) {
        const mid = job.midMap.get(uid);
        if (job.relocated.has(uid) || (!job.uidplus && mid && found.has(mid))) {
          results.success++;
        } else {
          results.failed++;
          results.errors.push(`Copy of UID ${uid} to ${targetFolder} was accepted but could not be verified present there — likely a no-op from a union mailbox (e.g. All Mail). Pass the message's real source folder, or verify the target label exists.`);
        }
      }
    }
    tags.successCount = results.success; tags.failCount = results.failed;
    logger.info(`Bulk copy completed: ${results.success}/${results.failed}`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkCopyToFolder')
  }

  /** Delete many emails from a SPECIFIC folder (label removal). Unlike
   *  bulkDeleteEmails this targets a single folder rather than the
   *  cached/INBOX-fallback folder per UID. UIDs are folder-scoped, so the
   *  caller must pass UIDs known to live in `folder`. */
  async bulkDeleteFromFolder(emailIds: string[], folder: string): Promise<{ success: number; failed: number; errors: string[] }> {
    this.validateFolderName(folder);
    const tags: SpanTags = { count: emailIds.length, folder };
    return tracer.span('imap.bulkDeleteFromFolder', tags, async () => {
    logger.debug('Bulk delete from folder', 'IMAPService', { count: emailIds.length, folder });
    if (!this.client || !this.isConnected) throw new Error('IMAP client not connected');

    const results = { success: 0, failed: 0, errors: [] as string[] };
    const validIds: string[] = [];
    for (const id of emailIds) {
      try {
        this.validateEmailId(id);
        validIds.push(id);
      } catch (e: unknown) {
        results.failed++;
        results.errors.push(`Invalid email ID ${id}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    if (validIds.length === 0) return results;

    const lock = await this.client.getMailboxLock(folder);
    try {
      let existing: Set<string>;
      try {
        existing = await this.findExistingUidsInLockedFolder(validIds);
      } catch (e: unknown) {
        // IMAP-006: transport error during pre-flight. Don't lie that the
        // UIDs are absent — bubble up so the caller knows the check failed.
        const msg = e instanceof Error ? e.message : String(e);
        for (const id of validIds) {
          results.failed++;
          results.errors.push(`UID ${id} existence check failed in folder ${folder}: ${msg}`);
        }
        tags.successCount = results.success; tags.failCount = results.failed;
        return results;
      }
      const present: string[] = [];
      for (const id of validIds) {
        if (existing.has(id)) {
          present.push(id);
        } else {
          results.failed++;
          results.errors.push(`UID ${id} not found in folder ${folder}`);
        }
      }
      if (present.length > 0) {
        // IMAP-016: see bulkDeleteEmails — flag \Deleted per UID then one EXPUNGE.
        const flaggedForExpunge: string[] = [];
        await this.chunkedBatchOp(
          present,
          (uidSet) => this.client!.messageDelete(uidSet, { uid: true }),
          async (id) => { await this.client!.messageFlagsAdd(id, ['\\Deleted'], { uid: true }); flaggedForExpunge.push(id); },
          (id) => { this.evictCacheEntry(`${folder}:${id}`); results.success++; },
          (id, msg) => { results.failed++; results.errors.push(`Failed to delete ${id} from ${folder}: ${msg}`); },
          'Bulk delete-from-folder',
          folder,
          // Chunk the trailing EXPUNGE (Copilot review on #154) — see
          // bulkDeleteEmails. Bounds the command line; O(N/chunk) round-trips.
          async () => {
            for (const uidSet of chunkUidsForWire(flaggedForExpunge)) {
              await this.client!.messageDelete(uidSet, { uid: true });
            }
          },
        );
      }
    } finally { lock.release(); }

    tags.successCount = results.success; tags.failCount = results.failed;
    logger.info(`Bulk delete-from-folder completed: ${results.success}/${results.failed}`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkDeleteFromFolder')
  }

  /**
   * Create a mailbox if it does not already exist; no-op when it is present.
   * Used by the label tools so "move/copy to label X" actually creates label X
   * when missing (the COPY would otherwise target a nonexistent Labels/<name>,
   * which Bridge may silently no-op).
   */
  async ensureFolderExists(folderName: string): Promise<void> {
    this.validateFolderName(folderName);
    if (!this.isConnected || !this.client) throw new Error('IMAP client not connected');
    try {
      await this.client.mailboxCreate(folderName);
      this.clearFolderCache();
      logger.info(`Folder created: ${folderName}`, 'IMAPService');
    } catch (error: unknown) {
      const rt = (error as { responseText?: string }).responseText || '';
      if (/ALREADYEXISTS/i.test(rt) || /already exists/i.test(rt)) return;
      throw error;
    }
  }

  /** Create a new folder (throws if it already exists). */
  async createFolder(folderName: string): Promise<boolean> {
    this.validateFolderName(folderName);
    return tracer.span('imap.createFolder', { folderName }, async () => {
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    try {
      logger.debug(`Creating folder: ${folderName}`, 'IMAPService');

      // Create the mailbox
      const result = await this.client.mailboxCreate(folderName);

      // Clear folder cache to refresh (also resets TTL so next getFolders() re-fetches)
      this.clearFolderCache();

      logger.info(`Folder created: ${folderName}`, 'IMAPService');
      return true;
    } catch (error: unknown) {
      const rt = (error as { responseText?: string }).responseText;
      if (rt?.includes('ALREADYEXISTS')) {
        logger.warn(`Folder already exists: ${folderName}`, 'IMAPService');
        throw new Error(`Folder '${folderName}' already exists`);
      }
      logger.error('Failed to create folder', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.createFolder')
  }

  /** Special-use attributes that mark a mailbox as undeletable / unrenamable. */
  private static readonly PROTECTED_SPECIAL_USE = new Set([
    '\\Inbox', '\\Sent', '\\Drafts', '\\Trash', '\\Junk', '\\Archive', '\\All', '\\Flagged',
  ]);
  private static readonly PROTECTED_NAMES = new Set([
    'inbox', 'sent', 'drafts', 'trash', 'spam', 'junk', 'archive', 'all mail', 'starred',
  ]);

  /**
   * IMAP-014: decide whether a folder is a protected system mailbox before a
   * destructive op. Trims + casefolds the input (so `'INBOX  '` can't slip
   * through a literal compare) and, when folder discovery is available, also
   * matches on the server-reported `specialUse` attribute so localised paths
   * (e.g. `Papelera` for `\Trash`) are still protected.
   */
  private async isProtectedFolder(folderName: string): Promise<boolean> {
    const normalized = folderName.trim().toLowerCase();
    if (SimpleIMAPService.PROTECTED_NAMES.has(normalized)) return true;
    try {
      const folders = await this.getFolders();
      const match = folders.find(f => f.path.trim().toLowerCase() === normalized);
      if (match?.specialUse && SimpleIMAPService.PROTECTED_SPECIAL_USE.has(match.specialUse)) {
        return true;
      }
    } catch (error) {
      // Discovery failed — fall back to the name check already performed above.
      logger.warn('Folder discovery failed during protected-folder check', 'IMAPService', error);
    }
    return false;
  }

  /**
   * Delete a folder (must be empty)
   */
  async deleteFolder(folderName: string): Promise<boolean> {
    this.validateFolderName(folderName);
    return tracer.span('imap.deleteFolder', { folderName }, async () => {
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    // Prevent deletion of system folders (IMAP-014: trim+casefold the input and
    // also resolve special-use so a localised/whitespace-padded path can't slip
    // a destructive op past a literal English-name check).
    if (await this.isProtectedFolder(folderName)) {
      throw new Error(`Cannot delete protected folder: ${folderName}`);
    }

    try {
      logger.debug(`Deleting folder: ${folderName}`, 'IMAPService');

      await this.client.mailboxDelete(folderName);

      // Clear folder cache to refresh (also resets TTL so next getFolders() re-fetches)
      this.clearFolderCache();

      logger.info(`Folder deleted: ${folderName}`, 'IMAPService');
      return true;
    } catch (error: unknown) {
      const rt = (error as { responseText?: string }).responseText;
      if (rt?.includes('NONEXISTENT')) {
        throw new Error(`Folder '${folderName}' does not exist`);
      }
      if (rt?.includes('HASCHILDREN') || rt?.includes('not empty')) {
        throw new Error(`Folder '${folderName}' is not empty. Move or delete emails first.`);
      }
      logger.error('Failed to delete folder', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.deleteFolder')
  }

  /**
   * Rename a folder
   */
  async renameFolder(oldName: string, newName: string): Promise<boolean> {
    this.validateFolderName(oldName);
    this.validateFolderName(newName);
    return tracer.span('imap.renameFolder', { oldName, newName }, async () => {
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    // Prevent renaming of system folders (IMAP-014: see isProtectedFolder).
    if (await this.isProtectedFolder(oldName)) {
      throw new Error(`Cannot rename protected folder: ${oldName}`);
    }

    try {
      logger.debug(`Renaming folder: ${oldName} -> ${newName}`, 'IMAPService');

      await this.client.mailboxRename(oldName, newName);

      // Clear folder cache to refresh (also resets TTL so next getFolders() re-fetches)
      this.clearFolderCache();

      logger.info(`Folder renamed: ${oldName} -> ${newName}`, 'IMAPService');
      return true;
    } catch (error: unknown) {
      const rt = (error as { responseText?: string }).responseText;
      if (rt?.includes('NONEXISTENT')) {
        throw new Error(`Folder '${oldName}' does not exist`);
      }
      if (rt?.includes('ALREADYEXISTS')) {
        throw new Error(`Folder '${newName}' already exists`);
      }
      logger.error('Failed to rename folder', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.renameFolder')
  }

  private idleClient: ImapFlow | null = null;
  private idleActive: boolean = false;
  // Bumped each time an IDLE loop starts. A running loop exits when it sees a
  // newer generation, so a stop-then-start (e.g. on credential reload) can
  // never leave two loops racing on idleClient.
  private _idleGen: number = 0;
  /** Set when the IDLE loop STOPS itself due to a login/credential failure, so
   *  the UI and logs can surface it. It is deliberately NOT retried (retrying a
   *  bad password just locks the account out). Cleared on a successful connect
   *  or when startIdle() is called again (e.g. after credentials are updated). */
  public idleAuthFailure: { message: string; at: Date } | null = null;
  /** Most recent transient (non-auth) connection issue, while the loop keeps
   *  retrying with backoff. Cleared on a successful connect. */
  public idleLastIssue: { category: string; message: string; at: Date } | null = null;

  /** Start a background IMAP IDLE connection on INBOX to receive push invalidations. */
  async startIdle(): Promise<void> {
    if (this.idleActive || !this.connectionConfig) return;
    // A fresh start clears any prior auth-stop so updated credentials get a
    // real attempt (the loop stops itself again if they're still wrong).
    this.idleAuthFailure = null;
    this.idleActive = true;

    // Run in background — don't await
    this.runIdleLoop().catch(err => {
      logger.debug('IDLE loop exited', 'IMAPService', err);
      this.idleActive = false;
    });
  }

  private async runIdleLoop(): Promise<void> {
    const myGen = ++this._idleGen; // claim this generation; older loops self-exit
    const cfg = this.connectionConfig;
    if (!cfg) return;

    // IMAP-001 from the 2026-05-28 audit: the IDLE loop used to silently
    // fall back to `rejectUnauthorized: false` when the cert load failed —
    // ignoring `allowInsecureBridge`. The main connect() path correctly
    // throws in the same situation. Mirror that contract here: if the
    // operator pinned a cert OR set localhost without an insecure opt-in,
    // refuse to bring up the IDLE socket downgraded.
    const isLocalhost = cfg.host === 'localhost' || cfg.host === '127.0.0.1';
    const allowInsecure = cfg.allowInsecureBridge
      || process.env.MAILPOUCH_INSECURE_BRIDGE === '1';
    let tlsOptions: Record<string, unknown> | undefined;

    if (isLocalhost) {
      if (cfg.bridgeCertPath) {
        try {
          let certPath = cfg.bridgeCertPath;
          try { if (statSync(certPath).isDirectory()) certPath = pathJoin(certPath, 'cert.pem'); } catch {}
          const cert = readPinnedBridgeCert(certPath);
          tlsOptions = buildBridgeTlsOptions(cert);
        } catch (err) {
          if (!allowInsecure) {
            logger.error(
              `IDLE: Bridge cert at "${cfg.bridgeCertPath}" could not be loaded and allowInsecureBridge is not set. ` +
              `Refusing to start IDLE with TLS validation disabled. Fix the cert path or set allowInsecureBridge: true.`,
              'IMAPService',
              err
            );
            this.idleActive = false;
            return;
          }
          logger.warn(
            `IDLE: Failed to load Bridge cert at "${cfg.bridgeCertPath}" — running with TLS validation DISABLED (allowInsecureBridge is set).`,
            'IMAPService',
            err
          );
          tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
        }
      } else {
        if (!allowInsecure) {
          logger.error(
            'IDLE: No Bridge certificate configured. Refusing to start IDLE with TLS validation disabled. ' +
            "Set 'bridgeCertPath' or set allowInsecureBridge: true to opt into the legacy behavior.",
            'IMAPService'
          );
          this.idleActive = false;
          return;
        }
        logger.warn(
          'IDLE: No Bridge certificate configured and allowInsecureBridge is set — TLS certificate validation DISABLED for localhost.',
          'IMAPService'
        );
        tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
      }
    } else {
      tlsOptions = { minVersion: 'TLSv1.2' };
    }

    // Cluster-2 connection leak: a failed connect()/idle() must NOT leave its
    // socket dangling for the next iteration to overwrite. Always reap the
    // previous idle client before creating a new one, and back off
    // exponentially on repeated failures so a session-capped Bridge (which
    // answers "454 too many login attempts") isn't hammered every 30s — which
    // previously turned one auth failure into thousands of leaked sockets/day.
    // Backoff schedule for TRANSIENT (non-auth) failures: 1, 5, 15, 30 minutes,
    // then hold at 30. A login/credential failure is NOT retried at all (see the
    // catch below) — hammering a bad password just trips Bridge's "too many
    // login attempts" lockout and never recovers on its own.
    const BACKOFF_SCHEDULE_MS = [60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000];
    let backoffIdx = 0;

    const reapIdleClient = async (): Promise<void> => {
      if (!this.idleClient) return;
      const stale = this.idleClient;
      this.idleClient = null;
      try { await stale.logout(); }
      catch { try { (stale as unknown as { close?: () => void }).close?.(); } catch { /* already gone */ } }
    };

    // Sleep in short chunks so stopIdle() (which flips idleActive) interrupts the
    // backoff promptly even at the 5-min cap, and no long pending timer keeps the
    // Node event loop alive during shutdown.
    const interruptibleSleep = async (ms: number): Promise<void> => {
      const STEP = 1000;
      for (let waited = 0; waited < ms && this.idleActive; waited += STEP) {
        await new Promise(resolve => setTimeout(resolve, Math.min(STEP, ms - waited)));
      }
    };

    while (this.idleActive && this._idleGen === myGen) {
      try {
        await reapIdleClient(); // never leak a prior socket
        this.idleClient = new ImapFlow({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure !== undefined ? cfg.secure : !isLocalhost,
          auth: cfg.username && cfg.password ? { user: cfg.username, pass: cfg.password } : undefined,
          logger: false,
          tls: tlsOptions,
          connectionTimeout: 30000,
        });

        // imapflow extends EventEmitter. A socket 'error' emitted with NO
        // 'error' listener throws synchronously → uncaughtException →
        // gracefulShutdown → the whole process exits. IDLE sockets to a local
        // Bridge reset routinely (Bridge sleep/restart/session caps), so this
        // was a recurring "mailpouch keeps crashing". The reconnect loop below
        // already recovers from drops via try/catch + backoff; these listeners
        // exist only so the async socket error is handled instead of thrown.
        this.idleClient.on('error', (err) => {
          logger.debug('IDLE socket error (will reconnect)', 'IMAPService', err);
        });
        this.idleClient.on('close', () => {
          logger.debug('IDLE socket closed (will reconnect)', 'IMAPService');
        });

        await this.idleClient.connect();
        // Connected (and authenticated) cleanly — clear failure state.
        backoffIdx = 0;
        this.idleAuthFailure = null;
        this.idleLastIssue = null;
        const lock = await this.idleClient.getMailboxLock('INBOX');

        try {
          logger.debug('IDLE: watching INBOX for changes', 'IMAPService');

          // Listen for new messages (EXISTS) or deletions (EXPUNGE)
          this.idleClient.on('exists', (data: { count?: number }) => {
            logger.debug('IDLE: new messages detected, invalidating cache', 'IMAPService', { count: data.count });
            this.evictInboxCacheEntries();
          });

          this.idleClient.on('expunge', () => {
            logger.debug('IDLE: expunge detected, invalidating INBOX cache', 'IMAPService');
            this.evictInboxCacheEntries();
          });

          // Start IDLE — this blocks until the server sends a response or timeout
          await this.idleClient.idle();
        } finally {
          lock.release();
        }
      } catch (err) {
        // Close the failed client so its socket is reaped, not orphaned.
        await reapIdleClient();

        const cls = classifyError(err);
        const shape = err as { message?: string; responseText?: string };
        const text = `${shape?.message ?? ''} ${shape?.responseText ?? ''}`.toLowerCase();
        // A genuine rejected login is terminal; "too many login attempts" is a
        // transient lockout (caused BY retrying) that DOES clear on its own, so
        // treat that as a backoff case rather than a permanent stop.
        const throttled = /too many login attempts|rate limit|try again later|temporarily/.test(text);

        if (cls.category === 'auth' && !throttled) {
          this.idleAuthFailure = { message: cls.message, at: new Date() };
          this.idleActive = false;
          logger.error(
            `IMAP login failed — ${cls.message} Halting reconnect attempts to avoid locking the account out. ` +
            `Fix the Bridge password in Settings → Connection, then restart the server (or relaunch from your MCP client) to retry.`,
            'IMAPService',
            err,
          );
          break; // STOP — do not reconnect on a credential failure
        }

        // Transient issue: surface it and retry on the 1 / 5 / 15 / 30-minute
        // schedule (holding at 30), so we never silently spin or hammer Bridge.
        this.idleLastIssue = { category: cls.category, message: cls.message, at: new Date() };
        const waitMs = BACKOFF_SCHEDULE_MS[Math.min(backoffIdx, BACKOFF_SCHEDULE_MS.length - 1)];
        backoffIdx++;
        logger.warn(
          `IMAP connection issue — ${cls.message}${throttled ? ' (server is rate-limiting logins)' : ''} ` +
          `Retrying in ${Math.round(waitMs / 60_000)} min.`,
          'IMAPService',
          err,
        );
        if (this.idleActive) await interruptibleSleep(waitMs);
        continue; // skip the post-success short delay below
      }

      // Normal end of an IDLE cycle (server closed idle / change detected):
      // reconnect promptly rather than waiting a full backoff step.
      if (this.idleActive) await interruptibleSleep(1000);
    }

    await reapIdleClient();
  }

  /** Stop the background IDLE connection. */
  stopIdle(): void {
    this.idleActive = false;
    this.idleClient?.logout().catch(() => {});
    this.idleClient = null;
  }

  /**
   * Flush the OLD credentials from every live IMAP client and reconnect with
   * the NEW password — so a Settings → Connection save takes effect WITHOUT a
   * restart. Tears down the main + IDLE clients (both authed with the stale
   * password), updates the stored connection config, clears the auth-failure
   * stop so tools no longer fast-fail, then reconnects and restarts IDLE.
   *
   * Never throws: a failed reconnect (e.g. Bridge still throttling) is logged;
   * the next IDLE cycle / tool call retries with the new password.
   */
  async reloadCredentials(password: string): Promise<void> {
    if (!this.connectionConfig) {
      // Never connected (boot connect hasn't run) — nothing live to flush; the
      // first connect will use whatever the account spec now holds.
      return;
    }
    logger.info('Reloading IMAP credentials and reconnecting with the updated password', 'IMAPService');
    const wasIdle = this.idleActive;
    // 1. Flush the stale credential from both live clients.
    this.stopIdle();                 // reaps the IDLE client (old password)
    await this.disconnect();         // reaps the main client (old password)
    // 2. Load the new credential into the live config and clear failure state.
    this.connectionConfig.password = password;
    this.idleAuthFailure = null;
    this.idleLastIssue = null;
    // 3. Reconnect now so the new password is in effect immediately.
    const c = this.connectionConfig;
    try {
      await this.connect(c.host, c.port, c.username, password, c.bridgeCertPath, c.secure, c.allowInsecureBridge ?? false);
      logger.info('IMAP reconnected with the updated credentials', 'IMAPService');
    } catch (err) {
      logger.warn(
        `IMAP reconnect after credential update did not succeed — ${classifyError(err).message} ` +
        `It will retry on the next use or IDLE cycle.`,
        'IMAPService',
      );
    }
    // 4. Restart IDLE if it had been running (the generation guard ensures the
    //    previously-stopped loop can't linger alongside the new one).
    if (wasIdle) await this.startIdle();
  }

  /** Clear all in-memory email and folder caches, forcing fresh IMAP fetches on next access. */
  clearCache(): void {
    tracer.spanSync('imap.clearCache', {}, () => {
    this.clearCacheAll();
    this.clearFolderCache();
    logger.info('IMAP cache cleared', 'IMAPService');
    }); // end tracer.spanSync('imap.clearCache')
  }

  /** Securely wipe all cached data and stored credentials from memory. */
  wipeCache(): void {
    tracer.spanSync('imap.wipeCache', {}, () => {
    // Overwrite email bodies/subjects before clearing
    for (const [, entry] of this.emailCache) {
      const email = entry.email;
      if (email.body) email.body = "";
      if (email.subject) email.subject = "";
      if (email.from) email.from = "";
      if (email.attachments) {
        for (const att of email.attachments) {
          if (att.content && Buffer.isBuffer(att.content)) {
            (att.content as Buffer).fill(0);
          }
          att.content = undefined;
        }
      }
    }
    this.clearCacheAll();
    this.clearFolderCache();

    // Wipe stored connection credentials
    if (this.connectionConfig) {
      if (this.connectionConfig.password) this.connectionConfig.password = "";
      if (this.connectionConfig.username) this.connectionConfig.username = "";
      this.connectionConfig = null;
    }
    logger.info("IMAP cache and credentials wiped", "IMAPService");
    }); // end tracer.spanSync('imap.wipeCache')
  }
}
