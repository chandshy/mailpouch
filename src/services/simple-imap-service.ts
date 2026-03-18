/**
 * IMAP Service for reading emails via Proton Bridge
 */

import { ImapFlow } from 'imapflow';
import { readFileSync } from 'fs';
import type { ParsedMail, Attachment } from 'mailparser';
import { simpleParser } from 'mailparser';
import nodemailer from 'nodemailer';
import { EmailMessage, EmailFolder, SearchEmailOptions, SaveDraftOptions } from '../types/index.js';
import { logger } from '../utils/logger.js';
import { extractEmailAddress, extractName, generateId } from '../utils/helpers.js';

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

/** Maximum number of emails held in the in-process cache.
 *  Each cached email carries its full body + binary attachment content, so
 *  an unbounded map is a memory-exhaustion vector.  Oldest entries are evicted
 *  (FIFO) once the cap is reached — imapflow UIDs are monotonically increasing
 *  so the oldest key is reliably the first key in insertion order. */
const MAX_EMAIL_CACHE_SIZE = 500;

export class SimpleIMAPService {
  private client: ImapFlow | null = null;
  private isConnected: boolean = false;
  private emailCache: Map<string, EmailMessage> = new Map();
  private folderCache: Map<string, EmailFolder> = new Map();
  private connectionConfig: { host: string; port: number; username?: string; password?: string; bridgeCertPath?: string } | null = null;
  /** True when TLS certificate validation is disabled (no Bridge cert configured). */
  insecureTls = false;

  /**
   * Write an entry to emailCache, evicting the oldest entry (FIFO) when the
   * cap is reached.  Map iteration order in V8 is insertion order, so
   * `keys().next()` reliably gives the oldest key.
   */
  private setCacheEntry(id: string, email: EmailMessage): void {
    if (!this.emailCache.has(id) && this.emailCache.size >= MAX_EMAIL_CACHE_SIZE) {
      const oldest = this.emailCache.keys().next().value;
      if (oldest !== undefined) this.emailCache.delete(oldest);
    }
    this.emailCache.set(id, email);
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
  }

