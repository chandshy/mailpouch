#!/usr/bin/env node

/**
 * Proton Mail MCP Server
 *
 * Full agentic design: Tools + Resources + Prompts, structured output,
 * tool annotations, progress notifications, cursor-based pagination.
 */

import { writeFileSync, existsSync, readFileSync } from "fs";
import { fileURLToPath as _fileURLToPath } from "url";
import nodePath from "path";
const _pkgVersion = (() => {
  try {
    const dir = nodePath.dirname(_fileURLToPath(import.meta.url));
    return (JSON.parse(readFileSync(nodePath.resolve(dir, "../package.json"), "utf-8")) as { version: string }).version;
  } catch { return "unknown"; }
})();
import { homedir } from "os";
import { deflateSync } from "zlib";
import { createRequire as _createRequire } from "module";
import { createConnection } from "net";
import { spawn } from "child_process";
import { startSettingsServer } from "./settings/server.js";
import { openBrowser } from "./settings/tui.js";
import type SysTrayClass from "systray2";
import type { MenuItem, SysTrayMenu } from "systray2";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
  McpError,
  ErrorCode,
} from "@modelcontextprotocol/sdk/types.js";

import { ProtonMailConfig, EmailMessage } from "./types/index.js";
import { SMTPService } from "./services/smtp-service.js";
import { SimpleIMAPService } from "./services/simple-imap-service.js";
import { SimpleLoginService } from "./services/simplelogin-service.js";
import { AnalyticsService } from "./services/analytics-service.js";
import { SchedulerService } from "./services/scheduler.js";
import { ReminderService } from "./services/reminder-service.js";
import { PassService } from "./services/pass-service.js";
import { FtsIndexService, FtsUnavailableError, openFtsIndex, type FtsRecord } from "./services/fts-service.js";
import { AgentGrantStore } from "./agents/grant-store.js";
import { GrantManager } from "./agents/grant-manager.js";
import { AgentAuditLog, hashArgs } from "./agents/audit.js";
import { currentCaller } from "./agents/caller-context.js";
import { registerAgentServices } from "./agents/registry.js";
import { notifications as agentNotifications } from "./agents/notifications.js";
import { AccountManager, registerAccountManager } from "./accounts/manager.js";
import { DesktopNotifier } from "./notifications/desktop.js";
import { WebhookDispatcher } from "./notifications/webhooks.js";
import { logger, getLogFilePath } from "./utils/logger.js";
import { isValidEmail, validateTargetFolder, requireNumericEmailId } from "./utils/helpers.js";
import { permissions } from "./permissions/manager.js";
import { loadConfig, defaultConfig, migrateCredentials, loadCredentialsFromKeychain } from "./config/loader.js";
import { migrateLegacyKeychainEntries } from "./security/keychain.js";
import type { ToolName } from "./config/schema.js";
import { DESTRUCTIVE_TOOLS, toolsForTier, parseToolTier } from "./config/schema.js";

/**
 * Build a short, user-readable preview of what a destructive tool call would
 * do, based on its arguments. Shown in the confirmation-required response so
 * the user can see the proposed action in their client before approving.
 */
function describeDestructivePreview(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "delete_email":
      return `Would permanently delete email with ID ${String(args.emailId ?? "(missing)")}.`;
    case "bulk_delete":
    case "bulk_delete_emails": {
      const ids = Array.isArray(args.emailIds) ? args.emailIds : [];
      const preview = ids.slice(0, 5).map(String).join(", ");
      const tail = ids.length > 5 ? `, … +${ids.length - 5} more` : "";
      return `Would permanently delete ${ids.length} email(s): [${preview}${tail}].`;
    }
    case "move_to_trash":
      return `Would move email with ID ${String(args.emailId ?? "(missing)")} to Trash.`;
    case "move_to_spam":
      return `Would move email with ID ${String(args.emailId ?? "(missing)")} to Spam.`;
    case "alias_delete":
      return `Would permanently delete SimpleLogin alias ${String(args.aliasId ?? "(missing)")}. This cannot be undone.`;
    case "pass_get":
      return `Would decrypt Proton Pass item ${String(args.item_id ?? "(missing)")} and return its secret fields to the model.`;
    default:
      return `Would run a destructive operation on the Proton mailbox.`;
  }
}

/**
 * Response returned when destructive-confirmation is required but elicitation
 * is unavailable (older MCP client). Tells the agent to retry with the
 * { confirmed: true } argument — preserving the pre-elicitation behavior.
 */
function confirmGateFallbackResponse(name: string, preview: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
  structuredContent: Record<string, unknown>;
} {
  return {
    content: [{
      type: "text" as const,
      text:
        `Confirmation required for '${name}'.\n\n` +
        `${preview}\n\n` +
        `This tool is destructive. Retry the call with the exact same arguments plus ` +
        `{ "confirmed": true } — the user will see the confirmation flag in the tool call and can cancel it. ` +
        `Set requireDestructiveConfirm: false in ~/.mailpouch.json to disable this guard system-wide.`,
    }],
    isError: false,
    structuredContent: { success: false, confirmationRequired: true, tool: name, preview },
  };
}
import { sanitizeText } from "./settings/security.js";
import { tracer } from "./utils/tracer.js";
import { allToolDefs, allHandlers, escalationHandlers, describeRequestEscalation } from "./tools/registry.js";
import type { ToolCallContext, ToolSharedState } from "./tools/types.js";

// ─── Service Initialization ───────────────────────────────────────────────────
// All credentials and connection settings are loaded from ~/.mailpouch.json
// and the OS keychain in main(). No credentials are read from environment variables
// to prevent accidental exposure to other processes.

const config: ProtonMailConfig = {
  smtp: {
    host: "localhost",
    port: 1025,
    secure: false,
    username: "",
    password: "",
  },
  imap: {
    host: "localhost",
    port: 1143,
    secure: false,
    username: "",
    password: "",
  },
  debug: false,
  autoSync: true,
  syncInterval: 5,
};

// Multi-account: AccountManager owns one SimpleIMAPService + SMTPService per
// configured account. The module-level `imapService`/`smtpService` symbols
// below point at whichever account is currently "active" and get hot-swapped
// when the user switches accounts via the settings UI — no restart needed.
// Per-tool routing to a non-active account happens in the dispatcher via a
// local shadow of these names.
const accountManager = new AccountManager();
registerAccountManager(accountManager);
let imapService: SimpleIMAPService = accountManager.getActive().imap;
let smtpService: SMTPService = accountManager.getActive().smtp;
accountManager.on("active-changed", (ev: { services: { imap: SimpleIMAPService; smtp: SMTPService } }) => {
  imapService = ev.services.imap;
  smtpService = ev.services.smtp;
  logger.info("Module-level imap/smtp services rebound to the new active account", "MCPServer");
});
// SimpleLogin client is lazy: constructed empty and reconfigured in main() once
// the API key is loaded. Alias tools check isConfigured() before dispatching.
let simpleloginService = new SimpleLoginService("");
const analyticsService = new AnalyticsService();

// Env-var priority: MAILPOUCH_* > PM_BRIDGE_MCP_* > PROTONMAIL_*. Legacy names
// honored through v3.0.
function _resolveSchedulerStorePath(): string {
  const envPath = process.env.MAILPOUCH_SCHEDULER_STORE
    || process.env.PM_BRIDGE_MCP_SCHEDULER_STORE
    || process.env.PROTONMAIL_SCHEDULER_STORE;
  if (envPath) return envPath;
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  // Read-old/write-new: keep using the legacy file if it exists and the new
  // one doesn't, so a queue of pending scheduled emails survives the rename.
  const preferred = `${home}/.mailpouch-scheduled.json`;
  const legacyV2 = `${home}/.pm-bridge-mcp-scheduled.json`;
  const legacyV1 = `${home}/.protonmail-mcp-scheduled.json`;
  if (!existsSync(preferred)) {
    if (existsSync(legacyV2)) { logger.info(`Using legacy scheduler store ${legacyV2}`, "MCPServer"); return legacyV2; }
    if (existsSync(legacyV1)) { logger.info(`Using legacy scheduler store ${legacyV1}`, "MCPServer"); return legacyV1; }
  }
  return preferred;
}
const SCHEDULER_STORE = _resolveSchedulerStorePath();
const schedulerService = new SchedulerService(smtpService, SCHEDULER_STORE);

/**
 * Resolve a per-feature file path by checking env-var aliases in priority
 * order (MAILPOUCH_* > PM_BRIDGE_MCP_* > PROTONMAIL_*), then falling back
 * through the matching on-disk defaults. Logs when a legacy path is hit so
 * operators notice the migration.
 */
function _resolveHomeFile(
  envNames: readonly [string, ...string[]],
  basenames: readonly [string, ...string[]],
): string {
  for (const name of envNames) {
    const v = process.env[name];
    if (v) return v;
  }
  const home = process.env.HOME || process.env.USERPROFILE || ".";
  const [preferredBase, ...legacyBases] = basenames;
  const preferred = `${home}/${preferredBase}`;
  if (!existsSync(preferred)) {
    for (const b of legacyBases) {
      const p = `${home}/${b}`;
      if (existsSync(p)) { logger.info(`Using legacy path ${p}`, "MCPServer"); return p; }
    }
  }
  return preferred;
}

const REMINDERS_STORE = _resolveHomeFile(
  ["MAILPOUCH_REMINDERS", "PM_BRIDGE_MCP_REMINDERS"],
  [".mailpouch-reminders.json", ".pm-bridge-mcp-reminders.json"],
);
const reminderService = new ReminderService(REMINDERS_STORE);

const PASS_AUDIT_PATH = _resolveHomeFile(
  ["MAILPOUCH_PASS_AUDIT", "PM_BRIDGE_MCP_PASS_AUDIT"],
  [".mailpouch-pass-audit.jsonl", ".pm-bridge-mcp-pass-audit.jsonl"],
);
let passService: PassService | null = null;

