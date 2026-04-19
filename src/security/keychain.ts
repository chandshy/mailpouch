/**
 * OS keychain abstraction for credential storage.
 *
 * Uses `@napi-rs/keyring` (optional dependency) to store credentials in:
 * - Windows: Credential Manager (pre-built binaries, no compilation needed)
 * - macOS: Keychain
 * - Linux: libsecret / GNOME Keyring
 *
 * If @napi-rs/keyring is not installed or the OS keychain is unavailable
 * (headless server, no GUI), all functions gracefully return null/false and
 * the caller falls back to config-file storage.
 */

import type { ServerConfig } from "../config/schema.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SERVICE_NAME = "mailpouch";
const KEY_PASSWORD = "bridge-password";
const KEY_SMTP_TOKEN = "smtp-token";

// ─── Lazy @napi-rs/keyring loading ────────────────────────────────────────────

interface EntryClass {
  new (service: string, account: string): {
    getPassword(): string | null;
    setPassword(password: string): void;
    deletePassword(): boolean;
  };
}

interface KeyringModule {
  Entry: EntryClass;
}

let keyringModule: KeyringModule | null = null;
let keyringChecked = false;

async function getKeyring(): Promise<KeyringModule | null> {
  if (keyringChecked) return keyringModule;
  keyringChecked = true;
  try {
    // Dynamic import — @napi-rs/keyring is an optional dependency and may not
    // be installed. Using Function constructor to bypass TypeScript's static
    // module resolution.
    const importFn = new Function("specifier", "return import(specifier)") as (s: string) => Promise<any>;
    keyringModule = await importFn("@napi-rs/keyring") as KeyringModule;
    return keyringModule;
  } catch {
    keyringModule = null;
    return null;
  }
}

/**
 * Test hook — reset the cached keyring module so `vi.mock` re-runs resolve
 * with a fresh factory between cases. Production code never calls this.
 */
export function __resetKeyringCacheForTests(): void {
  keyringModule = null;
  keyringChecked = false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check if the OS keychain is available.
 * Returns false if @napi-rs/keyring is not installed or the keychain daemon
 * is not running.
 */
export async function isKeychainAvailable(): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    // Probe call — will throw if no keychain daemon is running
    const probe = new keyring.Entry(SERVICE_NAME, "__probe__");
    probe.getPassword();
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
    const keyring = await getKeyring();
    if (!keyring) return null;

    const password = new keyring.Entry(SERVICE_NAME, KEY_PASSWORD).getPassword() ?? "";
    const smtpToken = new keyring.Entry(SERVICE_NAME, KEY_SMTP_TOKEN).getPassword() ?? "";

    if (!password && !smtpToken) return null;
    return { password, smtpToken };
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
    const keyring = await getKeyring();
    if (!keyring) return false;

    if (password) {
      new keyring.Entry(SERVICE_NAME, KEY_PASSWORD).setPassword(password);
    }
    if (smtpToken) {
      new keyring.Entry(SERVICE_NAME, KEY_SMTP_TOKEN).setPassword(smtpToken);
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
    const keyring = await getKeyring();
    if (!keyring) return false;

    new keyring.Entry(SERVICE_NAME, KEY_PASSWORD).deletePassword();
    new keyring.Entry(SERVICE_NAME, KEY_SMTP_TOKEN).deletePassword();
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
