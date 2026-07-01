/**
 * Configuration schema for mailpouch
 * Covers connection settings and per-tool agentic access permissions.
 */

// ─── Tool Registry ─────────────────────────────────────────────────────────────

export const ALL_TOOLS = [
  // Sending
  "send_email", "reply_to_email", "forward_email", "send_test_email",
  // Drafts & scheduling
  "save_draft", "schedule_email", "list_scheduled_emails", "cancel_scheduled_email", "list_proton_scheduled",
  "remind_if_no_reply", "list_pending_reminders", "cancel_reminder", "check_reminders",
  // Reading
  "get_emails", "get_email_by_id", "search_emails", "get_unread_count",
  "list_labels", "get_emails_by_label", "download_attachment",
  "get_thread", "get_correspondence_profile",
  "fts_search", "fts_rebuild", "fts_status",
  "extract_action_items", "extract_meeting",
  // Folder management
  "get_folders", "sync_folders", "create_folder", "delete_folder", "rename_folder",
  // Email actions
  "mark_email_read", "star_email", "mark_answered", "mark_forwarded", "move_email", "archive_email",
  "move_to_trash", "move_to_spam", "move_to_folder",
  "bulk_mark_read", "bulk_star", "bulk_move_emails",
  "move_to_label", "bulk_move_to_label",
  "remove_label", "bulk_remove_label",
  // Deletion
  "delete_email", "bulk_delete_emails", "bulk_delete", "empty_trash",
  // Analytics
  "get_email_stats", "get_email_analytics", "get_contacts", "get_volume_trends",
  // System
  "get_connection_status", "sync_emails", "clear_cache", "get_logs", "get_server_version",
  // Bridge & server control
  "start_bridge", "shutdown_server", "restart_server",
  // SimpleLogin aliases (Proton-owned; optional — requires API key)
  "alias_list", "alias_create_random", "alias_create_custom",
  "alias_toggle", "alias_delete", "alias_get_activity",
  "alias_list_contacts", "alias_create_contact", "alias_toggle_contact", "alias_delete_contact",
  // Proton Pass (optional — requires pass-cli and a Personal Access Token)
  "pass_list", "pass_search", "pass_get",
] as const;

export type ToolName = (typeof ALL_TOOLS)[number];

// ─── Tool Categories ───────────────────────────────────────────────────────────

export interface ToolCategory {
  label: string;
  description: string;
  tools: ToolName[];
  /** Default risk level for UI display */
  risk: "safe" | "moderate" | "destructive";
}

