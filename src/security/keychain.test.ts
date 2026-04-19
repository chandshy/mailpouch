import { describe, it, expect, vi } from 'vitest';
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
