/**
 * Shared configuration reset workflow.
 *
 * Settings can be reset from the browser UI or either terminal UI.  Resetting
 * only ~/.mailpouch.json is incomplete when credentials were moved to the OS
 * keychain: the next migration or legacy fallback could still find old
 * mailbox, remote-server, or integration secrets.  This module keeps every
 * entry point on the same cleanup path.
 */

import {
  defaultConfig,
  invalidateConfigCache,
  loadConfig,
  saveConfig,
  withConfigWriteLockAsync,
} from "../config/loader.js";
import {
  deleteAccountCredentials,
  deleteAuxiliaryCredentials,
  deleteCredentials,
  deleteRemoteSecrets,
} from "../security/keychain.js";

export interface CredentialCleanupResult {
  /** Per-account keychain entries that were targeted for erasure. */
  accountIds: string[];
  /** Legacy bridge-password / smtp-token entries. */
  legacyCredentialsCleared: boolean;
  /** Per-account bridge-password:<id> / smtp-token:<id> entries. */
  accountCredentialsCleared: boolean;
  /** Proton Pass and SimpleLogin integration entries. */
  auxiliaryCredentialsCleared: boolean;
  /** Remote bearer and OAuth administrator entries. */
  remoteSecretsCleared: boolean;
}

export interface ConfigurationResetResult {
  credentialCleanup: CredentialCleanupResult;
  /**
   * True only when every known keychain namespace acknowledged deletion.
   * False does not roll back the file reset: an unavailable OS keychain must
   * not leave old plaintext configuration in place.  Callers should surface
   * this as a cleanup warning, not as a false-success claim.
  */
  credentialsCleared: boolean;
  /**
   * True when both the legacy and every known per-account mailbox credential
   * entry acknowledged deletion. This is narrower than credentialsCleared:
   * an auxiliary or remote-secret cleanup issue must not force the mailbox
   * manager to skip a safe rebuild.
   */
  mailboxCredentialsCleared: boolean;
  /**
   * True when the reset persisted a marker that blocks mailbox-keychain
   * hydration after restart. It is the fail-closed counterpart of an
   * incomplete mailbox credential cleanup.
   */
  keychainMailboxCredentialsQuarantined: boolean;
}

/**
 * Return valid, known account IDs from the persisted configuration.
 *
 * Always include `primary`: installs upgraded from the pre-accounts layout
 * can retain a per-account primary key even after accounts[] was introduced,
 * and it is safe to delete an absent keychain entry.  Restricting the values
 * avoids passing malformed, hand-edited config data to the OS keychain API.
 */
function knownAccountIds(): string[] {
  const cfg = loadConfig();
  const ids = new Set<string>(["primary"]);
  for (const account of cfg?.accounts ?? []) {
    if (
      typeof account.id === "string"
      && /^[A-Za-z0-9_-]{1,128}$/.test(account.id)
    ) {
      ids.add(account.id);
    }
  }
  return [...ids];
}

/**
 * Reset persisted settings to defaults and erase every credential namespace
 * known to mailpouch where the OS keychain is available.
 *
 * The config-file lock covers discovering account IDs, keychain cleanup, and
 * the atomic save.  That prevents a concurrent account save from adding a
 * credential between discovery and deletion (especially the stable `primary`
 * key) and then having its new secret erased by this reset.
 */
export async function resetConfiguration(): Promise<ConfigurationResetResult> {
  return withConfigWriteLockAsync(async () => {
    // A concurrent process may have atomically replaced the config just before
    // it released the same lock. Do not let this process's short-lived loader
    // cache omit one of that newer registry's keychain account IDs.
    invalidateConfigCache();
    const currentConfig = loadConfig() ?? defaultConfig();
    const currentResetGeneration = Number.isSafeInteger(currentConfig.configResetGeneration)
      && (currentConfig.configResetGeneration ?? 0) >= 0
      ? currentConfig.configResetGeneration ?? 0
      : 0;
    const accountIds = knownAccountIds();

    // Do not let one unavailable keychain namespace prevent the durable reset.
    // The functions are individually defensive; catch each call as an extra
    // guard if a platform-specific keyring implementation throws.
    const [legacy, accountResults, auxiliary, remote] = await Promise.all([
      deleteCredentials().catch(() => false),
      Promise.all(accountIds.map(accountId => deleteAccountCredentials(accountId).catch(() => false))),
      deleteAuxiliaryCredentials({ passAccessToken: true, simpleloginApiKey: true }).catch(() => false),
      deleteRemoteSecrets().catch(() => false),
    ]);

    const accountCredentialsCleared = accountResults.every(Boolean);
    const credentialCleanup: CredentialCleanupResult = {
      accountIds,
      legacyCredentialsCleared: legacy,
      accountCredentialsCleared,
      auxiliaryCredentialsCleared: auxiliary,
      remoteSecretsCleared: remote,
    };

    const mailboxCredentialsCleared =
      credentialCleanup.legacyCredentialsCleared
      && credentialCleanup.accountCredentialsCleared;
    const keychainMailboxCredentialsQuarantined = !mailboxCredentialsCleared;

    // saveConfig uses its atomic adjacent-temp-file rename and recognizes the
    // outer lock reentrantly, so the reset itself remains an atomic config
    // transition even while the cleanup calls above are asynchronous. Persist
    // the mailbox quarantine with the defaults: process-local suspension alone
    // would disappear on restart and let an undeleted keychain entry revive
    // the old mailbox.
    const resetConfig = defaultConfig();
    resetConfig.configResetGeneration = currentResetGeneration + 1;
    if (keychainMailboxCredentialsQuarantined) {
      resetConfig.keychainMailboxCredentialsQuarantined = true;
    }
    if (!credentialCleanup.auxiliaryCredentialsCleared) {
      // The auxiliary delete API is intentionally a single batch verdict. A
      // false result can mean one entry was removed before its sibling threw,
      // so quarantine both names until a later verified save/clear. Without a
      // durable marker, restart would rehydrate whichever stale entry remains.
      resetConfig.keychainAuxiliaryCredentialsQuarantined = {
        passAccessToken: true,
        simpleloginApiKey: true,
      };
    }
    saveConfig(resetConfig);

    return {
      credentialCleanup,
      credentialsCleared:
        credentialCleanup.legacyCredentialsCleared
        && credentialCleanup.accountCredentialsCleared
        && credentialCleanup.auxiliaryCredentialsCleared
        && credentialCleanup.remoteSecretsCleared,
      mailboxCredentialsCleared,
      keychainMailboxCredentialsQuarantined,
    };
  });
}
