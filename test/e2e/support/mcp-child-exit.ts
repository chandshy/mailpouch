/**
 * Observe the exact child spawned by the MCP SDK's stdio transport.
 *
 * The SDK currently clears its private process reference before SIGKILL has
 * produced a `close` event, so neither transport.close() resolution nor its
 * public pid getter proves that the child can no longer mutate state. This
 * adapter attaches the close listener immediately after start() observes the
 * spawn event and exposes only the resulting terminal latch.
 */

interface ObservableChild {
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  once(event: "close", listener: () => void): unknown;
}

interface ObservableStdioTransport {
  start(): Promise<void>;
}

export interface McpChildExitLatch {
  /** True only after the exact observed child emitted `close`. */
  isStopped(): boolean;
}

export function observeMcpStdioChild(
  transport: ObservableStdioTransport,
): McpChildExitLatch {
  const internals = transport as ObservableStdioTransport & { _process?: ObservableChild };
  let observed: ObservableChild | undefined;
  let stopped = false;

  const capture = (): void => {
    const child = internals._process;
    if (!child) {
      throw new Error(
        "MCP stdio child could not be observed after transport start; refusing unprovable teardown",
      );
    }
    if (observed === child) return;
    if (observed) {
      throw new Error("MCP stdio transport replaced its observed child process");
    }
    observed = child;
    child.once("close", () => { stopped = true; });
    // A very short-lived child can close between the SDK's spawn resolution
    // and listener attachment. Its terminal fields are equivalent evidence.
    if (child.exitCode !== null || child.signalCode !== null) stopped = true;
  };

  if (internals._process) {
    capture();
  } else {
    const start = transport.start.bind(transport);
    transport.start = async (): Promise<void> => {
      await start();
      capture();
    };
  }

  return Object.freeze({ isStopped: () => observed !== undefined && stopped });
}
