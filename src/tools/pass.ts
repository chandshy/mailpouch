/**
 * Proton Pass tools: pass_list, pass_search, pass_get, pass_totp.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { PassCliUnavailableError } from "../services/pass-service.js";
import type { ToolDef, ToolHandler, ToolModule } from "./types.js";

export const defs: ToolDef[] = [
  {
    name: "pass_list",
    title: "List Proton Pass Items",
    description: "List credentials stored in Proton Pass. Returns item summaries (id, name, type, vault) — no secret values. Requires passAccessToken + pass-cli to be installed.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        vault: { type: "string", description: "Optional vault name to filter to" },
      },
    },
    outputSchema: {
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              type: { type: "string" },
              vault: { type: "string" },
              updatedAt: { type: "string", format: "date-time" },
            },
          },
        },
      },
      required: ["items"],
    },
  },
  {
    name: "pass_search",
    title: "Search Proton Pass Items",
    description: "Case-insensitive substring search across Proton Pass item summaries (name, URL, note, vault). Filtered client-side from the item list — returns summaries only; use pass_get to retrieve decrypted content for a specific item.",
    annotations: { readOnlyHint: true },
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        items: { type: "array" },
      },
      required: ["items"],
    },
  },
  {
    name: "pass_get",
    title: "Get Proton Pass Item",
    description: "Retrieve a single Proton Pass item by ID, INCLUDING its decrypted secret fields (password, TOTP, note body). Every call is audit-logged and requires { confirmed: true }. Prefer pass_list / pass_search for non-credential lookups.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Item ID from pass_list or pass_search" },
      },
      required: ["item_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        name: { type: "string" },
        type: { type: "string" },
        username: { type: "string" },
        fields: { type: "object", additionalProperties: { type: "string" }, description: "Extra string fields parsed from the Pass entry body. Omitted entirely when the entry has none — clients must treat `fields` as optional, not always-present." },
        note: { type: "string" },
        url: { type: "string" },
      },
      required: ["id", "name", "type"],
    },
  },
  {
    name: "pass_totp",
    title: "Get Proton Pass TOTP Code",
    description: "Retrieve the current TOTP/2FA code for a Proton Pass item by ID. Reveals a live second factor — every call is audit-logged and requires { confirmed: true }. Codes are time-limited; fetch immediately before use.",
    annotations: { destructiveHint: true },
    inputSchema: {
      type: "object",
      properties: {
        item_id: { type: "string", description: "Item ID from pass_list or pass_search" },
      },
      required: ["item_id"],
    },
    outputSchema: {
      type: "object",
      properties: {
        code: { type: "string", description: "The current TOTP code" },
        totp: { type: "string", description: "The current TOTP code (alias field, CLI-shape dependent)" },
      },
    },
  },
];

export const handlers: Record<string, ToolHandler> = {
  pass_list: async (ctx) => {
    const { args, passService, ok } = ctx;
    if (!passService) {
      throw new McpError(ErrorCode.InvalidRequest, "Proton Pass is not configured. Set passAccessToken in Settings → Pass.");
    }
    const vault = typeof args.vault === "string" ? args.vault : undefined;
    try {
      const items = await passService.listItems(vault);
      return ok({ items });
    } catch (err: unknown) {
      if (err instanceof PassCliUnavailableError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw err;
    }
  },

  pass_search: async (ctx) => {
    const { args, passService, ok } = ctx;
    if (!passService) {
      throw new McpError(ErrorCode.InvalidRequest, "Proton Pass is not configured. Set passAccessToken in Settings → Pass.");
    }
    const query = typeof args.query === "string" ? args.query.trim() : "";
    if (!query) throw new McpError(ErrorCode.InvalidParams, "query must be a non-empty string.");
    try {
      const items = await passService.searchItems(query);
      return ok({ items });
    } catch (err: unknown) {
      if (err instanceof PassCliUnavailableError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw err;
    }
  },

  pass_get: async (ctx) => {
    const { args, passService, ok } = ctx;
    if (!passService) {
      throw new McpError(ErrorCode.InvalidRequest, "Proton Pass is not configured. Set passAccessToken in Settings → Pass.");
    }
    const itemId = typeof args.item_id === "string" ? args.item_id.trim() : "";
    if (!itemId) throw new McpError(ErrorCode.InvalidParams, "item_id must be a non-empty string.");
    try {
      const item = await passService.getItem(itemId);
      return ok(item as unknown as Record<string, unknown>);
    } catch (err: unknown) {
      if (err instanceof PassCliUnavailableError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw err;
    }
  },

  pass_totp: async (ctx) => {
    const { args, passService, ok } = ctx;
    if (!passService) {
      throw new McpError(ErrorCode.InvalidRequest, "Proton Pass is not configured. Set passAccessToken in Settings → Pass.");
    }
    const itemId = typeof args.item_id === "string" ? args.item_id.trim() : "";
    if (!itemId) throw new McpError(ErrorCode.InvalidParams, "item_id must be a non-empty string.");
    try {
      const totp = await passService.getTotp(itemId);
      return ok(totp);
    } catch (err: unknown) {
      if (err instanceof PassCliUnavailableError) {
        throw new McpError(ErrorCode.InvalidRequest, err.message);
      }
      throw err;
    }
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
