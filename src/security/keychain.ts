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
const KEY_REMOTE_BEARER = "remote-bearer-token";
const KEY_REMOTE_OAUTH_ADMIN = "remote-oauth-admin-password";
// CRED-001 (audit 2026-05-28): the Proton Pass PAT and SimpleLogin API key
// used to round-trip plaintext through ~/.mailpouch.json even when
// credentialStorage="keychain". Routed to dedicated keychain entries from
// v3.0.46 onwards; on-disk fields are blanked at migration.
const KEY_PASS_PAT = "pass-pat";
const KEY_SIMPLELOGIN_KEY = "simplelogin-api-key";

/**
 * Build the keychain account key for a per-account credential. Multi-
 * account support (see src/accounts/) needs one keychain entry per
 * configured mailbox so passwords don't collide or leak across
 * accounts. The single-account legacy keys (`bridge-password`,
 * `smtp-token`) remain for backwards compatibility — they're what
 * `loadCredentials()` / `saveCredentials()` at the top level read.
 */
function accountPasswordKey(accountId: string): string {
  return `bridge-password:${accountId}`;
}
function accountSmtpTokenKey(accountId: string): string {
  return `smtp-token:${accountId}`;
}

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

/**
 * Test hook — inject a stub `Entry` backend so the positive-path tests
 * (TEST-005 in Batch 7) can exercise save/load/migrate without `@napi-rs/
 * keyring` actually being installed and without relying on `vi.mock`
 * intercepting the `new Function("specifier","return import(specifier)")`
 * dynamic load. Pass `null` to clear and fall back to the real dynamic
 * import. Production code never calls this.
 */
export function __setKeyringForTests(stub: KeyringModule | null): void {
  if (stub === null) {
    keyringModule = null;
    keyringChecked = false;
  } else {
    keyringModule = stub;
    keyringChecked = true;
  }
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

// ─── Per-account helpers ──────────────────────────────────────────────────────

/**
 * Load the password / smtp-token stored in the keychain for a
 * specific account. Returns null when the keychain is unavailable or
 * when neither value is set for that account — callers can treat
 * those two cases the same (blank credentials).
 */
export async function loadAccountCredentials(
  accountId: string,
): Promise<{ password: string; smtpToken: string } | null> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return null;
    const password = new keyring.Entry(SERVICE_NAME, accountPasswordKey(accountId)).getPassword() ?? "";
    const smtpToken = new keyring.Entry(SERVICE_NAME, accountSmtpTokenKey(accountId)).getPassword() ?? "";
    if (!password && !smtpToken) return null;
    return { password, smtpToken };
  } catch {
    return null;
  }
}

/**
 * Save an account's password / smtp-token into the keychain. Empty
 * strings are silently skipped (the keychain entry keeps whatever
 * value it had before) — this lets the Accounts UI send back
 * "•••••••" as a placeholder when the user didn't change the field
 * without blowing away the real value. Returns true on any success
 * (at least one value stored), false if the keychain is unavailable
 * or both inputs are empty.
 */
export async function saveAccountCredentials(
  accountId: string,
  password: string,
  smtpToken: string,
): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    let wrote = false;
    if (password) {
      new keyring.Entry(SERVICE_NAME, accountPasswordKey(accountId)).setPassword(password);
      wrote = true;
    }
    if (smtpToken) {
      new keyring.Entry(SERVICE_NAME, accountSmtpTokenKey(accountId)).setPassword(smtpToken);
      wrote = true;
    }
    return wrote;
  } catch {
    return false;
  }
}

/**
 * Remove an account's keychain entries. Called when an account is
 * deleted via the Accounts tab — leaving stranded keychain entries
 * would accumulate cruft and leak old passwords on next `backup-
 * keychain` run.
 */
export async function deleteAccountCredentials(accountId: string): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    // An absent entry normally returns false rather than throwing and still
    // counts as successfully cleared. A thrown deletion, however, means a
    // caller (notably the configuration reset flow) must be told that cleanup
    // could not be verified instead of receiving a false success signal.
    let cleared = true;
    try { new keyring.Entry(SERVICE_NAME, accountPasswordKey(accountId)).deletePassword(); } catch { cleared = false; }
    try { new keyring.Entry(SERVICE_NAME, accountSmtpTokenKey(accountId)).deletePassword(); } catch { cleared = false; }
    return cleared;
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
  const remoteBearer = config.connection.remoteBearerToken;
  const remoteOauthAdmin = config.connection.remoteOauthAdminPassword;
  const passPat = config.connection.passAccessToken;
  const simpleloginKey = config.connection.simpleloginApiKey;

  // Nothing to migrate if every secret is already blank
  if (
    !password && !smtpToken && !remoteBearer && !remoteOauthAdmin
    && !passPat && !simpleloginKey
  ) return false;

  // Check if keychain is available
  const available = await isKeychainAvailable();
  if (!available) return false;

  // Store bridge creds (existing flow)
  let migrated = false;
  if (password || smtpToken) {
    const saved = await saveCredentials(password, smtpToken);
    if (saved) {
      config.connection.password = "";
      config.connection.smtpToken = "";
      migrated = true;
    }
  }

  // Store OAuth secrets (new) — same pattern, separate keychain entries.
  if (remoteBearer || remoteOauthAdmin) {
    const saved = await saveRemoteSecrets(remoteBearer ?? "", remoteOauthAdmin ?? "");
    if (saved) {
      config.connection.remoteBearerToken = "";
      config.connection.remoteOauthAdminPassword = "";
      migrated = true;
    }
  }

  // CRED-001: Pass PAT + SimpleLogin API key. Were previously left in
  // ~/.mailpouch.json even when credentialStorage="keychain" — silent lie.
  if (passPat || simpleloginKey) {
    const saved = await saveAuxiliaryCredentials(passPat ?? "", simpleloginKey ?? "");
    if (saved) {
      config.connection.passAccessToken = "";
      config.connection.simpleloginApiKey = "";
      migrated = true;
    }
  }

  if (migrated) {
    config.credentialStorage = "keychain";
    saveConfigFn(config);
  }
  return migrated;
}

