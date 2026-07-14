import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import { observeMcpStdioChild } from "./e2e/support/mcp-child-exit.js";

describe("MCP stdio child exit observation", () => {
  it("waits for the exact stubborn SDK child close event after transport.close resolves", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [
        "-e",
        "process.stdin.resume(); process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)",
      ],
      stderr: "ignore",
    });
    const latch = observeMcpStdioChild(transport);

    try {
      await transport.start();
      expect(latch.isStopped()).toBe(false);
      await transport.close();

      const deadline = Date.now() + 2_000;
      while (!latch.isStopped() && Date.now() < deadline) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      expect(latch.isStopped()).toBe(true);
    } finally {
      await transport.close();
    }
  }, 10_000);
});
