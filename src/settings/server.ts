/**
 * mailpouch — Settings UI Server
 *
 * Starts a localhost-only HTTP server that serves a browser-based
 * configuration interface.  The UI lets users:
 *   • Set up SMTP / IMAP connection credentials
 *   • Choose a permission preset or configure per-tool access
 *   • Set per-tool rate limits
 *   • Test connectivity
 *   • View server status and the generated Claude Desktop config snippet
 *
 * The config is persisted to ~/.mailpouch.json (mode 0600).
 * The MCP server reads that file every 15 s, so changes take effect
 * without a restart.
 */

import http from "http";
import https from "https";
import os from "os";
import nodePath from "path";
import { fileURLToPath } from "url";
import { readFileSync, writeFileSync, renameSync, existsSync, statSync, openSync, readSync, closeSync, chmodSync } from "fs";
import { spawn, spawnSync } from "child_process";
import { Socket } from "net";
import { randomBytes, timingSafeEqual } from "crypto";
import {
  RateLimiter,
  readBodySafe,
  isValidOrigin,
  isValidChallengeId,
  sanitizeText,
  clientIP,
  generateAccessToken,
  hasValidAccessToken,
  hasValidBootstrapToken,
  tryGenerateSelfSignedCert,
  getPrimaryLanIP,
  GENERAL_RATE_LIMIT,
  ESCALATION_RATE_LIMIT,
  type AccessToken,
  type TlsCredentials,
} from "./security.js";
import {
  loadConfig,
  saveConfig,
  saveConfigWithCredentials,
  getConfigPath,
  defaultConfig,
  buildPermissions,
  configExists,
} from "../config/loader.js";
import { checkConnections } from "./connection-check.js";
import {
  ALL_TOOLS,
  PERMISSION_PRESETS,
  TOOL_CATEGORIES,
  type ServerConfig,
  type PermissionPreset,
  type ToolName,
} from "../config/schema.js";
import {
  getPendingEscalations,
  approveEscalation,
  denyEscalation,
  getAuditLog,
  type EscalationRecord,
  type AuditEntry,
} from "../permissions/escalation.js";
import { getLogFilePath, logger } from "../utils/logger.js";
import { getAgentGrantStore, getAgentAuditLog, getServiceAccountStore } from "../agents/registry.js";
import type { GrantConditions } from "../agents/types.js";
import { notifications as agentNotifications } from "../agents/notifications.js";
import {
  readRegistry,
  createAccount,
  updateAccount,
  deleteAccount,
  setActiveAccount,
} from "../accounts/registry.js";
import { getAccountManager } from "../accounts/manager.js";
import type { AccountSpecShape } from "../config/schema.js";
import { buildShellHtml } from "./shell.js";
import { buildWizardHtml } from "./tabs/wizard.js";
import { buildSetupHtml } from "./tabs/setup.js";
import { buildPermissionsHtml } from "./tabs/permissions.js";
import { buildAccountsHtml } from "./tabs/accounts.js";
import { buildAgentsHtml } from "./tabs/agents.js";
import { buildStatusHtml } from "./tabs/status.js";
import { buildLogsHtml } from "./tabs/logs.js";

// ─── TCP connectivity test ─────────────────────────────────────────────────────

function tcpCheck(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new Socket();
    socket.setTimeout(timeoutMs);
    socket.on("connect", () => { socket.destroy(); resolve(true); });
    socket.on("error", () => resolve(false));
    socket.on("timeout", () => { socket.destroy(); resolve(false); });
    socket.connect(port, host);
  });
}

// ─── REST API helpers ──────────────────────────────────────────────────────────

/**
 * UI-010: resolve the Claude Desktop config path for the current platform.
 * Returns null on Windows when %APPDATA% is unset (a service running without a
 * loaded user profile) — the earlier `process.env.APPDATA ?? ""` fell through
 * to a CWD-relative `Claude\claude_desktop_config.json` that existsSync could
 * match by accident or that a write could clobber.
 */
function claudeDesktopConfigPath(): string | null {
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

/** Claude Code stores its MCP servers in `~/.claude.json` (same on every
 *  platform). */
function claudeCodeConfigPath(): string {
  return nodePath.join(os.homedir(), ".claude.json");
}

/**
 * Build the `mcpServers.mailpouch` entry an MCP host should use for the given
 * transport. http points at the daemon's /mcp endpoint; stdio spawns a local
 * instance (MAILPOUCH_FORCE_STDIO).
 *
 * Daemon-aware: when `remoteMode` is on, a stdio entry would collide with the
 * shared daemon's per-account singleton (the spawn exits → the host shows
 * mailpouch as dead). So a stdio request is **coerced to http** — we never emit
 * a config the user's host can't actually run.
 */
function buildClaudeCodeEntry(transport: "stdio" | "http"): { entry: Record<string, unknown>; transport: "stdio" | "http"; coercedToHttp?: boolean; warning?: string } {
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
  const distIndexPath = nodePath.resolve(_moduleDir, "../index.js");
  const entry = {
    type: "stdio",
    command: "node",
    args: [distIndexPath],
    env: { MAILPOUCH_FORCE_STDIO: "1" },
  };
  return { entry, transport: "stdio" };
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type":           "application/json",
    "Content-Length":         Buffer.byteLength(payload),
    "Cache-Control":          "no-store, no-cache, must-revalidate",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options":        "DENY",
    "Referrer-Policy":        "no-referrer",
  });
  res.end(payload);
}

/** Strip password fields before sending config to the browser */
function safeConfig(cfg: ServerConfig): unknown {
  const hasPassword  = !!(cfg.connection.password || cfg.connection.passwordEncrypted);
  const hasSmtpToken = !!(cfg.connection.smtpToken || cfg.connection.smtpTokenEncrypted);
  const hasSlApiKey  = !!cfg.connection.simpleloginApiKey;
  const hasPassToken = !!cfg.connection.passAccessToken;
  return {
    ...cfg,
    credentialStorage: cfg.credentialStorage ?? "config",
    connection: {
      ...cfg.connection,
      password:          hasPassword  ? "••••••••" : "",
      smtpToken:         hasSmtpToken ? "••••••••" : "",
      simpleloginApiKey: hasSlApiKey  ? "••••••••" : "",
      passAccessToken:   hasPassToken ? "••••••••" : "",
      // Never send encrypted blobs to the browser
      passwordEncrypted:  undefined,
      smtpTokenEncrypted: undefined,
    },
  };
}

// ─── Module-relative path to package.json ─────────────────────────────────────
// Compiled output is dist/settings/server.js; package.json is two levels up.
const _moduleDir = nodePath.dirname(fileURLToPath(import.meta.url));
const _pkgJsonPath = nodePath.resolve(_moduleDir, "../../package.json");

// ─── HTTP Server ───────────────────────────────────────────────────────────────

export interface ServerSecurityOptions {
  /** Port the server will listen on (needed for Origin validation). */
  port:        number;
  /** True when binding to 0.0.0.0 (LAN mode). */
  lan:         boolean;
  /** Access token required for every request in LAN mode. */
  accessToken: AccessToken | null;
  /**
   * Actual URI scheme the server is reachable on.
   * "https" when a self-signed cert was successfully generated; "http" otherwise.
   * Passed to isValidOrigin so browsers in TLS mode are accepted.
   */
  scheme:      "http" | "https";
  /**
   * Called after a successful `npm install -g` update. The caller is
   * responsible for tearing down the tray, stopping services, and
   * restarting the process. When omitted the browser is told to restart
   * manually instead of auto-reloading.
   */
  onRestartRequested?: () => void;
  /**
   * Called when the UI requests a full shutdown via POST /api/shutdown.
   * The caller is responsible for graceful teardown (tray destroy, service
   * disconnect, then process exit). When omitted the server falls back to
   * `process.exit(0)`, which bypasses tray cleanup.
   */
  onShutdownRequested?: () => void;
  /**
   * Live status snapshot for GET /api/status. Lets `mailpouch status` (and any
   * tooling) read the running instance's authoritative connection + agent state
   * — something an offline probe can't determine. When omitted, /api/status
   * returns just `{ hasConfig }` (the back-compat singleton-probe shape).
   */
  onStatus?: () => { connected: boolean; account: string; pendingCount: number; activeCount: number };
}

// ── /agent-setup — integration reference for AI clients ─────────────────
// Rendered both as HTML (browser-readable) and JSON (machine-readable at
// /agent-setup.json or via Accept: application/json). The content is a
// minimal, copy-paste-ready summary: what this server is, how to launch
// it, and the exact client-config JSON an agent needs.

const _agentSetupPkgVersion = (() => {
  try {
    const dir = nodePath.dirname(fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(nodePath.resolve(dir, "../../package.json"), "utf-8")) as { version: string }).version;
  } catch { return "unknown"; }
})();

