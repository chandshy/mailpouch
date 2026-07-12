/**
 * Account registry — CRUD + active-selection over the AccountSpec array.
 *
 * Persistence piggybacks on the main config file (ServerConfig.accounts and
 * ServerConfig.activeAccountId). Writes go through the existing saveConfig
 * atomic-rename path. Migration from a pre-accounts config is lazy: when
 * the registry is first loaded and the accounts array is empty, the
 * top-level connection fields are lifted into a "primary" account so the
 * existing single-account behavior is preserved byte-for-byte.
 */

import { randomBytes } from "crypto";
import type { ServerConfig } from "../config/schema.js";
import {
  defaultConfig,
  invalidateConfigCache,
  loadConfig,
  saveConfig,
  withConfigWriteLockAsync,
} from "../config/loader.js";
import type { AccountSpec, AccountRegistry, AccountStatus } from "./types.js";
import {
  loadAccountCredentials,
  saveAccountCredentials,
  deleteAccountCredentials,
} from "../security/keychain.js";

export function shortId(): string {
  return `acct-${randomBytes(4).toString("hex")}`;
}

/**
 * Build a sanitized AccountSpec from the legacy top-level connection fields
 * on a ServerConfig. Used for the one-time migration when a user with a
 * pre-accounts config first opens the new UI.
 */
function specFromLegacy(cfg: ServerConfig): AccountSpec {
  const c = cfg.connection;
  const isBridge =
    (c.smtpHost === "localhost" || c.smtpHost === "127.0.0.1")
    && (c.imapHost === "localhost" || c.imapHost === "127.0.0.1");
  return {
    id: "primary",
    name: isBridge ? "Proton Mail (Bridge)" : (c.username || "Primary account"),
    providerType: isBridge ? "proton-bridge" : "imap",
    smtpHost: c.smtpHost, smtpPort: c.smtpPort,
    imapHost: c.imapHost, imapPort: c.imapPort,
    username: c.username, password: c.password,
    smtpToken: c.smtpToken || undefined,
    bridgeCertPath: c.bridgeCertPath || undefined,
    allowInsecureBridge: c.allowInsecureBridge,
    tlsMode: c.tlsMode,
    autoStartBridge: c.autoStartBridge,
    bridgePath: c.bridgePath || undefined,
  };
}

function registryFromConfig(cfg: ServerConfig): AccountRegistry {
  if (cfg.accounts && cfg.accounts.length > 0) {
    const activeId = cfg.activeAccountId
      && cfg.accounts.some(a => a.id === cfg.activeAccountId)
      ? cfg.activeAccountId
      : cfg.accounts[0].id;
    // Never hand out the loader's cached config objects.  The async secret
    // hydration path intentionally fills credentials into its returned
    // AccountSpecs; returning this array by reference put keychain secrets
    // back into the shared config cache and let unrelated config saves persist
    // them or settings reads disclose them.
    return { accounts: cfg.accounts.map(account => ({ ...account })), activeAccountId: activeId };
  }
  // Legacy migration path — lift the singleton connection into an account.
  const primary = specFromLegacy(cfg);
  return { accounts: [primary], activeAccountId: primary.id };
}

export function readRegistry(): AccountRegistry {
  return registryFromConfig(loadConfig() ?? defaultConfig());
}

/**
 * Load a detached, current config while the caller owns the write lock.
 *
 * The normal loader cache is safe for reads because it compares mtimes, but a
 * rapid atomic replacement can retain the same observable timestamp on some
 * filesystems. A read-modify-write must therefore invalidate unconditionally
 * after lock acquisition. Cloning also prevents a failed save from leaving
 * uncommitted registry state in the shared read cache.
 */
function loadFreshConfigForRegistryWrite(): ServerConfig {
  invalidateConfigCache();
  const loaded = loadConfig();
  return loaded ? structuredClone(loaded) : defaultConfig();
}

/** Resolve a mutation base from the fresh detached config snapshot. */
function readFreshRegistryForWrite(): AccountRegistry {
  return registryFromConfig(loadFreshConfigForRegistryWrite());
}

/**
 * Whether reset persisted a fail-closed mailbox-keychain quarantine.
 *
 * Keep this decision next to the only code that normally hydrates account
 * specs.  AccountManager and diagnostics both use readRegistryWithSecrets(),
 * so a restart cannot accidentally resurrect an undeleted legacy/per-account
 * credential through one caller that forgot to check the reset marker.
 */
export function mailboxKeychainCredentialsAreQuarantined(): boolean {
  return loadConfig()?.keychainMailboxCredentialsQuarantined === true;
}

/**
 * Async variant that fills each account's `password` and `smtpToken`
 * from the OS keychain when the on-disk entry is empty. Callers that
 * need plaintext credentials (the AccountManager, connect paths, send
 * paths) should prefer this over `readRegistry()` which only returns
 * the on-disk shape.
 *
 * Legacy single-account path still works: `specFromLegacy` pulls
 * `c.password` from the connection block (which is blank when the
 * keychain is authoritative), so we also try the legacy keychain
 * entry name (no account-id suffix) to populate the "primary" slot.
 */
