/**
 * Tests for the Tracer utility.
 *
 * The Tracer class is not directly exported — we test through the singleton
 * `tracer` instance and reset its enabled state between tests.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { tracer } from './tracer.js';

describe('tracer (singleton)', () => {
  beforeEach(() => {
    // Always start each test with tracing disabled to avoid cross-test contamination
    tracer.setEnabled(false);
  });

  // ─── setEnabled / isEnabled ────────────────────────────────────────────────

  describe('setEnabled / isEnabled', () => {
    it('is disabled by default after reset', () => {
      expect(tracer.isEnabled()).toBe(false);
    });

    it('enables tracing', () => {
      tracer.setEnabled(true);
      expect(tracer.isEnabled()).toBe(true);
    });

    it('disables tracing after enabling', () => {
      tracer.setEnabled(true);
      tracer.setEnabled(false);
      expect(tracer.isEnabled()).toBe(false);
    });
  });

  // ─── currentTraceId ────────────────────────────────────────────────────────

  describe('currentTraceId', () => {
    it('returns undefined outside any span context', () => {
      expect(tracer.currentTraceId()).toBeUndefined();
    });

    it('returns a non-empty string inside an enabled async span', async () => {
      tracer.setEnabled(true);
      let capturedId: string | undefined;
      await tracer.span('test.op', {}, async () => {
        capturedId = tracer.currentTraceId();
      });
      expect(typeof capturedId).toBe('string');
      expect(capturedId!.length).toBeGreaterThan(0);
    });

    it('returns undefined again after the span exits', async () => {
      tracer.setEnabled(true);
      await tracer.span('test.op', {}, async () => {
        // no-op
      });
      // AsyncLocalStorage context is gone once span() resolves
      expect(tracer.currentTraceId()).toBeUndefined();
    });
  });

  // ─── span — disabled fast-path ─────────────────────────────────────────────

  describe('span (tracing disabled)', () => {
    it('calls fn and returns its value', async () => {
      const result = await tracer.span('op', {}, async () => 42);
      expect(result).toBe(42);
    });

    it('propagates thrown errors from fn', async () => {
      await expect(
        tracer.span('op', {}, async () => { throw new Error('disabled-err'); })
      ).rejects.toThrow('disabled-err');
    });

    it('does NOT set a traceId context when disabled', async () => {
      let capturedId: string | undefined;
      await tracer.span('op', {}, async () => {
        capturedId = tracer.currentTraceId();
      });
      expect(capturedId).toBeUndefined();
    });
  });

  // ─── span — enabled path ───────────────────────────────────────────────────

  describe('span (tracing enabled)', () => {
    it('calls fn and returns its value', async () => {
      tracer.setEnabled(true);
      const result = await tracer.span('op', { tag: 'v' }, async () => 'hello');
      expect(result).toBe('hello');
    });

    it('re-throws Error instances from fn (error status path)', async () => {
      tracer.setEnabled(true);
      await expect(
        tracer.span('op', {}, async () => { throw new TypeError('typed-err'); })
      ).rejects.toThrow('typed-err');
    });

    it('re-throws non-Error throws from fn (unknown error type path)', async () => {
      tracer.setEnabled(true);
      await expect(
        tracer.span('op', {}, async () => { throw 'string-throw'; })
      ).rejects.toBe('string-throw');
    });

    it('propagates traceId to nested spans', async () => {
      tracer.setEnabled(true);
      let outerTraceId: string | undefined;
      let innerTraceId: string | undefined;
      await tracer.span('outer', {}, async () => {
        outerTraceId = tracer.currentTraceId();
        await tracer.span('inner', {}, async () => {
          innerTraceId = tracer.currentTraceId();
        });
      });
      // Inner span inherits the same traceId as the outer span
      expect(innerTraceId).toBe(outerTraceId);
    });

    it('works with boolean and numeric tags', async () => {
      tracer.setEnabled(true);
      // Should not throw regardless of tag types
      await expect(
        tracer.span('op', { count: 5, flag: true }, async () => 'ok')
      ).resolves.toBe('ok');
    });
  });

  // ─── spanSync — disabled fast-path ────────────────────────────────────────

  describe('spanSync (tracing disabled)', () => {
    it('calls fn and returns its value', () => {
      const result = tracer.spanSync('op', {}, () => 'sync-result');
      expect(result).toBe('sync-result');
    });

    it('propagates synchronous errors from fn', () => {
      expect(() =>
        tracer.spanSync('op', {}, () => { throw new Error('sync-err'); })
      ).toThrow('sync-err');
    });
  });

  // ─── spanSync — enabled path ───────────────────────────────────────────────

  describe('spanSync (tracing enabled)', () => {
    it('calls fn and returns its value', () => {
      tracer.setEnabled(true);
      const result = tracer.spanSync('op', { x: 1 }, () => 99);
      expect(result).toBe(99);
    });

    it('re-throws Error instances (error status path)', () => {
      tracer.setEnabled(true);
      expect(() =>
        tracer.spanSync('op', {}, () => { throw new RangeError('range-err'); })
      ).toThrow('range-err');
    });

    it('re-throws non-Error values (unknown error type path)', () => {
      tracer.setEnabled(true);
      expect(() =>
        tracer.spanSync('op', {}, () => { throw 42; })
      ).toThrow();
    });

    it('works with empty tags object', () => {
      tracer.setEnabled(true);
      expect(() => tracer.spanSync('op', {}, () => {})).not.toThrow();
    });
  });
});
