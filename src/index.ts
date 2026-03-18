#!/usr/bin/env node

/**
 * Proton Mail MCP Server
 *
 * Full agentic design: Tools + Resources + Prompts, structured output,
 * tool annotations, progress notifications, cursor-based pagination.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import { ProtonMailConfig, EmailMessage, EmailAttachment } from "./types/index.js";
import { SMTPService } from "./services/smtp-service.js";
import { SimpleIMAPService } from "./services/simple-imap-service.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { SchedulerService } from "./services/scheduler.js";
import { logger } from "./utils/logger.js";
import { isValidEmail, validateLabelName, validateFolderName, validateTargetFolder, requireNumericEmailId, validateAttachments } from "./utils/helpers.js";
import { permissions } from "./permissions/manager.js";
import {
  requestEscalation,
  getEscalationStatus,
  isUpgrade,
} from "./permissions/escalation.js";
import { loadConfig, defaultConfig, migrateCredentials } from "./config/loader.js";
import type { ToolName, PermissionPreset } from "./config/schema.js";
import { isValidChallengeId, sanitizeText, isValidEscalationTarget } from "./settings/security.js";

// ─── Environment Configuration ───────────────────────────────────────────────

const PROTONMAIL_USERNAME = process.env.PROTONMAIL_USERNAME;
const PROTONMAIL_PASSWORD = process.env.PROTONMAIL_PASSWORD;
const PROTONMAIL_SMTP_HOST = process.env.PROTONMAIL_SMTP_HOST || "smtp.protonmail.ch";
const PROTONMAIL_SMTP_PORT = parseInt(process.env.PROTONMAIL_SMTP_PORT || "587", 10);
const PROTONMAIL_IMAP_HOST = process.env.PROTONMAIL_IMAP_HOST || "localhost";
const PROTONMAIL_IMAP_PORT = parseInt(process.env.PROTONMAIL_IMAP_PORT || "1143", 10);
const PROTONMAIL_SMTP_TOKEN = process.env.PROTONMAIL_SMTP_TOKEN;
const PROTONMAIL_BRIDGE_CERT = process.env.PROTONMAIL_BRIDGE_CERT;
const DEBUG = process.env.DEBUG === "true";

if (!PROTONMAIL_USERNAME || !PROTONMAIL_PASSWORD) {
  console.error(
    "[ProtonMail MCP] Missing required env vars: PROTONMAIL_USERNAME and PROTONMAIL_PASSWORD must be set"
  );
  process.exit(1);
}

function validatePort(value: number, name: string): void {
  if (isNaN(value) || value < 1 || value > 65535) {
    console.error(`[ProtonMail MCP] Invalid port for ${name}: ${value}. Must be 1-65535.`);
    process.exit(1);
  }
}
validatePort(PROTONMAIL_SMTP_PORT, "PROTONMAIL_SMTP_PORT");
validatePort(PROTONMAIL_IMAP_PORT, "PROTONMAIL_IMAP_PORT");

logger.setDebugMode(DEBUG);

// ─── Service Initialization ───────────────────────────────────────────────────

const config: ProtonMailConfig = {
  smtp: {
    host: PROTONMAIL_SMTP_HOST,
    port: PROTONMAIL_SMTP_PORT,
    secure: PROTONMAIL_SMTP_PORT === 465,
    username: PROTONMAIL_USERNAME,
    password: PROTONMAIL_PASSWORD,
    smtpToken: PROTONMAIL_SMTP_TOKEN,
    bridgeCertPath: PROTONMAIL_BRIDGE_CERT,
  },
  imap: {
    host: PROTONMAIL_IMAP_HOST,
    port: PROTONMAIL_IMAP_PORT,
    secure: false,
    username: PROTONMAIL_USERNAME,
    password: PROTONMAIL_PASSWORD,
    bridgeCertPath: PROTONMAIL_BRIDGE_CERT,
  },
  debug: DEBUG,
  cacheEnabled: true,
  analyticsEnabled: true,
  autoSync: true,
  syncInterval: 5,
};

const smtpService = new SMTPService(config);
const imapService = new SimpleIMAPService();
const analyticsService = new AnalyticsService();

const SCHEDULER_STORE = process.env.PROTONMAIL_SCHEDULER_STORE
  || `${process.env.HOME || process.env.USERPROFILE || "."}/.protonmail-mcp-scheduled.json`;
const schedulerService = new SchedulerService(smtpService, SCHEDULER_STORE);

// ─── SMTP Connection Status ───────────────────────────────────────────────────
// Tracks the result of the last SMTP verify attempt so get_connection_status
// returns an honest answer instead of a hardcoded `true`.
let smtpStatus: { connected: boolean; lastCheck: Date; error?: string } = {
  connected: false,
  lastCheck: new Date(0),
};

// ─── Analytics TTL Cache ──────────────────────────────────────────────────────

const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;
let analyticsCache: { inbox: EmailMessage[]; sent: EmailMessage[]; fetchedAt: number } | null = null;
/** In-flight fetch promise — collapses concurrent cache-miss calls into one IMAP round-trip. */
let analyticsCacheInflight: Promise<{ inbox: EmailMessage[]; sent: EmailMessage[] }> | null = null;

/**
 * Fetch inbox + sent emails, update the analytics service, and cache the result.
 * Concurrent cache-miss callers share a single in-flight fetch to avoid a stampede.
 */
async function getAnalyticsEmails(): Promise<{ inbox: EmailMessage[]; sent: EmailMessage[] }> {
  const now = Date.now();
  if (analyticsCache && now - analyticsCache.fetchedAt < ANALYTICS_CACHE_TTL_MS) {
    return { inbox: analyticsCache.inbox, sent: analyticsCache.sent };
  }
  if (analyticsCacheInflight) return analyticsCacheInflight;
  analyticsCacheInflight = (async () => {
    try {
      const [inbox, sent] = await Promise.all([
        imapService.getEmails("INBOX", 200),
        imapService.getEmails("Sent", 100).catch(() => [] as EmailMessage[]),
      ]);
      analyticsCache = { inbox, sent, fetchedAt: Date.now() };
      analyticsService.updateEmails(inbox, sent);
      return { inbox, sent };
    } finally {
      analyticsCacheInflight = null;
    }
  })();
  return analyticsCacheInflight;
}

// ─── Cursor-Based Pagination ──────────────────────────────────────────────────

interface EmailCursor {
  folder: string;
  offset: number;
  limit: number;
}

function encodeCursor(c: EmailCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(token: string): EmailCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString());
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.folder === "string" &&
      typeof parsed.offset === "number" && parsed.offset >= 0 &&
      typeof parsed.limit === "number" && parsed.limit >= 1 && parsed.limit <= 200
    ) {
      // Validate folder to prevent path traversal via crafted cursor tokens.
      if (validateTargetFolder(parsed.folder) !== null) return null;
      return parsed as EmailCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of email IDs accepted by any bulk operation. */
const MAX_BULK_IDS = 200;

// ─── Safe Error Messages ──────────────────────────────────────────────────────

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "An error occurred";
  const msg = error.message.toLowerCase();
  if (
    msg.includes("invalid email") ||
    msg.includes("invalid reply") ||
    msg.includes("invalid email id") ||
    msg.includes("invalid folder") ||
    msg.includes("control char")
  )
    return error.message;
  if (msg.includes("not found")) return "Resource not found";
  if (msg.includes("smtp") || msg.includes("send") || msg.includes("delivery"))
    return "Email delivery failed";
  if (
    msg.includes("imap") ||
    msg.includes("connect") ||
    msg.includes("mailbox") ||
    msg.includes("login")
  )
    return "IMAP operation failed";
  if (
    msg.includes("protected folder") ||
    msg.includes("already exists") ||
    msg.includes("not empty") ||
    msg.includes("does not exist")
  )
    return error.message;
  if (msg.includes("at least one recipient") || msg.includes("required")) return error.message;
  return "An error occurred";
}

// ─── Prompt Body Truncation ───────────────────────────────────────────────────

/**
 * Truncate an email body before embedding it in a prompt message.
 * Prevents prompt token explosion from large HTML emails and limits the
 * attack surface for prompt injection via malicious email content.
 */
function truncateEmailBody(body: string, maxLength: number = 2000): string {
  if (!body || body.length <= maxLength) return body;
  return body.substring(0, maxLength) + "\n\n[...body truncated at " + maxLength + " chars — use get_email_by_id for full content]";
}

// ─── Shared Output Schemas ────────────────────────────────────────────────────

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

const ACTION_RESULT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    messageId: { type: "string" },
    reason: { type: "string" },
  },
  required: ["success"],
};