function buildAgentSetupJson(settingsPort = 8766) {
  return {
    product: "mailpouch",
    version: _agentSetupPkgVersion,
    summary:
      "An MCP server that exposes a user's Proton Mail inbox (via Proton Bridge) to AI agents as typed, permission-gated, audit-logged tools.",
    protocol: {
      name: "Model Context Protocol",
      version: "2025-06-18",
      transports: ["stdio", "http"],
      docs: "https://modelcontextprotocol.io",
      specsRepo: "https://github.com/modelcontextprotocol",
    },
    binary: {
      command: "mailpouch",
      installNote:
        "Install with `npm install -g <tarball-or-github-url>` so the `mailpouch` command is on PATH. The MCP client either spawns this binary as a subprocess (stdio transport) or POSTs JSON-RPC to its HTTP endpoint (http transport).",
      supportedEnvVars: {
        MAILPOUCH_TIER: "core | extended | complete — selects which tools are surfaced via tools/list. Default: complete.",
        MAILPOUCH_CONFIG: "Override the config file path (default ~/.mailpouch.json with legacy-path fallback).",
      },
    },
    quickstart: [
      "Step 1 — Check that the `mailpouch` binary is on PATH (the operator installs it).",
      "Step 2 — Configure your MCP client to spawn it over stdio OR connect to its HTTP endpoint.",
      "Step 3 — Send `initialize` → wait for `serverInfo` → send `notifications/initialized`.",
      "Step 4 — Send `tools/list` to discover the currently-exposed tool surface. Never assume the full 69-tool list is available — operator may have tiered it down or restricted it via per-agent grants.",
    ],
    transports: {
      stdio: {
        when: "Preferred for single-user / local / desktop clients that can spawn child processes (Claude Desktop, Claude Code, Cline, Continue.dev, mcp-inspector, SDK-based Python/TypeScript clients).",
        how: "Spawn `mailpouch` as a subprocess. Send JSON-RPC messages as newline-terminated JSON on the child's stdin; read responses from its stdout. One message per line. Log output goes to stderr (ignore or capture separately).",
        auth: "None required — the client trusts the binary because it spawned it. The binary reads its configuration (Bridge credentials, account list) from the operator's config file.",
      },
      http: {
        when: "Use when the client cannot spawn subprocesses (a web-based agent, a remote agent across machines, a multi-agent orchestrator). Operator must opt in by setting remoteMode=true in the mailpouch config.",
        endpoint: "POST http://<host>:<port>/mcp  — default port 8788, path /mcp. Exact URL is printed to the operator's terminal on startup.",
        contentType: "application/json",
        framing: "Standard JSON-RPC 2.0 over HTTP. One request body = one JSON-RPC message. The server uses the StreamableHTTPServerTransport from the MCP SDK.",
        auth: {
          modes: [
            "oauth-2.1 authorization_code — interactive agents (per-agent Approve/Deny)",
            "oauth-2.1 client_credentials — headless agents (pre-approved service accounts)",
          ],
          summary: "Every HTTP client authenticates as its OWN OAuth client. There is no shared bearer token — a token always resolves to a specific, gated, revocable agent identity.",
          oauth21: {
            when: "Interactive agents: RFC 7591 DCR + RFC 8414/9728 metadata + PKCE S256 + RFC 8707 resource indicators. Consent is automatic; the only human gate is Approve/Deny in the Agents tab (no admin password).",
            flow: [
              "1. GET /.well-known/oauth-authorization-server → discover /register, /authorize, /token URLs.",
              "2. POST /register with your { redirect_uris, client_name } → get back { client_id }.",
              "3. Open /authorize?response_type=code&client_id=…&code_challenge=…&code_challenge_method=S256&resource=http://<host>:<port>/mcp&redirect_uri=… → auth code is issued automatically (302 back to redirect_uri).",
              "4. POST /token { grant_type=authorization_code, code, code_verifier, client_id, redirect_uri, resource=http://<host>:<port>/mcp } → access_token (24h TTL).",
              "5. The operator Approves the agent in the Agents tab. Until then every tool call is denied (token is valid but inert).",
              "6. Send MCP requests with Authorization: Bearer <access_token>. The server validates the `resource` binding on every call.",
            ],
          },
          clientCredentials: {
            when: "Headless / unattended agents (cron, CI, scheduled) that cannot do interactive consent. The operator issues a service account out-of-band — `mailpouch agent issue --name <n> --preset <preset>` or the Agents tab — which prints a client_id + client_secret and pre-approves its grant.",
            flow: [
              "1. POST /token with Authorization: Basic base64(client_id:client_secret) and form body grant_type=client_credentials (or send client_id & client_secret as form fields).",
              "2. → access_token (24h TTL). No PKCE, no interactive consent — the service account was approved at issuance.",
              "3. Send MCP requests with Authorization: Bearer <access_token>. The grant's preset/conditions gate every call exactly like an interactively-approved agent.",
            ],
          },
        },
        rateLimits: "Per-caller token-bucket: 20 req/s sustained, 40 burst for unauthenticated IPs; 60/120 for authenticated tokens. 429 on exhaustion.",
      },
    },
    clientConfig: {
      claudeDesktop: {
        path: "~/Library/Application Support/Claude/claude_desktop_config.json  (macOS)\n%APPDATA%\\Claude\\claude_desktop_config.json  (Windows)\n~/.config/Claude/claude_desktop_config.json  (Linux)",
        snippet: {
          mcpServers: { mailpouch: { command: "mailpouch" } },
        },
      },
      claudeCode: {
        path: "Project-level: .mcp.json in the repo root, or ~/.claude.json for user-scoped. The Settings UI / wizard can write this for you (Connect a client → Write to Claude Code).",
        snippet: {
          // stdio: forces stdio even when the server config has remoteMode:true.
          mcpServers: { mailpouch: { type: "stdio", command: "mailpouch", env: { MAILPOUCH_FORCE_STDIO: "1" } } },
        },
        snippetHttp: {
          // http: connect to the shared daemon (needs remoteMode + remoteOauthEnabled + a running daemon; Claude Code handles OAuth, then Approve in the Agents tab).
          mcpServers: { mailpouch: { type: "http", url: "http://127.0.0.1:8788/mcp" } },
        },
      },
      cline: {
        path: "VSCode extension settings → Cline → MCP Servers, or directly edit cline_mcp_settings.json",
        snippet: {
          mcpServers: { mailpouch: { command: "mailpouch" } },
        },
      },
      continueDev: {
        path: "~/.continue/config.json",
        snippet: {
          experimental: {
            modelContextProtocolServers: [
              { transport: { type: "stdio", command: "mailpouch" } },
            ],
          },
        },
      },
      mcpInspector: {
        how: "npx @modelcontextprotocol/inspector mailpouch — useful for testing tool discovery + invocation without wiring a full client.",
      },
      customSdk: {
        python: "from mcp import StdioServerParameters, stdio_client\nparams = StdioServerParameters(command='mailpouch')\nasync with stdio_client(params) as (read, write): ...",
        typescript: "import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'\nconst transport = new StdioClientTransport({ command: 'mailpouch' })\nawait client.connect(transport)",
      },
      rawJsonRpc: {
        when: "No SDK? No wrapper client? Just a bare agent with a JSON-RPC capability? This is the minimum handshake.",
        example: [
          "// 1. Send this on stdin (or POST to /mcp):",
          '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"my-agent","version":"1.0"}}}',
          "// 2. Read response from stdout — expect {\"result\":{\"serverInfo\":{\"name\":\"mailpouch\",…}}}",
          "// 3. Send initialized notification (no response expected):",
          '{"jsonrpc":"2.0","method":"notifications/initialized"}',
          "// 4. Discover tools:",
          '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}',
          "// 5. Call one:",
          '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"get_unread_count","arguments":{}}}',
        ],
      },
    },
    capabilities: {
      toolCount: ALL_TOOLS.length,
      categories: Object.keys(TOOL_CATEGORIES),
      tiers: ["core", "extended", "complete"],
      defaultTier: "complete",
      resources: { supported: true, description: "Server exposes resources describing mail-account state (read-only URIs)." },
      prompts: { supported: true, description: "Pre-canned prompts like draft_in_my_voice, triage_inbox, compose_reply — consult prompts/list." },
      elicitation: { supported: true, description: "Server may request user confirmation mid-call for destructive operations. Clients that don't support elicitation fall back to { confirmed: true } on the call args." },
      destructiveConfirmation:
        "Destructive tools (delete_email, bulk_delete, move_to_trash, move_to_spam, alias_delete, pass_get) require an MCP elicitation round-trip OR an explicit { confirmed: true } argument on the call.",
    },
    accountRouting: {
      description: "A single server can host multiple mail accounts. Pass account_id on any tool call to route to a specific account; omit it to use the currently-active one.",
      discovery: "The list of configured accounts is not exposed as a tool (operator's decision for privacy). Ask the user to set the default in the settings UI, or pass account_id on every call.",
    },
    firstCallAdvice:
      "Before invoking tools, call tools/list to discover the currently-exposed surface. Default tier is `complete` (70 tools) but operators can restrict to `core` (~20 tools) or `extended` (~50) via MAILPOUCH_TIER. Per-agent grants can further narrow the surface or impose folder allowlists / IP pins / rate limits. If a tool you expected is missing, ask the user to adjust the grant — don't assume it's a bug.",
    humanControls: {
      settingsUi: `http://localhost:${settingsPort}`,
      description: "The operator uses this UI to approve your agent, set conditions (expiry, folder allowlist, IP pins, per-tool rate limits, account scope), and revoke access. Every tool call you make is audit-logged (hashed-args, never values). Your audit trail is visible to them.",
    },
  };
}

