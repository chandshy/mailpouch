/**
 * Sending tools: send_email, reply_to_email, forward_email, send_test_email.
 *
 * Unrestricted callers retain the pre-refactor behavior. Folder-restricted
 * callers must identify an allowlisted source mailbox before a reply/forward
 * reads a UID or mutates its IMAP flags, because UIDs are mailbox-local.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isValidEmail, optionalFolderHint, validateAttachments, sanitizeAttachments, requireNumericEmailId } from "../utils/helpers.js";
import { logger } from "../utils/logger.js";
import { escapeHtml } from "../services/smtp-service.js";
import type { ToolDef, ToolHandler, ToolModule } from "./types.js";

const ACTION_RESULT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    messageId: { type: "string" },
    reason: { type: "string" },
  },
  required: ["success"],
};

function requireReplyOrForwardSourceFolder(
  ctx: Parameters<ToolHandler>[0],
  folder: string | undefined,
  operation: string,
): void {
  const allowedFolders = ctx.getCallerAllowedFolders?.();
  if (allowedFolders === undefined) return;
  if (!folder) {
    // UIDs are mailbox-local. A folderless lookup scans mailboxes and could
    // resolve an identically numbered message outside the grant's scope.
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} requires an explicit source folder for a folder-restricted caller.`,
    );
  }
  if (!allowedFolders.some(candidate => candidate.toLowerCase() === folder.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: source folder '${folder}' is outside this agent's folder allowlist.`,
    );
  }
}

function requireFetchedSourceFolder(
  ctx: Parameters<ToolHandler>[0],
  resolvedFolder: string | undefined,
  requestedFolder: string | undefined,
  operation: string,
): void {
  const allowedFolders = ctx.getCallerAllowedFolders?.();
  if (allowedFolders === undefined) return;
  if (!resolvedFolder || !allowedFolders.some(candidate => candidate.toLowerCase() === resolvedFolder.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} resolved an email outside this agent's folder allowlist.`,
    );
  }
  // The IMAP adapter is expected to honor the explicit source hint. Treat a
  // disagreement as unsafe even when both folders happen to be allowed: the
  // UID belongs to the resolved mailbox, not necessarily the one requested.
  if (!requestedFolder || resolvedFolder.toLowerCase() !== requestedFolder.toLowerCase()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} resolved an email from '${resolvedFolder}' rather than the requested source folder '${requestedFolder ?? "(missing)"}'.`,
    );
  }
}

export const defs: ToolDef[] = [
  {
    name: "send_email",
    title: "Send Email",
    description:
      "Send an email via Proton Mail SMTP (through Proton Bridge). Supports To/CC/BCC (comma-separated), plain text or HTML body, priority (high/normal/low), reply-to, and base64-encoded attachments. Returns messageId on success.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address(es), comma-separated" },
        cc: { type: "string", description: "CC addresses, comma-separated" },
        bcc: { type: "string", description: "BCC addresses, comma-separated" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text or HTML)" },
        isHtml: { type: "boolean", description: "Set true if body is HTML", default: false },
        priority: {
          type: "string",
          enum: ["high", "normal", "low"],
          description: "Message priority header",
        },
        replyTo: { type: "string", description: "Reply-to address (must be valid email)" },
        attachments: {
          type: "array",
          description: "Attachments as objects with filename, content (base64), contentType",
        },
      },
      required: ["to", "subject", "body"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "reply_to_email",
    title: "Reply to Email",
    description:
      "Send a reply to an existing email. Fetches the original to pre-fill To, Re:-prefixed subject, and thread references. Use replyAll to include original CC recipients.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "UID of the email to reply to" },
        folder: { type: "string", description: "Folder the original message lives in. Providing this avoids UID collisions across folders." },
        body: { type: "string", description: "Reply body (plain text or HTML)" },
        isHtml: { type: "boolean", default: false },
        replyAll: {
          type: "boolean",
          default: false,
          description: "Include all original CC recipients",
        },
      },
      required: ["emailId", "body"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "forward_email",
    title: "Forward Email",
    description:
      "Forward an email to a new recipient. Original message is included as quoted content. Standard email headers (From, Date, Subject) are preserved in the forward body. Optionally prepend a message before the forwarded content.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "UID of the email to forward" },
        folder: { type: "string", description: "Folder the original message lives in. Providing this avoids UID collisions across folders." },
        to: { type: "string", description: "Recipient address(es), comma-separated" },
        message: { type: "string", description: "Optional message to prepend before the forwarded content" },
      },
      required: ["emailId", "to"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "send_test_email",
    title: "Send Test Email",
    description:
      "Send a test email to verify SMTP is working. Returns messageId on success. Use before relying on send_email in automated workflows.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address for the test" },
        customMessage: { type: "string", description: "Optional custom message body" },
      },
      required: ["to"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
];

export const handlers: Record<string, ToolHandler> = {
  send_email: async (ctx) => {
    const { args, smtpService, actionOk, MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH, invalidateAnalytics } = ctx;
    const seAttErr = validateAttachments(args.attachments);
    if (seAttErr) throw new McpError(ErrorCode.InvalidParams, seAttErr);
    if (!args.to || typeof args.to !== "string" || !(args.to as string).trim()) {
      throw new McpError(ErrorCode.InvalidParams, "'to' must be a non-empty string with at least one recipient address.");
    }
    if (!args.body || typeof args.body !== "string" || !(args.body as string).trim()) {
      throw new McpError(ErrorCode.InvalidParams, "'body' must be a non-empty string.");
    }
    if ((args.body as string).length > MAX_BODY_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `'body' must not exceed ${MAX_BODY_LENGTH} bytes (${MAX_BODY_LENGTH / 1024 / 1024} MB).`);
    }
    if (args.isHtml !== undefined && typeof args.isHtml !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isHtml' must be a boolean when provided.");
    }
    // SMTP-013: `subject` is in the schema's `required` list, but MCP transports
    // don't reliably enforce inputSchema — enforce it here so a `{to, body}` call
    // can't reach nodemailer with an empty Subject header.
    if (args.subject === undefined || typeof args.subject !== "string" || !(args.subject as string).trim()) {
      throw new McpError(ErrorCode.InvalidParams, "'subject' must be a non-empty string.");
    }
    if ((args.subject as string).length > MAX_SUBJECT_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `'subject' must not exceed ${MAX_SUBJECT_LENGTH} characters (RFC 2822 limit).`);
    }
    const VALID_PRIORITIES = new Set(["high", "normal", "low"]);
    if (args.priority !== undefined && !VALID_PRIORITIES.has(args.priority as string)) {
      throw new McpError(ErrorCode.InvalidParams, `'priority' must be one of "high", "normal", or "low".`);
    }
    if (args.replyTo !== undefined && (typeof args.replyTo !== "string" || !isValidEmail(args.replyTo as string))) {
      throw new McpError(ErrorCode.InvalidParams, `'replyTo' must be a valid email address.`);
    }
    if (args.cc !== undefined && typeof args.cc !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'cc' must be a string when provided.");
    }
    if (args.bcc !== undefined && typeof args.bcc !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'bcc' must be a string when provided.");
    }
    const result = await smtpService.sendEmail({
      to: args.to as string,
      cc: args.cc as string | undefined,
      bcc: args.bcc as string | undefined,
      subject: args.subject as string,
      body: args.body as string,
      isHtml: args.isHtml as boolean | undefined,
      priority: args.priority as "high" | "normal" | "low" | undefined,
      replyTo: args.replyTo as string | undefined,
      attachments: sanitizeAttachments(args.attachments),
    });
    if (!result.success) {
      return { content: [{ type: "text" as const, text: "Email delivery failed" }], isError: true };
    }
    invalidateAnalytics();
    return actionOk(result.messageId);
  },

  reply_to_email: async (ctx) => {
    const { args, imapService, smtpService, config, actionOk, MAX_BODY_LENGTH, MAX_SUBJECT_LENGTH, invalidateAnalytics } = ctx;
    const emailId = requireNumericEmailId(args.emailId);
    const sourceFolder = optionalFolderHint(args.folder);
    requireReplyOrForwardSourceFolder(ctx, sourceFolder, "reply_to_email");
    if (!args.body || typeof args.body !== "string" || !(args.body as string).trim()) {
      throw new McpError(ErrorCode.InvalidParams, "'body' must be a non-empty string.");
    }
    if ((args.body as string).length > MAX_BODY_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `'body' must not exceed ${MAX_BODY_LENGTH} bytes (${MAX_BODY_LENGTH / 1024 / 1024} MB).`);
    }
    if (args.isHtml !== undefined && typeof args.isHtml !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isHtml' must be a boolean when provided.");
    }
    if (args.replyAll !== undefined && typeof args.replyAll !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'replyAll' must be a boolean when provided.");
    }
    const original = await imapService.getEmailById(emailId, sourceFolder);
    if (!original) {
      return { content: [{ type: "text" as const, text: "Original email not found" }], isError: true };
    }
    requireFetchedSourceFolder(ctx, original.folder, sourceFolder, "reply_to_email");

    const replyToAddress = original.from.match(/<([^>]+)>/)?.[1] ?? original.from.trim();

    const cleanSubject = original.subject.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const replySubjectRaw = cleanSubject.toLowerCase().startsWith("re:")
      ? cleanSubject
      : `Re: ${cleanSubject}`;
    // SMTP-009: cap to MAX_SUBJECT_LENGTH like the forward path — a 998-char
    // original + "Re: " prefix otherwise bypasses the send_email guard.
    const subject = replySubjectRaw.length > MAX_SUBJECT_LENGTH
      ? replySubjectRaw.slice(0, MAX_SUBJECT_LENGTH)
      : replySubjectRaw;

    const ccAddresses: string[] = [];
    if (args.replyAll) {
      const self = config.smtp.username.toLowerCase();
      const addrs = [...(original.to ?? []), ...(original.cc ?? [])];
      for (const a of addrs) {
        const addr = (a.match(/<([^>]+)>/)?.[1] ?? a).trim().toLowerCase();
        if (addr && addr !== self && addr !== replyToAddress.toLowerCase()) {
          if (isValidEmail(addr)) ccAddresses.push(addr);
        }
      }
    }

    const result = await smtpService.sendEmail({
      to: replyToAddress,
      cc: ccAddresses.length > 0 ? ccAddresses.join(", ") : undefined,
      subject,
      body: args.body as string,
      isHtml: args.isHtml as boolean | undefined,
      inReplyTo: original.inReplyTo,
      references: original.references,
    });

    if (!result.success) {
      return { content: [{ type: "text" as const, text: "Email delivery failed" }], isError: true };
    }
    if (result.success) {
      // Keep the flag operation in the exact mailbox read above. IMAP UIDs
      // are folder-scoped, so an unqualified setFlag can mark a colliding UID
      // in another folder even after a correctly scoped source read.
      await imapService.setFlag(emailId, '\\Answered', true, original.folder).catch((err) =>
        logger.warn(`reply_to_email: failed to set \\Answered on ${emailId}: ${err instanceof Error ? err.message : String(err)}`, 'Sending'));
    }
    invalidateAnalytics();
    return actionOk(result.messageId);
  },

  forward_email: async (ctx) => {
    const { args, imapService, smtpService, actionOk, MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH, invalidateAnalytics } = ctx;
    const fwdId = requireNumericEmailId(args.emailId);
    const sourceFolder = optionalFolderHint(args.folder);
    requireReplyOrForwardSourceFolder(ctx, sourceFolder, "forward_email");
    if (!args.to || typeof args.to !== "string" || !(args.to as string).trim()) {
      throw new McpError(ErrorCode.InvalidParams, "'to' must be a non-empty string with at least one recipient address.");
    }
    const fwdOriginal = await imapService.getEmailById(fwdId, sourceFolder);
    if (!fwdOriginal) {
      return { content: [{ type: "text" as const, text: "Original email not found" }], isError: true };
    }
    requireFetchedSourceFolder(ctx, fwdOriginal.folder, sourceFolder, "forward_email");

    const fwdCleanSubject = fwdOriginal.subject.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const fwdSubjectRaw = fwdCleanSubject.toLowerCase().startsWith("fwd:")
      ? fwdCleanSubject
      : `Fwd: ${fwdCleanSubject}`;
    const fwdSubject = fwdSubjectRaw.length > MAX_SUBJECT_LENGTH
      ? fwdSubjectRaw.slice(0, MAX_SUBJECT_LENGTH)
      : fwdSubjectRaw;

    // Strip control chars from the embedded original From/To so a CRLF in a
    // display name can't break the quoted header block's visual structure.
    const stripCtl = (s: string) => s.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
    const fwdHeader = [
      "---------- Forwarded message ----------",
      `From: ${stripCtl(fwdOriginal.from)}`,
      `Date: ${fwdOriginal.date.toISOString()}`,
      `Subject: ${fwdCleanSubject}`,
      `To: ${stripCtl((fwdOriginal.to ?? []).join(", "))}`,
      "",
    ].join("\n");

    if (args.message !== undefined && typeof args.message !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'message' must be a string when provided.");
    }
    // SMTP-010: isHtml is inherited from the forwarded original, so when the
    // original is HTML, args.message is spliced into an HTML body unescaped —
    // letting an agent inject markup/script. Escape it in the HTML case.
    const rawUserMessage = (args.message as string | undefined) ?? "";
    const safeUserMessage = fwdOriginal.isHtml ? escapeHtml(rawUserMessage) : rawUserMessage;
    const userMessage = args.message ? `${safeUserMessage}\n\n` : "";
    const fwdBody = `${userMessage}${fwdHeader}\n${fwdOriginal.body ?? ""}`;
    if (fwdBody.length > MAX_BODY_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `Forwarded body must not exceed ${MAX_BODY_LENGTH} bytes (${MAX_BODY_LENGTH / 1024 / 1024} MB).`);
    }

    const fwdResult = await smtpService.sendEmail({
      to: args.to as string,
      subject: fwdSubject,
      body: fwdBody,
      isHtml: fwdOriginal.isHtml,
      // Keep the forward in the original thread (parity with reply_to_email).
      inReplyTo: fwdOriginal.inReplyTo,
      references: fwdOriginal.references,
    });

    if (!fwdResult.success) {
      return { content: [{ type: "text" as const, text: "Forward failed" }], isError: true };
    }
    if (fwdResult.success) {
      // Best-effort flag; log (don't fail the send) so a flag-set failure isn't invisible.
      await imapService.setFlag(fwdId, '$Forwarded', true, fwdOriginal.folder).catch((err) =>
        logger.warn(`forward_email: failed to set $Forwarded on ${fwdId}: ${err instanceof Error ? err.message : String(err)}`, 'Sending'));
    }
    invalidateAnalytics();
    return actionOk(fwdResult.messageId);
  },

  send_test_email: async (ctx) => {
    const { args, smtpService, actionOk, invalidateAnalytics } = ctx;
    if (!isValidEmail(args.to as string)) {
      throw new McpError(ErrorCode.InvalidParams, `Invalid recipient email address: ${args.to}`);
    }
    if (args.customMessage !== undefined && typeof args.customMessage !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'customMessage' must be a string when provided.");
    }
    const result = await smtpService.sendTestEmail(
      args.to as string,
      args.customMessage as string | undefined
    );
    if (!result.success) {
      return { content: [{ type: "text" as const, text: "Test email failed" }], isError: true };
    }
    invalidateAnalytics();
    return actionOk(result.messageId);
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
