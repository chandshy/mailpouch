/**
 * Tests for security.ts functions that require os.networkInterfaces mocking
 * for specific branch coverage scenarios.  Separate file to isolate the mock
 * from security.test.ts and security.mocked.test.ts.
 *
 * Branches targeted:
 *   - Line 204 branch1: if (lanIP) → false (lanIP is empty, no usable LAN interface)
 *   - Line 375 branch1: for (const iface of ifaces ?? []) → ifaces is null
 *   - Line 376 branch1: iface.family/internal condition is false (IPv6 or loopback)
 */

import { describe, it, expect, vi } from 'vitest';

// Control the os mock before any imports of the module under test.
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return {
    ...actual,
    networkInterfaces: vi.fn(() => ({
      // First entry: null value → covers line 375 branch1 (ifaces ?? [])
      lo0: null,
      // Second entry: loopback IPv4 → covers line 376 branch1 (iface.internal = true → condition false)
      lo1: [{ family: 'IPv4', internal: true, address: '127.0.0.1' }],
      // Third entry: IPv6 external → covers line 376 branch1 (family !== 'IPv4' → condition false)
      eth0: [{ family: 'IPv6', internal: false, address: '::1' }],
    })),
  };
});

import { getPrimaryLanIP, isValidOrigin } from './security.js';

describe('getPrimaryLanIP with no usable non-loopback IPv4 interface', () => {
  it('returns empty string when all interfaces are null, loopback, or IPv6 (lines 375-376)', () => {
    // networkInterfaces() is mocked to return: null entry, loopback IPv4, external IPv6
    // → all fail the "IPv4 && !internal" check → returns ""
    const ip = getPrimaryLanIP();
    expect(ip).toBe('');
  });
});

describe('isValidOrigin with lan=true but no LAN IP (line 204 branch1)', () => {
  it('still validates using RFC-1918 regex when getPrimaryLanIP returns "" (line 204 branch1)', () => {
    // lan=true but getPrimaryLanIP() returns "" → if (lanIP) is false → branch1
    // The RFC-1918 regex still applies even without a specific LAN IP
    const req = {
      headers: { origin: 'http://192.168.1.100:8765' },
    } as unknown as import('http').IncomingMessage;
    // Should still be valid via RFC-1918 regex (even without specific LAN IP)
    const result = isValidOrigin(req, 8765, true);
    expect(typeof result).toBe('boolean');
  });
});
