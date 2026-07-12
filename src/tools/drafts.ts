/**
 * Drafts & scheduling tools: save_draft, schedule_email,
 * list_scheduled_emails, cancel_scheduled_email, list_proton_scheduled,
 * remind_if_no_reply, list_pending_reminders, cancel_reminder,
 * check_reminders.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isValidEmail, optionalFolderHint, requireNumericEmailId, validateAttachments, sanitizeAttachments } from "../utils/helpers.js";
import type { EmailMessage } from "../types/index.js";
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

const EMAIL_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "IMAP UID for use in follow-up tool calls" },
    from: { type: "string" },
    to: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    bodyPreview: { type: "string", description: "First ~300 chars of body" },
    date: { type: "string", format: "date-time" },
    folder: { type: "string" },
    isRead: { type: "boolean" },
    isStarred: { type: "boolean" },
    hasAttachment: { type: "boolean" },
  },
  required: ["id", "from", "subject", "date", "isRead", "folder"],
};

/**
 * Folder restrictions apply to both IMAP reads and mailbox-derived records
 * persisted by local services. `undefined` is the explicit unscoped/trusted
 * case; an empty list is intentionally deny-all if a malformed context ever
 * produces one.
 */
function callerAllowedFolders(ctx: Parameters<ToolHandler>[0]): readonly string[] | undefined {
  // A few focused handler fixtures predate the contextual accessor. Treating
  // its absence as the historical trusted/unrestricted case preserves those
  // direct-call semantics; production dispatch always supplies it.
  return ctx.getCallerAllowedFolders?.();
}

function requireAllowedMailFolder(ctx: Parameters<ToolHandler>[0], folder: string, operation: string): void {
  const allowed = callerAllowedFolders(ctx);
  if (allowed === undefined) return;
  if (!allowed.some(candidate => candidate.toLowerCase() === folder.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} would access folder '${folder}', which is outside this agent's folder allowlist.`,
    );
  }
}

/**
 * A folder hint is a claim, not proof. Once IMAP returns a message, verify
 * its resolved folder before inspecting headers or persisting a reminder.
 * This closes the same folder-local UID collision class as reply/forward.
 */
function requireResolvedMailFolder(
  ctx: Parameters<ToolHandler>[0],
  requestedFolder: string,
  resolvedFolder: string | undefined,
  operation: string,
): void {
  const allowed = callerAllowedFolders(ctx);
  if (allowed === undefined) return;
  if (!resolvedFolder || !allowed.some(candidate => candidate.toLowerCase() === resolvedFolder.toLowerCase())) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} resolved a message outside this agent's folder allowlist.`,
    );
  }
  if (resolvedFolder.toLowerCase() !== requestedFolder.toLowerCase()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} resolved a message from '${resolvedFolder}' rather than the requested folder '${requestedFolder}'.`,
    );
  }
}

/**
 * Scheduled and reminder records are account-scoped but carry no originating
 * mailbox folder (or agent identity). Returning or mutating one therefore
 * cannot be proven within a restricted caller's mail scope. Do not mistake
 * an account ID match for folder provenance.
 */
function requireUnrestrictedPersistentRecordAccess(ctx: Parameters<ToolHandler>[0], operation: string): void {
  if (callerAllowedFolders(ctx) !== undefined) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${operation} is unavailable to folder-restricted callers because persisted records have no source-folder provenance.`,
    );
  }
}

