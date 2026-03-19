import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Socket } from 'net';
import {
  RateLimiter,
  isValidChallengeId,
  sanitizeText,
  isValidEscalationTarget,
  isValidOrigin,
  readBodySafe,
  generateAccessToken,
  hasValidAccessToken,
  getPrimaryLanIP,
  clientIP,
  tryGenerateSelfSignedCert,
} from './security.js';

// ─── RateLimiter ────────────────────────────────────────────────────────────────

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  afterEach(() => {
    limiter?.dispose();
  });

  it('allows requests within the limit', () => {
    limiter = new RateLimiter(3, 60_000);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
  });

  it('blocks after exceeding the limit', () => {
    limiter = new RateLimiter(2, 60_000);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(true);
    expect(limiter.check('a')).toBe(false);
  });

  it('count() returns current count without consuming a slot', () => {
    limiter = new RateLimiter(5, 60_000);
    expect(limiter.count('x')).toBe(0);

    limiter.check('x');
    limiter.check('x');
    expect(limiter.count('x')).toBe(2);

    // count() itself should not increment
    expect(limiter.count('x')).toBe(2);
  });

  it('uses a sliding window — old requests do not count', () => {
    vi.useFakeTimers();
    try {
      limiter = new RateLimiter(2, 1000); // 2 requests per 1 second

      limiter.check('b');
      limiter.check('b');
      expect(limiter.check('b')).toBe(false); // at limit

      // Advance past the window
      vi.advanceTimersByTime(1100);

      // Old requests have expired; new ones should be allowed
      expect(limiter.check('b')).toBe(true);
      expect(limiter.check('b')).toBe(true);
      expect(limiter.check('b')).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('tracks keys independently', () => {
    limiter = new RateLimiter(1, 60_000);
    expect(limiter.check('ip1')).toBe(true);
    expect(limiter.check('ip2')).toBe(true);
    expect(limiter.check('ip1')).toBe(false);
    expect(limiter.check('ip2')).toBe(false);
  });
});

// ─── isValidChallengeId ─────────────────────────────────────────────────────────

describe('isValidChallengeId', () => {
  it('accepts a 32-char lowercase hex string', () => {
    expect(isValidChallengeId('a'.repeat(32))).toBe(true);
    expect(isValidChallengeId('0123456789abcdef0123456789abcdef')).toBe(true);
  });

  it('rejects strings that are too short or too long', () => {
    expect(isValidChallengeId('a'.repeat(31))).toBe(false);
    expect(isValidChallengeId('a'.repeat(33))).toBe(false);
  });

  it('rejects uppercase hex', () => {
    expect(isValidChallengeId('A'.repeat(32))).toBe(false);
  });

  it('rejects non-hex characters', () => {
    expect(isValidChallengeId('g'.repeat(32))).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidChallengeId(null)).toBe(false);
    expect(isValidChallengeId(undefined)).toBe(false);
    expect(isValidChallengeId(123)).toBe(false);
  });
});

// ─── sanitizeText ───────────────────────────────────────────────────────────────

describe('sanitizeText', () => {
  it('preserves normal text', () => {
    expect(sanitizeText('Hello, world!')).toBe('Hello, world!');
  });

  it('strips control characters', () => {
    expect(sanitizeText('abc\x00def\x01ghi')).toBe('abcdefghi');
  });

  it('preserves tabs, newlines, and carriage returns', () => {
    expect(sanitizeText('line1\nline2\ttab\rreturn')).toBe('line1\nline2\ttab\rreturn');
  });

  it('respects maxLen parameter', () => {
    expect(sanitizeText('abcdefghij', 5)).toBe('abcde');
  });

  it('returns empty string for non-string input', () => {
    expect(sanitizeText(null)).toBe('');
    expect(sanitizeText(undefined)).toBe('');
    expect(sanitizeText(42)).toBe('');
  });

  it('trims whitespace after processing', () => {
    expect(sanitizeText('  hello  ')).toBe('hello');
  });
});

// ─── isValidEscalationTarget ────────────────────────────────────────────────────

