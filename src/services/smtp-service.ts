/**
 * SMTP Service for sending emails via Proton Mail (through Proton Bridge or
 * direct submission).
 */

import nodemailer from "nodemailer";
import { readFileSync, statSync } from "fs";
import { join as pathJoin } from "path";
import { ProtonMailConfig, SendEmailOptions } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { parseEmails, isValidEmail } from "../utils/helpers.js";
import { tracer } from "../utils/tracer.js";
import { BackoffTracker, isTransientAbuseError } from "../utils/backoff.js";

/**
 * Strip CRLF and null bytes from a header-like string value to prevent
 * header injection.  Used for Message-ID style fields (inReplyTo, references).
 */
function stripHeaderInjection(s: string): string {
  return s.replace(/[\r\n\x00]/g, "");
}

/** Escape special HTML characters to prevent injection in email bodies */
function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Header keys that must never be overridden via caller-supplied headers */
const BLOCKED_HEADER_KEYS = /^(to|cc|bcc|from|return-path|reply-to|sender)$/i;

/** Attachment limits — prevents OOM / DoS via oversized email payloads. */
const MAX_ATTACHMENTS       = 20;
const MAX_ATTACHMENT_BYTES  = 25 * 1024 * 1024; // 25 MB per file (matches Proton limit)
const MAX_TOTAL_ATT_BYTES   = 25 * 1024 * 1024; // 25 MB total across all attachments

export class SMTPService {
  private transporter: nodemailer.Transporter | null = null;
  private config: ProtonMailConfig;
  /** True when TLS certificate validation is disabled (no Bridge cert configured). */
  insecureTls = false;
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

    // Check if using localhost (Proton Bridge)
    const isLocalhost =
      this.config.smtp.host === "localhost" ||
      this.config.smtp.host === "127.0.0.1";

    // Prefer SMTP token over password for direct (non-Bridge) connections
    const authPassword = !isLocalhost && this.config.smtp.smtpToken
      ? this.config.smtp.smtpToken
      : this.config.smtp.password;

    // Env-var priority: MAILPOUCH_* > PM_BRIDGE_MCP_* > PROTONMAIL_MCP_*. Legacy
    // names honored through v3.0.
    const allowInsecure =
      this.config.smtp.allowInsecureBridge === true ||
      process.env.MAILPOUCH_INSECURE_BRIDGE === "1" ||
      process.env.PM_BRIDGE_MCP_INSECURE_BRIDGE === "1" ||
      process.env.PROTONMAIL_MCP_INSECURE_BRIDGE === "1";

