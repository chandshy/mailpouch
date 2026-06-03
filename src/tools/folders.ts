/**
 * Folder management tools: get_folders, sync_folders, create_folder,
 * delete_folder, rename_folder.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { validateRequiredTargetFolder } from "../utils/helpers.js";
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

export const defs: ToolDef[] = [
  {
    name: "get_folders",
    title: "Get Folders",
    description:
      "List all email folders with message counts. Labels appear as folders with the Labels/ prefix (e.g. Labels/Work). " +
      "Each folder reports `folderType` (system | user-folder | label) and, for system mailboxes, the IMAP `specialUse` " +
      "attribute (\\Inbox \\Sent \\Drafts \\Trash \\Junk \\Archive \\All \\Flagged) — use these to identify the real " +
      "Trash/Sent/Archive on a localised account rather than matching English names, and to avoid moving mail into the " +
      "\\All (All Mail) union view.",
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
              specialUse: {
                type: "string",
                description: "IMAP special-use attribute for system mailboxes (e.g. \\Trash, \\Sent, \\All). Absent for ordinary folders/labels.",
              },
              folderType: {
                type: "string",
                enum: ["system", "user-folder", "label"],
                description: "Proton Bridge classification: system mailbox, user-created folder, or label (Labels/ prefix).",
              },
            },
            required: ["name", "path", "totalMessages", "unreadMessages", "folderType"],
          },
        },
      },
      required: ["folders"],
    },
  },
  {
    name: "sync_folders",
    title: "Sync Folders",
    description: "Refresh the folder list from IMAP (invalidates folder cache). Call this after creating/renaming/deleting folders in another client or if folder counts seem stale.",
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
      "Delete an empty folder or label. Protected system folders (INBOX, Sent, Drafts, Trash, Spam, Archive, All Mail, Starred) cannot be deleted.",
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
];

export const handlers: Record<string, ToolHandler> = {
  get_folders: async (ctx) => {
    const { imapService, ok } = ctx;
    const folders = await imapService.getFolders();
    return ok({ folders });
  },

  sync_folders: async (ctx) => {
    const { imapService, ok } = ctx;
    // Force a fresh fetch (bypass the folder cache) — that's the whole point of
    // an explicit "sync"; the cached get_folders could otherwise echo stale data.
    const folders = await imapService.syncFolders();
    return ok({ success: true, folderCount: folders.length });
  },

  create_folder: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    // VALID-011: single required-name gate (rejects empty/whitespace + invalid
    // chars in one McpError shape).
    const folderName = validateRequiredTargetFolder(args.folderName, "folderName");
    await imapService.createFolder(folderName);
    return actionOk();
  },

  delete_folder: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const folderName = validateRequiredTargetFolder(args.folderName, "folderName");
    await imapService.deleteFolder(folderName);
    return actionOk();
  },

  rename_folder: async (ctx) => {
    const { args, imapService, actionOk } = ctx;
    const oldName = validateRequiredTargetFolder(args.oldName, "oldName");
    const newName = validateRequiredTargetFolder(args.newName, "newName");
    if (oldName === newName) {
      throw new McpError(ErrorCode.InvalidParams, "'newName' must be different from 'oldName'.");
    }
    await imapService.renameFolder(oldName, newName);
    return actionOk();
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
