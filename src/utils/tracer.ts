import { AsyncLocalStorage } from 'async_hooks';
import { randomBytes } from 'crypto';
import { logger } from './logger.js';

export interface SpanTags {
  [key: string]: string | number | boolean | undefined;
}

export interface CompletedSpan {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operation: string;
  startMs: number;
  durationMs: number;
  status: 'ok' | 'error';
  errorType?: string;
  tags: SpanTags;
}

class Tracer {
  private storage = new AsyncLocalStorage<{ traceId: string; currentSpanId?: string }>();
  private enabled: boolean = false;

  /** Enable or disable tracing. When disabled, span/spanSync are zero-overhead pass-throughs. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private shortId(): string {
    return randomBytes(4).toString('hex');
  }

  currentTraceId(): string | undefined {
    return this.storage.getStore()?.traceId;
  }

  async span<T>(operation: string, tags: SpanTags, fn: () => Promise<T>): Promise<T> {
    // Fast path: tracing disabled — zero overhead, no allocations
    if (!this.enabled) return fn();

    const ctx = this.storage.getStore();
    const traceId = ctx?.traceId ?? this.shortId();
    const spanId = this.shortId();
    const parentSpanId = ctx?.currentSpanId;
    const startHr = process.hrtime.bigint();
    const startMs = Date.now();

    return this.storage.run({ traceId, currentSpanId: spanId }, async () => {
      try {
        const result = await fn();
        this.emit({ traceId, spanId, parentSpanId, operation, startMs, durationMs: this.elapsed(startHr), status: 'ok', tags });
        return result;
      } catch (err: unknown) {
        this.emit({ traceId, spanId, parentSpanId, operation, startMs, durationMs: this.elapsed(startHr), status: 'error', errorType: err instanceof Error ? err.constructor.name : 'UnknownError', tags });
        throw err;
      }
    });
  }

  spanSync<T>(operation: string, tags: SpanTags, fn: () => T): T {
    // Fast path: tracing disabled — zero overhead, no allocations
    if (!this.enabled) return fn();

    const ctx = this.storage.getStore();
    const traceId = ctx?.traceId ?? this.shortId();
    const spanId = this.shortId();
    const parentSpanId = ctx?.currentSpanId;
    const startHr = process.hrtime.bigint();
    const startMs = Date.now();

    // For spanSync we cannot use storage.run with a sync fn and get the same
    // async-propagation benefit, but we still record the span with correct
    // parent linkage by reading the current context before running.
    try {
      const result = fn();
      this.emit({ traceId, spanId, parentSpanId, operation, startMs, durationMs: this.elapsed(startHr), status: 'ok', tags });
      return result;
    } catch (err: unknown) {
      this.emit({ traceId, spanId, parentSpanId, operation, startMs, durationMs: this.elapsed(startHr), status: 'error', errorType: err instanceof Error ? err.constructor.name : 'UnknownError', tags });
      throw err;
    }
  }

  private elapsed(startHr: bigint): number {
    return Number(process.hrtime.bigint() - startHr) / 1_000_000;
  }

  private emit(span: CompletedSpan): void {
    const depth = span.parentSpanId ? '  \u21b3' : '\u25b6';
    logger.debug(
      `${depth} [${span.traceId}] ${span.operation} ${span.status === 'ok' ? '\u2713' : '\u2717'} ${span.durationMs.toFixed(2)}ms`,
      'Tracer',
      {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        op: span.operation,
        ms: Math.round(span.durationMs * 100) / 100,
        status: span.status,
        ...(span.errorType ? { errorType: span.errorType } : {}),
        ...span.tags,
      }
    );
  }
}

export const tracer = new Tracer();
