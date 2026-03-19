/**
 * Tests for tryGenerateSelfSignedCert when spawnSync returns non-zero exit code.
 * Separate file to isolate child_process mock (security.mocked.test.ts already
 * mocks spawnSync to throw; this file mocks it to return status=1).
 *
 * Branch targeted: line 319 branch0 — `if (result.status !== 0 || ...) return null`
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('child_process', () => ({
  // spawnSync returns successfully but with non-zero exit code (openssl error)
  spawnSync: vi.fn(() => ({ status: 1, stdout: '', stderr: 'openssl error' })),
}));

import { tryGenerateSelfSignedCert } from './security.js';

describe('tryGenerateSelfSignedCert (spawnSync returns status=1)', () => {
  it('returns null when openssl exits with non-zero status (line 319 branch0)', () => {
    // spawnSync returns { status: 1 } → result.status !== 0 → return null
    const result = tryGenerateSelfSignedCert();
    expect(result).toBeNull();
  });
});