    // Build TLS options based on connection type
    let tlsOptions: Record<string, unknown>;
    if (isLocalhost) {
      const certPath = this.config.smtp.bridgeCertPath;
      if (certPath) {
        // If a directory was given, look for cert.pem inside it
        let resolvedCertPath = certPath;
        try {
          if (statSync(certPath).isDirectory()) {
            resolvedCertPath = pathJoin(certPath, "cert.pem");
            logger.info(`SMTP: Directory given for cert path — resolved to ${resolvedCertPath}`, "SMTPService");
          }
        } catch { /* stat failed — let readFileSync produce the real error below */ }
        // Load the exported Bridge certificate — proper trust without disabling validation
        try {
          const bridgeCert = readFileSync(resolvedCertPath);
          tlsOptions = {
            ca: [bridgeCert],
            minVersion: "TLSv1.2",
            checkServerIdentity: () => undefined,
          };
          logger.info(`SMTP: Using exported Bridge certificate for TLS trust (${resolvedCertPath})`, "SMTPService");
        } catch (err: unknown) {
          if (!allowInsecure) {
            throw new Error(
              `SMTP: Bridge cert at "${resolvedCertPath}" could not be loaded and allowInsecureBridge is not set. ` +
              `Fix the cert path in Settings → Connection, or set allowInsecureBridge: true ` +
              `(or MAILPOUCH_INSECURE_BRIDGE=1) to opt into the legacy insecure behavior. ` +
              `Underlying error: ${(err as Error).message}`
            );
          }
          logger.warn(
            `SMTP: Failed to load Bridge cert at "${resolvedCertPath}" — running with TLS validation DISABLED (allowInsecureBridge is set). ` +
            "Export a fresh cert from Bridge → Help → Export TLS Certificate and update Settings → Connection to re-secure.",
            "SMTPService",
            err
          );
          tlsOptions = { rejectUnauthorized: false, minVersion: "TLSv1.2" };
          this.insecureTls = true;
        }
      } else if (this.config.smtp.username) {
        // Credentials are loaded — this is a real connection attempt.
        if (!allowInsecure) {
          throw new Error(
            "SMTP: No Bridge certificate configured. Export the cert from Bridge → Help → Export TLS Certificate " +
            "and set 'bridgeCertPath' in Settings → Connection. To opt into the legacy behavior (TLS validation " +
            "disabled for localhost), set allowInsecureBridge: true or launch with MAILPOUCH_INSECURE_BRIDGE=1."
          );
        }
        logger.warn(
          "SMTP: No Bridge certificate configured and allowInsecureBridge is set — " +
          "TLS certificate validation DISABLED for localhost. Export the cert from Bridge → Help → " +
          "Export TLS Certificate and clear the insecure flag to re-secure.",
          "SMTPService"
        );
        tlsOptions = { rejectUnauthorized: false, minVersion: "TLSv1.2" };
        this.insecureTls = true;
      } else {
        // Pre-config constructor call — credentials haven't loaded yet. Skip the hard
        // check until reinitialize() runs after main() populates the config.
        logger.debug("SMTP: transporter pre-initialized (no config loaded yet — reinitialize() will be called after config loads)", "SMTPService");
        tlsOptions = { rejectUnauthorized: false, minVersion: "TLSv1.2" };
        this.insecureTls = true;
      }
    } else {
      // Non-localhost: full certificate validation required
      tlsOptions = { minVersion: "TLSv1.2" };
    }

    this.transporter = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: {
        user: this.config.smtp.username,
        pass: authPassword,
      },
      requireTLS: isLocalhost,
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

    // Parse and validate recipients
    const toAddresses = Array.isArray(options.to)
      ? options.to
      : parseEmails(options.to);
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
      const mailOptions: nodemailer.SendMailOptions = {
        from: this.config.smtp.username,
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
        // Enforce count cap
        if (options.attachments.length > MAX_ATTACHMENTS) {
          throw new Error(
            `Too many attachments: ${options.attachments.length} supplied, max ${MAX_ATTACHMENTS} allowed.`
          );
        }

        // Enforce per-file and total size caps.
        // att.content may be a base64 string, Buffer, or Readable — only string/Buffer are
        // trivially sizable; Readable streams are rejected to prevent unbounded streaming.
        let totalBytes = 0;
        for (const att of options.attachments) {
          const content = att.content;
          let bytes: number;
          if (Buffer.isBuffer(content)) {
            bytes = content.length;
          } else if (typeof content === "string") {
            // base64 string: actual binary size ≈ str.length * 0.75
            bytes = Math.ceil(content.length * 0.75);
          } else {
            throw new Error(
              `Attachment '${att.filename ?? "unnamed"}': content must be a Buffer or base64 string, not a stream.`
            );
          }
          if (bytes > MAX_ATTACHMENT_BYTES) {
            throw new Error(
              `Attachment '${att.filename ?? "unnamed"}' is too large: ` +
              `${Math.round(bytes / 1024 / 1024)}MB exceeds the ${MAX_ATTACHMENT_BYTES / 1024 / 1024}MB per-file limit.`
            );
          }
          totalBytes += bytes;
          if (totalBytes > MAX_TOTAL_ATT_BYTES) {
            throw new Error(
              `Total attachment size exceeds the ${MAX_TOTAL_ATT_BYTES / 1024 / 1024}MB limit.`
            );
          }
        }

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
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
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
