/**
 * SMTP Service for sending emails via Proton Mail (through Proton Bridge or
 * direct submission).
 */

import { Socket } from "node:net";
import nodemailer from "nodemailer";
import { ProtonMailConfig, SendEmailOptions } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { buildBridgeTlsConfig } from "./bridge-tls.js";
import { parseEmails, parseEmailsDetailed, isValidEmail, sanitizeForLog, validateAttachmentLimits } from "../utils/helpers.js";
import { tracer } from "../utils/tracer.js";
import { classifyError } from "../utils/error-classify.js";
import { BackoffTracker, isTransientAbuseError } from "../utils/backoff.js";
import {
  MailboxMutationDeadlineError,
  runAccountMailMutation,
} from "./mailbox-mutation-deadline.js";

/**
 * Nodemailer's default SMTP pool concurrency. Keeping the same bounded
 * parallelism avoids serializing independent sends while maxMessages=1
 * preserves the previous one-message-per-connection lifecycle.
 */
const SMTP_POOL_MAX_CONNECTIONS = 5;
const SMTP_CONNECTION_TIMEOUT_MS = 30_000;
const SMTP_GREETING_TIMEOUT_MS = 30_000;
const SMTP_SOCKET_TIMEOUT_MS = 45_000;

interface DestroyableSocket {
  destroyed?: boolean;
  destroy(): void;
}

interface SmtpConnectionInternals {
  _socket?: DestroyableSocket | { socket?: DestroyableSocket } | false;
  close?: () => void;
}

interface SmtpPoolResourceInternals {
  connection?: SmtpConnectionInternals | false;
  close?: () => void;
}

interface SmtpPoolInternals {
  _connections?: unknown;
}

interface PooledTransporterInternals {
  transporter?: SmtpPoolInternals;
}

interface PendingSmtpSocketAttempt {
  generation: number;
  invalidate: (error: Error) => void;
}

function getDestroyableSocket(value: unknown): DestroyableSocket | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as { socket?: unknown }).socket ?? value;
  if (!candidate || typeof candidate !== "object") return null;
  return typeof (candidate as { destroy?: unknown }).destroy === "function"
    ? candidate as DestroyableSocket
    : null;
}

/**
 * Strip CRLF and null bytes from a header-like string value to prevent
 * header injection.  Used for Message-ID style fields (inReplyTo, references).
 */
function stripHeaderInjection(s: string): string {
  return s.replace(/[\r\n\x00]/g, "");
}

/** Escape special HTML characters to prevent injection in email bodies */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Header keys that must never be overridden via caller-supplied headers */
const BLOCKED_HEADER_KEYS = /^(to|cc|bcc|from|return-path|reply-to|sender)$/i;

// Attachment count/size caps live in helpers.ts (validateAttachmentLimits),
// shared with the IMAP saveDraft path.

export class SMTPService {
  private transporter: nodemailer.Transporter | null = null;
  /** Raw sockets are tracked before Nodemailer creates a PoolResource connection. */
  private readonly smtpSockets = new Set<Socket>();
  /** Connecting callbacks that must be failed synchronously on retirement. */
  private readonly pendingSmtpSocketAttempts = new Map<Socket, PendingSmtpSocketAttempt>();
  /** Invalidates getSocket closures and completions belonging to an old pool. */
  private transportGeneration = 0;
  private config: ProtonMailConfig;
  /** True when TLS certificate validation is disabled (no Bridge cert configured). */
  insecureTls = false;
  /**
   * Actionable initialization error, or null on successful init. Populated
   * when the configured Bridge cert path cannot be loaded AND the user has
   * not opted into insecure mode. Construction itself NEVER throws — a
   * synchronous throw here would kill the MCP server at module load (stdio
   * servers have no chance to report structured errors to the client
   * before the transport comes up), so we defer the failure to the first
   * sendEmail() / verifyConnection() call where the error can propagate
   * back through the MCP response. reinitialize() clears this.
   */
  initError: string | null = null;
  /**
   * Tracks consecutive abuse-signal failures (SMTP 421/450/454 etc.) and
   * holds back sends during the exponential-backoff window. Surfaced via
   * getBackoffState() so get_connection_status can report throttling to
   * the agent rather than letting it keep hammering.
   */
  readonly backoff = new BackoffTracker();

