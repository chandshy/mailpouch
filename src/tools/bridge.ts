/**
 * Bridge & server control tools: start_bridge, shutdown_server,
 * restart_server.
 */

import { logger } from "../utils/logger.js";
import type { ToolDef, ToolHandler } from "./types.js";

const ACTION_RESULT_SCHEMA = {
  type: "object",
  properties: {
    success: { type: "boolean" },
    messageId: { type: "string" },
    reason: { type: "string" },
  },
  required: ["success"],
};

export const defs: ToolDef[] = [
  {
    name: "start_bridge",
    title: "Start Proton Bridge",
    description: "Launch Proton Mail Bridge if it is not already running. Waits up to 15 s for SMTP/IMAP ports to become reachable before returning.",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    inputSchema: { type: "object", properties: {} },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "shutdown_server",
    title: "Shutdown MCP Server",
    description: "Gracefully shut down the MCP server. Terminates Proton Bridge (regardless of whether this server launched it), disconnects IMAP/SMTP, scrubs credentials from memory, then exits. Requires { confirmed: true }.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "restart_server",
    title: "Restart MCP Server",
    description: "Restart the MCP server. Terminates Proton Bridge, shuts down gracefully, then spawns a fresh server process. If autoStartBridge is enabled the new process will re-launch Bridge automatically. Requires { confirmed: true }.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
];

export const handlers: Record<string, ToolHandler> = {
  start_bridge: async (ctx) => {
    const { ok, config, launchProtonBridge, isBridgeReachable, state } = ctx;
    // The dispatcher may have routed this call with account_id.  Pass that
    // immutable snapshot through to the launcher instead of reading the
    // module-level active-account configuration mid-call.
    await launchProtonBridge(config);
    const [smtpUp, imapUp] = await Promise.all([
      isBridgeReachable(config.smtp.host, config.smtp.port),
      isBridgeReachable(config.imap.host, config.imap.port),
    ]);
    if (smtpUp && imapUp) {
      state.bridgeAutoStarted = true;
      return ok({ success: true }, "Proton Bridge is running and reachable.");
    }
    // TOOL-014: the ports never came up. Flag isError so an agent that only
    // checks result.isError doesn't read this failure as success. The
    // structured `success: false` + reason are still carried for richer
    // consumers that unpack structuredContent.
    return {
      structuredContent: { success: false, reason: "Bridge launch command sent but ports are not yet reachable. Bridge may still be starting." },
      content: [{ type: "text" as const, text: "Bridge launch command sent — ports not yet reachable." }],
      isError: true,
    };
  },

  shutdown_server: async (ctx) => {
    const { ok, killProtonBridge, gracefulShutdown, state } = ctx;
    logger.info("Shutdown requested via MCP tool.", "MCPServer");
    await killProtonBridge();
    state.bridgeAutoStarted = false;
    setImmediate(() => gracefulShutdown("mcp_tool_shutdown"));
    return ok({ success: true }, "Shutdown initiated. MCP server is shutting down.");
  },

  restart_server: async (ctx) => {
    const { ok, killProtonBridge, gracefulShutdown, state } = ctx;
    logger.info("Restart requested via MCP tool.", "MCPServer");
    await killProtonBridge();
    state.bridgeAutoStarted = false;
    // Gracefully shut down — tray destroyed, settings server stopped, memory
    // scrubbed. The MCP client reconnects automatically and spawns a fresh
    // process with a clean tray and settings server.
    setImmediate(() => gracefulShutdown("mcp_tool_restart"));
    return ok({ success: true }, "Restart initiated. The server is shutting down; your client will reconnect automatically.");
  },
};