/**
 * Load Pass PAT + SimpleLogin API key from the keychain (CRED-001).
 * Returns null if neither secret is present or keychain is unavailable.
 */
export async function loadAuxiliaryCredentials(): Promise<{ passAccessToken: string; simpleloginApiKey: string } | null> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return null;
    const passAccessToken = new keyring.Entry(SERVICE_NAME, KEY_PASS_PAT).getPassword() ?? "";
    const simpleloginApiKey = new keyring.Entry(SERVICE_NAME, KEY_SIMPLELOGIN_KEY).getPassword() ?? "";
    if (!passAccessToken && !simpleloginApiKey) return null;
    return { passAccessToken, simpleloginApiKey };
  } catch {
    return null;
  }
}

/** Save Pass PAT + SimpleLogin API key to the keychain. */
export async function saveAuxiliaryCredentials(passAccessToken: string, simpleloginApiKey: string): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    if (passAccessToken) new keyring.Entry(SERVICE_NAME, KEY_PASS_PAT).setPassword(passAccessToken);
    if (simpleloginApiKey) new keyring.Entry(SERVICE_NAME, KEY_SIMPLELOGIN_KEY).setPassword(simpleloginApiKey);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete selected auxiliary secrets after an explicit Settings UI clear.
 * Keeping this separate from saveAuxiliaryCredentials is intentional: callers
 * commonly pass an empty value to mean "leave this untouched", while an
 * explicit clear must remove the durable keychain entry too.
 */
export async function deleteAuxiliaryCredentials(targets: {
  passAccessToken?: boolean;
  simpleloginApiKey?: boolean;
}): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    if (targets.passAccessToken) {
      // A false return merely means the entry was already absent. A thrown
      // delete must fail the clear request instead of reporting false success.
      new keyring.Entry(SERVICE_NAME, KEY_PASS_PAT).deletePassword();
    }
    if (targets.simpleloginApiKey) {
      new keyring.Entry(SERVICE_NAME, KEY_SIMPLELOGIN_KEY).deletePassword();
    }
    return true;
  } catch {
    return false;
  }
}

/** Load remoteBearerToken + remoteOauthAdminPassword from the keychain. */
export async function loadRemoteSecrets(): Promise<{ remoteBearerToken: string; remoteOauthAdminPassword: string } | null> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return null;
    const remoteBearerToken = new keyring.Entry(SERVICE_NAME, KEY_REMOTE_BEARER).getPassword() ?? "";
    const remoteOauthAdminPassword = new keyring.Entry(SERVICE_NAME, KEY_REMOTE_OAUTH_ADMIN).getPassword() ?? "";
    if (!remoteBearerToken && !remoteOauthAdminPassword) return null;
    return { remoteBearerToken, remoteOauthAdminPassword };
  } catch {
    return null;
  }
}

/** Save remoteBearerToken + remoteOauthAdminPassword to the keychain. */
export async function saveRemoteSecrets(remoteBearerToken: string, remoteOauthAdminPassword: string): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    if (remoteBearerToken) new keyring.Entry(SERVICE_NAME, KEY_REMOTE_BEARER).setPassword(remoteBearerToken);
    if (remoteOauthAdminPassword) new keyring.Entry(SERVICE_NAME, KEY_REMOTE_OAUTH_ADMIN).setPassword(remoteOauthAdminPassword);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the remote-server secrets kept in the OS keychain.
 *
 * A configuration reset must remove these alongside mailbox and integration
 * credentials.  Keep this separate from saveRemoteSecrets(): an empty value
 * during an ordinary settings save means "leave the existing secret alone",
 * whereas reset is an explicit request to erase it.
 */
export async function deleteRemoteSecrets(): Promise<boolean> {
  try {
    const keyring = await getKeyring();
    if (!keyring) return false;
    new keyring.Entry(SERVICE_NAME, KEY_REMOTE_BEARER).deletePassword();
    new keyring.Entry(SERVICE_NAME, KEY_REMOTE_OAUTH_ADMIN).deletePassword();
    return true;
  } catch {
    return false;
  }
}
