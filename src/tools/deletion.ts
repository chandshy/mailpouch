/**
 * Deletion tools: delete_email, bulk_delete_emails, bulk_delete.
 *
 * Both bulk_delete and bulk_delete_emails share the same handler — the
 * pre-refactor switch fall-through is preserved by registering one handler
 * function under both names.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { optionalSourceFolder, requireNumericEmailId } from "../utils/helpers.js";
import type { ToolDef, ToolHandler, ToolModule } from "./types.js";

const SOURCE_FOLDER_SCHEMA = {
  type: "string",
  description:
    "Folder the UID(s) live in (e.g. INBOX, Folders/Work, Labels/Foo). Strongly recommended whenever the UIDs came from a folder other than INBOX — IMAP UIDs are folder-scoped, so without this the wrong folder may be selected.",
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

export const defs: ToolDef[] = [
  {
    name: "delete_email",
    title: "Delete Email",
    description:
      "Delete an email by MOVING it to Trash — mail is never permanently deleted and stays recoverable from Trash. An email already in Trash is left in place. Requires { confirmed: true }. Pass sourceFolder whenever the UID came from a folder other than INBOX.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        confirmed: { type: "boolean", description: "Must be true to execute. See requireDestructiveConfirm." },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "bulk_delete_emails",
    title: "Bulk Delete Emails",
    description:
      "Delete multiple emails by MOVING them to Trash — mail is never permanently deleted and stays recoverable from Trash. Emits progress notifications if a progressToken is provided in _meta. Returns success/failed counts. Requires { confirmed: true }. Pass sourceFolder whenever the UIDs came from a folder other than INBOX.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" } },
        confirmed: { type: "boolean", description: "Must be true to execute. See requireDestructiveConfirm." },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailIds"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
  {
    name: "bulk_delete",
    title: "Bulk Delete Emails",
    description:
      "Alias for bulk_delete_emails. Delete multiple emails by MOVING them to Trash — mail is never permanently deleted and stays recoverable from Trash. Requires { confirmed: true }. Pass sourceFolder whenever the UIDs came from a folder other than INBOX.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" } },
        confirmed: { type: "boolean", description: "Must be true to execute. See requireDestructiveConfirm." },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailIds"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
  {
    name: "empty_trash",
    title: "Empty Trash",
    description:
      "PERMANENTLY delete every message in the Trash mailbox. This is the only operation that bypasses the move-to-Trash safety net — purged mail is UNRECOVERABLE. It only ever touches the Trash mailbox, never live mail. Requires { confirmed: true }.",
    // idempotentHint:false — matches the other destructive tools and, more
    // importantly, discourages client auto-retry: a retry could purge Trash
    // messages that arrived between attempts.
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        confirmed: { type: "boolean", description: "Must be true to execute. Purged Trash mail is unrecoverable. See requireDestructiveConfirm." },
      },
    },
    outputSchema: {
      type: "object",
      properties: { success: { type: "boolean" }, deleted: { type: "number" } },
      required: ["success", "deleted"],
    },
  },
];

const bulkDeleteHandler: ToolHandler = async (ctx) => {
  const { args, imapService, bulkOk, sendProgress, MAX_BULK_IDS, state } = ctx;
  if (!Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "emailIds must be a non-empty array of numeric UID strings.");
  }
  const rawIds3 = args.emailIds as unknown[];
  const emailIds3: string[] = rawIds3
    .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
    .slice(0, MAX_BULK_IDS);
  if (emailIds3.length === 0) {
    throw new McpError(ErrorCode.InvalidParams, "No valid numeric email IDs in the provided list. Email IDs must be numeric UID strings.");
  }
  const bdSourceFolder = optionalSourceFolder(args.sourceFolder);

  const results3 = await imapService.bulkDeleteEmails(emailIds3, bdSourceFolder);
  await sendProgress(emailIds3.length, emailIds3.length, `Deleted ${results3.success} of ${emailIds3.length} (${results3.failed} failed)`);
  state.analyticsCache = null;
  state.analyticsCacheInflight = null;
  return bulkOk(results3);
};

export const handlers: Record<string, ToolHandler> = {
  delete_email: async (ctx) => {
    const { args, imapService, actionOk, state } = ctx;
    const deEmailId = requireNumericEmailId(args.emailId);
    const deSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.deleteEmail(deEmailId, deSourceFolder);
    state.analyticsCache = null;
    state.analyticsCacheInflight = null;
    return actionOk();
  },

  bulk_delete: bulkDeleteHandler,
  bulk_delete_emails: bulkDeleteHandler,

  empty_trash: async (ctx) => {
    const { imapService, ok, state } = ctx;
    const { deleted } = await imapService.emptyTrash();
    state.analyticsCache = null;
    state.analyticsCacheInflight = null;
    return ok({ success: true, deleted }, `Permanently deleted ${deleted} message(s) from Trash.`);
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
