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
import { join, resolve, normalize } from "path";
import { randomBytes } from "crypto";
import {
  ALL_TOOLS,
  TOOL_CATEGORIES,
  CONFIG_VERSION,
  PERMISSION_PRESETS,
  DEFAULT_RESPONSE_LIMITS,
  type ServerConfig,
  type ToolPermission,
  type PermissionPreset,
  type ToolName,
  type ResponseLimits,
} from "./schema.js";
import {
  isKeychainAvailable,
  loadCredentials as loadKeychainCredentials,
  saveCredentials as saveKeychainCredentials,
  migrateFromConfig,
} from "../security/keychain.js";
import { tracer } from "../utils/tracer.js";

/** Clamp a numeric value to [min, max], falling back to min for non-finite input. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ─── Config path ───────────────────────────────────────────────────────────────

export function getConfigPath(): string {
  const envPath = process.env.PM_BRIDGE_MCP_CONFIG ?? process.env.PROTONMAIL_MCP_CONFIG;
  if (envPath) {
    // Resolve to absolute path and ensure it stays within the user's home
    // directory — prevents path-traversal attacks (e.g. "../../etc/passwd").
    const resolved = resolve(normalize(envPath));
    const home = homedir();
    if (!resolved.startsWith(home + "/") && !resolved.startsWith(home + "\\") && resolved !== home) {
      throw new Error(
        `PM_BRIDGE_MCP_CONFIG must point to a path within the home directory (${home}). Got: ${resolved}`
      );
    }
    return resolved;
  }
  // Prefer the new path, but fall back to the legacy ~/.protonmail-mcp.json
  // if it exists and the new one doesn't — keeps existing installs working.
  const preferred = join(homedir(), ".pm-bridge-mcp.json");
  const legacy = join(homedir(), ".protonmail-mcp.json");
  if (!existsSync(preferred) && existsSync(legacy)) return legacy;
  return preferred;
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
      "start_bridge",  // needed to bring Bridge up before reading
      // SimpleLogin read-only surface: list + activity logs only.
      "alias_list",
      "alias_get_activity",
    ]);
    for (const tool of ALL_TOOLS) {
      tools[tool].enabled = allowed.has(tool);
    }
  } else if (preset === "supervised") {
    // SimpleLogin write tools: cap creation + toggle + delete to keep a human
    // in the loop even when the preset is otherwise permissive.
    tools["alias_create_random"].rateLimit = 10;
    tools["alias_create_custom"].rateLimit = 10;
    tools["alias_toggle"].rateLimit = 20;
    tools["alias_delete"].rateLimit = 5;
    for (const tool of TOOL_CATEGORIES.deletion.tools) {
      tools[tool].rateLimit = 5;
    }
    for (const tool of TOOL_CATEGORIES.sending.tools) {
      tools[tool].rateLimit = 20;
    }
    for (const tool of TOOL_CATEGORIES.actions.tools) {
      if (tool.startsWith("bulk_")) tools[tool].rateLimit = 10;
    }
    // Rate limits for read-heavy tools to prevent excessive IMAP load
    tools["get_emails"].rateLimit = 60;
    tools["search_emails"].rateLimit = 30;
    tools["get_email_by_id"].rateLimit = 200;
    // Rate-limit server lifecycle tools — destructive but allowed in supervised
    tools["shutdown_server"].rateLimit = 2;
    tools["restart_server"].rateLimit = 2;
  } else if (preset === "send_only") {
    const allowed = new Set<string>([
      ...TOOL_CATEGORIES.sending.tools,
      ...TOOL_CATEGORIES.drafts.tools,
      ...TOOL_CATEGORIES.reading.tools,
      "get_folders",
      "get_connection_status",
      "get_logs",
      "start_bridge",  // needed to bring Bridge up before sending
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
      allowInsecureBridge: false,
      bridgePath: "",
      debug: false,
    },
    // Safe default: read-only. Users must explicitly grant write/send/delete
    // access via the settings UI (npm run settings).
    permissions: buildPermissions("read_only"),
    responseLimits: { ...DEFAULT_RESPONSE_LIMITS },
    requireDestructiveConfirm: true,
  };
}

// ─── Load / Save ───────────────────────────────────────────────────────────────

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function loadConfig(): ServerConfig | null {
  const tags: { found?: boolean } = {};
  return tracer.spanSync('config.load', tags, () => {
  const path = getConfigPath();
  if (!existsSync(path)) {
    tags.found = false;
    return null;
  }
  try {
    const raw = readFileSync(path, "utf-8");
    const parsed = JSON.parse(raw) as Partial<ServerConfig>;
    // Deep-merge on top of defaults so new tools added to ALL_TOOLS are always present
    const base = defaultConfig();
    // Validate the preset value from disk against the known-good set.
    // An arbitrary string (e.g. "superuser") must not survive into the live
    // permission state; fall back to the safe "read_only" default.
    const VALID_PRESETS = new Set<string>(PERMISSION_PRESETS as unknown as string[]);
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

    // Merge and clamp response limits — prevents invalid values from disk.
    // base = defaultConfig() which always populates responseLimits; non-null is safe here.
    const mergedLimits: ResponseLimits = {
      ...base.responseLimits!,
      ...(parsed.responseLimits ?? {}),
    };
    mergedLimits.maxResponseBytes    = clamp(mergedLimits.maxResponseBytes,    100_000, 1_048_576);
    mergedLimits.maxEmailBodyChars   = clamp(mergedLimits.maxEmailBodyChars,   1_000,   10_000_000);
    mergedLimits.maxEmailListResults = clamp(mergedLimits.maxEmailListResults, 1,       200);
    mergedLimits.maxAttachmentBytes  = clamp(mergedLimits.maxAttachmentBytes,  0,       1_048_576);

    const loadedVersion = parsed.configVersion ?? 1;
    const mergedConnection = { ...base.connection, ...(parsed.connection ?? {}) };

    // v1 → v2 grandfather: legacy configs ran with TLS validation silently
    // disabled when no Bridge cert was set. Preserve that behavior (so existing
    // installs keep working) but make the opt-in explicit on the next save, and
    // leave a breadcrumb the services surface as a startup warning.
    if (
      loadedVersion < 2 &&
      !mergedConnection.bridgeCertPath &&
      parsed.connection?.allowInsecureBridge === undefined
    ) {
      mergedConnection.allowInsecureBridge = true;
    }

    const result: ServerConfig = {
      configVersion: CONFIG_VERSION,
      connection: mergedConnection,
      permissions: {
        // Default to "read_only" — not "full" — for pre-permissions config files.
        // Silently upgrading old configs to full access would be a privilege-escalation risk.
        preset: safePreset,
        tools: { ...base.permissions.tools, ...filteredTools },
      },
      responseLimits: mergedLimits,
      // Destructive-tool confirmation defaults to TRUE; only an explicit false
      // opts out. This keeps the safe default for existing configs that never
      // set the field.
      requireDestructiveConfirm: parsed.requireDestructiveConfirm !== false,
      tosAcknowledged: parsed.tosAcknowledged,
    };
    tags.found = true;
    return result;
  } catch {
    tags.found = false;
    return null;
  }
  }); // end tracer.spanSync('config.load')
}

export function saveConfig(config: ServerConfig): void {
  tracer.spanSync('config.save', {}, () => {
  const dest    = getConfigPath();
  const payload = JSON.stringify(config, null, 2);
  // Atomic write: write to a temp file then rename into place.
  // rename(2) is atomic on POSIX only when both sides live on the same
  // filesystem. On Linux installs where /tmp is tmpfs and $HOME is on
  // separate storage, using os.tmpdir() produces EXDEV. Put the tmp next
  // to the destination so rename stays atomic regardless of mount layout.
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, dest);
  }); // end tracer.spanSync('config.save')
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
  const tags: { hasPassword?: boolean; hasSmtpToken?: boolean; storage?: string } = {};
  return tracer.span('config.loadKeychain', tags, async () => {
  // Try keychain first
  const keychainCreds = await loadKeychainCredentials();
  if (keychainCreds && (keychainCreds.password || keychainCreds.smtpToken)) {
    tags.hasPassword = !!keychainCreds.password;
    tags.hasSmtpToken = !!keychainCreds.smtpToken;
    tags.storage = "keychain";
    return { ...keychainCreds, storage: "keychain" as const };
  }

  // Fall back to config file
  const config = loadConfig();
  if (config && (config.connection.password || config.connection.smtpToken)) {
    tags.hasPassword = !!config.connection.password;
    tags.hasSmtpToken = !!config.connection.smtpToken;
    tags.storage = "config";
    return {
      password: config.connection.password,
      smtpToken: config.connection.smtpToken,
      storage: "config" as const,
    };
  }

  tags.hasPassword = false;
  tags.hasSmtpToken = false;
  return null;
  }); // end tracer.span('config.loadKeychain')
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
  const tags: { migrated?: boolean } = {};
  return tracer.span('config.migrateCredentials', tags, async () => {
  const config = loadConfig();
  if (!config) {
    tags.migrated = false;
    return false;
  }
  const migrated = await migrateFromConfig(config, saveConfig);
  tags.migrated = migrated;
  return migrated;
  }); // end tracer.span('config.migrateCredentials')
}