const FTS_DB_PATH = _resolveHomeFile(
  ["MAILPOUCH_FTS_DB", "PM_BRIDGE_MCP_FTS_DB"],
  [".mailpouch-fts.db", ".pm-bridge-mcp-fts.db"],
);
let ftsService: FtsIndexService | null = null;

function getFts(): FtsIndexService {
  if (ftsService) return ftsService;
  ftsService = openFtsIndex(FTS_DB_PATH);
  return ftsService;
}

function recordFromEmail(m: EmailMessage): FtsRecord {
  const stableId = m.protonId ?? m.id;
  const toAll = (m.to ?? []).join(", ");
  return {
    id: stableId,
    subject: m.subject ?? "",
    from: m.from ?? "",
    to: toAll,
    folder: m.folder ?? "",
    body: (m.body ?? m.bodyPreview ?? "").slice(0, 200_000),
    dateEpoch: Math.floor((m.date?.getTime?.() ?? 0) / 1000),
  };
}

// ─── Agent-grant system ───────────────────────────────────────────────────────
// Per-agent permission gating for multi-client deployments. Always-on so the
// gate is consistent whether the transport is stdio or HTTP — but stdio
// callers fall through to the global preset (no caller context), which
// preserves the single-user Claude Desktop default.
const AGENT_GRANTS_PATH = _resolveHomeFile(
  ["MAILPOUCH_AGENTS", "PM_BRIDGE_MCP_AGENTS"],
  [".mailpouch-agents.json", ".pm-bridge-mcp-agents.json"],
);
const AGENT_AUDIT_PATH = _resolveHomeFile(
  ["MAILPOUCH_AGENT_AUDIT", "PM_BRIDGE_MCP_AGENT_AUDIT"],
  [".mailpouch-agent-audit.jsonl", ".pm-bridge-mcp-agent-audit.jsonl"],
);
const agentGrants = new AgentGrantStore(AGENT_GRANTS_PATH);
const grantManager = new GrantManager(agentGrants);
const agentAudit = new AgentAuditLog({ path: AGENT_AUDIT_PATH });
registerAgentServices(agentGrants, agentAudit);

// ─── Notification channels (B2) ──────────────────────────────────────────────
// Subscribe an OS desktop notifier and an outbound webhook dispatcher to the
// agent-notification bus. Both read their settings from the ServerConfig on
// every event (no restart needed when toggling / adding endpoints).
const desktopNotifier = new DesktopNotifier();
const webhookDispatcher = new WebhookDispatcher();
agentNotifications.subscribe((ev) => {
  const cfg = loadConfig();
  // Desktop: default ON; only skip when explicitly disabled.
  if (cfg?.desktopNotificationsEnabled !== false) {
    const titleByKind: Record<string, string> = {
      "grant-created":  "mailpouch — agent awaiting approval",
      "grant-approved": "mailpouch — agent approved",
      "grant-denied":   "mailpouch — agent denied",
      "grant-revoked":  "mailpouch — agent revoked",
      "grant-expired":  "mailpouch — agent expired",
    };
    const title = titleByKind[ev.kind] ?? "mailpouch";
    const body = `${ev.grant.clientName}`;
    // Fire-and-forget — notifier failures never touch the caller.
    void desktopNotifier.notify({ title, body, sound: ev.kind === "grant-created" ? "Glass" : undefined })
      .catch(() => { /* logged inside notifier */ });
  }
  // Webhooks: dispatch to every enabled endpoint in parallel.
  const endpoints = cfg?.webhooks ?? [];
  if (endpoints.length > 0) {
    void webhookDispatcher.deliverAll(endpoints, ev).catch(err => {
      logger.warn("Webhook deliverAll failed", "Webhooks", err);
    });
  }
});

// ─── Bridge Auto-Start State ──────────────────────────────────────────────────
/** Number of times the watchdog has attempted to revive Bridge. */
let bridgeRestartAttempts = 0;
const BRIDGE_MAX_RESTARTS = 3;
/** Handle returned by setInterval for the bridge watchdog (null when inactive). */
let bridgeWatchdogTimer: ReturnType<typeof setInterval> | null = null;

// ─── Shared mutable state ────────────────────────────────────────────────────
// Referenced by both the tool handlers (via ToolCallContext.state) and
// non-handler code (main(), watchdog, tray, gracefulShutdown). Keeping a
// single object means there's one source of truth even though the symbol
// crosses the module boundary.
const sharedState: ToolSharedState = {
  // Flipped true when this process launched Proton Bridge; triggers kill on shutdown.
  bridgeAutoStarted: false,
  // Tracks the result of the last SMTP verify attempt so get_connection_status
  // returns an honest answer instead of a hardcoded `true`.
  smtpStatus: { connected: false, lastCheck: new Date(0) },
  analyticsCache: null,
  analyticsCacheInflight: null,
};

// ─── Analytics TTL Cache ──────────────────────────────────────────────────────

const ANALYTICS_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Fetch inbox + sent emails, update the analytics service, and cache the result.
 * Concurrent cache-miss callers share a single in-flight fetch to avoid a stampede.
 */
async function getAnalyticsEmails(): Promise<{ inbox: EmailMessage[]; sent: EmailMessage[] }> {
  const now = Date.now();
  const cached = sharedState.analyticsCache;
  if (cached && now - cached.fetchedAt < ANALYTICS_CACHE_TTL_MS) {
    return { inbox: cached.inbox, sent: cached.sent };
  }
  if (sharedState.analyticsCacheInflight) return sharedState.analyticsCacheInflight;
  sharedState.analyticsCacheInflight = (async () => {
    try {
      const [inbox, sent] = await Promise.all([
        imapService.getEmails("INBOX", 200),
        imapService.getEmails("Sent", 100).catch(() => [] as EmailMessage[]),
      ]);
      sharedState.analyticsCache = { inbox: trimForAnalytics(inbox), sent: trimForAnalytics(sent), fetchedAt: Date.now() };
      analyticsService.updateEmails(trimForAnalytics(inbox), trimForAnalytics(sent));
      return { inbox, sent };
    } finally {
      sharedState.analyticsCacheInflight = null;
    }
  })();
  return sharedState.analyticsCacheInflight;
}

// ─── Cursor-Based Pagination ──────────────────────────────────────────────────

interface EmailCursor {
  folder: string;
  offset: number;
  limit: number;
}

function encodeCursor(c: EmailCursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(token: string): EmailCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(token, "base64url").toString());
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      typeof parsed.folder === "string" &&
      typeof parsed.offset === "number" && parsed.offset >= 0 &&
      typeof parsed.limit === "number" && parsed.limit >= 1 && parsed.limit <= 200
    ) {
      // Validate folder to prevent path traversal via crafted cursor tokens.
      if (validateTargetFolder(parsed.folder) !== null) return null;
      return parsed as EmailCursor;
    }
    return null;
  } catch {
    return null;
  }
}

// ─── Constants ────────────────────────────────────────────────────────────────

/** Maximum number of email IDs accepted by any bulk operation. */
const MAX_BULK_IDS = 200;

// ─── Safe Error Messages ──────────────────────────────────────────────────────

function safeErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "An error occurred";
  // McpError instances originate from our own validated handlers — their
  // messages are already safe to surface directly to the caller.
  if (error instanceof McpError) return error.message;
  const msg = error.message.toLowerCase();
  if (
    msg.includes("invalid email") ||
    msg.includes("invalid reply") ||
    msg.includes("invalid email id") ||
    msg.includes("invalid folder") ||
    msg.includes("control char")
  )
    return error.message;
  if (msg.includes("not found")) return "Resource not found";
  if (msg.includes("smtp") || msg.includes("send") || msg.includes("delivery"))
    return "Email delivery failed";
  if (
    msg.includes("imap") ||
    msg.includes("connect") ||
    msg.includes("mailbox") ||
    msg.includes("login")
  )
    return "IMAP operation failed";
  if (
    msg.includes("protected folder") ||
    msg.includes("already exists") ||
    msg.includes("not empty") ||
    msg.includes("does not exist")
  )
    return error.message;
  if (msg.includes("at least one recipient") || msg.includes("required")) return error.message;
  return "An error occurred";
}

/**
 * Diagnostic error message — preserves error codes for internal status tracking
 * (SMTP/IMAP connection status, debug logs).  NOT for client-facing tool error
 * responses; use safeErrorMessage() for those.
 */
function diagnosticErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown error";
  const parts: string[] = [];
  const e = error as { code?: unknown; command?: unknown; responseCode?: unknown };
  if (e.code) parts.push(`code=${e.code}`);
  if (e.command) parts.push(`command=${e.command}`);
  if (e.responseCode) parts.push(`responseCode=${e.responseCode}`);
  // First line of message, email addresses redacted to prevent leaking usernames.
  const firstLine = error.message.split("\n")[0].replace(/[\w.-]+@[\w.-]+/g, "<redacted>");
  parts.push(firstLine.substring(0, 200));
  return parts.join("; ");
}

// ─── Prompt Body Truncation ───────────────────────────────────────────────────

/**
 * Truncate an email body before embedding it in a prompt message.
 * Prevents prompt token explosion from large HTML emails and limits the
 * attack surface for prompt injection via malicious email content.
 */
function truncateEmailBody(body: string, maxLength: number = 2000): string {
  if (!body || body.length <= maxLength) return body;
  return body.substring(0, maxLength) + "\n\n[...body truncated at " + maxLength + " chars — use get_email_by_id for full content]";
}

// ─── MCP Server ───────────────────────────────────────────────────────────────

const server = new Server(
  { name: "mailpouch", version: _pkgVersion },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    },
  }
);

// ═════════════════════════════════════════════════════════════════════════════
// TOOLS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resolve the active tool tier at the moment of the ListTools call. Order:
 *   1. MAILPOUCH_TIER env var (per-launch override)
 *   2. config.toolTier (persisted)
 *   3. "complete" (default — preserves pre-tiering behavior)
 */
