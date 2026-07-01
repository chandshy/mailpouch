/**
 * Config file loader / saver for mailpouch.
 *
 * Config is persisted to a single JSON file (default: ~/.mailpouch.json).
 * Override the path with the MAILPOUCH_CONFIG env var.
 *
 * On Unix systems the file is written with mode 0600 (owner-read/write only)
 * to reduce the risk of credential exposure.
 */

import { readFileSync, writeFileSync, existsSync, renameSync, statSync, openSync, closeSync, unlinkSync, chmodSync } from "fs";
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
  loadAuxiliaryCredentials as loadKeychainAuxCredentials,
  saveAuxiliaryCredentials as saveKeychainAuxCredentials,
  migrateFromConfig,
} from "../security/keychain.js";
import { CredentialEncryption } from "../crypto/credential-encryption.js";
import { tracer } from "../utils/tracer.js";
import { logger } from "../utils/logger.js";

/**
 * PERM-015: explicit set of bulk (mass-acting) action tools that get the
 * supervised "high cap" rate limit. Prefix-matching on `bulk_` silently missed
 * any future mass tool with a different prefix (e.g. `mark_all_read`); an
 * explicit list forces a deliberate addition when such a tool ships.
 */
const SUPERVISED_BULK_ACTION_TOOLS: readonly string[] = [
  "bulk_mark_read",
  "bulk_star",
  "bulk_move_emails",
  "bulk_move_to_label",
  "bulk_remove_label",
];

/** Clamp a numeric value to [min, max], falling back to min for non-finite input. */
function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.round(value)));
}

// ─── Config path ───────────────────────────────────────────────────────────────

export function getConfigPath(): string {
  const envPath = process.env.MAILPOUCH_CONFIG;
  if (envPath) {
    // Resolve to absolute path and ensure it stays within the user's home
    // directory — prevents path-traversal attacks (e.g. "../../etc/passwd").
    const resolved = resolve(normalize(envPath));
    const home = homedir();
    if (!resolved.startsWith(home + "/") && !resolved.startsWith(home + "\\") && resolved !== home) {
      throw new Error(
        `MAILPOUCH_CONFIG must point to a path within the home directory (${home}). Got: ${resolved}`
      );
    }
    return resolved;
  }
  return join(homedir(), ".mailpouch.json");
}

// ─── Default values ────────────────────────────────────────────────────────────

const DEFAULT_TOOL_PERM: ToolPermission = { enabled: true, rateLimit: null };