const BULK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "number" },
    failed: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["success", "failed", "errors"],
};

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "protonmail-mcp-server", version: "2.0.0" },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    },
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOLS
// ═════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListToolsRequestSchema, async () => {
  logger.debug("Listing tools", "MCPServer");
  return {
    tools: [
      // ── Sending ────────────────────────────────────────────────────────────
      {
        name: "send_email",
        title: "Send Email",
        description:
          "Send an email via ProtonMail SMTP. Supports To/CC/BCC (comma-separated), plain text or HTML body, priority (high/normal/low), reply-to, and base64-encoded attachments. Returns messageId on success.",
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
          "Forward an existing email to a new recipient. Fetches the original, prepends an optional message, and sends with Fwd:-prefixed subject.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string", description: "UID of the email to forward" },
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

      // ── Reading ────────────────────────────────────────────────────────────
      {
        name: "get_emails",
        title: "Get Emails",
        description:
          "Fetch a page of emails from a folder. Returns summary fields (id, from, subject, date, isRead, bodyPreview). Use id with get_email_by_id for full content. Pass nextCursor from a previous response to get the next page.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            folder: {
              type: "string",
              description: "Folder path. Examples: INBOX, Sent, Trash, Folders/MyFolder",
              default: "INBOX",
            },
            limit: {
              type: "number",
              description: "Emails per page (1-200, default 50)",
              default: 50,
            },
            cursor: {
              type: "string",
              description: "Opaque cursor from previous response nextCursor to get next page. Omit for first page.",
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            emails: { type: "array", items: EMAIL_SUMMARY_SCHEMA },
            folder: { type: "string" },
            count: { type: "number" },
            nextCursor: {
              type: "string",
              description: "Pass this value as cursor in the next call. Absent when no more pages.",
            },
          },
          required: ["emails", "folder", "count"],
        },
      },
      {
        name: "get_email_by_id",
        title: "Get Email by ID",
        description:
          "Fetch a single email's full content including body and attachment metadata (no binary content). Use the id returned by get_emails or search_emails.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string", description: "IMAP UID from get_emails or search_emails" },
          },
          required: ["emailId"],
        },
        outputSchema: {
          type: "object",
          properties: {
            id: { type: "string" },
            from: { type: "string" },
            to: { type: "array", items: { type: "string" } },
            cc: { type: "array", items: { type: "string" } },
            subject: { type: "string" },
            body: { type: "string" },
            isHtml: { type: "boolean" },
            date: { type: "string", format: "date-time" },
            folder: { type: "string" },
            isRead: { type: "boolean" },
            isStarred: { type: "boolean" },
            hasAttachment: { type: "boolean" },
            attachments: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  filename: { type: "string" },
                  contentType: { type: "string" },
                  size: { type: "number" },
                },
              },
            },
          },
          required: ["id", "from", "subject", "body", "date", "isRead"],
        },
      },
      {
        name: "search_emails",
        title: "Search Emails",
        description:
          "Search emails by sender, recipient, subject, date range, read/starred status, or attachment presence. Use `folder` for a single folder or `folders` for multiple (pass [\"*\"] to search all). Returns summary fields. Use get_email_by_id for full content.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", default: "INBOX", description: "Single folder to search (ignored if `folders` is set)" },
            folders: {
              type: "array",
              items: { type: "string" },
              description: "Search multiple folders. Use [\"*\"] to search all folders (capped at 20). Overrides `folder`.",
            },
            from: { type: "string", description: "Filter by sender address or name" },
            to: { type: "string", description: "Filter by recipient address" },
            subject: { type: "string", description: "Filter by subject text" },
            hasAttachment: { type: "boolean" },
            isRead: { type: "boolean" },
            isStarred: { type: "boolean" },
            dateFrom: { type: "string", description: "ISO 8601 start date" },
            dateTo: { type: "string", description: "ISO 8601 end date" },
            limit: { type: "number", description: "Max results (1-200, default 50)", default: 50 },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            emails: { type: "array", items: EMAIL_SUMMARY_SCHEMA },
            count: { type: "number" },
            folder: { type: "string" },
          },
          required: ["emails", "count", "folder"],
        },
      },
      {
        name: "get_unread_count",
        title: "Get Unread Count",
        description:
          "Get unread email count for each folder. Cheap call — use this before get_emails to decide whether to fetch. Returns object mapping folder path to unread count.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            unreadByFolder: {
              type: "object",
              additionalProperties: { type: "number" },
              description: "Folder path -> unread count",
            },
            totalUnread: { type: "number" },
          },
          required: ["unreadByFolder", "totalUnread"],
        },
      },

      {
        name: "list_labels",
        title: "List Labels",
        description:
          "List all ProtonMail labels with message counts. Returns only labels (Labels/ prefix), not regular folders.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            labels: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  path: { type: "string" },
                  totalMessages: { type: "number" },
                  unreadMessages: { type: "number" },
                },
              },
            },
            count: { type: "number" },
          },
          required: ["labels", "count"],
        },
      },
      {
        name: "get_emails_by_label",
        title: "Get Emails by Label",
        description:
          "Fetch emails from a specific label folder. Shortcut for get_emails with folder set to Labels/<label>.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            label: { type: "string", description: "Label name without prefix (e.g. Work)" },
            limit: { type: "number", default: 50, description: "Emails per page, 1-200" },
            cursor: { type: "string", description: "Opaque cursor from previous response" },
          },
          required: ["label"],
        },
        outputSchema: {
          type: "object",
          properties: {
            emails: { type: "array", items: { type: "object" } },
            count: { type: "number" },
            folder: { type: "string" },
            nextCursor: { type: "string" },
          },
        },
      },

      // ── Folder Management ──────────────────────────────────────────────────
      {
        name: "get_folders",
        title: "Get Folders",
        description:
          "List all email folders with message counts. Labels appear as folders with the Labels/ prefix (e.g. Labels/Work).",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            folders: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  name: { type: "string" },
                  path: { type: "string" },
                  totalMessages: { type: "number" },
                  unreadMessages: { type: "number" },
                },
              },
            },
          },
          required: ["folders"],
        },
      },
      {
        name: "sync_folders",
        title: "Sync Folders",
        description: "Refresh the folder list from the IMAP server. Returns the updated count.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: { success: { type: "boolean" }, folderCount: { type: "number" } },
          required: ["success", "folderCount"],
        },
      },
      {
        name: "create_folder",
        title: "Create Folder",
        description:
          "Create a new email folder or label. Use Folders/Name for custom folders, Labels/Name for labels. Must exist before using move_to_label.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            folderName: {
              type: "string",
              description: "Folder path to create (e.g. Folders/Archive, Labels/Work)",
            },
          },
          required: ["folderName"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "delete_folder",
        title: "Delete Folder",
        description:
          "Delete an empty folder or label. Protected system folders (INBOX, Sent, Drafts, Trash, Spam, Archive) cannot be deleted.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            folderName: { type: "string", description: "Folder path to delete" },
          },
          required: ["folderName"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "rename_folder",
        title: "Rename Folder",
        description: "Rename a custom folder or label. Protected system folders cannot be renamed.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            oldName: { type: "string", description: "Current folder path" },
            newName: { type: "string", description: "New folder path" },
          },
          required: ["oldName", "newName"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },

      // ── Email Actions ──────────────────────────────────────────────────────
      {
        name: "mark_email_read",
        title: "Mark Email Read/Unread",
        description: "Set the read/unread status of an email. isRead defaults to true.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string" },
            isRead: { type: "boolean", default: true },
          },
          required: ["emailId"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "star_email",
        title: "Star / Unstar Email",
        description: "Toggle the starred (flagged) status of an email. isStarred defaults to true.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string" },
            isStarred: { type: "boolean", default: true },
          },
          required: ["emailId"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "move_email",
        title: "Move Email",
        description:
          "Move an email to a different folder. Common targets: Trash, Archive, Spam, INBOX, Folders/MyFolder.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string" },
            targetFolder: {
              type: "string",
              description: "Destination folder path (e.g. Trash, Archive, Folders/Work)",
            },
          },
          required: ["emailId", "targetFolder"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "archive_email",
        title: "Archive Email",
        description:
          "Move an email to the Archive folder. Convenience wrapper for move_email targeting Archive.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: { emailId: { type: "string" } },
          required: ["emailId"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "move_to_trash",
        title: "Move Email to Trash",
        description:
          "Move an email to the Trash folder. Convenience wrapper for move_email targeting Trash.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: { emailId: { type: "string" } },
          required: ["emailId"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "move_to_spam",
        title: "Move Email to Spam",
        description:
          "Move an email to the Spam folder. Convenience wrapper for move_email targeting Spam.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: { emailId: { type: "string" } },
          required: ["emailId"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "move_to_folder",
        title: "Move Email to Custom Folder",
        description:
          "Move an email to a custom folder (Folders/<name>). Similar to move_to_label but for Folders/ paths.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string" },
            folder: {
              type: "string",
              description: "Folder name without prefix (e.g. Work). Moves to Folders/Work.",
            },
          },
          required: ["emailId", "folder"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "bulk_mark_read",
        title: "Bulk Mark Emails Read/Unread",
        description:
          "Mark multiple emails as read or unread. Emits progress notifications. Returns success/failed counts.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: { type: "array", items: { type: "string" }, description: "Array of email UIDs" },
            isRead: { type: "boolean", default: true },
          },
          required: ["emailIds"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },
      {
        name: "bulk_star",
        title: "Bulk Star/Unstar Emails",
        description:
          "Star or unstar multiple emails. Emits progress notifications. Returns success/failed counts.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: { type: "array", items: { type: "string" }, description: "Array of email UIDs" },
            isStarred: { type: "boolean", default: true },
          },
          required: ["emailIds"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },
      {
        name: "bulk_move_emails",
        title: "Bulk Move Emails",
        description:
          "Move multiple emails to a folder in one call. Emits progress notifications if a progressToken is provided in _meta. Returns success/failed counts.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: {
              type: "array",
              items: { type: "string" },
              description: "Array of email UIDs to move",
            },
            targetFolder: { type: "string", description: "Destination folder path" },
          },
          required: ["emailIds", "targetFolder"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },
      {
        name: "move_to_label",
        title: "Move Email to Label",
        description:
          "Move an email into a label folder (Labels/LabelName). ProtonMail Bridge represents labels as IMAP folders — the email is moved, not tagged. Create the label folder first with create_folder if it does not exist.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string" },
            label: {
              type: "string",
              description: "Label name without prefix (e.g. Work). Moves to Labels/Work.",
            },
          },
          required: ["emailId", "label"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "bulk_move_to_label",
        title: "Bulk Move Emails to Label",
        description:
          "Move multiple emails into a label folder. Emits progress notifications if a progressToken is provided in _meta.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: { type: "array", items: { type: "string" } },
            label: { type: "string", description: "Label name without prefix" },
          },
          required: ["emailIds", "label"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },
      {
        name: "remove_label",
        title: "Remove Label from Email",
        description:
          "Remove a label from an email by moving it back to INBOX (or a specified target folder).",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailId: { type: "string" },
            label: { type: "string", description: "Label name to remove (e.g. Work)" },
            targetFolder: { type: "string", default: "INBOX", description: "Where to move the email (default: INBOX)" },
          },
          required: ["emailId", "label"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "bulk_remove_label",
        title: "Bulk Remove Label from Emails",
        description:
          "Remove a label from multiple emails by moving them back to INBOX (or a specified folder). Emits progress notifications.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: { type: "array", items: { type: "string" } },
            label: { type: "string", description: "Label name to remove" },
            targetFolder: { type: "string", default: "INBOX", description: "Where to move emails (default: INBOX)" },
          },
          required: ["emailIds", "label"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },
      {
        name: "delete_email",
        title: "Delete Email",
        description:
          "Permanently delete an email. This action cannot be undone. Consider move_email to Trash first.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: { emailId: { type: "string" } },
          required: ["emailId"],
        },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "bulk_delete_emails",
        title: "Bulk Delete Emails",
        description:
          "Permanently delete multiple emails. Irreversible. Emits progress notifications if a progressToken is provided in _meta. Returns success/failed counts.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: { type: "array", items: { type: "string" } },
          },
          required: ["emailIds"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },
      {
        name: "bulk_delete",
        title: "Bulk Delete Emails",
        description:
          "Alias for bulk_delete_emails. Permanently delete multiple emails. Irreversible.",
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
        inputSchema: {
          type: "object",
          properties: {
            emailIds: { type: "array", items: { type: "string" } },
          },
          required: ["emailIds"],
        },
        outputSchema: BULK_RESULT_SCHEMA,
      },

      // ── Analytics ──────────────────────────────────────────────────────────
      {
        name: "get_email_stats",
        title: "Get Email Statistics",
        description:
          "Aggregate statistics across inbox and sent: totals, unread count, most active contact, storage estimate. Results cached for 5 minutes.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            totalEmails: { type: "number" },
            unreadEmails: { type: "number" },
            starredEmails: { type: "number" },
            totalFolders: { type: "number" },
            totalContacts: { type: "number" },
            averageEmailsPerDay: { type: "number" },
            mostActiveContact: { type: "string" },
            mostUsedFolder: { type: "string" },
            storageUsedMB: { type: "number" },
          },
          required: ["totalEmails", "unreadEmails", "totalContacts"],
        },
      },
      {
        name: "get_email_analytics",
        title: "Get Email Analytics",
        description:
          "Advanced analytics across inbox and sent: top senders/recipients, peak activity hours, attachment stats, and measured response times (null when insufficient data). Results cached for 5 minutes.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            volumeTrends: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  date: { type: "string" },
                  received: { type: "number" },
                  sent: { type: "number" },
                },
              },
            },
            topSenders: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  count: { type: "number", description: "Number of emails received from this sender" },
                  lastContact: { type: "string", format: "date-time" },
                },
                required: ["email", "count", "lastContact"],
              },
            },
            topRecipients: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  count: { type: "number", description: "Number of emails sent to this recipient" },
                  lastContact: { type: "string", format: "date-time" },
                },
                required: ["email", "count", "lastContact"],
              },
            },
            responseTimeStats: {
              description: "Null when no sent replies could be matched to received emails.",
              oneOf: [
                {
                  type: "object",
                  properties: {
                    average: { type: "number", description: "Average hours" },
                    median: { type: "number" },
                    fastest: { type: "number" },
                    slowest: { type: "number" },
                    sampleSize: { type: "number" },
                  },
                  required: ["average", "median", "fastest", "slowest", "sampleSize"],
                },
                { type: "null" },
              ],
            },
            peakActivityHours: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  hour: { type: "number", description: "Hour of day (0–23)" },
                  count: { type: "number", description: "Number of emails in this hour" },
                },
                required: ["hour", "count"],
              },
            },
            attachmentStats: {
              type: "object",
              properties: {
                totalAttachments: { type: "number" },
                totalSizeMB: { type: "number" },
                averageSizeMB: { type: "number" },
                mostCommonTypes: {
                  type: "array",
                  items: {
                    type: "object",
                    properties: {
                      type: { type: "string", description: "MIME top-level type (e.g. image, application)" },
                      count: { type: "number" },
                    },
                    required: ["type", "count"],
                  },
                },
              },
              required: ["totalAttachments", "totalSizeMB", "averageSizeMB", "mostCommonTypes"],
            },
          },
          required: ["volumeTrends", "topSenders", "topRecipients"],
        },
      },
      {
        name: "get_contacts",
        title: "Get Contacts",
        description:
          "Extract contact list from email history with send/receive counts and last-interaction dates. Includes contacts from both inbox and sent folders.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            limit: { type: "number", description: "Max contacts to return", default: 100 },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            contacts: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  email: { type: "string" },
                  name: { type: "string", description: "Display name if available" },
                  emailsSent: { type: "number" },
                  emailsReceived: { type: "number" },
                  lastInteraction: { type: "string", format: "date-time" },
                  firstInteraction: { type: "string", format: "date-time" },
                  averageResponseTime: { type: "number", description: "Average response time in hours, if measurable" },
                  isFavorite: { type: "boolean" },
                },
                required: ["email", "emailsSent", "emailsReceived"],
              },
            },
          },
          required: ["contacts"],
        },
      },
      {
        name: "get_volume_trends",
        title: "Get Volume Trends",
        description: "Email volume per day (received and sent) over a time window. Default: last 30 days.",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            days: { type: "number", description: "Number of days to include", default: 30 },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            trends: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  date: { type: "string", description: "ISO 8601 date (YYYY-MM-DD)" },
                  received: { type: "number" },
                  sent: { type: "number" },
                },
                required: ["date", "received", "sent"],
              },
            },
          },
          required: ["trends"],
        },
      },

      // ── System & Maintenance ────────────────────────────────────────────────
      {
        name: "get_connection_status",
        title: "Get Connection Status",
        description: "Check whether SMTP and IMAP connections are active.",
        annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: {
          type: "object",
          properties: {
            smtp: {
              type: "object",
              properties: {
                connected: { type: "boolean" },
                host: { type: "string" },
                port: { type: "number" },
                lastCheck: { type: "string", format: "date-time" },
                insecureTls: { type: "boolean" },
                error: { type: "string", description: "Last SMTP error message, if any" },
              },
            },
            imap: {
              type: "object",
              properties: {
                connected: { type: "boolean" },
                healthy: { type: "boolean" },
                host: { type: "string" },
                port: { type: "number" },
                insecureTls: { type: "boolean" },
              },
            },
            settingsConfigured: { type: "boolean", description: "Whether a settings config file exists on disk" },
            settingsConfigPath: { type: "string", description: "Absolute path to the settings config file" },
          },
        },
      },
      {
        name: "sync_emails",
        title: "Sync Emails",
        description: "Manually pull latest emails from the IMAP server into the local cache.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          properties: {
            folder: { type: "string", description: "Folder to sync. Default: INBOX" },
            limit: { type: "number", description: "Max emails to fetch (1-500, default 100)", default: 100 },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            folder: { type: "string" },
            count: { type: "number" },
          },
          required: ["success", "folder", "count"],
        },
      },
      {
        name: "clear_cache",
        title: "Clear Cache",
        description: "Clear the email and analytics caches. Use when data appears stale.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
        inputSchema: { type: "object", properties: {} },
        outputSchema: ACTION_RESULT_SCHEMA,
      },
      {
        name: "get_logs",
        title: "Get Server Logs",
        description: "Retrieve recent server log entries filtered by level. Sensitive fields are redacted.",
        annotations: { readOnlyHint: true },
        inputSchema: {
          type: "object",
          properties: {
            level: {
              type: "string",
              enum: ["debug", "info", "warn", "error"],
              description: "Filter by log level",
            },
            limit: { type: "number", description: "Max entries (max 500)", default: 100 },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            logs: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  timestamp: { type: "string", format: "date-time" },
                  level: { type: "string", enum: ["debug", "info", "warn", "error"] },
                  context: { type: "string" },
                  message: { type: "string" },
                },
                required: ["timestamp", "level", "context", "message"],
              },
            },
          },
          required: ["logs"],
        },
      },

      // ── Drafts & Scheduling ────────────────────────────────────────────────
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
          "Queue an email for future delivery. The email will be sent automatically at send_at (ISO 8601). Must be at least 60 seconds in the future and no more than 30 days out. Returns a schedule ID.",
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
      {
        name: "download_attachment",
        title: "Download Attachment",
        description:
          "Download the binary content of an email attachment as a base64-encoded string. Use get_email_by_id first to see available attachments and their indices (0-based).",
        annotations: { readOnlyHint: true, openWorldHint: true },
        inputSchema: {
          type: "object",
          properties: {
            email_id: { type: "string", description: "IMAP UID of the email" },
            attachment_index: { type: "number", description: "0-based index of the attachment (from get_email_by_id attachments array)" },
          },
          required: ["email_id", "attachment_index"],
        },
        outputSchema: {
          type: "object",
          properties: {
            filename: { type: "string" },
            contentType: { type: "string" },
            size: { type: "number" },
            content: { type: "string", description: "Base64-encoded attachment content" },
            encoding: { type: "string", enum: ["base64"] },
          },
          required: ["filename", "contentType", "size", "content", "encoding"],
        },
      },

      // ── Permission Escalation (always-available meta-tools) ────────────────
      {
        name: "request_permission_escalation",
        title: "Request Permission Escalation",
        description:
          "Request an increase in the server's active permission preset. " +
          "YOU CANNOT APPROVE THIS YOURSELF — approval requires a human to open the " +
          "settings UI (http://localhost:8765) and click Approve. " +
          "Use check_escalation_status to poll for the result. " +
          "Downgrading (reducing access) never requires a challenge.",
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
        inputSchema: {
          type: "object",
          required: ["target_preset", "reason"],
          properties: {
            target_preset: {
              type: "string",
              enum: ["send_only", "supervised", "full"],
              description: "The preset you are requesting. Must be higher than the current preset.",
            },
            reason: {
              type: "string",
              description:
                "Why you need elevated permissions. Shown to the human verbatim. " +
                "Be specific — vague reasons are more likely to be denied.",
            },
          },
        },
      },
      {
        name: "check_escalation_status",
        title: "Check Escalation Status",
        description:
          "Check whether a pending permission escalation has been approved, denied, or has expired. " +
          "Poll this after calling request_permission_escalation.",
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
        inputSchema: {
          type: "object",
          required: ["challenge_id"],
          properties: {
            challenge_id: {
              type: "string",
              description: "The challenge ID returned by request_permission_escalation.",
            },
          },
        },
        outputSchema: {
          type: "object",
          properties: {
            status:        { type: "string", enum: ["pending", "approved", "denied", "expired", "not_found"] },
            targetPreset:  { type: "string" },
            currentPreset: { type: "string" },
            expiresAt:     { type: "string" },
            resolvedAt:    { type: ["string", "null"] },
            resolvedBy:    { type: ["string", "null"] },
            newTools:      { type: "array", items: { type: "string" } },
          },
        },
      },
    ],
  };
});

