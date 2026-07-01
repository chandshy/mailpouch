/**
 * SimpleLogin alias tools: alias_list, alias_create_random,
 * alias_create_custom, alias_update, alias_toggle, alias_delete,
 * alias_get_activity, and reverse-alias contacts: alias_list_contacts,
 * alias_create_contact, alias_toggle_contact, alias_delete_contact.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import type { ToolDef, ToolHandler, ToolModule } from "./types.js";
import { clampOptionalInt, requireNonEmptyString } from "../utils/helpers.js";

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
    name: "alias_list",
    title: "List SimpleLogin Aliases",
    description: "List aliases on the configured SimpleLogin account. Returns up to pageSize aliases (default 200). Requires simpleloginApiKey in settings.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        pageSize: { type: "number", description: "Max aliases to return (default 200, cap 1000)" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        aliases: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              email: { type: "string" },
              enabled: { type: "boolean" },
              note: { type: "string" },
              nb_forward: { type: "number" },
              nb_block: { type: "number" },
              nb_reply: { type: "number" },
            },
          },
        },
      },
    },
  },
  {
    name: "alias_create_random",
    title: "Create Random SimpleLogin Alias",
    description: "Create a new random SimpleLogin alias. mode='uuid' produces a long random hex local-part (hardest to guess, good for sensitive signups); mode='word' is two readable words (easier to type). Optional note lets you tag what the alias is for so you can audit later.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        mode: { type: "string", enum: ["uuid", "word"], default: "uuid" },
        note: { type: "string", description: "Free-text note describing what this alias is for" },
        hostname: { type: "string", description: "Optional hostname the alias is being created for (used by SimpleLogin for analytics)" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        email: { type: "string" },
        enabled: { type: "boolean" },
        note: { type: "string" },
      },
    },
  },
  {
    name: "alias_create_custom",
    title: "Create Custom SimpleLogin Alias",
    description: "Create a custom SimpleLogin alias with a user-chosen prefix and a signed suffix (obtain suffixes from SimpleLogin's alias-options endpoint; the UI picker handles this for end users).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        aliasPrefix: { type: "string", description: "Local-part of the alias (before the suffix)" },
        signedSuffix: { type: "string", description: "Signed suffix returned by GET /api/v5/alias/options" },
        mailboxIds: { type: "array", items: { type: "number" }, description: "Mailbox IDs to deliver to" },
        note: { type: "string" },
        name: { type: "string", description: "Display name shown in replies sent through the alias" },
        hostname: { type: "string" },
      },
      required: ["aliasPrefix", "signedSuffix"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        email: { type: "string" },
        enabled: { type: "boolean" },
      },
    },
  },
  {
    name: "alias_toggle",
    title: "Toggle SimpleLogin Alias",
    description: "Enable or disable a SimpleLogin alias. Disabled aliases block all incoming mail without deleting the alias record (useful when a service starts abusing an alias).",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        aliasId: { type: "number" },
      },
      required: ["aliasId"],
    },
    outputSchema: {
      type: "object",
      properties: { enabled: { type: "boolean" } },
    },
  },
  {
    name: "alias_delete",
    title: "Delete SimpleLogin Alias",
    description: "Permanently delete a SimpleLogin alias. Irreversible — prefer alias_toggle unless you are certain. Destructive: requires { confirmed: true }.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        aliasId: { type: "number" },
        confirmed: { type: "boolean", description: "Must be true to execute." },
      },
      required: ["aliasId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "alias_get_activity",
    title: "Get SimpleLogin Alias Activity",
    description: "Return forward/block/reply activity log for a single SimpleLogin alias (most recent first). Useful for auditing what's hitting a specific alias before you disable or delete it.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        aliasId: { type: "number" },
        pageSize: { type: "number", description: "Max activity rows (default 50, cap 1000)" },
      },
      required: ["aliasId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        activities: {
          type: "array",
          items: {
            type: "object",
            properties: {
              action: { type: "string", enum: ["forward", "block", "reply", "bounced"] },
              from: { type: "string" },
              to: { type: "string" },
              timestamp: { type: "number" },
              reverse_alias: { type: "string" },
            },
          },
        },
      },
    },
  },
  {
    name: "alias_update",
    title: "Update SimpleLogin Alias",
    description: "Update an existing SimpleLogin alias in place: display name (shown in replies), note, which mailbox(es) receive its mail, PGP on/off, and pinned state. Provide only the fields you want to change; at least one is required. Use alias_list to find the aliasId and alias_list_mailboxes-equivalent workflow (mailbox_ids come from SimpleLogin's dashboard) to retarget delivery.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        aliasId: { type: "number" },
        name: { type: "string", description: "Display name shown in replies (empty string clears it)" },
        note: { type: "string", description: "Free-text note describing what this alias is for" },
        mailboxIds: { type: "array", items: { type: "number" }, description: "Mailbox IDs that should receive this alias's mail (replaces the current set)" },
        disablePgp: { type: "boolean", description: "true disables PGP encryption for forwards to the mailbox" },
        pinned: { type: "boolean", description: "Pin the alias to the top of the SimpleLogin dashboard" },
      },
      required: ["aliasId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "alias_list_contacts",
    title: "List SimpleLogin Alias Contacts",
    description: "List the reverse-alias contacts for a SimpleLogin alias. Each contact is an external address you can send *as* the alias to; the returned reverse_alias_address is what you put in To: to route a reply out through the alias (encrypted to the recipient's PGP key when set).",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        aliasId: { type: "number" },
        pageSize: { type: "number", description: "Max contacts to return (default 100, cap 1000)" },
      },
      required: ["aliasId"],
    },
    outputSchema: {
      type: "object",
      properties: {
        contacts: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "number" },
              contact: { type: "string" },
              reverse_alias: { type: "string" },
              reverse_alias_address: { type: "string" },
              block_forward: { type: "boolean" },
            },
          },
        },
      },
    },
  },
  {
    name: "alias_create_contact",
    title: "Create SimpleLogin Alias Contact",
    description: "Create (or fetch, if it already exists) a reverse-alias contact so you can send FROM a SimpleLogin alias TO an external address. Send your reply to the returned reverse_alias_address. `contact` is the recipient as \"email@example.com\" or \"Name <email@example.com>\".",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        aliasId: { type: "number" },
        contact: { type: "string", description: "External recipient: \"email@example.com\" or \"Name <email@example.com>\"" },
      },
      required: ["aliasId", "contact"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "number" },
        contact: { type: "string" },
        reverse_alias: { type: "string" },
        reverse_alias_address: { type: "string" },
        existed: { type: "boolean" },
      },
    },
  },
  {
    name: "alias_toggle_contact",
    title: "Block/Unblock SimpleLogin Alias Contact",
    description: "Block or unblock a reverse-alias contact from forwarding. Blocking stops mail to/from that contact without deleting the reverse-alias. Returns the new block_forward state.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "number" },
      },
      required: ["contactId"],
    },
    outputSchema: {
      type: "object",
      properties: { block_forward: { type: "boolean" } },
    },
  },
  {
    name: "alias_delete_contact",
    title: "Delete SimpleLogin Alias Contact",
    description: "Permanently delete a reverse-alias contact. Irreversible — prefer alias_toggle_contact to just block. Destructive: requires { confirmed: true }.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: {
      type: "object",
      properties: {
        contactId: { type: "number" },
        confirmed: { type: "boolean", description: "Must be true to execute." },
      },
      required: ["contactId"],
    },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
];

export const handlers: Record<string, ToolHandler> = {
  alias_list: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    // clampOptionalInt rejects NaN/Infinity (which passed `typeof === "number"`
    // and survived Math.max(1, NaN) as NaN into listAliases' caller-side
    // pagination cap, looping unbounded) — TOOL-006.
    const pageSize = clampOptionalInt(args.pageSize, 200, 1, 1000);
    const aliases = await simpleloginService.listAliases(pageSize);
    return ok({ aliases });
  },

  alias_create_random: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    const mode = args.mode === "word" ? "word" as const : "uuid" as const;
    const note = typeof args.note === "string" ? args.note : undefined;
    const hostname = typeof args.hostname === "string" ? args.hostname : undefined;
    const alias = await simpleloginService.createRandomAlias({ mode, note, hostname });
    return ok({ id: alias.id, email: alias.email, enabled: alias.enabled, note: alias.note ?? "" });
  },

  alias_create_custom: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    // Require non-empty after trim: "" passed the type check and reached
    // SimpleLogin, which answered with an opaque 4xx (TOOL-007).
    const aliasPrefix  = requireNonEmptyString(args.aliasPrefix, "aliasPrefix");
    const signedSuffix = requireNonEmptyString(args.signedSuffix, "signedSuffix");
    const alias = await simpleloginService.createCustomAlias({
      aliasPrefix,
      signedSuffix,
      mailboxIds: Array.isArray(args.mailboxIds) ? (args.mailboxIds as number[]) : undefined,
      note: typeof args.note === "string" ? args.note : undefined,
      name: typeof args.name === "string" ? args.name : undefined,
      hostname: typeof args.hostname === "string" ? args.hostname : undefined,
    });
    return ok({ id: alias.id, email: alias.email, enabled: alias.enabled });
  },

  alias_toggle: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.aliasId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "aliasId must be a number.");
    }
    const result = await simpleloginService.toggleAlias(args.aliasId);
    return ok({ enabled: result.enabled });
  },

  alias_delete: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.aliasId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "aliasId must be a number.");
    }
    await simpleloginService.deleteAlias(args.aliasId);
    return ok({ success: true });
  },

  alias_get_activity: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.aliasId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "aliasId must be a number.");
    }
    const pageSize = clampOptionalInt(args.pageSize, 50, 1, 1000);
    const activities = await simpleloginService.getAliasActivities(args.aliasId, pageSize);
    return ok({ activities });
  },

  alias_update: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.aliasId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "aliasId must be a number.");
    }
    const patch: { name?: string; note?: string; mailbox_ids?: number[]; disable_pgp?: boolean; pinned?: boolean } = {};
    if (typeof args.name === "string") patch.name = args.name;
    if (typeof args.note === "string") patch.note = args.note;
    if (Array.isArray(args.mailboxIds)) patch.mailbox_ids = args.mailboxIds as number[];
    if (typeof args.disablePgp === "boolean") patch.disable_pgp = args.disablePgp;
    if (typeof args.pinned === "boolean") patch.pinned = args.pinned;
    if (Object.keys(patch).length === 0) {
      throw new McpError(ErrorCode.InvalidParams, "Provide at least one field to update (name, note, mailboxIds, disablePgp, or pinned).");
    }
    await simpleloginService.updateAlias(args.aliasId, patch);
    return ok({ success: true });
  },

  alias_list_contacts: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.aliasId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "aliasId must be a number.");
    }
    const pageSize = clampOptionalInt(args.pageSize, 100, 1, 1000);
    const contacts = await simpleloginService.listContacts(args.aliasId, pageSize);
    return ok({ contacts });
  },

  alias_create_contact: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.aliasId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "aliasId must be a number.");
    }
    const contact = requireNonEmptyString(args.contact, "contact");
    const created = await simpleloginService.createContact(args.aliasId, contact);
    return ok({
      id: created.id,
      contact: created.contact,
      reverse_alias: created.reverse_alias,
      reverse_alias_address: created.reverse_alias_address,
      existed: created.existed ?? false,
    });
  },

  alias_toggle_contact: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.contactId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "contactId must be a number.");
    }
    const result = await simpleloginService.toggleContact(args.contactId);
    return ok({ block_forward: result.block_forward });
  },

  alias_delete_contact: async (ctx) => {
    const { args, simpleloginService, ok } = ctx;
    if (!simpleloginService.isConfigured()) {
      throw new McpError(ErrorCode.InvalidRequest, "SimpleLogin API key is not configured. Set simpleloginApiKey in Settings → Aliases.");
    }
    if (typeof args.contactId !== "number") {
      throw new McpError(ErrorCode.InvalidParams, "contactId must be a number.");
    }
    await simpleloginService.deleteContact(args.contactId);
    return ok({ success: true });
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