function activeToolTier(): ReturnType<typeof parseToolTier> {
  const envTier = process.env.MAILPOUCH_TIER
    || process.env.PM_BRIDGE_MCP_TIER
    || process.env.PROTONMAIL_MCP_TIER;
  if (envTier) return parseToolTier(envTier);
  const cfg = loadConfig();
  return parseToolTier(cfg?.toolTier);
}

server.setRequestHandler(ListToolsRequestSchema, async () => {
  const tier = activeToolTier();
  const visible = toolsForTier(tier);
  logger.debug(`Listing tools (tier=${tier}, visible=${visible.size})`, "MCPServer");
  // The registry emits every tool definition in the historical order
  // (sending → reading-early → folders → actions → deletion → analytics →
  // system → bridge → aliases → pass → drafts → reading-late → escalation).
  // The dynamic description for request_permission_escalation has to be
  // re-stamped with the live settings port, which depends on the current
  // config snapshot — everything else is static.
  const defs = allToolDefs().map(def =>
    def.name === "request_permission_escalation"
      ? { ...def, description: describeRequestEscalation(config.settingsPort ?? 8765) }
      : def,
  );
  return { tools: defs.filter(t => visible.has(t.name)) };
});

// ─── Tool Handlers ────────────────────────────────────────────────────────────
// The CallTool request handler resolves the account routing, runs the
// permission / agent-grant / destructive-confirm gates, and then dispatches
// to the per-category handler registered in src/tools/registry.ts.
// Pre-gate meta-tools (request_permission_escalation + check_escalation_status)
// bypass the gate chain — they can never GRANT access, only request it.

const _toolHandlers = allHandlers();
const _escalationHandlers = escalationHandlers();

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  return tracer.span('mcp.tool_call', { tool: name, argCount: Object.keys(args).length }, async () => {
  const progressToken = request.params._meta?.progressToken;

  const { body: _b, attachments: _a, password: _p, ...safeArgs } = args as Record<string, unknown>;
  logger.debug(`Tool: ${name}`, "MCPServer", safeArgs);

  // ── Always-available meta-tools (bypass permission gate) ─────────────────
  // These tools let the agent REQUEST more access — but they can never GRANT it.
  // Approval is strictly out-of-band (settings UI browser click or terminal).
  if (_escalationHandlers[name]) {
    return _escalationHandlers[name]({ args, config });
  }

  // ── Per-tool account routing ─────────────────────────────────────────────
  // The dispatcher resolves an optional `account_id` argument before the
  // gates so audit rows and permission checks both see the correct account.
  // If an agent grant is bound to a specific account (conditions.accountId),
  // the caller's requested account_id must match.
  const requestedAccountId = typeof args.account_id === "string" && args.account_id.trim()
    ? args.account_id.trim()
    : accountManager.activeAccountId();
  let routedImapService: SimpleIMAPService = accountManager.getActive().imap;
  let routedSmtpService: SMTPService = accountManager.getActive().smtp;
  try {
    const svcs = accountManager.getForAccount(requestedAccountId);
    routedImapService = svcs.imap;
    routedSmtpService = svcs.smtp;
  } catch {
    return {
      content: [{ type: "text" as const, text: `Unknown account_id: ${requestedAccountId}` }],
      isError: true,
      structuredContent: { success: false, reason: "unknown_account_id", requestedAccountId },
    };
  }

  // ── Agent-grant gate ──────────────────────────────────────────────────────
  // Runs BEFORE the global permission gate. Only takes effect when the call
  // carries caller context (i.e. came in through the HTTP transport with an
  // OAuth client_id). Stdio callers — the Claude Desktop default — fall
  // through and are gated only by the global preset, preserving single-user
  // behavior for anyone who hasn't opted into multi-agent mode.
  const caller = currentCaller();
  const callStartedAt = Date.now();
  // Flipped true in the catch so the finally success path is skipped.
  let auditFailureRecorded = false;
  if (caller && !caller.staticBearer) {
    const callerGrant = agentGrants.get(caller.clientId);
    const boundAccountId = callerGrant?.conditions?.accountId;
    if (boundAccountId && boundAccountId !== requestedAccountId) {
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: false,
        durMs: Date.now() - callStartedAt,
        blockedReason: `Grant is bound to account ${boundAccountId}; call targeted ${requestedAccountId}.`,
        ip: caller.ip,
      });
      auditFailureRecorded = true;
      return {
        content: [{ type: "text" as const, text: `Blocked: this agent's grant is bound to account ${boundAccountId}.` }],
        isError: true,
        structuredContent: { success: false, reason: "account_mismatch", expected: boundAccountId, requested: requestedAccountId },
      };
    }

    const globalPreset = (loadConfig() ?? defaultConfig()).permissions.preset;
    const grantResult = grantManager.check({
      clientId: caller.clientId,
      tool: name,
      args: args as Record<string, unknown>,
      callerIp: caller.ip,
      globalPreset,
    });
    if (!grantResult.allowed) {
      logger.warn(`Agent grant denied '${name}' for ${caller.clientId}`, "AgentGate", { reason: grantResult.reason });
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: false,
        durMs: Date.now() - callStartedAt,
        blockedReason: grantResult.reason,
        ip: caller.ip,
      });
      auditFailureRecorded = true;
      return {
        content: [{ type: "text" as const, text: `Blocked by agent grant: ${grantResult.reason}` }],
        isError: true,
        structuredContent: { success: false, reason: grantResult.reason, clientId: caller.clientId },
      };
    }
  }

  // ── Permission gate ───────────────────────────────────────────────────────
  // Checked against ~/.mailpouch.json (refreshed every 15 s).
  // If no config file exists the read-only preset is enforced — agents can
  // read and search but cannot send, move, delete, or modify email state.
  // Run `npm run settings` to open the settings UI and grant broader access.
  const permResult = permissions.check(name as ToolName);
  if (!permResult.allowed) {
    logger.warn(`Tool blocked by permission policy: ${name}`, "MCPServer", { reason: permResult.reason });
    if (caller && !caller.staticBearer) {
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: false,
        durMs: Date.now() - callStartedAt,
        blockedReason: `preset: ${permResult.reason}`,
        ip: caller.ip,
      });
      auditFailureRecorded = true;
    }
    return {
      content: [{ type: "text" as const, text: `Blocked: ${permResult.reason}` }],
      isError: true,
      structuredContent: { success: false, reason: permResult.reason },
    };
  }

  // ── Destructive-tool confirmation gate ────────────────────────────────────
  // Second-layer protection on top of the permission preset. Keeps the workflow
  // user-initiated per Proton ToS §2.10. Two mutually-compatible paths:
  //   1. MCP elicitation (2025-11-25 spec) — server asks the client to surface
  //      a confirmation dialog; returned when the client advertises the
  //      `elicitation` capability. Zero coupling to the tool's argument shape.
  //   2. { confirmed: true } fallback — preview-then-retry for clients that do
  //      not support elicitation yet. Disable the whole guard by setting
  //      requireDestructiveConfirm: false in the config.
  if (DESTRUCTIVE_TOOLS.has(name) && (loadConfig() ?? defaultConfig()).requireDestructiveConfirm !== false) {
    if (args.confirmed !== true) {
      const preview = describeDestructivePreview(name, args);
      const caps = server.getClientCapabilities();
      if (caps?.elicitation) {
        try {
          const result = await server.elicitInput({
            message: `Please confirm this destructive operation:\n\n${preview}`,
            // Empty schema → the client renders a plain accept/decline prompt.
            requestedSchema: { type: "object", properties: {} },
          });
          if (result.action !== "accept") {
            logger.info(`Destructive tool '${name}' cancelled via elicitation (${result.action})`, "MCPServer");
            return {
              content: [{ type: "text" as const, text: `Cancelled: user ${result.action}d the confirmation prompt for '${name}'.` }],
              isError: false,
              structuredContent: { success: false, cancelled: true, action: result.action, tool: name },
            };
          }
          logger.info(`Destructive tool '${name}' confirmed via elicitation`, "MCPServer");
        } catch (err: unknown) {
          // Elicitation advertised but request failed (network, protocol drift).
          // Fall through to the arg-based gate — never execute silently.
          logger.warn(`Elicitation request failed for '${name}', falling back to { confirmed: true } gate`, "MCPServer", err);
          return confirmGateFallbackResponse(name, preview);
        }
      } else {
        return confirmGateFallbackResponse(name, preview);
      }
    } else {
      logger.info(`Destructive tool '${name}' executing with { confirmed: true }`, "MCPServer");
    }
  }

  // Response-size limits — hot-reloaded from config every 15 s.
  const _limits = permissions.getResponseLimits();

  function ok(structured: Record<string, unknown>, text?: string) {
    const jsonText = text ?? JSON.stringify(structured);
    const byteLen = Buffer.byteLength(jsonText, "utf-8");

    // Observability: always log size at debug level.
    logger.debug(`Tool '${name}' response: ${byteLen} bytes (${Math.round(byteLen / 1024)} KB)`, "ResponseGuard");

    if (_limits.warnOnLargeResponse && byteLen > _limits.maxResponseBytes * 0.8) {
      logger.warn(
        `Tool '${name}' response is ${Math.round(byteLen / 1024)} KB — approaching limit of ${Math.round(_limits.maxResponseBytes / 1024)} KB`,
        "ResponseGuard",
      );
    }

    if (byteLen > _limits.maxResponseBytes) {
      logger.error(
        `Tool '${name}' response exceeds limit: ${byteLen} bytes > ${_limits.maxResponseBytes} bytes`,
        "ResponseGuard",
      );
      const errorStructured = {
        success: false,
        reason: `Response too large (${Math.round(byteLen / 1024)} KB). Reduce scope, use pagination, or increase the limit in Settings → Debug Logs → Response Limits.`,
        sizeBytes: byteLen,
        limitBytes: _limits.maxResponseBytes,
      };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(errorStructured) }],
        structuredContent: errorStructured,
        isError: true,
      };
    }

    return {
      content: [{ type: "text" as const, text: jsonText }],
      structuredContent: structured,
    };
  }


  function actionOk(messageId?: string) {
    const sc = { success: true, ...(messageId ? { messageId } : {}) };
    return ok(sc, messageId ? `Sent. Message ID: ${messageId}` : "Done.");
  }

  function bulkOk(result: { success: number; failed: number; errors: string[] }) {
    return ok(result, `Completed: ${result.success} succeeded, ${result.failed} failed.${result.errors.length ? " Errors: " + result.errors.slice(0, 5).join("; ") : ""}`);
  }

  async function sendProgress(progress: number, total: number, message: string) {
    if (!progressToken) return;
    await server.notification({
      method: "notifications/progress",
      params: { progressToken, progress, total, message },
    });
  }

  // RFC 2822 §2.1.1 hard limit: a single header line MUST NOT exceed 998 chars.
  // Enforced for the 'subject' field in send_email, save_draft, and schedule_email.
  const MAX_SUBJECT_LENGTH = 998;
  // Upper bound on outbound email body length.  100 MB bodies would exhaust
  // Node.js heap and cause silent OOM or SMTP timeout.  10 MB is well above
  // any legitimate use case (typical email bodies are <100 KB); Proton Bridge
  // itself enforces a lower limit but the handler-level guard gives the caller
  // a clear McpError(InvalidParams) rather than an opaque delivery failure.
  const MAX_BODY_LENGTH = 10 * 1024 * 1024; // 10 MB

  try {
    const handler = _toolHandlers[name];
    if (!handler) {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    const ctx: ToolCallContext = {
      args: args as Record<string, unknown>,
      imapService: routedImapService,
      smtpService: routedSmtpService,
      simpleloginService,
      analyticsService,
      schedulerService,
      reminderService,
      passService,
      getFts,
      config,
      limits: _limits,
      ok,
      actionOk,
      bulkOk,
      sendProgress,
      encodeCursor,
      decodeCursor,
      getAnalyticsEmails,
      recordFromEmail,
      launchProtonBridge,
      killProtonBridge,
      isBridgeReachable,
      gracefulShutdown,
      safeErrorMessage,
      MAX_BULK_IDS,
      MAX_BODY_LENGTH,
      MAX_SUBJECT_LENGTH,
      state: sharedState,
    };
    return await handler(ctx);
  } catch (error: unknown) {
    logger.error(`Tool failed: ${name}`, "MCPServer", error);
    const msg = safeErrorMessage(error);
    auditFailureRecorded = true;
    if (caller && !caller.staticBearer) {
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: false,
        durMs: Date.now() - callStartedAt,
        blockedReason: msg,
        ip: caller.ip,
      });
    }
    return {
      content: [{ type: "text" as const, text: `Error: ${msg}` }],
      structuredContent: { success: false, reason: msg },
      isError: true,
    };
  } finally {
    // Success audit: when the try block exited via a normal return (no
    // catch ran), the call completed successfully. We can't observe the
    // response contents from here (each case returns directly), but the
    // agent-audit channel intentionally avoids logging response bodies —
    // we just need the fact of the call and its duration.
    if (!auditFailureRecorded && caller && !caller.staticBearer) {
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: true,
        durMs: Date.now() - callStartedAt,
        ip: caller.ip,
      });
      agentGrants.recordCall(caller.clientId);
    }
  }
  }); // end tracer.span('mcp.tool_call')
});

