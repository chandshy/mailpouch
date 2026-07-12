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
import { isIP } from "node:net";

/** Bound a durable rolling-hour ledger even when an operator configures many grants. */
export const MAX_AGENT_TOOL_CALLS_PER_HOUR = 10_000;

/** A valid cap is a whole number of calls; zero deliberately disables a tool. */
export function isValidAgentToolHourlyCap(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 0
    && value <= MAX_AGENT_TOOL_CALLS_PER_HOUR;
}

const EXTERNAL_CONDITION_FIELDS = new Set([
  "expiresAt",
  "accountId",
  "folderAllowlist",
  "ipPins",
  "maxCallsPerHourByTool",
]);

export type GrantConditionsValidationResult =
  | { ok: true; conditions?: GrantConditions }
  | { ok: false; error: string };

function validFolderPath(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1_000
    && value === value.trim()
    && !value.includes("..")
    && !/[\x00-\x1f\x7f-\x9f]/.test(value);
}

function validIpPin(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value === value.trim()
    && !/[\x00-\x20\x7f-\x9f]/.test(value)
    && isIP(value) !== 0;
}

/**
 * Strictly parse conditions arriving at an untrusted HTTP boundary.
 *
 * Access-control input must never be "best effort": silently dropping a
 * malformed account binding, folder allowlist, or hourly cap turns an
 * operator's intended restriction into broader authority. Unknown fields are
 * rejected as likely typos. Internal accountIdentity fingerprints are added by
 * the settings server only after this parser succeeds and are intentionally
 * not accepted from callers.
 */
export function validateGrantConditions(input: unknown): GrantConditionsValidationResult {
  if (input === undefined) return { ok: true };
  if (typeof input !== "object" || Array.isArray(input)) {
    return { ok: false, error: "conditions must be an object." };
  }

  const raw = input as Record<string, unknown>;
  const unknown = Object.keys(raw).filter(field => !EXTERNAL_CONDITION_FIELDS.has(field));
  if (unknown.length > 0) {
    return { ok: false, error: `Unknown grant condition${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ")}.` };
  }

  const out: GrantConditions = {};
  if (raw.expiresAt !== undefined) {
    if (typeof raw.expiresAt !== "string" || !Number.isFinite(Date.parse(raw.expiresAt))) {
      return { ok: false, error: "conditions.expiresAt must be a valid ISO-8601 timestamp." };
    }
    out.expiresAt = raw.expiresAt;
  }
  if (raw.accountId !== undefined) {
    if (typeof raw.accountId !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(raw.accountId)) {
      return { ok: false, error: "conditions.accountId must be a valid configured account ID." };
    }
    out.accountId = raw.accountId;
  }
  if (raw.folderAllowlist !== undefined) {
    if (!Array.isArray(raw.folderAllowlist) || !raw.folderAllowlist.every(validFolderPath)) {
      return { ok: false, error: "conditions.folderAllowlist must contain only valid non-empty folder paths." };
    }
    out.folderAllowlist = [...raw.folderAllowlist];
  }
  if (raw.ipPins !== undefined) {
    if (!Array.isArray(raw.ipPins) || !raw.ipPins.every(validIpPin)) {
      return { ok: false, error: "conditions.ipPins must contain only valid IP addresses." };
    }
    out.ipPins = [...raw.ipPins];
  }

  if (raw.maxCallsPerHourByTool !== undefined) {
    if (!raw.maxCallsPerHourByTool
      || typeof raw.maxCallsPerHourByTool !== "object"
      || Array.isArray(raw.maxCallsPerHourByTool)) {
      return { ok: false, error: "conditions.maxCallsPerHourByTool must be an object." };
    }
    const knownTools = new Set<string>(ALL_TOOLS as readonly string[]);
    const caps: Partial<Record<ToolName, number>> = {};
    for (const [configuredTool, value] of Object.entries(raw.maxCallsPerHourByTool as Record<string, unknown>)) {
      const canonicalTool = canonicalToolName(configuredTool);
      if (!knownTools.has(canonicalTool)) {
        return { ok: false, error: `Unknown tool in conditions.maxCallsPerHourByTool: ${configuredTool}.` };
      }
      if (!isValidAgentToolHourlyCap(value)) {
        return {
          ok: false,
          error: `Hourly cap for ${configuredTool} must be a whole number between 0 and ${MAX_AGENT_TOOL_CALLS_PER_HOUR}.`,
        };
      }
      if (configuredTool === canonicalTool || !Object.prototype.hasOwnProperty.call(caps, canonicalTool)) {
        caps[canonicalTool as ToolName] = value;
      }
    }
    if (Object.keys(caps).length > 0) out.maxCallsPerHourByTool = caps;
  }

  return Object.keys(out).length > 0
    ? { ok: true, conditions: out }
    : { ok: true };
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
  if (out.accountId && typeof raw.accountIdentity === "string" && /^[a-f0-9]{64}$/i.test(raw.accountIdentity)) {
    out.accountIdentity = raw.accountIdentity;
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