  constructor(config: ProtonMailConfig) {
    this.config = config;
    this.initializeTransporter();
  }

  /**
   * Open and retain authority over the raw socket during DNS/connect. Once
   * connected, Nodemailer receives it as an already-open connection and owns
   * SMTP/STARTTLS setup; the close listener keeps our tracking set accurate.
   */
  private openTrackedSocket(
    options: { host?: string; port?: number; localAddress?: string },
    callback: (error: Error | null, socketOptions?: { connection: Socket }) => void,
    generation: number,
  ): void {
    if (generation !== this.transportGeneration) {
      callback(new Error("SMTP transport was retired before socket creation"));
      return;
    }
    const host = options.host;
    const port = options.port;
    if (!host || !Number.isInteger(port) || (port ?? 0) < 1 || (port ?? 0) > 65_535) {
      callback(new Error("SMTP socket requires a valid host and port"));
      return;
    }

    const socket = new Socket();
    this.smtpSockets.add(socket);
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const removePreconnectListeners = () => {
      socket.removeListener("connect", onConnect);
      socket.removeListener("error", onError);
      if (timer) clearTimeout(timer);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      removePreconnectListeners();
      this.pendingSmtpSocketAttempts.delete(socket);
      callback(error);
    };
    const onConnect = () => {
      if (settled) return;
      if (generation !== this.transportGeneration) {
        try { fail(new Error("SMTP transport was retired while connecting")); }
        finally { socket.destroy(); }
        return;
      }
      settled = true;
      removePreconnectListeners();
      this.pendingSmtpSocketAttempts.delete(socket);
      callback(null, { connection: socket });
    };
    const onError = (error: Error) => { fail(error); };
    socket.once("connect", onConnect);
    socket.once("error", onError);
    socket.once("close", () => {
      this.smtpSockets.delete(socket);
      fail(new Error("SMTP socket closed before connection completed"));
    });
    this.pendingSmtpSocketAttempts.set(socket, { generation, invalidate: fail });

    timer = setTimeout(() => {
      try { fail(new Error("SMTP connection timeout")); }
      finally { socket.destroy(); }
    }, SMTP_CONNECTION_TIMEOUT_MS);
    timer.unref?.();

    try {
      socket.connect({
        host,
        port: port!,
        ...(options.localAddress ? { localAddress: options.localAddress } : {}),
      });
    } catch (error) {
      try { fail(error instanceof Error ? error : new Error(String(error))); }
      finally { socket.destroy(); }
    }
  }

  /**
   * Detach one transporter generation and synchronously revoke every socket it
   * could still use. The generation bump also rejects delayed getSocket calls
   * from the retired Nodemailer pool before they allocate a new socket.
   */
  private hardRetireTransport(reason: string): { hadTransporter: boolean; errors: unknown[] } {
    const transporter = this.transporter;
    const hadTransporter = transporter !== null;
    this.transporter = null;
    this.transportGeneration += 1;

    const errors: unknown[] = [];
    const pool = transporter
      ? (transporter as unknown as PooledTransporterInternals).transporter
      : undefined;
    const liveResources = pool?._connections;
    const resources = transporter && Array.isArray(liveResources)
      ? [...liveResources]
      : null;
    if (transporter && !resources) {
      errors.push(new Error(
        "Nodemailer SMTP pool internals are unavailable; active socket closure could not be verified",
      ));
    }

    if (hadTransporter || this.smtpSockets.size > 0 || this.pendingSmtpSocketAttempts.size > 0) {
      logger.warn(`Hard-retiring SMTP transport: ${reason}`, "SMTPService");
    }

    const retirementError = new Error(`SMTP transport retired: ${reason}`);
    for (const attempt of [...this.pendingSmtpSocketAttempts.values()]) {
      try { attempt.invalidate(retirementError); }
      catch (error) { errors.push(error); }
    }

    // Collect both raw pre-connect sockets and the active TLS/socket wrappers
    // exposed through Nodemailer's pinned pool internals. Destroy each physical
    // object once before asking PoolResource/Transporter to close gracefully.
    const sockets = new Set<DestroyableSocket>(this.smtpSockets);
    if (resources) {
      for (const [index, entry] of resources.entries()) {
        const resource = entry as SmtpPoolResourceInternals | null;
        if (!resource || typeof resource !== "object") {
          errors.push(new Error(`Nodemailer SMTP pool resource ${index} is unavailable`));
          continue;
        }
        const connection = resource.connection;
        if (!connection || typeof connection !== "object") {
          errors.push(new Error(
            `Nodemailer SMTP pool resource ${index} has no active SMTPConnection to hard-close`,
          ));
        } else {
          const socket = getDestroyableSocket(connection._socket);
          if (socket) sockets.add(socket);
          else {
            errors.push(new Error(
              `Nodemailer SMTP pool resource ${index} has no destroyable active socket`,
            ));
          }
          if (typeof connection.close !== "function") {
            errors.push(new Error(
              `Nodemailer SMTP pool resource ${index} has no SMTPConnection.close()`,
            ));
          }
        }
      }
    }

    for (const socket of sockets) {
      try { socket.destroy(); }
      catch (error) { errors.push(error); }
    }

    if (resources) {
      for (const [index, entry] of resources.entries()) {
        const resource = entry as SmtpPoolResourceInternals | null;
        if (!resource || typeof resource !== "object") continue;
        if (typeof resource.close !== "function") {
          errors.push(new Error(
            `Nodemailer SMTP pool resource ${index} has no PoolResource.close()`,
          ));
        } else {
          try { resource.close(); }
          catch (error) { errors.push(error); }
        }
      }
    }

    if (transporter) {
      try { transporter.close(); }
      catch (error) { errors.push(error); }
    }
    return { hadTransporter, errors };
  }

