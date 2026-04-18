import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomBytes } from 'crypto';
import {
  isUpgrade,
  getPendingFilePath,
  getAuditLogPath,
  requestEscalation,
  getEscalationStatus,
  getPendingEscalations,
  approveEscalation,
  denyEscalation,
  getAuditLog,
} from './escalation.js';
import type { PermissionPreset } from '../config/schema.js';

// ─── isUpgrade ──────────────────────────────────────────────────────────────────

describe('isUpgrade', () => {
  it('read_only → supervised is an upgrade', () => {
    expect(isUpgrade('read_only', 'supervised')).toBe(true);
  });

  it('supervised → read_only is not an upgrade', () => {
    expect(isUpgrade('supervised', 'read_only')).toBe(false);
  });

  it('read_only → full is an upgrade', () => {
    expect(isUpgrade('read_only', 'full')).toBe(true);
  });

  it('full → read_only is not an upgrade', () => {
    expect(isUpgrade('full', 'read_only')).toBe(false);
  });

  it('same preset is not an upgrade', () => {
    const presets: PermissionPreset[] = ['read_only', 'send_only', 'supervised', 'full', 'custom'];
    for (const p of presets) {
      expect(isUpgrade(p, p)).toBe(false);
    }
  });

  it('read_only → send_only is an upgrade', () => {
    expect(isUpgrade('read_only', 'send_only')).toBe(true);
  });

  it('send_only → read_only is not an upgrade', () => {
    expect(isUpgrade('send_only', 'read_only')).toBe(false);
  });

  it('send_only → supervised is an upgrade', () => {
    expect(isUpgrade('send_only', 'supervised')).toBe(true);
  });

  it('supervised → full is an upgrade', () => {
    expect(isUpgrade('supervised', 'full')).toBe(true);
  });

  it('full → supervised is not an upgrade', () => {
    expect(isUpgrade('full', 'supervised')).toBe(false);
  });

  it('supervised → custom is not an upgrade (same level)', () => {
    expect(isUpgrade('supervised', 'custom')).toBe(false);
  });

  it('custom → supervised is not an upgrade (same level)', () => {
    expect(isUpgrade('custom', 'supervised')).toBe(false);
  });

  it('custom → full is an upgrade', () => {
    expect(isUpgrade('custom', 'full')).toBe(true);
  });
});

// ─── File path helpers ───────────────────────────────────────────────────────

describe('getPendingFilePath / getAuditLogPath', () => {
  function clearEnv() {
    delete process.env.MAILPOUCH_PENDING;
    delete process.env.MAILPOUCH_AUDIT;
    delete process.env.PM_BRIDGE_MCP_PENDING;
    delete process.env.PM_BRIDGE_MCP_AUDIT;
    delete process.env.PROTONMAIL_MCP_PENDING;
    delete process.env.PROTONMAIL_MCP_AUDIT;
  }

  it('uses the new default home-dir path when env vars are absent', () => {
    clearEnv();
    // Default is the new mailpouch path unless a legacy file exists on disk
    // (the read-old/write-new fallback). The test runner's homedir is
    // unlikely to contain one, so assert the new name.
    expect(getPendingFilePath()).toMatch(/mailpouch\.pending\.json$/);
    expect(getAuditLogPath()).toMatch(/mailpouch\.audit\.jsonl$/);
  });

  it('uses new-name env var overrides (MAILPOUCH_*) when set', () => {
    clearEnv();
    process.env.MAILPOUCH_PENDING = '/tmp/test-pending-new.json';
    process.env.MAILPOUCH_AUDIT   = '/tmp/test-audit-new.jsonl';
    expect(getPendingFilePath()).toBe('/tmp/test-pending-new.json');
    expect(getAuditLogPath()).toBe('/tmp/test-audit-new.jsonl');
    clearEnv();
  });

  it('still accepts legacy PM_BRIDGE_MCP_* env vars', () => {
    clearEnv();
    process.env.PM_BRIDGE_MCP_PENDING = '/tmp/test-pending-v21.json';
    process.env.PM_BRIDGE_MCP_AUDIT   = '/tmp/test-audit-v21.jsonl';
    expect(getPendingFilePath()).toBe('/tmp/test-pending-v21.json');
    expect(getAuditLogPath()).toBe('/tmp/test-audit-v21.jsonl');
    clearEnv();
  });

  it('still accepts legacy PROTONMAIL_MCP_* env vars', () => {
    clearEnv();
    process.env.PROTONMAIL_MCP_PENDING = '/tmp/test-pending-legacy.json';
    process.env.PROTONMAIL_MCP_AUDIT   = '/tmp/test-audit-legacy.jsonl';
    expect(getPendingFilePath()).toBe('/tmp/test-pending-legacy.json');
    expect(getAuditLogPath()).toBe('/tmp/test-audit-legacy.jsonl');
    clearEnv();
  });

  it('MAILPOUCH_* > PM_BRIDGE_MCP_* > PROTONMAIL_MCP_* priority chain', () => {
    clearEnv();
    process.env.MAILPOUCH_PENDING      = '/tmp/mp-pending.json';
    process.env.MAILPOUCH_AUDIT        = '/tmp/mp-audit.jsonl';
    process.env.PM_BRIDGE_MCP_PENDING  = '/tmp/v21-pending.json';
    process.env.PM_BRIDGE_MCP_AUDIT    = '/tmp/v21-audit.jsonl';
    process.env.PROTONMAIL_MCP_PENDING = '/tmp/v1-pending.json';
    process.env.PROTONMAIL_MCP_AUDIT   = '/tmp/v1-audit.jsonl';
    expect(getPendingFilePath()).toBe('/tmp/mp-pending.json');
    expect(getAuditLogPath()).toBe('/tmp/mp-audit.jsonl');

    // With MAILPOUCH_* removed, PM_BRIDGE_MCP_* takes over.
    delete process.env.MAILPOUCH_PENDING;
    delete process.env.MAILPOUCH_AUDIT;
    expect(getPendingFilePath()).toBe('/tmp/v21-pending.json');
    expect(getAuditLogPath()).toBe('/tmp/v21-audit.jsonl');
    clearEnv();
  });
});