// ═════════════════════════════════════════════════════════════════════════════
// RESOURCES
// ═════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Expose the INBOX folder as a listable resource; agents can also use templates for specific emails
  try {
    const folders = await imapService.getFolders();
    return {
      resources: folders.map((f) => ({
        uri: `folder://${encodeURIComponent(f.path)}`,
        name: f.name,
        title: `${f.name} (${f.unreadMessages} unread / ${f.totalMessages} total)`,
        description: `Email folder: ${f.path}`,
        mimeType: "application/json",
        annotations: { audience: ["assistant"] as ("assistant" | "user")[] },
      })),
    };
  } catch {
    return { resources: [] };
  }
});

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "email://{folder}/{id}",
      name: "Email Message",
      title: "Individual Email",
      description:
        "Full content of a specific email. folder = IMAP folder path (e.g. INBOX), id = numeric UID from get_emails.",
      mimeType: "application/json",
    },
    {
      uriTemplate: "folder://{path}",
      name: "Email Folder",
      title: "Email Folder",
      description:
        "Folder metadata and message counts. path = URL-encoded folder path (e.g. INBOX, Folders%2FWork).",
      mimeType: "application/json",
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  return tracer.span('mcp.resource_read', { uri: request.params.uri }, async () => {
  const { uri } = request.params;

  // email://{folder}/{id}
  const emailMatch = uri.match(/^email:\/\/([^/]+)\/(\d+)$/);
  if (emailMatch) {
    let folder: string;
    try {
      folder = decodeURIComponent(emailMatch[1]);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Malformed percent-encoding in resource URI: ${uri}`);
    }
    const id = emailMatch[2];
    const email = await imapService.getEmailById(id);
    if (!email) {
      throw new McpError(ErrorCode.InvalidRequest, `Email not found: ${uri}`);
    }
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(email, null, 2),
          annotations: {
            audience: ["assistant"] as ("assistant" | "user")[],
            priority: 0.9,
            lastModified: email.date instanceof Date ? email.date.toISOString() : String(email.date),
          },
        },
      ],
    };
  }

  // folder://{path}
  const folderMatch = uri.match(/^folder:\/\/(.+)$/);
  if (folderMatch) {
    let path: string;
    try {
      path = decodeURIComponent(folderMatch[1]);
    } catch {
      throw new McpError(ErrorCode.InvalidRequest, `Malformed percent-encoding in resource URI: ${uri}`);
    }
    const folders = await imapService.getFolders();
    const folder = path === ""
      ? null  // list-all case
      : folders.find((f) => f.path === path || f.name === path);

    if (path !== "" && !folder) {
      throw new McpError(ErrorCode.InvalidRequest, `Folder not found: ${path}`);
    }

    const payload = path === "" ? { folders } : folder;
    return {
      contents: [
        {
          uri,
          mimeType: "application/json",
          text: JSON.stringify(payload, null, 2),
          annotations: { audience: ["assistant"] as ("assistant" | "user")[], priority: 0.7 },
        },
      ],
    };
  }

  throw new McpError(ErrorCode.InvalidRequest, `Unsupported resource URI: ${uri}`);
  }); // end tracer.span('mcp.resource_read')
});

// ═════════════════════════════════════════════════════════════════════════════
// PROMPTS
// ═════════════════════════════════════════════════════════════════════════════

server.setRequestHandler(ListPromptsRequestSchema, async () => ({
  prompts: [
    {
      name: "triage_inbox",
      title: "Triage Inbox",
      description:
        "Review unread emails, assess urgency, and suggest actions (reply / archive / delete / snooze). Uses available tools to act on approved decisions.",
      arguments: [
        { name: "limit", description: "Max emails to review (default 20)", required: false },
        { name: "focus", description: "Sender or topic to prioritize", required: false },
      ],
    },
    {
      name: "compose_reply",
      title: "Compose Reply",
      description: "Draft a reply to a specific email, preserving thread context and tone.",
      arguments: [
        { name: "emailId", description: "UID of the email to reply to", required: true },
        { name: "intent", description: "What the reply should say or accomplish", required: false },
      ],
    },
    {
      name: "daily_briefing",
      title: "Daily Email Briefing",
      description:
        "Summarize today's inbox: unread count, key senders, action items, and any calendar or deadline mentions.",
      arguments: [],
    },
    {
      name: "find_subscriptions",
      title: "Find Subscriptions & Newsletters",
      description:
        "Identify bulk sender / newsletter / subscription emails in the inbox and offer to archive or delete them.",
      arguments: [
        { name: "folder", description: "Folder to search (default: INBOX)", required: false },
      ],
    },
    {
      name: "thread_summary",
      title: "Summarize Email Thread",
      description:
        "Fetch all messages related to a thread and produce a concise summary with open action items.",
      arguments: [
        { name: "emailId", description: "UID of any message in the thread", required: true },
      ],
    },
    {
      name: "draft_in_my_voice",
      title: "Draft Email in My Voice",
      description:
        "Draft a new email to a specific recipient in the user's own voice, using a handful of their recent sent emails as tone samples. The LLM infers style (formality, greeting/sign-off habits, typical length) from the samples rather than guessing.",
      arguments: [
        { name: "recipient", description: "Email address to draft to", required: true },
        { name: "intent", description: "What the email should say or accomplish", required: true },
        { name: "sampleCount", description: "How many recent sent emails to include as tone samples (default 5, max 20)", required: false },
      ],
    },
  ],
}));

server.setRequestHandler(GetPromptRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  switch (name) {
    case "triage_inbox": {
      const rawLimit = parseInt((args.limit as string) || "20", 10);
      const limit = isNaN(rawLimit) ? 20 : Math.min(Math.max(1, rawLimit), 100);
      // Sanitize agent-supplied focus to prevent prompt injection.
      const focus = args.focus ? sanitizeText(args.focus as string, 200) : undefined;
      let emails: EmailMessage[] = [];
      try {
        emails = await imapService.getEmails("INBOX", limit);
      } catch { /* IMAP not connected — prompt will still guide the user */ }
      const unread = emails.filter((e) => !e.isRead);

      return {
        description: "Inbox triage session",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `You are managing a Proton Mail inbox. ${focus ? `Prioritise emails from/about: ${focus}.` : ""}

${unread.length > 0
  ? `Here are ${unread.length} unread emails to review:\n\n${JSON.stringify(
      unread.map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        hasAttachment: e.hasAttachment,
        preview: e.bodyPreview,
      })),
      null,
      2
    )}`
  : "The inbox appears empty or could not be loaded. Use get_emails to fetch emails first."}

For each email, assess:
1. Urgency: urgent / normal / low
2. Suggested action: reply_needed / archive / delete / forward / snooze
3. If reply_needed: one-sentence draft response

After presenting your assessment, wait for the user to approve actions, then use the available tools (reply_to_email, archive_email, delete_email, move_email) to carry them out.`,
            },
          },
        ],
      };
    }

    case "compose_reply": {
      // Validate emailId early so we never embed an adversarial string in the prompt.
      const emailId = requireNumericEmailId(args.emailId);
      // Sanitize agent-supplied intent to prevent prompt injection.
      const intent = sanitizeText(args.intent, 200);
      let emailContent = "Could not load email — use get_email_by_id to fetch it first.";
      try {
        const email = await imapService.getEmailById(emailId);
        if (email) {
          emailContent = JSON.stringify(
            {
              from: email.from,
              subject: email.subject,
              date: email.date,
              // Body is truncated to prevent prompt token explosion and injection risk.
              // Full content is available via get_email_by_id if needed.
              body: truncateEmailBody(email.body, 2000),
            },
            null,
            2
          );
        }
      } catch { /* ignore */ }

      return {
        description: "Compose a reply",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Draft a reply to the following email${intent ? ` with this intent: ${intent}` : ""}.

Match the tone and formality of the original. Keep it concise.

Original email:
${emailContent}

When ready, use reply_to_email with emailId="${emailId}" to send.`,
            },
          },
        ],
      };
    }

    case "daily_briefing": {
      let emails: EmailMessage[] = [];
      try {
        emails = await imapService.getEmails("INBOX", 50);
      } catch { /* ignore */ }

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const todayEmails = emails.filter(
        (e) => e.date && new Date(e.date) >= today
      );
      const unread = emails.filter((e) => !e.isRead);

      return {
        description: "Daily email briefing",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Produce a concise daily briefing for this inbox.

Total unread: ${unread.length}
Emails arriving today: ${todayEmails.length}

${emails.length > 0
  ? `Most recent emails:\n${JSON.stringify(
      emails.slice(0, 20).map((e) => ({
        id: e.id,
        from: e.from,
        subject: e.subject,
        date: e.date,
        isRead: e.isRead,
        preview: e.bodyPreview,
      })),
      null,
      2
    )}`
  : "No emails loaded. Use get_emails to fetch inbox."}

Structure the briefing as:
- Summary (2-3 sentences)
- Key contacts / senders
- Action items requiring reply
- FYI / informational only
- Anything that looks time-sensitive`,
            },
          },
        ],
      };
    }

    case "find_subscriptions": {
      const rawFsFolder = (args.folder as string) || "INBOX";
      // Validate before embedding in prompt text to prevent prompt injection.
      const fsFolderErr = validateTargetFolder(rawFsFolder);
      if (fsFolderErr) throw new McpError(ErrorCode.InvalidParams, fsFolderErr);
      const folder = rawFsFolder;
      let emails: EmailMessage[] = [];
      try {
        emails = await imapService.getEmails(folder, 100);
      } catch { /* ignore */ }

      // Cap at 50 entries and truncate subjects to prevent prompt size explosion
      const emailSummaries = emails.slice(0, 50).map((e) => ({
        id: e.id,
        from: e.from.substring(0, 100),
        subject: (e.subject || "").substring(0, 120),
        date: e.date,
      }));

      return {
        description: "Find and manage subscriptions",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Review these ${emailSummaries.length} emails from ${folder} and identify bulk senders, newsletters, and subscription emails.

${JSON.stringify(emailSummaries, null, 2)}

Group them by sender domain and present a list of:
1. Confirmed subscriptions / newsletters (safe to archive or delete)
2. Transactional emails (receipts, notifications — keep or archive)
3. Personal / important emails (do not touch)

After the user reviews, use bulk_delete_emails or bulk_move_emails to take action on approved groups.`,
            },
          },
        ],
      };
    }

    case "thread_summary": {
      // Validate emailId early to prevent prompt injection via a crafted ID string.
      const emailId = requireNumericEmailId(args.emailId);
      let emailContent = "Could not load the email.";
      try {
        const email = await imapService.getEmailById(emailId);
        if (email) {
          // Truncate body to prevent prompt token explosion and injection risk.
          const safeEmail = {
            ...email,
            body: truncateEmailBody(email.body, 2000),
            attachments: email.attachments?.map(a => ({ filename: a.filename, contentType: a.contentType, size: a.size })),
          };
          emailContent = JSON.stringify(safeEmail, null, 2);
        }
      } catch { /* ignore */ }

      return {
        description: "Summarize email thread",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Summarize the following email thread. If there are earlier messages referenced, use search_emails to find them (search by subject or sender).

Starting email (ID: ${emailId}):
${emailContent}

Produce:
- One-paragraph summary of the conversation
- Key decisions or agreements made
- Open questions or action items
- Who needs to respond next (if applicable)`,
            },
          },
        ],
      };
    }

    case "draft_in_my_voice": {
      // Recipient must look like an email address — sanitize then validate.
      const rawRecipient = sanitizeText(args.recipient, 254);
      if (!isValidEmail(rawRecipient)) {
        throw new McpError(ErrorCode.InvalidParams, "recipient must be a valid email address.");
      }
      const recipient = rawRecipient;
      // Intent flows into the prompt body verbatim — sanitize against prompt
      // injection the same way compose_reply handles its intent arg.
      const intent = sanitizeText(args.intent, 500);
      if (!intent) {
        throw new McpError(ErrorCode.InvalidParams, "intent must be a non-empty string.");
      }
      const rawCount = parseInt((args.sampleCount as string) || "5", 10);
      const sampleCount = isNaN(rawCount) ? 5 : Math.min(Math.max(1, rawCount), 20);

      let samples: Array<{ subject: string; bodyPreview: string }> = [];
      try {
        const sent = await imapService.getEmails("Sent", sampleCount);
        samples = sent.map(e => ({
          subject: e.subject || "(No Subject)",
          // Use bodyPreview (~300 chars) — full bodies would blow up the prompt
          // and would leak far more than needed to demonstrate tone.
          bodyPreview: e.bodyPreview ?? truncateEmailBody(e.body, 400),
        }));
      } catch { /* Sent folder unreachable — prompt will still guide the model */ }

      const samplesBlock = samples.length > 0
        ? JSON.stringify(samples, null, 2)
        : "[no sent emails loaded — tone will have to be inferred from context only]";

      return {
        description: "Draft an email in the user's voice",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Draft a new email to ${recipient}.

Intent: ${intent}

Study the following ${samples.length} recent emails the user has sent and match their voice — formality level, greeting and sign-off conventions, typical sentence length, and word choices. Do not copy phrasing wholesale; infer style and write a fresh message.

Recent sent emails (tone samples):
${samplesBlock}

When drafting, produce:
1. A suggested subject line
2. The body of the new email

Then, if the user approves, use send_email with to="${recipient}" to send it.`,
            },
          },
        ],
      };
    }

    default:
      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// STARTUP & LIFECYCLE
