/**
 * Reading tools.
 *
 * The ListTools order in the pre-refactor index.ts interleaves reading
 * definitions with other categories:
 *   - The "early" reading group (get_emails … get_emails_by_label) appears
 *     immediately after Sending, before Folders / Actions / Deletion /
 *     Analytics / System / Bridge / Aliases / Pass / Drafts.
 *   - The "late" reading group (download_attachment … extract_meeting)
 *     appears after Drafts and before Escalation.
 *
 * Preserving the historical ordering is load-bearing — ListTools output
 * ordering affects client-side system prompts. The registry splices these
 * two arrays in at the correct positions. `defs` below is the concatenated
 * full list; `defsEarly` / `defsLate` expose the split for the registry.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  clampOptionalInt,
  isValidEmail,
  optionalFolderHint,
  requireNumericEmailId,
  truncate,
  validateLabelName,
  validateTargetFolder,
} from "../utils/helpers.js";
import { validateSearchInput } from "./search-input.js";
import { extractActionItems, parseIcs } from "../services/content-parser.js";
import { FtsOwnershipError, FtsUnavailableError } from "../services/fts-service.js";

// TOOL-013: track in-progress rebuilds per resolved DB path rather than a
// single module-global boolean. Per-account routing means two concurrent
// fts_rebuild calls can target different index files; a shared flag wrongly
// rejected the second even when its target was a different DB.
const _ftsRebuilding = new Set<string>();
import type { EmailMessage, EmailFolder } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { isFolderNotFoundError } from "../utils/error-classify.js";
import type { ToolCallContext, ToolDef, ToolHandler, ToolModule } from "./types.js";

const EMAIL_SUMMARY_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", description: "IMAP UID — per-folder, use for follow-up tool calls in THIS folder" },
    messageId: { type: "string", description: "RFC Message-ID — stable identity across folders (the per-folder `id` is not)" },
    from: { type: "string" },
    to: { type: "array", items: { type: "string" } },
    subject: { type: "string" },
    bodyPreview: { type: "string", description: "First ~300 chars of body (omitted when summaryOnly=true)" },
    date: { type: "string", format: "date-time" },
    folder: { type: "string" },
    isRead: { type: "boolean" },
    isStarred: { type: "boolean" },
    hasAttachment: { type: "boolean" },
  },
  required: ["id", "from", "subject", "date", "isRead", "folder"],
};

export const defsEarly: ToolDef[] = [
  {
    name: "get_emails",
    title: "Get Emails",
    description:
      "Fetch a page of emails from a folder. Returns summary fields (id, messageId, from, subject, date, isRead, bodyPreview). `id` is a per-folder IMAP UID; `messageId` is stable across folders. Use id with get_email_by_id for full content. Set summaryOnly=true to omit bodyPreview for lean listing/triage. Pass nextCursor from a previous response to get the next page.",
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
        summaryOnly: {
          type: "boolean",
          description: "When true, omit bodyPreview (and body) from each item — leaner payload for listing/triage. Default false.",
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
      "Fetch a single email's full content including body, attachment metadata (no binary content), isAnswered, and isForwarded flags. Use the id returned by get_emails or search_emails.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "IMAP UID from get_emails or search_emails" },
        folder: { type: "string", description: "Folder the email lives in (e.g. INBOX, Sent, Drafts). Providing this avoids a cross-folder UID collision." },
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
        isAnswered: { type: "boolean", description: "True if the email has been replied to (\\Answered IMAP flag)" },
        isForwarded: { type: "boolean", description: "True if the email has been forwarded ($Forwarded IMAP flag)" },
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
      "Search the live mailbox by sender, recipient (To/CC/BCC), subject, body content, date range (received or sent), size, read/replied/starred/draft status, or attachment presence. Uses server-side IMAP SEARCH except hasAttachment, which filters locally. Use fts_search only for faster local ranked search after its index is built. Use folder for one folder or folders for many (pass [\"*\"] for all); returns summaries, so use get_email_by_id for full content.",
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
        dateFrom: { type: "string", description: "ISO 8601 start date (INTERNALDATE — when received by server)" },
        dateTo: { type: "string", description: "ISO 8601 end date (INTERNALDATE — when received by server)" },
        limit: { type: "number", description: "Max results (1-200, default 50)", default: 50 },
        body: { type: "string", description: "Search within email body content" },
        text: { type: "string", description: "Search headers and body (full text)" },
        bcc: { type: "string", description: "Filter by BCC recipient" },
        answered: { type: "boolean", description: "Filter by whether email has been replied to" },
        isDraft: { type: "boolean", description: "Filter by draft status" },
        larger: { type: "number", description: "Minimum email size in bytes" },
        smaller: { type: "number", description: "Maximum email size in bytes" },
        sentBefore: { type: "string", format: "date-time", description: "Filter by Date: header before this date (ISO 8601)" },
        sentSince: { type: "string", format: "date-time", description: "Filter by Date: header since this date (ISO 8601)" },
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
      "List only Proton Mail labels with message counts (Labels/ prefix), not regular folders. Use get_folders when you also need regular folders, folder type, or IMAP special-use metadata.",
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
      "Legacy convenience wrapper for get_emails with folder set to Labels/<label>. Prefer get_emails when you need the canonical pagination and summaryOnly options.",
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
        // TOOL-011: advertise the same item shape as get_emails (was a bare
        // `object` with no properties) and declare required keys.
        emails: { type: "array", items: EMAIL_SUMMARY_SCHEMA },
        count: { type: "number" },
        folder: { type: "string" },
        nextCursor: { type: "string" },
      },
      required: ["emails", "folder", "count"],
    },
  },
];

export const defsLate: ToolDef[] = [
  {
    name: "download_attachment",
    title: "Download Attachment",
    description:
      "Download the binary content of an email attachment as a base64-encoded string. Use get_email_by_id first to see available attachments and their indices (0-based). Provide the message folder to avoid a cross-folder UID collision; it is required for folder-restricted agents.",
    annotations: { readOnlyHint: true, openWorldHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "IMAP UID of the email" },
        folder: { type: "string", description: "Folder the email lives in. Required for folder-restricted agents and recommended for all callers because IMAP UIDs are per-folder." },
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
  {
    name: "get_thread",
    title: "Get Email Thread",
    description:
      "Return all messages that look like they belong to the same thread as the given email. Uses the normalized Subject (Re:/Fwd: stripped) to collect related messages from INBOX + Sent. Folder-restricted agents only receive messages from their allowed folders. Useful for summarising long conversations in one call.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "IMAP UID of any message in the thread" },
        folder: { type: "string", description: "Folder the seed message lives in. Providing this avoids UID collisions across folders." },
        max_messages: { type: "number", description: "Max messages to return (default 50, cap 200)" },
      },
      required: ["email_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        subject: { type: "string", description: "Normalized subject line for the thread" },
        messages: {
          type: "array",
          items: EMAIL_SUMMARY_SCHEMA,
          description: "Messages in the thread, oldest-first",
        },
      },
      required: ["subject", "messages"],
    },
  },
  {
    name: "get_correspondence_profile",
    title: "Get Correspondence Profile",
    description:
      "Return relationship statistics for a single email address — volume sent/received, first and last interaction, average response time (if computable). Useful before drafting so the agent can match tone and recall context.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", description: "Email address to look up" },
      },
      required: ["email"],
    },
    outputSchema: {
      type: "object",
      properties: {
        email: { type: "string" },
        name: { type: "string" },
        emailsSent: { type: "number" },
        emailsReceived: { type: "number" },
        firstInteraction: { type: ["string", "null"], format: "date-time" },
        lastInteraction: { type: ["string", "null"], format: "date-time" },
        averageResponseTime: { type: ["number", "null"], description: "Minutes; null when not computable" },
        isFavorite: { type: "boolean" },
        exhaustive: { type: "boolean", description: "False when the contact ranked beyond the analytics top-500 scan and a lower-ranked record may exist" },
      },
      required: ["email", "emailsSent", "emailsReceived"],
    },
  },
  {
    name: "fts_search",
    title: "Full-Text Search (Local Index)",
    description:
      "BM25-ranked keyword search over the locally indexed mail corpus. Supports FTS5 syntax: phrases (\"exact phrase\"), boolean (foo AND bar, foo OR bar, NOT baz), prefix (proto*), and column filters (subject:invoice from:alice). Use search_emails for live, authoritative IMAP results; use this for faster ranked local search after fts_rebuild has populated the index.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "FTS5 query string" },
        folder: { type: "string", description: "Restrict results to a single folder" },
        sinceEpoch: { type: "number", description: "Filter to messages whose date is at or after this Unix-epoch second" },
        limit: { type: "number", description: "Max hits to return (1–200, default 20)" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        hits: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              subject: { type: "string" },
              from: { type: "string" },
              to: { type: "string" },
              folder: { type: "string" },
              snippet: { type: "string" },
              dateEpoch: { type: "number" },
              score: { type: "number" },
            },
          },
        },
      },
      required: ["hits"],
    },
  },
  {
    name: "fts_rebuild",
    title: "Rebuild Local FTS Index",
    description:
      "Clear the local FTS5 index and rebuild it from the messages currently cached by the analytics layer (INBOX + Sent). Intended for use after major mailbox changes or when fts_search returns stale results. Returns the number of messages indexed.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        indexed: { type: "number" },
        messageCount: { type: "number" },
        dbPath: { type: "string" },
      },
    },
  },
  {
    name: "fts_status",
    title: "FTS Index Status",
    description: "Report the path, row count, and on-disk size of the local FTS5 index. Returns { available: false } when better-sqlite3 is not installed.",
    annotations: { readOnlyHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: {
      type: "object",
      properties: {
        available: { type: "boolean" },
        messageCount: { type: "number" },
        dbPath: { type: "string" },
        databaseBytes: { type: "number" },
        reason: { type: "string" },
      },
      required: ["available"],
    },
  },
  {
    name: "extract_action_items",
    title: "Extract Action Items",
    description:
      "Scan a single email's body for action-item-looking lines (bullets with action verbs, TODO:/ACTION: markers, @mentions) and return a structured list with best-effort assignee and due-date fields. Heuristic — not a replacement for a real task extractor, but useful for quick triage.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "IMAP UID from get_emails / search_emails" },
        folder: { type: "string", description: "Folder the email lives in. Providing this avoids UID collisions across folders." },
      },
      required: ["email_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        action_items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              text: { type: "string" },
              assignee: { type: "string" },
              due: { type: "string" },
            },
            required: ["text"],
          },
        },
      },
      required: ["action_items"],
    },
  },
  {
    name: "extract_meeting",
    title: "Extract Meeting from ICS",
    description:
      "Parse an iCalendar (ICS) attachment or inline VCALENDAR block out of an email and return structured meeting details. Returns { meeting: null } when no ICS block is found. Supports RFC 5545 line folding and the common VEVENT properties (SUMMARY, DTSTART, DTEND, LOCATION, ORGANIZER, ATTENDEE, DESCRIPTION, RRULE).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        email_id: { type: "string", description: "IMAP UID from get_emails / search_emails" },
        folder: { type: "string", description: "Folder the email lives in. Providing this avoids UID collisions across folders." },
      },
      required: ["email_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        meeting: {
          type: ["object", "null"],
          properties: {
            summary: { type: "string" },
            start: { type: "string" },
            end: { type: "string" },
            location: { type: "string" },
            organizer: { type: "string" },
            attendees: { type: "array", items: { type: "string" } },
            description: { type: "string" },
            rrule: { type: "string" },
          },
          required: ["summary", "start"],
        },
      },
    },
  },
];

export const defs: ToolDef[] = [...defsEarly, ...defsLate];

/**
 * A folder allowlist is meaningful only when it has at least one path. The
 * dispatcher always supplies this accessor in production; the optional call
 * keeps direct handler tests (which intentionally use a tiny context) on the
 * unrestricted compatibility path.
 */
