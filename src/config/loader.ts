/**
 * Config file loader / saver for ProtonMail MCP Server.
 *
 * Config is persisted to a single JSON file (default: ~/.protonmail-mcp.json).
 * Override the path with the PROTONMAIL_MCP_CONFIG env var.
 *
 * On Unix systems the file is written with mode 0600 (owner-read/write only)
 * to reduce the risk of credential exposure.
 */

import { readFileSync, writeFileSync, existsSync, renameSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";
import { randomBytes } from "crypto";
import {
  ALL_TOOLS,
  TOOL_CATEGORIES,
  CONFIG_VERSION,
  type ServerConfig,
  type ToolPermission,
  type PermissionPreset,
  type ToolName,
} from "./schema.js";
import {
  isKeychainAvailable,
  loadCredentials as loadKeychainCredentials,
  saveCredentials as saveKeychainCredentials,
  migrateFromConfig,
} from "../security/keychain.js";

// ─── Config path ───────────────────────────────────────────────────────────────

export function getConfigPath(): string {
  return (
    process.env.PROTONMAIL_MCP_CONFIG ||
    join(homedir(), ".protonmail-mcp.json")
  );
}

// ─── Default values ────────────────────────────────────────────────────────────

const DEFAULT_TOOL_PERM: ToolPermission = { enabled: true, rateLimit: null };

/**
 * Build a full permissions object from a named preset.
 *
 * full       — all tools enabled, no limits
 * read_only  — only reading / analytics / system tools enabled
 * supervised — all enabled; deletion capped at 5/hr, sending at 20/hr
 * send_only  — reading + sending only; no deletion, no folder writes
 * custom     — same as full (caller modifies individual tools after)
 */
export function buildPermissions(preset: PermissionPreset): ServerConfig["permissions"] {
  const tools = {} as Record<ToolName, ToolPermission>;
  for (const tool of ALL_TOOLS) {
    tools[tool] = { ...DEFAULT_TOOL_PERM };
  }

  if (preset === "read_only") {
    const allowed = new Set<string>([
      ...TOOL_CATEGORIES.reading.tools,
      ...TOOL_CATEGORIES.analytics.tools,
      ...TOOL_CATEGORIES.system.tools,
      "get_folders",
    ]);
    for (const tool of ALL_TOOLS) {
      tools[tool].enabled = allowed.has(tool);
    }
  } else if (preset === "supervised") {
    for (const tool of TOOL_CATEGORIES.deletion.tools) {
      tools[tool].rateLimit = 5;
    }
    for (const tool of TOOL_CATEGORIES.sending.tools) {
      tools[tool].rateLimit = 20;
    }
    for (const tool of TOOL_CATEGORIES.actions.tools) {
      if (tool.startsWith("bulk_")) tools[tool].rateLimit = 10;
    }
  } else if (preset === "send_only") {
    const allowed = new Set<string>([
      ...TOOL_CATEGORIES.sending.tools,
      ...TOOL_CATEGORIES.reading.tools,
      "get_folders",
      "get_connection_status",
      "get_logs",
    ]);
    for (const tool of ALL_TOOLS) {
      tools[tool].enabled = allowed.has(tool);
    }
  }
  // "full" and "custom" use the default (all enabled, no limits)

  return { preset, tools };
}

export function defaultConfig(): ServerConfig {
  return {
    configVersion: CONFIG_VERSION,
    connection: {
      smtpHost: "localhost",
      smtpPort: 1025,
      imapHost: "localhost",
      imapPort: 1143,
      username: "",
      password: "",
      smtpToken: "",
      bridgeCertPath: "",
      debug: false,
    },
    // Safe default: read-only. Users must explicitly grant write/send/delete
    // access via the settings UI (npm run settings).
    permissions: buildPermissions("read_only"),
  };
}

// ─── Load / Save ───────────────────────────────────────────────────────────────

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function loadConfig(): ServerConfig | null {
  const path = getConfigPath();
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    // Deep-merge on top of defaults so new tools added to ALL_TOOLS are always present
    const base = defaultConfig();
    // Validate the preset value from disk against the known-good set.
    // An arbitrary string (e.g. "superuser") must not survive into the live
    // permission state; fall back to the safe "read_only" default.
    const VALID_PRESETS = new Set<string>(["read_only", "send_only", "supervised", "custom", "full"]);
    const rawPreset = parsed.permissions?.preset;
    const safePreset: PermissionPreset = VALID_PRESETS.has(rawPreset as string)
      ? (rawPreset as PermissionPreset)
      : "read_only";

    // Filter the tool map loaded from disk so that only canonical tool names
    // are merged.  An attacker who can write the config file must not be able
    // to inject arbitrary keys that confuse the permission-check logic or
    // accumulate unknown entries through repeated saves.
    const knownTools = new Set<string>(ALL_TOOLS as readonly string[]);
    const rawTools = parsed.permissions?.tools ?? {};
    const filteredTools: Partial<Record<ToolName, ToolPermission>> = {};
    for (const [k, v] of Object.entries(rawTools)) {
      if (knownTools.has(k)) {
        filteredTools[k as ToolName] = v as ToolPermission;
      }
    }

    return {
      configVersion: parsed.configVersion ?? base.configVersion,
      connection: { ...base.connection, ...(parsed.connection ?? {}) },
      permissions: {
        // Default to "read_only" — not "full" — for pre-permissions config files.
        // Silently upgrading old configs to full access would be a privilege-escalation risk.
        preset: safePreset,
        tools: { ...base.permissions.tools, ...filteredTools },
      },
    };
  } catch {
    return null;
  }
}