// ═════════════════════════════════════════════════════════════════════════════

/** Test whether a TCP connection can be established to host:port within timeoutMs. */
async function isBridgeReachable(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise(resolve => {
    const sock = createConnection({ host, port });
    const timer = setTimeout(() => { sock.destroy(); resolve(false); }, timeoutMs);
    sock.on('connect', () => { clearTimeout(timer); sock.destroy(); resolve(true); });
    sock.on('error', () => { clearTimeout(timer); resolve(false); });
  });
}

/** Launch Proton Bridge using the platform-appropriate command, then wait up to 15 s for ports. */
async function launchProtonBridge(): Promise<void> {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  let useShell = false;
  // Strip surrounding quotes that users sometimes paste in (e.g. from explorer)
  if (config.bridgePath) {
    config.bridgePath = config.bridgePath.trim().replace(/^["']|["']$/g, "");
  }
  // User-configured path takes top priority
  if (config.bridgePath && existsSync(config.bridgePath)) {
    try {
      spawn(config.bridgePath, [], { stdio: "ignore", detached: true, shell: false }).unref();
      logger.info("Proton Bridge launch command sent — waiting up to 15 s for ports to open…", "MCPServer");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, 1500));
        const [smtpOk, imapOk] = await Promise.all([
          isBridgeReachable(config.smtp.host, config.smtp.port),
          isBridgeReachable(config.imap.host, config.imap.port),
        ]);
        if (smtpOk && imapOk) {
          logger.info("Proton Bridge is now reachable", "MCPServer");
          sharedState.bridgeAutoStarted = true;
          bridgeRestartAttempts = 0;
          return;
        }
      }
      logger.warn("Proton Bridge did not become reachable within 15 s — continuing anyway", "MCPServer");
    } catch (e: unknown) {
      logger.warn("Failed to launch Proton Bridge from configured path", "MCPServer", e);
    }
    return;
  }

  if (platform === "win32") {
    // Try known install paths first, then fall back to display-name launch
    const bridgeCandidates = [
      `${homedir()}\\AppData\\Local\\Programs\\Proton Mail Bridge\\bridge.exe`,
      `${homedir()}\\AppData\\Local\\Programs\\bridge\\bridge.exe`,
      "C:\\Program Files\\Proton AG\\Proton Mail Bridge\\proton-bridge.exe",
      "C:\\Program Files\\Proton Mail\\Proton Mail Bridge\\bridge.exe",
      "C:\\Program Files\\Proton\\Proton Mail Bridge\\bridge.exe",
      "C:\\Program Files (x86)\\Proton Mail\\Proton Mail Bridge\\bridge.exe",
    ];
    const found = bridgeCandidates.find(p => existsSync(p));
    if (found) {
      cmd = found;
      args = [];
    } else {
      logger.error(
        "Proton Bridge executable not found. Open the MCP settings page and set the bridge path under Bridge TLS Certificate.",
        "MCPServer"
      );
      return;
    }
  } else if (platform === "darwin") {
    const macCandidates = [
      "/Applications/Proton Mail Bridge.app/Contents/MacOS/Proton Mail Bridge",
      `${homedir()}/Applications/Proton Mail Bridge.app/Contents/MacOS/Proton Mail Bridge`,
    ];
    const macFound = macCandidates.find(p => existsSync(p));
    if (macFound) {
      cmd = macFound;
      args = [];
    } else {
      logger.error(
        "Proton Bridge executable not found. Open the MCP settings page and set the bridge path under Bridge TLS Certificate.",
        "MCPServer"
      );
      return;
    }
  } else {
    const linuxCandidates = [
      "/usr/bin/proton-bridge",
      "/usr/local/bin/proton-bridge",
      `${homedir()}/.local/bin/proton-bridge`,
      "/opt/proton-bridge/proton-bridge",
    ];
    const linuxFound = linuxCandidates.find(p => existsSync(p));
    if (linuxFound) {
      cmd = linuxFound;
      args = [];
    } else {
      logger.error(
        "Proton Bridge executable not found. Open the MCP settings page and set the bridge path under Bridge TLS Certificate.",
        "MCPServer"
      );
      return;
    }
  }
  try {
    spawn(cmd, args, { stdio: "ignore", detached: true, shell: false }).unref();
    logger.info("Proton Bridge launch command sent — waiting up to 15 s for ports to open…", "MCPServer");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, 1500));
      const [smtpOk, imapOk] = await Promise.all([
        isBridgeReachable(config.smtp.host, config.smtp.port),
        isBridgeReachable(config.imap.host, config.imap.port),
      ]);
      if (smtpOk && imapOk) {
        logger.info("Proton Bridge is now reachable", "MCPServer");
        sharedState.bridgeAutoStarted = true;
        bridgeRestartAttempts = 0;
        return;
      }
    }
    logger.warn("Proton Bridge did not become reachable within 15 s — continuing anyway", "MCPServer");
  } catch (e: unknown) {
    logger.warn("Failed to auto-start Proton Bridge", "MCPServer", e);
  }
}

