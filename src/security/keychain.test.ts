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
});

// ─── Legacy keychain migration ────────────────────────────────────────────────
//
// These tests stub the dynamic `import("@napi-rs/keyring")` call that the
// keychain module performs via `new Function("specifier", "return import(...)")`.
// The stub installs a fake Entry class backed by an in-memory map keyed by
// "<service>\0<account>" so we can assert the migration's read/write/delete
// behavior without touching the OS keychain.

type Store = Map<string, string>;

function installFakeKeyring(store: Store): () => void {
  const FakeEntry = class {
    constructor(private service: string, private account: string) {}
    private key(): string { return `${this.service}\u0000${this.account}`; }
    getPassword(): string | null {
      return store.has(this.key()) ? (store.get(this.key()) as string) : null;
    }
    setPassword(password: string): void { store.set(this.key(), password); }
    deletePassword(): boolean { return store.delete(this.key()); }
  };
  const fakeModule = { Entry: FakeEntry };
  const originalFn = global.Function;
  const patchedFn = function (this: unknown, ...args: unknown[]) {
    const src = String(args[args.length - 1] ?? "");
    if (src.includes("import(specifier)")) {
      return ((_specifier: string) => Promise.resolve(fakeModule)) as unknown as Function;
    }
    return (originalFn as unknown as new (...a: unknown[]) => Function)(...args as []);
  };
  patchedFn.prototype = originalFn.prototype;
  (global as { Function: unknown }).Function = patchedFn;
  return () => { (global as { Function: unknown }).Function = originalFn; };
}

describe('migrateLegacyKeychainEntries', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('migrates a legacy entry when no new entry exists (read, write, delete, return migrated=1)', async () => {
    const store: Store = new Map();
    store.set('pm-bridge-mcp\u0000bridge-password', 'secret-v2.1');
    const restore = installFakeKeyring(store);
    try {
      const { migrateLegacyKeychainEntries, __resetKeyringCacheForTests } = await import('./keychain.js');
      __resetKeyringCacheForTests();
      const result = await migrateLegacyKeychainEntries();
      expect(result.migrated).toBe(1);
      expect(result.conflicts).toBe(0);
      expect(store.get('mailpouch\u0000bridge-password')).toBe('secret-v2.1');
      expect(store.has('pm-bridge-mcp\u0000bridge-password')).toBe(false);
    } finally {
      restore();
    }
  });

  it('leaves both entries alone when the new slot is already populated (conflict counter)', async () => {
    const store: Store = new Map();
    store.set('pm-bridge-mcp\u0000bridge-password', 'legacy-value');
    store.set('mailpouch\u0000bridge-password', 'new-value');
    const restore = installFakeKeyring(store);
    try {
      const { migrateLegacyKeychainEntries, __resetKeyringCacheForTests } = await import('./keychain.js');
      __resetKeyringCacheForTests();
      const result = await migrateLegacyKeychainEntries();
      expect(result.migrated).toBe(0);
      expect(result.conflicts).toBe(1);
      // New slot untouched
      expect(store.get('mailpouch\u0000bridge-password')).toBe('new-value');
      // Legacy slot left in place (operator resolves)
      expect(store.get('pm-bridge-mcp\u0000bridge-password')).toBe('legacy-value');
    } finally {
      restore();
    }
  });

  it('is a noop when no legacy entries exist (migrated=0)', async () => {
    const store: Store = new Map();
    const restore = installFakeKeyring(store);
    try {
      const { migrateLegacyKeychainEntries, __resetKeyringCacheForTests } = await import('./keychain.js');
      __resetKeyringCacheForTests();
      const result = await migrateLegacyKeychainEntries();
      expect(result.migrated).toBe(0);
      expect(result.conflicts).toBe(0);
      expect(store.size).toBe(0);
    } finally {
      restore();
    }
  });

  it('is a noop when @napi-rs/keyring import fails (migrated=0)', async () => {
    // Do not install the fake — the real dynamic import throws because the
    // optional dep is not present in the test env.
    const { migrateLegacyKeychainEntries, __resetKeyringCacheForTests } = await import('./keychain.js');
    __resetKeyringCacheForTests();
    const result = await migrateLegacyKeychainEntries();
    expect(result.migrated).toBe(0);
    expect(result.conflicts).toBe(0);
  });
});
