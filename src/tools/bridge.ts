/**
 * Bridge & server control tools: start_bridge, shutdown_server,
 * restart_server.
 */

import { spawn } from "child_process";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { logger } from "../utils/logger.js";
import type { ToolDef, ToolHandler, ToolModule } from "./types.js";

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
    description: "Gracefully shut down the MCP server. Terminates Proton Bridge (regardless of whether this server launched it), disconnects IMAP/SMTP, scrubs credentials from memory, then exits.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
  {
    name: "restart_server",
    title: "Restart MCP Server",
    description: "Restart the MCP server. Terminates Proton Bridge, shuts down gracefully, then spawns a fresh server process. If autoStartBridge is enabled the new process will re-launch Bridge automatically.",
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    inputSchema: { type: "object", properties: {} },
    outputSchema: ACTION_RESULT_SCHEMA,
  },
];

export const handlers: Record<string, ToolHandler> = {
  start_bridge: async (ctx) => {
    const { ok, config, launchProtonBridge, isBridgeReachable, state } = ctx;
    await launchProtonBridge();
    const [smtpUp, imapUp] = await Promise.all([
      isBridgeReachable(config.smtp.host, config.smtp.port),
      isBridgeReachable(config.imap.host, config.imap.port),
    ]);
    if (smtpUp && imapUp) {
      state.bridgeAutoStarted = true;
      return ok({ success: true }, "Proton Bridge is running and reachable.");
    }
    return ok(
      { success: false, reason: "Bridge launch command sent but ports are not yet reachable. Bridge may still be starting." },
      "Bridge launch command sent — ports not yet reachable.",
    );
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
    try {
      spawn(process.execPath, process.argv.slice(1), {
        stdio: "ignore",
        detached: true,
        env: { ...process.env, PM_BRIDGE_MCP_RESPAWN: "1" },
      }).unref();
    } catch (spawnErr: unknown) {
      logger.error("Failed to spawn replacement process during restart", "MCPServer", spawnErr);
      throw new McpError(ErrorCode.InternalError, "Restart failed: could not spawn replacement process.");
    }
    setImmediate(() => gracefulShutdown("mcp_tool_restart"));
    return ok({ success: true }, "Restart initiated. A new MCP server process is starting.");
  },
};

const mod: ToolModule = { defs, handlers };
export default mod;