// ─── Tool Handlers ────────────────────────────────────────────────────────────

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;
  const progressToken = request.params._meta?.progressToken;

  const { body: _b, attachments: _a, password: _p, ...safeArgs } = args as Record<string, unknown>;
  logger.debug(`Tool: ${name}`, "MCPServer", safeArgs);

  // ── Always-available meta-tools (bypass permission gate) ─────────────────
  // These tools let the agent REQUEST more access — but they can never GRANT it.
  // Approval is strictly out-of-band (settings UI browser click or terminal).

  if (name === "request_permission_escalation") {
    const targetPreset = args.target_preset;
    const reason       = sanitizeText((args.reason as string | undefined) ?? "No reason provided", 500);
    if (!isValidEscalationTarget(targetPreset)) {
      return {
        content: [{ type: "text" as const, text: `Invalid target_preset. Must be one of: send_only, supervised, full` }],
        isError: true,
      };
    }
    const validatedPreset = targetPreset as PermissionPreset;
    const currentPreset = (loadConfig() ?? defaultConfig()).permissions.preset;
    if (!isUpgrade(currentPreset, validatedPreset)) {
      return {
        content: [{
          type: "text" as const,
          text: `'${targetPreset}' is not a higher privilege level than the current '${currentPreset}'. ` +
                `To reduce permissions, open the settings UI directly — no challenge required.`,
        }],
        isError: false,
      };
    }
    const result = requestEscalation(validatedPreset, currentPreset, reason);
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: result.error }], isError: true };
    }
    const settingsUrl = "http://localhost:8765";
    const newToolList = result.newTools.length > 0
      ? `\n\nNew tools that would be granted:\n${result.newTools.map(t => `  • ${t}`).join("\n")}`
      : "";
    return {
      content: [{
        type: "text" as const,
        text:
          `✅ Escalation request submitted.\n\n` +
          `Challenge ID : ${result.id}\n` +
          `Requesting   : ${currentPreset} → ${validatedPreset}\n` +
          `Expires at   : ${new Date(result.expiresAt).toLocaleString()}\n` +
          `${newToolList}\n\n` +
          `⚠️  A HUMAN MUST NOW APPROVE THIS.\n` +
          `Please ask the user to open ${settingsUrl} in their browser.\n` +
          `They will see a pending approval card — they must read what will be granted,\n` +
          `type APPROVE to confirm, and click the button.\n\n` +
          `Poll check_escalation_status with challenge_id "${result.id}" to know when it resolves.`,
      }],
      structuredContent: {
        challenge_id:      result.id,
        status:            "pending",
        targetPreset:      validatedPreset,
        currentPreset,
        expiresAt:         result.expiresAt,
        newTools:          result.newTools,
        unthrottledTools:  result.unthrottledTools,
        settingsUrl,
      },
    };
  }

  if (name === "check_escalation_status") {
    const challengeId = args.challenge_id;
    if (!isValidChallengeId(challengeId)) {
      return {
        content: [{ type: "text" as const, text: "challenge_id must be a 32-character lowercase hex string." }],
        isError: true,
      };
    }
    const record = getEscalationStatus(challengeId);
    if (!record) {
      return {
        content: [{ type: "text" as const, text: `No escalation found with ID '${challengeId}'.` }],
        structuredContent: { status: "not_found" },
      };
    }
    const statusMsg: Record<string, string> = {
      pending:  `Pending — waiting for human approval in the settings UI. Expires at ${new Date(record.expiresAt).toLocaleString()}.`,
      approved: `Approved ✅ The new preset '${record.targetPreset}' is now active (may take up to 15 s to propagate).`,
      denied:   `Denied ✗ The human declined the escalation request.`,
      expired:  `Expired — the 5-minute window passed without a decision. You may submit a new request.`,
    };
    return {
      content: [{ type: "text" as const, text: statusMsg[record.status] ?? record.status }],
      structuredContent: {
        status:       record.status,
        targetPreset: record.targetPreset,
        currentPreset: record.currentPreset,
        expiresAt:    record.expiresAt,
        resolvedAt:   record.resolvedAt,
        resolvedBy:   record.resolvedBy,
        newTools:     record.newTools,
      },
    };
  }

  // ── Permission gate ───────────────────────────────────────────────────────
  // Checked against ~/.protonmail-mcp.json (refreshed every 15 s).
  // If no config file exists the read-only preset is enforced — agents can
  // read and search but cannot send, move, delete, or modify email state.
  // Run `npm run settings` to open the settings UI and grant broader access.
  const permResult = permissions.check(name as ToolName);
  if (!permResult.allowed) {
    logger.warn(`Tool blocked by permission policy: ${name}`, "MCPServer", { reason: permResult.reason });
    return {
      content: [{ type: "text" as const, text: `Blocked: ${permResult.reason}` }],
      isError: true,
      structuredContent: { success: false, reason: permResult.reason },
    };
  }

  function ok(structured: Record<string, unknown>, text?: string) {
    return {
      content: [{ type: "text" as const, text: text ?? JSON.stringify(structured) }],
      structuredContent: structured,
    };
  }


  function actionOk(messageId?: string) {
    const sc = { success: true, ...(messageId ? { messageId } : {}) };
    return ok(sc, messageId ? `Sent. Message ID: ${messageId}` : "Done.");
  }

  function bulkOk(result: { success: number; failed: number; errors: string[] }) {
    return ok(result, `Completed: ${result.success} succeeded, ${result.failed} failed.${result.errors.length ? " Errors: " + result.errors.slice(0, 5).join("; ") : ""}`);
  }

  async function sendProgress(progress: number, total: number, message: string) {
    if (!progressToken) return;
    await server.notification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    });
  }

  try {
    switch (name) {

      // ── Sending ─────────────────────────────────────────────────────────────

      case "send_email": {
        const seAttErr = validateAttachments(args.attachments);
        if (seAttErr) throw new McpError(ErrorCode.InvalidParams, seAttErr);
        const result = await smtpService.sendEmail({
          to: args.to as string,
          cc: args.cc as string | undefined,
          bcc: args.bcc as string | undefined,
          subject: args.subject as string,
          body: args.body as string,
          isHtml: args.isHtml as boolean | undefined,
          priority: args.priority as "high" | "normal" | "low" | undefined,
          replyTo: args.replyTo as string | undefined,
          attachments: args.attachments as EmailAttachment[] | undefined,
        });
        if (!result.success) {
          return { content: [{ type: "text" as const, text: "Email delivery failed" }], isError: true, structuredContent: { success: false, reason: "Email delivery failed" } };
        }
        return actionOk(result.messageId);
      }

      case "reply_to_email": {
        const emailId = args.emailId as string;
        const original = await imapService.getEmailById(emailId);
        if (!original) {
          return { content: [{ type: "text" as const, text: "Original email not found" }], isError: true, structuredContent: { success: false, reason: "Original email not found" } };
        }

        // Build reply To from original From (strip display name to get address)
        const replyToAddress = original.from.match(/<([^>]+)>/)?.[1] ?? original.from.trim();

        // Sanitize subject from original email (could contain control chars from
        // a malicious sender) then prefix "Re:" — defense-in-depth before
        // passing to nodemailer which encodes RFC 2047 for non-ASCII anyway.
        const cleanSubject = original.subject.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
        const subject = cleanSubject.toLowerCase().startsWith("re:")
          ? cleanSubject
          : `Re: ${cleanSubject}`;

        // ReplyAll: include original To and CC (excluding self)
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
          return { content: [{ type: "text" as const, text: "Email delivery failed" }], isError: true, structuredContent: { success: false, reason: "Email delivery failed" } };
        }
        return actionOk(result.messageId);
      }

      case "forward_email": {
        const fwdId = args.emailId as string;
        const fwdOriginal = await imapService.getEmailById(fwdId);
        if (!fwdOriginal) {
          return { content: [{ type: "text" as const, text: "Original email not found" }], isError: true, structuredContent: { success: false, reason: "Original email not found" } };
        }

        const fwdCleanSubject = fwdOriginal.subject.replace(/[\r\n\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
        const fwdSubject = fwdCleanSubject.toLowerCase().startsWith("fwd:")
          ? fwdCleanSubject
          : `Fwd: ${fwdCleanSubject}`;

        const fwdHeader = [
          "---------- Forwarded message ----------",
          `From: ${fwdOriginal.from}`,
          `Date: ${fwdOriginal.date.toISOString()}`,
          `Subject: ${fwdCleanSubject}`,
          `To: ${(fwdOriginal.to ?? []).join(", ")}`,
          "",
        ].join("\n");

        const userMessage = args.message ? `${args.message as string}\n\n` : "";
        const fwdBody = `${userMessage}${fwdHeader}\n${fwdOriginal.body ?? ""}`;

        const fwdResult = await smtpService.sendEmail({
          to: args.to as string,
          subject: fwdSubject,
          body: fwdBody,
          isHtml: fwdOriginal.isHtml,
        });

        if (!fwdResult.success) {
          return { content: [{ type: "text" as const, text: "Forward failed" }], isError: true, structuredContent: { success: false, reason: "Email delivery failed" } };
        }
        return actionOk(fwdResult.messageId);
      }

      case "send_test_email": {
        // Validate recipient address at handler level for a clear early error,
        // consistent with the validation applied in send_email via smtpService.
        if (!isValidEmail(args.to as string)) {
          throw new McpError(ErrorCode.InvalidParams, `Invalid recipient email address: ${args.to}`);
        }
        const result = await smtpService.sendTestEmail(
          args.to as string,
          args.customMessage as string | undefined
        );
        if (!result.success) {
          return { content: [{ type: "text" as const, text: "Test email failed" }], isError: true, structuredContent: { success: false, reason: "Email delivery failed" } };
        }
        return actionOk(result.messageId);
      }

      // ── Reading ──────────────────────────────────────────────────────────────

      case "get_emails": {
        const folder = (args.folder as string) || "INBOX";
        // Validate folder before passing to IMAP — prevents path traversal (e.g. ../../etc).
        const geValidErr = validateTargetFolder(folder);
        if (geValidErr) throw new McpError(ErrorCode.InvalidParams, geValidErr);
        const limit = Math.min(Math.max(1, (args.limit as number) || 50), 200);

        // Decode cursor for offset, or start at 0
        let offset = 0;
        if (args.cursor) {
          const decoded = decodeCursor(args.cursor as string);
          if (!decoded || decoded.folder !== folder) {
            return { content: [{ type: "text" as const, text: "Invalid or expired cursor" }], isError: true, structuredContent: { success: false, reason: "Invalid cursor" } };
          }
          offset = decoded.offset;
        }

        const emails = await imapService.getEmails(folder, limit, offset);

        // Build nextCursor if we got a full page (more may exist)
        let nextCursor: string | undefined;
        if (emails.length === limit) {
          nextCursor = encodeCursor({ folder, offset: offset + limit, limit });
        }

        const structured = { emails, folder, count: emails.length, ...(nextCursor ? { nextCursor } : {}) };
        return ok(structured);
      }

      case "get_email_by_id": {
        const rawEmailId = requireNumericEmailId(args.emailId);
        const email = await imapService.getEmailById(rawEmailId);
        if (!email) {
          return { content: [{ type: "text" as const, text: "Email not found" }], isError: true, structuredContent: { success: false, reason: "Resource not found" } };
        }
        return ok(email as unknown as Record<string, unknown>);
      }

      case "search_emails": {
        const folder = (args.folder as string) || "INBOX";
        const folders = args.folders as string[] | undefined;
        // Guard free-text search fields against excessively long strings that could
        // produce oversized IMAP SEARCH commands (imapflow handles encoding; this is
        // a defence-in-depth limit, not an injection guard).
        const MAX_SEARCH_TEXT = 500;
        if (args.from && (args.from as string).length > MAX_SEARCH_TEXT) {
          throw new McpError(ErrorCode.InvalidParams, `'from' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
        }
        if (args.to && (args.to as string).length > MAX_SEARCH_TEXT) {
          throw new McpError(ErrorCode.InvalidParams, `'to' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
        }
        if (args.subject && (args.subject as string).length > MAX_SEARCH_TEXT) {
          throw new McpError(ErrorCode.InvalidParams, `'subject' filter must not exceed ${MAX_SEARCH_TEXT} characters.`);
        }
        const results = await imapService.searchEmails({
          folder: folders ? undefined : folder,
          folders,
          from: args.from as string | undefined,
          to: args.to as string | undefined,
          subject: args.subject as string | undefined,
          hasAttachment: args.hasAttachment as boolean | undefined,
          isRead: args.isRead as boolean | undefined,
          isStarred: args.isStarred as boolean | undefined,
          dateFrom: args.dateFrom as string | undefined,
          dateTo: args.dateTo as string | undefined,
          limit: Math.min(Math.max(1, (args.limit as number) || 50), 200),
        });
        const searchedIn = folders ? folders.join(", ") : folder;
        return ok({ emails: results, count: results.length, folder: searchedIn });
      }

      case "get_unread_count": {
        const folders = await imapService.getFolders();
        const unreadByFolder: Record<string, number> = {};
        let totalUnread = 0;
        for (const f of folders) {
          unreadByFolder[f.path] = f.unreadMessages;
          totalUnread += f.unreadMessages;
        }
        return ok({ unreadByFolder, totalUnread });
      }

      case "list_labels": {
        const allFolders = await imapService.getFolders();
        const labels = allFolders.filter((f: any) => f.path?.startsWith("Labels/"));
        return ok({ labels, count: labels.length });
      }

      case "get_emails_by_label": {
        const lblName = args.label as string;
        // Validate label before constructing the IMAP folder path — prevents
        // path traversal attacks such as Labels/../INBOX.
        const lblValidErr = validateLabelName(lblName);
        if (lblValidErr) throw new McpError(ErrorCode.InvalidParams, lblValidErr);
        const lblFolder = `Labels/${lblName}`;
        const lblLimit = Math.min(Math.max((args.limit as number) || 50, 1), 200);

        let lblOffset = 0;
        if (args.cursor) {
          const decoded = decodeCursor(args.cursor as string);
          if (!decoded || decoded.folder !== lblFolder) {
            return { content: [{ type: "text" as const, text: "Invalid or expired cursor" }], isError: true, structuredContent: { success: false, reason: "Invalid cursor" } };
          }
          lblOffset = decoded.offset;
        }

        const lblEmails = await imapService.getEmails(lblFolder, lblLimit, lblOffset);
        let lblNextCursor: string | undefined;
        if (lblEmails.length === lblLimit) {
          lblNextCursor = encodeCursor({ folder: lblFolder, offset: lblOffset + lblLimit, limit: lblLimit });
        }

        const lblStructured = { emails: lblEmails, folder: lblFolder, count: lblEmails.length, ...(lblNextCursor ? { nextCursor: lblNextCursor } : {}) };
        return ok(lblStructured);
      }

      // ── Drafts & Scheduling ───────────────────────────────────────────────────

      case "save_draft": {
        const sdAttErr = validateAttachments(args.attachments);
        if (sdAttErr) throw new McpError(ErrorCode.InvalidParams, sdAttErr);
        const draftResult = await imapService.saveDraft({
          to: args.to as string | undefined,
          cc: args.cc as string | undefined,
          bcc: args.bcc as string | undefined,
          subject: args.subject as string | undefined,
          body: args.body as string | undefined,
          isHtml: args.isHtml as boolean | undefined,
          attachments: args.attachments as EmailAttachment[] | undefined,
          inReplyTo: args.inReplyTo as string | undefined,
          references: args.references as string[] | undefined,
        });
        if (!draftResult.success) {
          return { content: [{ type: "text" as const, text: `Failed to save draft: ${draftResult.error}` }], isError: true, structuredContent: { success: false, reason: draftResult.error } };
        }
        return ok({ success: true, uid: draftResult.uid }, `Draft saved (UID: ${draftResult.uid ?? "unknown"})`);
      }

      case "schedule_email": {
        const schAttErr = validateAttachments(args.attachments);
        if (schAttErr) throw new McpError(ErrorCode.InvalidParams, schAttErr);
        const sendAtStr = args.send_at as string;
        if (!sendAtStr) {
          return { content: [{ type: "text" as const, text: "send_at is required" }], isError: true, structuredContent: { success: false, reason: "send_at is required" } };
        }
        const sendAt = new Date(sendAtStr);
        if (isNaN(sendAt.getTime())) {
          return { content: [{ type: "text" as const, text: `Invalid send_at date: ${sendAtStr}` }], isError: true, structuredContent: { success: false, reason: "Invalid date" } };
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
            attachments: args.attachments as EmailAttachment[] | undefined,
          }, sendAt);
          return ok({ success: true, id: schedId, scheduledAt: sendAt.toISOString() },
            `Scheduled for ${sendAt.toISOString()} (ID: ${schedId})`);
        } catch (err: any) {
          return { content: [{ type: "text" as const, text: err.message }], isError: true, structuredContent: { success: false, reason: err.message } };
        }
      }

      case "list_scheduled_emails": {
        const allScheduled = schedulerService.list();
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
      }

      case "cancel_scheduled_email": {
        const cancelled = schedulerService.cancel(args.id as string);
        if (!cancelled) {
          return { content: [{ type: "text" as const, text: "Not found or not pending" }], isError: true, structuredContent: { success: false, reason: "Not found or not pending" } };
        }
        return actionOk();
      }

      case "download_attachment": {
        const rawAttEmailId = requireNumericEmailId(args.email_id, "email_id");
        const rawAttIdx = args.attachment_index as number;
        if (!Number.isInteger(rawAttIdx) || rawAttIdx < 0) {
          throw new McpError(ErrorCode.InvalidParams, "attachment_index must be a non-negative integer.");
        }
        const attResult = await imapService.downloadAttachment(rawAttEmailId, rawAttIdx);
        if (!attResult) {
          return { content: [{ type: "text" as const, text: "Attachment not found" }], isError: true, structuredContent: { success: false, reason: "Attachment not found" } };
        }
        return ok(attResult, `Attachment: ${attResult.filename} (${attResult.contentType}, ${attResult.size} bytes)`);
      }

      // ── Folder Management ─────────────────────────────────────────────────────

      case "get_folders": {
        const folders = await imapService.getFolders();
        return ok({ folders });
      }

      case "sync_folders": {
        const folders = await imapService.getFolders();
        return ok({ success: true, folderCount: folders.length });
      }

      case "create_folder": {
        // Validate folderName before passing to IMAP — returns clean McpError
        // rather than letting the service throw a raw Error.
        const cfValidErr = validateFolderName(args.folderName);
        if (cfValidErr) throw new McpError(ErrorCode.InvalidParams, cfValidErr);
        await imapService.createFolder(args.folderName as string);
        return actionOk();
      }

      case "delete_folder": {
        const dfValidErr = validateFolderName(args.folderName);
        if (dfValidErr) throw new McpError(ErrorCode.InvalidParams, dfValidErr);
        await imapService.deleteFolder(args.folderName as string);
        return actionOk();
      }

      case "rename_folder": {
        const rfOldErr = validateFolderName(args.oldName);
        if (rfOldErr) throw new McpError(ErrorCode.InvalidParams, `oldName: ${rfOldErr}`);
        const rfNewErr = validateFolderName(args.newName);
        if (rfNewErr) throw new McpError(ErrorCode.InvalidParams, `newName: ${rfNewErr}`);
        await imapService.renameFolder(args.oldName as string, args.newName as string);
        return actionOk();
      }

      // ── Email Actions ──────────────────────────────────────────────────────────

      case "mark_email_read": {
        const merEmailId = requireNumericEmailId(args.emailId);
        const isRead = args.isRead !== undefined ? (args.isRead as boolean) : true;
        await imapService.markEmailRead(merEmailId, isRead);
        return actionOk();
      }

      case "star_email": {
        const seEmailId = requireNumericEmailId(args.emailId);
        const isStarred = args.isStarred !== undefined ? (args.isStarred as boolean) : true;
        await imapService.starEmail(seEmailId, isStarred);
        return actionOk();
      }

      case "move_email": {
        // Validate emailId format — must be a numeric UID string.
        const mvEmailId = requireNumericEmailId(args.emailId);
        // Validate targetFolder before passing to IMAP — prevents path traversal
        // attacks such as "../../etc/passwd" style folder names.
        const mvValidErr = validateTargetFolder(args.targetFolder);
        if (mvValidErr) throw new McpError(ErrorCode.InvalidParams, mvValidErr);
        await imapService.moveEmail(mvEmailId, args.targetFolder as string);
        return actionOk();
      }

      case "archive_email": {
        const aeEmailId = requireNumericEmailId(args.emailId);
        await imapService.moveEmail(aeEmailId, "Archive");
        return actionOk();
      }

      case "move_to_trash": {
        const mttEmailId = requireNumericEmailId(args.emailId);
        await imapService.moveEmail(mttEmailId, "Trash");
        return actionOk();
      }

      case "move_to_spam": {
        const mtsEmailId = requireNumericEmailId(args.emailId);
        await imapService.moveEmail(mtsEmailId, "Spam");
        return actionOk();
      }

      case "move_to_folder": {
        const folderName = args.folder as string;
        // Validate folder name before constructing the IMAP folder path — prevents
        // path traversal attacks like "Folders/../INBOX".
        const folderValidErr = validateFolderName(folderName);
        if (folderValidErr) throw new McpError(ErrorCode.InvalidParams, folderValidErr);
        await imapService.moveEmail(args.emailId as string, `Folders/${folderName}`);
        return actionOk();
      }

      case "bulk_mark_read": {
        const bmrIds = Array.isArray(args.emailIds) ? args.emailIds : [];
        const bmrEmailIds: string[] = bmrIds
          .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
          .slice(0, MAX_BULK_IDS);
        const bmrIsRead = args.isRead !== undefined ? (args.isRead as boolean) : true;
        const bmrTotal = bmrEmailIds.length;
        const bmrResults = { success: 0, failed: 0, errors: [] as string[] };

        for (let i = 0; i < bmrEmailIds.length; i++) {
          try {
            await imapService.markEmailRead(bmrEmailIds[i], bmrIsRead);
            bmrResults.success++;
          } catch (e: any) {
            bmrResults.failed++;
            bmrResults.errors.push(`${bmrEmailIds[i]}: ${safeErrorMessage(e)}`);
          }
          await sendProgress(i + 1, bmrTotal, `Marked ${i + 1} of ${bmrTotal}`);
        }
        return bulkOk(bmrResults);
      }

      case "bulk_star": {
        const bsIds = Array.isArray(args.emailIds) ? args.emailIds : [];
        const bsEmailIds: string[] = bsIds
          .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
          .slice(0, MAX_BULK_IDS);
        const bsIsStarred = args.isStarred !== undefined ? (args.isStarred as boolean) : true;
        const bsTotal = bsEmailIds.length;
        const bsResults = { success: 0, failed: 0, errors: [] as string[] };

        for (let i = 0; i < bsEmailIds.length; i++) {
          try {
            await imapService.starEmail(bsEmailIds[i], bsIsStarred);
            bsResults.success++;
          } catch (e: any) {
            bsResults.failed++;
            bsResults.errors.push(`${bsEmailIds[i]}: ${safeErrorMessage(e)}`);
          }
          await sendProgress(i + 1, bsTotal, `Starred ${i + 1} of ${bsTotal}`);
        }
        return bulkOk(bsResults);
      }

      case "bulk_move_emails": {
        // Validate targetFolder before touching any email — same guards as move_email.
        const bmValidErr = validateTargetFolder(args.targetFolder);
        if (bmValidErr) throw new McpError(ErrorCode.InvalidParams, bmValidErr);
        // Validate and sanitize input — reject non-string and non-numeric IDs, cap array size
        const rawIds = Array.isArray(args.emailIds) ? args.emailIds : [];
        const emailIds: string[] = rawIds
          .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
          .slice(0, MAX_BULK_IDS);
        const targetFolder = args.targetFolder as string;
        const total = emailIds.length;
        const results = { success: 0, failed: 0, errors: [] as string[] };

        for (let i = 0; i < emailIds.length; i++) {
          try {
            await imapService.moveEmail(emailIds[i], targetFolder);
            results.success++;
          } catch (e: any) {
            results.failed++;
            results.errors.push(`${emailIds[i]}: ${safeErrorMessage(e)}`);
          }
          await sendProgress(i + 1, total, `Moved ${i + 1} of ${total}`);
        }

        analyticsCache = null; analyticsCacheInflight = null; // invalidate
        return bulkOk(results);
      }

      case "move_to_label": {
        const mtlEmailId = requireNumericEmailId(args.emailId);
        const label = args.label as string;
        // Validate label before constructing the IMAP folder path — prevents
        // path traversal attacks such as Labels/../INBOX.
        const mtlValidErr = validateLabelName(label);
        if (mtlValidErr) throw new McpError(ErrorCode.InvalidParams, mtlValidErr);
        await imapService.moveEmail(mtlEmailId, `Labels/${label}`);
        return actionOk();
      }

      case "bulk_move_to_label": {
        const rawIds2 = Array.isArray(args.emailIds) ? args.emailIds : [];
        const emailIds2: string[] = rawIds2
          .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
          .slice(0, MAX_BULK_IDS);
        const rawLabel = args.label as string;
        // Validate label before constructing the IMAP folder path — prevents
        // path traversal attacks such as Labels/../INBOX.
        const bmlValidErr = validateLabelName(rawLabel);
        if (bmlValidErr) throw new McpError(ErrorCode.InvalidParams, bmlValidErr);
        const labelFolder = `Labels/${rawLabel}`;
        const total2 = emailIds2.length;
        const results2 = { success: 0, failed: 0, errors: [] as string[] };

        for (let i = 0; i < emailIds2.length; i++) {
          try {
            await imapService.moveEmail(emailIds2[i], labelFolder);
            results2.success++;
          } catch (e: any) {
            results2.failed++;
            results2.errors.push(`${emailIds2[i]}: ${safeErrorMessage(e)}`);
          }
          await sendProgress(i + 1, total2, `Labeled ${i + 1} of ${total2}`);
        }

        analyticsCache = null; analyticsCacheInflight = null;
        return bulkOk(results2);
      }

      case "remove_label": {
        const rlEmailId = requireNumericEmailId(args.emailId);
        const rlRawTarget = args.targetFolder as string | undefined;
        // Validate caller-supplied targetFolder before use as an IMAP path.
        // Default to INBOX when omitted; reject control characters and path traversal.
        const rlValidErr = validateTargetFolder(rlRawTarget);
        if (rlValidErr) throw new McpError(ErrorCode.InvalidParams, rlValidErr);
        const rlTarget = rlRawTarget || "INBOX";
        await imapService.moveEmail(rlEmailId, rlTarget);
        return actionOk();
      }

      case "bulk_remove_label": {
        const brlIds = Array.isArray(args.emailIds) ? args.emailIds : [];
        const brlEmailIds: string[] = brlIds
          .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
          .slice(0, MAX_BULK_IDS);
        const brlRawTarget = args.targetFolder as string | undefined;
        // Validate caller-supplied targetFolder — same guards as remove_label.
        const brlValidErr = validateTargetFolder(brlRawTarget);
        if (brlValidErr) throw new McpError(ErrorCode.InvalidParams, brlValidErr);
        const brlTarget = brlRawTarget || "INBOX";
        const brlTotal = brlEmailIds.length;
        const brlResults = { success: 0, failed: 0, errors: [] as string[] };

        for (let i = 0; i < brlEmailIds.length; i++) {
          try {
            await imapService.moveEmail(brlEmailIds[i], brlTarget);
            brlResults.success++;
          } catch (e: any) {
            brlResults.failed++;
            brlResults.errors.push(`${brlEmailIds[i]}: ${safeErrorMessage(e)}`);
          }
          await sendProgress(i + 1, brlTotal, `Unlabeled ${i + 1} of ${brlTotal}`);
        }

        analyticsCache = null; analyticsCacheInflight = null;
        return bulkOk(brlResults);
      }

      case "delete_email": {
        const deEmailId = requireNumericEmailId(args.emailId);
        await imapService.deleteEmail(deEmailId);
        analyticsCache = null; analyticsCacheInflight = null;
        return actionOk();
      }

      case "bulk_delete":
      case "bulk_delete_emails": {
        const rawIds3 = Array.isArray(args.emailIds) ? args.emailIds : [];
        const emailIds3: string[] = rawIds3
          .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
          .slice(0, MAX_BULK_IDS);
        const total3 = emailIds3.length;
        const results3 = { success: 0, failed: 0, errors: [] as string[] };

        for (let i = 0; i < emailIds3.length; i++) {
          try {
            await imapService.deleteEmail(emailIds3[i]);
            results3.success++;
          } catch (e: any) {
            results3.failed++;
            results3.errors.push(`${emailIds3[i]}: ${safeErrorMessage(e)}`);
          }
          await sendProgress(i + 1, total3, `Deleted ${i + 1} of ${total3}`);
        }

        analyticsCache = null; analyticsCacheInflight = null;
        return bulkOk(results3);
      }

      // ── Analytics ──────────────────────────────────────────────────────────────

      case "get_email_stats": {
        await getAnalyticsEmails();
        const stats = analyticsService.getEmailStats();
        return ok(stats as unknown as Record<string, unknown>);
      }

      case "get_email_analytics": {
        await getAnalyticsEmails();
        const analytics = analyticsService.getEmailAnalytics();
        return ok(analytics as unknown as Record<string, unknown>);
      }

      case "get_contacts": {
        await getAnalyticsEmails();
        const contacts = analyticsService.getContacts(args.limit as number | undefined);
        return ok({ contacts });
      }

      case "get_volume_trends": {
        await getAnalyticsEmails();
        const trends = analyticsService.getVolumeTrends(args.days as number | undefined);
        return ok({ trends });
      }

      // ── System ─────────────────────────────────────────────────────────────────

      case "get_connection_status": {
        const { configExists, getConfigPath } = await import("./config/loader.js");
        const status = {
          smtp: {
            connected: smtpStatus.connected,
            host: config.smtp.host,
            port: config.smtp.port,
            lastCheck: smtpStatus.lastCheck.toISOString(),
            insecureTls: smtpService.insecureTls,
            ...(smtpStatus.error ? { error: smtpStatus.error } : {}),
          },
          imap: {
            connected: imapService.isActive(),
            healthy: await imapService.healthCheck(),
            host: config.imap.host,
            port: config.imap.port,
            insecureTls: imapService.insecureTls,
          },
          settingsConfigured: configExists(),
          settingsConfigPath: getConfigPath(),
        };
        return ok(status);
      }

      case "sync_emails": {
        const folder = (args.folder as string) || "INBOX";
        const limit = Math.min(Math.max(1, (args.limit as number) || 100), 500);
        const emails = await imapService.getEmails(folder, limit);
        analyticsCache = null; analyticsCacheInflight = null; // force analytics refresh on next request
        return ok({ success: true, folder, count: emails.length });
      }

      case "clear_cache": {
        imapService.clearCache();
        analyticsService.clearCache();
        analyticsCache = null; analyticsCacheInflight = null;
        return actionOk();
      }

      case "get_logs": {
        const VALID_LEVELS = new Set(["debug", "info", "warn", "error"]);
        const rawLevel = args.level as string | undefined;
        const level = rawLevel && VALID_LEVELS.has(rawLevel)
          ? (rawLevel as "debug" | "info" | "warn" | "error")
          : undefined;
        const rawLimit = typeof args.limit === "number" ? args.limit : 100;
        const limit   = Math.min(Math.max(1, Math.trunc(rawLimit)), 500);
        const logs    = logger.getLogs(level, limit);
        return ok({ logs });
      }

      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
  } catch (error: any) {
    logger.error(`Tool failed: ${name}`, "MCPServer", error);
    const msg = safeErrorMessage(error);
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      structuredContent: { success: false, reason: msg },
      isError: true,
    };
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// RESOURCES
// ═════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Expose the INBOX folder as a listable resource; agents can also use templates for specific emails
  try {
    const folders = await imapService.getFolders();
    return {
      resources: folders.map((f) => ({
        uri: `folder://${encodeURIComponent(f.path)}`,
        name: f.name,
        title: `${f.name} (${f.unreadMessages} unread / ${f.totalMessages} total)`,
        description: `Email folder: ${f.path}`,
        mimeType: "application/json",
        annotations: { audience: ["assistant"] as ("assistant" | "user")[] },
      })),
    };
  } catch {
    return { resources: [] };
  }
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "email://{folder}/{id}",
      name: "Email Message",
      title: "Individual Email",
      description:
        "Full content of a specific email. folder = IMAP folder path (e.g. INBOX), id = numeric UID from get_emails.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "folder://{path}",
      name: "Email Folder",
      title: "Email Folder",
      description:
        "Folder metadata and message counts. path = URL-encoded folder path (e.g. INBOX, Folders%2FWork).",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  // email://{folder}/{id}
  const emailMatch = uri.match(/^email:\/\/([^/]+)\/(\d+)$/);
  if (emailMatch) {
    let folder: string;
    try {
      folder = decodeURIComponent(emailMatch[1]);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Malformed percent-encoding in resource URI: ${uri}`);
    }
    const id = emailMatch[2];
    const email = await imapService.getEmailById(id);
    if (!email) {
      throw new McpError(ErrorCode.InvalidRequest, `Email not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(email, null, 2),
          annotations: {
            audience: ["assistant"] as ("assistant" | "user")[],
            priority: 0.9,
            lastModified: email.date instanceof Date ? email.date.toISOString() : String(email.date),
          },
        },
      ],
    };
  }

  // folder://{path}
  const folderMatch = uri.match(/^folder:\/\/(.+)$/);
  if (folderMatch) {
    let path: string;
    try {
      path = decodeURIComponent(folderMatch[1]);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Malformed percent-encoding in resource URI: ${uri}`);
    }
    const folders = await imapService.getFolders();
    const folder = path === ""
      ? null  // list-all case
      : folders.find((f) => f.path === path || f.name === path);

    if (path !== "" && !folder) {
      throw new McpError(ErrorCode.InvalidRequest, `Folder not found: ${path}`);
    }

    const payload = path === "" ? { folders } : folder;
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
          annotations: { audience: ["assistant"] as ("assistant" | "user")[], priority: 0.7 },
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unsupported resource URI: ${uri}`);
});