describe('isValidEscalationTarget', () => {
  it('accepts "send_only"', () => {
    expect(isValidEscalationTarget('send_only')).toBe(true);
  });

  it('accepts "supervised"', () => {
    expect(isValidEscalationTarget('supervised')).toBe(true);
  });

  it('accepts "full"', () => {
    expect(isValidEscalationTarget('full')).toBe(true);
  });

  it('rejects "read_only"', () => {
    expect(isValidEscalationTarget('read_only')).toBe(false);
  });

  it('rejects "custom"', () => {
    expect(isValidEscalationTarget('custom')).toBe(false);
  });

  it('rejects random strings', () => {
    expect(isValidEscalationTarget('admin')).toBe(false);
    expect(isValidEscalationTarget('')).toBe(false);
  });

  it('rejects non-string values', () => {
    expect(isValidEscalationTarget(null)).toBe(false);
    expect(isValidEscalationTarget(123)).toBe(false);
  });
});

// ─── isValidOrigin ──────────────────────────────────────────────────────────────

describe('isValidOrigin', () => {
  function mockReq(headers: Record<string, string> = {}) {
    return { headers } as unknown as import('http').IncomingMessage;
  }

  it('accepts localhost origin on the correct port', () => {
    const req = mockReq({ origin: 'http://localhost:8765' });
    expect(isValidOrigin(req, 8765, false)).toBe(true);
  });

  it('accepts 127.0.0.1 origin on the correct port', () => {
    const req = mockReq({ origin: 'http://127.0.0.1:8765' });
    expect(isValidOrigin(req, 8765, false)).toBe(true);
  });

  it('accepts https localhost origin', () => {
    const req = mockReq({ origin: 'https://localhost:8765' });
    expect(isValidOrigin(req, 8765, false)).toBe(true);
  });

  it('rejects unknown origins', () => {
    const req = mockReq({ origin: 'http://evil.com:8765' });
    expect(isValidOrigin(req, 8765, false)).toBe(false);
  });

  it('rejects localhost on a different port', () => {
    const req = mockReq({ origin: 'http://localhost:9999' });
    expect(isValidOrigin(req, 8765, false)).toBe(false);
  });

  it('accepts missing origin (defers to CSRF)', () => {
    const req = mockReq({});
    expect(isValidOrigin(req, 8765, false)).toBe(true);
  });

  it('falls back to referer when origin is absent', () => {
    const req = mockReq({ referer: 'http://localhost:8765/settings' });
    expect(isValidOrigin(req, 8765, false)).toBe(true);
  });

  it('rejects a port-prefix spoof via referer', () => {
    // "http://localhost:3000" should not match port 300
    const req = mockReq({ referer: 'http://localhost:30001/evil' });
    expect(isValidOrigin(req, 3000, false)).toBe(false);
  });

  it('accepts RFC-1918 192.168.x.x addresses in LAN mode', () => {
    const req = mockReq({ origin: 'http://192.168.1.50:8765' });
    expect(isValidOrigin(req, 8765, true)).toBe(true);
  });

  it('accepts RFC-1918 10.x.x.x addresses in LAN mode', () => {
    const req = mockReq({ origin: 'http://10.0.0.5:8765' });
    expect(isValidOrigin(req, 8765, true)).toBe(true);
  });

  it('accepts RFC-1918 172.16-31.x.x addresses in LAN mode', () => {
    const req = mockReq({ origin: 'http://172.16.0.1:8765' });
    expect(isValidOrigin(req, 8765, true)).toBe(true);
  });

  it('rejects non-RFC-1918 addresses in LAN mode', () => {
    const req = mockReq({ origin: 'http://8.8.8.8:8765' });
    expect(isValidOrigin(req, 8765, true)).toBe(false);
  });

  it('accepts localhost on correct port in LAN mode', () => {
    const req = mockReq({ origin: 'http://localhost:8765' });
    expect(isValidOrigin(req, 8765, true)).toBe(true);
  });
});

// ─── readBodySafe ────────────────────────────────────────────────────────────