export function saveConfig(config: ServerConfig): void {
  const dest    = getConfigPath();
  const payload = JSON.stringify(config, null, 2);
  // Atomic write: write to a temp file then rename into place.
  // rename(2) is atomic on POSIX; on Windows it is also effectively atomic
  // for same-volume operations.  This prevents a corrupted config file if
  // the process is killed between open() and write() — the same technique
  // used in escalation.ts for the pending-escalation file.
  const tmp = join(tmpdir(), `protonmcp-cfg-${randomBytes(8).toString("hex")}.json.tmp`);
  writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, dest);
}

// ─── Keychain-aware credential helpers ──────────────────────────────────────

/**
 * Load credentials with keychain priority: keychain > config file.
 * Returns the credentials and the storage method used.
 */
export async function loadCredentialsFromKeychain(): Promise<{
  password: string;
  smtpToken: string;
  storage: "keychain" | "config";
} | null> {
  // Try keychain first
  const keychainCreds = await loadKeychainCredentials();
  if (keychainCreds && (keychainCreds.password || keychainCreds.smtpToken)) {
    return { ...keychainCreds, storage: "keychain" };
  }

  // Fall back to config file
  const config = loadConfig();
  if (config && (config.connection.password || config.connection.smtpToken)) {
    return {
      password: config.connection.password,
      smtpToken: config.connection.smtpToken,
      storage: "config",
    };
  }

  return null;
}

/**
 * Save config with credentials routed to keychain when available.
 * If keychain is available, credentials are stored there and blanked in the JSON file.
 * If keychain is unavailable, credentials are stored in the JSON file as fallback.
 */
export async function saveConfigWithCredentials(config: ServerConfig): Promise<"keychain" | "config"> {
  const password = config.connection.password;
  const smtpToken = config.connection.smtpToken;

  const keychainOk = await saveKeychainCredentials(password, smtpToken);
  if (keychainOk) {
    // Blank credentials in config file — they're now in keychain
    config.connection.password = "";
    config.connection.smtpToken = "";
    config.credentialStorage = "keychain";
    saveConfig(config);
    return "keychain";
  }

  // Fallback: store in config file
  config.credentialStorage = "config";
  saveConfig(config);
  return "config";
}

/**
 * One-time migration: move plaintext credentials from config file to keychain.
 * Idempotent — safe to call on every startup.
 */
export async function migrateCredentials(): Promise<boolean> {
  const config = loadConfig();
  if (!config) return false;
  return migrateFromConfig(config, saveConfig);
}
