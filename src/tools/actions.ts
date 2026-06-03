/**
 * Email action tools: mark_email_read, star_email, move_email,
 * archive_email, move_to_trash, move_to_spam, move_to_folder,
 * bulk_mark_read, bulk_star, bulk_move_emails, move_to_label,
 * bulk_move_to_label, remove_label, bulk_remove_label.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import {
  optionalSourceFolder,
  requireNumericEmailId,
  validateFolderName,
  validateLabelName,
  validateTargetFolder,
} from "../utils/helpers.js";
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

const BULK_RESULT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "number" },
    failed: { type: "number" },
    errors: { type: "array", items: { type: "string" } },
  },
  required: ["success", "failed", "errors"],
};

// Shared schema fragment for the optional sourceFolder parameter — appears on
// every mutating tool. IMAP UIDs are folder-scoped, so callers should pass the
// folder the UID came from to avoid cross-folder collisions and silent no-ops.
const SOURCE_FOLDER_SCHEMA = {
  type: "string",
  description:
    "Folder the UID(s) live in (e.g. INBOX, Folders/Work, Labels/Foo). Strongly recommended whenever the UIDs came from a folder other than INBOX — IMAP UIDs are folder-scoped, so without this the wrong folder may be selected and the operation may silently no-op. Avoid passing 'All Mail' as the source: it is a union view of every folder, not a real location, so moves out of it can silently do nothing — pass the message's actual folder instead. Moving to the folder a message is already in is a no-op.",
};

export const defs: ToolDef[] = [
  {
    name: "mark_email_read",
    title: "Mark Email Read/Unread",
    description:
      "Set the read/unread status of an email. isRead defaults to true. Pass sourceFolder whenever the UID came from a folder other than INBOX — IMAP UIDs are folder-scoped and silent no-ops can otherwise occur.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        isRead: { type: "boolean", default: true },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "star_email",
    title: "Star / Unstar Email",
    description:
      "Toggle the starred (flagged) status of an email. isStarred defaults to true. Pass sourceFolder whenever the UID came from a folder other than INBOX.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        isStarred: { type: "boolean", default: true },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "move_email",
    title: "Move Email",
    description:
      "Move an email to a different folder. Common targets: Trash, Archive, Spam, INBOX, Folders/MyFolder. Pass sourceFolder whenever the UID came from a folder other than INBOX — IMAP UIDs are folder-scoped.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        targetFolder: {
          type: "string",
          description: "Destination folder path (e.g. Trash, Archive, Folders/Work)",
        },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId", "targetFolder"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "archive_email",
    title: "Archive Email",
    description:
      "Move an email to the Archive folder. Convenience wrapper for move_email targeting Archive. Note: labels are lost when an email is moved — label copies in Labels/ folders are not preserved.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "move_to_trash",
    title: "Move Email to Trash",
    description:
      "Move an email to the Trash folder. Convenience wrapper for move_email targeting Trash. Note: labels are lost when an email is moved — label copies in Labels/ folders are not preserved. Destructive: requires { confirmed: true }.",
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
    name: "move_to_spam",
    title: "Move Email to Spam",
    description:
      "Move an email to the Spam folder. Convenience wrapper for move_email targeting Spam. Destructive: requires { confirmed: true }.",
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
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId", "folder"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "bulk_mark_read",
    title: "Bulk Mark Emails Read/Unread",
    description:
      "Mark multiple emails as read or unread. Emits progress notifications. Returns success/failed counts. Pass sourceFolder whenever the UIDs came from a folder other than INBOX.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Array of email UIDs" },
        isRead: { type: "boolean", default: true },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailIds"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
  {
    name: "bulk_star",
    title: "Bulk Star/Unstar Emails",
    description:
      "Star or unstar multiple emails. Emits progress notifications. Returns success/failed counts. Pass sourceFolder whenever the UIDs came from a folder other than INBOX.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Array of email UIDs" },
        isStarred: { type: "boolean", default: true },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailIds"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
  {
    name: "bulk_move_emails",
    title: "Bulk Move Emails",
    description:
      "Move multiple emails to a folder in one call. Emits progress notifications if a progressToken is provided in _meta. Returns success/failed counts. Pass sourceFolder whenever the UIDs came from a folder other than INBOX.",
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
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailIds", "targetFolder"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
  {
    name: "move_to_label",
    title: "Move Email to Label",
    description:
      "Apply a label to an email. The email remains in its original folder and also appears in Labels/{label}. Labels are additive — an email can have multiple labels simultaneously.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string" },
        label: {
          type: "string",
          description: "Label name without prefix (e.g. Work). Moves to Labels/Work.",
        },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailId", "label"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "bulk_move_to_label",
    title: "Bulk Move Emails to Label",
    description:
      "Apply a label to multiple emails. Each email remains in its original folder and also appears in Labels/{label}. Progress notifications are sent for large batches.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" } },
        label: { type: "string", description: "Label name without prefix" },
        sourceFolder: SOURCE_FOLDER_SCHEMA,
      },
      required: ["emailIds", "label"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
  {
    name: "remove_label",
    title: "Remove Label from Email",
    description:
      "Remove a label from an email. The email is removed from Labels/{label} but remains in its original folder (Inbox, etc.). The UID passed must be the UID in Labels/{label} (not the INBOX/source UID) — Labels/ folders have their own UID space.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailId: { type: "string", description: "UID of the email inside Labels/{label}" },
        label: { type: "string", description: "Label name to remove (e.g. Work)" },
      },
      required: ["emailId", "label"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "bulk_remove_label",
    title: "Bulk Remove Label from Emails",
    description:
      "Remove a label from multiple emails. Emails are removed from Labels/{label} but remain in their original folders. The UIDs passed must be the UIDs inside Labels/{label} — Labels/ folders have their own UID space, so INBOX UIDs will silently miss.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        emailIds: { type: "array", items: { type: "string" }, description: "Array of UIDs inside Labels/{label}" },
        label: { type: "string", description: "Label name to remove" },
      },
      required: ["emailIds", "label"],
    },
    outputSchema: BULK_RESULT_SCHEMA,
  },
];

export const handlers: Record<string, ToolHandler> = {
  mark_email_read: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const merEmailId = requireNumericEmailId(args.emailId);
    if (args.isRead !== undefined && typeof args.isRead !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isRead' must be a boolean when provided.");
    }
    const isRead = args.isRead !== undefined ? (args.isRead as boolean) : true;
    const merSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.markEmailRead(merEmailId, isRead, merSourceFolder);
    return actionOk();
  },

  star_email: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const seEmailId = requireNumericEmailId(args.emailId);
    if (args.isStarred !== undefined && typeof args.isStarred !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isStarred' must be a boolean when provided.");
    }
    const isStarred = args.isStarred !== undefined ? (args.isStarred as boolean) : true;
    const seSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.starEmail(seEmailId, isStarred, seSourceFolder);
    return actionOk();
  },

  move_email: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const mvEmailId = requireNumericEmailId(args.emailId);
    const mvValidErr = validateTargetFolder(args.targetFolder);
    if (mvValidErr) throw new McpError(ErrorCode.InvalidParams, mvValidErr);
    const mvSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.moveEmail(mvEmailId, args.targetFolder as string, mvSourceFolder);
    return actionOk();
  },

  archive_email: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const aeEmailId = requireNumericEmailId(args.emailId);
    const aeSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.moveEmail(aeEmailId, "Archive", aeSourceFolder);
    return actionOk();
  },

  move_to_trash: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const mttEmailId = requireNumericEmailId(args.emailId);
    const mttSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.moveEmail(mttEmailId, "Trash", mttSourceFolder);
    return actionOk();
  },

  move_to_spam: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const mtsEmailId = requireNumericEmailId(args.emailId);
    const mtsSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.moveEmail(mtsEmailId, "Spam", mtsSourceFolder);
    return actionOk();
  },

  move_to_folder: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const mtfEmailId = requireNumericEmailId(args.emailId);
    const folderName = args.folder as string;
    const folderValidErr = validateFolderName(folderName);
    if (folderValidErr) throw new McpError(ErrorCode.InvalidParams, folderValidErr);
    const mtfSourceFolder = optionalSourceFolder(args.sourceFolder);
    await imapService.moveEmail(mtfEmailId, `Folders/${folderName}`, mtfSourceFolder);
    return actionOk();
  },

  bulk_mark_read: async (ctx) => {
    const { args, imapService, bulkOk, sendProgress, MAX_BULK_IDS } = ctx;
    if (!Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "emailIds must be a non-empty array of numeric UID strings.");
    }
    const bmrEmailIds: string[] = (args.emailIds as unknown[])
      .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
      .slice(0, MAX_BULK_IDS);
    if (bmrEmailIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "No valid numeric email IDs in the provided list.");
    }
    if (args.isRead !== undefined && typeof args.isRead !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isRead' must be a boolean when provided.");
    }
    const bmrIsRead = args.isRead !== undefined ? (args.isRead as boolean) : true;
    const bmrSourceFolder = optionalSourceFolder(args.sourceFolder);
    const bmrResults = await imapService.bulkMarkRead(bmrEmailIds, bmrIsRead, bmrSourceFolder);
    await sendProgress(bmrEmailIds.length, bmrEmailIds.length, `Marked ${bmrResults.success} of ${bmrEmailIds.length} (${bmrResults.failed} failed)`);
    return bulkOk(bmrResults);
  },

  bulk_star: async (ctx) => {
    const { args, imapService, bulkOk, sendProgress, MAX_BULK_IDS } = ctx;
    if (!Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "emailIds must be a non-empty array of numeric UID strings.");
    }
    const bsEmailIds: string[] = (args.emailIds as unknown[])
      .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
      .slice(0, MAX_BULK_IDS);
    if (bsEmailIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "No valid numeric email IDs in the provided list.");
    }
    if (args.isStarred !== undefined && typeof args.isStarred !== "boolean") {
      throw new McpError(ErrorCode.InvalidParams, "'isStarred' must be a boolean when provided.");
    }
    const bsIsStarred = args.isStarred !== undefined ? (args.isStarred as boolean) : true;
    const bsSourceFolder = optionalSourceFolder(args.sourceFolder);
    const bsResults = await imapService.bulkStar(bsEmailIds, bsIsStarred, bsSourceFolder);
    await sendProgress(bsEmailIds.length, bsEmailIds.length, `Starred ${bsResults.success} of ${bsEmailIds.length} (${bsResults.failed} failed)`);
    return bulkOk(bsResults);
  },

  bulk_move_emails: async (ctx) => {
    const { args, imapService, bulkOk, sendProgress, MAX_BULK_IDS, state } = ctx;
    const bmValidErr = validateTargetFolder(args.targetFolder);
    if (bmValidErr) throw new McpError(ErrorCode.InvalidParams, bmValidErr);
    if (!Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "emailIds must be a non-empty array of numeric UID strings.");
    }
    const rawIds = args.emailIds as unknown[];
    const emailIds: string[] = rawIds
      .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
      .slice(0, MAX_BULK_IDS);
    if (emailIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "No valid numeric email IDs in the provided list. Email IDs must be numeric UID strings.");
    }
    const targetFolder = args.targetFolder as string;
    const bmSourceFolder = optionalSourceFolder(args.sourceFolder);

    const results = await imapService.bulkMoveEmails(emailIds, targetFolder, bmSourceFolder);
    await sendProgress(emailIds.length, emailIds.length, `Moved ${results.success} of ${emailIds.length} to ${targetFolder} (${results.failed} failed)`);
    state.analyticsCache = null;
    state.analyticsCacheInflight = null;
    return bulkOk(results);
  },

  move_to_label: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const mtlEmailId = requireNumericEmailId(args.emailId);
    if (!args.label || typeof args.label !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'label' is required and must be a string.");
    }
    const label = args.label as string;
    const mtlValidErr = validateLabelName(label);
    if (mtlValidErr) throw new McpError(ErrorCode.InvalidParams, mtlValidErr);
    const mtlSourceFolder = optionalSourceFolder(args.sourceFolder);
    // Create the label mailbox if it doesn't exist — otherwise the copy targets
    // a nonexistent Labels/<name>, which Proton Bridge can silently no-op.
    await imapService.ensureFolderExists(`Labels/${label}`);
    await imapService.copyEmailToFolder(mtlEmailId, `Labels/${label}`, mtlSourceFolder);
    return actionOk();
  },

  bulk_move_to_label: async (ctx) => {
    const { args, imapService, bulkOk, sendProgress, MAX_BULK_IDS, state } = ctx;
    if (!Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "emailIds must be a non-empty array of numeric UID strings.");
    }
    const emailIds2: string[] = (args.emailIds as unknown[])
      .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
      .slice(0, MAX_BULK_IDS);
    if (emailIds2.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "No valid numeric email IDs in the provided list.");
    }
    if (!args.label || typeof args.label !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'label' is required and must be a string.");
    }
    const rawLabel = args.label as string;
    const bmlValidErr = validateLabelName(rawLabel);
    if (bmlValidErr) throw new McpError(ErrorCode.InvalidParams, bmlValidErr);
    const labelFolder = `Labels/${rawLabel}`;
    const bmlSourceFolder = optionalSourceFolder(args.sourceFolder);

    // Create the label mailbox if it doesn't exist — otherwise the copy targets
    // a nonexistent Labels/<name>, which Proton Bridge can silently no-op.
    await imapService.ensureFolderExists(labelFolder);
    const results2 = await imapService.bulkCopyToFolder(emailIds2, labelFolder, bmlSourceFolder);
    await sendProgress(emailIds2.length, emailIds2.length, `Labeled ${results2.success} of ${emailIds2.length} (${results2.failed} failed)`);
    state.analyticsCache = null;
    state.analyticsCacheInflight = null;
    return bulkOk(results2);
  },

  remove_label: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const rlEmailId = requireNumericEmailId(args.emailId);
    if (!args.label || typeof args.label !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'label' is required and must be a string.");
    }
    const rlLabel = args.label as string;
    const rlLabelValidErr = validateLabelName(rlLabel);
    if (rlLabelValidErr) throw new McpError(ErrorCode.InvalidParams, rlLabelValidErr);
    await imapService.deleteFromFolder(rlEmailId, `Labels/${rlLabel}`);
    return actionOk();
  },

  bulk_remove_label: async (ctx) => {
    const { args, imapService, bulkOk, sendProgress, MAX_BULK_IDS, state } = ctx;
    if (!Array.isArray(args.emailIds) || (args.emailIds as unknown[]).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "emailIds must be a non-empty array of numeric UID strings.");
    }
    const brlEmailIds: string[] = (args.emailIds as unknown[])
      .filter((id): id is string => typeof id === "string" && /^\d+$/.test(id))
      .slice(0, MAX_BULK_IDS);
    if (brlEmailIds.length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "No valid numeric email IDs in the provided list.");
    }
    if (!args.label || typeof args.label !== "string") {
      throw new McpError(ErrorCode.InvalidParams, "'label' is required and must be a string.");
    }
    const brlLabel = args.label as string;
    const brlLabelValidErr = validateLabelName(brlLabel);
    if (brlLabelValidErr) throw new McpError(ErrorCode.InvalidParams, brlLabelValidErr);
    const brlLabelFolder = `Labels/${brlLabel}`;

    const brlResults = await imapService.bulkDeleteFromFolder(brlEmailIds, brlLabelFolder);
    await sendProgress(brlEmailIds.length, brlEmailIds.length, `Unlabeled ${brlResults.success} of ${brlEmailIds.length} (${brlResults.failed} failed)`);
    state.analyticsCache = null;
    state.analyticsCacheInflight = null;
    return bulkOk(brlResults);
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
