import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import e2eConfig from "../vitest.config.e2e.js";
import { MAILBOX_MUTATION_DEADLINE_MS } from "../src/services/mailbox-mutation-deadline.js";
import {
  BRIDGE_BASELINE_VERIFY_MS,
  BRIDGE_AUTO_RECOVERY_MAX_MS,
  BRIDGE_CLEANUP_SETTLE_MS,
  BRIDGE_HOOK_TIMEOUT_MS,
  BRIDGE_MCP_CLIENT_CLOSE_MS,
  BRIDGE_MCP_REQUEST_MS,
  BRIDGE_MCP_SHUTDOWN_MS,
  BRIDGE_MCP_TRANSPORT_CLOSE_MS,
  BRIDGE_MUTATION_COMMAND_MS,
  BRIDGE_PENDING_CLEANUP_MAX_MS,
  BRIDGE_SETUP_MS,
  BRIDGE_STANDALONE_MAX_MS,
  BRIDGE_STANDALONE_OVERHEAD_MS,
  BRIDGE_STANDALONE_PARENT_MARGIN_MS,
  BRIDGE_TEARDOWN_CLOSE_MARGIN_MS,
  bridgeStandaloneProcessBudgetMs,
} from "./e2e/support/time-budgets.mjs";

describe("live Bridge E2E teardown budgets", () => {
  it("keeps the outer hook beyond every fail-closed inner deadline", () => {
    const configuredHookTimeout = (e2eConfig as { test?: { hookTimeout?: number } }).test?.hookTimeout;

    expect(BRIDGE_PENDING_CLEANUP_MAX_MS).toBe(BRIDGE_CLEANUP_SETTLE_MS * 2);
    expect(BRIDGE_SETUP_MS).toBe(180_000);
    expect(BRIDGE_MUTATION_COMMAND_MS).toBeLessThan(BRIDGE_CLEANUP_SETTLE_MS);
    expect(BRIDGE_MUTATION_COMMAND_MS).toBeLessThan(BRIDGE_MCP_REQUEST_MS);
    expect(MAILBOX_MUTATION_DEADLINE_MS).toBeLessThan(BRIDGE_MCP_REQUEST_MS);
    expect(MAILBOX_MUTATION_DEADLINE_MS).toBe(50_000);
    expect(BRIDGE_MCP_REQUEST_MS).toBe(60_000);
    expect(BRIDGE_MCP_SHUTDOWN_MS).toBe(
      BRIDGE_MCP_CLIENT_CLOSE_MS + BRIDGE_MCP_TRANSPORT_CLOSE_MS,
    );
    expect(BRIDGE_STANDALONE_MAX_MS).toBe(
      BRIDGE_SETUP_MS
        + BRIDGE_PENDING_CLEANUP_MAX_MS
        + BRIDGE_BASELINE_VERIFY_MS
        + BRIDGE_STANDALONE_OVERHEAD_MS,
    );
    expect(bridgeStandaloneProcessBudgetMs(true)).toBe(BRIDGE_STANDALONE_MAX_MS);
    expect(bridgeStandaloneProcessBudgetMs(false)).toBe(
      BRIDGE_SETUP_MS
        + BRIDGE_CLEANUP_SETTLE_MS
        + BRIDGE_BASELINE_VERIFY_MS
        + BRIDGE_STANDALONE_OVERHEAD_MS,
    );
    expect(BRIDGE_AUTO_RECOVERY_MAX_MS).toBe(
      BRIDGE_PENDING_CLEANUP_MAX_MS
        + BRIDGE_STANDALONE_MAX_MS
        + BRIDGE_STANDALONE_PARENT_MARGIN_MS,
    );
    expect(configuredHookTimeout).toBe(BRIDGE_HOOK_TIMEOUT_MS);
    expect(BRIDGE_HOOK_TIMEOUT_MS).toBeGreaterThan(
      BRIDGE_AUTO_RECOVERY_MAX_MS,
    );
    expect(BRIDGE_HOOK_TIMEOUT_MS - BRIDGE_AUTO_RECOVERY_MAX_MS - BRIDGE_MCP_SHUTDOWN_MS)
      .toBe(BRIDGE_TEARDOWN_CLOSE_MARGIN_MS);
  });

  it("applies the explicit outer deadline to the actual MCP callTool request", () => {
    const source = readFileSync(new URL("./e2e/mcp-client.ts", import.meta.url), "utf8");
    expect(source).toMatch(
      /client\.callTool\([\s\S]*?timeout: BRIDGE_MCP_REQUEST_MS,[\s\S]*?maxTotalTimeout: BRIDGE_MCP_REQUEST_MS,[\s\S]*?resetTimeoutOnProgress: false/,
    );
  });

});