/**
 * Build a full permissions object from a named preset.
 *
 * full       — all tools enabled, no limits
 * read_only  — reading/analytics/system enabled; all writes blocked
 * supervised — all tools enabled; reading unlimited; sending ≤200/hr,
 *              schedule ≤100/hr, bulk actions ≤100/hr, deletion ≤20/hr,
 *              folder delete ≤20/hr, server lifecycle ≤5/hr
 * send_only  — reading unlimited; send/forward/schedule ≤50/hr;
 *              actions, deletion, folder writes, and bulk ops disabled
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
      // SimpleLogin read-only surface: lists + activity logs + options.
      "alias_list",
      "alias_get_activity",
      "alias_list_contacts",
      "alias_list_mailboxes",
      "alias_list_domains",
      "alias_options",
    ]);
    for (const tool of ALL_TOOLS) {
      tools[tool].enabled = allowed.has(tool);
    }
  } else if (preset === "supervised") {
    // Reading tools are safe — no rate limits.
    // Sending: high cap.
    for (const tool of TOOL_CATEGORIES.sending.tools) {
      tools[tool].rateLimit = 200;
    }
    tools["schedule_email"].rateLimit = 100;
    tools["remind_if_no_reply"].rateLimit = 200;
    // Bulk non-delete actions: high cap. PERM-015: match an explicit allowlist
    // rather than the `bulk_` prefix so a future non-`bulk_` mass tool can't
    // slip through unthrottled.
    for (const tool of SUPERVISED_BULK_ACTION_TOOLS) {
      if (tool in tools) tools[tool as ToolName].rateLimit = 100;
    }
    // Deletion: lower cap — irreversible.
    for (const tool of TOOL_CATEGORIES.deletion.tools) {
      tools[tool].rateLimit = 20;
    }
    // Folder writes: create/rename high, delete lower.
    tools["create_folder"].rateLimit = 100;
    tools["rename_folder"].rateLimit = 100;
    tools["delete_folder"].rateLimit = 20;
    // SimpleLogin: create/toggle high, delete lower.
    tools["alias_create_random"].rateLimit = 50;
    tools["alias_create_custom"].rateLimit = 50;
    tools["alias_toggle"].rateLimit = 100;
    tools["alias_update"].rateLimit = 100;
    tools["alias_delete"].rateLimit = 20;
    tools["alias_create_contact"].rateLimit = 50;
    tools["alias_toggle_contact"].rateLimit = 100;
    tools["alias_delete_contact"].rateLimit = 20;
    tools["alias_create_mailbox"].rateLimit = 20;
    tools["alias_delete_mailbox"].rateLimit = 20;
    // Server lifecycle: allow a few per session.
    tools["shutdown_server"].rateLimit = 5;
    tools["restart_server"].rateLimit = 5;
  } else if (preset === "send_only") {
    const allowed = new Set<string>([
      ...TOOL_CATEGORIES.sending.tools,
      ...TOOL_CATEGORIES.drafts.tools,
      ...TOOL_CATEGORIES.reading.tools,
      "get_folders",
      "get_connection_status",
      "sync_emails",    // safe — reads from server, no email modified
      "get_contacts",   // look up recipients when composing
      "get_logs",
      "start_bridge",
    ]);
    for (const tool of ALL_TOOLS) {
      tools[tool].enabled = allowed.has(tool);
    }
    // Outbound ops: rate-limited. Reads, sync, and draft management: unlimited.
    for (const tool of TOOL_CATEGORIES.sending.tools) {
      tools[tool].rateLimit = 50;
    }
    tools["schedule_email"].rateLimit = 50;
    tools["remind_if_no_reply"].rateLimit = 100;
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

const CONFIG_CACHE_TTL_MS = 15_000;
let _configCache: { config: ServerConfig | null; loadedAt: number; mtimeMs: number } | null = null;

/** Invalidate the in-process config cache (called after saveConfig). */
export function invalidateConfigCache(): void {
  _configCache = null;
}

export function configExists(): boolean {
  return existsSync(getConfigPath());
}