function callerAllowedFolders(ctx: ToolCallContext): string[] | undefined {
  const allowed = ctx.getCallerAllowedFolders?.();
  return Array.isArray(allowed) && allowed.length > 0 ? allowed : undefined;
}

function folderIsAllowed(folder: string, allowedFolders: string[]): boolean {
  return allowedFolders.some((allowed) => allowed.toLowerCase() === folder.toLowerCase());
}

/**
 * A UID is scoped to its IMAP folder. For a restricted caller, a folderless
 * UID cannot be proven to refer to an allowed message, so do not make the
 * service's all-folder fallback available. Check both the requested folder and
 * the service's resolved folder: the latter protects this boundary even if a
 * cache or future service implementation resolves an allowed-looking hint to a
 * different mailbox.
 */
function requireAuthorizedFolderProvenance(
  tool: string,
  folderHint: string | undefined,
  allowedFolders: string[] | undefined,
): void {
  if (!allowedFolders) return;
  if (!folderHint) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: ${tool} requires a folder for a folder-restricted agent.`,
    );
  }
  if (!folderIsAllowed(folderHint, allowedFolders)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      `Blocked: folder '${folderHint}' is outside this agent's folder allowlist.`,
    );
  }
}

function requireResolvedEmailInAllowedFolder(
  email: EmailMessage,
  allowedFolders: string[] | undefined,
  expectedFolder?: string,
): void {
  if (!allowedFolders) return;
  if (!folderIsAllowed(email.folder, allowedFolders)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Blocked: the resolved email is outside this agent's folder allowlist.",
    );
  }
  if (expectedFolder && email.folder.toLowerCase() !== expectedFolder.toLowerCase()) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Blocked: the resolved email does not match the requested folder.",
    );
  }
}

