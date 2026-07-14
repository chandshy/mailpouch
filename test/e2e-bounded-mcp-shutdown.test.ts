import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { shutdownMcpBounded } from "./e2e/support/bounded-mcp-shutdown.js";

function never(): Promise<void> {
  return new Promise(() => undefined);
}

describe("bounded MCP shutdown", () => {
  it("reports a graceful client close as clean and stopped", async () => {
    let stopped = false;
    const closeClient = vi.fn(async () => { stopped = true; });
    const closeTransport = vi.fn(async () => undefined);

    await expect(shutdownMcpBounded({
      closeClient,
      closeTransport,
      isChildStopped: () => stopped,
      clientTimeoutMs: 100,
      transportTimeoutMs: 100,
    })).resolves.toEqual({ stopped: true, clean: true, errors: [] });
    expect(closeClient).toHaveBeenCalledOnce();
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("uses one transport stop after a rejected client close", async () => {
    let stopped = false;
    const closeClient = vi.fn(async () => { throw new Error("client broke"); });
    const closeTransport = vi.fn(async () => { stopped = true; });

    await expect(shutdownMcpBounded({
      closeClient,
      closeTransport,
      isChildStopped: () => stopped,
      clientTimeoutMs: 100,
      transportTimeoutMs: 100,
    })).resolves.toEqual({
      stopped: true,
      clean: false,
      errors: [
        "MCP client close failed: client broke",
        "MCP child exit was not confirmed after client close within 100ms",
      ],
    });
    expect(closeTransport).toHaveBeenCalledOnce();
  });

  it("uses one transport stop after a client-close timeout", async () => {
    let stopped = false;
    const closeTransport = vi.fn(async () => { stopped = true; });

    await expect(shutdownMcpBounded({
      closeClient: never,
      closeTransport,
      isChildStopped: () => stopped,
      clientTimeoutMs: 10,
      transportTimeoutMs: 100,
    })).resolves.toEqual({
      stopped: true,
      clean: false,
      errors: [
        "MCP client close timed out after 10ms",
        "MCP child exit was not confirmed after client close within 10ms",
      ],
    });
    expect(closeTransport).toHaveBeenCalledOnce();
  });

  it("reports the child as not stopped when both close attempts reject", async () => {
    await expect(shutdownMcpBounded({
      closeClient: async () => { throw new Error("client broke"); },
      closeTransport: async () => { throw new Error("transport broke"); },
      isChildStopped: () => false,
      clientTimeoutMs: 100,
      transportTimeoutMs: 100,
    })).resolves.toEqual({
      stopped: false,
      clean: false,
      errors: [
        "MCP client close failed: client broke",
        "MCP child exit was not confirmed after client close within 100ms",
        "MCP transport close failed: transport broke",
        "MCP child exit was not confirmed after transport close within 100ms",
      ],
    });
  });

  it("bounds both attempts and observes their delayed rejections", async () => {
    let rejectClient!: (error: Error) => void;
    let rejectTransport!: (error: Error) => void;
    const client = new Promise<void>((_resolve, reject) => { rejectClient = reject; });
    const transport = new Promise<void>((_resolve, reject) => { rejectTransport = reject; });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);

    try {
      const startedAt = Date.now();
      await expect(shutdownMcpBounded({
        closeClient: () => client,
        closeTransport: () => transport,
        isChildStopped: () => false,
        clientTimeoutMs: 15,
        transportTimeoutMs: 15,
      })).resolves.toEqual({
        stopped: false,
        clean: false,
        errors: [
          "MCP client close timed out after 15ms",
          "MCP child exit was not confirmed after client close within 15ms",
          "MCP transport close timed out after 15ms",
          "MCP child exit was not confirmed after transport close within 15ms",
        ],
      });
      expect(Date.now() - startedAt).toBeLessThan(250);

      rejectClient(new Error("late client rejection"));
      rejectTransport(new Error("late transport rejection"));
      await new Promise((resolveWait) => setTimeout(resolveWait, 25));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("rejects invalid budgets before invoking either close operation", async () => {
    const closeClient = vi.fn(async () => undefined);
    const closeTransport = vi.fn(async () => undefined);

    await expect(shutdownMcpBounded({
      closeClient,
      closeTransport,
      isChildStopped: () => false,
      clientTimeoutMs: 0,
      transportTimeoutMs: 10,
    })).rejects.toThrow(/clientTimeoutMs must be a positive integer/);
    expect(closeClient).not.toHaveBeenCalled();
    expect(closeTransport).not.toHaveBeenCalled();
  });

  it("does not report a real stubborn child stopped until its close event is observed", async () => {
    const child = spawn(process.execPath, [
      "-e",
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
    ], { stdio: "ignore" });
    await once(child, "spawn");

    try {
      const result = await shutdownMcpBounded({
        closeClient: async () => undefined,
        closeTransport: async () => { child.kill("SIGKILL"); },
        isChildStopped: () => child.exitCode !== null || child.signalCode !== null,
        clientTimeoutMs: 25,
        transportTimeoutMs: 1_000,
      });

      expect(result.stopped).toBe(true);
      expect(result.clean).toBe(false);
      expect(result.errors).toContain(
        "MCP child exit was not confirmed after client close within 25ms",
      );
      expect(child.signalCode).toBe("SIGKILL");
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, "close");
        child.kill("SIGKILL");
        await closed;
      }
    }
  }, 10_000);
});
