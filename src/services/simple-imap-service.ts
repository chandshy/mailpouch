/**
 * IMAP Service for reading emails via Proton Bridge
 */

import { ImapFlow, type SearchObject } from 'imapflow';
import { readFileSync, statSync } from 'fs';
import { join as pathJoin } from 'path';
import type { ParsedMail, Attachment } from 'mailparser';
import { simpleParser } from 'mailparser';
import nodemailer, { type SendMailOptions } from 'nodemailer';
import { EmailMessage, EmailFolder, SearchEmailOptions, SaveDraftOptions } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { tracer, type SpanTags } from '../utils/tracer.js';

/** imapflow's append() return value includes uid at runtime but it is omitted from the type declaration. */
interface AppendResult { uid?: number }

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
  private connectionConfig: { host: string; port: number; username?: string; password?: string; bridgeCertPath?: string; secure?: boolean } | null = null;
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
  private evictCacheEntry(id: string): void {
    const entry = this.emailCache.get(id);
    if (entry) {
      this.cacheByteEstimate -= SimpleIMAPService.estimateCacheBytes(entry.email);
      this.emailCache.delete(id);
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
    // Strip attachment binary content before caching — content is re-fetched on demand
    const toCache: EmailMessage = {
      ...email,
      attachments: email.attachments?.map(a => ({ ...a, content: undefined })),
    };
    const entryBytes = SimpleIMAPService.estimateCacheBytes(toCache);

    // Evict oldest entries until both size and byte limits are satisfied
    while (
      this.emailCache.size > 0 &&
      !this.emailCache.has(id) && // don't evict when updating an existing entry
      (this.emailCache.size >= MAX_EMAIL_CACHE_SIZE ||
       this.cacheByteEstimate + entryBytes > MAX_EMAIL_CACHE_BYTES)
    ) {
      const oldest = this.emailCache.keys().next().value;
      if (oldest === undefined) break;
      this.evictCacheEntry(oldest);
    }

    // If updating an existing entry, subtract its old byte contribution first
    if (this.emailCache.has(id)) {
      const old = this.emailCache.get(id)!;
      this.cacheByteEstimate -= SimpleIMAPService.estimateCacheBytes(old.email);
    }

    this.emailCache.set(id, { email: toCache, cachedAt: Date.now() });
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
    } catch {
      // Silently ignore — UIDVALIDITY tracking is best-effort
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

  private getCacheEntry(id: string): EmailMessage | undefined {
    const entry = this.emailCache.get(id);
    if (!entry) return undefined;
    if (Date.now() - entry.cachedAt > SimpleIMAPService.CACHE_TTL_MS) {
      this.evictCacheEntry(id);
      return undefined;
    }
    return entry.email;
  }

  /** Validate that an email ID is a numeric UID string (prevents IMAP injection) */
  private validateEmailId(id: string): void {
    if (!/^\d+$/.test(id)) {
      throw new Error(`Invalid email ID format: ${JSON.stringify(id)}`);
    }
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
    if (!name || name.trim().length === 0) {
      throw new Error('Folder name must not be empty');
    }
    // RFC 5321 / practical sanity: no folder name should exceed 1 000 chars.
    if (name.length > 1_000) {
      throw new Error(`Folder name is too long: ${name.length} characters (max 1000)`);
    }
    if (/[\x00-\x1f]/.test(name)) {
      throw new Error(`Folder name contains invalid control characters: ${JSON.stringify(name.slice(0, 80))}`);
    }
    // Reject path-traversal sequences (e.g. "../../etc") — defence-in-depth
    // alongside the handler-level validateTargetFolder() checks.
    if (name.includes('..')) {
      throw new Error(`Folder name contains invalid path traversal sequence: ${JSON.stringify(name.slice(0, 80))}`);
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
   */
  async connect(host: string = 'localhost', port: number = 1143, username?: string, password?: string, bridgeCertPath?: string, secure?: boolean): Promise<void> {
    return tracer.span('imap.connect', { host, port, hasCert: !!bridgeCertPath }, async () => {
    logger.debug('Connecting to IMAP server', 'IMAPService', { host, port });

    try {
      // Store connection config for reconnection
      this.connectionConfig = { host, port, username, password, bridgeCertPath, secure };

      // Check if using localhost (Proton Bridge)
      const isLocalhost = host === 'localhost' || host === '127.0.0.1';

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
            const bridgeCert = readFileSync(resolvedCertPath);
            // Bridge certs use CN=127.0.0.1 but we may connect via "localhost",
            // so skip hostname verification when the CA is explicitly trusted.
            tlsOptions = {
              ca: [bridgeCert],
              minVersion: 'TLSv1.2',
              checkServerIdentity: () => undefined,
            };
            logger.info(`IMAP: Using exported Bridge certificate for TLS trust (${resolvedCertPath})`, 'IMAPService');
          } catch (err) {
            logger.error(
              `IMAP: Failed to load Bridge cert at "${resolvedCertPath}" — TLS certificate validation DISABLED. ` +
              `Update the Bridge Certificate Path in Settings → Connection to secure this connection.`,
              'IMAPService',
              err
            );
            tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
            this.insecureTls = true;
          }
        } else {
          logger.warn(
            'IMAP: No Bridge certificate configured — TLS certificate validation DISABLED for localhost. ' +
            'Export the cert from Bridge → Help → Export TLS Certificate, then set the path in Settings → Connection.',
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
    } catch (error) {
      this.isConnected = false;
      logger.error('IMAP connection failed', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.connect')
  }

  /** Log out and close the IMAP connection gracefully. */
  async disconnect(): Promise<void> {
    return tracer.span('imap.disconnect', {}, async () => {
    if (this.client && this.isConnected) {
      logger.debug('Disconnecting from IMAP server', 'IMAPService');
      await this.client.logout();
      this.client = null;
      this.isConnected = false;
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

    const { host, port, username, password, bridgeCertPath, secure } = this.connectionConfig;
    await this.connect(host, port, username, password, bridgeCertPath, secure);
  }

  /**
   * Ensure connection is active, reconnect if needed
   */
  private async ensureConnection(): Promise<void> {
    if (!this.isConnected || !this.client) {
      logger.warn('IMAP connection lost, attempting to reconnect', 'IMAPService');
      await this.reconnect();
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

      for (const folder of folders) {
        const status = await this.client.status(folder.path, { messages: true, unseen: true });

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
      }

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
      logger.warn('IMAP not connected, returning empty array', 'IMAPService');
      return [];
    }

    if (!this.client) {
      logger.warn('IMAP client not available, returning empty array', 'IMAPService');
      return [];
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
            const bodyPreview = truncateBody(bodyText);

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
              isHtml: false,  // envelope fetch doesn't tell us; full fetch via getEmailById will
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
  async getEmailById(emailId: string): Promise<EmailMessage | null> {
    this.validateEmailId(emailId);
    const tags: SpanTags = { emailId };
    return tracer.span('imap.getEmailById', tags, async () => {
    logger.debug('Fetching email by ID', 'IMAPService', { emailId });

    // Check cache first
    const cachedEntry = this.getCacheEntry(emailId);
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
      // Search all folders for this email
      const folders = await this.getFolders();

      for (const folder of folders) {
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

            // Extract content-type for PGP detection
            const contentType = parsed.headers?.get('content-type');
            const ctStr = typeof contentType === 'string' ? contentType : ((contentType as unknown as { value?: string } | null)?.value ?? '');

            // Extract X-Pm-Internal-Id for stable Proton message ID
            const pmId = parsed.headers?.get('x-pm-internal-id');

            const emailMessage: EmailMessage = {
              id: message.uid.toString(),
              from: parsed.from?.text || '',
              to: parsed.to?.text ? [parsed.to.text] : [],
              cc: parsed.cc?.text ? [parsed.cc.text] : [],
              subject: parsed.subject || '(No Subject)',
              body: fullBody, // Full body for individual email view
              bodyPreview: truncateBody(fullBody),
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
      const sanitizeImapStr = (s: string) => s.replace(/["\\]/g, "");
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
      // header is { [field]: value } in the SearchObject API (not a tuple)
      if (options.header) searchCriteria.header = { [options.header.field]: options.header.value };

      // Flag criteria — imapflow uses boolean: true = flag set, false = flag not set
      if (options.answered !== undefined) searchCriteria.answered = options.answered;
      if (options.isDraft  !== undefined) searchCriteria.draft    = options.isDraft;

      // Size criteria
      if (options.larger !== undefined)  searchCriteria.larger = options.larger;
      if (options.smaller !== undefined) searchCriteria.smaller = options.smaller;

      // Sent-date criteria (Date: header vs INTERNALDATE)
      if (options.sentBefore) searchCriteria.sentBefore = options.sentBefore;
      if (options.sentSince)  searchCriteria.sentSince  = options.sentSince;

      const uids = await this.client.search(searchCriteria, { uid: true });
      const results: EmailMessage[] = [];

      const limitedUids = Array.isArray(uids) ? uids.slice(0, limit) : [];

      for (const uid of limitedUids) {
        const email = await this.getEmailById(uid.toString());
        if (email) {
          results.push({
            ...email,
            body: truncateBody(email.body),
            attachments: email.attachments?.map(att => ({
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

    // Ensure the email metadata is in cache (getCacheEntry returns stripped version)
    if (!this.getCacheEntry(emailId)) {
      await this.getEmailById(emailId);
    }

    const cached = this.getCacheEntry(emailId);
    if (!cached || !cached.attachments || cached.attachments.length === 0) {
      return null;
    }

    const idx = Math.trunc(attachmentIndex);
    if (idx < 0 || idx >= cached.attachments.length) {
      return null;
    }

    let att = cached.attachments[idx];

    // GAP 7.5: attachment content is stripped from cache — re-fetch full source on demand
    if (!att.content) {
      logger.debug('Attachment content not in cache, re-fetching full email source', 'IMAPService', { emailId, attachmentIndex });
      const fresh = await this.fetchEmailFullSource(emailId);
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
  private async fetchEmailFullSource(emailId: string): Promise<EmailMessage | null> {
    if (!this.client || !this.isConnected) return null;
    try {
      const folders = await this.getFolders();
      for (const folder of folders) {
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
            return {
              id: message.uid.toString(),
              from: parsed.from?.text || '',
              to: parsed.to?.text ? [parsed.to.text] : [],
              cc: parsed.cc?.text ? [parsed.cc.text] : [],
              subject: parsed.subject || '(No Subject)',
              body: fullBody,
              bodyPreview: truncateBody(fullBody),
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
   * case-insensitive name match against common names; last resort 'Drafts'.
   */
  private async findDraftsFolder(): Promise<string> {
    // Check folder cache first (populated by getFolders / markEmailRead etc.)
    const cached = Array.from(this.folderCache.values());
    const fromCache = this.pickDraftsFolder(cached);
    if (fromCache) return fromCache;

    // Cache miss — refresh and retry
    try {
      const folders = await this.getFolders();
      const found = this.pickDraftsFolder(folders);
      if (found) return found;
    } catch {
      // swallow — fall through to default
    }

    return 'Drafts';
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
      // Build the raw MIME message using nodemailer's buffer transport
      const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'crlf' });

      const toAddresses = !options.to
        ? undefined
        : Array.isArray(options.to) ? options.to.join(', ') : options.to;
      const ccAddresses = !options.cc
        ? undefined
        : Array.isArray(options.cc) ? options.cc.join(', ') : options.cc;
      const bccAddresses = !options.bcc
        ? undefined
        : Array.isArray(options.bcc) ? options.bcc.join(', ') : options.bcc;

      const mailOptions: SendMailOptions = {
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject: options.subject || '(No Subject)',
        text: options.isHtml ? undefined : (options.body || ''),
        html: options.isHtml ? (options.body || '') : undefined,
        // Strip CRLF and NUL from inReplyTo to prevent Message-ID header injection
        // (e.g. a crafted value like "<id>\r\nBcc: evil@x.com" would inject a raw
        // MIME header line).  Mirrors the stripHeaderInjection() call in smtp-service.ts.
        inReplyTo: options.inReplyTo ? options.inReplyTo.replace(/[\r\n\x00]/g, "") : undefined,
        references: options.references?.map(r => r.replace(/[\x00-\x1f\x7f]/g, "")).join(' '),
      };

      if (options.attachments && options.attachments.length > 0) {
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

      // Append to Drafts folder with the \Draft IMAP flag
      const draftsPath = await this.findDraftsFolder();
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
   * @returns true on success, false if not connected or email not found
   */
  async markEmailRead(emailId: string, isRead: boolean = true): Promise<boolean> {
    this.validateEmailId(emailId);
    return tracer.span('imap.markEmailRead', { emailId, isRead }, async () => {
    logger.debug('Marking email read status', 'IMAPService', { emailId, isRead });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      const email = await this.getEmailById(emailId);
      if (!email) {
        throw new Error(`Email ${emailId} not found`);
      }

      const lock = await this.client.getMailboxLock(email.folder);

      try {
        if (isRead) {
          await this.client.messageFlagsAdd(emailId, ['\\Seen'], { uid: true });
        } else {
          await this.client.messageFlagsRemove(emailId, ['\\Seen'], { uid: true });
        }

        // Update cache
        const cachedForRead = this.getCacheEntry(emailId);
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
   * @returns true on success, false if not connected or email not found
   */
  async starEmail(emailId: string, isStarred: boolean = true): Promise<boolean> {
    this.validateEmailId(emailId);
    return tracer.span('imap.starEmail', { emailId, isStarred }, async () => {
    logger.debug('Starring email', 'IMAPService', { emailId, isStarred });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      const email = await this.getEmailById(emailId);
      if (!email) {
        throw new Error(`Email ${emailId} not found`);
      }

      const lock = await this.client.getMailboxLock(email.folder);

      try {
        if (isStarred) {
          await this.client.messageFlagsAdd(emailId, ['\\Flagged'], { uid: true });
        } else {
          await this.client.messageFlagsRemove(emailId, ['\\Flagged'], { uid: true });
        }

        // Update cache
        const cachedForStar = this.getCacheEntry(emailId);
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
   * @returns true on success, false if not connected or email not found
   */
  async moveEmail(emailId: string, targetFolder: string): Promise<boolean> {
    this.validateEmailId(emailId);
    this.validateFolderName(targetFolder);
    return tracer.span('imap.moveEmail', { emailId, targetFolder }, async () => {
    logger.debug('Moving email', 'IMAPService', { emailId, targetFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      const email = await this.getEmailById(emailId);
      if (!email) {
        throw new Error(`Email ${emailId} not found`);
      }

      const lock = await this.client.getMailboxLock(email.folder);

      try {
        await this.client.messageMove(emailId, targetFolder, { uid: true });

        // Update cache
        const cachedForMove = this.getCacheEntry(emailId);
        if (cachedForMove) {
          cachedForMove.folder = targetFolder;
        }

        logger.info(`Email ${emailId} moved to ${targetFolder}`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
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
   * @returns true on success, false if not connected or email not found
   */
  async copyEmailToFolder(emailId: string, targetFolder: string): Promise<boolean> {
    this.validateEmailId(emailId);
    this.validateFolderName(targetFolder);
    return tracer.span('imap.copyEmailToFolder', { emailId, targetFolder }, async () => {
    logger.debug('Copying email to folder', 'IMAPService', { emailId, targetFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      const email = await this.getEmailById(emailId);
      if (!email) {
        throw new Error(`Email ${emailId} not found`);
      }

      const lock = await this.client.getMailboxLock(email.folder);

      try {
        await this.client.messageCopy(emailId, targetFolder, { uid: true });
        logger.info(`Email ${emailId} copied to ${targetFolder}`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
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
        await this.client.messageDelete(emailId, { uid: true });
        // Remove from cache if present
        this.evictCacheEntry(emailId);
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
   * @returns true on success, false/throws on failure
   */
  async setFlag(emailId: string, flag: string, set: boolean = true): Promise<boolean> {
    this.validateEmailId(emailId);
    return tracer.span('imap.setFlag', { emailId, flag, set }, async () => {
    logger.debug('Setting flag on email', 'IMAPService', { emailId, flag, set });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      // Find folder from cache first, then scan
      let folder: string | undefined;
      const cached = this.getCacheEntry(emailId);
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
          } catch { /* not in this folder */ } finally {
            lock.release();
          }
        }
      }

      if (!folder) {
        throw new Error(`Email ${emailId} not found in any folder`);
      }

      const lock = await this.client.getMailboxLock(folder);
      try {
        if (set) {
          await this.client.messageFlagsAdd(emailId, [flag], { uid: true });
        } else {
          await this.client.messageFlagsRemove(emailId, [flag], { uid: true });
        }
        logger.info(`Flag ${flag} ${set ? 'set' : 'cleared'} on email ${emailId}`, 'IMAPService');
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

  async bulkMoveEmails(emailIds: string[], targetFolder: string): Promise<{ success: number; failed: number; errors: string[] }> {
    this.validateFolderName(targetFolder);
    const tags: SpanTags = { count: emailIds.length, targetFolder };
    return tracer.span('imap.bulkMoveEmails', tags, async () => {
    logger.debug('Bulk moving emails', 'IMAPService', { count: emailIds.length, targetFolder });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      throw new Error('IMAP client not connected');
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[]
    };

    // Group emails by their source folder (use cache for known folders; fall back to INBOX)
    const emailsByFolder = new Map<string, string[]>();

    for (const emailId of emailIds) {
      try {
        this.validateEmailId(emailId);
        const cached = this.getCacheEntry(emailId);
        const folder = cached?.folder ?? 'INBOX';
        if (!emailsByFolder.has(folder)) emailsByFolder.set(folder, []);
        emailsByFolder.get(folder)!.push(emailId);
      } catch (error: unknown) {
        results.failed++;
        results.errors.push(`Invalid email ID ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // For each group, open the folder lock once and batch-move all UIDs
    for (const [sourceFolder, ids] of emailsByFolder.entries()) {
      const lock = await this.client.getMailboxLock(sourceFolder);
      try {
        const uidSet = ids.join(',');
        try {
          await this.client.messageMove(uidSet, targetFolder, { uid: true });
          // Update cache and count successes
          for (const emailId of ids) {
            const cachedForBulkMove = this.getCacheEntry(emailId);
            if (cachedForBulkMove) cachedForBulkMove.folder = targetFolder;
            results.success++;
          }
        } catch (batchError: unknown) {
          // Batch failed — fall back to per-email
          logger.warn(`Batch move failed for folder ${sourceFolder}, falling back to per-email`, 'IMAPService', batchError);
          for (const emailId of ids) {
            try {
              await this.client.messageMove(emailId, targetFolder, { uid: true });
              const cachedForBulkMove = this.getCacheEntry(emailId);
              if (cachedForBulkMove) cachedForBulkMove.folder = targetFolder;
              results.success++;
            } catch (error: unknown) {
              results.failed++;
              results.errors.push(`Failed to move email ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
              logger.warn(`Failed to move email ${emailId}`, 'IMAPService', error);
            }
          }
        }
      } finally {
        lock.release();
      }
    }

    tags.successCount = results.success;
    tags.failCount = results.failed;
    logger.info(`Bulk move completed: ${results.success} succeeded, ${results.failed} failed`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkMoveEmails')
  }

  async deleteEmail(emailId: string): Promise<boolean> {
    this.validateEmailId(emailId);
    return tracer.span('imap.deleteEmail', { emailId }, async () => {
    logger.debug('Deleting email', 'IMAPService', { emailId });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      return false;
    }

    try {
      const email = await this.getEmailById(emailId);
      if (!email) {
        throw new Error(`Email ${emailId} not found`);
      }

      const lock = await this.client.getMailboxLock(email.folder);

      try {
        await this.client.messageDelete(emailId, { uid: true });

        // Remove from cache
        this.evictCacheEntry(emailId);

        logger.info(`Email ${emailId} deleted`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to delete email', 'IMAPService', error);
      throw error;
    }
    }); // end tracer.span('imap.deleteEmail')
  }

  async bulkDeleteEmails(emailIds: string[]): Promise<{ success: number; failed: number; errors: string[] }> {
    const tags: SpanTags = { count: emailIds.length };
    return tracer.span('imap.bulkDeleteEmails', tags, async () => {
    logger.debug('Bulk deleting emails', 'IMAPService', { count: emailIds.length });

    if (!this.client || !this.isConnected) {
      logger.warn('IMAP not connected', 'IMAPService');
      throw new Error('IMAP client not connected');
    }

    const results = {
      success: 0,
      failed: 0,
      errors: [] as string[]
    };

    // Group emails by their folder (use cache for known folders; fall back to INBOX)
    const emailsByFolder2 = new Map<string, string[]>();

    for (const emailId of emailIds) {
      try {
        this.validateEmailId(emailId);
        const cached = this.getCacheEntry(emailId);
        const folder = cached?.folder ?? 'INBOX';
        if (!emailsByFolder2.has(folder)) emailsByFolder2.set(folder, []);
        emailsByFolder2.get(folder)!.push(emailId);
      } catch (error: unknown) {
        results.failed++;
        results.errors.push(`Invalid email ID ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // For each group, open the folder lock once and batch-delete all UIDs
    for (const [folder, ids] of emailsByFolder2.entries()) {
      const lock = await this.client.getMailboxLock(folder);
      try {
        const uidSet = ids.join(',');
        try {
          await this.client.messageDelete(uidSet, { uid: true });
          for (const emailId of ids) {
            this.evictCacheEntry(emailId);
            results.success++;
          }
        } catch (batchError: unknown) {
          // Batch failed — fall back to per-email
          logger.warn(`Batch delete failed for folder ${folder}, falling back to per-email`, 'IMAPService', batchError);
          for (const emailId of ids) {
            try {
              await this.client.messageDelete(emailId, { uid: true });
              this.evictCacheEntry(emailId);
              results.success++;
            } catch (error: unknown) {
              results.failed++;
              results.errors.push(`Failed to delete email ${emailId}: ${error instanceof Error ? error.message : String(error)}`);
              logger.warn(`Failed to delete email ${emailId}`, 'IMAPService', error);
            }
          }
        }
      } finally {
        lock.release();
      }
    }

    tags.successCount = results.success;
    tags.failCount = results.failed;
    logger.info(`Bulk delete completed: ${results.success} succeeded, ${results.failed} failed`, 'IMAPService');
    return results;
    }); // end tracer.span('imap.bulkDeleteEmails')
  }

  /**
   * Create a new folder
   */
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

  /**
   * Delete a folder (must be empty)
   */
  async deleteFolder(folderName: string): Promise<boolean> {
    this.validateFolderName(folderName);
    return tracer.span('imap.deleteFolder', { folderName }, async () => {
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    // Prevent deletion of system folders
    const protectedFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive', 'All Mail', 'Starred'];
    if (protectedFolders.some(f => folderName.toLowerCase() === f.toLowerCase())) {
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

    // Prevent renaming of system folders
    const protectedFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive', 'All Mail', 'Starred'];
    if (protectedFolders.some(f => oldName.toLowerCase() === f.toLowerCase())) {
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

  /** Start a background IMAP IDLE connection on INBOX to receive push invalidations. */
  async startIdle(): Promise<void> {
    if (this.idleActive || !this.connectionConfig) return;
    this.idleActive = true;

    // Run in background — don't await
    this.runIdleLoop().catch(err => {
      logger.debug('IDLE loop exited', 'IMAPService', err);
      this.idleActive = false;
    });
  }

  private async runIdleLoop(): Promise<void> {
    const cfg = this.connectionConfig;
    if (!cfg) return;

    const isLocalhost = cfg.host === 'localhost' || cfg.host === '127.0.0.1';
    let tlsOptions: Record<string, unknown> | undefined;

    if (isLocalhost) {
      if (cfg.bridgeCertPath) {
        try {
          let certPath = cfg.bridgeCertPath;
          try { if (statSync(certPath).isDirectory()) certPath = pathJoin(certPath, 'cert.pem'); } catch {}
          const cert = readFileSync(certPath);
          tlsOptions = {
            ca: [cert],
            minVersion: 'TLSv1.2',
            checkServerIdentity: () => undefined,
          };
        } catch {
          tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
        }
      } else {
        tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
      }
    } else {
      tlsOptions = { minVersion: 'TLSv1.2' };
    }

    while (this.idleActive) {
      try {
        this.idleClient = new ImapFlow({
          host: cfg.host,
          port: cfg.port,
          secure: cfg.secure !== undefined ? cfg.secure : !isLocalhost,
          auth: cfg.username && cfg.password ? { user: cfg.username, pass: cfg.password } : undefined,
          logger: false,
          tls: tlsOptions,
          connectionTimeout: 30000,
        });

        await this.idleClient.connect();
        const lock = await this.idleClient.getMailboxLock('INBOX');

        try {
          logger.debug('IDLE: watching INBOX for changes', 'IMAPService');

          // Listen for new messages (EXISTS) or deletions (EXPUNGE)
          this.idleClient.on('exists', (data: { count?: number }) => {
            logger.debug('IDLE: new messages detected, invalidating cache', 'IMAPService', { count: data.count });
            // Invalidate only INBOX email cache entries (not all folders)
            for (const [id, entry] of this.emailCache) {
              if (entry.email.folder === 'INBOX') this.evictCacheEntry(id);
            }
          });

          this.idleClient.on('expunge', () => {
            logger.debug('IDLE: expunge detected, invalidating INBOX cache', 'IMAPService');
            for (const [id, entry] of this.emailCache) {
              if (entry.email.folder === 'INBOX') this.evictCacheEntry(id);
            }
          });

          // Start IDLE — this blocks until the server sends a response or timeout
          await this.idleClient.idle();
        } finally {
          lock.release();
        }
      } catch (err) {
        logger.debug('IDLE connection dropped, will retry in 30s', 'IMAPService', err);
      }

      if (this.idleActive) {
        // Wait 30s before reconnecting
        await new Promise(resolve => setTimeout(resolve, 30_000));
      }
    }

    try { this.idleClient?.logout().catch(() => {}); } catch {}
    this.idleClient = null;
  }

  /** Stop the background IDLE connection. */
  stopIdle(): void {
    this.idleActive = false;
    this.idleClient?.logout().catch(() => {});
    this.idleClient = null;
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