export const TOOL_CATEGORIES: Record<string, ToolCategory> = {
  sending: {
    label: "Sending",
    description: "Compose and send outbound email",
    tools: ["send_email", "reply_to_email", "forward_email", "send_test_email"],
    risk: "moderate",
  },
  drafts: {
    label: "Drafts & Scheduling",
    description: "Save drafts and schedule emails for future delivery",
    tools: [
      "save_draft", "schedule_email", "list_scheduled_emails", "cancel_scheduled_email", "list_proton_scheduled",
      "remind_if_no_reply", "list_pending_reminders", "cancel_reminder", "check_reminders",
    ],
    risk: "moderate",
  },
  reading: {
    label: "Reading",
    description: "Fetch, search, preview email content, and download attachments",
    tools: [
      "get_emails", "get_email_by_id", "search_emails", "get_unread_count",
      "list_labels", "get_emails_by_label", "download_attachment",
      "get_thread", "get_correspondence_profile",
      "fts_search", "fts_rebuild", "fts_status",
      "extract_action_items", "extract_meeting",
    ],
    risk: "safe",
  },
  folders: {
    label: "Folder Management",
    description: "List, create, rename, and delete folders",
    tools: ["get_folders", "sync_folders", "create_folder", "delete_folder", "rename_folder"],
    risk: "moderate",
  },
  actions: {
    label: "Email Actions",
    description: "Mark read/unread, star, move, label, and bulk operations",
    tools: [
      "mark_email_read", "star_email", "mark_answered", "mark_forwarded", "move_email", "archive_email",
      "move_to_trash", "move_to_spam", "move_to_folder",
      "bulk_mark_read", "bulk_star", "bulk_move_emails",
      "move_to_label", "bulk_move_to_label",
      "remove_label", "bulk_remove_label",
    ],
    risk: "moderate",
  },
  deletion: {
    label: "Deletion",
    description: "Delete emails by moving them to Trash (recoverable). Includes empty_trash, which PERMANENTLY purges the Trash mailbox — the one unrecoverable, confirm-gated exception.",
    tools: ["delete_email", "bulk_delete_emails", "bulk_delete", "empty_trash"],
    risk: "destructive",
  },
  analytics: {
    label: "Analytics",
    description: "Email statistics, volume trends, and contact insights",
    tools: ["get_email_stats", "get_email_analytics", "get_contacts", "get_volume_trends"],
    risk: "safe",
  },
  system: {
    label: "System",
    description: "Connection status, cache control, server logs, and version info",
    tools: ["get_connection_status", "sync_emails", "clear_cache", "get_logs", "get_server_version"],
    risk: "safe",
  },
  bridge_control: {
    label: "Bridge & Server Control",
    description: "Start Proton Bridge, shut down, or restart the MCP server",
    tools: ["start_bridge", "shutdown_server", "restart_server"],
    risk: "destructive",
  },
  aliases: {
    label: "SimpleLogin Aliases",
    description: "Create and manage SimpleLogin aliases (Proton-owned alias service; requires API key)",
    tools: [
      "alias_list", "alias_create_random", "alias_create_custom",
      "alias_toggle", "alias_delete", "alias_get_activity",
      "alias_list_contacts", "alias_create_contact", "alias_toggle_contact", "alias_delete_contact",
    ],
    risk: "moderate",
  },
  pass: {
    label: "Proton Pass",
    description: "Retrieve credentials from Proton Pass via pass-cli (requires a Personal Access Token).",
    tools: ["pass_list", "pass_search", "pass_get"],
    risk: "moderate",
  },
};

// ─── Permission Types ──────────────────────────────────────────────────────────

export type RateLimitWindow = 'second' | 'minute' | 'hour' | 'day';

export interface ToolPermission {
  /** Whether the tool can be called at all */
  enabled: boolean;
  /** Max calls within the rateLimitWindow. null = unlimited. */
  rateLimit: number | null;
  /** Rolling window for rateLimit enforcement. Defaults to 'hour' when absent. */
  rateLimitWindow?: RateLimitWindow;
}

export const PERMISSION_PRESETS = ["full", "read_only", "supervised", "send_only", "custom"] as const;
export type PermissionPreset = typeof PERMISSION_PRESETS[number];

export interface ServerPermissions {
  preset: PermissionPreset;
  tools: Record<ToolName, ToolPermission>;
}

// ─── Encrypted credential shape (mirrored from src/crypto/credential-encryption.ts) ──

/** Persistent shape of an AES-256-GCM encrypted credential stored in the config file. */
export interface EncryptedCredentialShape {
  algorithm: string;
  version: number;
  iv: string;
  encryptedData: string;
  authTag: string;
}

// ─── Connection Settings ───────────────────────────────────────────────────────

