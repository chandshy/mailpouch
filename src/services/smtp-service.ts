/**
 * SMTP Service for sending emails via Proton Mail (through Proton Bridge or
 * direct submission).
 */

import nodemailer from "nodemailer";
import { ProtonMailConfig, SendEmailOptions } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { buildBridgeTlsConfig } from "./bridge-tls.js";
import { parseEmails, parseEmailsDetailed, isValidEmail, sanitizeForLog, validateAttachmentLimits } from "../utils/helpers.js";
import { tracer } from "../utils/tracer.js";
import { classifyError } from "../utils/error-classify.js";
import { BackoffTracker, isTransientAbuseError } from "../utils/backoff.js";

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

  private initializeTransporter(): void {
    logger.debug("Initializing SMTP transporter", "SMTPService");
    // Close any existing transporter before replacing it — reinitialize()
    // runs on every config update (AccountManager.rebuildFromRegistry, the
    // settings UI save path, etc.) and nodemailer holds a connection pool
    // internally. Skipping close() here would leak sockets + file
    // descriptors on every save. Best-effort: swallow close errors so a
    // dead transporter can't block re-init.
    if (this.transporter) {
      try { this.transporter.close(); } catch { /* already dead — ignore */ }
    }
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
    this.transporter = nodemailer.createTransport({
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

      const info = await this.transporter.sendMail(mailOptions);

      logger.info("Email sent successfully", "SMTPService", {
        messageId: info.messageId,
      });

      this.backoff.record("success");
      return {
        success: true,
        messageId: info.messageId,
      };
    } catch (error: unknown) {
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
    if (this.transporter) {
      logger.debug("Closing SMTP transporter", "SMTPService");
      this.transporter.close();
      this.transporter = null;
      logger.info("SMTP transporter closed", "SMTPService");
    }
    }); // end tracer.span('smtp.close')
  }

  /** Securely wipe credential strings from memory. */
  wipeCredentials(): void {
    if (this.config?.smtp) {
      if (this.config.smtp.password) this.config.smtp.password = "";
      if (this.config.smtp.smtpToken) this.config.smtp.smtpToken = "";
      if (this.config.smtp.username) this.config.smtp.username = "";
    }
    if (this.transporter) {
      this.transporter.close();
      this.transporter = null;
    }
    logger.info("SMTP credentials wiped from memory", "SMTPService");
  }
}