// ═════════════════════════════════════════════════════════════════════════════
// PROMPTS
// ═════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "triage_inbox",
      title: "Triage Inbox",
      description:
        "Review unread emails, assess urgency, and suggest actions (reply / archive / delete / snooze). Uses available tools to act on approved decisions.",
      arguments: [
        { name: "limit", description: "Max emails to review (default 20)", required: false },
        { name: "focus", description: "Sender or topic to prioritize", required: false },
      ],
    },
    {
      name: "compose_reply",
      title: "Compose Reply",
      description: "Draft a reply to a specific email, preserving thread context and tone.",
      arguments: [
        { name: "emailId", description: "UID of the email to reply to", required: true },
        { name: "intent", description: "What the reply should say or accomplish", required: false },
      ],
    },
    {
      name: "daily_briefing",
      title: "Daily Email Briefing",
      description:
        "Summarize today's inbox: unread count, key senders, action items, and any calendar or deadline mentions.",
      arguments: [],
    },
    {
      name: "find_subscriptions",
      title: "Find Subscriptions & Newsletters",
      description:
        "Identify bulk sender / newsletter / subscription emails in the inbox and offer to archive or delete them.",
      arguments: [
        { name: "folder", description: "Folder to search (default: INBOX)", required: false },
      ],
    },
    {
      name: "thread_summary",
      title: "Summarize Email Thread",
      description:
        "Fetch all messages related to a thread and produce a concise summary with open action items.",
      arguments: [
        { name: "emailId", description: "UID of any message in the thread", required: true },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "triage_inbox": {
      const limit = parseInt((args.limit as string) || "20", 10);
      // Sanitize agent-supplied focus to prevent prompt injection.
      const focus = args.focus ? sanitizeText(args.focus as string, 200) : undefined;
      let emails: EmailMessage[] = [];
      try {
        emails = await imapService.getEmails("INBOX", limit);
      } catch { /* IMAP not connected — prompt will still guide the user */ }
      const unread = emails.filter((e) => !e.isRead);

      return {
        description: "Inbox triage session",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are managing a ProtonMail inbox. ${focus ? `Prioritise emails from/about: ${focus}.` : ""}

${unread.length > 0
  ? `Here are ${unread.length} unread emails to review:\n\n${JSON.stringify(
      unread.map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        hasAttachment: e.hasAttachment,
        preview: e.bodyPreview,
      })),
      null,
      2
    )}`
  : "The inbox appears empty or could not be loaded. Use get_emails to fetch emails first."}

For each email, assess:
1. Urgency: urgent / normal / low
2. Suggested action: reply_needed / archive / delete / forward / snooze
3. If reply_needed: one-sentence draft response

After presenting your assessment, wait for the user to approve actions, then use the available tools (reply_to_email, archive_email, delete_email, move_email) to carry them out.`,
            },
          },
        ],
      };
    }

    case "compose_reply": {
      // Validate emailId early so we never embed an adversarial string in the prompt.
      const emailId = requireNumericEmailId(args.emailId);
      // Sanitize agent-supplied intent to prevent prompt injection.
      const intent = sanitizeText(args.intent, 200);
      let emailContent = "Could not load email — use get_email_by_id to fetch it first.";
      try {
        const email = await imapService.getEmailById(emailId);
        if (email) {
          emailContent = JSON.stringify(
            {
              from: email.from,
              subject: email.subject,
              date: email.date,
              // Body is truncated to prevent prompt token explosion and injection risk.
              // Full content is available via get_email_by_id if needed.
              body: truncateEmailBody(email.body, 2000),
            },
            null,
            2
          );
        }
      } catch { /* ignore */ }

      return {
        description: "Compose a reply",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Draft a reply to the following email${intent ? ` with this intent: ${intent}` : ""}.

Match the tone and formality of the original. Keep it concise.

Original email:
${emailContent}

When ready, use reply_to_email with emailId="${emailId}" to send.`,
            },
          },
        ],
      };
    }

    case "daily_briefing": {
      let emails: EmailMessage[] = [];
      try {
        emails = await imapService.getEmails("INBOX", 50);
      } catch { /* ignore */ }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEmails = emails.filter(
        (e) => e.date && new Date(e.date) >= today
      );
      const unread = emails.filter((e) => !e.isRead);

      return {
        description: "Daily email briefing",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Produce a concise daily briefing for this inbox.

Total unread: ${unread.length}
Emails arriving today: ${todayEmails.length}

${emails.length > 0
  ? `Most recent emails:\n${JSON.stringify(
      emails.slice(0, 20).map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        isRead: e.isRead,
        preview: e.bodyPreview,
      })),
      null,
      2
    )}`
  : "No emails loaded. Use get_emails to fetch inbox."}

Structure the briefing as:
- Summary (2-3 sentences)
- Key contacts / senders
- Action items requiring reply
- FYI / informational only
- Anything that looks time-sensitive`,
            },
          },
        ],
      };
    }

    case "find_subscriptions": {
      const folder = (args.folder as string) || "INBOX";
      let emails: EmailMessage[] = [];
      try {
        emails = await imapService.getEmails(folder, 100);
      } catch { /* ignore */ }

      // Cap at 50 entries and truncate subjects to prevent prompt size explosion
      const emailSummaries = emails.slice(0, 50).map((e) => ({
        id: e.id,
        from: e.from.substring(0, 100),
        subject: (e.subject || "").substring(0, 120),
        date: e.date,
      }));

      return {
        description: "Find and manage subscriptions",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Review these ${emailSummaries.length} emails from ${folder} and identify bulk senders, newsletters, and subscription emails.

${JSON.stringify(emailSummaries, null, 2)}

Group them by sender domain and present a list of:
1. Confirmed subscriptions / newsletters (safe to archive or delete)
2. Transactional emails (receipts, notifications — keep or archive)
3. Personal / important emails (do not touch)

After the user reviews, use bulk_delete_emails or bulk_move_emails to take action on approved groups.`,
            },
          },
        ],
      };
    }

    case "thread_summary": {
      const emailId = args.emailId as string;
      let emailContent = "Could not load the email.";
      try {
        const email = await imapService.getEmailById(emailId);
        if (email) {
          // Truncate body to prevent prompt token explosion and injection risk.
          const safeEmail = {
            ...email,
            body: truncateEmailBody(email.body, 2000),
            attachments: email.attachments?.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
          };
          emailContent = JSON.stringify(safeEmail, null, 2);
        }
      } catch { /* ignore */ }

      return {
        description: "Summarize email thread",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Summarize the following email thread. If there are earlier messages referenced, use search_emails to find them (search by subject or sender).

Starting email (ID: ${emailId}):
${emailContent}

Produce:
- One-paragraph summary of the conversation
- Key decisions or agreements made
- Open questions or action items
- Who needs to respond next (if applicable)`,
            },
          },
        ],
      };
    }

    default:
      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STARTUP & LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

async function main() {
  logger.info("Starting Proton Mail MCP Server v2.0.0", "MCPServer");

  // Migrate plaintext credentials to OS keychain if available
  try {
    const migrated = await migrateCredentials();
    if (migrated) {
      logger.info("Credentials migrated to OS keychain", "MCPServer");
    }
  } catch (e) {
    logger.debug("Keychain migration skipped (not available or no credentials to migrate)", "MCPServer");
  }

  try {
    logger.info("Verifying SMTP connection...", "MCPServer");
    try {
      await smtpService.verifyConnection();
      smtpStatus = { connected: true, lastCheck: new Date() };
      logger.info("SMTP connection verified", "MCPServer");
    } catch (e: any) {
      smtpStatus = { connected: false, lastCheck: new Date(), error: safeErrorMessage(e) };
      logger.warn("SMTP connection failed — sending features limited", "MCPServer", e);
      logger.info("Use your Proton Bridge password (not your ProtonMail account password)", "MCPServer");
    }

    logger.info("Connecting to IMAP (Proton Bridge)...", "MCPServer");
    try {
      await imapService.connect(
        config.imap.host,
        config.imap.port,
        config.imap.username,
        config.imap.password,
        config.imap.bridgeCertPath
      );
      logger.info("IMAP connection established", "MCPServer");
    } catch (e) {
      logger.warn("IMAP connection failed — reading features limited", "MCPServer", e);
      logger.info("Ensure Proton Bridge is running on localhost:1143", "MCPServer");
    }

    // Start the email scheduler (loads persisted pending emails, begins 60s poll)
    schedulerService.start();

    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info("Proton Mail MCP Server started. Tools, Resources, and Prompts are available.", "MCPServer");
  } catch (error) {
    logger.error("Server startup failed", "MCPServer", error);
    process.exit(1);
  }
}

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", "MCPServer", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", "MCPServer", reason);
  process.exit(1);
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`, "MCPServer");
  try {
    // 1. Stop scheduler (persists pending items before close)
    schedulerService.stop();

    // 2. Disconnect services
    await imapService.disconnect();
    await smtpService.close();

    // 3. Scrub sensitive data from memory
    imapService.wipeCache();
    analyticsService.wipeData();
    smtpService.wipeCredentials();

    // 4. Wipe top-level config credentials
    if (config?.smtp) {
      config.smtp.password = "";
      config.smtp.username = "";
      config.smtp.smtpToken = "";
    }
    if (config?.imap) {
      config.imap.password = "";
      config.imap.username = "";
    }

    logger.info("Shutdown complete (memory scrubbed)", "MCPServer");
    process.exit(0);
  } catch (error) {
    logger.error(`Error during ${signal} shutdown`, "MCPServer", error);
    process.exit(1);
  }
}

// Last-resort wipe on any exit path
process.on("exit", () => {
  try {
    imapService.wipeCache();
    analyticsService.wipeData();
    smtpService.wipeCredentials();
  } catch { /* best-effort */ }
});

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

main().catch((error) => {
  logger.error("Fatal server error", "MCPServer", error);
  process.exit(1);
});
