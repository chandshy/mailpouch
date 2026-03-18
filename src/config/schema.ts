/**
 * Configuration schema for ProtonMail MCP Server
 * Covers connection settings and per-tool agentic access permissions.
 */

// ─── Tool Registry ─────────────────────────────────────────────────────────────

export const ALL_TOOLS = [
  // Sending
  "send_email", "reply_to_email", "forward_email", "send_test_email",
  // Drafts & scheduling
  "save_draft", "schedule_email", "list_scheduled_emails", "cancel_scheduled_email", "list_proton_scheduled",
  // Reading
  "get_emails", "get_email_by_id", "search_emails", "get_unread_count",
  "list_labels", "get_emails_by_label", "download_attachment",
  // Folder management
  "get_folders", "sync_folders", "create_folder", "delete_folder", "rename_folder",
  // Email actions
  "mark_email_read", "star_email", "move_email", "archive_email",
  "move_to_trash", "move_to_spam", "move_to_folder",
  "bulk_mark_read", "bulk_star", "bulk_move_emails",
  "move_to_label", "bulk_move_to_label",
  "remove_label", "bulk_remove_label",
  // Deletion
  "delete_email", "bulk_delete_emails", "bulk_delete",
  // Analytics
  "get_email_stats", "get_email_analytics", "get_contacts", "get_volume_trends",
  // System
  "get_connection_status", "sync_emails", "clear_cache", "get_logs",
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
    tools: ["save_draft", "schedule_email", "list_scheduled_emails", "cancel_scheduled_email", "list_proton_scheduled"],
    risk: "moderate",
  },
  reading: {
    label: "Reading",
    description: "Fetch, search, preview email content, and download attachments",
    tools: ["get_emails", "get_email_by_id", "search_emails", "get_unread_count", "list_labels", "get_emails_by_label", "download_attachment"],
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
      "mark_email_read", "star_email", "move_email", "archive_email",
      "move_to_trash", "move_to_spam", "move_to_folder",
      "bulk_mark_read", "bulk_star", "bulk_move_emails",
      "move_to_label", "bulk_move_to_label",
      "remove_label", "bulk_remove_label",
    ],
    risk: "moderate",
  },
  deletion: {
    label: "Deletion",
    description: "Permanently delete emails — irreversible",
    tools: ["delete_email", "bulk_delete_emails", "bulk_delete"],
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
    description: "Connection status, cache control, and server logs",
    tools: ["get_connection_status", "sync_emails", "clear_cache", "get_logs"],
    risk: "safe",
  },
};

// ─── Permission Types ──────────────────────────────────────────────────────────

export interface ToolPermission {
  /** Whether the tool can be called at all */
  enabled: boolean;
  /** Max calls per hour. null = unlimited. */
  rateLimit: number | null;
}

export const PERMISSION_PRESETS = ["full", "read_only", "supervised", "send_only", "custom"] as const;
export type PermissionPreset = typeof PERMISSION_PRESETS[number];

export interface ServerPermissions {
  preset: PermissionPreset;
  tools: Record<ToolName, ToolPermission>;
}

// ─── Connection Settings ───────────────────────────────────────────────────────

export interface ConnectionSettings {
  smtpHost: string;
  smtpPort: number;
  imapHost: string;
  imapPort: number;
  username: string;
  /** Stored encrypted at rest is ideal; at minimum this file should be mode 0600 */
  password: string;
  /** Optional SMTP token for direct smtp.protonmail.ch submission (paid plans) */
  smtpToken: string;
  /** Path to exported Proton Bridge TLS certificate */
  bridgeCertPath: string;
  /**
   * TLS mode for SMTP/IMAP connections.
   * 'starttls' (default) — use STARTTLS upgrade; correct for Proton Bridge.
   * 'ssl'               — implicit TLS (ports 465/993); only for non-Bridge setups.
   */
  tlsMode?: 'starttls' | 'ssl';
  /** Automatically launch Proton Bridge if it is not reachable on MCP server start. */
  autoStartBridge?: boolean;
  debug: boolean;
}

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

export const CONFIG_VERSION = 1;

export interface ServerConfig {
  configVersion: number;
  connection: ConnectionSettings;
  permissions: ServerPermissions;
  /** Where credentials are stored: "keychain" (OS keychain) or "config" (JSON file). */
  credentialStorage?: "keychain" | "config";
  /** Tuneable response-size guards — see ResponseLimits. */
  responseLimits?: ResponseLimits;
  /** Port the settings UI server listens on (default 8765). */
  settingsPort?: number;
}