export interface ConnectionSettings {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  /** Runtime plaintext password (empty when credential is stored encrypted or in keychain). */
  password: string;
  /** AES-256-GCM encrypted password blob — see src/crypto/credential-encryption.ts. */
  passwordEncrypted?: EncryptedCredentialShape;
  /** Optional SMTP token for direct smtp.protonmail.ch submission (paid plans) */
  smtpToken: string;
  /** AES-256-GCM encrypted SMTP token blob. */
  smtpTokenEncrypted?: EncryptedCredentialShape;
  /** Path to exported Proton Bridge TLS certificate */
  bridgeCertPath: string;
  /**
   * Explicit opt-in to run IMAP/SMTP against localhost Bridge without a pinned cert.
   * Default false — the services throw at startup if localhost is used with neither
   * a loaded cert nor this flag. Override per-launch with MAILPOUCH_INSECURE_BRIDGE=1.
   */
  allowInsecureBridge?: boolean;
  /**
   * TLS mode for SMTP/IMAP connections.
   * 'starttls' (default) — use STARTTLS upgrade; correct for Proton Bridge.
   * 'ssl'               — implicit TLS (ports 465/993); only for non-Bridge setups.
   */
  tlsMode?: 'starttls' | 'ssl';
  /** Automatically launch Proton Bridge if it is not reachable on MCP server start. */
  autoStartBridge?: boolean;
  /** Explicit path to the Proton Bridge executable. Leave blank to auto-detect. */
  bridgePath?: string;
  /**
   * Remote (HTTP) transport mode. When true, mailpouch listens on an
   * HTTP port for MCP requests instead of stdio, gated by a bearer token.
   * Default false — stdio transport, which is what Claude Desktop spawns.
   */
  remoteMode?: boolean;
  /** Bind host for the HTTP transport. Default 127.0.0.1. */
  remoteHost?: string;
  /** Port for the HTTP transport. Default 8788. */
  remotePort?: number;
  /** HTTP path for the MCP endpoint. Default /mcp. */
  remotePath?: string;
  /**
   * @deprecated The shared static bearer was removed — it bypassed per-agent
   * gating and audit. A present value is ignored with a startup warning. Every
   * agent now authenticates as its own OAuth client: interactive via
   * authorization_code, headless via a service account (`mailpouch agent issue`).
   */
  remoteBearerToken?: string;
  /** Optional HTTPS cert path for the HTTP transport. Required for public exposure. */
  remoteTlsCertPath?: string;
  /** Optional HTTPS key path for the HTTP transport. Must be paired with remoteTlsCertPath. */
  remoteTlsKeyPath?: string;
  /**
   * REQUIRED when remoteMode=true. Enables the OAuth 2.1 endpoints — the only
   * remote-auth mechanism. MCP hosts self-register via /oauth/register and
   * obtain tokens via a PKCE-guarded automatic-consent flow (gated by per-agent
   * Approve/Deny); headless service accounts use the client_credentials grant.
   * Remote mode refuses to start without it.
   */
  remoteOauthEnabled?: boolean;
  /**
   * @deprecated No longer supported and ignored if set. OAuth now uses
   * automatic consent (the agent authenticates automatically via DCR + PKCE)
   * and the sole human gate is the per-agent Approve/Deny in the Agents tab,
   * where a pending request expires after 5 minutes. A startup warning is
   * logged if this is present.
   */
  remoteOauthAdminPassword?: string;
  /**
   * Externally-visible issuer URL for OAuth metadata (defaults to
   * http[s]://remoteHost:remotePort). Override when behind a reverse
   * proxy, e.g. https://mcp.example.com.
   */
  remoteOauthIssuer?: string;
  /** Sustained requests/sec per caller (default 20). */
  remoteRateLimitPerSecond?: number;
  /** Burst size per caller (default 40). */
  remoteRateLimitBurst?: number;
  /**
   * SimpleLogin API key for the alias_* tools. Generated from
   * https://app.simplelogin.io/dashboard/api_key. Leave blank to disable the
   * alias tool group entirely (tools return a configuration error if invoked).
   */
  simpleloginApiKey?: string;
  /** Optional override for SimpleLogin instance base URL (defaults to app.simplelogin.io). */
  simpleloginBaseUrl?: string;
  /**
   * Personal Access Token for Proton Pass CLI. Generated from the Pass web
   * app → Settings → Developer → Personal Access Tokens. Leave blank to
   * disable the pass_* tools entirely. Prefer keychain storage when
   * available; Pass tokens give access to decrypted credentials.
   */
  passAccessToken?: string;
  /** Optional override for the pass-cli binary path (defaults to 'pass-cli' on PATH). */
  passCliPath?: string;
  debug: boolean;
}

/**
 * Minimum Proton Bridge version the MCP server targets.
 * Bumped when Proton ships security-relevant Bridge changes (e.g. v3.21.2
 * strict TLS validation, v3.22.0 FIDO2 + 50 MB import cap). Detected at
 * startup via the IMAP ID command; running an older Bridge logs a warning
 * but does not block connection.
 */
export const BRIDGE_MIN_VERSION = "3.22.0";

// ─── Response Limits ──────────────────────────────────────────────────────────