  private createTransporter(): void {
    logger.debug("Initializing SMTP transporter", "SMTPService");
    // Reset degraded state so reinitialize() after the user fixes config
    // clears any prior deferred failure.
    this.initError = null;
    this.transporter = null;
    this.insecureTls = false;

    // Check if using localhost (Proton Bridge). Include IPv6 loopback ::1 to
    // match the IMAP path + buildBridgeTlsConfig — otherwise host "::1" falls
    // through to full-validation TLS against Bridge's self-signed cert and fails.
    const isLocalhost =
      this.config.smtp.host === "localhost" ||
      this.config.smtp.host === "127.0.0.1" ||
      this.config.smtp.host === "::1";

    // Prefer SMTP token over password for direct (non-Bridge) connections
    const authPassword = !isLocalhost && this.config.smtp.smtpToken
      ? this.config.smtp.smtpToken
      : this.config.smtp.password;

    const allowInsecure =
      this.config.smtp.allowInsecureBridge === true ||
      process.env.MAILPOUCH_INSECURE_BRIDGE === "1";

    // TLS config via the SHARED bridge-tls decision (same as the IMAP path) so the
    // pinned-cert / insecure-fallback contract can't diverge between transports.
    // SMTP keeps its deferred-init semantics: a secure-config-impossible error is
    // stashed (not thrown) so the MCP server stays up and sendEmail() surfaces it.
    let tlsOptions: Record<string, unknown>;
    if (isLocalhost && !this.config.smtp.bridgeCertPath && !this.config.smtp.username) {
      // Pre-config constructor call — credentials haven't loaded yet. Soft insecure;
      // reinitialize() runs the real check once main() populates the config.
      logger.debug("SMTP: transporter pre-initialized (no config loaded yet — reinitialize() will be called after config loads)", "SMTPService");
      tlsOptions = { rejectUnauthorized: false, minVersion: "TLSv1.2" };
      this.insecureTls = true;
    } else {
      try {
        const cfg = buildBridgeTlsConfig(this.config.smtp.host, this.config.smtp.bridgeCertPath, allowInsecure);
        tlsOptions = cfg.tlsOptions;
        this.insecureTls = cfg.insecure;
        for (const l of cfg.logs) logger[l.level](`SMTP: ${l.msg}`, "SMTPService");
      } catch (err: unknown) {
        // Deferred failure: stash the actionable message, keep the server up.
        this.initError = `SMTP: ${err instanceof Error ? err.message : String(err)}`;
        logger.warn(
          `SMTP init deferred: ${this.initError} ` +
          "Send attempts will fail with this message until the user fixes the config and reinitialize() runs.",
          "SMTPService",
        );
        return;
      }
    }

    // requireTLS forces nodemailer to issue STARTTLS and reject the
    // connection if the server doesn't advertise it. For real Bridge this
    // is always correct (Bridge advertises STARTTLS on its localhost
    // socket). The Greenmail E2E harness's embedded SMTP server does NOT
    // advertise STARTTLS, so the no-STARTTLS path is gated on a dedicated,
    // test-only signal — `MAILPOUCH_SMTP_ALLOW_PLAINTEXT=1` — NOT on
    // `allowInsecureBridge`. Critical distinction (Copilot review on #146):
    // `allowInsecureBridge` is a *production* opt-in that disables cert
    // PINNING for localhost while STILL requiring STARTTLS encryption.
    // Overloading it to also drop requireTLS would silently downgrade a
    // real insecure-cert deployment to plaintext send. Keeping the two
    // concerns on separate switches means production insecure-cert mode
    // keeps its encrypted-transport guarantee; only the explicit
    // E2E-plaintext env (which no real deployment sets) relaxes STARTTLS.
    const allowPlaintextSmtp = process.env.MAILPOUCH_SMTP_ALLOW_PLAINTEXT === "1";
    const generation = this.transportGeneration;
    this.transporter = nodemailer.createTransport({
      pool: true,
      maxConnections: SMTP_POOL_MAX_CONNECTIONS,
      maxMessages: 1,
      // Match the former non-pooled transport: an ambiguous connection close
      // must never cause Nodemailer to resend the same message automatically.
      // Nodemailer 9 supports this option although @types/nodemailer omits it.
      ...({ maxRequeues: 0 } as const),
      // SMTP-local defense in depth. The request coordinator still owns the
      // shorter absolute mutation deadline and hard cancellation semantics.
      connectionTimeout: SMTP_CONNECTION_TIMEOUT_MS,
      greetingTimeout: SMTP_GREETING_TIMEOUT_MS,
      socketTimeout: SMTP_SOCKET_TIMEOUT_MS,
      getSocket: (options, callback) => { this.openTrackedSocket(options, callback, generation); },
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.username,
        pass: authPassword,
      },
      requireTLS: isLocalhost && !allowPlaintextSmtp,
      tls: tlsOptions,
    });

