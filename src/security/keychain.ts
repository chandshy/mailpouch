/**
 * OS keychain abstraction for credential storage.
 *
 * Uses `keytar` (optional dependency) to store credentials in:
 * - Windows: Credential Manager
 * - macOS: Keychain
 * - Linux: libsecret / GNOME Keyring
 *
 * If keytar is not installed or the OS keychain is unavailable (headless
 * server, no GUI), all functions gracefully return null/false and the
 * caller falls back to config-file storage.
 */

import type { ServerConfig } from "../config/schema.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_NAME = "protonmail-mcp-server";
const KEY_PASSWORD = "bridge-password";
const KEY_SMTP_TOKEN = "smtp-token";

// ─── Lazy keytar loading ──────────────────────────────────────────────────────

interface KeytarModule {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
}

let keytarModule: KeytarModule | null = null;
let keytarChecked = false;

async function getKeytar(): Promise<KeytarModule | null> {
  if (keytarChecked) return keytarModule;
  keytarChecked = true;
  try {
    // Dynamic import — keytar is an optional dependency and may not be installed.
    // Using Function constructor to bypass TypeScript's static module resolution.
    const importFn = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;
    keytarModule = await importFn("keytar") as KeytarModule;
    return keytarModule;
  } catch {
    keytarModule = null;
    return null;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if the OS keychain is available.
 * Returns false if keytar is not installed or the keychain daemon is not running.
 */
export async function isKeychainAvailable(): Promise<boolean> {
  try {
    const keytar = await getKeytar();
    if (!keytar) return false;
    // Probe call — will throw if no keychain daemon
    await keytar.getPassword(SERVICE_NAME, "__probe__");
    return true;
  } catch {
    return false;
  }
}

/**
 * Load credentials from the OS keychain.
 * Returns null if keychain is unavailable or credentials are not stored.
 */
export async function loadCredentials(): Promise<{ password: string; smtpToken: string } | null> {
  try {
    const keytar = await getKeytar();
    if (!keytar) return null;

    const password = await keytar.getPassword(SERVICE_NAME, KEY_PASSWORD);
    const smtpToken = await keytar.getPassword(SERVICE_NAME, KEY_SMTP_TOKEN);

    if (!password && !smtpToken) return null;
    return {
      password: password ?? "",
      smtpToken: smtpToken ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Save credentials to the OS keychain.
 * Returns true on success, false if keychain is unavailable.
 */
export async function saveCredentials(password: string, smtpToken: string): Promise<boolean> {
  try {
    const keytar = await getKeytar();
    if (!keytar) return false;

    if (password) {
      await keytar.setPassword(SERVICE_NAME, KEY_PASSWORD, password);
    }
    if (smtpToken) {
      await keytar.setPassword(SERVICE_NAME, KEY_SMTP_TOKEN, smtpToken);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete credentials from the OS keychain.
 * Returns true on success, false if keychain is unavailable.
 */
export async function deleteCredentials(): Promise<boolean> {
  try {
    const keytar = await getKeytar();
    if (!keytar) return false;

    await keytar.deletePassword(SERVICE_NAME, KEY_PASSWORD);
    await keytar.deletePassword(SERVICE_NAME, KEY_SMTP_TOKEN);
    return true;
  } catch {
    return false;
  }
}

/**
 * Migrate plaintext credentials from config file to OS keychain.
 * Idempotent — safe to call multiple times.
 *
 * Returns true if migration occurred, false if skipped or failed.
 */
export async function migrateFromConfig(
  config: ServerConfig,
  saveConfigFn: (config: ServerConfig) => void,
): Promise<boolean> {
  const password = config.connection.password;
  const smtpToken = config.connection.smtpToken;

  // Nothing to migrate if credentials are already blank
  if (!password && !smtpToken) return false;

  // Check if keychain is available
  const available = await isKeychainAvailable();
  if (!available) return false;

  // Store in keychain
  const saved = await saveCredentials(password, smtpToken);
  if (!saved) return false;

  // Blank credentials in config file
  config.connection.password = "";
  config.connection.smtpToken = "";
  config.credentialStorage = "keychain";
  saveConfigFn(config);

  return true;
}