/** Terminate the Proton Bridge process launched by this server. */
async function killProtonBridge(): Promise<void> {
  const platform = process.platform;
  try {
    let killCmd: string;
    let killArgs: string[];
    if (platform === "win32") {
      killCmd = "taskkill";
      killArgs = ["/IM", "proton-bridge.exe", "/F"];
    } else if (platform === "darwin") {
      killCmd = "killall";
      killArgs = ["Proton Mail Bridge"];
    } else {
      killCmd = "pkill";
      killArgs = ["-f", "proton-bridge"];
    }
    await new Promise<void>((resolve) => {
      const p = spawn(killCmd, killArgs, { stdio: "ignore" });
      p.on("close", () => resolve());
      p.on("error", () => resolve());
    });
    logger.info("Proton Bridge terminated", "MCPServer");
  } catch (e: unknown) {
    logger.debug("Could not terminate Proton Bridge", "MCPServer", e);
  }
}

/**
 * Background watchdog — runs every 30 s when autoStartBridge is enabled.
 * If Bridge ports become unreachable it attempts up to BRIDGE_MAX_RESTARTS relaunches.
 * After all attempts are exhausted it logs a critical alert and stops watching.
 */
function startBridgeWatchdog(): void {
  if (bridgeWatchdogTimer) return;
  bridgeWatchdogTimer = setInterval(async () => {
    const [smtpOk, imapOk] = await Promise.all([
      isBridgeReachable(config.smtp.host, config.smtp.port),
      isBridgeReachable(config.imap.host, config.imap.port),
    ]);
    if (smtpOk && imapOk) {
      // Bridge healthy — reset consecutive-failure counter
      if (bridgeRestartAttempts > 0) {
        logger.info("Proton Bridge is reachable again", "MCPServer");
        bridgeRestartAttempts = 0;
      }
      return;
    }

    // Bridge is down
    bridgeRestartAttempts++;
    if (bridgeRestartAttempts > BRIDGE_MAX_RESTARTS) {
      // Already gave up — don't spam logs
      return;
    }

    logger.warn(
      `Proton Bridge went away — restart attempt ${bridgeRestartAttempts}/${BRIDGE_MAX_RESTARTS}`,
      "MCPServer"
    );
    await launchProtonBridge();

    // Try to reconnect IMAP if Bridge came back
    if (bridgeRestartAttempts === 0) {
      // launchProtonBridge reset the counter → it succeeded
      try {
        await imapService.connect(
          config.imap.host, config.imap.port,
          config.imap.username, config.imap.password,
          config.imap.bridgeCertPath, config.imap.secure,
          config.imap.allowInsecureBridge ?? false
        );
        logger.info("IMAP reconnected after Bridge restart", "MCPServer");
      } catch (e: unknown) {
        logger.warn("IMAP reconnect failed after Bridge restart", "MCPServer", e);
      }
    }

    if (bridgeRestartAttempts >= BRIDGE_MAX_RESTARTS) {
      logger.error(
        `Proton Bridge failed to recover after ${BRIDGE_MAX_RESTARTS} restart attempts. ` +
        "Email tools will not work until Bridge is restarted manually. " +
        "Stopping watchdog.",
        "MCPServer"
      );
      process.stderr.write(
        `[mailpouch] CRITICAL: Proton Bridge did not recover after ${BRIDGE_MAX_RESTARTS} restart attempts. ` +
        "Start Bridge manually and restart the MCP server.\n"
      );
      if (bridgeWatchdogTimer) { clearInterval(bridgeWatchdogTimer); bridgeWatchdogTimer = null; }
    }
  }, 30_000).unref();
}

/**
 * Strip body text and attachment binary content from emails before storing
 * in the analytics cache. Prevents unbounded memory growth from large emails.
 */
function trimForAnalytics(emails: EmailMessage[]): EmailMessage[] {
  return emails.map(e => ({
    ...e,
    body: undefined as unknown as string,
    attachments: e.attachments?.map(a => ({ ...a, content: undefined })),
  }));
}

// ─── Daemon: Tray Icon Generation ────────────────────────────────────────────
// Pure-Node PNG + ICO generation — no external dependencies.

function _crc32(buf: Buffer): number {
  const tbl = Array.from({ length: 256 }, (_, i) => {
    let c = i;
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    return c >>> 0;
  });
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ tbl[(crc ^ b) & 0xFF];
  return (~crc) >>> 0;
}