/**
 * Configurable size guards for MCP tool responses.
 *
 * Claude's MCP client enforces a hard 1 MB limit on tool results and silently
 * drops oversized payloads.  These limits let the server truncate or reject
 * responses *before* they hit that wall, and give operators a knob to tune
 * the trade-off between completeness and reliability.
 */
export interface ResponseLimits {
  /** Hard ceiling in bytes for any single tool response (default 900 KB — 100 KB margin below Claude's 1 MB). */
  maxResponseBytes: number;
  /** Max email body length (chars) returned by get_email_by_id before truncation (default 500 000). */
  maxEmailBodyChars: number;
  /** Max email summaries returned by get_emails / search_emails per call (default 50). */
  maxEmailListResults: number;
  /** Max base64-encoded attachment size in bytes for download_attachment (default 600 000). */
  maxAttachmentBytes: number;
  /** Log a warning when a response exceeds 80 % of maxResponseBytes (default true). */
  warnOnLargeResponse: boolean;
}

export const DEFAULT_RESPONSE_LIMITS: ResponseLimits = {
  maxResponseBytes:    900 * 1024,   // 900 KB
  maxEmailBodyChars:   500_000,
  maxEmailListResults: 50,
  maxAttachmentBytes:  600_000,      // ~440 KB raw → ~600 KB base64
  warnOnLargeResponse: true,
};

// ─── Top-Level Config ──────────────────────────────────────────────────────────

/**
 * Config schema version.
 *   v1 → pre-2026-04 — no explicit insecure-Bridge opt-in (TLS validation was
 *        silently disabled when no cert was configured).
 *   v2 → 2026-04 hardening — allowInsecureBridge is required to keep the legacy
 *        behavior. v1 configs are grandfathered in the loader with a warning.
 *   v3 → 2026-04 multi-account — adds accounts[] + activeAccountId. Legacy
 *        configs auto-migrate: the top-level connection fields are promoted
 *        into a "primary" account on first read and mirrored back on each
 *        save so single-account consumers keep working during the transition.
 */
export const CONFIG_VERSION = 3;

/** Shape-only declaration for schema.ts — see src/notifications/webhooks.ts WebhookEndpoint. */
export interface WebhookEndpointShape {
  id: string;
  url: string;
  secret?: string;
  format?: "cloudevents" | "slack" | "discord" | "raw";
  enabled?: boolean;
  subscribe?: Array<"grant-created" | "grant-approved" | "grant-denied" | "grant-revoked" | "grant-expired">;
}

/** Shape-only declaration for schema.ts — see src/accounts/types.ts AccountSpec. */
export interface AccountSpecShape {
  id: string;
  name: string;
  providerType: "proton-bridge" | "imap";
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  password: string;
  smtpToken?: string;
  bridgeCertPath?: string;
  allowInsecureBridge?: boolean;
  tlsMode?: "starttls" | "ssl";
  autoStartBridge?: boolean;
  bridgePath?: string;
  lastCheckedAt?: string;
  lastCheckResult?: string;
}

// The schema module stays dependency-free; AccountSpec is defined alongside
// the registry in src/accounts/types.ts and is structurally compatible with
// what we persist. We type it as `unknown[]` here to avoid a circular
// import; the accounts registry validates the shape on read.

