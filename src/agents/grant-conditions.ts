/**
 * Shared validation for grant conditions accepted through the Settings API and
 * service-account issuance paths.
 *
 * Keep this at the agent boundary rather than duplicating partial whitelists in
 * routes: a condition accepted for an interactive grant must have identical
 * semantics when attached to a headless service account.
 */

import { ALL_TOOLS, canonicalToolName, type ToolName } from "../config/schema.js";
import type { GrantConditions } from "./types.js";

/** Bound a durable rolling-hour ledger even when an operator configures many grants. */
export const MAX_AGENT_TOOL_CALLS_PER_HOUR = 10_000;

/** A valid cap is a whole number of calls; zero deliberately disables a tool. */
export function isValidAgentToolHourlyCap(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_AGENT_TOOL_CALLS_PER_HOUR;
}

/**
 * Whitelist and normalize operator-provided grant conditions.
 *
 * Alias keys normalize to their canonical tool, and an explicitly canonical
 * key wins over an alias regardless of JSON property order. Invalid values are
 * dropped at the write boundary; malformed values already persisted on disk
 * remain fail-closed in GrantManager when loaded.
 */
export function sanitizeGrantConditions(input: unknown): GrantConditions | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;

  const raw = input as Record<string, unknown>;
  const out: GrantConditions = {};
  if (typeof raw.expiresAt === "string") out.expiresAt = raw.expiresAt;
  if (typeof raw.accountId === "string") out.accountId = raw.accountId;
  if (Array.isArray(raw.folderAllowlist)) {
    out.folderAllowlist = raw.folderAllowlist.filter((value): value is string => typeof value === "string");
  }
  if (Array.isArray(raw.ipPins)) {
    out.ipPins = raw.ipPins.filter((value): value is string => typeof value === "string");
  }

  const rawCaps = raw.maxCallsPerHourByTool;
  if (rawCaps && typeof rawCaps === "object" && !Array.isArray(rawCaps)) {
    const knownTools = new Set<string>(ALL_TOOLS as readonly string[]);
    const caps: Partial<Record<ToolName, number>> = {};
    for (const [configuredTool, value] of Object.entries(rawCaps as Record<string, unknown>)) {
      const canonicalTool = canonicalToolName(configuredTool);
      if (!knownTools.has(canonicalTool) || !isValidAgentToolHourlyCap(value)) continue;

      // A canonical setting takes precedence over its compatibility alias. An
      // alias only fills the canonical slot when no canonical value has been
      // supplied, which keeps the result independent of JSON key order.
      if (configuredTool === canonicalTool || !Object.prototype.hasOwnProperty.call(caps, canonicalTool)) {
        caps[canonicalTool as ToolName] = value;
      }
    }
    if (Object.keys(caps).length > 0) out.maxCallsPerHourByTool = caps;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