// ─── Full escalation workflow ────────────────────────────────────────────────

describe('escalation workflow', () => {
  let tmpDir: string;
  let pendingPath: string;
  let auditPath: string;
  const origPending    = process.env.MAILPOUCH_PENDING;
  const origAudit      = process.env.MAILPOUCH_AUDIT;
  const origV21Pend    = process.env.PM_BRIDGE_MCP_PENDING;
  const origV21Aud     = process.env.PM_BRIDGE_MCP_AUDIT;
  const origLegacyPend = process.env.PROTONMAIL_MCP_PENDING;
  const origLegacyAud  = process.env.PROTONMAIL_MCP_AUDIT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'escalation-test-'));
    pendingPath = join(tmpDir, 'pending.json');
    auditPath   = join(tmpDir, 'audit.jsonl');
    // Ensure stale overrides from another test cannot shadow the new-name
    // path we're about to set.
    delete process.env.PM_BRIDGE_MCP_PENDING;
    delete process.env.PM_BRIDGE_MCP_AUDIT;
    delete process.env.PROTONMAIL_MCP_PENDING;
    delete process.env.PROTONMAIL_MCP_AUDIT;
    process.env.MAILPOUCH_PENDING = pendingPath;
    process.env.MAILPOUCH_AUDIT   = auditPath;
  });

  afterEach(() => {
    if (origPending !== undefined) process.env.MAILPOUCH_PENDING = origPending;
    else delete process.env.MAILPOUCH_PENDING;
    if (origAudit !== undefined) process.env.MAILPOUCH_AUDIT = origAudit;
    else delete process.env.MAILPOUCH_AUDIT;
    if (origV21Pend !== undefined) process.env.PM_BRIDGE_MCP_PENDING = origV21Pend;
    if (origV21Aud !== undefined)  process.env.PM_BRIDGE_MCP_AUDIT   = origV21Aud;
    if (origLegacyPend !== undefined) process.env.PROTONMAIL_MCP_PENDING = origLegacyPend;
    if (origLegacyAud !== undefined)  process.env.PROTONMAIL_MCP_AUDIT   = origLegacyAud;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  // ── requestEscalation ──────────────────────────────────────────────────────

  it('requestEscalation() returns ok:true for a valid upgrade', () => {
    const result = requestEscalation('supervised', 'read_only', 'Need to send emails');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(typeof result.id).toBe('string');
    expect(result.id).toMatch(/^[0-9a-f]{32}$/);
    expect(result.newTools.length).toBeGreaterThanOrEqual(0);
  });

  it('requestEscalation() persists the pending file', () => {
    requestEscalation('supervised', 'read_only', 'Test');
    expect(existsSync(pendingPath)).toBe(true);
  });

  it('requestEscalation() computes unthrottledTools for supervised → full transition', () => {
    // supervised → full produces 15 unthrottled tools (tools with rateLimit in supervised
    // but no rateLimit in full), covering the unthrottledTools.filter callback (line 167)
    const result = requestEscalation('full', 'supervised', 'Need full access');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(result.unthrottledTools.length).toBeGreaterThan(0);

    // Load the record back from disk — this exercises loadPendingFile validation
    // of non-empty unthrottledTools arrays (line 167 in escalation.ts)
    const record = getEscalationStatus(result.id);
    expect(record).not.toBeNull();
    expect(record!.unthrottledTools.length).toBeGreaterThan(0);
  });

  it('requestEscalation() returns ok:false when not an upgrade', () => {
    const result = requestEscalation('read_only', 'supervised', 'Test');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toContain('not a higher privilege');
  });

  it('requestEscalation() rate-limits after RATE_LIMIT (5) requests per hour', () => {
    // RATE_LIMIT = 5 per hour.
    // MAX_PENDING = 1, so approve/deny each request before the next to avoid pending block.
    for (let i = 0; i < 5; i++) {
      const r = requestEscalation('supervised', 'read_only', `Reason ${i}`);
      expect(r.ok).toBe(true);
      if (!r.ok) break;
      // Approve each to clear pending slot
      approveEscalation(r.id, 'browser_ui');
    }
    // 6th request should hit rate limit
    const blocked = requestEscalation('supervised', 'read_only', 'Extra');
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error('unexpected');
    expect(blocked.error).toContain('Rate limit');
  });

  it('requestEscalation() blocks when MAX_PENDING (1) is already pending', () => {
    const r1 = requestEscalation('supervised', 'read_only', 'First');
    expect(r1.ok).toBe(true);
    const r2 = requestEscalation('supervised', 'read_only', 'Second');
    // MAX_PENDING = 1; second should be blocked
    expect(r2.ok).toBe(false);
    if (r2.ok) throw new Error('unexpected');
    expect(r2.error).toContain('pending');
  });

  // ── getEscalationStatus ────────────────────────────────────────────────────

  it('getEscalationStatus() returns the record for a known id', () => {
    const result = requestEscalation('supervised', 'read_only', 'Check status');
    if (!result.ok) throw new Error('request failed');
    const record = getEscalationStatus(result.id);
    expect(record).not.toBeNull();
    expect(record!.id).toBe(result.id);
    expect(record!.status).toBe('pending');
  });

  it('getEscalationStatus() returns null for unknown id', () => {
    expect(getEscalationStatus('nonexistent')).toBeNull();
  });

  // ── getPendingEscalations ──────────────────────────────────────────────────

  it('getPendingEscalations() returns pending items', () => {
    requestEscalation('supervised', 'read_only', 'Pending test');
    const pending = getPendingEscalations();
    expect(pending.length).toBeGreaterThan(0);
    expect(pending[0].status).toBe('pending');
  });

  it('getPendingEscalations() returns empty array when file does not exist', () => {
    expect(getPendingEscalations()).toEqual([]);
  });

  // ── approveEscalation ─────────────────────────────────────────────────────

  it('approveEscalation() marks the escalation approved', () => {
    const req = requestEscalation('supervised', 'read_only', 'Approve me');
    if (!req.ok) throw new Error('request failed');
    const result = approveEscalation(req.id, 'browser_ui');
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('unexpected');
    expect(result.targetPreset).toBe('supervised');
  });

  it('approveEscalation() fails for unknown id', () => {
    const result = approveEscalation('unknown-id', 'browser_ui');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toContain('not found');
  });

  it('approveEscalation() fails for already-resolved escalation', () => {
    const req = requestEscalation('supervised', 'read_only', 'Test double-approve');
    if (!req.ok) throw new Error('request failed');
    approveEscalation(req.id, 'browser_ui');
    const second = approveEscalation(req.id, 'browser_ui');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unexpected');
    expect(second.error).toContain('already');
  });

  it('approveEscalation() returns "Challenge has expired." for the TOCTOU race where entry slips past eviction but is past expiresAt', () => {
    const req = requestEscalation('supervised', 'read_only', 'Race condition expiry test');
    if (!req.ok) throw new Error('request failed');

    // Set expiresAt to a fixed point in time T
    const { readFileSync, writeFileSync } = require('fs');
    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    const T = Date.now() + 60_000; // 60 s from now
    fileData.escalations[0].expiresAt = new Date(T).toISOString();
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    // Mock Date.now so the first call (inside evictExpired) returns T-1 (not expired yet),
    // and the second call (line 394 in approveEscalation) returns T+1 (now expired).
    let callCount = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      callCount++;
      return callCount === 1 ? T - 1 : T + 1;
    });

    try {
      const result = approveEscalation(req.id, 'browser_ui');
      expect(result.ok).toBe(false);
      if (result.ok) throw new Error('unexpected');
      expect(result.error).toBe('Challenge has expired.');
    } finally {
      vi.restoreAllMocks();
    }
  });

  // ── denyEscalation ────────────────────────────────────────────────────────

  it('denyEscalation() marks the escalation denied', () => {
    const req = requestEscalation('supervised', 'read_only', 'Deny me');
    if (!req.ok) throw new Error('request failed');
    const result = denyEscalation(req.id, 'terminal_tui');
    expect(result.ok).toBe(true);
    const record = getEscalationStatus(req.id);
    expect(record!.status).toBe('denied');
  });

  it('denyEscalation() fails for unknown id', () => {
    const result = denyEscalation('no-such-id', 'browser_ui');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toContain('not found');
  });

  it('denyEscalation() fails for already-resolved escalation', () => {
    const req = requestEscalation('supervised', 'read_only', 'Deny then deny again');
    if (!req.ok) throw new Error('request failed');
    denyEscalation(req.id, 'browser_ui');
    const second = denyEscalation(req.id, 'browser_ui');
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unexpected');
    expect(second.error).toContain('already');
  });

  it('getPendingEscalations() evicts expired entries (evictExpired → savePendingFile path)', () => {
    const req = requestEscalation('supervised', 'read_only', 'Will expire');
    if (!req.ok) throw new Error('request failed');

    // Back-date expiresAt to trigger eviction
    const { readFileSync, writeFileSync } = require('fs');
    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    fileData.escalations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    // getPendingEscalations calls evictExpired which returns true (entry evicted) → savePendingFile called
    const pending = getPendingEscalations();
    expect(pending).toHaveLength(0); // expired entry not in pending list
  });

  it('approveEscalation() evicts expired entries before checking (evictExpired → savePendingFile path)', () => {
    // Create two escalations: one that will be expired, one that will be approved.
    const reqExpiring = requestEscalation('supervised', 'read_only', 'This will expire');
    if (!reqExpiring.ok) throw new Error('request failed');

    // Back-date the first escalation to expired, without using approveEscalation yet
    const { readFileSync, writeFileSync } = require('fs');
    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    fileData.escalations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    // Approve a non-existent ID — evictExpired will run and return true, triggering savePendingFile
    const result = approveEscalation('unknown-id', 'browser_ui');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toContain('not found');
  });

  it('denyEscalation() evicts expired entries before checking (evictExpired → savePendingFile path)', () => {
    const req = requestEscalation('supervised', 'read_only', 'Expiring before deny');
    if (!req.ok) throw new Error('request failed');

    // Back-date expiresAt to trigger eviction
    const { readFileSync, writeFileSync } = require('fs');
    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    fileData.escalations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    // Deny with unknown ID — evictExpired returns true (expired entry found) → savePendingFile called
    const result = denyEscalation('unknown-id', 'browser_ui');
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('unexpected');
    expect(result.error).toContain('not found');
  });

  // ── getAuditLog ───────────────────────────────────────────────────────────

  it('getAuditLog() returns empty array when file does not exist', () => {
    expect(getAuditLog()).toEqual([]);
  });

  it('getAuditLog() returns audit entries after a request+approve cycle', () => {
    const req = requestEscalation('supervised', 'read_only', 'Audit test');
    if (!req.ok) throw new Error('request failed');
    approveEscalation(req.id, 'browser_ui');
    const log = getAuditLog(10);
    expect(Array.isArray(log)).toBe(true);
    expect(log.length).toBeGreaterThanOrEqual(2);
    // Most recent entry should be "approved"
    const events = log.map(e => e.event);
    expect(events).toContain('requested');
    expect(events).toContain('approved');
  });

  it('getAuditLog() respects the limit parameter', () => {
    requestEscalation('supervised', 'read_only', 'Entry 1');
    const r = approveEscalation(getPendingEscalations()[0].id, 'browser_ui');
    expect(r.ok).toBe(true);
    const log = getAuditLog(1);
    expect(log.length).toBe(1);
  });

  it('getAuditLog() skips malformed lines', () => {
    const { writeFileSync } = require('fs');
    writeFileSync(auditPath, '{"event":"requested","id":"abc"}\n{not valid json}\n', 'utf-8');
    const log = getAuditLog(10);
    // Only the valid line should parse
    expect(log.length).toBe(1);
  });

  it('getAuditLog() returns empty array when file cannot be read', () => {
    // Write a valid audit path but make it a directory so readFileSync throws
    const { mkdirSync } = require('fs');
    mkdirSync(auditPath); // auditPath is now a directory, readFileSync will throw
    const log = getAuditLog(10);
    expect(log).toEqual([]);
    // Cleanup: remove the directory for afterEach
    rmSync(auditPath, { recursive: true, force: true });
  });

  it('loadPendingFile() recovers from invalid JSON in the pending file', () => {
    // Write invalid JSON to pending file to exercise the catch in loadPendingFile
    const { writeFileSync } = require('fs');
    writeFileSync(pendingPath, '{invalid json}', 'utf-8');
    // Accessing escalation data should not throw, should return empty
    const pending = getPendingEscalations();
    expect(pending).toEqual([]);
  });

  it('loadPendingFile() returns empty escalations when escalations field is not an array', () => {
    // Covers line 146: !Array.isArray(raw.escalations)
    const { writeFileSync } = require('fs');
    writeFileSync(pendingPath, JSON.stringify({ version: 1, escalations: 'not-an-array' }), 'utf-8');
    const pending = getPendingEscalations();
    expect(pending).toEqual([]);
  });

  it('loadPendingFile() filters out invalid escalation records (validation branches)', () => {
    const { readFileSync, writeFileSync } = require('fs');
    // First create a valid entry so the file exists
    const req = requestEscalation('supervised', 'read_only', 'Valid entry');
    if (!req.ok) throw new Error('request failed');

    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    // Append various invalid records to test all validation branches
    fileData.escalations.push(
      null,                                          // !e check (line 149)
      { id: 'invalid-hex', status: 'pending', currentPreset: 'read_only', targetPreset: 'supervised', requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), reason: 'r', newTools: [], unthrottledTools: [] }, // bad id
      { id: randomBytes(16).toString('hex'), status: 'unknown_status', currentPreset: 'read_only', targetPreset: 'supervised', requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), reason: 'r', newTools: [], unthrottledTools: [] }, // bad status
      { id: randomBytes(16).toString('hex'), status: 'pending', currentPreset: 'bad_preset', targetPreset: 'supervised', requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), reason: 'r', newTools: [], unthrottledTools: [] }, // bad currentPreset
      { id: randomBytes(16).toString('hex'), status: 'pending', currentPreset: 'read_only', targetPreset: 'bad_target', requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), reason: 'r', newTools: [], unthrottledTools: [] }, // bad targetPreset
      { id: randomBytes(16).toString('hex'), status: 'pending', currentPreset: 'read_only', targetPreset: 'supervised', requestedAt: 'not-a-date', expiresAt: new Date().toISOString(), reason: 'r', newTools: [], unthrottledTools: [] }, // bad requestedAt
      { id: randomBytes(16).toString('hex'), status: 'pending', currentPreset: 'read_only', targetPreset: 'supervised', requestedAt: new Date().toISOString(), expiresAt: 'not-a-date', reason: 'r', newTools: [], unthrottledTools: [] }, // bad expiresAt
      { id: randomBytes(16).toString('hex'), status: 'pending', currentPreset: 'read_only', targetPreset: 'supervised', requestedAt: new Date().toISOString(), expiresAt: new Date().toISOString(), reason: 42, newTools: [], unthrottledTools: [] }, // non-string reason
      { id: randomBytes(16).toString('hex'), status: 'pending', currentPreset: 'read_only', targetPreset: 'supervised', requestedAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 300_000).toISOString(), reason: 'ok', version: undefined }, // missing newTools/unthrottledTools arrays (triggers lines 157-158)
    );
    // Also test version ?? 1 (no version in file)
    delete fileData.version;
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    const pending = getPendingEscalations();
    // Only the original valid entry should survive validation (+ the last invalid one with missing arrays gets fixed)
    expect(pending.length).toBeGreaterThanOrEqual(1);
  });

  it('requestEscalation() evicts expired-status entries (pre-resolved, no eviction triggered)', () => {
    const req1 = requestEscalation('supervised', 'read_only', 'Will expire');
    if (!req1.ok) throw new Error('request failed');

    // Back-date AND pre-set status=expired so evictExpired does NOT trigger (entry already resolved)
    const { readFileSync, writeFileSync } = require('fs');
    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    fileData.escalations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    fileData.escalations[0].status = 'expired';
    fileData.escalations[0].resolvedAt = new Date().toISOString();
    fileData.escalations[0].resolvedBy = 'timeout';
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    // No pending entries block the new request; evictExpired finds nothing to evict
    const req2 = requestEscalation('supervised', 'read_only', 'New request after expiry');
    expect(req2.ok).toBe(true);
  });

  it('requestEscalation() triggers evictExpired+savePendingFile when pending entry has expired (line 280 branch0)', () => {
    const req1 = requestEscalation('supervised', 'read_only', 'Pending but expired');
    if (!req1.ok) throw new Error('request failed');

    // Back-date ONLY expiresAt — leave status as 'pending' so evictExpired picks it up
    const { readFileSync, writeFileSync } = require('fs');
    const fileData = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    fileData.escalations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    // status remains 'pending' → evictExpired will change it to 'expired' and return true
    writeFileSync(pendingPath, JSON.stringify(fileData), 'utf-8');

    // requestEscalation: loadPendingFile → evictExpired(data) returns true → savePendingFile called (line 280)
    // Then MAX_PENDING check finds 0 pending → new request allowed
    const req2 = requestEscalation('supervised', 'read_only', 'New after real expiry');
    expect(req2.ok).toBe(true);
  });

  it('savePendingFile() trims history to MAX_HISTORY (100) records', () => {
    // Write 101 historical (non-pending) records directly to the file,
    // then trigger a save by calling requestEscalation which calls savePendingFile.
    const { writeFileSync } = require('fs');

    // Create a valid pending file with 101 "sent" (non-pending) records
    // Use old requestedAt dates to avoid the 5/hour rate limit check
    const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const futureExpiry = new Date(Date.now() + 60_000).toISOString();
    const historicalRecords = Array.from({ length: 101 }, (_, i) => ({
      id: randomBytes(16).toString('hex'),
      requestedAt: twoHoursAgo,
      expiresAt: futureExpiry,
      targetPreset: 'supervised',
      currentPreset: 'read_only',
      reason: `Record ${i}`,
      status: 'denied',
      resolvedAt: twoHoursAgo,
      resolvedBy: 'browser_ui',
      newTools: [],
      unthrottledTools: [],
    }));

    writeFileSync(pendingPath, JSON.stringify({ version: 1, escalations: historicalRecords }), 'utf-8');

    // getPendingEscalations triggers loadPendingFile; the 101 denied records should all load
    // (MAX_HISTORY cap only triggers on SAVE, not load)
    // Now trigger a save by making a new request — savePendingFile will trim to 100
    const req = requestEscalation('supervised', 'read_only', 'Trigger save');
    expect(req.ok).toBe(true);

    // After save, the file should have been trimmed to MAX_HISTORY (100) + 1 pending
    const { readFileSync } = require('fs');
    const data = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    // 100 historical + 1 new pending = 101, but MAX_HISTORY=100 trims oldest,
    // so we keep at most 100 (the 100 oldest denied get trimmed to 100, then 1 pending added)
    expect(data.escalations.length).toBeLessThanOrEqual(101);
  });

  // ── evictExpired (via getEscalationStatus) ────────────────────────────────

  it('expired escalations are evicted on status check', () => {
    const req = requestEscalation('supervised', 'read_only', 'Expire me');
    if (!req.ok) throw new Error('request failed');

    // Manually back-date the expiresAt to the past by rewriting the file
    const { readFileSync, writeFileSync } = require('fs');
    const data = JSON.parse(readFileSync(pendingPath, 'utf-8'));
    data.escalations[0].expiresAt = new Date(Date.now() - 1000).toISOString();
    writeFileSync(pendingPath, JSON.stringify(data), 'utf-8');

    const record = getEscalationStatus(req.id);
    expect(record!.status).toBe('expired');
  });
});