export const defs: ToolDef[] = [
  {
    name: "save_draft",
    title: "Save Draft",
    description:
      "Save an email as a draft in the Drafts folder without sending it. All fields are optional — drafts can be incomplete. Returns the server-assigned UID.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address(es), comma-separated" },
        cc: { type: "string", description: "CC addresses, comma-separated" },
        bcc: { type: "string", description: "BCC addresses, comma-separated" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text or HTML)" },
        isHtml: { type: "boolean", default: false },
        attachments: { type: "array", description: "Attachments as objects with filename, content (base64), contentType" },
        inReplyTo: { type: "string", description: "Message-ID this is a reply to" },
        references: { type: "array", items: { type: "string" }, description: "Thread reference Message-IDs" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        uid: { type: "number", description: "IMAP UID assigned to the draft" },
        error: { type: "string" },
      },
      required: ["success"],
    },
  },
  {
    name: "schedule_email",
    title: "Schedule Email",
    description:
      "Schedule an email for future delivery (minimum 60 seconds from now, maximum 30 days). Scheduled emails are retried up to 3 times on failure. Use list_scheduled_emails to view pending sends and cancel_scheduled_email to cancel before delivery.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Recipient address(es), comma-separated" },
        subject: { type: "string", description: "Email subject line" },
        body: { type: "string", description: "Email body (plain text or HTML)" },
        send_at: { type: "string", description: "ISO 8601 datetime when to send (e.g. 2026-03-18T09:00:00Z)" },
        cc: { type: "string", description: "CC addresses, comma-separated" },
        bcc: { type: "string", description: "BCC addresses, comma-separated" },
        isHtml: { type: "boolean", default: false },
        priority: { type: "string", enum: ["high", "normal", "low"] },
        replyTo: { type: "string", description: "Reply-to address" },
        attachments: { type: "array", description: "Attachments as objects with filename, content (base64), contentType" },
      },
      required: ["to", "subject", "body", "send_at"],
    },
    outputSchema: {
      type: "object",
      properties: {
        success: { type: "boolean" },
        id: { type: "string", description: "Schedule ID — use with cancel_scheduled_email" },
        scheduledAt: { type: "string", format: "date-time" },
      },
      required: ["success", "id"],
    },
  },
  {
    name: "list_scheduled_emails",
    title: "List Scheduled Emails",
    description: "List all scheduled emails (pending, sent, failed, and cancelled). Sorted by scheduledAt ascending.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        scheduled: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              scheduledAt: { type: "string", format: "date-time" },
              status: { type: "string", enum: ["pending", "sent", "failed", "cancelled"] },
              subject: { type: "string" },
              to: { type: "string" },
              createdAt: { type: "string", format: "date-time" },
              error: { type: "string" },
              retryCount: { type: "number", description: "Number of send attempts made for this scheduled email" },
            },
          },
        },
        count: { type: "number" },
      },
      required: ["scheduled", "count"],
    },
  },
  {
    name: "list_proton_scheduled",
    title: "List Proton Scheduled Emails",
    description: "List emails natively scheduled via Proton Mail web/mobile app (not MCP-scheduled emails). Reads the 'All Scheduled' IMAP folder exposed by Proton Bridge.",
    inputSchema: { type: "object", properties: {}, required: [] },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    outputSchema: {
      type: "object",
      properties: {
        emails: { type: "array", items: EMAIL_SUMMARY_SCHEMA },
        count: { type: "number" },
        folder: { type: "string" },
        note: { type: "string" },
      },
      required: ["emails", "count"],
    },
  },
  {
    name: "remind_if_no_reply",
    title: "Remind If No Reply",
    description:
      "Schedule a follow-up reminder for a message you've sent. Given the IMAP UID of a message in Sent, captures its Message-ID + recipient and fires a reminder after N days. Use check_reminders to retrieve due reminders; list_pending_reminders to audit; cancel_reminder to drop one.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "IMAP UID of the sent message" },
        folder: { type: "string", description: "Folder containing the message (default: Sent). Provide this to avoid UID collisions across folders." },
        after_days: { type: "number", description: "Days from the message's send date until the reminder fires (1–365)" },
        note: { type: "string", description: "Optional note explaining the reminder" },
      },
      required: ["email_id", "after_days"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        recipient: { type: "string" },
        subject: { type: "string" },
        fireAt: { type: "string", format: "date-time" },
      },
      required: ["id", "recipient", "subject", "fireAt"],
    },
  },
  {
    name: "list_pending_reminders",
    title: "List Pending Reminders",
    description: "List every pending no-reply reminder, sorted by earliest fireAt.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        reminders: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              recipient: { type: "string" },
              subject: { type: "string" },
              sentAt: { type: "string", format: "date-time" },
              fireAt: { type: "string", format: "date-time" },
              note: { type: "string" },
            },
          },
        },
      },
      required: ["reminders"],
    },
  },
  {
    name: "cancel_reminder",
    title: "Cancel Reminder",
    description: "Cancel a pending no-reply reminder by ID. Silently returns false if the ID is unknown or the reminder already fired.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        reminder_id: { type: "string" },
      },
      required: ["reminder_id"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "check_reminders",
    title: "Check Reminders",
    description:
      "Return every pending reminder whose deadline has passed. Each returned reminder is transitioned to 'fired' status so it won't appear in subsequent calls. The agent can then search INBOX for replies to messageId and decide whether to surface the reminder to the user.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        fired: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              messageId: { type: "string" },
              recipient: { type: "string" },
              subject: { type: "string" },
              sentAt: { type: "string", format: "date-time" },
              fireAt: { type: "string", format: "date-time" },
              note: { type: "string" },
            },
          },
        },
      },
      required: ["fired"],
    },
  },
  {
    name: "cancel_scheduled_email",
    title: "Cancel Scheduled Email",
    description: "Cancel a pending scheduled email before it is sent. Returns false if the ID is not found or the email has already been sent.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Schedule ID from schedule_email or list_scheduled_emails" },
      },
      required: ["id"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
];