export async function readRegistryWithSecrets(): Promise<AccountRegistry> {
  const reg = readRegistry();
  // Reset persisted a durable marker because at least one mailbox keychain
  // delete failed. Returning the unhydrated registry is intentional: even a
  // fresh process must fail closed rather than make that old credential live
  // again. A subsequent successful reset clears the marker.
  if (mailboxKeychainCredentialsAreQuarantined()) return reg;

  const { loadCredentials } = await import("../security/keychain.js");
  for (const acct of reg.accounts) {
    // The per-account keychain entry is AUTHORITATIVE for that account. Load it
    // unconditionally and prefer it over any value already on the spec so a
    // stale legacy primary credential can never shadow a newer account-owned
    // secret. A keychain miss falls back to the existing value / legacy key,
    // so config-plaintext and single-account installs are unaffected.
    const perAccount = await loadAccountCredentials(acct.id);
    let legacy: Awaited<ReturnType<typeof loadCredentials>> | null | undefined;
    const getLegacy = async () => {
      if (legacy === undefined) legacy = (await loadCredentials()) ?? null;
      return legacy;
    };

    if (perAccount?.password) {
      acct.password = perAccount.password;
    } else if (!acct.password && acct.id === "primary") {
      // Back-compat: the pre-multi-account keychain entry had no per-account
      // suffix. Fall back to the legacy key so existing installs keep working.
      const l = await getLegacy();
      if (l?.password) acct.password = l.password;
    }
    if (perAccount?.smtpToken) {
      acct.smtpToken = perAccount.smtpToken;
    } else if (!acct.smtpToken && acct.id === "primary") {
      const l = await getLegacy();
      if (l?.smtpToken) acct.smtpToken = l.smtpToken;
    }
  }
  return reg;
}

/**
 * Persist the registry to disk + route per-account credentials into
 * the OS keychain. Critical for the account-save security contract:
 * passwords MUST NOT land in the plaintext JSON file.
 *
 * Flow:
 *   1. For each account whose spec has a non-empty password, save it
 *      to the keychain under the per-account key, then blank the
 *      on-disk `password` field.
 *   2. Do the same for `smtpToken`.
 *   3. Also blank the legacy top-level `connection.password` /
 *      `connection.smtpToken` — they're mirrored from the active
 *      account below, and the active account's creds are keychain-
 *      backed after step 1.
 *   4. Persist the (now secret-free) JSON via the standard atomic
 *      rename path.
 *
 * If the keychain is unavailable (headless / no libsecret), the
 * function degrades to the old behavior — saves plaintext in the
 * file with a credentialStorage="config" marker so callers can
 * surface a warning. That's the same fallback saveConfigWithCredentials
 * uses for the legacy single-account path.
 *
 * This is an async function by necessity; the previous sync signature
 * cannot route secrets through the keychain without blocking. Call
 * sites that used to fire-and-forget should `await` it.
 */
