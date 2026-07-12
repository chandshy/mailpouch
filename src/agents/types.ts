/**
 * Shared types for the agent-grant system.
 *
 * A mailpouch deployment typically serves more than one MCP client
 * (Claude Desktop, Claude Code, other hosts). Every client identifies
 * itself via an OAuth client_id issued by DCR. An AgentGrant records the
 * user's decision about that specific client: is it approved, what can
 * it do, when does the approval expire.
 *
 * Grants are orthogonal to the global permission preset. The global
 * preset is still the upper bound — a grant's effective permissions are
 * intersected with the global config before tool dispatch — but within
 * that ceiling each agent has its own independently-revocable surface.
 */

import type { PermissionPreset, ToolName } from "../config/schema.js";

export type AgentGrantStatus = "pending" | "active" | "revoked" | "expired";

export interface GrantConditions {
  /** ISO-8601 timestamp; undefined means no expiry. */
  expiresAt?: string;
  /**
   * Folder names the grant is restricted to. Undefined/empty = all folders.
   * Matched case-insensitively against the IMAP folder path.
   */
  folderAllowlist?: string[];
  /**
   * IP addresses allowed to present this agent's OAuth token. Undefined
   * means any IP. Matched literally against the socket remoteAddress.
   */
  ipPins?: string[];
  /**
   * Per-tool rolling rate cap, calls per hour. Undefined means uncapped;
   * zero explicitly denies every call to that tool for this grant. Accepted
   * values are bounded to 10,000 to keep the durable quota ledger finite.
   */
  maxCallsPerHourByTool?: Partial<Record<ToolName, number>>;
  /** Which account the grant is bound to. Undefined = default active account. */
  accountId?: string;
}

export interface AgentGrant {
  clientId: string;
  clientName: string;
  status: AgentGrantStatus;
  /** Effective preset for this agent. Capped by the global config preset. */
  preset: PermissionPreset;
  /**
   * Per-tool overrides applied on top of the preset. A tool set to `false`
   * is denied even if the preset permits it; `true` opens it even if the
   * preset denies it — still bounded by the ALL_TOOLS registry and the
   * global preset's overall allowance.
   */
  toolOverrides?: Partial<Record<ToolName, boolean>>;
  conditions?: GrantConditions;
  /** ISO-8601 timestamp. When the grant record was first created (at DCR time). */
  createdAt: string;
  /** ISO-8601 timestamp. When the user flipped the grant to "active". */
  approvedAt?: string;
  /** ISO-8601 timestamp. When the user revoked. */
  revokedAt?: string;
  /** ISO-8601 timestamp. Updated on every successful tool call. */
  lastCallAt?: string;
  /** Incremented on every successful tool call. */
  totalCalls: number;
  /** Optional note the user attached on approval. */
  note?: string;
  /**
   * Durable provenance for grants backed by a client_credentials service
   * account. Unlike a display note or transport value, this survives normal
   * grant edits and lets authorization require the matching credential record
   * to remain present.
   */
  credentialKind?: "service_account";
  /**
   * IP the agent registered (DCR'd) from, captured at registration time and
   * shown on the approval card so the user has context to approve/deny the
   * connection. Optional — older stored grants won't have it.
   */
  registeredFromIp?: string;
  /**
   * Live connection info captured at the MCP `initialize` handshake (distinct
   * from the DCR-supplied `clientName`): the MCP client's self-reported name +
   * version, the transport it connected over, and when it last connected.
   * Display-only context for the Agents tab — NOT identity (identity is the
   * server-issued `clientId`). Optional; populated on connect.
   */
  mcpClientName?: string;
  mcpClientVersion?: string;
  transport?: "http" | "stdio";
  /** ISO-8601 timestamp of the most recent MCP handshake (connect). */
  lastConnectedAt?: string;
}

/** Result returned by the permission check when gating a tool call. */
export interface GrantCheckResult {
  allowed: boolean;
  /** Human-readable reason when allowed=false. */
  reason?: string;
  /** Effective preset applied for this call (for audit logging). */
  effectivePreset?: PermissionPreset;
}

/**
 * Row appended to the audit log per tool invocation. Intentionally does NOT
 * carry argument values or response bodies — the agent already saw both and
 * we don't want a parallel copy of the user's email on disk. An argHash
 * lets callers see "same call repeated" patterns without exposing content.
 */
export interface AuditRow {
  /** ISO-8601 timestamp. */
  ts: string;
  clientId: string;
  clientName?: string;
  tool: string;
  /** Truncated sha256 of JSON.stringify(args); empty string when args absent. */
  argHash: string;
  /** True when the tool completed successfully (ok: true in the response). */
  ok: boolean;
  /** Wall-clock duration of the dispatcher call, in milliseconds. */
  durMs: number;
  /** When the grant check blocked the call, the reason string. Omitted on ok=true. */
  blockedReason?: string;
  /** Caller IP when available (OAuth/bearer path only). */
  ip?: string;
}
