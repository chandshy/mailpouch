/**
 * Configuration schema for ProtonMail MCP Server
 * Covers connection settings and per-tool agentic access permissions.
 */

// ─── Tool Registry ─────────────────────────────────────────────────────────────

export const ALL_TOOLS = [
  // Sending
  "send_email", "reply_to_email", "forward_email", "send_test_email",
  // Reading
  "get_emails", "get_email_by_id", "search_emails", "get_unread_count",
  "list_labels", "get_emails_by_label",
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
  reading: {
    label: "Reading",
    description: "Fetch, search, and preview email content",
    tools: ["get_emails", "get_email_by_id", "search_emails", "get_unread_count", "list_labels", "get_emails_by_label"],
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

export type PermissionPreset = "full" | "read_only" | "supervised" | "send_only" | "custom";

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
  debug: boolean;
}

// ─── Top-Level Config ──────────────────────────────────────────────────────────

export const CONFIG_VERSION = 1;

export interface ServerConfig {
  configVersion: number;
  connection: ConnectionSettings;
  permissions: ServerPermissions;
}
