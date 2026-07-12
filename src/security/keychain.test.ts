import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ServerConfig } from '../config/schema.js';

// keytar is an optional dependency that won't be installed in test environments.
// All functions should gracefully return null/false when keytar is unavailable.

describe('Keychain (without keytar installed)', () => {
  it('isKeychainAvailable should return false', async () => {
    const { isKeychainAvailable } = await import('./keychain.js');
    const available = await isKeychainAvailable();
    expect(available).toBe(false);
  });

  it('loadCredentials should return null', async () => {
    const { loadCredentials } = await import('./keychain.js');
    const creds = await loadCredentials();
    expect(creds).toBeNull();
  });

  it('saveCredentials should return false', async () => {
    const { saveCredentials } = await import('./keychain.js');
    const result = await saveCredentials('password', 'token');
    expect(result).toBe(false);
  });

  it('deleteCredentials should return false', async () => {
    const { deleteCredentials } = await import('./keychain.js');
    const result = await deleteCredentials();
    expect(result).toBe(false);
  });

  it('migrateFromConfig should return false when keychain unavailable', async () => {
    const { migrateFromConfig } = await import('./keychain.js');
    const mockConfig = {
      configVersion: 1,
      connection: {
        smtpHost: 'localhost',
        smtpPort: 1025,
        imapHost: 'localhost',
        imapPort: 1143,
        username: 'user@proton.me',
        password: 'bridge-password',
        smtpToken: '',
        bridgeCertPath: '',
        debug: false,
      },
      permissions: {
        preset: 'read_only' as const,
        tools: {} as any,
      },
    } satisfies ServerConfig;

    const saveFn = vi.fn();
    const result = await migrateFromConfig(mockConfig, saveFn);
    expect(result).toBe(false);
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('migrateFromConfig should return false when no credentials to migrate', async () => {
    const { migrateFromConfig } = await import('./keychain.js');
    const mockConfig = {
      configVersion: 1,
      connection: {
        smtpHost: 'localhost',
        smtpPort: 1025,
        imapHost: 'localhost',
        imapPort: 1143,
        username: 'user@proton.me',
        password: '',
        smtpToken: '',
        bridgeCertPath: '',
        debug: false,
      },
      permissions: {
        preset: 'read_only' as const,
        tools: {} as any,
      },
    } satisfies ServerConfig;

    const saveFn = vi.fn();
    const result = await migrateFromConfig(mockConfig, saveFn);
    expect(result).toBe(false);
    expect(saveFn).not.toHaveBeenCalled();
  });

  // ─── CRED-001 (audit 2026-05-28): aux credential migration ──────────────

  it('loadAuxiliaryCredentials should return null without keytar', async () => {
    const { loadAuxiliaryCredentials } = await import('./keychain.js');
    expect(await loadAuxiliaryCredentials()).toBeNull();
  });

  it('saveAuxiliaryCredentials should return false without keytar', async () => {
    const { saveAuxiliaryCredentials } = await import('./keychain.js');
    expect(await saveAuxiliaryCredentials('pat-secret', 'sl-key')).toBe(false);
  });

  it('deleteAuxiliaryCredentials should return false without keytar', async () => {
    const { deleteAuxiliaryCredentials } = await import('./keychain.js');
    expect(await deleteAuxiliaryCredentials({ passAccessToken: true })).toBe(false);
  });

  it('deleteRemoteSecrets should return false without keytar', async () => {
    const { deleteRemoteSecrets } = await import('./keychain.js');
    expect(await deleteRemoteSecrets()).toBe(false);
  });

  it('migrateFromConfig with only Pass PAT set leaves the secret on disk when keychain is unavailable (CRED-001)', async () => {
    const { migrateFromConfig } = await import('./keychain.js');
    const mockConfig = {
      configVersion: 1,
      connection: {
        smtpHost: 'localhost',
        smtpPort: 1025,
        imapHost: 'localhost',
        imapPort: 1143,
        username: 'user@proton.me',
        password: '',
        smtpToken: '',
        passAccessToken: 'pat-secret-123',
        simpleloginApiKey: '',
        bridgeCertPath: '',
        debug: false,
      },
      permissions: {
        preset: 'read_only' as const,
        tools: {} as any,
      },
    } satisfies ServerConfig;

    const saveFn = vi.fn();
    // Without keychain, return is false and the secret stays on disk —
    // any successful keychain save would have blanked the field. This is
    // the behaviour-preserving guard for the new aux-credential plumbing:
    // we don't crash on the new fields, we don't lose them, and we don't
    // pretend they migrated when keychain is unavailable. The harder
    // assertion ("the migration code branched into the new aux block,
    // not into the legacy 'nothing to migrate' early return") needs a
    // keytar mock — TEST-005 in Batch 7 will add that positive-path harness.
    const result = await migrateFromConfig(mockConfig, saveFn);
    expect(result).toBe(false);
    expect(mockConfig.connection.passAccessToken).toBe('pat-secret-123');
    expect(saveFn).not.toHaveBeenCalled();
  });

  it('migrateFromConfig with only SimpleLogin API key set leaves the secret on disk when keychain is unavailable (CRED-001)', async () => {
    const { migrateFromConfig } = await import('./keychain.js');
    const mockConfig = {
      configVersion: 1,
      connection: {
        smtpHost: 'localhost',
        smtpPort: 1025,
        imapHost: 'localhost',
        imapPort: 1143,
        username: 'user@proton.me',
        password: '',
        smtpToken: '',
        passAccessToken: '',
        simpleloginApiKey: 'sl-api-key-xyz',
        bridgeCertPath: '',
        debug: false,
      },
      permissions: {
        preset: 'read_only' as const,
        tools: {} as any,
      },
    } satisfies ServerConfig;

    const saveFn = vi.fn();
    const result = await migrateFromConfig(mockConfig, saveFn);
    expect(result).toBe(false);
    expect(mockConfig.connection.simpleloginApiKey).toBe('sl-api-key-xyz');
    expect(saveFn).not.toHaveBeenCalled();
  });
});

// ─── TEST-005 (audit 2026-05-28): positive-path coverage ────────────────────
//
// The "without keytar installed" suite above only exercises the failure
// branch — every test runs in an environment where @napi-rs/keyring is
// absent. The branch where keychain IS available and round-trips succeed
// was uncovered. Below we use `__setKeyringForTests()` to inject a stub
// `Entry` backend that records every set/get/delete call. The stub is
// rebuilt in `beforeEach` so previously-set "entries" don't leak across
// tests — vi.mock can't reach the `new Function("specifier","return
// import(specifier)")` dynamic load that keychain.ts uses, so the explicit
// inject hook is the only way to get a fresh-factory-per-test guarantee.

/** Test-scoped stub of the @napi-rs/keyring Entry class. */
interface StubEntryInstance {
  getPassword(): string | null;
  setPassword(password: string): void;
  deletePassword(): boolean;
}

/** A fresh stub backend for one test. Records every operation so assertions
 *  can inspect the side effects. */
interface StubBackend {
  /** Map of `${service}|${account}` → password. */
  store: Map<string, string>;
  setCalls: Array<{ service: string; account: string; password: string }>;
  getCalls: Array<{ service: string; account: string }>;
  deleteCalls: Array<{ service: string; account: string }>;
  EntryCtor: new (service: string, account: string) => StubEntryInstance;
}

function makeStubBackend(): StubBackend {
  const store = new Map<string, string>();
  const setCalls: StubBackend['setCalls'] = [];
  const getCalls: StubBackend['getCalls'] = [];
  const deleteCalls: StubBackend['deleteCalls'] = [];
  class Entry implements StubEntryInstance {
    constructor(private readonly service: string, private readonly account: string) {}
    getPassword(): string | null {
      getCalls.push({ service: this.service, account: this.account });
      return store.get(`${this.service}|${this.account}`) ?? null;
    }
    setPassword(password: string): void {
      setCalls.push({ service: this.service, account: this.account, password });
      // Overwrite — IDEMPOTENT, NOT throw. saveCredentials called twice with
      // different values must update, not error.
      store.set(`${this.service}|${this.account}`, password);
    }
    deletePassword(): boolean {
      deleteCalls.push({ service: this.service, account: this.account });
      return store.delete(`${this.service}|${this.account}`);
    }
  }
  return { store, setCalls, getCalls, deleteCalls, EntryCtor: Entry };
}

describe('Keychain (positive-path with stub @napi-rs/keyring) — TEST-005', () => {
  let backend: StubBackend;

  beforeEach(async () => {
    // Fresh stub per test — no leaked entries from prior cases.
    backend = makeStubBackend();
    const { __setKeyringForTests } = await import('./keychain.js');
    __setKeyringForTests({ Entry: backend.EntryCtor });
  });

  // Clear after each — restore the real "no keytar" behaviour so the negative
  // suite above isn't poisoned if it runs after this block in a single file.
  // (We re-import to get the same module instance.)
  async function clear(): Promise<void> {
    const { __setKeyringForTests } = await import('./keychain.js');
    __setKeyringForTests(null);
  }

  it('isKeychainAvailable returns true when the backend resolves', async () => {
    const { isKeychainAvailable } = await import('./keychain.js');
    expect(await isKeychainAvailable()).toBe(true);
    await clear();
  });

  it('saveCredentials → loadCredentials round-trip records set/get calls', async () => {
    const { saveCredentials, loadCredentials } = await import('./keychain.js');
    expect(await saveCredentials('bridge-pwd-1', 'smtp-tok-1')).toBe(true);
    const loaded = await loadCredentials();
    expect(loaded).toEqual({ password: 'bridge-pwd-1', smtpToken: 'smtp-tok-1' });
    // Verify the stub backend saw the right service/account combos.
    expect(backend.setCalls).toEqual([
      { service: 'mailpouch', account: 'bridge-password', password: 'bridge-pwd-1' },
      { service: 'mailpouch', account: 'smtp-token', password: 'smtp-tok-1' },
    ]);
    expect(backend.getCalls.length).toBeGreaterThanOrEqual(2);
    await clear();
  });

  it('saveAuxiliaryCredentials → loadAuxiliaryCredentials round-trip (CRED-001)', async () => {
    const { saveAuxiliaryCredentials, loadAuxiliaryCredentials } = await import('./keychain.js');
    expect(await saveAuxiliaryCredentials('pat-secret', 'sl-key')).toBe(true);
    const loaded = await loadAuxiliaryCredentials();
    expect(loaded).toEqual({ passAccessToken: 'pat-secret', simpleloginApiKey: 'sl-key' });
    expect(backend.store.get('mailpouch|pass-pat')).toBe('pat-secret');
    expect(backend.store.get('mailpouch|simplelogin-api-key')).toBe('sl-key');
    await clear();
  });

  it('deleteAuxiliaryCredentials removes only explicitly-cleared secrets', async () => {
    const { saveAuxiliaryCredentials, loadAuxiliaryCredentials, deleteAuxiliaryCredentials } = await import('./keychain.js');
    await saveAuxiliaryCredentials('pat-secret', 'sl-key');
    expect(await deleteAuxiliaryCredentials({ passAccessToken: true })).toBe(true);
    expect(await loadAuxiliaryCredentials()).toEqual({ passAccessToken: '', simpleloginApiKey: 'sl-key' });
    expect(backend.store.has('mailpouch|pass-pat')).toBe(false);
    expect(backend.store.get('mailpouch|simplelogin-api-key')).toBe('sl-key');
    await clear();
  });

  it('deleteRemoteSecrets removes both remote-server entries', async () => {
    const { saveRemoteSecrets, loadRemoteSecrets, deleteRemoteSecrets } = await import('./keychain.js');
    await saveRemoteSecrets('bearer-secret', 'oauth-admin-secret');
    expect(await deleteRemoteSecrets()).toBe(true);
    expect(await loadRemoteSecrets()).toBeNull();
    expect(backend.store.has('mailpouch|remote-bearer-token')).toBe(false);
    expect(backend.store.has('mailpouch|remote-oauth-admin-password')).toBe(false);
    await clear();
  });

  it('migrateFromConfig migrates all six fields and blanks each one on disk', async () => {
    const { migrateFromConfig, loadCredentials, loadRemoteSecrets, loadAuxiliaryCredentials } =
      await import('./keychain.js');
    const cfg = {
      configVersion: 1,
      connection: {
        smtpHost: 'localhost',
        smtpPort: 1025,
        imapHost: 'localhost',
        imapPort: 1143,
        username: 'user@proton.me',
        password: 'bridge-pwd',
        smtpToken: 'smtp-tok',
        remoteBearerToken: 'bearer-tok',
        remoteOauthAdminPassword: 'oauth-pwd',
        passAccessToken: 'pat-tok',
        simpleloginApiKey: 'sl-tok',
        bridgeCertPath: '',
        debug: false,
      },
      permissions: { preset: 'read_only' as const, tools: {} as any },
    } satisfies ServerConfig;
    const saveFn = vi.fn();
    const result = await migrateFromConfig(cfg, saveFn);
    expect(result).toBe(true);
    // All six fields blanked on disk.
    expect(cfg.connection.password).toBe('');
    expect(cfg.connection.smtpToken).toBe('');
    expect(cfg.connection.remoteBearerToken).toBe('');
    expect(cfg.connection.remoteOauthAdminPassword).toBe('');
    expect(cfg.connection.passAccessToken).toBe('');
    expect(cfg.connection.simpleloginApiKey).toBe('');
    // credentialStorage promoted to keychain and persisted.
    expect((cfg as any).credentialStorage).toBe('keychain');
    expect(saveFn).toHaveBeenCalledTimes(1);
    // All six secrets readable from the keychain stub.
    expect(await loadCredentials()).toEqual({ password: 'bridge-pwd', smtpToken: 'smtp-tok' });
    expect(await loadRemoteSecrets()).toEqual({ remoteBearerToken: 'bearer-tok', remoteOauthAdminPassword: 'oauth-pwd' });
    expect(await loadAuxiliaryCredentials()).toEqual({ passAccessToken: 'pat-tok', simpleloginApiKey: 'sl-tok' });
    await clear();
  });

  it('saving the same key twice overwrites rather than throwing (collision handling)', async () => {
    const { saveCredentials, loadCredentials } = await import('./keychain.js');
    await saveCredentials('first-pwd', 'first-tok');
    // Second save with new values must overwrite, not throw.
    await expect(saveCredentials('second-pwd', 'second-tok')).resolves.toBe(true);
    const loaded = await loadCredentials();
    expect(loaded).toEqual({ password: 'second-pwd', smtpToken: 'second-tok' });
    // Two save invocations × two fields each = 4 setPassword calls recorded.
    expect(backend.setCalls).toHaveLength(4);
    await clear();
  });

  it('deleteCredentials clears the entries and the in-stub store', async () => {
    const { saveCredentials, deleteCredentials, loadCredentials } = await import('./keychain.js');
    await saveCredentials('to-be-deleted', 'also-deleted');
    expect(backend.store.size).toBe(2);
    expect(await deleteCredentials()).toBe(true);
    // Stub state cleared.
    expect(backend.store.has('mailpouch|bridge-password')).toBe(false);
    expect(backend.store.has('mailpouch|smtp-token')).toBe(false);
    // deletePassword was invoked for both accounts.
    expect(backend.deleteCalls).toEqual([
      { service: 'mailpouch', account: 'bridge-password' },
      { service: 'mailpouch', account: 'smtp-token' },
    ]);
    // loadCredentials now returns null (both fields empty).
    expect(await loadCredentials()).toBeNull();
    await clear();
  });
});