    logger.info("SMTP transporter initialized", "SMTPService");
  }

  /** Replace the current pool only after its complete authority is revoked. */
  private initializeTransporter(): void {
    const retired = this.hardRetireTransport("transporter initialization/replacement");
    try {
      this.createTransporter();
    } catch (error) {
      retired.errors.push(error);
    }
    if (retired.errors.length > 0) {
      throw new AggregateError(retired.errors, "SMTP transport replacement did not hard-close cleanly");
    }
  }

  /**
   * Rebuild the transporter using the current config values.
   * Call this after credentials or cert path have been loaded into config
   * (i.e. after main() has populated smtp.password and smtp.bridgeCertPath).
   */
  reinitialize(): void {
    this.initializeTransporter();
  }

  /** Verify the SMTP transporter can authenticate with the Bridge. Returns true on success. */
  async verifyConnection(): Promise<boolean> {
    return tracer.span('smtp.verifyConnection', {}, async () => {
    logger.debug("Verifying SMTP connection", "SMTPService");

    // Surface deferred-init errors first — more actionable than the generic
    // "transporter not initialized".
    if (this.initError) {
      throw new Error(this.initError);
    }
    if (!this.transporter) {
      throw new Error("SMTP transporter not initialized");
    }

    try {
      await this.transporter.verify();
      logger.info("SMTP connection verified successfully", "SMTPService");
      return true;
    } catch (error: unknown) {
      logger.error("SMTP connection verification failed", "SMTPService", error);
      throw error;
    }
    }); // end tracer.span('smtp.verifyConnection')
  }

  /**
   * Send an email via the Proton Bridge SMTP relay.
   * @param options Recipient(s), subject, body, attachments, and optional headers
   * @returns Object with success flag, SMTP messageId on success, or error string on failure
   */
  async sendEmail(
    options: SendEmailOptions
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    return tracer.span('smtp.sendEmail', {
      recipientCount: Array.isArray(options.to) ? options.to.length : (parseEmails(options.to as string)).length,
      hasCC: !!(options.cc?.length),
      hasBCC: !!(options.bcc?.length),
      hasAttachments: !!(options.attachments?.length),
      attachmentCount: options.attachments?.length || 0,
      estimatedBodyBytes: (options.body || '').length,
    }, async () => {
    logger.debug("Sending email", "SMTPService", {
      to: options.to,
      subject: options.subject,
    });

    // Surface deferred-init errors first (cert missing, unreadable, etc.)
    // — far more actionable than the generic "transporter not initialized".
    if (this.initError) {
      throw new Error(this.initError);
    }
    if (!this.transporter) {
      throw new Error("SMTP transporter not initialized");
    }

    // Abuse-signal backoff gate — if a prior send tripped a 4xx throttle
    // response, hold this one until the exponential-backoff window elapses.
    if (this.backoff.isBlocked()) {
      const waitMs = this.backoff.delayUntilMs();
      logger.warn(
        `SMTP: send is in abuse-signal backoff (${this.backoff.failureCount} consecutive failures, ${waitMs} ms remaining). Skipping.`,
        "SMTPService"
      );
      return {
        success: false,
        error: `SMTP backoff active — ${waitMs} ms remaining after ${this.backoff.failureCount} consecutive throttle responses. Wait or call reset to clear.`,
      };
    }

    // Parse and validate recipients.
    // SMTP-014: for the primary `to` field, hard-fail on partial drops so a
    // typo'd address can't silently shrink the recipient set (especially for
    // scheduled sends, which surface the failure 60+s after the user asked).
    let toAddresses: string[];
    if (Array.isArray(options.to)) {
      toAddresses = options.to;
    } else {
      const parsedTo = parseEmailsDetailed(options.to);
      if (parsedTo.dropped.length > 0) {
        // Sanitize the rejected (caller-controlled) values before interpolating —
        // this error is logged/persisted, so raw newlines/control chars would
        // allow log injection.
        const shown = parsedTo.dropped.map(d => sanitizeForLog(d, 60)).join(", ");
        throw new Error(
          `Invalid recipient address(es) in "to": ${shown}. Fix or remove them and retry.`,
        );
      }
      toAddresses = parsedTo.valid;
    }
    const ccAddresses = options.cc
      ? Array.isArray(options.cc)
        ? options.cc
        : parseEmails(options.cc)
      : [];
    const bccAddresses = options.bcc
      ? Array.isArray(options.bcc)
        ? options.bcc
        : parseEmails(options.bcc)
      : [];

    // Validate at least one recipient
    if (toAddresses.length === 0) {
      throw new Error("At least one recipient is required");
    }

    // Cap total recipient count to prevent spam amplification / DoS.
    // Proton Bridge itself enforces SMTP limits; this is defence-in-depth.
    const MAX_RECIPIENTS = 50;
    const allAddresses = [...toAddresses, ...ccAddresses, ...bccAddresses];
    if (allAddresses.length > MAX_RECIPIENTS) {
      throw new Error(
        `Too many recipients: ${allAddresses.length} supplied, max ${MAX_RECIPIENTS} allowed (To + CC + BCC combined).`
      );
    }

    // Validate all email addresses
    for (const email of allAddresses) {
      if (!isValidEmail(email)) {
        throw new Error(`Invalid email address: ${email}`);
      }
    }

    let dispatchedTransportGeneration: number | undefined;
    try {
      // Real Proton Bridge always uses a full email as the SMTP username
      // (e.g. "chuck@protonmail.com"), so `from: username` is a valid address.
      // The Greenmail E2E harness, by contrast, provisions users with bare
      // logins ("alice"), so nodemailer would build `MAIL FROM:<>` and the
      // server rejects "503 MAIL must come before RCPT". When MAILPOUCH_SMTP_FROM
      // is set (only in the Greenmail E2E harness) it overrides the From
      // header AND the envelope sender. Production is unaffected — operators
      // never set this env var.
      const fromOverride = process.env.MAILPOUCH_SMTP_FROM?.trim();
      const fromAddress = fromOverride && isValidEmail(fromOverride)
        ? fromOverride
        : this.config.smtp.username;
      const mailOptions: nodemailer.SendMailOptions = {
        from: fromAddress,
        to: toAddresses.join(", "),
        // Strip CRLF/NUL to prevent header injection via a crafted subject line.
        // reply_to_email already strips these from fetched subjects; this covers
        // the direct send_email path where the agent supplies the subject directly.
        subject: stripHeaderInjection(options.subject),
        text: options.isHtml ? undefined : options.body,
        html: options.isHtml ? options.body : undefined,
      };

      if (ccAddresses.length > 0) {
        mailOptions.cc = ccAddresses.join(", ");
      }

      if (bccAddresses.length > 0) {
        mailOptions.bcc = bccAddresses.join(", ");
      }

      if (options.replyTo) {
        if (!isValidEmail(options.replyTo)) {
          throw new Error(`Invalid replyTo email address: ${options.replyTo}`);
        }
        mailOptions.replyTo = options.replyTo;
      }

      if (options.priority) {
        mailOptions.priority = options.priority;
      }

      if (options.inReplyTo) {
        // Strip CRLF/NUL to prevent header injection via a crafted Message-ID
        mailOptions.inReplyTo = stripHeaderInjection(options.inReplyTo);
      }

      if (options.references && options.references.length > 0) {
        // Strip CRLF/NUL from each reference before joining
        mailOptions.references = options.references.map(stripHeaderInjection).join(" ");
      }

      if (options.headers) {
        // Only allow safe custom headers — block routing/envelope headers to prevent injection.
        // Both the key and the value must be stripped of CRLF/NUL before the
        // block-list check: a key like "X-Foo\r\nBcc: evil@x.com" would otherwise
        // bypass the regex and inject a raw SMTP header line.
        const safeHeaders: Record<string, string> = {};
        for (const [rawKey, rawValue] of Object.entries(options.headers)) {
          // Strip CRLF and NUL from the key before testing against the blocklist.
          const key = stripHeaderInjection(rawKey).trim();
          if (!key) continue; // drop empty/whitespace-only keys
          if (BLOCKED_HEADER_KEYS.test(key)) {
            logger.warn(`SMTP: Blocked disallowed header '${key}'`, "SMTPService");
            continue;
          }
          // Strip CRLF and NUL from the value to prevent header injection via
          // a crafted value such as "harmless\r\nBcc: victim@evil.com".
          safeHeaders[key] = stripHeaderInjection(String(rawValue ?? ""));
        }
        if (Object.keys(safeHeaders).length > 0) {
          mailOptions.headers = safeHeaders;
        }
      }

      if (options.attachments && options.attachments.length > 0) {
        // Count + per-file + total size caps (shared with the IMAP saveDraft
        // path via validateAttachmentLimits — Readable streams are rejected
        // because they aren't trivially sizable).
        const limitErr = validateAttachmentLimits(options.attachments);
        if (limitErr) throw new Error(limitErr);

        mailOptions.attachments = options.attachments.map((att) => {
          // Strip CRLF and NUL from filename — a value like
          // "report.pdf\r\nContent-Type: text/html" would break the
          // Content-Disposition MIME header and inject a bogus part header.
          const safeFilename = att.filename
            ? stripHeaderInjection(att.filename).slice(0, 255) || "attachment"
            : undefined;

          // Strip CRLF from contentType to prevent MIME header injection.
          // Also reject the value if it doesn't look like a valid MIME type
          // (type/subtype) to avoid smuggling arbitrary header content.
          const rawCt = att.contentType ? stripHeaderInjection(att.contentType).trim() : undefined;
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

      // Capture the exact pooled transport being dispatched. A concurrent
      // cancellation replaces this.transporter, while the coordinator fences
      // this closure and hard-closes the captured transport's active socket.
      const transporter = this.transporter;
      if (!transporter) throw new Error("SMTP transporter not initialized");
      dispatchedTransportGeneration = this.transportGeneration;
      const info = await runAccountMailMutation(
        this,
        () => transporter.sendMail(mailOptions),
      );
      if (dispatchedTransportGeneration !== this.transportGeneration) {
        throw new MailboxMutationDeadlineError(
          "send_email",
          "shared transport cancellation",
          true,
        );
      }

      logger.info("Email sent successfully", "SMTPService", {
        messageId: info.messageId,
      });

      this.backoff.record("success");
      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error: unknown) {
      // The request coordinator owns cancellation/outcome reporting. Do not
      // downgrade its typed error into an ordinary SMTP delivery failure.
      if (error instanceof MailboxMutationDeadlineError) throw error;
      // Lifecycle replacement/wipe can hard-retire the captured pool without
      // being initiated by an MCP request. Once sendMail was dispatched, any
      // rejection from that retired generation is still ambiguous and must not
      // be converted into an ordinary retryable SMTP failure.
      if (dispatchedTransportGeneration !== undefined
          && dispatchedTransportGeneration !== this.transportGeneration) {
        throw new MailboxMutationDeadlineError(
          "send_email",
          "shared transport cancellation",
          true,
          error,
        );
      }
      if (isTransientAbuseError(error)) {
        this.backoff.record("abuse");
        logger.warn(
          `SMTP: send hit a throttle/abuse signal (${this.backoff.failureCount} consecutive). Backing off ${this.backoff.delayUntilMs()} ms.`,
          "SMTPService",
          error
        );
      } else {
        this.backoff.record("terminal");
        logger.error("Failed to send email", "SMTPService", error);
      }
      // Make a credential failure actionable: tell the user what to go fix
      // rather than relaying an opaque "Invalid login: 454 …" to the agent.
      const cls = classifyError(error);
      const actionable = cls.category === "auth"
        ? `mailpouch can't sign in to send mail — ${cls.message} ` +
          `Update the Bridge password in the mailpouch Settings UI → Connection, then restart mailpouch.`
        : error instanceof Error ? error.message : "Unknown error";
      return {
        success: false,
        error: actionable,
      };
    }
    }); // end tracer.span('smtp.sendEmail')
  }

  /**
   * Send a diagnostic test email to verify end-to-end SMTP delivery.
   * @param to Recipient email address (must be a valid RFC 5321 address)
   * @param customMessage Optional HTML body to use instead of the default test message
   * @returns Object with success flag, SMTP messageId on success, or error string on failure
   */
  async sendTestEmail(
    to: string,
    customMessage?: string
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    logger.debug("Sending test email", "SMTPService", { to });

    const subject = "Test Email from mailpouch";
    const body =
      customMessage ||
      `
      <h2>Test Email Successful</h2>
      <p>This is a test email from the mailpouch server.</p>
      <p><strong>Timestamp:</strong> ${new Date().toISOString()}</p>
      <p><strong>From:</strong> ${escapeHtml(this.config.smtp.username)}</p>
      <p>If you received this email, your SMTP configuration is working correctly.</p>
      <hr>
    `;

    return this.sendEmail({
      to,
      subject,
      body,
      isHtml: true,
    });
  }

  /** Close and release the SMTP transporter connection pool. */
  async close(): Promise<void> {
    return tracer.span('smtp.close', {}, async () => {
    const hadAuthority = this.transporter !== null
      || this.smtpSockets.size > 0
      || this.pendingSmtpSocketAttempts.size > 0;
    const retired = this.hardRetireTransport("service close");
    if (hadAuthority) {
      logger.info("SMTP transporter closed", "SMTPService");
    }
    if (retired.errors.length > 0) {
      throw new AggregateError(retired.errors, "SMTP transport did not hard-close cleanly");
    }
    }); // end tracer.span('smtp.close')
  }

  /**
   * Hard-stop a cancelled/timed-out SMTP send and replace the transporter so a
   * later request does not inherit the poisoned socket. This is synchronous:
   * the request deadline must not await a graceful close on a wedged command.
   */
  abortActiveMutationTransport(reason: string): void {
    logger.warn(`Aborting SMTP transport: ${reason}`, "SMTPService");
    const retired = this.hardRetireTransport(reason);
    // A fresh transporter is safe for a later request; the abandoned send
    // holds its own reference to the closed predecessor.
    if (retired.hadTransporter) {
      try { this.createTransporter(); }
      catch (error) { retired.errors.push(error); }
    }
    if (retired.errors.length > 0) {
      throw new AggregateError(retired.errors, "SMTP transport did not hard-close cleanly");
    }
  }

  /** Securely wipe credential strings from memory. */
  wipeCredentials(): void {
    const retired = this.hardRetireTransport("credential wipe");
    if (this.config?.smtp) {
      if (this.config.smtp.password) this.config.smtp.password = "";
      if (this.config.smtp.smtpToken) this.config.smtp.smtpToken = "";
      if (this.config.smtp.username) this.config.smtp.username = "";
    }
    logger.info("SMTP credentials wiped from memory", "SMTPService");
    if (retired.errors.length > 0) {
      throw new AggregateError(retired.errors, "SMTP transport did not hard-close cleanly during credential wipe");
    }
  }
}