function _pngChunk(type: string, data: Buffer): Buffer {
  const t   = Buffer.from(type, "ascii");
  const len = Buffer.allocUnsafe(4); len.writeUInt32BE(data.length, 0);
  const crc = Buffer.allocUnsafe(4); crc.writeUInt32BE(_crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}

function _makeEnvelopePng(): Buffer {
  const W = 32, H = 32;
  const rowSize = 1 + W * 4;
  const raw = Buffer.allocUnsafe(H * rowSize);
  for (let y = 0; y < H; y++) {
    raw[y * rowSize] = 0;
    for (let x = 0; x < W; x++) {
      const o = y * rowSize + 1 + x * 4;
      raw[o] = 109; raw[o + 1] = 74; raw[o + 2] = 255; raw[o + 3] = 255;
    }
  }
  function setWhite(x: number, y: number) {
    if (x < 0 || x >= W || y < 0 || y >= H) return;
    const o = y * rowSize + 1 + x * 4;
    raw[o] = 255; raw[o + 1] = 255; raw[o + 2] = 255; raw[o + 3] = 255;
  }
  function drawLine(ax: number, ay: number, bx: number, by: number) {
    const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
    const sx = ax < bx ? 1 : -1, sy = ay < by ? 1 : -1;
    let err = dx - dy;
    for (;;) {
      setWhite(ax, ay);
      if (ax === bx && ay === by) break;
      const e2 = 2 * err;
      if (e2 > -dy) { err -= dy; ax += sx; }
      if (e2 <  dx) { err += dx; ay += sy; }
    }
  }
  const x1 = 3, y1 = 9, x2 = 28, y2 = 22;
  for (let x = x1; x <= x2; x++) { setWhite(x, y1); setWhite(x, y2); }
  for (let y = y1; y <= y2; y++) { setWhite(x1, y); setWhite(x2, y); }
  const cx = Math.floor((x1 + x2) / 2);
  const cy = y1 + Math.floor((y2 - y1) * 0.5);
  drawLine(x1, y1, cx, cy);
  drawLine(x2, y1, cx, cy);
  const ihdr = Buffer.allocUnsafe(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    _pngChunk("IHDR", ihdr),
    _pngChunk("IDAT", deflateSync(raw)),
    _pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function _pngToIco(png: Buffer): Buffer {
  const hdr   = Buffer.from([0, 0, 1, 0, 1, 0]);
  const entry = Buffer.allocUnsafe(16);
  entry[0] = 32; entry[1] = 32;
  entry[2] = 0;  entry[3] = 0;
  entry.writeUInt16LE(1,  4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  return Buffer.concat([hdr, entry, png]);
}

const _trayIconPng = _makeEnvelopePng();
const TRAY_ICON_B64 = process.platform === "win32"
  ? _pngToIco(_trayIconPng).toString("base64")
  : _trayIconPng.toString("base64");

// ─── Daemon: Settings Server + Tray State ────────────────────────────────────

let _settingsStop:    (() => Promise<void>) | null = null;
let _settingsEnabled: boolean = false;
let _settingsUrl:     string  = "";
let _trayInstance:    InstanceType<typeof SysTrayClass> | null = null;
const _trayRequire = _createRequire(import.meta.url);

async function _startSettingsServerDaemon(): Promise<void> {
  const port = config.settingsPort ?? 8765;
  const maxAttempts = 5;
  const retryMs     = 1000;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { scheme, stop } = await startSettingsServer(port, false, true /* quiet */);
      _settingsStop    = stop;
      _settingsUrl     = `${scheme}://localhost:${port}`;
      _settingsEnabled = true;
      logger.info(`Settings UI started at ${_settingsUrl}`, "MCPServer");
      return;
    } catch (err: unknown) {
      const isInUse = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
      if (isInUse && attempt < maxAttempts) {
        logger.debug(`Settings UI port ${port} in use, retrying (${attempt}/${maxAttempts})…`, "MCPServer");
        await new Promise(r => setTimeout(r, retryMs));
      } else {
        logger.warn("Settings UI failed to start", "MCPServer", err);
        return;
      }
    }
  }
}

async function _stopSettingsServerDaemon(): Promise<void> {
  if (_settingsStop) {
    try {
      await _settingsStop();
      logger.info("Settings UI stopped", "MCPServer");
    } catch (err: unknown) {
      logger.warn("Settings UI stop error", "MCPServer", err);
    } finally {
      _settingsStop    = null;
      _settingsEnabled = false;
    }
  }
}

function _buildTrayMenu(): SysTrayMenu {
  const sep: MenuItem = { title: "<SEPARATOR>", tooltip: "", enabled: true, checked: false };
  const statusLabel   = sharedState.smtpStatus.connected ? "\u25CF Connected" : "\u25CB Disconnected";
  const emailLabel    = config.smtp.username || "Not configured";
  const pendingCount  = agentGrants.list({ status: "pending" }).length;
  const activeCount   = agentGrants.list({ status: "active" }).length;
  const tooltip = pendingCount > 0
    ? `mailpouch · ${pendingCount} agent(s) awaiting approval`
    : "mailpouch";
  const items: MenuItem[] = [
    { title: "mailpouch", tooltip: "mailpouch daemon", enabled: false, checked: false },
    sep,
    { title: statusLabel, tooltip: "", enabled: false, checked: false },
    { title: emailLabel,  tooltip: "", enabled: false, checked: false },
    ...(pendingCount > 0
      ? [{ title: `\u26A0 ${pendingCount} agent(s) pending`, tooltip: "Open Settings → Agents to approve", enabled: false, checked: false }]
      : []),
    ...(activeCount > 0
      ? [{ title: `\u25CF ${activeCount} agent(s) active`, tooltip: "", enabled: false, checked: false }]
      : []),
    sep,
    ...(_settingsEnabled && _settingsUrl
      ? [{ title: "Open Settings", tooltip: `Open ${_settingsUrl}`, enabled: true, checked: false }]
      : []),
    sep,
    {
      title:   _settingsEnabled ? "Disable Settings UI" : "Enable Settings UI",
      tooltip: _settingsEnabled ? "Stop the settings HTTP server" : "Start the settings HTTP server",
      enabled: true,
      checked: false,
    },
    sep,
    { title: "Quit", tooltip: "Stop the MCP daemon", enabled: true, checked: false },
  ];
  return { icon: TRAY_ICON_B64, title: "", tooltip, items };
}

async function _rebuildTray(): Promise<void> {
  if (!_trayInstance) return;
  try {
    await _trayInstance.sendAction({ type: "update-menu", menu: _buildTrayMenu() });
  } catch (err: unknown) {
    logger.debug("Tray menu update failed", "MCPServer", err);
  }
}

async function _initTray(): Promise<void> {
  type SysTrayConstructor = typeof SysTrayClass;
  let ST: SysTrayConstructor | undefined;
  try {
    ST = (_trayRequire("systray2") as { default: SysTrayConstructor }).default;
  } catch {
    logger.debug("systray2 not installed — tray icon disabled", "MCPServer");
    return;
  }

  try {
    const tray = new ST({ menu: _buildTrayMenu(), debug: false, copyDir: true });

    // Wait for the native tray binary to signal ready
    await tray.ready();
    _trayInstance = tray;
    logger.info("System tray icon active", "MCPServer");

    // Keep the tray menu in sync with grant changes (new pending → badge,
    // approved/revoked → count update). Handler is fire-and-forget; if
    // rebuild fails we swallow to avoid crashing the daemon.
    agentNotifications.subscribe(() => {
      void _rebuildTray().catch(() => { /* swallow */ });
    });

    await tray.onClick((action: { item: MenuItem }) => {
      switch (action.item.title) {
        case "Open Settings":
          openBrowser(_settingsUrl);
          break;
        case "Disable Settings UI":
          _stopSettingsServerDaemon()
            .then(() => _rebuildTray())
            .catch((err: unknown) => logger.warn("Settings disable failed", "MCPServer", err));
          break;
        case "Enable Settings UI":
          _startSettingsServerDaemon()
            .then(() => _rebuildTray())
            .catch((err: unknown) => logger.warn("Settings enable failed", "MCPServer", err));
          break;
        case "Quit":
          gracefulShutdown("tray-quit").catch(() => process.exit(1));
          break;
      }
    });
  } catch (err: unknown) {
    logger.warn("Tray icon failed to start", "MCPServer", err);
    _trayInstance = null;
  }
}

async function main() {
  // Clear log file from previous run so each session starts fresh
  try { writeFileSync(getLogFilePath(), "", "utf8"); } catch { /* ignore */ }

  logger.info(`Starting mailpouch v${_pkgVersion}`, "MCPServer");

  // One-shot migration of legacy keychain service names to 'mailpouch'. Runs
  // BEFORE any loadCredentialsFromKeychain() so the first read hits the new
  // slot. Failures are non-fatal.
  try {
    const legacyResult = await migrateLegacyKeychainEntries();
    if (legacyResult.migrated > 0) {
      logger.info(
        `Keychain: migrated ${legacyResult.migrated} legacy entry(ies) to 'mailpouch'` +
        (legacyResult.conflicts > 0 ? ` (${legacyResult.conflicts} conflict(s) left in place)` : ""),
        "MCPServer",
      );
    }
  } catch (e: unknown) {
    logger.debug("Legacy keychain migration skipped", "MCPServer", e);
  }

  // Migrate plaintext credentials to OS keychain if available
  try {
    const migrated = await migrateCredentials();
    if (migrated) {
      logger.info("Credentials migrated to OS keychain", "MCPServer");
    }
  } catch (e: unknown) {
    logger.debug("Keychain migration skipped (not available or no credentials to migrate)", "MCPServer");
  }

  // Load all connection settings and credentials from config file + OS keychain.
  // Credentials are never read from environment variables.
  try {
    const fileConfig = loadConfig();
    if (fileConfig) {
      const cn = fileConfig.connection;
      config.smtp.host          = cn.smtpHost  || "localhost";
      config.smtp.port          = cn.smtpPort  || 1025;
      config.smtp.secure        = cn.tlsMode === 'ssl';
      config.imap.host          = cn.imapHost  || "localhost";
      config.imap.port          = cn.imapPort  || 1143;
      config.imap.secure        = cn.tlsMode === 'ssl';
      config.smtp.username      = cn.username  || "";
      config.imap.username      = cn.username  || "";
      config.smtp.bridgeCertPath = cn.bridgeCertPath || undefined;
      config.imap.bridgeCertPath = cn.bridgeCertPath || undefined;
      config.smtp.allowInsecureBridge = cn.allowInsecureBridge ?? false;
      config.imap.allowInsecureBridge = cn.allowInsecureBridge ?? false;
      config.debug              = !!cn.debug;
      config.autoStartBridge    = !!cn.autoStartBridge;
      config.bridgePath         = cn.bridgePath || undefined;
      config.settingsPort       = fileConfig.settingsPort ?? 8765;

      // SimpleLogin client — populated from config; stays empty (isConfigured=false) if no key.
      if (cn.simpleloginApiKey) {
        simpleloginService = new SimpleLoginService(
          cn.simpleloginApiKey,
          cn.simpleloginBaseUrl || undefined,
        );
        logger.info("SimpleLogin client configured (alias_* tools active)", "MCPServer");
      }
      logger.setDebugMode(!!cn.debug);
      tracer.setEnabled(!!cn.debug);

      // Proton Pass — constructed only when a PAT is configured. Pass is a
      // credential vault; errors from a missing CLI shouldn't crash the
      // server on startup. Mail tools work fine without it.
      if (cn.passAccessToken) {
        passService = new PassService({
          personalAccessToken: cn.passAccessToken,
          cliPath: cn.passCliPath || undefined,
          auditLogPath: PASS_AUDIT_PATH,
        });
        logger.info("Proton Pass client configured (pass_* tools active)", "MCPServer");
      }

      // Password: keychain takes priority over config file plaintext
      const keychainCreds = await loadCredentialsFromKeychain();
      if (keychainCreds?.password) {
        config.smtp.password = keychainCreds.password;
        config.imap.password = keychainCreds.password;
        logger.debug(`Bridge password loaded from ${keychainCreds.storage}`, "MCPServer");
      } else if (cn.password) {
        config.smtp.password = cn.password;
        config.imap.password = cn.password;
        logger.debug("Bridge password loaded from config file", "MCPServer");
      }
      if (keychainCreds?.smtpToken) {
        config.smtp.smtpToken = keychainCreds.smtpToken;
      } else if (cn.smtpToken) {
        config.smtp.smtpToken = cn.smtpToken;
      }
    } else {
      logger.warn("No config file found — run 'npm run settings' to configure", "MCPServer");
    }
  } catch (e: unknown) {
    logger.warn("Failed to load config file", "MCPServer", e);
  }

  if (!config.smtp.username) {
    logger.warn("No username configured — run 'npm run settings' to set up credentials", "MCPServer");
  }
  if (!config.smtp.password) {
    logger.warn("No password configured — run 'npm run settings' to set up credentials", "MCPServer");
  }

  // Rebuild the SMTP transporter now that credentials and cert path are loaded.
  // SMTPService is constructed at module load time (before config is read), so
  // its initial transporter has an empty password and no Bridge cert.
  smtpService.reinitialize();

  // ── Bridge reachability probe + optional auto-start ───────────────────────
  let [smtpReachable, imapReachable] = await Promise.all([
    isBridgeReachable(config.smtp.host, config.smtp.port),
    isBridgeReachable(config.imap.host, config.imap.port),
  ]);

  if (config.autoStartBridge) {
    if (!smtpReachable || !imapReachable) {
      logger.info("autoStartBridge enabled — Bridge not reachable, attempting to launch…", "MCPServer");
      await launchProtonBridge();
      // Re-probe after launch attempt so the connection step below reflects reality
      [smtpReachable, imapReachable] = await Promise.all([
        isBridgeReachable(config.smtp.host, config.smtp.port),
        isBridgeReachable(config.imap.host, config.imap.port),
      ]);
    } else {
      logger.debug("autoStartBridge enabled — Bridge already running", "MCPServer");
    }
    startBridgeWatchdog();
  }

  if (!smtpReachable || !imapReachable) {
    logger.warn(
      `Proton Bridge does not appear to be running — ${config.smtp.host}:${config.smtp.port} (SMTP) and/or ${config.imap.host}:${config.imap.port} (IMAP) are not reachable. Start Bridge and restart the MCP server.`,
      'MCPServer'
    );
    // Don't exit — continue anyway so the server starts and tools can fail gracefully
  }

  try {
    logger.info("Connecting to SMTP and IMAP…", "MCPServer");
    await Promise.all([
      smtpService.verifyConnection().then(() => {
        sharedState.smtpStatus = { connected: true, lastCheck: new Date() };
        logger.info("SMTP connection verified", "MCPServer");
      }).catch((e: unknown) => {
        sharedState.smtpStatus = { connected: false, lastCheck: new Date(), error: diagnosticErrorMessage(e) };
        logger.warn("SMTP connection failed — sending features limited", "MCPServer", e);
        logger.info("Use your Proton Bridge password (not your Proton Mail account password)", "MCPServer");
      }),
      // Connect IMAP for EVERY configured account so IDLE runs against each
      // mailbox, not just the active one. Per-account failures are logged
      // but do not fail the boot — a single broken account shouldn't stop
      // the others from coming online.
      accountManager.connectAll().then((results) => {
        const ok = results.filter(r => r.ok).length;
        const failed = results.length - ok;
        logger.info(
          `IMAP connections established: ${ok}/${results.length} account(s)${failed > 0 ? ` — ${failed} failed` : ""}`,
          "MCPServer",
        );
        if (failed > 0) {
          logger.info("Ensure Proton Bridge is running and each account's credentials are correct", "MCPServer");
        }
      }),
    ]);

    // Start background IDLE for push cache invalidation
    if (config.debug) {
      logger.debug('Starting IMAP IDLE background watcher', 'MCPServer');
    }
    imapService.startIdle().catch(err => logger.debug('IDLE startup failed', 'MCPServer', err));

    // Start the email scheduler (loads persisted pending emails, begins 60s poll)
    schedulerService.start();

    // ── Background auto-sync ────────────────────────────────────────────────
    if (config.autoSync && (config.syncInterval ?? 0) > 0) {
      const intervalMs = (config.syncInterval as number) * 60 * 1000;
      setInterval(async () => {
        try {
          if (imapService.isActive()) {
            const inbox = await imapService.getEmails('INBOX', 50);
            const sent  = await imapService.getEmails('Sent',  50);
            analyticsService.updateEmails(trimForAnalytics(inbox), trimForAnalytics(sent));
            logger.debug(`Background sync: ${inbox.length} inbox, ${sent.length} sent`, 'Scheduler');

            // FTS incremental upsert — ride the same sync to keep the local
            // search index fresh without a manual fts_rebuild call. Cheap:
            // upsert is idempotent on id and we cap body size at 200 KB.
            // Silently no-ops if better-sqlite3 isn't installed.
            try {
              const fts = getFts();
              fts.upsertMany([...inbox, ...sent].map(recordFromEmail));
            } catch (err: unknown) {
              if (!(err instanceof FtsUnavailableError)) {
                logger.debug('FTS incremental upsert failed', 'Scheduler', err);
              }
            }

            // Auto reply-detection — scan inbox for messages whose
            // In-Reply-To points at a Message-ID we are waiting on, and
            // cancel those reminders. Also drops reminders past their
            // deadline with no match (the user can still see them via
            // list_pending_reminders).
            try {
              const cancelled = reminderService.detectRepliesAndCancel(inbox);
              if (cancelled.length > 0) {
                logger.info(`Auto-cancelled ${cancelled.length} reminder(s) after replies arrived`, 'Scheduler');
              }
            } catch (err: unknown) {
              logger.debug('Reminder reply-detection failed', 'Scheduler', err);
            }
          }
        } catch (e: unknown) {
          logger.debug('Background sync failed', 'Scheduler', e);
        }
      }, intervalMs).unref(); // .unref() so the timer doesn't prevent clean exit
    }

    // Transport selection: HTTP when remoteMode=true in the config (with a
    // bearer token or OAuth), otherwise the default stdio transport that
    // Claude Desktop spawns.
    const loadedCfg = loadConfig();
    const remoteCn = loadedCfg?.connection;
    const hasBearer = !!remoteCn?.remoteBearerToken;
    const hasOAuth  = !!remoteCn?.remoteOauthEnabled && !!remoteCn?.remoteOauthAdminPassword;
    if (remoteCn?.remoteMode && (hasBearer || hasOAuth)) {
      const { startHttpTransport } = await import("./transports/http.js");
      const handle = await startHttpTransport({
        server,
        host: remoteCn.remoteHost || "127.0.0.1",
        port: remoteCn.remotePort ?? 8788,
        path: remoteCn.remotePath || "/mcp",
        bearerToken: remoteCn.remoteBearerToken || "",
        tlsCertPath: remoteCn.remoteTlsCertPath || undefined,
        tlsKeyPath:  remoteCn.remoteTlsKeyPath  || undefined,
        oauthEnabled: !!remoteCn.remoteOauthEnabled,
        oauthAdminPassword: remoteCn.remoteOauthAdminPassword || undefined,
        oauthIssuer: remoteCn.remoteOauthIssuer || undefined,
        rateLimitPerSecond: remoteCn.remoteRateLimitPerSecond ?? undefined,
        rateLimitBurst: remoteCn.remoteRateLimitBurst ?? undefined,
        agentGrants,
      });
      logger.info(`mailpouch started on HTTP transport at ${handle.url}${handle.issuer ? ` (OAuth issuer ${handle.issuer})` : ""}`, "MCPServer");
      (globalThis as unknown as { __mailpouchHttpHandle?: { close(): Promise<void> } }).__mailpouchHttpHandle = handle;
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info("mailpouch started on stdio transport.", "MCPServer");
    }

    // ── Daemon: start settings HTTP server + system tray ───────────────────
    // Both run alongside the MCP stdio transport. stdout is now owned by the
    // MCP protocol, so startSettingsServer is called with quiet=true.
    // Skip when running as a respawn child (stdio:ignore, no real MCP session).
    // Honor any env name from the rename chain — children spawned by older
    // parents may still set PROTONMAIL_MCP_RESPAWN or PM_BRIDGE_MCP_RESPAWN.
    // Any one of them suppresses the daemon side-effects.
    if (!process.env.MAILPOUCH_RESPAWN && !process.env.PM_BRIDGE_MCP_RESPAWN && !process.env.PROTONMAIL_MCP_RESPAWN) {
      await _startSettingsServerDaemon();
      _initTray().catch((err: unknown) => logger.warn("Tray init error", "MCPServer", err));
    }
  } catch (error) {
    logger.error("Server startup failed", "MCPServer", error);
    process.exit(1);
  }
}

process.on("uncaughtException", (error) => {
  logger.error("Uncaught exception", "MCPServer", error);
  // Attempt graceful shutdown (wipes credentials, stops bridge) before exit
  gracefulShutdown("uncaughtException").catch(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled rejection", "MCPServer", reason);
  gracefulShutdown("unhandledRejection").catch(() => process.exit(1));
});

async function gracefulShutdown(signal: string): Promise<void> {
  logger.info(`Received ${signal}, shutting down gracefully...`, "MCPServer");
  try {
    // 0. Stop settings server + tray
    await _stopSettingsServerDaemon();
    if (_trayInstance) {
      try { _trayInstance.kill(false); } catch { /* ignore */ }
      _trayInstance = null;
    }

    // 1. Stop bridge watchdog
    if (bridgeWatchdogTimer) { clearInterval(bridgeWatchdogTimer); bridgeWatchdogTimer = null; }

    // 1. Stop scheduler (persists pending items before close)
    schedulerService.stop();

    // Stop IDLE background watcher
    imapService.stopIdle();

    // 2. Disconnect services
    await imapService.disconnect();
    await smtpService.close();

    // 3. Scrub sensitive data from memory
    imapService.wipeCache();
    analyticsService.wipeData();
    smtpService.wipeCredentials();

    // 4. Wipe top-level config credentials
    if (config?.smtp) {
      config.smtp.password = "";
      config.smtp.username = "";
      config.smtp.smtpToken = "";
    }
    if (config?.imap) {
      config.imap.password = "";
      config.imap.username = "";
    }

    // Kill Proton Bridge if this process launched it
    if (sharedState.bridgeAutoStarted) {
      logger.info("Terminating Proton Bridge (launched by this server)…", "MCPServer");
      await killProtonBridge();
    }

    logger.info("Shutdown complete (memory scrubbed)", "MCPServer");
    process.exit(0);
  } catch (error) {
    logger.error(`Error during ${signal} shutdown`, "MCPServer", error);
    process.exit(1);
  }
}

// Last-resort wipe on any exit path
process.on("exit", () => {
  try {
    imapService.wipeCache();
    analyticsService.wipeData();
    smtpService.wipeCredentials();
  } catch { /* best-effort */ }
});

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

main().catch((error) => {
  logger.error("Fatal server error", "MCPServer", error);
  process.exit(1);
});
