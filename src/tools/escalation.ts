/**
 * Permission escalation meta-tools.
 *
 * These two tools sit OUTSIDE the permission-gate chain — they are
 * ALWAYS_AVAILABLE (config/schema.ts) so an agent that has been over-restricted
 * can still ASK for more access. They can never GRANT access: approval requires
 * a human clicking Approve in the settings UI.
 *
 * The per-call dispatcher in src/index.ts invokes these handlers BEFORE running
 * account routing, agent grants, permission gate, or destructive-confirm. The
 * signature here is intentionally lighter than ToolHandler because escalation
 * runs pre-gate — it only needs args + a live config snapshot for the settings
 * URL.
 */

import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { requestEscalation, getEscalationStatus, isUpgrade } from "../permissions/escalation.js";
import { loadConfig, defaultConfig } from "../config/loader.js";
import type { PermissionPreset } from "../config/schema.js";
import { isValidChallengeId, sanitizeText, isValidEscalationTarget } from "../settings/security.js";
import type { ProtonMailConfig } from "../types/index.js";
import { logger } from "../utils/logger.js";
import { requireNonEmptyString } from "../utils/helpers.js";
import type { ToolDef, ToolResult } from "./types.js";

void logger;

export interface EscalationContext {
  args: Record<string, unknown>;
  config: ProtonMailConfig;
  /**
   * PERM-002: identity of the agent making the escalation request, so the
   * approval card can surface it. `clientId === "stdio"` for the local
   * stdio transport (no OAuth identity); for HTTP/OAuth callers, this is
   * the real client id and (optionally) the human-readable client name.
   * Optional for back-compat with any test harness that doesn't supply it.
   */
  caller?: { clientId: string; clientName?: string };
}

export type EscalationHandler = (ctx: EscalationContext) => Promise<ToolResult>;

export const defs: ToolDef[] = [
  {
    name: "request_permission_escalation",
    title: "Request Permission Escalation",
    description:
      "Request an increase in the server's active permission preset. " +
      "YOU CANNOT APPROVE THIS YOURSELF — approval requires a human to open the " +
      "settings UI and click Approve. " +
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
];

/**
 * `request_permission_escalation`'s description renders the settings-UI URL
 * at ListTools time using the then-current port. Returns the dynamic description
 * so the ListTools handler can inject the live port before sending tools to
 * the client.
 */
export function describeRequestEscalation(settingsPort: number): string {
  return (
    "Request an increase in the server's active permission preset. " +
    "YOU CANNOT APPROVE THIS YOURSELF — approval requires a human to open the " +
    `settings UI (http://localhost:${settingsPort}) and click Approve. ` +
    "Use check_escalation_status to poll for the result. " +
    "Downgrading (reducing access) never requires a challenge."
  );
}

export const handlers: Record<string, EscalationHandler> = {
  request_permission_escalation: async (ctx) => {
    const { args, config } = ctx;
    const targetPreset = args.target_preset;
    // `reason` is declared required in inputSchema; enforce it at runtime so an
    // omitted/blank reason can't land a real escalation logged as "No reason
    // provided" (TOOL-002).
    const reason       = sanitizeText(requireNonEmptyString(args.reason, "reason"), 500);
    if (!isValidEscalationTarget(targetPreset)) {
      throw new McpError(ErrorCode.InvalidParams, "Invalid target_preset. Must be one of: send_only, supervised, full");
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
    const result = requestEscalation(validatedPreset, currentPreset, reason, {
      clientId:   ctx.caller?.clientId,
      clientName: ctx.caller?.clientName,
    });
    if (!result.ok) {
      return { content: [{ type: "text" as const, text: result.error }], isError: true };
    }
    const settingsUrl = `http://localhost:${config.settingsPort ?? 8766}`;
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
  },

  check_escalation_status: async (ctx) => {
    const { args } = ctx;
    const challengeId = args.challenge_id;
    if (!isValidChallengeId(challengeId)) {
      throw new McpError(ErrorCode.InvalidParams, "challenge_id must be a 32-character lowercase hex string.");
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
  },
};