export function loadConfig(): ServerConfig | null {
  const path = getConfigPath();

  // Serve from cache when it is fresh and the file hasn't been modified on disk.
  if (_configCache !== null) {
    const age = Date.now() - _configCache.loadedAt;
    if (age < CONFIG_CACHE_TTL_MS) {
      try {
        const mtimeMs = statSync(path).mtimeMs;
        if (mtimeMs === _configCache.mtimeMs) return _configCache.config;
        // mtime changed — fall through to reload
      } catch {
        // statSync failed (file deleted, permission error, or test mock).
        // Invalidate and reload rather than returning a potentially stale null.
        _configCache = null;
      }
    }
  }

  const tags: { found?: boolean } = {};
  const config = tracer.spanSync('config.load', tags, () => {
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

    // Preserve settingsPort when it's a sane port number — without this, the
    // field round-trips to disk via saveConfig but is stripped on the way
    // back out, so GET /api/config returns no settingsPort → the UI defaults
    // the field to 8766 → the port-mismatch warning banner fires on every
    // reload even though the user already saved the correct value.
    //
    // Validation mirrors the POST /api/config merge path
    // (settings/server.ts): Math.round + range check [1, 65535]. Keeping
    // the two paths symmetric means a hand-edited `8766.5` on disk is
    // accepted with the same semantics a browser-sent 8766.5 would be,
    // rather than being silently dropped here and accepted on the next save.
    const parsedSettingsPort = parsed.settingsPort;
    let preservedSettingsPort: number | undefined = undefined;
    if (typeof parsedSettingsPort === "number" && Number.isFinite(parsedSettingsPort)) {
      const sp = Math.round(parsedSettingsPort);
      if (sp >= 1 && sp <= 65535) preservedSettingsPort = sp;
    }
    // credentialStorage drives the settings UI's "where are my secrets
    // kept?" badge. Derive it from observed state rather than trusting the
    // persisted value — an attacker editing the config file could otherwise
    // set credentialStorage="keychain" while leaving plaintext passwords in
    // the file, hiding the fact that credentials live in cleartext.
    let preservedCredentialStorage: "keychain" | "encrypted-file" | "config" | undefined;
    const hasEncryptedBlob =
      CredentialEncryption.isValidEncrypted(mergedConnection.passwordEncrypted) ||
      CredentialEncryption.isValidEncrypted(mergedConnection.smtpTokenEncrypted);
    const hasPlaintext =
      !!mergedConnection.password || !!mergedConnection.smtpToken;
    if (hasEncryptedBlob) {
      preservedCredentialStorage = "encrypted-file";
    } else if (hasPlaintext) {
      preservedCredentialStorage = "config";
    } else if (
      parsed.credentialStorage === "keychain" ||
      parsed.credentialStorage === "encrypted-file" ||
      parsed.credentialStorage === "config"
    ) {
      // No on-disk credentials at all → trust the saved hint (we expect this
      // to be "keychain" for any installation that's gone through migration).
      preservedCredentialStorage = parsed.credentialStorage;
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
      settingsPort: preservedSettingsPort,
      credentialStorage: preservedCredentialStorage,
      accounts: Array.isArray(parsed.accounts) ? parsed.accounts : undefined,
      activeAccountId: typeof parsed.activeAccountId === "string" ? parsed.activeAccountId : undefined,
      desktopNotificationsEnabled: typeof parsed.desktopNotificationsEnabled === "boolean"
        ? parsed.desktopNotificationsEnabled
        : undefined,
      autoOpenApprovalWindow: typeof parsed.autoOpenApprovalWindow === "boolean"
        ? parsed.autoOpenApprovalWindow
        : undefined,
      nativeApprovalDialog: typeof parsed.nativeApprovalDialog === "boolean"
        ? parsed.nativeApprovalDialog
        : undefined,
      gateLocalAgents: typeof parsed.gateLocalAgents === "boolean"
        ? parsed.gateLocalAgents
        : undefined,
      webhooks: Array.isArray(parsed.webhooks) ? parsed.webhooks : undefined,
    };
    tags.found = true;
    return result;
  } catch {
    tags.found = false;
    return null;
  }
  }); // end tracer.spanSync('config.load')

  // Populate cache with the mtime at the point we read the file.
  let mtimeMs = 0;
  try { mtimeMs = statSync(path).mtimeMs; } catch { /* file gone */ }
  _configCache = { config, loadedAt: Date.now(), mtimeMs };
  return config;
}

// ─── Config file lock (CRED-008) ─────────────────────────────────────────────
//
// Read-modify-write callers (saveConfig, and writeRegistry's load→merge→save)
// race with each other and with the settings-UI POST handler. Without a lock,
// two near-simultaneous renames clobber one another (last-writer-wins) and a
// reader caught between them can observe a half-merged file. We serialize via
// an exclusive O_EXCL lock file next to the config — no new dependency.

/** Max attempts to acquire the lock before giving up. */
const LOCK_MAX_RETRIES = 50;
/** Delay between lock acquisition attempts (busy-wait; writes are sub-ms). */
const LOCK_RETRY_DELAY_MS = 20;
/** A lock file older than this is treated as abandoned by a crashed holder. */
const LOCK_STALE_MS = 10_000;

/**
 * Reentrancy depth. writeRegistry holds the lock across its whole
 * read-modify-write and calls saveConfig() inside it; the inner saveConfig
 * must reuse the held lock rather than deadlock on its own O_EXCL.
 */
let _lockDepth = 0;

/**
 * In-process async serialization. The on-disk O_EXCL lock guards against OTHER
 * processes (settings UI, a second MCP), but two concurrent async writers in
 * THIS process cannot busy-wait on it — a synchronous spin would block the
 * event loop and deadlock the holder mid-await. This promise chain queues
 * same-process async writers so they run one at a time.
 */
let _asyncLockChain: Promise<void> = Promise.resolve();