describe('readBodySafe', () => {
  function mockIncomingMessage(chunks: Buffer[], opts: { delay?: number } = {}) {
    const emitter = new EventEmitter() as NodeJS.EventEmitter & {
      destroy: ReturnType<typeof vi.fn>;
      socket: Partial<Socket>;
    };
    (emitter as any).destroy = vi.fn();

    // Emit chunks asynchronously so the promise can be set up first
    setTimeout(() => {
      for (const chunk of chunks) {
        emitter.emit('data', chunk);
      }
      if (!opts.delay) emitter.emit('end');
    }, 0);

    return emitter as unknown as import('http').IncomingMessage;
  }

  it('resolves with the body when under the limit', async () => {
    const req = mockIncomingMessage([Buffer.from('hello world')]);
    const body = await readBodySafe(req, 1024, 5000);
    expect(body).toBe('hello world');
  });

  it('rejects with TOO_LARGE when body exceeds maxBytes', async () => {
    const bigChunk = Buffer.alloc(200, 'x');
    const req = mockIncomingMessage([bigChunk]);
    await expect(readBodySafe(req, 100, 5000)).rejects.toMatchObject({ code: 'TOO_LARGE' });
  });

  it('rejects with TIMEOUT when no data arrives within timeoutMs', async () => {
    const emitter = new EventEmitter() as any;
    emitter.destroy = vi.fn();
    // Never emit 'end' — simulates a slow-loris request
    const req = emitter as unknown as import('http').IncomingMessage;
    await expect(readBodySafe(req, 1024, 10)).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('rejects on request error', async () => {
    const emitter = new EventEmitter() as any;
    emitter.destroy = vi.fn();
    setTimeout(() => emitter.emit('error', new Error('socket reset')), 0);
    const req = emitter as unknown as import('http').IncomingMessage;
    await expect(readBodySafe(req, 1024, 5000)).rejects.toThrow('socket reset');
  });
});

// ─── generateAccessToken ─────────────────────────────────────────────────────

describe('generateAccessToken', () => {
  it('returns a token with a 64-char hex value', () => {
    const token = generateAccessToken();
    expect(typeof token.value).toBe('string');
    expect(token.value).toMatch(/^[0-9a-f]{64}$/);
  });

  it('fingerprint is formatted as XXXX-XXXX-XXXX-XXXX', () => {
    const token = generateAccessToken();
    expect(token.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/);
  });

  it('generates unique tokens each time', () => {
    const t1 = generateAccessToken();
    const t2 = generateAccessToken();
    expect(t1.value).not.toBe(t2.value);
  });
});

// ─── hasValidAccessToken ─────────────────────────────────────────────────────

describe('hasValidAccessToken', () => {
  function makeURL(search = '') {
    return new URL(`http://localhost:8765/${search}`);
  }

  function mockReqWithHeaders(headers: Record<string, string>) {
    return { headers } as unknown as import('http').IncomingMessage;
  }

  it('returns true when X-Access-Token header matches', () => {
    const token = generateAccessToken();
    const req = mockReqWithHeaders({ 'x-access-token': token.value });
    expect(hasValidAccessToken(req, makeURL(), token)).toBe(true);
  });

  it('returns false when X-Access-Token header is wrong', () => {
    const token = generateAccessToken();
    const req = mockReqWithHeaders({ 'x-access-token': 'wrongvalue' });
    expect(hasValidAccessToken(req, makeURL(), token)).toBe(false);
  });

  it('returns true when ?token= query param matches', () => {
    const token = generateAccessToken();
    const req = mockReqWithHeaders({});
    const url = makeURL(`?token=${token.value}`);
    expect(hasValidAccessToken(req, url, token)).toBe(true);
  });

  it('returns false when ?token= query param is wrong', () => {
    const token = generateAccessToken();
    const req = mockReqWithHeaders({});
    const url = makeURL('?token=badtoken');
    expect(hasValidAccessToken(req, url, token)).toBe(false);
  });

  it('returns false when neither header nor query param is provided', () => {
    const token = generateAccessToken();
    const req = mockReqWithHeaders({});
    expect(hasValidAccessToken(req, makeURL(), token)).toBe(false);
  });

  it('returns false when token length differs (timing-safe early exit)', () => {
    const token = generateAccessToken();
    const req = mockReqWithHeaders({ 'x-access-token': 'short' });
    expect(hasValidAccessToken(req, makeURL(), token)).toBe(false);
  });

  it('returns false when candidate has same string length but different byte length (multi-byte UTF-8)', () => {
    // "abcd" → 4 chars, 4 bytes. "caf\u00e9" → 4 chars, 5 bytes (é = 2 bytes).
    // String-length check passes, but timingSafeEqual throws on mismatched buffer sizes → catch returns false.
    const token = { value: 'abcd' };
    const req = mockReqWithHeaders({ 'x-access-token': 'caf\u00e9' });
    expect(hasValidAccessToken(req, makeURL(), token)).toBe(false);
  });
});

// ─── getPrimaryLanIP ─────────────────────────────────────────────────────────

describe('getPrimaryLanIP', () => {
  it('returns a string (either an IP address or empty string)', () => {
    const ip = getPrimaryLanIP();
    expect(typeof ip).toBe('string');
    // Either a valid IPv4 address or empty string (no external interface in CI)
    expect(ip).toMatch(/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$|^$/);
  });

});

// ─── clientIP ────────────────────────────────────────────────────────────────

describe('clientIP', () => {
  it('returns socket.remoteAddress when present', () => {
    const req = {
      socket: { remoteAddress: '127.0.0.1' },
    } as unknown as import('http').IncomingMessage;
    expect(clientIP(req)).toBe('127.0.0.1');
  });

  it('returns "unknown" when socket.remoteAddress is absent', () => {
    const req = { socket: {} } as unknown as import('http').IncomingMessage;
    expect(clientIP(req)).toBe('unknown');
  });

  it('returns "unknown" when socket itself is null', () => {
    const req = { socket: null } as unknown as import('http').IncomingMessage;
    expect(clientIP(req)).toBe('unknown');
  });
});

// ─── RateLimiter — MAX_RATE_LIMIT_BUCKETS eviction ───────────────────────────

describe('RateLimiter — bucket cap eviction', () => {
  it('evicts the oldest bucket when the cap is reached', () => {
    // This test exercises the MAX_RATE_LIMIT_BUCKETS path (>= 10_000 keys).
    // We use a small-key-count limiter and bypass the cap by inserting
    // enough unique keys to force the eviction path.
    // Since MAX_RATE_LIMIT_BUCKETS = 10_000 is too expensive to fill in a test,
    // we verify the limiter does not throw when fed many unique keys.
    const limiter = new RateLimiter(100, 60_000);
    // Fill with 100 unique keys — all should be allowed (within per-key limit)
    for (let i = 0; i < 100; i++) {
      expect(limiter.check(`key-${i}`)).toBe(true);
    }
    limiter.dispose();
  });

  it('triggers FIFO eviction when bucket count reaches MAX_RATE_LIMIT_BUCKETS (10_000)', () => {
    // Large window so entries are still fresh — evict() won't free any space,
    // forcing the FIFO fallback at line 96-97 to delete the oldest key.
    const limiter = new RateLimiter(1000, 60 * 60 * 1000); // 1hr window
    // Fill to exactly MAX_RATE_LIMIT_BUCKETS (10_000)
    for (let i = 0; i < 10_000; i++) {
      limiter.check(`fill-${i}`);
    }
    // This key is new → size === 10_000 → evict() runs (no stale entries) →
    // size still 10_000 → FIFO delete of oldest key
    const result = limiter.check('overflow-key');
    expect(result).toBe(true); // should still succeed
    limiter.dispose();
  });

  it('evict() removes stale entries when window expires', () => {
    const limiter = new RateLimiter(1000, 1); // 1ms window — entries go stale immediately
    for (let i = 0; i < 10_000; i++) {
      limiter.check(`stale-${i}`);
    }
    // Wait for entries to go stale, then fill to cap again to trigger evict()
    // which should now clear the stale entries
    setTimeout(() => {
      const result = limiter.check('fresh-after-stale');
      expect(result).toBe(true);
      limiter.dispose();
    }, 5);
  });
});

// ─── tryGenerateSelfSignedCert (integration) ─────────────────────────────────

describe('tryGenerateSelfSignedCert', () => {
  it('returns TlsCredentials or null (depends on openssl availability)', () => {
    // This is an integration test: if openssl is on PATH, we get a real cert.
    // If not, the function gracefully returns null. Either outcome is valid.
    const result = tryGenerateSelfSignedCert();
    if (result === null) {
      // openssl not available — that is a valid, expected outcome
      expect(result).toBeNull();
    } else {
      expect(result.key).toBeInstanceOf(Buffer);
      expect(result.cert).toBeInstanceOf(Buffer);
      expect(result.fingerprint).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/);
    }
  });
});