function buildAgentSetupHtml(settingsPort = 8766): string {
  const data = buildAgentSetupJson(settingsPort);
  const jsonPretty = JSON.stringify(data, null, 2);
  const clients = data.clientConfig;
  const snip = (o: unknown) => escapeHtml(JSON.stringify(o, null, 2));
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<meta name="audience" content="ai-agent,llm,mcp-client">
<title>mailpouch — Agent Integration Reference</title>
<style>
* { box-sizing: border-box; margin: 0; padding: 0; }
body {
  font: 14px/1.55 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: #0f0e1a; color: #e8e6f8; padding: 32px 24px; max-width: 900px; margin: 0 auto;
}
h1 { font-size: 20px; color: #c4c0e0; margin-bottom: 6px; font-family: system-ui, sans-serif; }
h2 { font-size: 14px; color: #6d4aff; margin: 28px 0 8px; font-family: system-ui, sans-serif; text-transform: uppercase; letter-spacing: .04em; }
h3 { font-size: 13px; color: #c4c0e0; margin: 16px 0 6px; font-family: system-ui, sans-serif; }
p  { color: #c4c0e0; margin-bottom: 10px; font-family: system-ui, sans-serif; font-size: 14px; }
ol, ul { color: #c4c0e0; font-family: system-ui, sans-serif; font-size: 14px; margin: 0 0 12px 20px; }
li { margin-bottom: 4px; }
.lede { color: #e8e6f8; font-size: 15px; margin-bottom: 4px; }
pre {
  background: #1a1830; border: 1px solid #302e50; border-radius: 8px;
  padding: 12px 14px; overflow-x: auto; font-size: 12.5px; color: #e8e6f8;
  margin-bottom: 8px;
}
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: #e8e6f8; background: #22203a; padding: 1px 5px; border-radius: 3px; }
a { color: #6d4aff; }
.pill {
  display: inline-block; font-size: 11px; padding: 2px 8px; border-radius: 999px;
  background: #22203a; border: 1px solid #403d68; color: #c4c0e0; font-family: system-ui, sans-serif;
}
.card {
  background: rgba(26,24,48,.5); border: 1px solid #302e50; border-radius: 10px;
  padding: 14px 16px; margin-bottom: 12px;
}
.card h3 { margin-top: 0; color: #6d4aff; }
.note { font-family: system-ui, sans-serif; font-size: 13px; color: #7c78a8; margin-bottom: 6px; }
footer { color: #7c78a8; margin-top: 36px; font-size: 12px; font-family: system-ui, sans-serif; }
</style>
</head>
<body>

<h1>mailpouch — Agent Integration Reference</h1>
<p class="lede">A single-page, copy-paste-ready guide for connecting any MCP client (not just Claude) to mailpouch. Humans share this URL with their agent.</p>
<p><span class="pill">For AI agents</span> <span class="pill">noindex</span> <span class="pill">HTML + JSON</span> <span class="pill">v${escapeHtml(data.version)}</span></p>

<h2>What this is</h2>
<p>${escapeHtml(data.summary)}</p>
<p>Protocol: <strong>${escapeHtml(data.protocol.name)}</strong> (spec version <code>${escapeHtml(data.protocol.version)}</code>) — <a href="${escapeHtml(data.protocol.docs)}">${escapeHtml(data.protocol.docs)}</a>. Transports: <code>${escapeHtml(data.protocol.transports.join(", "))}</code>.</p>

<h2>4-step quickstart</h2>
<ol>
${data.quickstart.map(s => `  <li>${escapeHtml(s)}</li>`).join("\n")}
</ol>

<h2>Transport: stdio (most common)</h2>
<p class="note">${escapeHtml(data.transports.stdio.when)}</p>
<p><strong>How:</strong> ${escapeHtml(data.transports.stdio.how)}</p>
<p><strong>Auth:</strong> ${escapeHtml(data.transports.stdio.auth)}</p>

<h2>Transport: http (remote / multi-client)</h2>
<p class="note">${escapeHtml(data.transports.http.when)}</p>
<p><strong>Endpoint:</strong> <code>${escapeHtml(data.transports.http.endpoint)}</code></p>
<p><strong>Content-Type:</strong> <code>${escapeHtml(data.transports.http.contentType)}</code> · <strong>Framing:</strong> ${escapeHtml(data.transports.http.framing)}</p>

<p class="note">${escapeHtml(data.transports.http.auth.summary)}</p>

<h3>Auth: OAuth 2.1 — authorization_code (interactive agents)</h3>
<p>${escapeHtml(data.transports.http.auth.oauth21.when)}</p>
<ol>
${data.transports.http.auth.oauth21.flow.map(s => `  <li>${escapeHtml(s)}</li>`).join("\n")}
</ol>

<h3>Auth: OAuth 2.1 — client_credentials (headless / service accounts)</h3>
<p>${escapeHtml(data.transports.http.auth.clientCredentials.when)}</p>
<ol>
${data.transports.http.auth.clientCredentials.flow.map(s => `  <li>${escapeHtml(s)}</li>`).join("\n")}
</ol>
<p><strong>Rate limits:</strong> ${escapeHtml(data.transports.http.rateLimits)}</p>

<h2>Client config — pick your client</h2>

<div class="card">
  <h3>Claude Desktop</h3>
  <p class="note">Config path: <code>${escapeHtml(clients.claudeDesktop.path)}</code></p>
  <pre>${snip(clients.claudeDesktop.snippet)}</pre>
</div>

<div class="card">
  <h3>Claude Code (CLI)</h3>
  <p class="note">Config path: <code>${escapeHtml(clients.claudeCode.path)}</code></p>
  <pre>${snip(clients.claudeCode.snippet)}</pre>
</div>

<div class="card">
  <h3>Cline (VSCode extension)</h3>
  <p class="note">${escapeHtml(clients.cline.path)}</p>
  <pre>${snip(clients.cline.snippet)}</pre>
</div>

<div class="card">
  <h3>Continue.dev</h3>
  <p class="note">Config path: <code>${escapeHtml(clients.continueDev.path)}</code></p>
  <pre>${snip(clients.continueDev.snippet)}</pre>
</div>

<div class="card">
  <h3>mcp-inspector (dev tool)</h3>
  <p class="note">${escapeHtml(clients.mcpInspector.how)}</p>
</div>

<div class="card">
  <h3>Custom SDK client — Python</h3>
  <pre>${escapeHtml(clients.customSdk.python)}</pre>
</div>

<div class="card">
  <h3>Custom SDK client — TypeScript</h3>
  <pre>${escapeHtml(clients.customSdk.typescript)}</pre>
</div>

<div class="card">
  <h3>Raw JSON-RPC (no SDK, no wrapper)</h3>
  <p class="note">${escapeHtml(clients.rawJsonRpc.when)}</p>
  <pre>${clients.rawJsonRpc.example.map(escapeHtml).join("\n")}</pre>
</div>

<h2>Capabilities</h2>
<pre>toolCount:   ${escapeHtml(String(data.capabilities.toolCount))}
categories:  ${escapeHtml(data.capabilities.categories.join(", "))}
tiers:       ${escapeHtml(data.capabilities.tiers.join(" < "))}   (default: ${escapeHtml(data.capabilities.defaultTier)})
resources:   ${data.capabilities.resources.supported}    — ${escapeHtml(data.capabilities.resources.description)}
prompts:     ${data.capabilities.prompts.supported}    — ${escapeHtml(data.capabilities.prompts.description)}
elicitation: ${data.capabilities.elicitation.supported}    — ${escapeHtml(data.capabilities.elicitation.description)}</pre>

<h2>Destructive operations</h2>
<p>${escapeHtml(data.capabilities.destructiveConfirmation)}</p>

<h2>Multi-account routing</h2>
<p>${escapeHtml(data.accountRouting.description)}</p>
<p>${escapeHtml(data.accountRouting.discovery)}</p>

<h2>First-call advice</h2>
<p>${escapeHtml(data.firstCallAdvice)}</p>

<h2>Operator control surface</h2>
<p>The human running this server sees you in their <a href="${escapeHtml(data.humanControls.settingsUi)}">settings UI</a>. ${escapeHtml(data.humanControls.description)}</p>

<h2>Machine-readable payload</h2>
<p>Same data as JSON: <a href="/agent-setup.json"><code>/agent-setup.json</code></a>, or send <code>Accept: application/json</code> to this URL.</p>
<pre>${escapeHtml(jsonPretty)}</pre>

<footer>
mailpouch v${escapeHtml(data.version)} · served from the local settings server · noindex · not internet-indexed
</footer>

</body>
</html>`;
}

function escapeHtml(s: string): string {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function createSettingsServer(secOpts: ServerSecurityOptions): http.Server {
  const { port, lan, accessToken, scheme } = secOpts;
  const configPath = getConfigPath();

  // ── Per-instance security objects ────────────────────────────────────────
  // CSRF: 32-byte random token embedded in HTML, required on all mutations.
  const csrfToken = randomBytes(32).toString("hex");

  // Rate limiters — keyed by client IP
  const generalLimiter    = new RateLimiter(GENERAL_RATE_LIMIT,    60_000); // 120/min
  const escalationLimiter = new RateLimiter(ESCALATION_RATE_LIMIT, 60_000); // 20/min

  function requireCsrf(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    const provided = req.headers["x-csrf-token"];
    // Use constant-time comparison to prevent timing-based brute-force of the
    // CSRF token.  `timingSafeEqual` requires equal-length buffers; a length
    // mismatch is itself a definitive rejection and reveals no secret bits.
    const valid =
      typeof provided === "string" &&
      provided.length === csrfToken.length &&
      timingSafeEqual(Buffer.from(provided, "utf8"), Buffer.from(csrfToken, "utf8"));
    if (valid) return true;
    // Human-legible message. Stable `code` field drives the client-side
    // auto-reload interceptor (see CSRF_SESSION_EXPIRED_CODE / fetch wrapper
    // in the inline page JS) — when the server restarts, the browser's cached
    // token goes stale and every mutation 403's; we catch that and silently
    // reload so the user sees "page refreshed" rather than
    // "Missing or invalid CSRF token".
    json(res, 403, {
      error: "Your settings session expired. Reload the page to continue.",
      code: "session_expired",
    });
    return false;
  }

  function requireOrigin(req: http.IncomingMessage, res: http.ServerResponse): boolean {
    if (isValidOrigin(req, port, lan, scheme)) return true;
    json(res, 403, { error: "Origin not permitted." });
    return false;
  }

  // ── Request handler ───────────────────────────────────────────────────────
  const handler: http.RequestListener = async (req, res) => {
    const url    = new URL(req.url ?? "/", `http://localhost`);
    const path   = url.pathname;
    const method = req.method ?? "GET";
    const ip     = clientIP(req);

    // ── Security headers ────────────────────────────────────────────────────
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Frame-Options",        "DENY");
    res.setHeader("Referrer-Policy",        "no-referrer");
    res.setHeader("Cache-Control",          "no-store");
    // Never use ACAO: * — a wildcard allows any page on the network to make
    // credentialed cross-origin requests and read the responses, defeating the
    // origin-check and access-token gates in LAN mode.  Instead reflect the
    // request Origin only if it passes the isValidOrigin() check; otherwise
    // fall back to the expected localhost origin so the CORS policy stays tight.
    {
      const reqOrigin = req.headers["origin"] as string | undefined;
      const allowedOrigin =
        reqOrigin && isValidOrigin(req, port, lan, scheme)
          ? reqOrigin
          : `${scheme}://localhost:${port}`;
      res.setHeader("Access-Control-Allow-Origin", allowedOrigin);
      // Vary: Origin so caches do not serve the wrong ACAO value to other origins.
      res.setHeader("Vary", "Origin");
    }
    res.setHeader("Strict-Transport-Security",    "max-age=31536000; includeSubDomains; preload");

    // ── CORS preflight ──────────────────────────────────────────────────────
    if (method === "OPTIONS") {
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-CSRF-Token, X-Access-Token");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      res.writeHead(204); res.end();
      return;
    }

    // ── LAN access token ────────────────────────────────────────────────────
    // In LAN mode every request must carry the access token so that other
    // devices on the network cannot read config or approve escalations.
    if (lan && accessToken && path !== "/") {
      if (!hasValidAccessToken(req, url, accessToken)) {
        json(res, 401, { error: "Access denied. Include the X-Access-Token header." });
        return;
      }
    }

    // ── General rate limiting ───────────────────────────────────────────────
    if (!generalLimiter.check(ip)) {
      json(res, 429, { error: "Too many requests. Please slow down." });
      return;
    }

    try {
      // ── Serve UI ────────────────────────────────────────────────────────
      if (method === "GET" && path === "/") {
        // UI-014: in LAN mode the shell HTML embeds the per-process CSRF token,
        // so "/" must be token-gated too. The general gate above skips "/"
        // (browser navigation can't send the X-Access-Token header), so accept
        // the bootstrap `?token=` here instead. Without this any LAN device
        // could GET "/" and read the CSRF token.
        if (lan && accessToken && !hasValidBootstrapToken(req, url, accessToken)) {
          json(res, 401, { error: "Access denied. Open the URL with ?token=… from the server console." });
          return;
        }
        // Per-response CSP nonce. Lets us drop 'unsafe-inline' for script
        // and style: only the three inline blocks we ship can execute,
        // because they carry the matching nonce attribute. Stops stored XSS
        // from any future bug that reflects config into the page.
        const cspNonce = randomBytes(16).toString("base64");
        const html = buildShellHtml(configPath, csrfToken, port, cspNonce);
        res.writeHead(200, {
          "Content-Type":             "text/html; charset=utf-8",
          // CSP3 behaviour note:
          // - script-src: nonce gates <script> block execution. When ANY nonce
          //   appears in script-src, CSP3 completely ignores 'unsafe-inline' for
          //   ALL inline scripts — including onclick/oninput/onchange event handlers.
          //   All event wiring therefore uses data-action/data-tab/data-change/
          //   data-input/data-submit attributes dispatched by delegated listeners
          //   inside the nonce-protected <script> block. 'unsafe-inline' is
          //   omitted entirely: there are no remaining inline handlers, and CSP1/2
          //   browsers (which honour the keyword) gain nothing from it here.
          // - style-src: NO nonce here. When a nonce is present in style-src,
          //   CSP3 browsers completely ignore 'unsafe-inline', blocking all
          //   element.style.* JS assignments and style="" HTML attributes.
          //   Keeping style-src nonce-free lets 'unsafe-inline' take effect,
          //   which is necessary for every show/hide operation in the UI.
          "Content-Security-Policy":  `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'nonce-${cspNonce}'`,
          "X-Content-Type-Options":   "nosniff",
          "X-Frame-Options":          "DENY",
          "Referrer-Policy":          "no-referrer",
          "Cache-Control":            "no-store, no-cache, must-revalidate",
        });
        res.end(html);
        return;
      }

      // ── GET /api/tab/:name — lazy tab HTML ───────────────────────────────
      if (method === "GET" && path.startsWith("/api/tab/")) {
        const tabName = path.slice("/api/tab/".length);
        // Allowlist-only lookup — rejects traversal, prototype keys, and unknown names.
        const VALID_TABS = new Set(["wizard","setup","permissions","accounts","agents","status","logs"]);
        if (!VALID_TABS.has(tabName)) { json(res, 404, { error: "Unknown tab" }); return; }
        const escHtml = (s: string): string => s
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
        const certBrowsePlaceholder = nodePath.join(os.homedir(), "Downloads", "cert.pem");
        const certInternalPath =
          process.platform === "win32"  ? "%APPDATA%\\protonmail\\bridge-v3\\cert.pem" :
          process.platform === "darwin" ? "~/Library/Application Support/protonmail/bridge-v3/cert.pem" :
                                          "~/.config/protonmail/bridge-v3/cert.pem";
        const certBrowsePlaceholderAttr = escHtml(certBrowsePlaceholder);
        const certInternalPathAttr = escHtml(certInternalPath);
        const certPlatformHint = `Default export location: <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">${certBrowsePlaceholderAttr}</code>. In-place Bridge cert: <code style="background:var(--surface3);padding:1px 5px;border-radius:3px;font-size:11px">${certInternalPathAttr}</code>`;
        const safeConfigPath = escHtml(configPath);
        const tabBuilders: Record<string, () => string> = {
          wizard:      () => buildWizardHtml({ certBrowsePlaceholderAttr, certPlatformHint }),
          setup:       () => buildSetupHtml({ safeConfigPath, certBrowsePlaceholderAttr, certPlatformHint, runningPort: port }),
          permissions: () => buildPermissionsHtml(),
          accounts:    () => buildAccountsHtml({ certBrowsePlaceholderAttr }),
          agents:      () => buildAgentsHtml(),
          status:      () => buildStatusHtml({ safeConfigPath, runningPort: port }),
          logs:        () => buildLogsHtml(),
        };
        json(res, 200, { html: tabBuilders[tabName]() });
        return;
      }

      // ── GET /agent-setup ──────────────────────────────────────────────────
      // Structured integration reference intended for AI agents. Humans can
      // share this URL with their agent as a single-page, copy-paste-ready
      // "how to connect to this MCP" brief. Also served as JSON at
      // /agent-setup.json for programmatic consumers.
      if (method === "GET" && (path === "/agent-setup" || path === "/agent-setup.json")) {
        const wantsJson = path === "/agent-setup.json"
          || String(req.headers["accept"] ?? "").includes("application/json");
        if (wantsJson) {
          res.writeHead(200, {
            "Content-Type":           "application/json; charset=utf-8",
            "X-Content-Type-Options": "nosniff",
            "Cache-Control":          "no-store, no-cache",
          });
          res.end(JSON.stringify(buildAgentSetupJson(port), null, 2));
        } else {
          res.writeHead(200, {
            "Content-Type":             "text/html; charset=utf-8",
            // No <script> tags on this page, so script-src is locked to 'self'
            // (effectively none). style-src keeps 'unsafe-inline' for the single
            // inline <style> block; all ${data.*} interpolations are escapeHtml'd.
            "Content-Security-Policy":  "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'",
            "X-Content-Type-Options":   "nosniff",
            "X-Frame-Options":          "DENY",
            "Referrer-Policy":          "no-referrer",
            "Cache-Control":            "no-store, no-cache, must-revalidate",
          });
          res.end(buildAgentSetupHtml(port));
        }
        return;
      }

      // ── GET /api/status ───────────────────────────────────────────────────
      // `hasConfig` is the load-bearing field the singleton probe checks
      // (src/index.ts) — keep it. The rest is the live snapshot `mailpouch
      // status` surfaces; present only when the running instance supplied a
      // status provider.
      if (method === "GET" && path === "/api/status") {
        const live = secOpts.onStatus?.();
        json(res, 200, {
          hasConfig: configExists(),
          version: _agentSetupPkgVersion,
          ...(live ?? {}),
        });
        return;
      }

      // ── GET /api/config ───────────────────────────────────────────────────
      if (method === "GET" && path === "/api/config") {
        const cfg = loadConfig() ?? defaultConfig();
        json(res, 200, safeConfig(cfg));
        return;
      }

      // ── POST /api/config ──────────────────────────────────────────────────
      if (method === "POST" && path === "/api/config") {
        if (!requireCsrf(req, res)) return;
        let body: Record<string, unknown>;
        try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }
        const current = loadConfig() ?? defaultConfig();

        // Merge connection settings — never overwrite password with placeholder/empty
        if (body.connection && typeof body.connection === "object") {
          const c = body.connection as Record<string, unknown>;

          // Validate port values: must be integers in 1–65535.
          // Reject rather than silently clamp so the user sees an error.
          const validPort = (v: unknown): v is number =>
            typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
          if (c.smtpPort !== undefined && c.smtpPort !== null && !validPort(c.smtpPort)) {
            json(res, 400, { error: `Invalid smtpPort: must be an integer between 1 and 65535.` }); return;
          }
          if (c.imapPort !== undefined && c.imapPort !== null && !validPort(c.imapPort)) {
            json(res, 400, { error: `Invalid imapPort: must be an integer between 1 and 65535.` }); return;
          }

          // Validate hostnames: must be non-empty strings, max 253 chars, no control
          // characters, no whitespace.  This prevents log injection and CRLF smuggling
          // via a crafted hostname stored in the config file.
          const validHost = (h: unknown): h is string =>
            typeof h === "string" && h.length > 0 && h.length <= 253 &&
            !/[\x00-\x1f\x7f\s]/.test(h);
          if (c.smtpHost !== undefined && c.smtpHost !== null && !validHost(c.smtpHost)) {
            json(res, 400, { error: "Invalid smtpHost: must be a non-empty string with no control characters (max 253 chars)." }); return;
          }
          if (c.imapHost !== undefined && c.imapHost !== null && !validHost(c.imapHost)) {
            json(res, 400, { error: "Invalid imapHost: must be a non-empty string with no control characters (max 253 chars)." }); return;
          }
          const validUrl = (u: unknown): boolean => {
            if (typeof u !== "string") return false;
            if (u.trim() === "") return true;
            try { const p = new URL(u.trim()); return p.protocol === "http:" || p.protocol === "https:"; } catch { return false; }
          };
          if (c.simpleloginBaseUrl !== undefined && !validUrl(c.simpleloginBaseUrl)) {
            json(res, 400, { error: "Invalid simpleloginBaseUrl: must be an http:// or https:// URL, or empty." }); return;
          }
          // For binary paths (bridgePath / passCliPath): if a non-empty value
          // is provided, normalise + require it points to an existing regular
          // file. We deliberately do NOT enforce a directory allowlist (the
          // operator may have a custom build location), but we refuse strings
          // that don't resolve to a real file — silently saving garbage paths
          // makes later spawn() failures opaque to the user.
          const validBinaryPath = (raw: string): string | null => {
            const cleaned = raw.trim().replace(/^["']|["']$/g, "");
            if (cleaned === "") return ""; // explicit clear
            const resolved = nodePath.resolve(cleaned);
            if (!existsSync(resolved)) return null;
            try { if (!statSync(resolved).isFile()) return null; } catch { return null; }
            return resolved;
          };
          if (typeof c.bridgePath === "string" && c.bridgePath.trim() !== "") {
            const v = validBinaryPath(c.bridgePath);
            if (v === null) { json(res, 400, { error: "Invalid bridgePath: not an existing regular file." }); return; }
            c.bridgePath = v;
          }
          if (typeof c.passCliPath === "string" && c.passCliPath.trim() !== "") {
            const v = validBinaryPath(c.passCliPath);
            if (v === null) { json(res, 400, { error: "Invalid passCliPath: not an existing regular file." }); return; }
            c.passCliPath = v;
          }

          current.connection = {
            ...current.connection,
            smtpHost:       validHost(c.smtpHost) ? c.smtpHost : current.connection.smtpHost,
            smtpPort:       c.smtpPort       ?? current.connection.smtpPort,
            imapHost:       validHost(c.imapHost) ? c.imapHost : current.connection.imapHost,
            imapPort:       c.imapPort       ?? current.connection.imapPort,
            username:       typeof c.username === "string" ? c.username : current.connection.username,
            bridgeCertPath:  typeof c.bridgeCertPath === "string" ? c.bridgeCertPath : current.connection.bridgeCertPath,
            bridgePath:      typeof c.bridgePath === "string" ? c.bridgePath.trim().replace(/^["']|["']$/g, "") : current.connection.bridgePath,
            debug:           typeof c.debug === "boolean" ? c.debug : current.connection.debug,
            autoStartBridge: typeof c.autoStartBridge === "boolean" ? c.autoStartBridge : current.connection.autoStartBridge,
            allowInsecureBridge: typeof c.allowInsecureBridge === "boolean" ? c.allowInsecureBridge : current.connection.allowInsecureBridge,
            // Optional integrations: placeholder ("••••••••") = keep existing; any other string (incl. "") = set (empty clears)
            ...(typeof c.simpleloginApiKey === "string" && c.simpleloginApiKey !== "••••••••" ? { simpleloginApiKey: c.simpleloginApiKey.trim() || undefined } : {}),
            simpleloginBaseUrl: typeof c.simpleloginBaseUrl === "string" ? c.simpleloginBaseUrl.trim() : current.connection.simpleloginBaseUrl,
            ...(typeof c.passAccessToken === "string" && c.passAccessToken !== "••••••••" ? { passAccessToken: c.passAccessToken.trim() || undefined } : {}),
            passCliPath: typeof c.passCliPath === "string" ? c.passCliPath.trim() : current.connection.passCliPath,
            // Only overwrite credentials if a non-empty, non-placeholder string was sent
            ...(typeof c.password  === "string" && c.password  && c.password  !== "••••••••" ? { password:  c.password  } : {}),
            ...(typeof c.smtpToken === "string" && c.smtpToken && c.smtpToken !== "••••••••" ? { smtpToken: c.smtpToken } : {}),
          };
        }

        // Merge settingsPort
        if (typeof body.settingsPort === "number") {
          const sp = Math.round(body.settingsPort);
          if (sp >= 1 && sp <= 65535) {
            current.settingsPort = sp;
          } else {
            json(res, 400, { error: `Invalid settingsPort: must be 1–65535 (got ${sp}).` }); return;
          }
        }

        // Merge compliance flags (destructive-confirm, ToS ack) and notification prefs
        if (typeof body.requireDestructiveConfirm === "boolean") {
          current.requireDestructiveConfirm = body.requireDestructiveConfirm;
        }
        if (typeof body.desktopNotificationsEnabled === "boolean") {
          current.desktopNotificationsEnabled = body.desktopNotificationsEnabled;
        }
        if (typeof body.surfaceSecurityNotifications === "boolean") {
          current.surfaceSecurityNotifications = body.surfaceSecurityNotifications;
        }
        if (typeof body.autoOpenApprovalWindow === "boolean") {
          current.autoOpenApprovalWindow = body.autoOpenApprovalWindow;
        }
        if (body.tosAcknowledged && typeof body.tosAcknowledged === "object") {
          const t = body.tosAcknowledged as Record<string, unknown>;
          if (typeof t.accepted === "boolean" && typeof t.timestamp === "string") {
            current.tosAcknowledged = { accepted: t.accepted, timestamp: t.timestamp };
          }
        }

        // Merge permissions
        if (body.permissions && typeof body.permissions === "object") {
          const p = body.permissions as Record<string, unknown>;
          const validPresets = new Set<string>(PERMISSION_PRESETS as unknown as string[]);
          // Filter incoming tool keys against ALL_TOOLS so an unknown name
          // (typo, or a key for a tool that doesn't ship yet) is dropped
          // instead of silently entering the persisted config. Matches the
          // pattern config/loader.ts applies on load.
          const knownTools = new Set<string>(ALL_TOOLS as unknown as string[]);
          const incomingTools = typeof p.tools === "object" && p.tools !== null
            ? p.tools as Record<string, unknown>
            : {};
          const filteredTools: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(incomingTools)) {
            if (knownTools.has(k)) filteredTools[k] = v;
          }
          current.permissions = {
            preset: typeof p.preset === "string" && validPresets.has(p.preset)
              ? (p.preset as PermissionPreset)
              : current.permissions.preset,
            tools:  { ...current.permissions.tools, ...filteredTools as Record<string, boolean> },
          };
        }

        // Merge response limits
        if (body.responseLimits && typeof body.responseLimits === "object") {
          const rl = body.responseLimits as Record<string, unknown>;
          const validNum = (v: unknown, min: number, max: number): number | undefined =>
            typeof v === "number" && Number.isFinite(v) && v >= min && v <= max ? Math.round(v) : undefined;
          const cur = current.responseLimits ?? {
            maxResponseBytes: 900 * 1024, maxEmailBodyChars: 500_000,
            maxEmailListResults: 50, maxAttachmentBytes: 600_000, warnOnLargeResponse: true,
          };
          current.responseLimits = {
            maxResponseBytes:    validNum(rl.maxResponseBytes,    100_000, 1_048_576) ?? cur.maxResponseBytes,
            maxEmailBodyChars:   validNum(rl.maxEmailBodyChars,   1_000,   10_000_000) ?? cur.maxEmailBodyChars,
            maxEmailListResults: validNum(rl.maxEmailListResults, 1,       200)        ?? cur.maxEmailListResults,
            maxAttachmentBytes:  validNum(rl.maxAttachmentBytes,  0,       1_048_576)  ?? cur.maxAttachmentBytes,
            warnOnLargeResponse: typeof rl.warnOnLargeResponse === "boolean" ? rl.warnOnLargeResponse : cur.warnOnLargeResponse,
          };
        }

        // Try to store credentials in OS keychain; fall back to config file.
        // saveConfigWithCredentials mutates `current` — it blanks the password
        // in the file when the keychain save succeeds — so capture what was
        // posted BEFORE the call, for in-process propagation below.
        const postedPassword  = current.connection.password  || "";
        const postedSmtpToken = current.connection.smtpToken || "";
        const credStorage     = await saveConfigWithCredentials(current);

        // Push the newly-saved credentials into the running AccountManager so
        // the SMTP transporter and IMAP connection pick them up WITHOUT a
        // restart. Without this, the UI "Save Configuration" button reports
        // success, the keychain is updated, but the in-memory per-account
        // SMTPService still holds whatever empty creds it was built with at
        // module load — the next send/receive still fails with
        // "Please configure the login" / "Missing credentials for PLAIN"
        // until the user manually restarts the MCP.
        //
        // Only applies when the settings server is running in-process with
        // the MCP (the common case). The standalone `mailpouch-settings`
        // daemon has no AccountManager singleton; getAccountManager() returns
        // null there and the update falls through silently — the MCP process
        // will pick up the new creds on its own next startup via main().
        try {
          const mgr = getAccountManager();
          if (mgr && (postedPassword || postedSmtpToken)) {
            // SMTP is refreshed synchronously here (transporter rebuilt).
            mgr.applyKeychainCredentials(postedPassword, postedSmtpToken);
            // IMAP: flush the stale clients and reconnect with the new password
            // so it takes effect WITHOUT a restart. Fire-and-forget — the
            // reconnect can take seconds (or back off if Bridge is throttling),
            // and we don't want to stall the save response on it; the UI's
            // "Check Now" surfaces the result.
            if (postedPassword) {
              void mgr.reloadImapCredentials(postedPassword);
            }
          }
        } catch (e: unknown) {
          // Non-fatal — save already succeeded; a restart will pick creds up.
          logger.warn("Could not push fresh credentials to AccountManager; a restart will apply them", "SettingsServer", e);
        }

        json(res, 200, { ok: true, credentialStorage: credStorage });
        return;
      }

      // ── POST /api/preset ──────────────────────────────────────────────────
      if (method === "POST" && path === "/api/preset") {
        if (!requireCsrf(req, res)) return;
        let _presetBody: { preset: string };
        try { _presetBody = JSON.parse(await readBodySafe(req)); } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }
        const { preset } = _presetBody;
        const validPresets = ["full", "read_only", "supervised", "send_only", "custom"];
        if (!validPresets.includes(preset)) {
          json(res, 400, { error: "Invalid preset" });
          return;
        }
        const current = loadConfig() ?? defaultConfig();
        current.permissions = buildPermissions(preset as PermissionPreset);
        saveConfig(current);
        json(res, 200, { ok: true });
        return;
      }

      // ── POST /api/test-connection ─────────────────────────────────────────
      // Requires CSRF to prevent cross-site abuse, even though this endpoint
      // is read-only (it does open TCP connections, which is a side-effect).
      // Host allow-list blocks SSRF probing of internal/cloud-metadata services.
      if (method === "POST" && path === "/api/test-connection") {
        if (!requireCsrf(req, res)) return;
        let body: Record<string, unknown>;
        try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }
        const { smtpHost, smtpPort, imapHost, imapPort } = body;

        // Port validation
        const validPort = (v: unknown): v is number =>
          typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 65535;
        if (!validPort(smtpPort) || !validPort(imapPort)) {
          json(res, 400, { error: "Ports must be integers between 1 and 65535." }); return;
        }

        // Host allow-list: only localhost and private-LAN addresses may be tested.
        // This prevents SSRF probing of cloud-metadata endpoints (169.254.169.254),
        // internal services, or arbitrary internet hosts.
        const ALLOWED_HOST_RE =
          /^(?:localhost|127\.0\.0\.1|::1|192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})$/;
        if (typeof smtpHost !== "string" || !ALLOWED_HOST_RE.test(smtpHost)) {
          json(res, 400, { error: "smtpHost must be localhost or a private LAN address." }); return;
        }
        if (typeof imapHost !== "string" || !ALLOWED_HOST_RE.test(imapHost)) {
          json(res, 400, { error: "imapHost must be localhost or a private LAN address." }); return;
        }

        // Real check: TCP reachability AND a STARTTLS+AUTH probe with the saved
        // credentials, so a port that's open but failing auth (e.g. a 454
        // throttle / wrong Bridge password) is NOT reported as a green
        // "reachable". `smtp`/`imap` stay as the reachability booleans for
        // backward compatibility; `smtpAuth`/`imapAuth` carry the auth verdict.
        const checked = await checkConnections({ smtpHost, smtpPort, imapHost, imapPort });
        json(res, 200, {
          smtp: checked.smtp.reachable,
          imap: checked.imap.reachable,
          smtpAuth: { authenticated: checked.smtp.authenticated, error: checked.smtp.error },
          imapAuth: { authenticated: checked.imap.authenticated, error: checked.imap.error },
        });
        return;
      }

      // ── POST /api/start-bridge ────────────────────────────────────────────
      // Checks if Bridge is reachable; if not, locates and launches the
      // executable then waits up to 15 s for SMTP/IMAP ports to come up.
      if (method === "POST" && path === "/api/start-bridge") {
        if (!requireCsrf(req, res)) return;
        const cfg = loadConfig() ?? defaultConfig();
        const smtpHost = cfg.connection.smtpHost || "localhost";
        const smtpPort = cfg.connection.smtpPort || 1025;
        const imapHost = cfg.connection.imapHost || "localhost";
        const imapPort = cfg.connection.imapPort || 1143;

        // If already up, nothing to do
        const [smtpAlready, imapAlready] = await Promise.all([
          tcpCheck(smtpHost, smtpPort, 2000),
          tcpCheck(imapHost, imapPort, 2000),
        ]);
        if (smtpAlready && imapAlready) {
          json(res, 200, { launched: false, alreadyRunning: true, reachable: true });
          return;
        }

        // Resolve executable path: config override → known locations → OS fallback
        const home = os.homedir();
        const platform = process.platform;
        // Strip surrounding quotes that users sometimes paste in (e.g. from Explorer)
        let bridgeExe: string | null = (cfg.connection.bridgePath || "").trim().replace(/^["']|["']$/g, "") || null;
        if (bridgeExe && !existsSync(bridgeExe)) bridgeExe = null;

        if (!bridgeExe) {
          let candidates: string[];
          if (platform === "win32") {
            candidates = [
              `${home}\\AppData\\Local\\Programs\\Proton Mail Bridge\\bridge.exe`,
              `${home}\\AppData\\Local\\Programs\\bridge\\bridge.exe`,
              "C:\\Program Files\\Proton AG\\Proton Mail Bridge\\proton-bridge.exe",
              "C:\\Program Files\\Proton Mail\\Proton Mail Bridge\\bridge.exe",
              "C:\\Program Files\\Proton\\Proton Mail Bridge\\bridge.exe",
              "C:\\Program Files (x86)\\Proton Mail\\Proton Mail Bridge\\bridge.exe",
            ];
          } else if (platform === "darwin") {
            candidates = [
              "/Applications/Proton Mail Bridge.app/Contents/MacOS/Proton Mail Bridge",
              `${home}/Applications/Proton Mail Bridge.app/Contents/MacOS/Proton Mail Bridge`,
            ];
          } else {
            candidates = [
              "/usr/bin/proton-bridge",
              "/usr/local/bin/proton-bridge",
              `${home}/.local/bin/proton-bridge`,
              "/opt/proton-bridge/proton-bridge",
            ];
          }
          bridgeExe = candidates.find(p => existsSync(p)) ?? null;
        }

        // Launch — error out if executable wasn't found rather than guessing
        if (!bridgeExe) {
          json(res, 200, { launched: false, alreadyRunning: false, reachable: false,
            error: "Proton Bridge not found. Please set the executable path in Settings → Bridge TLS Certificate." });
          return;
        }
        try {
          if (bridgeExe) {
            // Async 'error' would crash the server without a listener, even
            // after .unref() — existsSync above doesn't guarantee spawn.
            const bridgeProc = spawn(bridgeExe, [], {
              stdio: "ignore", detached: true, shell: false,
            });
            bridgeProc.on("error", (err) => {
              // Log at warn level so operators can diagnose launch failures
              // from `tail ~/.mailpouch.log`. The tcp poll below will also
              // surface this to the HTTP caller as `reachable: false`, but
              // the specific error (ENOENT vs EACCES vs EPERM) only shows
              // up here.
              const msg = err instanceof Error ? err.message : String(err);
              logger.warn(`Failed to launch Proton Bridge (${bridgeExe}): ${msg}`, "SettingsServer");
            });
            bridgeProc.unref();
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          json(res, 200, { launched: false, alreadyRunning: false, reachable: false,
            error: `Failed to launch Bridge: ${msg}` });
          return;
        }

        // Poll up to 15 s
        const deadline = Date.now() + 15_000;
        let reachable = false;
        while (Date.now() < deadline) {
          await new Promise<void>(r => setTimeout(r, 1500));
          const [s, i] = await Promise.all([
            tcpCheck(smtpHost, smtpPort, 2000),
            tcpCheck(imapHost, imapPort, 2000),
          ]);
          if (s && i) { reachable = true; break; }
        }
        json(res, 200, { launched: true, alreadyRunning: false, reachable });
        return;
      }

      // ── GET /api/search-bridge ────────────────────────────────────────────
      // Searches well-known install locations for the Proton Bridge executable.
      // Returns the first found path (or null) plus the full candidate list.
      if (method === "GET" && path === "/api/search-bridge") {
        const home = os.homedir();
        const platform = process.platform;
        let candidates: string[];
        if (platform === "win32") {
          candidates = [
            `${home}\\AppData\\Local\\Programs\\Proton Mail Bridge\\bridge.exe`,
            `${home}\\AppData\\Local\\Programs\\bridge\\bridge.exe`,
            "C:\\Program Files\\Proton AG\\Proton Mail Bridge\\proton-bridge.exe",
            "C:\\Program Files\\Proton Mail\\Proton Mail Bridge\\bridge.exe",
            "C:\\Program Files\\Proton\\Proton Mail Bridge\\bridge.exe",
            "C:\\Program Files (x86)\\Proton Mail\\Proton Mail Bridge\\bridge.exe",
          ];
        } else if (platform === "darwin") {
          candidates = [
            "/Applications/Proton Mail Bridge.app/Contents/MacOS/Proton Mail Bridge",
            `${home}/Applications/Proton Mail Bridge.app/Contents/MacOS/Proton Mail Bridge`,
          ];
        } else {
          candidates = [
            "/usr/bin/proton-bridge",
            "/usr/local/bin/proton-bridge",
            `${home}/.local/bin/proton-bridge`,
            "/opt/proton-bridge/proton-bridge",
          ];
        }
        let found = candidates.find(p => existsSync(p)) ?? null;
        // POSIX fallback: `which` catches non-standard install prefixes
        // (Homebrew pour, pacman AUR package, Flatpak bin shim, etc.) that
        // our hardcoded candidate list misses. Quick sync call — `which`
        // returns in <10 ms on all modern POSIX systems.
        if (!found && platform !== "win32") {
          for (const name of ["proton-bridge", "protonmail-bridge", "bridge"]) {
            try {
              const result = spawnSync("which", [name], { encoding: "utf8", timeout: 2000 });
              const path = result.stdout?.trim();
              if (result.status === 0 && path && existsSync(path)) {
                found = path;
                break;
              }
            } catch { /* which unavailable — nothing more to try */ }
          }
        }
        json(res, 200, { found: found !== null, path: found, candidates });
        return;
      }

      // ── GET /api/find-bridge-cert ─────────────────────────────────────────
      // Scans the user's home directory for `cert.pem` at the locations most
      // commonly used by Bridge's "Export TLS Certificate" dialog. Uses
      // path.join so the paths are platform-correct (backslashes on Windows,
      // forward slashes elsewhere).
      if (method === "GET" && path === "/api/find-bridge-cert") {
        const home = os.homedir();
        const candidates: string[] = [
          nodePath.join(home, "Downloads", "cert.pem"),
          nodePath.join(home, "Documents", "cert.pem"),
          nodePath.join(home, "Desktop", "cert.pem"),
          nodePath.join(home, "cert.pem"),
        ];
        // Also check Bridge's in-place cert (rarely used by end users but
        // occasionally the easier option on dev boxes).
        if (process.platform === "win32" && process.env.APPDATA) {
          candidates.push(nodePath.join(process.env.APPDATA, "protonmail", "bridge-v3", "cert.pem"));
        } else if (process.platform === "darwin") {
          candidates.push(nodePath.join(home, "Library", "Application Support", "protonmail", "bridge-v3", "cert.pem"));
        } else {
          candidates.push(nodePath.join(home, ".config", "protonmail", "bridge-v3", "cert.pem"));
        }
        const found = candidates.find(p => existsSync(p)) ?? null;
        json(res, 200, { found: found !== null, path: found, candidates });
        return;
      }

      // ── POST /api/upload-bridge-cert ──────────────────────────────────────
      // Accepts a PEM-encoded certificate in the request body (text/plain or
      // application/x-pem-file), validates the PEM preamble, and writes it
      // to `~/.mailpouch-bridge-cert.pem` at mode 0600. Returns the resolved
      // path so the UI can populate the cert-path field without the user
      // typing anything. The upload replaces any previous copy — this is the
      // canonical server-managed cert location.
      if (method === "POST" && path === "/api/upload-bridge-cert") {
        if (!requireCsrf(req, res)) return;
        // LAN access-token gate is enforced globally at line ~4016 for every
        // non-"/" path, so no per-endpoint check needed here.
        try {
          // Hard cap to prevent memory exhaustion on runaway uploads — a real
          // PEM cert is well under 10 KB, so 256 KB is a generous ceiling.
          // readBodySafe returns a string (PEM is ASCII) already size-capped.
          const MAX_CERT_BYTES = 256 * 1024;
          const text = await readBodySafe(req, MAX_CERT_BYTES);
          if (!text.includes("-----BEGIN CERTIFICATE-----") || !text.includes("-----END CERTIFICATE-----")) {
            json(res, 400, { error: "Upload does not look like a PEM certificate (missing BEGIN/END markers)." });
            return;
          }
          const destPath = nodePath.join(os.homedir(), ".mailpouch-bridge-cert.pem");
          writeFileSync(destPath, text, { encoding: "utf8", mode: 0o600 });
          // writeFileSync's `mode` only applies on first creation. If the
          // file already existed with broader perms, tighten it now —
          // otherwise the endpoint's 0600 contract silently regresses
          // whenever the user re-uploads. chmod is a no-op on Windows.
          try { chmodSync(destPath, 0o600); } catch { /* platform may not support chmod */ }
          json(res, 200, { ok: true, path: destPath, size: Buffer.byteLength(text, "utf8") });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          if ((e as { code?: string })?.code === "TOO_LARGE") {
            json(res, 413, { error: "Cert file too large (max 256 KB)." });
          } else {
            json(res, 500, { error: `Failed to save certificate: ${msg}` });
          }
        }
        return;
      }

      // ── GET /api/check-update ─────────────────────────────────────────────
      // Fetches the latest version from the npm registry and compares it
      // with the currently installed version from package.json.
      if (method === "GET" && path === "/api/check-update") {
        try {
          const pkgJson = JSON.parse(readFileSync(_pkgJsonPath, "utf-8")) as { version?: string; name?: string };
          const current = pkgJson.version ?? "unknown";
          const name    = pkgJson.name    ?? "mailpouch";

          const latest = await new Promise<string>((resolve, reject) => {
            // npm is a shell script (#!/usr/bin/env node) so it needs both the
            // resolved npm path AND node on PATH. GUI MCP clients strip PATH, so
            // we inject node's bin dir into the child's PATH explicitly.
            const isWin = process.platform === "win32";
            const nodeDir = nodePath.dirname(process.execPath);
            const pathSep = isWin ? ";" : ":";
            const childEnv = {
              ...process.env,
              PATH: process.env.PATH
                ? `${nodeDir}${pathSep}${process.env.PATH}`
                : nodeDir,
            };
            const npmResolved = nodePath.join(nodeDir, isWin ? "npm.cmd" : "npm");
            const proc = spawn(npmResolved, ["view", name, "version", "--json"], {
              stdio: ["ignore", "pipe", "pipe"],
              shell: isWin,
              env: childEnv,
            });
            let out = "";
            let err = "";
            proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
            proc.stderr?.on("data", (d: Buffer) => { err += d.toString(); });
            const timer = setTimeout(() => { proc.kill(); reject(new Error("npm view timed out")); }, 15_000);
            proc.on("close", (code) => {
              clearTimeout(timer);
              if (code !== 0) {
                const msg = err.trim() || out.trim();
                if (msg.includes("E404") || msg.includes("Not found") || msg.includes("404")) {
                  reject(new Error(`Package '${name}' is not yet published on npm. Publish it first to enable auto-update.`));
                } else {
                  reject(new Error(msg || `npm view exited ${code}`));
                }
                return;
              }
              try {
                // npm --json returns a quoted string e.g. "2.1.0" or an array for multiple versions
                const raw = out.trim();
                const parsed = JSON.parse(raw);
                const version = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
                if (typeof version !== "string") { reject(new Error("Unexpected npm view output")); return; }
                resolve(version);
              } catch { reject(new Error(`Could not parse npm view output: ${out.trim()}`)); }
            });
            proc.on("error", (e) => { clearTimeout(timer); reject(e); });
          });

          // Simple semver comparison: split on dots and compare integers
          const toNum = (v: string) => v.split(".").map(Number);
          const [ca, cb, cc] = toNum(current);
          const [la, lb, lc] = toNum(latest);
          const updateAvailable =
            la > ca || (la === ca && lb > cb) || (la === ca && lb === cb && lc > cc);

          json(res, 200, { current, latest, updateAvailable, name });
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          json(res, 500, { error: `Update check failed: ${msg}` });
        }
        return;
      }

      // ── POST /api/install-update ──────────────────────────────────────────
      // Runs `npm install -g <package>@latest` and streams output back.
      if (method === "POST" && path === "/api/install-update") {
        if (!requireCsrf(req, res)) return;
        try {
          const pkgJson = JSON.parse(readFileSync(_pkgJsonPath, "utf-8")) as { name?: string };
          const name    = pkgJson.name ?? "mailpouch";

          const output = await new Promise<string>((resolve, reject) => {
            const isWin = process.platform === "win32";
            const nodeDir = nodePath.dirname(process.execPath);
            const pathSep = isWin ? ";" : ":";
            const childEnv = {
              ...process.env,
              PATH: process.env.PATH
                ? `${nodeDir}${pathSep}${process.env.PATH}`
                : nodeDir,
            };
            const npmResolved = nodePath.join(nodeDir, isWin ? "npm.cmd" : "npm");
            const proc = spawn(npmResolved, ["install", "-g", `${name}@latest`], {
              stdio: ["ignore", "pipe", "pipe"],
              shell: isWin,
              env: childEnv,
            });
            let out = "";
            proc.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
            proc.stderr?.on("data", (d: Buffer) => { out += d.toString(); });
            proc.on("close", (code) => {
              if (code === 0) resolve(out);
              else reject(new Error(`npm exited with code ${code}:\n${out}`));
            });
            proc.on("error", reject);
          });

          const restarting = typeof secOpts.onRestartRequested === "function";
          json(res, 200, { ok: true, output, restarting });
          if (restarting) {
            // Give the HTTP response 400 ms to flush before tearing down
            setTimeout(() => secOpts.onRestartRequested!(), 400);
          }
        } catch (e: unknown) {
          const msg = e instanceof Error ? e.message : String(e);
          json(res, 200, { ok: false, error: msg });
        }
        return;
      }

      // ── POST /api/reset ───────────────────────────────────────────────────
      if (method === "POST" && path === "/api/reset") {
        if (!requireCsrf(req, res)) return;
        saveConfig(defaultConfig());
        json(res, 200, { ok: true });
        return;
      }

      // ── GET /api/escalations ──────────────────────────────────────────────
      // Returns current pending escalations for display in the browser UI.
      // Read-only — no CSRF needed for reads.
      if (method === "GET" && path === "/api/escalations") {
        json(res, 200, { pending: getPendingEscalations() });
        return;
      }

      // ── GET /api/audit ────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/audit") {
        json(res, 200, { entries: getAuditLog(100) });
        return;
      }

      // ── POST /api/escalations/:id/approve ────────────────────────────────
      // Four-layer gate:
      //   1. Escalation-specific rate limit (20/min per IP)
      //   2. Valid CSRF token   — requires loading the HTML page first
      //   3. Valid Origin header — defence-in-depth alongside CSRF
      //   4. Typed confirmation  — body.confirm must equal "APPROVE" exactly
      if (method === "POST" && /^\/api\/escalations\/[0-9a-f]{32}\/approve$/.test(path)) {
        if (!escalationLimiter.check(`${ip}:approve`)) {
          json(res, 429, { error: "Too many approval attempts." }); return;
        }
        if (!requireCsrf(req, res))   return;
        if (!requireOrigin(req, res)) return;

        const id = path.split("/")[3];
        // Re-validate the ID format before using it (path regex already covers this,
        // but defence-in-depth: never trust data derived from user input).
        if (!isValidChallengeId(id)) {
          json(res, 400, { error: "Invalid challenge ID format." }); return;
        }

        let body: Record<string, unknown>;
        try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; } catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }

        // Server-side enforcement — JS client validation is not reliable.
        if (body.confirm !== "APPROVE") {
          json(res, 400, { error: "Confirmation text must be exactly 'APPROVE' (case-sensitive)." });
          return;
        }

        const result = approveEscalation(id, "browser_ui");
        if (!result.ok) {
          json(res, 400, { error: result.error });
          return;
        }

        const cfg = loadConfig() ?? defaultConfig();
        cfg.permissions = buildPermissions(result.targetPreset);
        saveConfig(cfg);

        json(res, 200, { ok: true, preset: result.targetPreset });
        return;
      }

      // ── POST /api/escalations/:id/deny ───────────────────────────────────
      if (method === "POST" && /^\/api\/escalations\/[0-9a-f]{32}\/deny$/.test(path)) {
        if (!escalationLimiter.check(`${ip}:deny`)) {
          json(res, 429, { error: "Too many denial attempts." }); return;
        }
        if (!requireCsrf(req, res))   return;
        if (!requireOrigin(req, res)) return;

        const id = path.split("/")[3];
        if (!isValidChallengeId(id)) {
          json(res, 400, { error: "Invalid challenge ID format." }); return;
        }

        const result = denyEscalation(id, "browser_ui");
        if (!result.ok) { json(res, 400, { error: result.error }); return; }
        json(res, 200, { ok: true });
        return;
      }

      // ── GET /api/logs ─────────────────────────────────────────────────────
      if (method === "GET" && path === "/api/logs") {
        const PAGE_SIZE = 200; // lines per page
        const page  = Math.max(1, parseInt(url.searchParams.get("page")  ?? "1", 10));
        const logPath = getLogFilePath();
        if (!existsSync(logPath)) {
          json(res, 200, { lines: [], page: 1, pages: 1, total: 0 });
          return;
        }
        try {
          const raw   = readFileSync(logPath, "utf8");
          const all   = raw.split("\n").filter(l => l.trim() !== "");
          const total = all.length;
          const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
          const safePage = Math.min(page, pages);
          const start = (safePage - 1) * PAGE_SIZE;
          const slice = all.slice(start, start + PAGE_SIZE).map(l => {
            try { return JSON.parse(l); } catch { return { level: "info", message: l, context: "raw", timestamp: null }; }
          });
          json(res, 200, { lines: slice, page: safePage, pages, total });
        } catch (e: unknown) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ── POST /api/logs/clear ───────────────────────────────────────────────
      if (method === "POST" && path === "/api/logs/clear") {
        if (!requireCsrf(req, res)) return;
        try {
          const logPath = getLogFilePath();
          if (existsSync(logPath)) writeFileSync(logPath, "", "utf8");
          json(res, 200, { ok: true });
        } catch (e: unknown) {
          json(res, 500, { error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ══ AGENT NOTIFICATIONS — SSE stream for the Agents tab ═══════════════
      if (method === "GET" && path === "/api/notifications") {
        res.statusCode = 200;
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no"); // disable proxy buffering
        res.write(`: connected\n\n`);
        const stripNL = (s: unknown) => String(s).replace(/[\r\n]/g, "");
        const unsub = agentNotifications.subscribe((ev) => {
          try {
            res.write(`event: ${stripNL(ev.kind)}\n`);
            res.write(`id: ${stripNL(ev.seq)}\n`);
            res.write(`data: ${JSON.stringify(ev.grant)}\n\n`);
          } catch { /* client disconnected mid-write */ }
        });
        // Keep-alive comments every 25 s so proxies don't tear the stream down.
        const heartbeat = setInterval(() => {
          try { res.write(`: heartbeat\n\n`); } catch { /* ignore */ }
        }, 25_000);
        req.on("close", () => {
          clearInterval(heartbeat);
          unsub();
          try { res.end(); } catch { /* ignore */ }
        });
        return; // don't fall through to response cleanup
      }

      // ══ AGENT GRANTS (REST API — consumed by the Agents tab UI) ═══════════
      if (path === "/api/agents" || path.startsWith("/api/agents/")) {
        const grants = getAgentGrantStore();
        const audit = getAgentAuditLog();
        if (!grants || !audit) {
          json(res, 503, { error: "Agent services not initialized." });
          return;
        }

        // GET /api/agents?status=... — list all (or filter by status)
        if (method === "GET" && path === "/api/agents") {
          const statusFilter = url.searchParams.get("status") as
            | "pending" | "active" | "revoked" | "expired" | null;
          const list = statusFilter
            ? grants.list({ status: statusFilter })
            : grants.list();
          // Tag grants backed by a service account so the UI routes revoke to
          // the service-account endpoint (which also deletes the credential —
          // a grant-only revoke would be re-activated on the next restart).
          const sa = getServiceAccountStore();
          const tagged = list.map(g => ({ ...g, isServiceAccount: !!sa?.get(g.clientId) }));
          json(res, 200, { grants: tagged });
          return;
        }

        // GET /api/agents/audit?limit=200 — recent audit rows
        if (method === "GET" && path === "/api/agents/audit") {
          const limit = Math.min(Math.max(1, parseInt(url.searchParams.get("limit") ?? "200", 10)), 1000);
          json(res, 200, { rows: audit.readTail(limit) });
          return;
        }

        // GET /api/agents/service-account — list service accounts (no secrets).
        if (method === "GET" && path === "/api/agents/service-account") {
          const sa = getServiceAccountStore();
          if (!sa) { json(res, 503, { error: "Service accounts not initialized." }); return; }
          json(res, 200, {
            accounts: sa.list().map(a => ({
              clientId: a.clientId,
              clientName: a.clientName,
              preset: a.preset,
              conditions: a.conditions,
              createdAt: a.createdAt,
              status: grants.get(a.clientId)?.status ?? "active",
            })),
          });
          return;
        }

        // POST /api/agents/service-account — issue a service account
        // (client_credentials). Returns the plaintext secret ONCE. The matching
        // grant is born active (pre-approved), like `mailpouch agent issue`.
        if (method === "POST" && path === "/api/agents/service-account") {
          const sa = getServiceAccountStore();
          if (!sa) { json(res, 503, { error: "Service accounts not initialized." }); return; }
          // Issuing a credential widens privilege — share the escalation limiter.
          if (!escalationLimiter.check(`${ip}:service-account-issue`)) {
            json(res, 429, { error: "Too many service-account changes." }); return;
          }
          if (!requireCsrf(req, res)) return;
          let body: Record<string, unknown>;
          try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; }
          catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }

          const name = typeof body.name === "string" ? body.name.trim() : "";
          if (!name) { json(res, 400, { error: "name is required." }); return; }
          const presets = new Set(["full", "read_only", "supervised", "send_only", "custom"]);
          const preset = String(body.preset ?? "read_only");
          if (!presets.has(preset)) {
            json(res, 400, { error: `Invalid preset '${preset}'. Must be one of: ${[...presets].join(", ")}.` });
            return;
          }
          // Reuse the same conditions whitelist shape the approve route applies.
          let conditions: GrantConditions | undefined;
          if (body.conditions && typeof body.conditions === "object" && !Array.isArray(body.conditions)) {
            const c = body.conditions as Record<string, unknown>;
            const out: GrantConditions = {};
            if (typeof c.expiresAt === "string") out.expiresAt = c.expiresAt;
            if (typeof c.accountId === "string") out.accountId = c.accountId;
            if (Array.isArray(c.folderAllowlist)) {
              out.folderAllowlist = c.folderAllowlist.filter((x): x is string => typeof x === "string");
            }
            if (Array.isArray(c.ipPins)) {
              out.ipPins = c.ipPins.filter((x): x is string => typeof x === "string");
            }
            if (Object.keys(out).length > 0) conditions = out;
          }

          const { account, clientSecret } = sa.issue({
            name,
            preset: preset as "full" | "read_only" | "supervised" | "send_only" | "custom",
            conditions,
          });
          grants.ensureActiveServiceGrant({
            clientId: account.clientId,
            clientName: account.clientName,
            preset: account.preset,
            conditions: account.conditions,
          });
          // clientSecret is returned ONCE here and never persisted in plaintext.
          json(res, 201, {
            clientId: account.clientId,
            clientSecret,
            clientName: account.clientName,
            preset: account.preset,
          });
          return;
        }

        // POST /api/agents/service-account/:id/revoke — remove the account +
        // revoke its grant (immediate in-process token invalidation).
        const saRevokeMatch = /^\/api\/agents\/service-account\/([A-Za-z0-9_]+)\/revoke$/.exec(path);
        if (method === "POST" && saRevokeMatch) {
          const sa = getServiceAccountStore();
          if (!sa) { json(res, 503, { error: "Service accounts not initialized." }); return; }
          if (!escalationLimiter.check(`${ip}:service-account-revoke`)) {
            json(res, 429, { error: "Too many service-account changes." }); return;
          }
          if (!requireCsrf(req, res)) return;
          const clientId = saRevokeMatch[1];
          const existed = sa.revoke(clientId);
          const grant = grants.revoke(clientId);
          if (!existed && !grant) { json(res, 404, { error: "No service account for that clientId." }); return; }
          json(res, 200, { revoked: clientId });
          return;
        }

        // POST /api/agents/:id/approve — body: { preset, toolOverrides?, conditions?, note? }
        const approveMatch = /^\/api\/agents\/([A-Za-z0-9_\-]+)\/approve$/.exec(path);
        if (method === "POST" && approveMatch) {
          // UI-012: agent-grant mutations widen privilege just like an escalation
          // approval, so they share the stricter per-IP escalation limiter.
          if (!escalationLimiter.check(`${ip}:agent-approve`)) {
            json(res, 429, { error: "Too many agent-grant changes." }); return;
          }
          if (!requireCsrf(req, res)) return;
          const clientId = approveMatch[1];
          let body: Record<string, unknown>;
          try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; }
          catch { json(res, 400, { error: "Request body must be valid JSON." }); return; }

          const presets = new Set(["full", "read_only", "supervised", "send_only", "custom"]);
          const preset = String(body.preset ?? "read_only");
          if (!presets.has(preset)) {
            json(res, 400, { error: `Invalid preset '${preset}'. Must be one of: ${[...presets].join(", ")}.` });
            return;
          }
          // Sanitize toolOverrides: only known tool names → boolean. Drops
          // unknown keys and prototype-pollution keys (__proto__, etc.).
          const knownTools = new Set<string>(ALL_TOOLS as unknown as string[]);
          let toolOverrides: Partial<Record<ToolName, boolean>> | undefined;
          if (body.toolOverrides && typeof body.toolOverrides === "object" && !Array.isArray(body.toolOverrides)) {
            const out: Record<string, boolean> = {};
            for (const [k, v] of Object.entries(body.toolOverrides as Record<string, unknown>)) {
              if (knownTools.has(k) && typeof v === "boolean") out[k] = v;
            }
            toolOverrides = out as Partial<Record<ToolName, boolean>>;
          }

          // Sanitize conditions: whitelist GrantConditions keys, validate each
          // value's shape. Anything else (including __proto__) is discarded.
          let conditions: GrantConditions | undefined;
          if (body.conditions && typeof body.conditions === "object" && !Array.isArray(body.conditions)) {
            const c = body.conditions as Record<string, unknown>;
            const out: GrantConditions = {};
            if (typeof c.expiresAt === "string") out.expiresAt = c.expiresAt;
            if (typeof c.accountId === "string") out.accountId = c.accountId;
            if (Array.isArray(c.folderAllowlist)) {
              out.folderAllowlist = c.folderAllowlist.filter((x): x is string => typeof x === "string");
            }
            if (Array.isArray(c.ipPins)) {
              out.ipPins = c.ipPins.filter((x): x is string => typeof x === "string");
            }
            if (c.maxCallsPerHourByTool && typeof c.maxCallsPerHourByTool === "object" && !Array.isArray(c.maxCallsPerHourByTool)) {
              const caps: Partial<Record<ToolName, number>> = {};
              for (const [k, v] of Object.entries(c.maxCallsPerHourByTool as Record<string, unknown>)) {
                if (knownTools.has(k) && typeof v === "number" && Number.isFinite(v) && v >= 0) {
                  caps[k as ToolName] = v;
                }
              }
              out.maxCallsPerHourByTool = caps;
            }
            conditions = out;
          }

          const grant = grants.approve({
            clientId,
            preset: preset as "full" | "read_only" | "supervised" | "send_only" | "custom",
            toolOverrides,
            conditions,
            note: typeof body.note === "string" ? body.note : undefined,
          });
          if (!grant) { json(res, 404, { error: "No grant record for that clientId." }); return; }
          json(res, 200, { grant });
          return;
        }

        // POST /api/agents/:id/deny
        const denyMatch = /^\/api\/agents\/([A-Za-z0-9_\-]+)\/deny$/.exec(path);
        if (method === "POST" && denyMatch) {
          if (!escalationLimiter.check(`${ip}:agent-deny`)) {
            json(res, 429, { error: "Too many agent-grant changes." }); return;
          }
          if (!requireCsrf(req, res)) return;
          const clientId = denyMatch[1];
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; } catch { /* allow empty body */ }
          const grant = grants.deny(clientId, typeof body.note === "string" ? body.note : undefined);
          if (!grant) { json(res, 404, { error: "No grant record for that clientId." }); return; }
          json(res, 200, { grant });
          return;
        }

        // POST /api/agents/:id/revoke
        const revokeMatch = /^\/api\/agents\/([A-Za-z0-9_\-]+)\/revoke$/.exec(path);
        if (method === "POST" && revokeMatch) {
          if (!escalationLimiter.check(`${ip}:agent-revoke`)) {
            json(res, 429, { error: "Too many agent-grant changes." }); return;
          }
          if (!requireCsrf(req, res)) return;
          const clientId = revokeMatch[1];
          // If this grant is backed by a service account, also delete the
          // credential — otherwise revoke isn't durable (startup re-activates
          // the grant from the credential, and a client_credentials login would
          // re-activate it live). Presence of the credential = enabled.
          const saDeleted = getServiceAccountStore()?.revoke(clientId) ?? false;
          const grant = grants.revoke(clientId);
          if (!grant && !saDeleted) { json(res, 404, { error: "No grant record for that clientId." }); return; }
          json(res, 200, { grant, serviceAccountRemoved: saDeleted });
          return;
        }

        json(res, 404, { error: "Unknown agent endpoint." });
        return;
      }

      // ══ ACCOUNTS (A4 — CRUD + active-account switch) ══════════════════════
      if (path === "/api/accounts" || path.startsWith("/api/accounts/")) {
        // GET /api/accounts — list (sanitized, no passwords)
        if (method === "GET" && path === "/api/accounts") {
          const reg = readRegistry();
          const sanitized = reg.accounts.map(a => ({ ...a, password: a.password ? "••••••••" : "" }));
          json(res, 200, { accounts: sanitized, activeAccountId: reg.activeAccountId });
          return;
        }

        // POST /api/accounts — create
        if (method === "POST" && path === "/api/accounts") {
          if (!requireCsrf(req, res)) return;
          let body: Record<string, unknown>;
          try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; }
          catch { json(res, 400, { error: "Body must be JSON." }); return; }
          if (typeof body.name !== "string" || !body.name) { json(res, 400, { error: "name is required" }); return; }
          if (body.providerType !== "proton-bridge" && body.providerType !== "imap") {
            json(res, 400, { error: "providerType must be 'proton-bridge' or 'imap'" }); return;
          }
          const created = await createAccount({
            name: body.name,
            providerType: body.providerType,
            smtpHost: String(body.smtpHost ?? ""),
            smtpPort: Number(body.smtpPort ?? 0),
            imapHost: String(body.imapHost ?? ""),
            imapPort: Number(body.imapPort ?? 0),
            username: String(body.username ?? ""),
            password: String(body.password ?? ""),
            smtpToken: typeof body.smtpToken === "string" ? body.smtpToken : undefined,
            bridgeCertPath: typeof body.bridgeCertPath === "string" ? body.bridgeCertPath : undefined,
            allowInsecureBridge: typeof body.allowInsecureBridge === "boolean" ? body.allowInsecureBridge : undefined,
            tlsMode: body.tlsMode === "ssl" || body.tlsMode === "starttls" ? body.tlsMode : undefined,
            autoStartBridge: typeof body.autoStartBridge === "boolean" ? body.autoStartBridge : undefined,
            bridgePath: typeof body.bridgePath === "string" ? body.bridgePath : undefined,
          });
          // Push the new account's creds into the running AccountManager
          // so the MCP can connect to it on the very next tool call,
          // without requiring a restart. The in-memory `created` still
          // carries the plaintext password (writeRegistry only scrubs
          // the persisted copy); we forward it here and rely on the
          // manager to treat empty specs appropriately.
          try {
            const mgr = getAccountManager();
            if (mgr && (created.password || created.smtpToken)) {
              await mgr.rebuildFromRegistryAsync();
              mgr.applyKeychainCredentials(created.password || "", created.smtpToken);
            }
          } catch (e) {
            logger.warn("Could not propagate new account creds to AccountManager", "Accounts", e);
          }
          json(res, 201, { account: { ...created, password: created.password ? "••••••••" : "" } });
          return;
        }

        // PATCH /api/accounts/:id
        const patchMatch = /^\/api\/accounts\/([A-Za-z0-9_\-]+)$/.exec(path);
        if (method === "PATCH" && patchMatch) {
          if (!requireCsrf(req, res)) return;
          let body: Record<string, unknown>;
          try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; }
          catch { json(res, 400, { error: "Body must be JSON." }); return; }
          // Strip placeholder passwords — only overwrite when a real value arrives.
          if (body.password === "" || body.password === "••••••••") delete body.password;
          const updated = await updateAccount(patchMatch[1], body as Partial<AccountSpecShape>);
          if (!updated) { json(res, 404, { error: "Account not found." }); return; }
          // Same propagation as create — a password rotation applied
          // via PATCH should take effect immediately.
          try {
            const mgr = getAccountManager();
            if (mgr && (updated.password || updated.smtpToken)) {
              await mgr.rebuildFromRegistryAsync();
              mgr.applyKeychainCredentials(updated.password || "", updated.smtpToken);
            }
          } catch (e) {
            logger.warn("Could not propagate updated account creds to AccountManager", "Accounts", e);
          }
          json(res, 200, { account: { ...updated, password: updated.password ? "••••••••" : "" } });
          return;
        }

        // DELETE /api/accounts/:id
        if (method === "DELETE" && patchMatch) {
          if (!requireCsrf(req, res)) return;
          const ok = await deleteAccount(patchMatch[1]);
          if (!ok) { json(res, 400, { error: "Cannot delete — unknown account id or last remaining account." }); return; }
          json(res, 200, { ok: true });
          return;
        }

        // POST /api/accounts/:id/activate
        const activateMatch = /^\/api\/accounts\/([A-Za-z0-9_\-]+)\/activate$/.exec(path);
        if (method === "POST" && activateMatch) {
          // UI-012: switching the active account hot-swaps credentials; gate it
          // with the same per-IP escalation limiter as other privileged ops.
          if (!escalationLimiter.check(`${ip}:account-activate`)) {
            json(res, 429, { error: "Too many account-activation attempts." }); return;
          }
          if (!requireCsrf(req, res)) return;
          const set = await setActiveAccount(activateMatch[1]);
          if (!set) { json(res, 404, { error: "Account not found." }); return; }
          // Hot-swap: ask the AccountManager to rebuild from the persisted
          // registry and flip its active pointer. Emits "active-changed"
          // which rewires the module-level imap/smtp references in index.ts.
          const mgr = getAccountManager();
          let restartRequired = true;
          if (mgr) {
            try {
              await mgr.rebuildFromRegistryAsync();
              await mgr.setActive(set.id);
              restartRequired = false;
            } catch (err) {
              logger.warn("Hot-swap failed, falling back to restart-required", "Accounts", err);
            }
          }
          json(res, 200, { account: { ...set, password: set.password ? "••••••••" : "" }, restartRequired });
          return;
        }

        json(res, 404, { error: "Unknown account endpoint." });
        return;
      }

      // ── GET /api/claude-desktop-status ────────────────────────────────────
      if (method === "GET" && path === "/api/claude-desktop-status") {
        const cdConfigPath = claudeDesktopConfigPath();
        if (!cdConfigPath) {
          // UI-010: Windows with no %APPDATA% — can't resolve a real path.
          json(res, 200, { found: false, configPath: null });
          return;
        }
        const found = existsSync(cdConfigPath);
        json(res, 200, { found, configPath: cdConfigPath });
        return;
      }

      // ── POST /api/write-claude-desktop ────────────────────────────────────
      if (method === "POST" && path === "/api/write-claude-desktop") {
        if (!requireCsrf(req, res)) return;
        if (lan && accessToken && !hasValidAccessToken(req, url, accessToken)) {
          json(res, 401, { error: "Access denied." }); return;
        }
        try {
          const claudeConfigPath = claudeDesktopConfigPath();
          if (!claudeConfigPath) {
            // UI-010: refuse to write to a CWD-relative path when %APPDATA% is
            // unset on Windows — that would scatter a config in the wrong place.
            json(res, 200, {
              ok: false,
              error: "Could not resolve the Claude Desktop config location (%APPDATA% is not set). Write it manually.",
            });
            return;
          }

          let existing: Record<string, unknown> = {};
          let raw: string | null = null;
          try {
            raw = readFileSync(claudeConfigPath, "utf8");
          } catch (readErr: unknown) {
            // Only ENOENT (no file yet) is safe to treat as "start fresh".
            // Any other read error (e.g. EACCES) must not silently overwrite.
            if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") {
              json(res, 200, {
                ok: false,
                error: "Existing Claude Desktop config could not be read; not overwriting. Resolve the file permissions and retry.",
              });
              return;
            }
          }
          if (raw !== null) {
            try {
              const parsed = JSON.parse(raw) as unknown;
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("not a JSON object");
              }
              existing = parsed as Record<string, unknown>;
            } catch {
              // File present but not valid JSON — bail rather than clobber it.
              json(res, 200, {
                ok: false,
                error: "Existing Claude Desktop config could not be parsed as JSON; not overwriting. Back up and fix the file, then retry.",
              });
              return;
            }
          }

          // Daemon-aware: when remoteMode is on, this writes the HTTP entry (a
          // stdio entry would collide with the shared daemon's singleton and
          // fail to start); otherwise a stdio entry with MAILPOUCH_FORCE_STDIO.
          const built = buildClaudeCodeEntry("stdio");

          if (!existing.mcpServers || typeof existing.mcpServers !== "object") {
            existing.mcpServers = {};
          }
          (existing.mcpServers as Record<string, unknown>)["mailpouch"] = built.entry;

          // Write atomically via temp file + rename
          const tmpPath = claudeConfigPath + ".tmp." + randomBytes(6).toString("hex");
          writeFileSync(tmpPath, JSON.stringify(existing, null, 2), "utf8");
          renameSync(tmpPath, claudeConfigPath);

          json(res, 200, { ok: true, configPath: claudeConfigPath, transport: built.transport, entry: built.entry, ...(built.coercedToHttp ? { coercedToHttp: true } : {}), ...(built.warning ? { warning: built.warning } : {}) });
        } catch (e: unknown) {
          json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ── GET /api/claude-code-status ───────────────────────────────────────
      if (method === "GET" && path === "/api/claude-code-status") {
        const ccPath = claudeCodeConfigPath();
        json(res, 200, { found: existsSync(ccPath), configPath: ccPath });
        return;
      }

      // ── POST /api/write-claude-code ───────────────────────────────────────
      // Merge a mailpouch entry into Claude Code's ~/.claude.json mcpServers,
      // for the requested transport (stdio | http). Mirrors write-claude-desktop.
      if (method === "POST" && path === "/api/write-claude-code") {
        if (!requireCsrf(req, res)) return;
        if (lan && accessToken && !hasValidAccessToken(req, url, accessToken)) {
          json(res, 401, { error: "Access denied." }); return;
        }
        try {
          let body: Record<string, unknown> = {};
          try { body = JSON.parse(await readBodySafe(req)) as Record<string, unknown>; } catch { /* default stdio */ }
          const transport = body.transport === "http" ? "http" : "stdio";

          const claudeConfigPath = claudeCodeConfigPath();
          let existing: Record<string, unknown> = {};
          let raw: string | null = null;
          try {
            raw = readFileSync(claudeConfigPath, "utf8");
          } catch (readErr: unknown) {
            if ((readErr as NodeJS.ErrnoException).code !== "ENOENT") {
              json(res, 200, {
                ok: false,
                error: "Existing ~/.claude.json could not be read; not overwriting. Resolve the file permissions and retry.",
              });
              return;
            }
          }
          if (raw !== null) {
            try {
              const parsed = JSON.parse(raw) as unknown;
              if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
                throw new Error("not a JSON object");
              }
              existing = parsed as Record<string, unknown>;
            } catch {
              json(res, 200, {
                ok: false,
                error: "Existing ~/.claude.json could not be parsed as JSON; not overwriting. Back up and fix the file, then retry.",
              });
              return;
            }
          }

          const built = buildClaudeCodeEntry(transport);
          if (!existing.mcpServers || typeof existing.mcpServers !== "object" || Array.isArray(existing.mcpServers)) {
            existing.mcpServers = {};
          }
          (existing.mcpServers as Record<string, unknown>)["mailpouch"] = built.entry;

          // Atomic write via temp file + rename. ~/.claude.json holds no secrets
          // beyond MCP config, but match the project's 0600 hygiene anyway.
          const tmpPath = claudeConfigPath + ".tmp." + randomBytes(6).toString("hex");
          writeFileSync(tmpPath, JSON.stringify(existing, null, 2), { encoding: "utf8", mode: 0o600 });
          renameSync(tmpPath, claudeConfigPath);

          json(res, 200, { ok: true, configPath: claudeConfigPath, transport: built.transport, entry: built.entry, ...(built.coercedToHttp ? { coercedToHttp: true } : {}), ...(built.warning ? { warning: built.warning } : {}) });
        } catch (e: unknown) {
          json(res, 200, { ok: false, error: e instanceof Error ? e.message : String(e) });
        }
        return;
      }

      // ── POST /api/restart-claude-desktop ──────────────────────────────────
      if (method === "POST" && path === "/api/restart-claude-desktop") {
        if (!requireCsrf(req, res)) return;
        if (lan && accessToken && !hasValidAccessToken(req, url, accessToken)) {
          json(res, 401, { error: "Access denied." }); return;
        }
        try {
          const platform = process.platform;

          // Detect Claude Desktop install BEFORE killing anything. There is no
          // official Linux build, and on macOS/Windows it may just not be
          // installed — better to bail cleanly than leave the user with a
          // killed instance and no relaunch path.
          let claudeLaunchCmd: string | null = null;
          let claudeLaunchArgs: string[] = [];
          if (platform === "darwin") {
            const macApp = "/Applications/Claude.app";
            if (existsSync(macApp)) {
              claudeLaunchCmd = "open";
              claudeLaunchArgs = ["-a", "Claude"];
            }
          } else if (platform === "win32") {
            // Only build absolute candidates — falling back to `?? ""` would
            // produce `AnthropicClaude\Claude.exe` (relative to cwd) if the
            // env var is unset, which existsSync could match by accident and
            // lead to killing Claude and then failing to relaunch.
            const winCandidates: string[] = [];
            const localAppData = process.env.LOCALAPPDATA;
            const programFiles = process.env.PROGRAMFILES;
            if (localAppData) {
              winCandidates.push(nodePath.join(localAppData, "AnthropicClaude", "Claude.exe"));
              winCandidates.push(nodePath.join(localAppData, "Programs", "Claude", "Claude.exe"));
            }
            if (programFiles) {
              winCandidates.push(nodePath.join(programFiles, "Claude", "Claude.exe"));
            }
            const found = winCandidates.find((p) => existsSync(p));
            if (found) {
              claudeLaunchCmd = "cmd";
              claudeLaunchArgs = ["/c", "start", "", found];
            }
          }
          // Linux (and any platform where detection failed) falls through with
          // claudeLaunchCmd === null.

          if (!claudeLaunchCmd) {
            json(res, 200, {
              ok: false,
              error: platform === "linux"
                ? "Claude Desktop is not distributed for Linux. Restart it manually from wherever you launched it."
                : "Claude Desktop was not found at the standard install locations. Launch it manually.",
            });
            return;
          }

          // Kill Claude Desktop (ignore errors — may not be running)
          await new Promise<void>((resolve) => {
            let killCmd: string;
            let killArgs: string[];
            if (platform === "win32") {
              killCmd = "taskkill";
              killArgs = ["/IM", "Claude.exe", "/F"];
            } else {
              killCmd = "killall";
              killArgs = ["Claude"];
            }
            const killProc = spawn(killCmd, killArgs, { stdio: "ignore" });
            killProc.on("close", () => resolve());
            killProc.on("error", () => resolve());
          });

          // Wait ~500ms before relaunching
          await new Promise<void>((resolve) => setTimeout(resolve, 500));

          // Relaunch Claude Desktop (fire-and-forget). Attach an async error
          // handler: without it, an ENOENT becomes an unhandled 'error' event
          // and crashes the settings server — we still reply 200 here because
          // we pre-verified the binary exists.
          const launchProc = spawn(claudeLaunchCmd, claudeLaunchArgs, {
            stdio: "ignore", detached: true,
          });
          launchProc.on("error", () => { /* already verified presence; swallow */ });
          launchProc.unref();

          json(res, 200, { ok: true });
        } catch (e: unknown) {
          void e; // kill may fail if process not running — still return ok
          json(res, 200, { ok: true });
        }
        return;
      }

      // ── POST /api/shutdown ────────────────────────────────────────────────
      if (method === "POST" && path === "/api/shutdown") {
        if (!requireCsrf(req, res)) return;
        json(res, 200, { ok: true });
        // Allow the response to flush, then hand off to the caller's graceful
        // shutdown (destroys the tray subprocess, disconnects services, then
        // exits). Fall back to process.exit only when no callback is wired.
        setTimeout(() => {
          if (secOpts.onShutdownRequested) secOpts.onShutdownRequested();
          else process.exit(0);
        }, 300);
        return;
      }

      json(res, 404, { error: "Not found" });
    } catch (err: unknown) {
      // Never reflect raw error messages to callers (information disclosure).
      const errCode    = (err as { code?: string } | null)?.code;
      const isOversize = errCode === "TOO_LARGE";
      const isTimeout  = errCode === "TIMEOUT";
      const status = isOversize || isTimeout ? 400 : 500;
      const msg    = isOversize ? "Request body too large."
                   : isTimeout  ? "Request timed out."
                   : "Internal server error.";
      json(res, status, { error: msg });
    }
  };

  const server = http.createServer(handler);

  // ── Server-level DoS mitigations ───────────────────────────────────────────
  // headersTimeout: abort if the client hasn't finished sending HTTP headers
  // within 10 s (defeats Slow Loris header-starvation attacks).
  server.headersTimeout  = 10_000;
  // requestTimeout: abort the entire request after 30 s.
  server.requestTimeout  = 30_000;
  // Hard cap on simultaneous connections.
  server.maxConnections  = 50;

  return server;
}

/**
 * Start the settings HTTP(S) server.
 *
 * Local mode  (default): binds to 127.0.0.1 over plain HTTP.
 *             Only the local machine can reach it; no token required.
 *
 * LAN mode (--lan flag): binds to 0.0.0.0.
 *             • Attempts to generate a self-signed TLS cert via openssl.
 *               If successful, starts an HTTPS server and prints the cert
 *               fingerprint so the user can verify it in the browser.
 *             • Generates a 256-bit single-use access token displayed in the
 *               terminal; every non-root request must carry it via
 *               X-Access-Token header or ?token= query param.
 *             • Falls back to plain HTTP + token if openssl is absent.
 *             Use only on trusted local networks.
 *
 * @param port  TCP port to listen on (default 8766)
 * @param lan   Enable LAN mode (bind 0.0.0.0 + token + optional TLS)
 */
export async function startSettingsServer(
  port  = 8766,
  lan   = false,
  quiet = false,
  opts: {
    onRestartRequested?: () => void;
    onShutdownRequested?: () => void;
    onStatus?: () => { connected: boolean; account: string; pendingCount: number; activeCount: number };
  } = {},
): Promise<{ scheme: "http" | "https"; stop: () => Promise<void> }> {
  const bindHost    = lan ? "0.0.0.0" : "127.0.0.1";
  const lanIP       = lan ? getPrimaryLanIP() : "";
  const accessToken = lan ? generateAccessToken() : null;
  let   tls: TlsCredentials | null = null;

  if (lan) {
    if (!quiet) process.stdout.write("  Generating TLS certificate for LAN mode… ");
    tls = tryGenerateSelfSignedCert();
    if (!quiet) process.stdout.write(tls ? "done.\n" : "openssl not found — using HTTP + access token.\n");
  }

  const scheme: "http" | "https" = tls ? "https" : "http";
  const secOpts: ServerSecurityOptions = { port, lan, accessToken, scheme, ...opts };
  const appHandler = createSettingsServer(secOpts);

  // Wrap in HTTPS if we have a cert; otherwise use the plain HTTP server.
  // Extract the request listener from appHandler so https.createServer can
  // accept it — both http.Server and https.Server share net.Server.listen().
  type AnyServer = { headersTimeout?: number; requestTimeout?: number; maxConnections?: number;
                     on(e: string, l: (...a: unknown[]) => unknown): unknown;
                     listen(port: number, host: string, cb: () => void): unknown;
                     close(cb?: (err?: Error) => void): void; };
  let server: AnyServer;

  if (tls) {
    const reqListener: http.RequestListener = (req, res) => {
      appHandler.emit("request", req, res);
    };
    const httpsServer = https.createServer({ key: tls.key, cert: tls.cert }, reqListener);
    // Mirror the DOS guards onto the HTTPS wrapper
    httpsServer.headersTimeout = 10_000;
    httpsServer.requestTimeout = 30_000;
    (httpsServer as unknown as { maxConnections: number }).maxConnections = 50;
    server = httpsServer as unknown as AnyServer;
  } else {
    server = appHandler as unknown as AnyServer;
  }

  await new Promise<void>((resolve, reject) => {
    server.on("error", reject as (...a: unknown[]) => unknown);
    server.listen(port, bindHost, () => resolve());
  });

  // ── Startup banner ────────────────────────────────────────────────────────
  if (!quiet) {
    const localUrl  = `${scheme}://localhost:${port}`;
    const lanUrl    = lan && lanIP ? `${scheme}://${lanIP}:${port}` : null;
    const tokenUrl  = lanUrl && accessToken
      ? `${lanUrl}?token=${accessToken.value}`
      : null;
    const w = 52; // banner inner width

    const line  = (s: string) => console.log(`  │ ${s.padEnd(w)} │`);
    const blank = ()           => console.log(`  │ ${" ".repeat(w)} │`);
    const rule  = (ch: string) => console.log(`  ├${"─".repeat(w + 2)}┤`);
    void rule; // used below

    console.log("");
    console.log(`  ┌${"─".repeat(w + 2)}┐`);
    line("mailpouch — Settings UI");
    blank();
    line(`Local:   ${localUrl}`);

    if (lanUrl) {
      blank();
      line(`Network: ${lanUrl}`);
      if (tokenUrl) {
        line(`(with token) ${tokenUrl.slice(0, w - 13)}`);
      }
      line("↑ Open on phone/tablet to approve escalations");
    }

    blank();
    line(`Config:  ${getConfigPath().slice(0, w - 9)}`);
    blank();

    if (accessToken) {
      console.log(`  ├${"─".repeat(w + 2)}┤`);
      line("ACCESS TOKEN (share only with trusted devices):");
      line(`  Fingerprint: ${accessToken.fingerprint}`);
      line("  Full token shown once — copy it now:");
      // Show full token split for readability
      const tok = accessToken.value;
      line(`  ${tok.slice(0, 32)}`);
      line(`  ${tok.slice(32)}`);
      blank();
    }

    if (tls) {
      console.log(`  ├${"─".repeat(w + 2)}┤`);
      line("TLS CERTIFICATE FINGERPRINT (SHA-256):");
      // Split 95-char fingerprint across two lines
      const fp = tls.fingerprint;
      const mid = Math.ceil(fp.length / 2);
      line(`  ${fp.slice(0, mid)}`);
      line(`  ${fp.slice(mid)}`);
      line("Verify this in your browser before trusting the page.");
      blank();
    }

    console.log(`  ├${"─".repeat(w + 2)}┤`);
    line("Press Ctrl+C to stop.");
    console.log(`  └${"─".repeat(w + 2)}┘`);
    console.log("");

    if (lan && !tls) {
      console.log("  ⚠  WARNING: LAN mode is running over plain HTTP.");
      console.log("     Traffic is NOT encrypted. Use --lan only on a");
      console.log("     trusted private network, or install openssl to");
      console.log("     enable automatic TLS.\n");
    }
  }

  const stop = (): Promise<void> =>
    new Promise((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve()))
    );

  return { scheme, stop };
}