export interface ServerConfig {
  configVersion: number;
  connection: ConnectionSettings;
  permissions: ServerPermissions;
  /** Where credentials are stored: "keychain" (OS keychain), "encrypted-file" (AES-256-GCM in config), or "config" (plaintext in config — legacy). */
  credentialStorage?: "keychain" | "encrypted-file" | "config";
  /** Tuneable response-size guards — see ResponseLimits. */
  responseLimits?: ResponseLimits;
  /** Port the settings UI server listens on (default 8766). */
  settingsPort?: number;
  /**
   * Progressive tool-disclosure tier. Controls how many tools appear in the
   * ListTools response — reduces context bloat when only a subset is needed.
   *   "core"     — reading / sending / analytics / system (27 categorized + 3 meta = 30 visible)
   *   "extended" — core + drafts / folders / actions
   *   "complete" — all tools (default, preserves current behavior)
   * Override per-launch with MAILPOUCH_TIER.
   */
  toolTier?: ToolTier;
  /**
   * Multi-account registry. When present, the active account's connection
   * fields are mirrored back into `connection` on save so the singleton
   * IMAP/SMTP services continue to read from the familiar location while
   * the UI manages the list. Shape matches src/accounts/types.ts
   * AccountSpec; validated on read.
   */
  accounts?: AccountSpecShape[];
  /** Which entry in `accounts` drives the singleton IMAP/SMTP services. */
  activeAccountId?: string;
  /** Fire native OS notifications on new pending grants (default true). */
  desktopNotificationsEnabled?: boolean;
  /**
   * Debug aid ("Surface security messages"). Default false. When false, the
   * informational/security desktop toasts — post-decision grant lifecycle
   * (approved/denied/revoked/expired) and per-action notifications for the
   * non-read-only tools mailpouch runs — are routed to the DEBUG log instead of
   * popping a toast. When true, they surface as desktop notifications for
   * debugging. The actionable "agent awaiting approval" prompt is NOT gated by
   * this — it always fires (subject to desktopNotificationsEnabled) so the human
   * approval gate keeps working.
   */
  surfaceSecurityNotifications?: boolean;
  /**
   * Auto-open the Settings UI Agents tab in the browser when a new remote agent
   * registers, so the user can approve/deny the connection immediately
   * (default true). Skipped on headless hosts (no display). Set false on a
   * remote/headless deployment to suppress the auto-popup.
   */
  autoOpenApprovalWindow?: boolean;
  /**
   * Show a NATIVE on-screen Approve/Deny dialog on the machine where mailpouch
   * runs when a new agent registers, so the operator can decide right there
   * instead of opening the Agents tab (default true). Falls back to the browser
   * approval window on headless hosts or where no dialog tool (zenity/osascript/
   * PowerShell) is available. Set false to use only the browser window.
   */
  nativeApprovalDialog?: boolean;
  /**
   * Require LOCAL (stdio) agents to register and be approved too, like remote
   * agents — every connecting client is gated behind the per-agent Approve/Deny
   * (default true). Set false (or `MAILPOUCH_TRUST_LOCAL=1`) to restore the
   * legacy behavior where the local stdio client is auto-trusted.
   */
  gateLocalAgents?: boolean;
  /** Outbound webhook endpoints that receive grant-change events. */
  webhooks?: WebhookEndpointShape[];
  /**
   * Require an explicit { confirmed: true } argument on destructive tool calls.
   * Default true. Intended to keep the workflow user-initiated (per Proton
   * ToS §2.10 on automated access) — the agent must surface each destructive
   * intent to the user before it executes, via a separate tool call.
   */
  requireDestructiveConfirm?: boolean;
  /**
   * Records the user's acknowledgement of the Proton ToS §2.10 automated-access
   * clause and the third-party-tool disclaimer. Unset means the user has not yet
   * been shown the first-run compliance banner.
   */
  tosAcknowledged?: { accepted: boolean; timestamp: string };
}

/** Tools that mutate or destroy Proton-side state and require { confirmed: true }. */
export const DESTRUCTIVE_TOOLS: ReadonlySet<string> = new Set<string>([
  "delete_email",
  "bulk_delete",
  "bulk_delete_emails",
  "empty_trash",
  "delete_folder",
  "move_to_trash",
  "move_to_spam",
  "alias_delete",
  "pass_get",
  "shutdown_server",
  "restart_server",
]);

/**
 * Tool-name aliases. PERM-003 (audit 2026-05-28): `bulk_delete` and
 * `bulk_delete_emails` resolve to the same handler in src/tools/deletion.ts,
 * but the permission gate keys rate buckets by raw tool name — letting an
 * agent double the destruction throughput the operator configured by
 * alternating between the two names. Canonicalize at every gate
 * (rate-limit bucket, destructive-confirm, per-tool enabled flag) so the
 * operator's intent applies regardless of which alias the caller used.
 *
 * Keys are aliases; values are the canonical name. Stays small — only add
 * an entry when two tool names truly share a handler.
 */
export const TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  bulk_delete: "bulk_delete_emails",
});