export async function writeRegistry(reg: AccountRegistry): Promise<void> {
  // CRED-008: hold the exclusive config lock across the whole read-modify-write
  // (loadConfig → merge → saveConfig) so a racing settings-UI POST or a second
  // writeRegistry cannot clobber this write. The inner saveConfig reuses the
  // held lock reentrantly.
  await withConfigWriteLockAsync(async () => {
  const cfg = loadFreshConfigForRegistryWrite();

  // Clone the specs so we can blank secrets without mutating the
  // caller's in-memory view. Downstream code that holds a reference
  // to an AccountSpec still gets the plaintext it passed in.
  const scrubbed = await Promise.all(
    reg.accounts.map(async (a) => {
      const password = a.password ?? "";
      const smtpToken = a.smtpToken ?? "";
      const hadSecrets = !!(password || smtpToken);
      let keychainOk = false;
      if (hadSecrets) {
        keychainOk = await saveAccountCredentials(a.id, password, smtpToken);
      } else {
        keychainOk = true; // nothing to save, nothing to fall back to
      }
      return {
        // CRED-004: carry the real saveAccountCredentials result alongside the
        // scrubbed spec instead of re-deriving keychain success from the
        // scrubbed shape. The shape inference (`!password && !smtpToken`) was
        // brittle — a future normalisation of empty fields to undefined would
        // have silently flipped credentialStorage to "keychain" even on a
        // plaintext-fallback host. `keychainSaved` is true only when this
        // account actually had secrets AND the keychain accepted them.
        keychainSaved: hadSecrets && keychainOk,
        spec: {
          ...a,
          // Only blank the on-disk password when the keychain actually
          // took it. Headless / no-libsecret hosts keep the legacy
          // behavior (plaintext on disk, credentialStorage="config").
          password: keychainOk ? "" : password,
          smtpToken: keychainOk ? undefined : (smtpToken || undefined),
        } as AccountSpec,
      };
    }),
  );

  const scrubbedAccounts: AccountSpec[] = scrubbed.map(s => s.spec);
  cfg.accounts = scrubbedAccounts;
  cfg.activeAccountId = reg.activeAccountId;

  // Mark storage method based on whether ANY account actually saved to the
  // keychain (all-or-nothing per host; mixed mode isn't a supported
  // deployment). CRED-004: decided from the actual per-account keychain
  // result, not from inspecting the scrubbed on-disk shape.
  const anySecrets = reg.accounts.some(a => a.password || a.smtpToken);
  const anyKeychain = scrubbed.some(s => s.keychainSaved);
  if (anySecrets) {
    cfg.credentialStorage = anyKeychain ? "keychain" : "config";
  }

  // Mirror the *active* account's connection fields back into the
  // legacy top-level shape so the existing service bootstrap still
  // finds hostnames/ports at startup. Passwords are NEVER mirrored
  // here — they live in the keychain or (fallback) inside the
  // per-account spec above. The MCP's AccountManager now loads
  // secrets via readRegistryWithSecrets().
  const active = scrubbedAccounts.find(a => a.id === reg.activeAccountId) ?? scrubbedAccounts[0];
  if (active) {
    cfg.connection = {
      ...cfg.connection,
      smtpHost: active.smtpHost, smtpPort: active.smtpPort,
      imapHost: active.imapHost, imapPort: active.imapPort,
      username: active.username,
      password: "",                // keychain-backed; never on disk
      smtpToken: "",               // same
      bridgeCertPath: active.bridgeCertPath ?? "",
      allowInsecureBridge: active.allowInsecureBridge,
      tlsMode: active.tlsMode,
      autoStartBridge: active.autoStartBridge,
      bridgePath: active.bridgePath,
    };
  }
  saveConfig(cfg);
  });
}

export function listStatuses(): AccountStatus[] {
  const reg = readRegistry();
  return reg.accounts.map(a => ({
    id: a.id,
    name: a.name,
    providerType: a.providerType,
    isActive: a.id === reg.activeAccountId,
    lastCheckedAt: a.lastCheckedAt,
    lastCheckResult: a.lastCheckResult,
  }));
}

export async function createAccount(spec: Omit<AccountSpec, "id">): Promise<AccountSpec> {
  // Keep the read inside the same lock as the write.  writeRegistry() already
  // serializes its own persistence, but taking the registry snapshot before
  // that lock let two concurrent settings requests both append to an old array
  // and silently discard one another's account.
  return withConfigWriteLockAsync(async () => {
    const reg = readFreshRegistryForWrite();
    const account: AccountSpec = { ...spec, id: shortId() };
    reg.accounts.push(account);
    await writeRegistry(reg);
    return account;
  });
}

/**
 * Patch fields on an existing account. Unknown IDs return null.
 * Passwords / smtpTokens in the patch are routed to the keychain by
 * writeRegistry(); the returned AccountSpec still carries the
 * plaintext in memory only for its immediate API response; the running
 * AccountManager reloads the account-owned keychain entry after a mutation.
 */
export async function updateAccount(
  id: string,
  patch: Partial<AccountSpec>,
): Promise<AccountSpec | null> {
  return withConfigWriteLockAsync(async () => {
    const reg = readFreshRegistryForWrite();
    const idx = reg.accounts.findIndex(a => a.id === id);
    if (idx < 0) return null;
    const merged = { ...reg.accounts[idx], ...patch, id };
    reg.accounts[idx] = merged;
    await writeRegistry(reg);
    return merged;
  });
}

export async function deleteAccount(id: string): Promise<boolean> {
  const deleted = await withConfigWriteLockAsync(async () => {
    const reg = readFreshRegistryForWrite();
    if (reg.accounts.length <= 1) {
      // Refuse to delete the last account — leaves the server without
      // anywhere to connect.
      return false;
    }
    const before = reg.accounts.length;
    reg.accounts = reg.accounts.filter(a => a.id !== id);
    if (reg.accounts.length === before) return false;
    if (reg.activeAccountId === id) {
      reg.activeAccountId = reg.accounts[0].id;
    }
    await writeRegistry(reg);
    return true;
  });
  if (!deleted) return false;

  // Scrub the deleted account's keychain entries so stale secrets
  // don't accumulate. Non-fatal on failure.
  try { await deleteAccountCredentials(id); } catch { /* non-fatal */ }
  return true;
}

export async function setActiveAccount(id: string): Promise<AccountSpec | null> {
  return withConfigWriteLockAsync(async () => {
    const reg = readFreshRegistryForWrite();
    const match = reg.accounts.find(a => a.id === id);
    if (!match) return null;
    reg.activeAccountId = id;
    await writeRegistry(reg);
    return match;
  });
}