function blockMs(ms: number): void {
  // Synchronous sleep for the sync acquire path (saveConfig). Node lacks a sync
  // sleep; Atomics.wait on a throwaway buffer is the standard no-dep idiom.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Run `fn` while holding an exclusive lock on `${dest}.lock`. Reentrant for the
 * same process (depth-counted). Reclaims a stale lock left by a crashed holder.
 * The lock is always released in the outermost frame via try/finally.
 */
function withConfigLock<T>(dest: string, fn: () => T): T {
  if (_lockDepth > 0) {
    // Already held by an outer frame in this process — reuse it.
    _lockDepth++;
    try { return fn(); }
    finally { _lockDepth--; }
  }

  const lockPath = `${dest}.lock`;
  let fd: number | null = null;
  for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
    try {
      fd = openSync(lockPath, "wx", 0o600); // O_CREAT | O_EXCL
      break;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Lock held by someone else — reclaim it if it's stale (crashed holder),
      // otherwise back off and retry.
      try {
        const age = Date.now() - statSync(lockPath).mtimeMs;
        if (age > LOCK_STALE_MS) {
          unlinkSync(lockPath);
          continue; // retry immediately after clearing the stale lock
        }
      } catch { /* lock vanished between open and stat — just retry */ }
      blockMs(LOCK_RETRY_DELAY_MS);
    }
  }
  if (fd === null) {
    throw new Error(`Could not acquire config lock at ${lockPath} after ${LOCK_MAX_RETRIES} attempts`);
  }

  _lockDepth++;
  try {
    return fn();
  } finally {
    _lockDepth--;
    try { closeSync(fd); } catch { /* already closed */ }
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

/**
 * Force the config file back to owner-only (0o600) if its mode drifted wider.
 * `writeFileSync({mode})` only applies at creation and is masked by umask, so
 * the destination can be group/world-readable. Best-effort — a chmod failure
 * must not break a config save. CRED-007.
 */
function reassertOwnerOnly(path: string): void {
  try {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) chmodSync(path, 0o600);
  } catch { /* file vanished or chmod unsupported — best effort */ }
}

export function saveConfig(config: ServerConfig): void {
  tracer.spanSync('config.save', {}, () => {
  const dest    = getConfigPath();
  withConfigLock(dest, () => {
  const payload = JSON.stringify(config, null, 2);
  // Atomic write: write to a temp file then rename into place.
  // rename(2) is atomic on POSIX only when both sides live on the same
  // filesystem. On Linux installs where /tmp is tmpfs and $HOME is on
  // separate storage, using os.tmpdir() produces EXDEV. Put the tmp next
  // to the destination so rename stays atomic regardless of mount layout.
  const tmp = `${dest}.${randomBytes(8).toString("hex")}.tmp`;
  writeFileSync(tmp, payload, { encoding: "utf-8", mode: 0o600 });
  renameSync(tmp, dest);
  // CRED-007: the `mode` arg above is masked by umask at creation, so the
  // file the config lands in may be wider than 0o600. Re-assert owner-only
  // on the destination — the config file carries plaintext credentials in
  // the legacy/encrypted-file storage modes.
  reassertOwnerOnly(dest);
  invalidateConfigCache();
  });
  }); // end tracer.spanSync('config.save')
}

/**
 * Run a read-modify-write of the config file under the exclusive lock so the
 * read (loadConfig) and the write (saveConfig) cannot interleave with a racing
 * writer. saveConfig() reuses the held lock reentrantly. CRED-008.
 */
export function withConfigWriteLock<T>(fn: () => T): T {
  return withConfigLock(getConfigPath(), fn);
}

/**
 * Async variant of withConfigWriteLock for callers whose read-modify-write
 * spans an await (e.g. writeRegistry, which routes secrets through the
 * keychain between load and save). The lock is held for the full duration and
 * released only after the promise settles. CRED-008.
 */
export async function withConfigWriteLockAsync<T>(fn: () => Promise<T>): Promise<T> {
  // Reentrant: an async writer already holding the lock (e.g. a future nested
  // call) reuses it rather than enqueuing behind itself.
  if (_lockDepth > 0) {
    _lockDepth++;
    try { return await fn(); }
    finally { _lockDepth--; }
  }

  // Queue behind any in-flight same-process async writer. Chain on settle (not
  // resolve) so one writer's failure doesn't wedge the queue.
  const prior = _asyncLockChain;
  let release!: () => void;
  _asyncLockChain = new Promise<void>(r => { release = r; });
  await prior.catch(() => {});

  const dest = getConfigPath();
  const lockPath = `${dest}.lock`;
  let fd: number | null = null;
  try {
    for (let attempt = 0; attempt < LOCK_MAX_RETRIES; attempt++) {
      try {
        fd = openSync(lockPath, "wx", 0o600); // O_CREAT | O_EXCL
        break;
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
        try {
          const age = Date.now() - statSync(lockPath).mtimeMs;
          if (age > LOCK_STALE_MS) { unlinkSync(lockPath); continue; }
        } catch { /* lock vanished — retry */ }
        await sleepMs(LOCK_RETRY_DELAY_MS); // async sleep — never blocks the loop
      }
    }
    if (fd === null) {
      throw new Error(`Could not acquire config lock at ${lockPath} after ${LOCK_MAX_RETRIES} attempts`);
    }

    _lockDepth++;
    try {
      return await fn();
    } finally {
      _lockDepth--;
      try { closeSync(fd); } catch { /* already closed */ }
      try { unlinkSync(lockPath); } catch { /* already removed */ }
    }
  } finally {
    release();
  }
}

// ─── Keychain-aware credential helpers ──────────────────────────────────────

/**
 * Load credentials with priority: keychain > encrypted-file > plaintext config.
 * Returns the credentials and the storage method used.
 */
export async function loadCredentialsFromKeychain(): Promise<{
  password: string;
  smtpToken: string;
  storage: "keychain" | "encrypted-file" | "config" | "decrypt-failed";
} | null> {
  const tags: { hasPassword?: boolean; hasSmtpToken?: boolean; storage?: string } = {};
  return tracer.span('config.loadKeychain', tags, async () => {
  // 1. Try keychain first
  const keychainCreds = await loadKeychainCredentials();
  if (keychainCreds && (keychainCreds.password || keychainCreds.smtpToken)) {
    tags.hasPassword = !!keychainCreds.password;
    tags.hasSmtpToken = !!keychainCreds.smtpToken;
    tags.storage = "keychain";
    return { ...keychainCreds, storage: "keychain" as const };
  }

  const config = loadConfig();

  // 2. Try encrypted-file storage
  if (config) {
    const hasEncryptedPassword = CredentialEncryption.isValidEncrypted(config.connection.passwordEncrypted);
    const hasEncryptedToken    = CredentialEncryption.isValidEncrypted(config.connection.smtpTokenEncrypted);
    if (hasEncryptedPassword || hasEncryptedToken) {
      let password = "";
      let smtpToken = "";
      // CRED-010: track GCM auth failures. A well-formed encrypted blob whose
      // decrypt() throws is an authenticated-decryption failure — the IV/tag/
      // ciphertext don't agree with the key (machine-id changed, downgrade, or
      // tampering). We must NOT silently fall through to a plaintext field in
      // the SAME file: plaintext coexisting with a failed-auth encrypted blob
      // is itself a tamper indicator, and serving it would hand the caller an
      // attacker-controllable value from a blob that just failed integrity.
      let decryptFailed = false;
      if (hasEncryptedPassword) {
        try {
          // isValidEncrypted confirmed algorithm === "aes-256-gcm"; cast is safe.
          password = CredentialEncryption.decrypt(config.connection.passwordEncrypted as Parameters<typeof CredentialEncryption.decrypt>[0]);
        } catch (err) {
          decryptFailed = true;
          logger.error(
            "Encrypted bridge password failed authenticated decryption — refusing to fall back to plaintext from the same config file (possible machine-id change, version downgrade, or tampering). Re-enter the credential to re-encrypt.",
            "Credentials",
            err,
          );
        }
      }
      if (hasEncryptedToken) {
        try {
          smtpToken = CredentialEncryption.decrypt(config.connection.smtpTokenEncrypted as Parameters<typeof CredentialEncryption.decrypt>[0]);
        } catch (err) {
          decryptFailed = true;
          logger.error(
            "Encrypted SMTP token failed authenticated decryption — refusing to fall back to plaintext from the same config file (possible machine-id change, version downgrade, or tampering). Re-enter the credential to re-encrypt.",
            "Credentials",
            err,
          );
        }
      }
      if (password || smtpToken) {
        tags.hasPassword = !!password;
        tags.hasSmtpToken = !!smtpToken;
        tags.storage = "encrypted-file";
        return { password, smtpToken, storage: "encrypted-file" as const };
      }
      // Fail closed: a valid-shaped encrypted blob that failed to decrypt must
      // not degrade to plaintext from this same file. Return a DISTINCT
      // "decrypt-failed" sentinel (not null, which callers can't tell apart from
      // "no credentials" and would answer by reading the plaintext field
      // themselves) so the caller can refuse the plaintext fallback explicitly.
      if (decryptFailed) {
        tags.hasPassword = false;
        tags.hasSmtpToken = false;
        tags.storage = "decrypt-failed";
        return { password: "", smtpToken: "", storage: "decrypt-failed" as const };
      }
    }
  }

  // 3. Fall back to plaintext config (legacy / migration path)
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
 * Save config with credentials routed to the most secure available store.
 * Priority: keychain > encrypted-file (AES-256-GCM) > plaintext config (legacy).
 * Mutates `config` — blanks plaintext fields when storing elsewhere.
 */
export async function saveConfigWithCredentials(config: ServerConfig): Promise<"keychain" | "encrypted-file" | "config"> {
  const password  = config.connection.password;
  const smtpToken = config.connection.smtpToken;
  const passPat = config.connection.passAccessToken;
  const simpleloginKey = config.connection.simpleloginApiKey;

  // 1. Try keychain
  const keychainOk = await saveKeychainCredentials(password, smtpToken);
  if (keychainOk) {
    config.connection.password  = "";
    config.connection.smtpToken = "";
    delete config.connection.passwordEncrypted;
    delete config.connection.smtpTokenEncrypted;
    // CRED-001: route Pass PAT + SimpleLogin API key to keychain too.
    // Best-effort: if the aux save fails, leave the fields on disk — the
    // settings save reporting "keychain" stays honest for the bridge creds.
    if (passPat || simpleloginKey) {
      const auxOk = await saveKeychainAuxCredentials(passPat ?? "", simpleloginKey ?? "");
      if (auxOk) {
        config.connection.passAccessToken = "";
        config.connection.simpleloginApiKey = "";
      }
    }
    config.credentialStorage = "keychain";
    saveConfig(config);
    return "keychain";
  }

  // 2. Encrypt and store in config file (keychain unavailable)
  if (password) {
    config.connection.passwordEncrypted  = CredentialEncryption.encrypt(password);
    config.connection.password = "";
  }
  if (smtpToken) {
    config.connection.smtpTokenEncrypted = CredentialEncryption.encrypt(smtpToken);
    config.connection.smtpToken = "";
  }
  config.credentialStorage = "encrypted-file";
  saveConfig(config);
  return "encrypted-file";
}

/**
 * Load passAccessToken + simpleloginApiKey from the keychain, falling back
 * to the config-file plaintext if the keychain has neither. Used at startup
 * to rehydrate the in-process clients after migrateCredentials() has blanked
 * the disk fields. Returns null if neither secret is configured anywhere.
 */
export async function loadAuxiliaryCredentialsFromKeychain(): Promise<{
  passAccessToken: string;
  simpleloginApiKey: string;
  storage: "keychain" | "config";
} | null> {
  const fromKeychain = await loadKeychainAuxCredentials();
  if (fromKeychain) {
    return { ...fromKeychain, storage: "keychain" as const };
  }
  const config = loadConfig();
  if (config && (config.connection.passAccessToken || config.connection.simpleloginApiKey)) {
    return {
      passAccessToken: config.connection.passAccessToken ?? "",
      simpleloginApiKey: config.connection.simpleloginApiKey ?? "",
      storage: "config" as const,
    };
  }
  return null;
}

/**
 * One-time migration: move plaintext credentials to the best available store.
 * Priority: keychain > encrypted-file. Idempotent — safe to call on every startup.
 */
export async function migrateCredentials(): Promise<boolean> {
  const tags: { migrated?: boolean } = {};
  return tracer.span('config.migrateCredentials', tags, async () => {
  // CRED-015: take the config write lock for the whole read-modify-write so a
  // concurrent loadCredentialsFromKeychain() can't observe the in-flight,
  // partially-blanked config object (loadConfig returns the cached reference).
  return withConfigWriteLockAsync(async () => {
  const loaded = loadConfig();
  if (!loaded) {
    tags.migrated = false;
    return false;
  }
  // Operate on a deep clone, then save once. The cache keeps the un-mutated
  // reference until saveConfig() invalidates it, so racing readers within the
  // lock window never see `password=""` + a missing encrypted blob.
  const config = structuredClone(loaded);

  // Plaintext-creds path: hoist to keychain (preferred) or encrypted-file.
  const hasPlaintext = !!(config.connection.password || config.connection.smtpToken);
  const alreadyEncrypted = !!(config.connection.passwordEncrypted || config.connection.smtpTokenEncrypted);

  // Re-encryption path: existing v1 blobs upgraded to v2 (per-system entropy).
  // Decrypt with the matching old key, re-encrypt with the new key, save.
  const passwordEncryptedField = config.connection.passwordEncrypted;
  const smtpEncryptedField = config.connection.smtpTokenEncrypted;
  const pwNeedsReencrypt = CredentialEncryption.isValidEncrypted(passwordEncryptedField)
    && CredentialEncryption.needsReencrypt(passwordEncryptedField);
  const smtpNeedsReencrypt = CredentialEncryption.isValidEncrypted(smtpEncryptedField)
    && CredentialEncryption.needsReencrypt(smtpEncryptedField);
  if (!hasPlaintext && (pwNeedsReencrypt || smtpNeedsReencrypt)) {
    try {
      // CRED-011: stage BOTH re-encrypted blobs in locals first. If the second
      // encrypt throws, we must not have already mutated the first field — that
      // would leave a config with one v2 blob and one v1 blob, and the catch
      // below would swallow it. Assign + save only once both succeed.
      let newPasswordEncrypted: typeof config.connection.passwordEncrypted;
      let newSmtpEncrypted: typeof config.connection.smtpTokenEncrypted;
      if (pwNeedsReencrypt && CredentialEncryption.isValidEncrypted(passwordEncryptedField)) {
        newPasswordEncrypted = CredentialEncryption.encrypt(CredentialEncryption.decrypt(passwordEncryptedField));
      }
      if (smtpNeedsReencrypt && CredentialEncryption.isValidEncrypted(smtpEncryptedField)) {
        newSmtpEncrypted = CredentialEncryption.encrypt(CredentialEncryption.decrypt(smtpEncryptedField));
      }
      if (newPasswordEncrypted !== undefined) config.connection.passwordEncrypted = newPasswordEncrypted;
      if (newSmtpEncrypted !== undefined) config.connection.smtpTokenEncrypted = newSmtpEncrypted;
      saveConfig(config);
      tags.migrated = true;
      return true;
    } catch {
      // Decryption failed (e.g. host moved without preserving v1 key inputs).
      // Don't crash; leave the v1 blob as-is so the next save path can rotate.
      tags.migrated = false;
      return false;
    }
  }

  if (!hasPlaintext || alreadyEncrypted) {
    tags.migrated = false;
    return false;
  }

  // Try keychain first
  const migratedToKeychain = await migrateFromConfig(config, saveConfig);
  if (migratedToKeychain) {
    tags.migrated = true;
    return true;
  }

  // Fall back to encrypted-file (always writes the current version)
  config.connection.passwordEncrypted  = config.connection.password
    ? CredentialEncryption.encrypt(config.connection.password)
    : undefined;
  config.connection.smtpTokenEncrypted = config.connection.smtpToken
    ? CredentialEncryption.encrypt(config.connection.smtpToken)
    : undefined;
  config.connection.password  = "";
  config.connection.smtpToken = "";
  config.credentialStorage = "encrypted-file";
  saveConfig(config);
  tags.migrated = true;
  return true;
  });
  }); // end tracer.span('config.migrateCredentials')
}