export const handlers: Record<string, ToolHandler> = {
  save_draft: async (ctx) => {
    const { args, imapService, ok, MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH } = ctx;
    const sdAttErr = validateAttachments(args.attachments);
    if (sdAttErr) throw new McpError(ErrorCode.InvalidParams, sdAttErr);
    if (args.to !== undefined && typeof args.to !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'to' must be a string when provided.");
    }
    if (args.subject !== undefined && typeof args.subject !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'subject' must be a string.");
    }
    if (args.subject !== undefined && typeof args.subject === "string" && (args.subject as string).length > MAX_SUBJECT_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `'subject' must not exceed ${MAX_SUBJECT_LENGTH} characters (RFC 2822 limit).`);
    }
    if (args.body !== undefined && (typeof args.body !== "string" || !(args.body as string).trim())) {
      throw new McpError(ErrorCode.InvalidParams, "'body' must be a non-empty string when provided.");
    }
    if (args.body !== undefined && (args.body as string).length > MAX_BODY_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `'body' must not exceed ${MAX_BODY_LENGTH} bytes (${MAX_BODY_LENGTH / 1024 / 1024} MB).`);
    }
    if (args.isHtml !== undefined && typeof args.isHtml !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isHtml' must be a boolean when provided.");
    }
    if (args.cc !== undefined && typeof args.cc !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'cc' must be a string when provided.");
    }
    if (args.bcc !== undefined && typeof args.bcc !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'bcc' must be a string when provided.");
    }
    if (args.inReplyTo !== undefined && typeof args.inReplyTo !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'inReplyTo' must be a string when provided.");
    }
    if (args.references !== undefined) {
      if (!Array.isArray(args.references)) {
        throw new McpError(ErrorCode.InvalidParams, "'references' must be an array of strings when provided.");
      }
      for (let i = 0; i < (args.references as unknown[]).length; i++) {
        if (typeof (args.references as unknown[])[i] !== "string") {
          throw new McpError(ErrorCode.InvalidParams, `'references[${i}]' must be a string.`);
        }
      }
    }
    const draftResult = await imapService.saveDraft({
      to: args.to as string | undefined,
      cc: args.cc as string | undefined,
      bcc: args.bcc as string | undefined,
      subject: args.subject as string | undefined,
      body: args.body as string | undefined,
      isHtml: args.isHtml as boolean | undefined,
      attachments: sanitizeAttachments(args.attachments),
      inReplyTo: args.inReplyTo as string | undefined,
      references: args.references as string[] | undefined,
    });
    if (!draftResult.success) {
      return { content: [{ type: "text" as const, text: `Failed to save draft: ${draftResult.error}` }], isError: true };
    }
    return ok({ success: true, uid: draftResult.uid }, `Draft saved (UID: ${draftResult.uid ?? "unknown"})`);
  },

  schedule_email: async (ctx) => {
    const { args, schedulerService, accountId, accountIdentity, ok, MAX_SUBJECT_LENGTH, MAX_BODY_LENGTH, safeErrorMessage } = ctx;
    const schAttErr = validateAttachments(args.attachments);
    if (schAttErr) throw new McpError(ErrorCode.InvalidParams, schAttErr);
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
    if (args.subject !== undefined && typeof args.subject !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'subject' must be a string.");
    }
    if (args.subject !== undefined && typeof args.subject === "string" && (args.subject as string).length > MAX_SUBJECT_LENGTH) {
      throw new McpError(ErrorCode.InvalidParams, `'subject' must not exceed ${MAX_SUBJECT_LENGTH} characters (RFC 2822 limit).`);
    }
    if (args.priority !== undefined && !new Set(["high", "normal", "low"]).has(args.priority as string)) {
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
    if (!args.send_at || typeof args.send_at !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'send_at' is required and must be an ISO 8601 date-time string.");
    }
    const sendAt = new Date(args.send_at as string);
    if (isNaN(sendAt.getTime())) {
      throw new McpError(ErrorCode.InvalidParams, `'send_at' is not a valid date-time: '${args.send_at}'. Use ISO 8601 format, e.g. 2026-01-15T14:30:00Z.`);
    }
    try {
      const schedId = schedulerService.schedule({
        to: args.to as string,
        cc: args.cc as string | undefined,
        bcc: args.bcc as string | undefined,
        subject: args.subject as string,
        body: args.body as string,
        isHtml: args.isHtml as boolean | undefined,
        priority: args.priority as "high" | "normal" | "low" | undefined,
        replyTo: args.replyTo as string | undefined,
        attachments: sanitizeAttachments(args.attachments),
      }, sendAt, accountId, accountIdentity);
      return ok({ success: true, id: schedId, scheduledAt: sendAt.toISOString() },
        `Scheduled for ${sendAt.toISOString()} (ID: ${schedId})`);
    } catch (err: unknown) {
      const errMsg = safeErrorMessage(err);
      return { content: [{ type: "text" as const, text: errMsg }], isError: true };
    }
  },

  list_scheduled_emails: async (ctx) => {
    const { schedulerService, accountId, ok } = ctx;
    requireUnrestrictedPersistentRecordAccess(ctx, "list_scheduled_emails");
    const allScheduled = schedulerService.list(accountId);
    const summary = allScheduled.map(s => {
      const opts = s.options as unknown as Record<string, unknown>;
      const toField = opts?.to;
      const toStr = Array.isArray(toField) ? toField.join(", ") : (typeof toField === "string" ? toField : undefined);
      return {
        id: s.id,
        scheduledAt: s.scheduledAt,
        status: s.status,
        subject: typeof opts?.subject === "string" ? opts.subject : undefined,
        to: toStr,
        createdAt: s.createdAt,
        error: s.error,
        retryCount: s.retryCount,
      };
    });
    return ok({ scheduled: summary, count: summary.length });
  },

  list_proton_scheduled: async (ctx) => {
    const { imapService, ok } = ctx;
    const scheduledFolderCandidates = ['All Scheduled', 'Scheduled'];
    const allowed = callerAllowedFolders(ctx);
    // These are fixed IMAP sources, unlike the account-scoped local scheduler
    // records above. Intersect before probing: a failed probe itself can reveal
    // whether an excluded folder exists or is reachable.
    const scopedCandidates = allowed === undefined
      ? scheduledFolderCandidates
      : scheduledFolderCandidates.filter(candidate =>
          allowed.some(folder => folder.toLowerCase() === candidate.toLowerCase()));
    if (scopedCandidates.length === 0) {
      throw new McpError(
        ErrorCode.InvalidRequest,
        "Blocked: no Proton scheduled-mail folder is in this agent's folder allowlist.",
      );
    }
    let scheduledEmails: EmailMessage[] = [];
    let foundFolder = '';

    for (const candidate of scopedCandidates) {
      try {
        const emails = await imapService.getEmails(candidate, 50);
        if (emails.length >= 0) {
          // The service normally stamps each result with the mailbox it read,
          // but retain the boundary check so a stale/misbehaving adapter never
          // leaks a record from a different folder through this aggregate.
          scheduledEmails = allowed === undefined
            ? emails
            : emails.filter(email => allowed.some(folder => folder.toLowerCase() === email.folder.toLowerCase()));
          foundFolder = candidate;
          break;
        }
      } catch {
        // folder doesn't exist, try next
      }
    }

    if (!foundFolder) {
      return ok({
        emails: [], count: 0,
        note: "No Proton scheduled folder found. Scheduled emails may not be visible until a message is actually scheduled via Proton web/mobile."
      });
    }

    return ok({ emails: scheduledEmails, count: scheduledEmails.length, folder: foundFolder });
  },

  cancel_scheduled_email: async (ctx) => {
    const { args, schedulerService, accountId, actionOk } = ctx;
    requireUnrestrictedPersistentRecordAccess(ctx, "cancel_scheduled_email");
    const rawCancelId = args.id;
    if (
      !rawCancelId ||
      typeof rawCancelId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rawCancelId)
    ) {
      throw new McpError(ErrorCode.InvalidParams, "id must be a valid UUID (e.g. xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx).");
    }
    const result = schedulerService.cancel(rawCancelId, accountId);
    if (result.ok) {
      return actionOk();
    }
    // SMTP-002: distinguish "send already on the wire" from terminal-state /
    // unknown-id so callers can warn the user that the message may still be
    // delivered.
    const msg = result.error === "in_flight"
      ? "Send is already in flight; message may still be delivered. Status updated to cancelled to suppress retries."
      : result.error === "not_found"
        ? "Not found"
        : "Not pending (already sent, failed, or cancelled)";
    return { content: [{ type: "text" as const, text: msg }], isError: true };
  },

  remind_if_no_reply: async (ctx) => {
    const { args, imapService, reminderService, accountId, accountIdentity, ok } = ctx;
    const remEmailId = requireNumericEmailId(args.email_id, "email_id");
    const folderHint = optionalFolderHint(args.folder) ?? "Sent";
    requireAllowedMailFolder(ctx, folderHint, "remind_if_no_reply");
    const afterDays = typeof args.after_days === "number" ? args.after_days : NaN;
    if (!Number.isFinite(afterDays) || afterDays < 1 || afterDays > 365) {
      throw new McpError(ErrorCode.InvalidParams, "after_days must be a number between 1 and 365.");
    }
    let msg;
    try {
      msg = await imapService.getEmailById(remEmailId, folderHint);
    } catch (fetchErr: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to fetch message ${remEmailId} from ${folderHint}: ${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)}`);
    }
    if (!msg) {
      return { content: [{ type: "text" as const, text: `Source message ${remEmailId} not found in ${folderHint}` }], isError: true };
    }
    requireResolvedMailFolder(ctx, folderHint, msg.folder, "remind_if_no_reply");
    const headers = msg.headers ?? {};
    const rawMsgId = Array.isArray(headers["message-id"]) ? headers["message-id"][0] : (headers["message-id"] as string | undefined);
    if (!rawMsgId) {
      throw new McpError(ErrorCode.InvalidRequest, "Source message has no Message-ID header; cannot track replies.");
    }
    const sentAt = msg.date ?? new Date();
    const fireAt = new Date(sentAt.getTime() + afterDays * 24 * 60 * 60 * 1000);
    if (fireAt <= new Date()) {
      throw new McpError(ErrorCode.InvalidParams, `Computed fireAt (${fireAt.toISOString()}) is in the past. The message was sent on ${sentAt.toISOString()} — increase after_days or choose a more recent sent message.`);
    }
    const recipient = (msg.to ?? [])[0] ?? "";
    let reminder;
    try {
      reminder = reminderService.add({
        accountId,
        accountIdentity,
        messageId: rawMsgId,
        imapUid: remEmailId,
        recipient,
        subject: msg.subject ?? "",
        sentAt,
        afterDays,
        note: typeof args.note === "string" ? args.note : undefined,
      });
    } catch (addErr: unknown) {
      throw new McpError(ErrorCode.InternalError, `Failed to persist reminder: ${addErr instanceof Error ? addErr.message : String(addErr)}`);
    }
    return ok({
      id: reminder.id,
      recipient: reminder.recipient,
      subject: reminder.subject,
      fireAt: reminder.fireAt,
    });
  },

  list_pending_reminders: async (ctx) => {
    const { reminderService, accountId, ok } = ctx;
    requireUnrestrictedPersistentRecordAccess(ctx, "list_pending_reminders");
    const reminders = reminderService.listPending(accountId).map(r => ({
      id: r.id,
      recipient: r.recipient,
      subject: r.subject,
      sentAt: r.sentAt,
      fireAt: r.fireAt,
      note: r.note ?? "",
    }));
    return ok({ reminders });
  },

  cancel_reminder: async (ctx) => {
    const { args, reminderService, accountId, actionOk } = ctx;
    requireUnrestrictedPersistentRecordAccess(ctx, "cancel_reminder");
    const rid = typeof args.reminder_id === "string" ? args.reminder_id : "";
    if (!rid) throw new McpError(ErrorCode.InvalidParams, "reminder_id must be a non-empty string.");
    const cancelled = reminderService.cancel(rid, accountId);
    if (!cancelled) {
      return { content: [{ type: "text" as const, text: "Reminder not found or already fired" }], isError: true };
    }
    return actionOk();
  },

  check_reminders: async (ctx) => {
    const { reminderService, accountId, ok } = ctx;
    requireUnrestrictedPersistentRecordAccess(ctx, "check_reminders");
    const fired = reminderService.scanDue(new Date(), accountId).map(r => ({
      id: r.id,
      messageId: r.messageId,
      recipient: r.recipient,
      subject: r.subject,
      sentAt: r.sentAt,
      fireAt: r.fireAt,
      note: r.note ?? "",
    }));
    reminderService.prune(30, accountId);
    return ok({ fired });
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