function requireResolvedSearchEmailInAllowedScope(
  email: EmailMessage,
  searchFolders: string[] | undefined,
  allowedFolders: string[] | undefined,
): void {
  requireResolvedEmailInAllowedFolder(email, allowedFolders);
  if (!allowedFolders || !searchFolders || searchFolders.includes("*") || searchFolders.includes("all")) return;
  if (!folderIsAllowed(email.folder, searchFolders)) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "Blocked: a search result does not match the requested folder scope.",
    );
  }
}

export const handlers: Record<string, ToolHandler> = {
  get_emails: async (ctx) => {
    const { args, imapService, ok, limits, encodeCursor, decodeCursor } = ctx;
    const folder = (args.folder as string) || "INBOX";
    const geValidErr = validateTargetFolder(folder);
    if (geValidErr) throw new McpError(ErrorCode.InvalidParams, geValidErr);
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("get_emails", folder, allowedFolders);
    if (args.limit !== undefined && typeof args.limit !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "'limit' must be a number.");
    }
    const limit = Math.min(Math.max(1, (args.limit as number) || 50), 200, limits.maxEmailListResults);

    if (args.cursor !== undefined && typeof args.cursor !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'cursor' must be a string.");
    }
    let offset = 0;
    if (args.cursor) {
      const decoded = decodeCursor(args.cursor as string);
      if (!decoded || decoded.folder !== folder) {
        return { content: [{ type: "text" as const, text: "Invalid or expired cursor" }], isError: true };
      }
      offset = decoded.offset;
    }

    let emails;
    try {
      emails = await imapService.getEmails(folder, limit, offset);
    } catch (err) {
      // Cluster 6: a SELECT of a missing mailbox surfaces as an opaque imapflow
      // rejection. Convert it to a precise, actionable not-found error.
      if (isFolderNotFoundError(err)) {
        throw new McpError(ErrorCode.InvalidParams, `Folder/label '${folder}' not found.`);
      }
      throw err;
    }
    for (const email of emails) requireResolvedEmailInAllowedFolder(email, allowedFolders, folder);

    let nextCursor: string | undefined;
    if (emails.length === limit) {
      nextCursor = encodeCursor({ folder, offset: offset + limit, limit });
    }

    // #8: projection — drop the body fields for lean listing/triage payloads.
    const projected = (args.summaryOnly === true)
      ? emails.map((e) => { const { body: _b, bodyPreview: _p, ...rest } = e; void _b; void _p; return rest; })
      : emails;

    const structured = { emails: projected, folder, count: projected.length, ...(nextCursor ? { nextCursor } : {}) };
    return ok(structured);
  },

  get_email_by_id: async (ctx) => {
    const { args, imapService, ok, limits } = ctx;
    const rawEmailId = requireNumericEmailId(args.emailId);
    const folderHint = optionalFolderHint(args.folder);
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("get_email_by_id", folderHint, allowedFolders);
    const email = await imapService.getEmailById(rawEmailId, folderHint);
    if (!email) {
      return { content: [{ type: "text" as const, text: "Email not found" }], isError: true };
    }
    requireResolvedEmailInAllowedFolder(email, allowedFolders, folderHint);
    if (email.body && email.body.length > limits.maxEmailBodyChars) {
      // Clone before truncating: imapService may cache the returned object, so
      // mutating email.body in place would persist the truncation into later
      // calls made with a higher maxEmailBodyChars (TOOL-025).
      const originalLen = email.body.length;
      const truncated = {
        ...email,
        body: email.body.substring(0, limits.maxEmailBodyChars)
          + `\n\n[...body truncated at ${limits.maxEmailBodyChars.toLocaleString()} chars — original was ${originalLen.toLocaleString()} chars]`,
      };
      return ok(truncated as unknown as Record<string, unknown>);
    }
    return ok(email as unknown as Record<string, unknown>);
  },

  search_emails: async (ctx) => {
    const { args, imapService, ok, limits } = ctx;
    const allowedFolders = callerAllowedFolders(ctx);
    const searchOptions = validateSearchInput(args, limits.maxEmailListResults, allowedFolders);
    const results = await imapService.searchEmails(searchOptions);
    const requestedSearchFolders = searchOptions.folders ?? [searchOptions.folder ?? "INBOX"];
    for (const email of results) requireResolvedSearchEmailInAllowedScope(email, requestedSearchFolders, allowedFolders);
    const searchedIn = searchOptions.folders ? searchOptions.folders.join(", ") : (searchOptions.folder ?? "INBOX");
    return ok({ emails: results, count: results.length, folder: searchedIn });
  },

  get_unread_count: async (ctx) => {
    const { imapService, ok } = ctx;
    const folders = await imapService.getFolders();
    const unreadByFolder: Record<string, number> = {};
    let totalUnread = 0;
    for (const f of folders) {
      unreadByFolder[f.path] = f.unreadMessages;
      totalUnread += f.unreadMessages;
    }
    return ok({ unreadByFolder, totalUnread });
  },

  list_labels: async (ctx) => {
    const { imapService, ok } = ctx;
    const allFolders = await imapService.getFolders();
    const labels = allFolders.filter((f: EmailFolder) => f.path.startsWith("Labels/"));
    return ok({ labels, count: labels.length });
  },

  get_emails_by_label: async (ctx) => {
    const { args, imapService, ok, limits, encodeCursor, decodeCursor } = ctx;
    if (!args.label || typeof args.label !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'label' is required and must be a string.");
    }
    const lblName = args.label as string;
    const lblValidErr = validateLabelName(lblName);
    if (lblValidErr) throw new McpError(ErrorCode.InvalidParams, lblValidErr);
    const lblFolder = `Labels/${lblName}`;
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("get_emails_by_label", lblFolder, allowedFolders);
    if (args.limit !== undefined && typeof args.limit !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "'limit' must be a number.");
    }
    const lblLimit = Math.min(Math.max(1, (args.limit as number) || 50), 200, limits.maxEmailListResults);

    if (args.cursor !== undefined && typeof args.cursor !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'cursor' must be a string.");
    }
    let lblOffset = 0;
    if (args.cursor) {
      const decoded = decodeCursor(args.cursor as string);
      if (!decoded || decoded.folder !== lblFolder) {
        return { content: [{ type: "text" as const, text: "Invalid or expired cursor" }], isError: true };
      }
      lblOffset = decoded.offset;
    }

    let lblEmails;
    try {
      lblEmails = await imapService.getEmails(lblFolder, lblLimit, lblOffset);
    } catch (err) {
      // Cluster 6: a missing label folder maps to a precise not-found message
      // naming the label, rather than the opaque "An error occurred".
      if (isFolderNotFoundError(err)) {
        throw new McpError(ErrorCode.InvalidParams, `Folder/label '${lblFolder}' not found.`);
      }
      throw err;
    }
    for (const email of lblEmails) requireResolvedEmailInAllowedFolder(email, allowedFolders, lblFolder);
    let lblNextCursor: string | undefined;
    if (lblEmails.length === lblLimit) {
      lblNextCursor = encodeCursor({ folder: lblFolder, offset: lblOffset + lblLimit, limit: lblLimit });
    }

    const lblStructured = { emails: lblEmails, folder: lblFolder, count: lblEmails.length, ...(lblNextCursor ? { nextCursor: lblNextCursor } : {}) };
    return ok(lblStructured);
  },

  download_attachment: async (ctx) => {
    const { args, imapService, ok, limits } = ctx;
    const rawAttEmailId = requireNumericEmailId(args.email_id, "email_id");
    const folderHint = optionalFolderHint(args.folder);
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("download_attachment", folderHint, allowedFolders);
    const rawAttIdx = args.attachment_index as number;
    const MAX_ATTACHMENT_INDEX = 50;
    if (!Number.isInteger(rawAttIdx) || rawAttIdx < 0) {
      throw new McpError(ErrorCode.InvalidParams, "attachment_index must be a non-negative integer.");
    }
    if (rawAttIdx > MAX_ATTACHMENT_INDEX) {
      throw new McpError(ErrorCode.InvalidParams, `attachment_index must be at most ${MAX_ATTACHMENT_INDEX}.`);
    }
    // The attachment service returns binary data, not its source folder. Resolve
    // the email first for a restricted caller so we can verify that a hinted UID
    // did not resolve from another folder before handing out its attachment.
    if (allowedFolders) {
      const email = await imapService.getEmailById(rawAttEmailId, folderHint);
      if (!email) {
        return { content: [{ type: "text" as const, text: "Attachment not found" }], isError: true };
      }
      requireResolvedEmailInAllowedFolder(email, allowedFolders, folderHint);
    }
    const attResult = await imapService.downloadAttachment(rawAttEmailId, rawAttIdx, folderHint);
    if (!attResult) {
      return { content: [{ type: "text" as const, text: "Attachment not found" }], isError: true };
    }
    const encodedLen = typeof attResult.content === "string" ? attResult.content.length : 0;
    if (encodedLen > limits.maxAttachmentBytes) {
      logger.warn(
        `Attachment "${attResult.filename}" too large: ${encodedLen} bytes encoded (limit ${limits.maxAttachmentBytes})`,
        "ResponseGuard",
      );
      return {
        content: [{ type: "text" as const, text: `Attachment "${attResult.filename}" is too large (${attResult.size} bytes raw, ${encodedLen} bytes encoded). Limit: ${limits.maxAttachmentBytes} bytes. Increase maxAttachmentBytes in Settings → Debug Logs → Response Limits to download larger files.` }],
        isError: true,
      };
    }
    return ok(attResult, `Attachment: ${attResult.filename} (${attResult.contentType}, ${attResult.size} bytes)`);
  },

  get_thread: async (ctx) => {
    const { args, imapService, ok } = ctx;
    const threadEmailId = requireNumericEmailId(args.email_id, "email_id");
    const threadFolderHint = optionalFolderHint(args.folder);
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("get_thread", threadFolderHint, allowedFolders);
    const maxMsgs = typeof args.max_messages === "number"
      ? Math.min(Math.max(1, args.max_messages), 200)
      : 50;
    const seed = await imapService.getEmailById(threadEmailId, threadFolderHint);
    if (!seed) {
      return { content: [{ type: "text" as const, text: "Seed message not found" }], isError: true };
    }
    requireResolvedEmailInAllowedFolder(seed, allowedFolders, threadFolderHint);
    const normalizeSubject = (s: string) => s.replace(/^(\s*(re|fwd|fw):\s*)+/i, "").trim();
    const normalized = normalizeSubject(seed.subject || "");
    // Unrestricted callers retain the historical INBOX + Sent expansion. A
    // folder-restricted caller may only query every folder from its grant and
    // must never inherit those hard-coded mailboxes.
    const threadFolders = allowedFolders ?? ["INBOX", "Sent"];
    const related = await Promise.all(
      threadFolders.map(async (folder, index) => {
        try {
          return {
            folder,
            messages: await imapService.searchEmails({ folder, subject: normalized, limit: maxMsgs }),
          };
        } catch (error) {
          // Preserve the old best-effort Sent behavior only for unrestricted
          // callers. A restricted folder failing to search is not permission to
          // silently fall back to a different mailbox.
          if (!allowedFolders && index > 0) return { folder, messages: [] as EmailMessage[] };
          throw error;
        }
      }),
    );
    const byId = new Map<string, EmailMessage>();
    const addRelated = (m: EmailMessage) => {
      const normSubj = normalizeSubject(m.subject || "");
      if (normSubj !== normalized) return;
      // UIDs are per-folder. Deduping only by UID previously allowed INBOX:42
      // and Sent:42 to overwrite one another, producing ambiguous output.
      byId.set(`${m.folder.toLowerCase()}\u0000${m.id}`, m);
    };
    addRelated(seed);
    for (const { folder, messages } of related) {
      for (const m of messages) {
        // A restricted thread is allowed to search several folders, but each
        // result must still be attributable to the particular IMAP mailbox
        // queried. Checking only the whole allowlist would accept an adapter
        // response from a different allowed folder and break UID provenance.
        requireResolvedEmailInAllowedFolder(m, allowedFolders, folder);
        addRelated(m);
      }
    }
    // TOOL-010: the outputSchema advertises EMAIL_SUMMARY_SCHEMA, but the
    // handler used to return full EmailMessage objects (entire body per
    // message), so a long thread could blow the 1 MB response budget and the
    // shape didn't match the schema. Narrow to the summary fields, deriving a
    // bounded bodyPreview from the body when absent.
    const messages = Array.from(byId.values())
      .sort((a, b) => (a.date?.getTime?.() ?? 0) - (b.date?.getTime?.() ?? 0))
      .slice(0, maxMsgs)
      .map((m) => ({
        id: m.id,
        from: m.from,
        to: m.to,
        subject: m.subject,
        bodyPreview: m.bodyPreview ?? (m.body ? truncate(m.body, 300) : ""),
        date: m.date?.toISOString?.() ?? null,
        folder: m.folder,
        isRead: m.isRead,
        isStarred: m.isStarred,
        hasAttachment: m.hasAttachment,
      }));
    return ok({ subject: normalized, messages });
  },

  get_correspondence_profile: async (ctx) => {
    const { args, analyticsService, ok, getAnalyticsEmails } = ctx;
    const emailArg = typeof args.email === "string" ? args.email.trim().toLowerCase() : "";
    if (!emailArg || !isValidEmail(emailArg)) {
      throw new McpError(ErrorCode.InvalidParams, "email must be a valid address.");
    }
    await getAnalyticsEmails().catch(() => null);
    // analyticsService.getContacts hard-clamps to its top 500 ranked contacts,
    // so a low-frequency-but-real correspondent ranked beyond 500 will not be
    // found here. Report the result honestly as "not in the top N" rather than
    // asserting "no prior correspondence", which would be a false negative
    // (TOOL-008). A full-set lookup would require an analyticsService.findContact
    // accessor, which lives in a file owned by a sibling batch.
    const CONTACT_SCAN_CAP = 500;
    const contacts = analyticsService.getContacts(CONTACT_SCAN_CAP);
    const found = contacts.find(c => c.email.toLowerCase() === emailArg);
    if (!found) {
      const exhaustive = contacts.length < CONTACT_SCAN_CAP;
      const message = exhaustive
        ? `No prior correspondence with ${emailArg} in the analytics window.`
        : `${emailArg} is not among the top ${CONTACT_SCAN_CAP} contacts in the analytics window; ` +
          `a lower-ranked correspondence record may exist but is not reported here.`;
      return ok({
        email: emailArg,
        emailsSent: 0,
        emailsReceived: 0,
        firstInteraction: null,
        lastInteraction: null,
        averageResponseTime: null,
        isFavorite: false,
        exhaustive,
      }, message);
    }
    return ok({
      email: found.email,
      name: found.name ?? "",
      emailsSent: found.emailsSent,
      emailsReceived: found.emailsReceived,
      firstInteraction: found.firstInteraction?.toISOString?.() ?? null,
      lastInteraction:  found.lastInteraction?.toISOString?.()  ?? null,
      averageResponseTime: found.averageResponseTime ?? null,
      isFavorite: !!found.isFavorite,
    });
  },

  fts_search: async (ctx) => {
    const { args, ok, getFts, getCallerAllowedFolders } = ctx;
    const q = typeof args.query === "string" ? args.query.trim() : "";
    if (!q) throw new McpError(ErrorCode.InvalidParams, "query must be a non-empty string.");
    const fts = getFts();
    // Scope snippet content to the caller's grant. The grant gate in
    // index.ts already blocks the per-call `folder` arg outside the
    // allowlist, but `searchAll` returns hits + snippets from every
    // indexed folder when no `folder` arg is supplied — leaking decrypted
    // bodies from Trash/Spam/Archive that the caller has no business
    // seeing. PARSE-002 (audit-2026-05-28).
    const allowedFolders = getCallerAllowedFolders();
    // Clamp limit to the input-schema's documented 1–200 bound (defaulting to
    // 20); reject non-finite limit/sinceEpoch so NaN/Infinity never reach the
    // FTS query (TOOL-009). Range validation lives in the handler, not the
    // service (another batch owns fts-service.ts).
    const limit = clampOptionalInt(args.limit, 20, 1, 200);
    if (args.sinceEpoch !== undefined &&
        (typeof args.sinceEpoch !== "number" || !Number.isFinite(args.sinceEpoch) || args.sinceEpoch < 0)) {
      throw new McpError(ErrorCode.InvalidParams, "'sinceEpoch' must be a non-negative finite number (epoch seconds) when provided.");
    }
    const sinceEpoch = typeof args.sinceEpoch === "number" ? args.sinceEpoch : undefined;
    // VALID-016: validate the folder filter for parity with search_emails;
    // previously it was forwarded raw, so fts_search admitted folders its IMAP
    // twin would reject.
    const ftsFolder = typeof args.folder === "string" ? args.folder : undefined;
    if (ftsFolder !== undefined) {
      const ftsFolderErr = validateTargetFolder(ftsFolder);
      if (ftsFolderErr) throw new McpError(ErrorCode.InvalidParams, `folder: ${ftsFolderErr}`);
    }
    const hits = fts.search({
      query: q,
      limit,
      folder: ftsFolder,
      sinceEpoch,
      allowedFolders,
    }).map(h => ({
      id: h.id,
      subject: h.subject,
      from: h.from,
      to: h.to,
      folder: h.folder,
      snippet: h.snippet,
      dateEpoch: h.dateEpoch,
      score: h.score,
    }));
    return ok({ hits });
  },

  fts_rebuild: async (ctx) => {
    const { ok, getFts, getAnalyticsEmails, recordFromEmail } = ctx;
    const fts = getFts();
    // Resolve the target DB path so the in-progress guard is scoped to this
    // account's index, not all accounts (TOOL-013).
    const dbPath = fts.stats().dbPath;
    if (_ftsRebuilding.has(dbPath)) {
      return { content: [{ type: "text" as const, text: "FTS rebuild already in progress — try again in a moment." }], isError: true };
    }
    _ftsRebuilding.add(dbPath);
    try {
      const { inbox, sent } = await getAnalyticsEmails();
      // PARSE-003: atomic clear+repopulate in one transaction. A bare
      // clear()+upsertMany() committed the DELETE immediately, so a throw mid-map
      // (e.g. a malformed record) left the index wiped. rebuild() rolls back to
      // the prior index on any throw.
      const indexed = fts.rebuild([...inbox, ...sent].map(recordFromEmail));
      const stats = fts.stats();
      return ok({ indexed, messageCount: stats.messageCount, dbPath: stats.dbPath });
    } finally {
      _ftsRebuilding.delete(dbPath);
    }
  },

  fts_status: async (ctx) => {
    const { ok, getFts } = ctx;
    try {
      const fts = getFts();
      const stats = fts.stats();
      return ok({ available: true, ...stats });
    } catch (err: unknown) {
      if (err instanceof FtsUnavailableError || err instanceof FtsOwnershipError) {
        return ok({ available: false, reason: err.message });
      }
      throw err;
    }
  },

  extract_action_items: async (ctx) => {
    const { args, imapService, ok } = ctx;
    const aiEmailId = requireNumericEmailId(args.email_id, "email_id");
    const folderHint = optionalFolderHint(args.folder);
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("extract_action_items", folderHint, allowedFolders);
    const email = await imapService.getEmailById(aiEmailId, folderHint);
    if (!email) {
      return { content: [{ type: "text" as const, text: "Email not found" }], isError: true };
    }
    requireResolvedEmailInAllowedFolder(email, allowedFolders, folderHint);
    const action_items = extractActionItems(email.body || "");
    return ok({ action_items });
  },

  extract_meeting: async (ctx) => {
    const { args, imapService, ok } = ctx;
    const emEmailId = requireNumericEmailId(args.email_id, "email_id");
    const folderHint = optionalFolderHint(args.folder);
    const allowedFolders = callerAllowedFolders(ctx);
    requireAuthorizedFolderProvenance("extract_meeting", folderHint, allowedFolders);
    const email = await imapService.getEmailById(emEmailId, folderHint);
    if (!email) {
      return { content: [{ type: "text" as const, text: "Email not found" }], isError: true };
    }
    requireResolvedEmailInAllowedFolder(email, allowedFolders, folderHint);
    let icsText: string | null = null;
    for (const att of email.attachments ?? []) {
      const ct = (att.contentType ?? "").toLowerCase();
      const fn = (att.filename ?? "").toLowerCase();
      const looksIcs = ct.startsWith("text/calendar")
        || ct === "application/ics"
        || fn.endsWith(".ics");
      if (!looksIcs) continue;
      if (Buffer.isBuffer(att.content)) {
        icsText = att.content.toString("utf-8");
      } else if (typeof att.content === "string") {
        icsText = att.content;
      }
      if (icsText) break;
    }
    if (!icsText && email.body && /BEGIN:VCALENDAR/i.test(email.body)) {
      icsText = email.body;
    }
    const meeting = icsText ? parseIcs(icsText) : null;
    return ok({ meeting: meeting ?? null });
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
