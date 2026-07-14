/**
 * Bounded shutdown orchestration for the E2E MCP child.
 *
 * A graceful Client.close() is the only clean outcome. If it rejects or does
 * not settle, Transport.close() gets one bounded opportunity to force the
 * stdio child down. Timed-out operations remain observed so a later rejection
 * cannot escape as an unhandled rejection after teardown has returned.
 */

export interface BoundedMcpShutdownOptions {
  closeClient(): void | Promise<void>;
  closeTransport(): void | Promise<void>;
  /** Synchronous liveness probe for the exact child captured before shutdown.
   * A resolved SDK close promise is not proof that SIGKILL has been reaped. */
  isChildStopped(): boolean;
  clientTimeoutMs: number;
  transportTimeoutMs: number;
}

async function confirmStoppedWithin(
  isChildStopped: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  do {
    if (isChildStopped()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await new Promise<void>((resolveWait) => {
      setTimeout(resolveWait, Math.min(25, remaining));
    });
  } while (Date.now() < deadline);
  return isChildStopped();
}

export interface BoundedMcpShutdownResult {
  /** True when graceful close or the fallback transport stop was confirmed. */
  stopped: boolean;
  /** True only when Client.close() completed within its graceful budget. */
  clean: boolean;
  errors: string[];
}

type CloseAttempt =
  | { ok: true }
  | { ok: false; timedOut: boolean; error: string };

function positiveTimeout(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function closeWithin(
  label: string,
  close: () => void | Promise<void>,
  timeoutMs: number,
): Promise<CloseAttempt> {
  // Invoke through a Promise turn so synchronous throws and returned thenables
  // share the same observed rejection path.
  const operation = Promise.resolve().then(close);
  const observed = operation.then<CloseAttempt>(
    () => ({ ok: true }),
    (error: unknown) => ({
      ok: false,
      timedOut: false,
      error: `${label} failed: ${errorMessage(error)}`,
    }),
  );

  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CloseAttempt>((resolveTimeout) => {
    timer = setTimeout(() => {
      resolveTimeout({
        ok: false,
        timedOut: true,
        error: `${label} timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
  });

  const result = await Promise.race([observed, timeout]);
  if (timer) clearTimeout(timer);
  if (!result.ok && result.timedOut) {
    // Promise.race already installed a rejection observer through `observed`.
    // Keep an explicit terminal observer as defense in depth if this helper is
    // refactored later; neither Promise is allowed to become unhandled.
    void operation.catch(() => undefined);
  }
  return result;
}

/** Stop the E2E MCP child within the caller-provided production budgets. */
export async function shutdownMcpBounded(
  options: BoundedMcpShutdownOptions,
): Promise<BoundedMcpShutdownResult> {
  positiveTimeout(options.clientTimeoutMs, "clientTimeoutMs");
  positiveTimeout(options.transportTimeoutMs, "transportTimeoutMs");

  const client = await closeWithin(
    "MCP client close",
    options.closeClient,
    options.clientTimeoutMs,
  );
  const clientStopped = await confirmStoppedWithin(
    options.isChildStopped,
    options.clientTimeoutMs,
  );
  if (clientStopped) {
    return {
      stopped: true,
      clean: client.ok,
      errors: client.ok ? [] : [client.error],
    };
  }

  const errors = [
    ...(!client.ok ? [client.error] : []),
    `MCP child exit was not confirmed after client close within ${options.clientTimeoutMs}ms`,
  ];

  const transport = await closeWithin(
    "MCP transport close",
    options.closeTransport,
    options.transportTimeoutMs,
  );
  const transportStopped = await confirmStoppedWithin(
    options.isChildStopped,
    options.transportTimeoutMs,
  );
  return {
    stopped: transportStopped,
    clean: false,
    errors: [
      ...errors,
      ...(!transport.ok ? [transport.error] : []),
      ...(transportStopped
        ? []
        : [`MCP child exit was not confirmed after transport close within ${options.transportTimeoutMs}ms`]),
    ],
  };
}
