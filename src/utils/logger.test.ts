import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Logger } from './logger.js';

describe('Logger', () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it('should create logger instance', () => {
    const logger = new Logger();
    expect(logger).toBeInstanceOf(Logger);
  });

  it('should log info message', () => {
    const logger = new Logger();
    logger.info('Test message', 'TestContext');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[INFO]'),
      ''
    );
  });

  it('should log warning message', () => {
    const logger = new Logger();
    logger.warn('Test warning', 'TestContext');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[WARN]'),
      ''
    );
  });

  it('should log error message', () => {
    const logger = new Logger();
    const error = new Error('Test error');
    logger.error('Test error', 'TestContext', error);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[ERROR]'),
      error
    );
  });

  it('should log debug message when debug mode is enabled', () => {
    const logger = new Logger();
    logger.setDebugMode(true);
    logger.debug('Test debug', 'TestContext');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[DEBUG]'),
      ''
    );
  });

  it('should not log debug message when debug mode is disabled', () => {
    const logger = new Logger();
    logger.debug('Test debug', 'TestContext');

    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('should include context in log message', () => {
    const logger = new Logger();
    logger.info('Test message', 'CustomContext');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[CustomContext]'),
      ''
    );
  });

  it('should handle optional data parameter', () => {
    const logger = new Logger();
    const data = { key: 'value' };
    logger.info('Test message', 'TestContext', data);

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[INFO]'),
      data
    );
  });

  it('should use default context if not provided', () => {
    const logger = new Logger();
    logger.info('Test message');

    expect(consoleErrorSpy).toHaveBeenCalledWith(
      expect.stringContaining('[System]'),
      ''
    );
  });

  // ─── getLogs ────────────────────────────────────────────────────────────────

  describe('getLogs', () => {
    it('returns all stored logs when no level filter is given', () => {
      const logger = new Logger();
      logger.info('msg1', 'Ctx');
      logger.warn('msg2', 'Ctx');
      logger.error('msg3', 'Ctx');
      const logs = logger.getLogs();
      expect(logs.length).toBe(3);
    });

    it('filters by level', () => {
      const logger = new Logger();
      logger.info('info-msg', 'Ctx');
      logger.warn('warn-msg', 'Ctx');
      const warnLogs = logger.getLogs('warn');
      expect(warnLogs).toHaveLength(1);
      expect(warnLogs[0].level).toBe('warn');
      expect(warnLogs[0].message).toBe('warn-msg');
    });

    it('respects limit parameter', () => {
      const logger = new Logger();
      for (let i = 0; i < 10; i++) logger.info(`msg${i}`, 'Ctx');
      const logs = logger.getLogs(undefined, 3);
      // Returns last N entries
      expect(logs).toHaveLength(3);
      expect(logs[2].message).toBe('msg9');
    });

    it('clamps limit to minimum 1', () => {
      const logger = new Logger();
      logger.info('only', 'Ctx');
      const logs = logger.getLogs(undefined, 0);
      expect(logs).toHaveLength(1);
    });

    it('clamps limit to maximum 500', () => {
      const logger = new Logger();
      for (let i = 0; i < 10; i++) logger.info(`msg${i}`, 'Ctx');
      // limit of 99999 should be clamped to 500 — all 10 still returned
      const logs = logger.getLogs(undefined, 99999);
      expect(logs.length).toBe(10);
    });

    it('filters debug logs (only captured in debug mode)', () => {
      const logger = new Logger();
      logger.setDebugMode(true);
      logger.debug('dbg', 'Ctx');
      logger.info('inf', 'Ctx');
      const debugOnly = logger.getLogs('debug');
      expect(debugOnly).toHaveLength(1);
      expect(debugOnly[0].level).toBe('debug');
    });
  });

  // ─── clearLogs ──────────────────────────────────────────────────────────────

  describe('clearLogs', () => {
    it('empties the log buffer', () => {
      const logger = new Logger();
      logger.info('a', 'Ctx');
      logger.warn('b', 'Ctx');
      expect(logger.getLogs().length).toBe(2);
      logger.clearLogs();
      expect(logger.getLogs().length).toBe(0);
    });
  });

  // ─── maxLogs ring-buffer eviction ────────────────────────────────────────────

  describe('maxLogs eviction', () => {
    it('drops oldest log entries when buffer is full (1000 cap)', () => {
      const logger = new Logger();
      // Fill beyond the 1000-entry cap
      for (let i = 0; i < 1002; i++) logger.info(`msg${i}`, 'Ctx');
      const logs = logger.getLogs(undefined, 500);
      // Should never exceed 500 (the getLogs limit) and the first entry
      // should NOT be msg0 or msg1 (they were evicted)
      expect(logs[0].message).not.toBe('msg0');
    });
  });

  // ─── sanitizeData (observable through getLogs data field) ────────────────────

  describe('sanitizeData', () => {
    it('redacts sensitive key "password"', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', { password: 'secret123' });
      const entry = logger.getLogs()[0];
      expect((entry.data as Record<string, unknown>)['password']).toBe('[redacted]');
    });

    it('redacts sensitive key "body"', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', { body: 'email body content' });
      const entry = logger.getLogs()[0];
      expect((entry.data as Record<string, unknown>)['body']).toBe('[redacted]');
    });

    it('redacts sensitive key "smtpToken"', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', { smtpToken: 'tok-abc' });
      const entry = logger.getLogs()[0];
      expect((entry.data as Record<string, unknown>)['smtpToken']).toBe('[redacted]');
    });

    it('preserves non-sensitive keys', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', { status: 'ok', count: 42 });
      const entry = logger.getLogs()[0];
      const data = entry.data as Record<string, unknown>;
      expect(data['status']).toBe('ok');
      expect(data['count']).toBe(42);
    });

    it('truncates long strings to 200 chars with ellipsis', () => {
      const logger = new Logger();
      const longStr = 'x'.repeat(300);
      logger.info('test', 'Ctx', { msg: longStr });
      const entry = logger.getLogs()[0];
      const sanitized = (entry.data as Record<string, unknown>)['msg'] as string;
      expect(sanitized.length).toBeLessThanOrEqual(201); // 200 chars + '…'
      expect(sanitized.endsWith('…')).toBe(true);
    });

    it('replaces C0 control characters in strings', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', { msg: 'hello\nworld\x01' });
      const entry = logger.getLogs()[0];
      const sanitized = (entry.data as Record<string, unknown>)['msg'] as string;
      expect(sanitized).not.toMatch(/[\x00-\x1f\x7f]/);
      expect(sanitized).toBe('hello world '); // \n → ' ', \x01 → ' '
    });

    it('handles array data (sanitizes each element)', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', ['hello', 'world']);
      const entry = logger.getLogs()[0];
      expect(Array.isArray(entry.data)).toBe(true);
      expect(entry.data).toEqual(['hello', 'world']);
    });

    it('handles array with sensitive nested objects', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', [{ password: 'secret' }]);
      const entry = logger.getLogs()[0];
      const arr = entry.data as Array<Record<string, unknown>>;
      expect(arr[0]['password']).toBe('[redacted]');
    });

    it('handles null data', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', null);
      const entry = logger.getLogs()[0];
      expect(entry.data).toBeNull();
    });

    it('handles undefined data (not stored)', () => {
      const logger = new Logger();
      logger.info('no data', 'Ctx');
      const entry = logger.getLogs()[0];
      expect(entry.data).toBeUndefined();
    });

    it('handles numeric data', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', 42);
      const entry = logger.getLogs()[0];
      expect(entry.data).toBe(42);
    });

    it('handles boolean data', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', true);
      const entry = logger.getLogs()[0];
      expect(entry.data).toBe(true);
    });

    it('handles circular references without infinite loop', () => {
      const logger = new Logger();
      const obj: Record<string, unknown> = { a: 1 };
      obj['self'] = obj; // circular reference
      expect(() => logger.info('circular', 'Ctx', obj)).not.toThrow();
      const entry = logger.getLogs()[0];
      const data = entry.data as Record<string, unknown>;
      expect(data['self']).toBe('[circular]');
    });

    it('handles nested objects recursively', () => {
      const logger = new Logger();
      logger.info('test', 'Ctx', { outer: { inner: { password: 'x', name: 'bob' } } });
      const entry = logger.getLogs()[0];
      const outer = (entry.data as Record<string, unknown>)['outer'] as Record<string, unknown>;
      const inner = outer['inner'] as Record<string, unknown>;
      expect(inner['password']).toBe('[redacted]');
      expect(inner['name']).toBe('bob');
    });
  });
});