  async connect(host: string = 'localhost', port: number = 1143, username?: string, password?: string, bridgeCertPath?: string): Promise<void> {
    logger.debug('Connecting to IMAP server', 'IMAPService', { host, port });

    try {
      // Store connection config for reconnection
      this.connectionConfig = { host, port, username, password, bridgeCertPath };

      // Check if using localhost (Proton Bridge)
      const isLocalhost = host === 'localhost' || host === '127.0.0.1';

      // Build TLS options
      let tlsOptions: Record<string, unknown> | undefined;
      if (isLocalhost) {
        if (bridgeCertPath) {
          try {
            const bridgeCert = readFileSync(bridgeCertPath);
            tlsOptions = { ca: [bridgeCert], minVersion: 'TLSv1.2' };
            logger.info('IMAP: Using exported Bridge certificate for TLS trust', 'IMAPService');
          } catch (err) {
            logger.error(
              `IMAP: Failed to load Bridge cert at "${bridgeCertPath}" — TLS certificate validation DISABLED. ` +
              `Fix the PROTONMAIL_BRIDGE_CERT path to secure this connection.`,
              'IMAPService',
              err
            );
            tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
            this.insecureTls = true;
          }
        } else {
          logger.error(
            'IMAP: PROTONMAIL_BRIDGE_CERT not set — TLS certificate validation DISABLED for localhost. ' +
            'Export the cert from Bridge → Help → Export TLS Certificate and set this env var.',
            'IMAPService'
          );
          tlsOptions = { rejectUnauthorized: false, minVersion: 'TLSv1.2' };
          this.insecureTls = true;
        }
      } else {
        // Non-localhost: full certificate validation required
        tlsOptions = { minVersion: 'TLSv1.2' };
      }

      this.client = new ImapFlow({
        host,
        port,
        secure: !isLocalhost, // Use implicit TLS for non-Bridge connections; Bridge uses STARTTLS
        auth: username && password ? {
          user: username,
          pass: password
        } : undefined,
        logger: false,
        tls: tlsOptions
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
  }

  async disconnect(): Promise<void> {
    if (this.client && this.isConnected) {
      logger.debug('Disconnecting from IMAP server', 'IMAPService');
      await this.client.logout();
      this.client = null;
      this.isConnected = false;
      logger.info('IMAP disconnected', 'IMAPService');
    }
  }

  /**
   * Attempt to reconnect to IMAP server if connection was lost
   */
  private async reconnect(): Promise<void> {
    if (!this.connectionConfig) {
      throw new Error('Cannot reconnect: no connection config stored');
    }

    logger.info('Attempting to reconnect to IMAP server', 'IMAPService');

    const { host, port, username, password, bridgeCertPath } = this.connectionConfig;
    await this.connect(host, port, username, password, bridgeCertPath);
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

  isActive(): boolean {
    return this.isConnected && this.client !== null;
  }

  async getFolders(): Promise<EmailFolder[]> {
    logger.debug('Fetching folders', 'IMAPService');

    try {
      await this.ensureConnection();
    } catch (error) {
      logger.warn('IMAP not connected, returning cached folders', 'IMAPService');
      return Array.from(this.folderCache.values());
    }

    if (!this.client) {
      logger.warn('IMAP client not available, returning cached folders', 'IMAPService');
      return Array.from(this.folderCache.values());
    }

    try {
      const folders = await this.client.list();
      const result: EmailFolder[] = [];

      for (const folder of folders) {
        const status = await this.client.status(folder.path, { messages: true, unseen: true });

        const emailFolder: EmailFolder = {
          name: folder.name,
          path: folder.path,
          totalMessages: status.messages || 0,
          unreadMessages: status.unseen || 0,
          specialUse: folder.specialUse
        };

        result.push(emailFolder);
        this.folderCache.set(folder.path, emailFolder);
      }

      logger.info(`Retrieved ${result.length} folders`, 'IMAPService');
      return result;
    } catch (error) {
      logger.error('Failed to fetch folders', 'IMAPService', error);
      throw error;
    }
  }

  async getEmails(folder: string = 'INBOX', limit: number = 50, offset: number = 0): Promise<EmailMessage[]> {
    this.validateFolderName(folder);
    limit = Math.min(Math.max(1, limit ?? 50), 200);
    offset = Math.max(0, offset ?? 0);
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
        const mailbox = this.client.mailbox;
        const total = (mailbox && typeof mailbox !== 'boolean' ? mailbox.exists : 0) || 0;
        const start = Math.max(1, total - offset - limit + 1);
        const end = Math.max(1, total - offset);

        if (start > end || total === 0) {
          return [];
        }

        const messages: EmailMessage[] = [];

        for await (const message of this.client.fetch(`${start}:${end}`, {
          envelope: true,
          bodyStructure: true,
          flags: true,
          uid: true,
          source: true
        })) {
          try {
            if (!message.source) continue;
            const parsed = await simpleParser(message.source);

            const fullBody = parsed.text || parsed.html || '';

            // Store full body in cache for later retrieval
            const cachedEmail: EmailMessage = {
              id: message.uid.toString(),
              from: parsed.from?.text || '',
              to: parsed.to?.text ? [parsed.to.text] : [],
              cc: parsed.cc?.text ? [parsed.cc.text] : [],
              subject: parsed.subject || '(No Subject)',
              body: fullBody, // Full body stored in cache
              bodyPreview: truncateBody(fullBody),
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
            };

            this.setCacheEntry(cachedEmail.id, cachedEmail);

            // Return truncated body for list view, without attachment content
            const listEmail: EmailMessage = {
              ...cachedEmail,
              body: truncateBody(fullBody),
              // Remove attachment content from list view to reduce payload size
              attachments: cachedEmail.attachments?.map(att => ({
                filename: att.filename,
                contentType: att.contentType,
                size: att.size,
                contentId: att.contentId
                // content is intentionally omitted
              }))
            };

            messages.push(listEmail);
          } catch (parseError) {
            logger.warn('Failed to parse email', 'IMAPService', parseError);
          }
        }

        logger.info(`Retrieved ${messages.length} emails from ${folder}`, 'IMAPService');
        return messages.reverse(); // Most recent first
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to fetch emails', 'IMAPService', error);
      throw error;
    }
  }

  async getEmailById(emailId: string): Promise<EmailMessage | null> {
    this.validateEmailId(emailId);
    logger.debug('Fetching email by ID', 'IMAPService', { emailId });

    // Check cache first
    if (this.emailCache.has(emailId)) {
      return this.emailCache.get(emailId) || null;
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
            };

            // Cache the full version (including binary content) for internal use
            this.setCacheEntry(emailMessage.id, emailMessage);

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
  }

  /**
   * Search a single folder — extracted so multi-folder search can call it per folder.
   * Caller is responsible for ensuring the IMAP client is connected.
   */
  private async searchSingleFolder(folder: string, options: SearchEmailOptions, limit: number): Promise<EmailMessage[]> {
    if (!this.client) return [];
    const lock = await this.client.getMailboxLock(folder);

    try {
      const searchCriteria: any = {};

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

      if (options.isRead !== undefined) {
        if (options.isRead) {
          searchCriteria.seen = true;
        } else {
          searchCriteria.unseen = true;
        }
      }

      if (options.isStarred !== undefined) {
        if (options.isStarred) {
          searchCriteria.flagged = true;
        }
      }

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

  async searchEmails(options: SearchEmailOptions): Promise<EmailMessage[]> {
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

      logger.info(`Multi-folder search found ${filtered.length} emails across ${foldersToSearch.length} folders`, 'IMAPService');
      return filtered;
    } catch (error) {
      logger.error('Failed to search emails', 'IMAPService', error);
      throw error;
    }
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
    logger.debug('Downloading attachment', 'IMAPService', { emailId, attachmentIndex });

    // Ensure the email (with attachment content) is in cache
    if (!this.emailCache.has(emailId)) {
      // getEmailById populates the cache with full content
      await this.getEmailById(emailId);
    }

    const cached = this.emailCache.get(emailId);
    if (!cached || !cached.attachments || cached.attachments.length === 0) {
      return null;
    }

    const idx = Math.trunc(attachmentIndex);
    if (idx < 0 || idx >= cached.attachments.length) {
      return null;
    }

    const att = cached.attachments[idx];
    if (!att.content) {
      // Content not available (e.g., attachment was fetched without content)
      return null;
    }

    let content: string;
    if (Buffer.isBuffer(att.content)) {
      content = att.content.toString('base64');
    } else {
      // Already a base64 string
      content = att.content;
    }

    return {
      filename: att.filename,
      contentType: att.contentType,
      size: att.size,
      content,
      encoding: "base64",
    };
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

      const mailOptions: any = {
        to: toAddresses,
        cc: ccAddresses,
        bcc: bccAddresses,
        subject: options.subject || '(No Subject)',
        text: options.isHtml ? undefined : (options.body || ''),
        html: options.isHtml ? (options.body || '') : undefined,
        inReplyTo: options.inReplyTo,
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

      const uid = result && typeof result === 'object' ? (result as any).uid : undefined;
      logger.info('Draft saved', 'IMAPService', { uid });
      return { success: true, uid };
    } catch (error: any) {
      logger.error('Failed to save draft', 'IMAPService', error);
      return { success: false, error: error.message };
    }
  }

  async markEmailRead(emailId: string, isRead: boolean = true): Promise<boolean> {
    this.validateEmailId(emailId);
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
        if (this.emailCache.has(emailId)) {
          const cachedEmail = this.emailCache.get(emailId)!;
          cachedEmail.isRead = isRead;
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
  }

  async starEmail(emailId: string, isStarred: boolean = true): Promise<boolean> {
    this.validateEmailId(emailId);
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
        if (this.emailCache.has(emailId)) {
          const cachedEmail = this.emailCache.get(emailId)!;
          cachedEmail.isStarred = isStarred;
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
  }

  async moveEmail(emailId: string, targetFolder: string): Promise<boolean> {
    this.validateEmailId(emailId);
    this.validateFolderName(targetFolder);
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
        if (this.emailCache.has(emailId)) {
          const cachedEmail = this.emailCache.get(emailId)!;
          cachedEmail.folder = targetFolder;
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
  }

  async bulkMoveEmails(emailIds: string[], targetFolder: string): Promise<{ success: number; failed: number; errors: string[] }> {
    this.validateFolderName(targetFolder);
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

    // Group emails by their source folder for efficient bulk operations
    const emailsByFolder = new Map<string, string[]>();

    // First, fetch all emails to determine their folders
    for (const emailId of emailIds) {
      try {
        const email = await this.getEmailById(emailId);
        if (!email) {
          results.failed++;
          results.errors.push(`Email ${emailId} not found`);
          continue;
        }

        if (!emailsByFolder.has(email.folder)) {
          emailsByFolder.set(email.folder, []);
        }
        emailsByFolder.get(email.folder)!.push(emailId);
      } catch (error: any) {
        results.failed++;
        results.errors.push(`Error fetching email ${emailId}: ${error.message}`);
      }
    }

    // Now move emails folder by folder
    for (const [sourceFolder, ids] of emailsByFolder.entries()) {
      const lock = await this.client.getMailboxLock(sourceFolder);

      try {
        // Move each email in this folder
        for (const emailId of ids) {
          try {
            await this.client.messageMove(emailId, targetFolder, { uid: true });

            // Update cache
            if (this.emailCache.has(emailId)) {
              const cachedEmail = this.emailCache.get(emailId)!;
              cachedEmail.folder = targetFolder;
            }

            results.success++;
          } catch (error: any) {
            results.failed++;
            results.errors.push(`Failed to move email ${emailId}: ${error.message}`);
            logger.warn(`Failed to move email ${emailId}`, 'IMAPService', error);
          }
        }
      } finally {
        lock.release();
      }
    }

    logger.info(`Bulk move completed: ${results.success} succeeded, ${results.failed} failed`, 'IMAPService');
    return results;
  }

  async deleteEmail(emailId: string): Promise<boolean> {
    this.validateEmailId(emailId);
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
        this.emailCache.delete(emailId);

        logger.info(`Email ${emailId} deleted`, 'IMAPService');
        return true;
      } finally {
        lock.release();
      }
    } catch (error) {
      logger.error('Failed to delete email', 'IMAPService', error);
      throw error;
    }
  }

  async bulkDeleteEmails(emailIds: string[]): Promise<{ success: number; failed: number; errors: string[] }> {
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

    // Group emails by their folder for efficient bulk operations
    const emailsByFolder = new Map<string, string[]>();

    // First, fetch all emails to determine their folders
    for (const emailId of emailIds) {
      try {
        const email = await this.getEmailById(emailId);
        if (!email) {
          results.failed++;
          results.errors.push(`Email ${emailId} not found`);
          continue;
        }

        if (!emailsByFolder.has(email.folder)) {
          emailsByFolder.set(email.folder, []);
        }
        emailsByFolder.get(email.folder)!.push(emailId);
      } catch (error: any) {
        results.failed++;
        results.errors.push(`Error fetching email ${emailId}: ${error.message}`);
      }
    }

    // Now delete emails folder by folder
    for (const [folder, ids] of emailsByFolder.entries()) {
      const lock = await this.client.getMailboxLock(folder);

      try {
        // Delete each email in this folder
        for (const emailId of ids) {
          try {
            await this.client.messageDelete(emailId, { uid: true });

            // Remove from cache
            this.emailCache.delete(emailId);

            results.success++;
          } catch (error: any) {
            results.failed++;
            results.errors.push(`Failed to delete email ${emailId}: ${error.message}`);
            logger.warn(`Failed to delete email ${emailId}`, 'IMAPService', error);
          }
        }
      } finally {
        lock.release();
      }
    }

    logger.info(`Bulk delete completed: ${results.success} succeeded, ${results.failed} failed`, 'IMAPService');
    return results;
  }

  /**
   * Create a new folder
   */
  async createFolder(folderName: string): Promise<boolean> {
    this.validateFolderName(folderName);
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    try {
      logger.debug(`Creating folder: ${folderName}`, 'IMAPService');

      // Create the mailbox
      const result = await this.client.mailboxCreate(folderName);

      // Clear folder cache to refresh
      this.folderCache.clear();

      logger.info(`Folder created: ${folderName}`, 'IMAPService');
      return true;
    } catch (error: any) {
      if (error.responseText?.includes('ALREADYEXISTS')) {
        logger.warn(`Folder already exists: ${folderName}`, 'IMAPService');
        throw new Error(`Folder '${folderName}' already exists`);
      }
      logger.error('Failed to create folder', 'IMAPService', error);
      throw error;
    }
  }

  /**
   * Delete a folder (must be empty)
   */
  async deleteFolder(folderName: string): Promise<boolean> {
    this.validateFolderName(folderName);
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    // Prevent deletion of system folders
    const protectedFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive', 'All Mail'];
    if (protectedFolders.some(f => folderName.toLowerCase() === f.toLowerCase())) {
      throw new Error(`Cannot delete protected folder: ${folderName}`);
    }

    try {
      logger.debug(`Deleting folder: ${folderName}`, 'IMAPService');

      await this.client.mailboxDelete(folderName);

      // Clear folder cache to refresh
      this.folderCache.clear();

      logger.info(`Folder deleted: ${folderName}`, 'IMAPService');
      return true;
    } catch (error: any) {
      if (error.responseText?.includes('NONEXISTENT')) {
        throw new Error(`Folder '${folderName}' does not exist`);
      }
      if (error.responseText?.includes('HASCHILDREN') || error.responseText?.includes('not empty')) {
        throw new Error(`Folder '${folderName}' is not empty. Move or delete emails first.`);
      }
      logger.error('Failed to delete folder', 'IMAPService', error);
      throw error;
    }
  }

  /**
   * Rename a folder
   */
  async renameFolder(oldName: string, newName: string): Promise<boolean> {
    this.validateFolderName(oldName);
    this.validateFolderName(newName);
    if (!this.isConnected || !this.client) {
      throw new Error('IMAP client not connected');
    }

    // Prevent renaming of system folders
    const protectedFolders = ['INBOX', 'Sent', 'Drafts', 'Trash', 'Spam', 'Archive', 'All Mail'];
    if (protectedFolders.some(f => oldName.toLowerCase() === f.toLowerCase())) {
      throw new Error(`Cannot rename protected folder: ${oldName}`);
    }

    try {
      logger.debug(`Renaming folder: ${oldName} -> ${newName}`, 'IMAPService');

      await this.client.mailboxRename(oldName, newName);

      // Clear folder cache to refresh
      this.folderCache.clear();

      logger.info(`Folder renamed: ${oldName} -> ${newName}`, 'IMAPService');
      return true;
    } catch (error: any) {
      if (error.responseText?.includes('NONEXISTENT')) {
        throw new Error(`Folder '${oldName}' does not exist`);
      }
      if (error.responseText?.includes('ALREADYEXISTS')) {
        throw new Error(`Folder '${newName}' already exists`);
      }
      logger.error('Failed to rename folder', 'IMAPService', error);
      throw error;
    }
  }

  clearCache(): void {
    this.emailCache.clear();
    this.folderCache.clear();
    logger.info('IMAP cache cleared', 'IMAPService');
  }

  /** Securely wipe all cached data and stored credentials from memory. */
  wipeCache(): void {
    // Overwrite email bodies/subjects before clearing
    for (const [, email] of this.emailCache) {
      if (email.body) email.body = "";
      if (email.subject) email.subject = "";
      if (email.from) email.from = "";
      if (email.attachments) {
        for (const att of email.attachments) {
          if (att.content && Buffer.isBuffer(att.content)) {
            (att.content as Buffer).fill(0);
          }
          (att as any).content = undefined;
        }
      }
    }
    this.emailCache.clear();
    this.folderCache.clear();

    // Wipe stored connection credentials
    if (this.connectionConfig) {
      if (this.connectionConfig.password) this.connectionConfig.password = "";
      if (this.connectionConfig.username) this.connectionConfig.username = "";
      this.connectionConfig = null;
    }
    logger.info("IMAP cache and credentials wiped", "IMAPService");
  }
}
