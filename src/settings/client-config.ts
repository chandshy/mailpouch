/**
 * Client-configuration paths and MCP entry builders used by the Settings UI.
 *
 * Keeping host-app file layout and transport coercion outside server.ts makes
 * the HTTP router about HTTP rather than platform-specific config mutation.
 */

import os from "os";
import nodePath from "path";
import { defaultConfig, loadConfig } from "../config/loader.js";

/** Resolve Claude Desktop's config path, or null without a Windows user profile. */
export function claudeDesktopConfigPath(): string | null {
  if (process.platform === "win32") {
    const appData = process.env.APPDATA;
    if (!appData) return null;
    return nodePath.join(appData, "Claude", "claude_desktop_config.json");
  }
  if (process.platform === "darwin") {
    return nodePath.join(os.homedir(), "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  return nodePath.join(os.homedir(), ".config", "Claude", "claude_desktop_config.json");
}

/** Claude Code stores MCP server registrations in ~/.claude.json on every OS. */
export function claudeCodeConfigPath(): string {
  return nodePath.join(os.homedir(), ".claude.json");
}

export interface McpClientEntry {
  entry: Record<string, unknown>;
  transport: "stdio" | "http";
  coercedToHttp?: boolean;
  warning?: string;
}

/**
 * Build a host-client registration. A shared daemon cannot coexist with a
 * second stdio process, so remote mode deliberately coerces stdio to HTTP.
 */
export function buildClaudeCodeEntry(moduleDir: string, transport: "stdio" | "http"): McpClientEntry {
  const cn = (loadConfig() ?? defaultConfig()).connection;
  const daemonMode = !!cn?.remoteMode;
  const coercedToHttp = transport === "stdio" && daemonMode;
  const effective = coercedToHttp ? "http" : transport;

  if (effective === "http") {
    const scheme = cn?.remoteTlsCertPath && cn?.remoteTlsKeyPath ? "https" : "http";
    const host = cn?.remoteHost || "127.0.0.1";
    const port = cn?.remotePort ?? 8788;
    const mcpPath = cn?.remotePath || "/mcp";
    const entry = { type: "http", url: `${scheme}://${host}:${port}${mcpPath}` };
    const warning = coercedToHttp
      ? "A shared mailpouch daemon is configured (remoteMode), so the app connects over HTTP — a per-computer (stdio) entry would conflict with the daemon and fail to start."
      : (!cn?.remoteMode || !cn?.remoteOauthEnabled)
        ? "HTTP transport needs the mailpouch daemon running with remoteMode + remoteOauthEnabled. Enable remote mode and start the daemon, then approve the agent in the Agents tab."
        : undefined;
    return { entry, transport: "http", ...(coercedToHttp ? { coercedToHttp } : {}), ...(warning ? { warning } : {}) };
  }

  const distIndexPath = nodePath.resolve(moduleDir, "../index.js");
  return {
    entry: {
      type: "stdio",
      command: "node",
      args: [distIndexPath],
      env: { MAILPOUCH_FORCE_STDIO: "1" },
    },
    transport: "stdio",
  };
}