/** Resolve a tool name through TOOL_ALIASES; returns the canonical name. */
export function canonicalToolName(name: string): string {
  return TOOL_ALIASES[name] ?? name;
}

/**
 * Move-style tools that, when their target folder is destructive (Trash or
 * Spam), should be gated by the destructive-confirm flow the same way
 * `move_to_trash` / `move_to_spam` already are. PERM-004 (audit 2026-05-28):
 * without this, calling `move_email { targetFolder: "Trash" }` bypassed
 * destructive-confirm even though `move_to_trash` did not.
 */
export const MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET: ReadonlySet<string> = new Set<string>([
  "move_email",
  "bulk_move_emails",
  "move_to_folder",
]);

/** Destination folder names that count as destructive. Case-insensitive comparison. */
export const DESTRUCTIVE_DESTINATIONS: ReadonlySet<string> = new Set<string>([
  "trash",
  "spam",
]);

// ─── Tool Tiers ────────────────────────────────────────────────────────────────
//
// Every connected MCP server contributes its ListTools response to the client's
// system-prompt context. At 50+ tools this is measurable — multiple servers can
// burn tens of thousands of tokens before the user types anything.
//
// Tiering lets operators expose only the tools they actually use. Activate via
// the MAILPOUCH_TIER env var (core|extended|complete; default complete) or
// the `toolTier` field in the config file.

export type ToolTier = "core" | "extended" | "complete";

/**
 * Where each category surfaces first.
 *
 * Actual tool counts per tier (cumulative, including the 3 always-available
 * meta-tools: setup_status + request_permission_escalation + check_escalation_status):
 *   core     — 27 categorized (reading 14 + sending 4 + analytics 4 + system 5)            + 3 meta = 30 visible
 *   extended — 66 categorized (core 27 + drafts 9 + folders 5 + actions 16 + aliases 6 + pass 3) + 3 = 69 visible
 *   complete — 73 categorized (extended 66 + deletion 4 + bridge_control 3)                       + 3 = 76 visible
 */
export const TOOL_CATEGORY_TIER: Record<string, ToolTier> = {
  reading:        "core",     // reading is the 80 % use case
  sending:        "core",     // sending needs to be available in core too — common ask
  analytics:      "core",     // analytics is read-only and small
  system:         "core",     // connection status, cache, logs
  drafts:         "extended",
  folders:        "extended",
  actions:        "extended",
  aliases:        "extended", // SimpleLogin; optional (requires API key), moderate risk
  pass:           "extended", // Proton Pass; optional (requires PAT + pass-cli), moderate risk
  deletion:       "complete", // destructive + rarely needed by casual agents
  bridge_control: "complete", // server lifecycle
};

/**
 * Always-available meta-tools — they bypass the permission gate, sit outside
 * the category registry, and ignore the tiering system (visible at every tier):
 *   setup_status                  — read-only install/connect diagnostic (CALL FIRST)
 *   request_permission_escalation — ask a human for a higher preset
 *   check_escalation_status       — poll an escalation request
 * None can GRANT access; they only report or request.
 */
export const ALWAYS_AVAILABLE_TOOLS: ReadonlySet<string> = new Set<string>([
  "setup_status",
  "request_permission_escalation",
  "check_escalation_status",
]);

/** Resolve the set of tools that should be exposed by ListTools for a given tier. */
export function toolsForTier(tier: ToolTier): Set<string> {
  const tiersIncluded: ToolTier[] =
    tier === "core"     ? ["core"] :
    tier === "extended" ? ["core", "extended"] :
                          ["core", "extended", "complete"];
  const result = new Set<string>();
  for (const [cat, catTier] of Object.entries(TOOL_CATEGORY_TIER)) {
    if (tiersIncluded.includes(catTier)) {
      const def = TOOL_CATEGORIES[cat];
      if (def) for (const tool of def.tools) result.add(tool);
    }
  }
  // Always-available tools are added regardless of tier.
  for (const tool of ALWAYS_AVAILABLE_TOOLS) result.add(tool);
  return result;
}

/** Parse a value into a ToolTier, defaulting to "complete" on anything else. */
export function parseToolTier(value: unknown): ToolTier {
  if (value === "core" || value === "extended" || value === "complete") return value;
  return "complete";
}
