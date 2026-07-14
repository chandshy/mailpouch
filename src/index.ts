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
import { createConnection } from "net";
import { spawn } from "child_process";
import { startSettingsServer } from "./settings/server.js";
import { openBrowser } from "./settings/tui.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { chooseTransport, forceStdioFromEnv } from "./transports/select.js";
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
import { SimpleIMAPService, stripHtml } from "./services/simple-imap-service.js";
import {
  ACCOUNT_MAIL_MUTATION_TOOLS,
  MAILBOX_MUTATION_DEADLINE_MS,
  MAILBOX_MUTATION_TOOLS,
  MailboxMutationDeadlineError,
  SMTP_MUTATION_TOOLS,
  withMailboxMutationDeadline,
} from "./services/mailbox-mutation-deadline.js";
import { SimpleLoginService } from "./services/simplelogin-service.js";
import { SchedulerService } from "./services/scheduler.js";
import { ReminderService } from "./services/reminder-service.js";
import { PassService } from "./services/pass-service.js";
import {
  registerAuxiliaryServiceDisabler,
  registerAuxiliaryServiceRefresher,
} from "./services/auxiliary-service-runtime.js";
import {
  BridgeWatchdogRouteTracker,
  bridgeWatchdogRouteForAccount,
  type BridgeWatchdogRoute,
} from "./services/bridge-watchdog-route.js";
import { ftsRecordFromEmail, type FtsRecord } from "./services/fts-service.js";
import { AgentGrantStore } from "./agents/grant-store.js";
import { GrantManager } from "./agents/grant-manager.js";
import type { AgentGrant } from "./agents/types.js";
import { ServiceAccountStore } from "./agents/service-account-store.js";
import { AgentAuditLog, hashArgs } from "./agents/audit.js";
import { currentCaller, localAgentId, type CallerContext } from "./agents/caller-context.js";
import { registerAgentServices } from "./agents/registry.js";
import { notifications as agentNotifications } from "./agents/notifications.js";
import { shouldAutoOpenApproval } from "./agents/auto-open-approval.js";
import { AccountManager, registerAccountManager, type AccountServices, type AccountsRebuiltEvent } from "./accounts/manager.js";
import { DesktopNotifier } from "./notifications/desktop.js";
import { DesktopPrompt } from "./notifications/desktop-prompt.js";
import { WebhookDispatcher } from "./notifications/webhooks.js";
import { logger, getLogFilePath } from "./utils/logger.js";
import { acquireSingletonLock, releaseSingletonLock } from "./utils/singleton-lock.js";
import { isValidEmail, validateTargetFolder, requireNumericEmailId } from "./utils/helpers.js";
import { classifyError, ConnectionStateError } from "./utils/error-classify.js";
import { permissions } from "./permissions/manager.js";
import { loadConfig, defaultConfig, migrateCredentials, loadCredentialsFromConfigFile, loadCredentialsFromKeychain, loadAuxiliaryCredentialsFromKeychain, getConfigPath } from "./config/loader.js";
import { StartupCredentialAccess } from "./config/startup-credential-access.js";
import { withE2EMailboxIdentity } from "./config/e2e-mailbox-identity.js";
import type { ToolName } from "./config/schema.js";
import {
  DESTRUCTIVE_TOOLS,
  DESTRUCTIVE_DESTINATIONS,
  MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET,
  canonicalToolName,
  toolsForTier,
  parseToolTier,
} from "./config/schema.js";

/**
 * Build a short, user-readable preview of what a destructive tool call would
 * do, based on its arguments. Shown in the confirmation-required response so
 * the user can see the proposed action in their client before approving.
 */
function describeDestructivePreview(tool: string, args: Record<string, unknown>): string {
  switch (tool) {
    case "delete_email":
      return `Would move email with ID ${String(args.emailId ?? "(missing)")} to Trash (recoverable — not a permanent delete).`;
    case "bulk_delete":
    case "bulk_delete_emails": {
      const ids = Array.isArray(args.emailIds) ? args.emailIds : [];
      const preview = ids.slice(0, 5).map(String).join(", ");
      const tail = ids.length > 5 ? `, … +${ids.length - 5} more` : "";
      return `Would move ${ids.length} email(s) to Trash (recoverable — not a permanent delete): [${preview}${tail}].`;
    }
    case "empty_trash":
      return `Would PERMANENTLY delete every message in the Trash mailbox. This cannot be undone.`;
    case "move_to_trash":
      return `Would move email with ID ${String(args.emailId ?? "(missing)")} to Trash.`;
    case "move_to_spam":
      return `Would move email with ID ${String(args.emailId ?? "(missing)")} to Spam.`;
    case "delete_folder":
      return `Would permanently delete folder ${String(args.folderName ?? "(missing)")} and all emails inside it. This cannot be undone.`;
    case "alias_delete":
      return `Would permanently delete SimpleLogin alias ${String(args.aliasId ?? "(missing)")}. This cannot be undone.`;
    case "alias_delete_contact":
      return `Would permanently delete SimpleLogin contact ${String(args.contactId ?? "(missing)")}. This cannot be undone.`;
    case "alias_delete_mailbox":
      return `Would delete SimpleLogin mailbox ${String(args.mailboxId ?? "(missing)")}; linked aliases may also be deleted.`;
    case "pass_get":
      return `Would decrypt Proton Pass item ${String(args.item_id ?? "(missing)")} and return its secret fields to the model.`;
    case "pass_totp":
      return `Would reveal the live TOTP code for Proton Pass item ${String(args.item_id ?? "(missing)")}.`;
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
    isError: true,
  };
}
import { sanitizeText } from "./settings/security.js";
import { tracer } from "./utils/tracer.js";
import { allToolDefs, advertisedToolDefs, allHandlers, escalationHandlers, describeRequestEscalation } from "./tools/registry.js";
import type { ToolCallContext, ToolSharedState } from "./tools/types.js";
import { gatherSetupStatus } from "./diagnostics/setup-status.js";
import { shouldSurfaceGrantToast, shouldSurfaceActionToast } from "./notifications/security-gate.js";
import { resolveInvocation, USAGE } from "./cli/invocation.js";
import { AccountRuntimeRegistry } from "./runtime/account-runtime.js";

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
// below point at whichever account is currently active. An active-account
// transition rebinds every singleton that follows the default account.
// Per-tool routing to a non-active account happens in the dispatcher via a
// local shadow of these names.
const accountManager = new AccountManager();
registerAccountManager(accountManager);
let imapService: SimpleIMAPService = accountManager.getActive().imap;
let smtpService: SMTPService = accountManager.getActive().smtp;
// SimpleLogin client is lazy: constructed empty and reconfigured in main() once
// the API key is loaded. Alias tools check isConfigured() before dispatching.
let simpleloginService = new SimpleLoginService("");

import { ensurePrivateParentDirectory, profileHomeFile } from "./utils/home-path.js";

// Runtime state follows the configuration profile.  A custom
// MAILPOUCH_CONFIG may legitimately run alongside the default profile, so it
// must not share account-owned queues, indexes, or authorization stores.
function profileRuntimeFile(envName: string, basename: string): string {
  const path = profileHomeFile(envName, basename, getConfigPath());
  ensurePrivateParentDirectory(path);
  return path;
}

const SCHEDULER_STORE = profileRuntimeFile("MAILPOUCH_SCHEDULER_STORE", ".mailpouch-scheduled.json");
const schedulerService = new SchedulerService(smtpService, SCHEDULER_STORE);

const REMINDERS_STORE = profileRuntimeFile("MAILPOUCH_REMINDERS", ".mailpouch-reminders.json");
const reminderService = new ReminderService(REMINDERS_STORE);

const PASS_AUDIT_PATH = profileRuntimeFile("MAILPOUCH_PASS_AUDIT", ".mailpouch-pass-audit.jsonl");
let passService: PassService | null = null;

/**
 * Rebuild the immutable SimpleLogin/Pass clients from the latest durable
 * settings.  The settings server calls this through the runtime registry
 * after a successful auxiliary credential, base-URL, or CLI-path save.
 *
 * Each call receives a generation so a slow keychain read from an older save
 * cannot overwrite a newer clear/rotation. Replacing the module references is
 * atomic for newly dispatched calls; an already-running tool keeps its own
 * captured service until it completes.
 */
let auxiliaryServiceRefreshGeneration = 0;
async function refreshAuxiliaryServicesFromConfig(
  startupAccess = new StartupCredentialAccess(process.env, getConfigPath()),
): Promise<void> {
  const generation = ++auxiliaryServiceRefreshGeneration;
  try {
    const cn = loadConfig()?.connection;
    if (!cn) {
      if (generation === auxiliaryServiceRefreshGeneration) {
        simpleloginService = new SimpleLoginService("");
        passService = null;
      }
      return;
    }

    const auxCreds = await startupAccess.readExternal(loadAuxiliaryCredentialsFromKeychain);
    // A newer settings save started another refresh while the keychain call
    // was pending. Its snapshot is authoritative.
    if (generation !== auxiliaryServiceRefreshGeneration) return;

    // The loader merges keychain/config per integration and applies durable
    // partial-write quarantine. Falling back again here would bypass that
    // quarantine and resurrect the credential it deliberately suppressed.
    const effectiveSimpleloginKey = auxCreds?.simpleloginApiKey ?? "";
    const effectivePassPat = auxCreds?.passAccessToken ?? "";
    const source = auxCreds?.storage ?? "config";

    // Always replace, even with empty values: that is what makes an explicit
    // clear revoke the old in-process credentials immediately.
    simpleloginService = new SimpleLoginService(
      effectiveSimpleloginKey,
      cn.simpleloginBaseUrl || undefined,
    );
    passService = effectivePassPat
      ? new PassService({
        personalAccessToken: effectivePassPat,
        cliPath: cn.passCliPath || undefined,
        auditLogPath: PASS_AUDIT_PATH,
      })
      : null;

    if (effectiveSimpleloginKey) {
      logger.info(`SimpleLogin client refreshed (alias_* tools active, source=${source})`, "MCPServer");
    } else {
      logger.info("SimpleLogin client disabled after settings refresh", "MCPServer");
    }
    if (effectivePassPat) {
      logger.info(`Proton Pass client refreshed (pass_* tools active, source=${source})`, "MCPServer");
    } else {
      logger.info("Proton Pass client disabled after settings refresh", "MCPServer");
    }
  } catch (error) {
    // A failed refresh must not leave a recently cleared/rotated credential
    // live in the daemon. Fail closed, then let the settings server surface
    // restartRequired rather than claiming the old service is still current.
    if (generation === auxiliaryServiceRefreshGeneration) {
      simpleloginService = new SimpleLoginService("");
      passService = null;
    }
    throw error;
  }
}

/**
 * Reset is intentionally different from a normal settings refresh: it must
 * never read the keychain again, because cleanup can fail while an old entry
 * remains. Advancing the generation also prevents an older in-flight refresh
 * from restoring a credential after this fail-closed transition.
 */
function disableAuxiliaryServicesForReset(): void {
  ++auxiliaryServiceRefreshGeneration;
  simpleloginService = new SimpleLoginService("");
  passService = null;
  logger.info("SimpleLogin and Proton Pass clients disabled after configuration reset", "MCPServer");
}

registerAuxiliaryServiceRefresher(refreshAuxiliaryServicesFromConfig);
registerAuxiliaryServiceDisabler(disableAuxiliaryServicesForReset);

// The pre-multi-account database has no owner column. AccountRuntimeRegistry
// archives it on first FTS use and creates a private database per account,
// rather than risk attributing decrypted mail to the wrong mailbox.
const LEGACY_FTS_DB_PATH = profileRuntimeFile("MAILPOUCH_FTS_DB", ".mailpouch-fts.db");
const accountRuntime = new AccountRuntimeRegistry({ legacyFtsPath: LEGACY_FTS_DB_PATH });

function recordFromEmail(m: EmailMessage): FtsRecord {
  return ftsRecordFromEmail(
    m,
    stripHtml(m.body ?? m.bodyPreview ?? "").slice(0, 200_000),
  );
}

// ─── Agent-grant system ───────────────────────────────────────────────────────
// Per-agent permission gating for multi-client deployments. Always-on so the
// gate is consistent whether the transport is stdio or HTTP — but stdio
// callers fall through to the global preset (no caller context), which
// preserves the single-user Claude Desktop default.
const AGENT_GRANTS_PATH = profileRuntimeFile("MAILPOUCH_AGENTS", ".mailpouch-agents.json");
const AGENT_AUDIT_PATH = profileRuntimeFile("MAILPOUCH_AGENT_AUDIT", ".mailpouch-agent-audit.jsonl");
const SERVICE_ACCOUNTS_PATH = profileRuntimeFile("MAILPOUCH_SERVICE_ACCOUNTS", ".mailpouch-service-accounts.json");
const OAUTH_TOKENS_PATH = profileRuntimeFile("MAILPOUCH_OAUTH_TOKENS", ".mailpouch-oauth-tokens.json");
// AgentGrantStore derives its SQLite hourly-quota sidecar from this exact
// profile-scoped grants path, so custom profiles and MAILPOUCH_AGENTS overrides
// never accidentally share a rate budget.
const agentGrants = new AgentGrantStore(AGENT_GRANTS_PATH);
const agentAudit = new AgentAuditLog({ path: AGENT_AUDIT_PATH });
const serviceAccounts = new ServiceAccountStore(SERVICE_ACCOUNTS_PATH);
// Service grants are credential-backed: GrantManager fresh-checks this store
// on every authorization decision so a grant orphaned by an interrupted
// cross-file revoke cannot outlive its service-account credential.
const grantManager = new GrantManager(agentGrants, serviceAccounts);
// Each persisted service account is born with an active grant (pre-approved at
// issuance) so its client_credentials login flows through GrantManager like any
// approved agent. Converge on startup so an account edited/re-issued while the
// server was down takes effect.
for (const acct of serviceAccounts.list()) {
  agentGrants.ensureActiveServiceGrant({
    clientId: acct.clientId,
    clientName: acct.clientName,
    preset: acct.preset,
    conditions: acct.conditions,
  });
}
registerAgentServices(agentGrants, agentAudit, serviceAccounts);

// ─── Notification channels (B2) ──────────────────────────────────────────────
// Subscribe an OS desktop notifier and an outbound webhook dispatcher to the
// agent-notification bus. Both read their settings from the ServerConfig on
// every event (no restart needed when toggling / adding endpoints).
const desktopNotifier = new DesktopNotifier();
const desktopPrompt = new DesktopPrompt();
const webhookDispatcher = new WebhookDispatcher();
// Epoch ms the approval window was last auto-opened — throttles a burst of
// registrations so we open at most one tab (it lists all pending agents).
let _lastApprovalOpenAtMs = 0;

/** Fallback path: open the Settings UI Agents tab in the browser for a new
 *  agent (used when the on-screen dialog isn't available / is disabled). */
function _autoOpenApprovalWindow(): void {
  const open = shouldAutoOpenApproval({
    enabled: loadConfig()?.autoOpenApprovalWindow !== false,
    hasDisplay: trayPreconditionSkip() === null,
    settingsEnabled: _settingsEnabled,
    settingsUrl: _settingsUrl,
    nowMs: Date.now(),
    lastOpenedAtMs: _lastApprovalOpenAtMs,
  });
  if (open) {
    _lastApprovalOpenAtMs = Date.now();
    try { openBrowser(`${_settingsUrl}#agents`); }
    catch (err: unknown) { logger.debug("auto-open approval window failed", "MCPServer", err); }
  }
}

agentNotifications.subscribe((ev) => {
  const cfg = loadConfig();
  // A new agent registered → surface a NATIVE on-screen Approve/Deny dialog on
  // the machine where mailpouch runs, so the operator can decide right there
  // (not in a browser tab). On approve/deny we resolve the grant immediately;
  // if no dialog tool is available (headless) or it times out, fall back to the
  // browser approval window (and the pending grant's 5-min TTL still applies).
  let dialogHandlingCreated = false;
  if (ev.kind === "grant-created") {
    const dialogEnabled = cfg?.nativeApprovalDialog !== false && trayPreconditionSkip() === null;
    if (dialogEnabled) {
      dialogHandlingCreated = true;
      const grant = ev.grant;
      const where = String(grant.clientId).startsWith("stdio:")
        ? "local"
        : (grant.registeredFromIp ? `from ${grant.registeredFromIp}` : "remote");
      void desktopPrompt.prompt({
        title: "mailpouch — approve agent?",
        message: `Agent "${grant.clientName}" (${where}) is requesting access to your mailbox.\n\nApprove this connection?`,
      }).then((choice) => {
        if (choice === "approve") {
          const preset = loadConfig()?.permissions?.preset ?? "read_only";
          agentGrants.approve({ clientId: grant.clientId, preset });
          logger.info(`Agent "${grant.clientName}" approved at the on-screen prompt (preset ${preset})`, "MCPServer");
        } else if (choice === "deny") {
          agentGrants.deny(grant.clientId, "Denied at the on-screen prompt");
          logger.info(`Agent "${grant.clientName}" denied at the on-screen prompt`, "MCPServer");
        } else {
          _autoOpenApprovalWindow(); // no dialog tool / timed out → browser fallback
        }
      }).catch(() => { _autoOpenApprovalWindow(); });
    } else {
      _autoOpenApprovalWindow();
    }
  }
  // Desktop notification heads-up. Skip the new-registration toast when the
  // on-screen dialog is already handling it (avoid a redundant double-prompt).
  if (cfg?.desktopNotificationsEnabled !== false && !dialogHandlingCreated) {
    const titleByKind: Record<string, string> = {
      "grant-created":  "mailpouch — agent awaiting approval",
      "grant-approved": "mailpouch — agent approved",
      "grant-denied":   "mailpouch — agent denied",
      "grant-revoked":  "mailpouch — agent revoked",
      "grant-expired":  "mailpouch — agent expired",
    };
    const title = titleByKind[ev.kind] ?? "mailpouch";
    const body = `${ev.grant.clientName}`;
    // "grant-created" is the actionable approval gate — always surface it. The
    // post-decision events (approved/denied/revoked/expired) are informational;
    // route them to the debug log unless "Surface security messages" is enabled.
    if (shouldSurfaceGrantToast(ev.kind, cfg ?? {})) {
      // Fire-and-forget — notifier failures never touch the caller.
      void desktopNotifier.notify({ title, body, sound: ev.kind === "grant-created" ? "Glass" : undefined })
        .catch(() => { /* logged inside notifier */ });
    } else {
      logger.debug(`Security notification (toast suppressed; enable "Surface security messages" to show): ${ev.kind} — ${body}`, "Notifications");
    }
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
/**
 * The settings-only process deliberately never touches Bridge.  Hold account
 * rebuild events behind this lifecycle gate until the normal MCP startup path
 * has completed its initial reachability probe.
 */
let bridgeWatchdogPermitted = false;
/**
 * Retains the recovery-relevant active route even when the watchdog exhausts
 * its retries. A routine AccountManager rebuild then remains a no-op instead
 * of re-arming a Bridge that was deliberately rate-limited.
 */
const bridgeWatchdogRouteTracker = new BridgeWatchdogRouteTracker();
/**
 * Invalidates a tick that was already awaiting a reachability probe when the
 * active account changes or auto-start is disabled.  Clearing an interval does
 * not cancel its currently-running async callback, so the callback must carry
 * and check this generation before it launches Bridge or reconnects IMAP.
 */
let bridgeWatchdogGeneration = 0;
/** PID of the Bridge process this server launched. Used for clean shutdown so we
 *  never fall back to `pkill -f proton-bridge`, which would kill any unrelated
 *  process that happens to carry "proton-bridge" in its command line. */
let launchedBridgePid: number | null = null;
/** Prevents concurrent gracefulShutdown invocations (SIGINT + tray quit race, etc.). */
let _shutdownInProgress = false;
/** Path of the configuration-profile singleton lock this process holds (null if none/disabled). */
let _singletonLockPath: string | null = null;

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
};

function syncLegacyConfigFromActiveAccount({ spec }: AccountServices): void {
  const secure = spec.tlsMode === "ssl";
  Object.assign(config.smtp, {
    host: spec.smtpHost,
    port: spec.smtpPort,
    secure,
    username: spec.username,
    password: spec.password,
    smtpToken: spec.smtpToken,
    bridgeCertPath: spec.bridgeCertPath,
    allowInsecureBridge: spec.allowInsecureBridge,
  });
  Object.assign(config.imap, {
    host: spec.imapHost,
    port: spec.imapPort,
    secure,
    username: spec.username,
    password: spec.password,
    bridgeCertPath: spec.bridgeCertPath,
    allowInsecureBridge: spec.allowInsecureBridge,
  });
  config.autoStartBridge = spec.autoStartBridge;
  config.bridgePath = spec.bridgePath;
}

/**
 * Tool handlers occasionally need connection metadata (for a reply-to check
 * or a live bridge probe). Build a per-call snapshot from the routed account
 * instead of handing an `account_id` call the active account's credentials.
 */
function configForAccount({ spec }: AccountServices): ProtonMailConfig {
  const secure = spec.tlsMode === "ssl";
  return {
    ...config,
    smtp: {
      ...config.smtp,
      host: spec.smtpHost,
      port: spec.smtpPort,
      secure,
      username: spec.username,
      password: spec.password,
      smtpToken: spec.smtpToken,
      bridgeCertPath: spec.bridgeCertPath,
      allowInsecureBridge: spec.allowInsecureBridge,
    },
    imap: {
      ...config.imap,
      host: spec.imapHost,
      port: spec.imapPort,
      secure,
      username: spec.username,
      password: spec.password,
      bridgeCertPath: spec.bridgeCertPath,
      allowInsecureBridge: spec.allowInsecureBridge,
    },
    autoStartBridge: spec.autoStartBridge,
    bridgePath: spec.bridgePath,
  };
}

/**
 * A tool call may await IMAP/SMTP while Settings repoints the same account ID
 * at another mailbox. Do not return a completed old-mailbox result under the
 * reused ID. Connection teardown on replacement is the best-effort abort for
 * an in-flight mutation; callers receive an explicit uncertain-outcome error
 * rather than stale content that appears to belong to the new mailbox.
 */
function isCurrentAccountRoute(
  accountId: string,
  accountIdentity: string,
  services: AccountServices,
): boolean {
  try {
    return accountManager.getForAccount(accountId) === services
      && accountManager.identityForAccount(accountId) === accountIdentity;
  } catch {
    return false;
  }
}

accountManager.on("active-changed", (ev: { services: AccountServices }) => {
  imapService = ev.services.imap;
  smtpService = ev.services.smtp;
  syncLegacyConfigFromActiveAccount(ev.services);
  schedulerService.setSmtpService(smtpService);
  reconcileBridgeWatchdog();

  sharedState.smtpStatus = accountRuntime.getSmtpStatus(ev.services.spec.id);

  logger.info("Active-account services rebound; account-owned caches remain isolated", "MCPServer", {
    accountId: ev.services.spec.id,
  });
});

accountManager.on("account-services-replaced", (ev: { accountId: string; services: AccountServices }) => {
  // A same-ID edit can repoint an account at another mailbox without causing
  // an active-id transition. Rebind the module-level fallbacks explicitly so
  // no active-account singleton holds the old connection/transporter.
  if (accountManager.activeAccountId() !== ev.accountId) return;
  imapService = ev.services.imap;
  smtpService = ev.services.smtp;
  syncLegacyConfigFromActiveAccount(ev.services);
  schedulerService.setSmtpService(smtpService);
  reconcileBridgeWatchdog();
  accountRuntime.setSmtpStatus(ev.accountId, { connected: false, lastCheck: new Date(0) });
  sharedState.smtpStatus = accountRuntime.getSmtpStatus(ev.accountId);
  logger.info("Active account services replaced after identity change", "MCPServer", { accountId: ev.accountId });
});

/**
 * Account-scoped grants name a mutable registry ID.  Reusing that ID for a
 * different mailbox must never carry an old agent's authority across the
 * ownership boundary.  Service-account credentials are removed as well:
 * revoking only their grant would let the next client_credentials exchange
 * reactivate it from the persisted credential.
 */
function revokeGrantsBoundToAccount(accountId: string, reason: string): void {
  for (const grant of agentGrants.list()) {
    if (grant.conditions?.accountId !== accountId) continue;
    const serviceCredentialRemoved = serviceAccounts.revoke(grant.clientId);
    const revoked = agentGrants.revoke(grant.clientId);
    if (revoked || serviceCredentialRemoved) {
      logger.warn("Revoked account-scoped agent authority after mailbox ownership changed", "AgentGate", {
        accountId,
        clientId: grant.clientId,
        reason,
        serviceCredentialRemoved,
      });
    }
  }
}

accountManager.on("accounts-rebuilt", (ev: AccountsRebuiltEvent) => {
  // A credential/certificate edit keeps the same service object and therefore
  // does not emit active-changed. Refresh the legacy active snapshot anyway so
  // watchdogs and diagnostics never retain the prior active account settings.
  try {
    const active = accountManager.getActive();
    imapService = active.imap;
    smtpService = active.smtp;
    syncLegacyConfigFromActiveAccount(active);
    schedulerService.setSmtpService(smtpService);
    reconcileBridgeWatchdog();
    sharedState.smtpStatus = accountRuntime.getSmtpStatus(active.spec.id);
  } catch (err: unknown) {
    logger.warn("Could not refresh active-account bindings after registry rebuild", "MCPServer", err);
  }

  // A deleted ID and a repointed ID are both hard ownership boundaries. Clear
  // derived plaintext and quarantine queued background work before anything
  // can run against the newly resolved account services.
  for (const accountId of [...ev.removedAccountIds, ...ev.identityChangedAccountIds]) {
    const reason = ev.removedAccountIds.includes(accountId)
      ? "account removed from registry"
      : "account identity changed";
    try { accountRuntime.resetMailbox(accountId); }
    catch (err: unknown) { logger.warn("Could not reset account-owned runtime state", "MCPServer", { accountId, err }); }
    try { schedulerService.quarantineAccount(accountId, reason); }
    catch (err: unknown) { logger.warn("Could not quarantine account-owned schedules", "MCPServer", { accountId, err }); }
    try { reminderService.quarantineAccount(accountId, reason); }
    catch (err: unknown) { logger.warn("Could not quarantine account-owned reminders", "MCPServer", { accountId, err }); }
    try { revokeGrantsBoundToAccount(accountId, reason); }
    catch (err: unknown) { logger.warn("Could not revoke account-scoped agent grants", "MCPServer", { accountId, err }); }
  }

  // Dispose removed account objects after the reset so their current FTS path
  // can be scrubbed. Retained account runtimes stay alive and isolated.
  accountRuntime.disposeAccountsExcept(ev.accountIds);
});

// ─── Analytics TTL Cache ──────────────────────────────────────────────────────

/**
 * Fetch a requested account's inbox + sent messages into that account's
 * analytics runtime. The registry owns cache/in-flight state, so explicit
 * account routing cannot accidentally observe the active account.
 */
function getAnalyticsEmailsForAccount(
  accountId: string,
  sourceImapService: SimpleIMAPService,
): Promise<{ inbox: EmailMessage[]; sent: EmailMessage[] }> {
  return accountRuntime.getAnalyticsEmails(accountId, sourceImapService, trimForAnalytics);
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
  // Request-scoped mutation cancellation messages deliberately distinguish a
  // safe retry from an already-dispatched command whose outcome is unknown.
  // Preserve that safety guidance verbatim; generic timeout classification
  // would erase the inspect-before-retry warning.
  if (error instanceof MailboxMutationDeadlineError) return error.message;
  // ConnectionStateError carries operator-actionable guidance (fix the Bridge
  // password / start Bridge) written for a human — surface it verbatim so the
  // agent can relay exactly what the user needs to go fix.
  if (error instanceof ConnectionStateError) return error.message;
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
    msg.includes("protected folder") ||
    msg.includes("already exists") ||
    msg.includes("not empty") ||
    msg.includes("does not exist")
  )
    return error.message;
  if (msg.includes("at least one recipient") || msg.includes("required")) return error.message;
  // Cluster 6: classify the remaining IMAP/connection/auth/timeout failures into
  // actionable categories instead of the opaque "IMAP operation failed" /
  // "An error occurred". The raw error (with stack) is logged by the dispatcher.
  const classified = classifyError(error);
  if (classified.category !== "internal") return classified.message;
  if (
    msg.includes("imap") ||
    msg.includes("connect") ||
    msg.includes("mailbox") ||
    msg.includes("login")
  )
    return "IMAP operation failed";
  return classified.message;
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

// Returned in the MCP `initialize` response — the one channel a client/agent
// reads to learn what this server is and how to get connected. Keep it tight;
// clients inject it into the model's context on every session.
const SERVER_INSTRUCTIONS =
  "mailpouch is a local MCP server that exposes a Proton Mail / IMAP mailbox (via the Proton Bridge " +
  "desktop app) as permission-gated, audit-logged tools. It runs on the user's machine; mail content " +
  "you read is sent to your model provider for processing.\n\n" +
  "GETTING CONNECTED — do this in order:\n" +
  "1. Call `setup_status` FIRST. It is always available (even before approval) and tells you exactly " +
  "what is wrong and the single next step.\n" +
  "2. If it reports `unconfigured`: credentials must be set on the user's machine. Either run " +
  "`npx -y mailpouch setup --username <you@proton.me> --password-stdin` (the Proton BRIDGE password, not " +
  "the Proton login password), or ask the user to run `npx -y mailpouch-settings` for the interactive wizard.\n" +
  "3. If it reports `bridge-unreachable`: ask the user to start the Proton Bridge app (signed in). " +
  "Bridge listens on 127.0.0.1 — IMAP :1143, SMTP :1025.\n" +
  "4. If it reports `pending-approval`: this is EXPECTED on first connect, not an error. Every agent is " +
  "gated behind a human Approve/Deny. Ask the user to open the settings UI (default http://localhost:8766/#/agents) " +
  "and click Approve, then retry. You cannot approve yourself.\n" +
  "5. When it reports `ready`, call `get_connection_status` to confirm live auth, then use the mail tools.\n\n" +
  "Use `request_permission_escalation` to ask the user for a higher permission preset. " +
  "Full tool reference: README_FIRST_AI.md (https://github.com/chandshy/mailpouch/blob/main/README_FIRST_AI.md), " +
  "also bundled in the installed package.";

const server = new Server(
  { name: "mailpouch", version: _pkgVersion },
  {
    capabilities: {
      tools: { listChanged: false },
      resources: { listChanged: false, subscribe: false },
      prompts: { listChanged: false },
    },
    instructions: SERVER_INSTRUCTIONS,
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
  const envTier = process.env.MAILPOUCH_TIER;
  if (envTier) return parseToolTier(envTier);
  const cfg = loadConfig();
  return parseToolTier(cfg?.toolTier);
}

// Tools annotated read-only never fire a per-action security toast — reads
// (get_emails, search, status, …) would be pure noise. Built once from the
// registry so it tracks the annotations automatically.
const READONLY_TOOLS: ReadonlySet<string> = new Set(
  allToolDefs()
    .filter((d) => (d.annotations as { readOnlyHint?: boolean } | undefined)?.readOnlyHint === true)
    .map((d) => d.name),
);

/**
 * Per-action security notification (debug aid). Read-only tools and
 * errored/no-op calls are ignored entirely (they would be pure noise). For a
 * successful, non-read-only tool call it writes a DEBUG log line, and
 * additionally surfaces a desktop toast when "Surface security messages"
 * (surfaceSecurityNotifications) is enabled and desktop notifications aren't
 * disabled. Fire-and-forget.
 */
function notifyActionPerformed(
  tool: string,
  caller: CallerContext | undefined,
  result: { isError?: boolean },
  cfg: { surfaceSecurityNotifications?: boolean; desktopNotificationsEnabled?: boolean },
): void {
  // Guard the noisy cases up front; reads and errored/no-op calls never notify.
  if (result.isError === true || READONLY_TOOLS.has(tool)) return;
  const who = caller?.clientName ? ` · ${caller.clientName}` : "";
  logger.debug(`Action performed: ${tool}${who}`, "Notifications");
  if (shouldSurfaceActionToast({ isReadOnly: false, isError: false, cfg })) {
    void desktopNotifier
      .notify({ title: "mailpouch — action", body: `${tool}${who}` })
      .catch(() => { /* logged inside notifier */ });
  }
}

function registerHandlers(server: Server): void {
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
  const defs = advertisedToolDefs({
    simpleLogin: simpleloginService.isConfigured(),
    pass: passService !== null,
  }).map(def =>
    def.name === "request_permission_escalation"
      ? { ...def, description: describeRequestEscalation(config.settingsPort ?? 8766) }
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

server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  // Capture an absolute deadline at request receipt. Permission gates and an
  // elicitation prompt may consume part of the budget; they must never extend
  // how long a client-visible mailbox mutation can remain live.
  const mailboxMutationDeadlineAt = Date.now() + MAILBOX_MUTATION_DEADLINE_MS;
  const name = request.params.name;
  const args = request.params.arguments ?? {};

  return tracer.span('mcp.tool_call', { tool: name, argCount: Object.keys(args).length }, async () => {
  const progressToken = request.params._meta?.progressToken;

  const { body: _b, attachments: _a, password: _p, ...safeArgs } = args as Record<string, unknown>;
  logger.debug(`Tool: ${name}`, "MCPServer", safeArgs);

  // ── setup_status: ungated install/connect diagnostic (CALL FIRST) ─────────
  // Pre-gate like the escalation tools so an agent with no credentials, an
  // unreachable Bridge, or an unapproved grant can still learn exactly what is
  // wrong and the single next action. Read-only; never grants or mutates.
  if (name === "setup_status") {
    const diagCaller = currentCaller() ?? _stdioCaller ?? undefined;
    // This is display-only diagnostic context, not an authorization decision;
    // retain the lightweight live-map lookup so a partially-written external
    // grants file does not hide useful setup guidance.
    const diagGrant = diagCaller ? agentGrants.get(diagCaller.clientId) : undefined;
    const result = await gatherSetupStatus({
      grant: diagGrant ? { status: diagGrant.status, clientName: diagGrant.clientName } : undefined,
    });
    return {
      content: [{ type: "text" as const, text: result.summary }],
      structuredContent: result as unknown as Record<string, unknown>,
    };
  }

  // ── Always-available meta-tools (bypass permission gate) ─────────────────
  // These tools let the agent REQUEST more access — but they can never GRANT it.
  // Approval is strictly out-of-band (settings UI browser click or terminal).
  if (_escalationHandlers[name]) {
    // PERM-002: thread the requesting caller's identity into the escalation
    // record so the approval card can surface it. Stdio (no OAuth client)
    // becomes the literal string "stdio" — distinguishable from a real
    // client id so the UI can flag which approval flow this is.
    const earlyCaller = currentCaller() ?? _stdioCaller ?? undefined;
    const escalationCaller = earlyCaller
      ? { clientId: earlyCaller.clientId, clientName: earlyCaller.clientName }
      : { clientId: "stdio", clientName: undefined };
    // PERM-001: escalation meta-tools bypass the grant/permission/destructive
    // gates by design (they can never GRANT access), but they MUST still leave
    // a per-agent audit trail. Previously these calls were invisible in
    // ~/.mailpouch-agent-audit.jsonl, so a revoked agent could spam escalation
    // requests with zero per-agent attribution. Write a row around the call.
    const escStartedAt = Date.now();
    try {
      const res = await _escalationHandlers[name]({ args, config, caller: escalationCaller });
      if (earlyCaller) {
        agentAudit.write({
          ts: new Date(escStartedAt).toISOString(),
          clientId: earlyCaller.clientId,
          clientName: earlyCaller.clientName,
          tool: name,
          argHash: hashArgs(args),
          ok: res.isError !== true,
          durMs: Date.now() - escStartedAt,
          ...(res.isError === true ? { blockedReason: "escalation request returned an error" } : {}),
          ip: earlyCaller.ip,
        });
      }
      return res;
    } catch (err: unknown) {
      if (earlyCaller) {
        agentAudit.write({
          ts: new Date(escStartedAt).toISOString(),
          clientId: earlyCaller.clientId,
          clientName: earlyCaller.clientName,
          tool: name,
          argHash: hashArgs(args),
          ok: false,
          durMs: Date.now() - escStartedAt,
          blockedReason: safeErrorMessage(err),
          ip: earlyCaller.ip,
        });
      }
      throw err;
    }
  }

  // ── Per-tool account routing ─────────────────────────────────────────────
  // The dispatcher resolves an optional `account_id` argument before the
  // gates so audit rows and permission checks both see the correct account.
  // If an agent grant is bound to a specific account (conditions.accountId),
  // the caller's requested account_id must match.
  const requestedAccountId = typeof args.account_id === "string" && args.account_id.trim()
    ? args.account_id.trim()
    : accountManager.activeAccountId();
  let routedAccountServices: AccountServices = accountManager.getActive();
  let routedImapService: SimpleIMAPService = routedAccountServices.imap;
  let routedSmtpService: SMTPService = routedAccountServices.smtp;
  let routedAccountIdentity = "";
  try {
    routedAccountServices = accountManager.getForAccount(requestedAccountId);
    routedImapService = routedAccountServices.imap;
    routedSmtpService = routedAccountServices.smtp;
    routedAccountIdentity = accountManager.identityForAccount(requestedAccountId);
  } catch {
    return {
      content: [{ type: "text" as const, text: `Unknown account_id: ${requestedAccountId}` }],
      isError: true,
    };
  }

  // ── Agent-grant gate ──────────────────────────────────────────────────────
  // Runs BEFORE the global permission gate. The caller is the HTTP request's
  // OAuth identity (AsyncLocalStorage) when present, else the LOCAL stdio
  // client's identity resolved at the handshake (_stdioCaller) when local
  // gating is on. So every agent — local or remote — is routed through the
  // per-agent grant: an unapproved one is blocked "pending user approval".
  // When local gating is disabled, _stdioCaller is null and stdio bypasses
  // (legacy auto-trust).
  const caller = currentCaller() ?? _stdioCaller ?? undefined;
  const callStartedAt = Date.now();
  // Flipped true in the catch so the finally success path is skipped.
  let auditFailureRecorded = false;
  let resultIsError = false;
  // PERM-007: snapshot the config ONCE for the whole gate chain. The grant
  // gate's global-preset read and the destructive-confirm gate's
  // requireDestructiveConfirm read previously each called loadConfig()
  // independently; a settings save (or an approved escalation) landing
  // between them produced a TOCTOU window where the two gates judged the
  // same call against different snapshots. One snapshot closes that gap.
  const configSnapshot = loadConfig() ?? defaultConfig();
  const globalPreset = configSnapshot.permissions.preset;
  let authorizedGrant: AgentGrant | undefined;
  if (caller) {
    // One durable snapshot feeds the initial grant gate. Do not consult
    // AgentGrantStore's in-memory UI map here: another process can revoke or
    // narrow this caller while the daemon is alive.
    const grantSnapshot = grantManager.getAuthorizationSnapshot(caller.clientId);
    const grantResult = grantManager.check({
      clientId: caller.clientId,
      tool: name,
      args: args as Record<string, unknown>,
      callerIp: caller.ip,
      targetAccountId: requestedAccountId,
      targetAccountIdentity: routedAccountIdentity,
      globalPreset,
    }, { reserveHourlyToolSlot: false, snapshot: grantSnapshot });
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
    if (caller) {
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
  // PERM-003: alias-canonicalize before the destructive check so calling
  // `bulk_delete` exercises the same gate as `bulk_delete_emails`.
  // PERM-004: move_email / bulk_move_emails / move_to_folder count as
  // destructive when their target folder name matches a destructive
  // destination (Trash, Spam). Without this, an agent could bypass
  // destructive-confirm by routing the delete through `move_email` with
  // `targetFolder: "Trash"` instead of calling `move_to_trash` directly.
  const canonicalName = canonicalToolName(name);
  const moveTargetRaw = typeof args.targetFolder === "string"
    ? args.targetFolder
    : typeof args.folder === "string" ? args.folder : "";
  const moveTargetIsDestructive =
    MOVE_TOOLS_WITH_DESTRUCTIVE_TARGET.has(canonicalName)
    && DESTRUCTIVE_DESTINATIONS.has(moveTargetRaw.trim().toLowerCase());
  const isDestructive = DESTRUCTIVE_TOOLS.has(canonicalName) || moveTargetIsDestructive;
  if (isDestructive && configSnapshot.requireDestructiveConfirm !== false) {
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
              isError: true,
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

  // Reserve a grant-scoped hourly slot only once every other pre-execution
  // gate has allowed the call.  GrantManager repeats its own condition checks
  // as part of this final step, then atomically prunes/checks/reserves the
  // per-client canonical-tool bucket.  This prevents parallel calls from
  // overshooting a cap without charging a slot to a globally-disabled or
  // confirmation-rejected request.
  if (caller) {
    // A destructive confirmation can await user input. Re-read authorization
    // state afterwards so an external revoke/change wins before dispatch.
    const grantSnapshot = grantManager.getAuthorizationSnapshot(caller.clientId);
    const finalGrant = grantSnapshot.kind === "present" ? grantSnapshot.grant : undefined;
    const reservationResult = grantManager.check({
      clientId: caller.clientId,
      tool: name,
      args: args as Record<string, unknown>,
      callerIp: caller.ip,
      targetAccountId: requestedAccountId,
      targetAccountIdentity: routedAccountIdentity,
      globalPreset,
    }, { snapshot: grantSnapshot });
    if (!reservationResult.allowed) {
      logger.warn(`Agent grant denied '${name}' for ${caller.clientId}`, "AgentGate", { reason: reservationResult.reason });
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: false,
        durMs: Date.now() - callStartedAt,
        blockedReason: reservationResult.reason,
        ip: caller.ip,
      });
      auditFailureRecorded = true;
      return {
        content: [{ type: "text" as const, text: `Blocked by agent grant: ${reservationResult.reason}` }],
        isError: true,
      };
    }
    authorizedGrant = finalGrant;
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
      accountId: requestedAccountId,
      accountIdentity: routedAccountIdentity,
      imapService: routedImapService,
      smtpService: routedSmtpService,
      simpleloginService,
      analyticsService: accountRuntime.getAnalyticsService(requestedAccountId),
      schedulerService,
      reminderService,
      passService,
      getFts: () => accountRuntime.getFts(requestedAccountId, routedAccountIdentity),
      // Folder-allowlist accessor: trusted/stdio callers (no caller context)
      // and static-bearer callers fall through to `undefined` (= no
      // restriction), preserving existing behavior. OAuth callers with a
      // folder-restricted grant return their allowlist for content-scoping.
      getCallerAllowedFolders: () => {
        if (!authorizedGrant) return undefined;
        return grantManager.resolveAllowedFolders(authorizedGrant);
      },
      config: configForAccount(routedAccountServices),
      smtpStatus: accountRuntime.getSmtpStatus(requestedAccountId),
      setSmtpStatus: (status) => {
        accountRuntime.setSmtpStatus(requestedAccountId, status);
        if (accountManager.activeAccountId() === requestedAccountId) sharedState.smtpStatus = { ...status };
      },
      limits: _limits,
      ok,
      actionOk,
      bulkOk,
      sendProgress,
      encodeCursor,
      decodeCursor,
      getAnalyticsEmails: () => getAnalyticsEmailsForAccount(requestedAccountId, routedImapService),
      invalidateAnalytics: () => accountRuntime.invalidateAnalytics(requestedAccountId),
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
    const invokeHandler = async () => {
      if (MAILBOX_MUTATION_TOOLS.has(name)) {
        await routedImapService.ensureMutationConnection();
      }
      return withE2EMailboxIdentity(
        args as Record<string, unknown>,
        () => handler(ctx),
      );
    };
    const result = ACCOUNT_MAIL_MUTATION_TOOLS.has(name)
      ? await withMailboxMutationDeadline({
        tool: name,
        signal: extra.signal,
        deadlineAt: mailboxMutationDeadlineAt,
        transports: [
          ...(MAILBOX_MUTATION_TOOLS.has(name) ? [{
            scope: routedImapService,
            abort: () => routedImapService.abortPrimaryMutationTransport(
              `MCP account mail mutation '${name}' was cancelled or exceeded ${MAILBOX_MUTATION_DEADLINE_MS}ms`,
            ),
          }] : []),
          ...(SMTP_MUTATION_TOOLS.has(name) ? [{
            scope: routedSmtpService,
            abort: () => routedSmtpService.abortActiveMutationTransport(
              `MCP account mail mutation '${name}' was cancelled or exceeded ${MAILBOX_MUTATION_DEADLINE_MS}ms`,
            ),
          }] : []),
        ],
      }, invokeHandler)
      : await invokeHandler();
    if (!isCurrentAccountRoute(requestedAccountId, routedAccountIdentity, routedAccountServices)) {
      resultIsError = true;
      logger.warn("Discarded a completed tool result after its account route changed", "MCPServer", {
        tool: name,
        accountId: requestedAccountId,
      });
      return {
        content: [{
          type: "text" as const,
          text: "The account changed while this request was running, so its result was discarded. If this request changed mail, its outcome may be unknown; inspect the mailbox before retrying.",
        }],
        isError: true,
      };
    }
    resultIsError = result.isError === true;
    // Per-action security notification (debug aid) — debug-logs a successful
    // non-read-only action; also toasts it when "Surface security messages" is
    // enabled. Uses the one config snapshot already loaded for this gate chain.
    notifyActionPerformed(name, caller, result, configSnapshot);
    return result;
  } catch (error: unknown) {
    logger.error(`Tool failed: ${name}`, "MCPServer", error);
    const msg = safeErrorMessage(error);
    auditFailureRecorded = true;
    if (caller) {
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
      isError: true,
    };
  } finally {
    // Every normal handler return receives an audit row. A structured error
    // is a failed call, not a successful one, and must not consume the
    // grant's successful-call budget.
    if (!auditFailureRecorded && caller) {
      agentAudit.write({
        ts: new Date(callStartedAt).toISOString(),
        clientId: caller.clientId,
        clientName: caller.clientName,
        tool: name,
        argHash: hashArgs(args),
        ok: !resultIsError,
        durMs: Date.now() - callStartedAt,
        ...(resultIsError ? { blockedReason: "Tool returned an error." } : {}),
        ip: caller.ip,
      });
      if (!resultIsError) agentGrants.recordCall(caller.clientId);
    }
  }
  }); // end tracer.span('mcp.tool_call')
});

// ═════════════════════════════════════════════════════════════════════════════
// RESOURCES
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Resources and prompts can return decrypted mail just as tools can. They do
 * not pass through CallToolRequestSchema, so apply the same grant + global
 * read policy here rather than accidentally creating an approval bypass for
 * remote MCP clients.
 */
interface ActiveReadSurfaceAccess {
  allowedFolders?: string[];
  accountId: string;
  accountIdentity: string;
  services: AccountServices;
}

/**
 * Bind a resource/prompt read to the active mailbox observed at its grant
 * check. Resources do not accept account_id, so an active-account switch
 * while IMAP is awaiting must discard the old result rather than returning it
 * under the new default mailbox.
 */
async function readFromActiveSurface<T>(
  access: ActiveReadSurfaceAccess,
  read: (imap: SimpleIMAPService) => Promise<T>,
): Promise<T> {
  const isStillActive = () => accountManager.activeAccountId() === access.accountId
    && isCurrentAccountRoute(access.accountId, access.accountIdentity, access.services);
  if (!isStillActive()) {
    throw new McpError(ErrorCode.InvalidRequest, "The active account changed before this read could start. Retry after the switch completes.");
  }
  const result = await read(access.services.imap);
  if (!isStillActive()) {
    throw new McpError(ErrorCode.InvalidRequest, "The active account changed while this read was running, so its result was discarded.");
  }
  return result;
}

function requireReadSurfaceAccess(
  tool: ToolName,
  args: Record<string, unknown> = {},
): ActiveReadSurfaceAccess {
  const services = accountManager.getActive();
  const activeAccountId = services.spec.id;
  const accountIdentity = accountManager.identityForAccount(activeAccountId);
  const caller = currentCaller() ?? _stdioCaller ?? undefined;
  if (!caller) return { accountId: activeAccountId, accountIdentity, services };

  const grantSnapshot = grantManager.getAuthorizationSnapshot(caller.clientId);

  const configSnapshot = loadConfig() ?? defaultConfig();
  const grantResult = grantManager.check({
    clientId: caller.clientId,
    tool,
    args,
    callerIp: caller.ip,
    targetAccountId: activeAccountId,
    targetAccountIdentity: accountIdentity,
    globalPreset: configSnapshot.permissions.preset,
  }, { reserveHourlyToolSlot: false, snapshot: grantSnapshot });
  if (!grantResult.allowed) {
    agentAudit.write({
      ts: new Date().toISOString(),
      clientId: caller.clientId,
      clientName: caller.clientName,
      tool: `read_surface:${tool}`,
      argHash: hashArgs(args),
      ok: false,
      durMs: 0,
      blockedReason: grantResult.reason,
      ip: caller.ip,
    });
    throw new McpError(ErrorCode.InvalidRequest, `Blocked by agent grant: ${grantResult.reason}`);
  }

  const permissionResult = permissions.check(tool);
  if (!permissionResult.allowed) {
    agentAudit.write({
      ts: new Date().toISOString(),
      clientId: caller.clientId,
      clientName: caller.clientName,
      tool: `read_surface:${tool}`,
      argHash: hashArgs(args),
      ok: false,
      durMs: 0,
      blockedReason: `preset: ${permissionResult.reason}`,
      ip: caller.ip,
    });
    throw new McpError(ErrorCode.InvalidRequest, `Blocked: ${permissionResult.reason}`);
  }

  // Resources and prompts are routed through this helper rather than the
  // normal tool dispatcher.  Make the same final reserving check here, after
  // the global permission gate, so these read surfaces cannot bypass a
  // configured per-agent hourly cap or consume one when globally disabled.
  const reservationSnapshot = grantManager.getAuthorizationSnapshot(caller.clientId);
  const reservationGrant = reservationSnapshot.kind === "present" ? reservationSnapshot.grant : undefined;
  const reservationResult = grantManager.check({
    clientId: caller.clientId,
    tool,
    args,
    callerIp: caller.ip,
    targetAccountId: activeAccountId,
    targetAccountIdentity: accountIdentity,
    globalPreset: configSnapshot.permissions.preset,
  }, { snapshot: reservationSnapshot });
  if (!reservationResult.allowed) {
    agentAudit.write({
      ts: new Date().toISOString(),
      clientId: caller.clientId,
      clientName: caller.clientName,
      tool: `read_surface:${tool}`,
      argHash: hashArgs(args),
      ok: false,
      durMs: 0,
      blockedReason: reservationResult.reason,
      ip: caller.ip,
    });
    throw new McpError(ErrorCode.InvalidRequest, `Blocked by agent grant: ${reservationResult.reason}`);
  }

  return {
    allowedFolders: reservationGrant ? grantManager.resolveAllowedFolders(reservationGrant) : undefined,
    accountId: activeAccountId,
    accountIdentity,
    services,
  };
}

function requireAllowedReadFolder(path: string, allowedFolders: string[] | undefined): void {
  if (!allowedFolders) return;
  if (!allowedFolders.some(folder => folder.toLowerCase() === path.toLowerCase())) {
    throw new McpError(ErrorCode.InvalidRequest, `Blocked: folder '${path}' is outside this agent's folder allowlist.`);
  }
}

server.setRequestHandler(ListResourcesRequestSchema, async () => {
  // Expose the INBOX folder as a listable resource; agents can also use templates for specific emails
  try {
    const access = requireReadSurfaceAccess("get_folders");
    const { allowedFolders } = access;
    const folders = await readFromActiveSurface(access, imap => imap.getFolders());
    const visibleFolders = allowedFolders
      ? folders.filter(folder => allowedFolders.some(allowed => allowed.toLowerCase() === folder.path.toLowerCase()))
      : folders;
    return {
      resources: visibleFolders.map((f) => ({
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
    const access = requireReadSurfaceAccess("get_email_by_id", { folder });
    const { allowedFolders } = access;
    requireAllowedReadFolder(folder, allowedFolders);
    const id = emailMatch[2];
    const email = await readFromActiveSurface(access, imap => imap.getEmailById(id, folder));
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
    const access = requireReadSurfaceAccess("get_folders");
    const { allowedFolders } = access;
    const folders = await readFromActiveSurface(access, imap => imap.getFolders());
    const visibleFolders = allowedFolders
      ? folders.filter(folder => allowedFolders.some(allowed => allowed.toLowerCase() === folder.path.toLowerCase()))
      : folders;
    const matchedFolder = path === ""
      ? null
      : folders.find((f) => f.path === path || f.name === path);
    if (matchedFolder) requireAllowedReadFolder(matchedFolder.path, allowedFolders);
    const folder = path === ""
      ? null  // list-all case
      : visibleFolders.find((f) => f.path === path || f.name === path);

    if (path !== "" && !folder) {
      throw new McpError(ErrorCode.InvalidRequest, `Folder not found: ${path}`);
    }

    const payload = path === "" ? { folders: visibleFolders } : folder;
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
      const access = requireReadSurfaceAccess("get_emails", { folder: "INBOX" });
      const rawLimit = parseInt((args.limit as string) || "20", 10);
      const limit = isNaN(rawLimit) ? 20 : Math.min(Math.max(1, rawLimit), 100);
      // Sanitize agent-supplied focus to prevent prompt injection.
      const focus = args.focus ? sanitizeText(args.focus as string, 200) : undefined;
      let emails: EmailMessage[] = [];
      try {
        emails = await readFromActiveSurface(access, imap => imap.getEmails("INBOX", limit));
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

After presenting your assessment, wait for the user to approve actions, then use the available tools (reply_to_email, archive_email, delete_email, move_email) to carry them out. Include account_id="${access.accountId}" on every follow-up tool call so it remains bound to this mailbox even if the active account changes.`,
            },
          },
        ],
      };
    }

    case "compose_reply": {
      // Validate emailId early so we never embed an adversarial string in the prompt.
      const emailId = requireNumericEmailId(args.emailId);
      const access = requireReadSurfaceAccess("get_email_by_id");
      const { allowedFolders } = access;
      // The prompt has only a numeric ID and no folder argument. A
      // folder-restricted grant therefore cannot prove the requested message
      // is allowed; fail closed instead of resolving it across every mailbox.
      if (allowedFolders) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Blocked: compose_reply cannot resolve a folderless email ID for a folder-restricted agent. Use get_email_by_id with an allowed folder instead.",
        );
      }
      // Sanitize agent-supplied intent to prevent prompt injection.
      const intent = sanitizeText(args.intent, 200);
      let emailContent = "Could not load email — use get_email_by_id to fetch it first.";
      try {
        const email = await readFromActiveSurface(access, imap => imap.getEmailById(emailId));
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

When ready, use reply_to_email with emailId="${emailId}" and account_id="${access.accountId}" to send.`,
            },
          },
        ],
      };
    }

    case "daily_briefing": {
      const access = requireReadSurfaceAccess("get_emails", { folder: "INBOX" });
      let emails: EmailMessage[] = [];
      try {
        emails = await readFromActiveSurface(access, imap => imap.getEmails("INBOX", 50));
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
      const access = requireReadSurfaceAccess("get_emails", { folder });
      let emails: EmailMessage[] = [];
      try {
        emails = await readFromActiveSurface(access, imap => imap.getEmails(folder, 100));
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

After the user reviews, use bulk_delete_emails or bulk_move_emails with account_id="${access.accountId}" to take action on approved groups.`,
            },
          },
        ],
      };
    }

    case "thread_summary": {
      // Validate emailId early to prevent prompt injection via a crafted ID string.
      const emailId = requireNumericEmailId(args.emailId);
      const access = requireReadSurfaceAccess("get_thread");
      const { allowedFolders } = access;
      if (allowedFolders) {
        throw new McpError(
          ErrorCode.InvalidRequest,
          "Blocked: thread_summary can traverse multiple folders and is unavailable to folder-restricted agents. Use get_email_by_id with an allowed folder instead.",
        );
      }
      let emailContent = "Could not load the email.";
      try {
        const email = await readFromActiveSurface(access, imap => imap.getEmailById(emailId));
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
      text: `Summarize the following email thread. If there are earlier messages referenced, use search_emails with account_id="${access.accountId}" to find them (search by subject or sender).

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
      const access = requireReadSurfaceAccess("get_emails", { folder: "Sent" });
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
        const sent = await readFromActiveSurface(access, imap => imap.getEmails("Sent", sampleCount));
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

Then, if the user approves, use send_email with to="${recipient}" and account_id="${access.accountId}" to send it.`,
            },
          },
        ],
      };
    }

    default:
      throw new McpError(ErrorCode.InvalidRequest, `Unknown prompt: ${name}`);
  }
});
}

// Build a fresh MCP server instance with all handlers registered. The HTTP
// transport calls this per client session so each session gets its own Server
// (the MCP SDK binds one Server to one transport). Without it, a single shared
// stateless transport 500s after the first initialize. (2026-06-01)
export function createSessionServer(): Server {
  const s = new Server(
    { name: "mailpouch", version: _pkgVersion },
    {
      capabilities: {
        tools: { listChanged: false },
        resources: { listChanged: false, subscribe: false },
        prompts: { listChanged: false },
      },
      instructions: SERVER_INSTRUCTIONS,
    },
  );
  // Capture the MCP handshake's connection info onto this agent's grant for
  // display in the Agents tab. The `initialize` request runs inside
  // runWithCaller(), so currentCaller() yields the session's OAuth clientId
  // here. Identity is the server-issued clientId; the client's self-reported
  // name/version are display-only. Bearer/stdio callers have no per-agent grant
  // (trusted), so this is a no-op for them.
  s.oninitialized = () => {
    try {
      const caller = currentCaller();
      if (!caller || !caller.clientId) return;
      const info = s.getClientVersion(); // { name, version? } | undefined
      agentGrants.recordConnection(caller.clientId, {
        mcpClientName: info?.name,
        mcpClientVersion: info?.version,
        transport: "http",
        registeredFromIp: caller.ip,
      });
    } catch (err: unknown) {
      logger.debug("Failed to record agent handshake connection info", "MCPServer", err);
    }
  };
  registerHandlers(s);
  return s;
}

// Register handlers on the module-level server (used by the stdio transport).
registerHandlers(server);

// ── Local (stdio) agent gating ───────────────────────────────────────────────
// Stdio has no per-request caller context (AsyncLocalStorage doesn't cross from
// the initialize handshake to the tool handler), and a stdio process serves
// exactly ONE local client, so we resolve that client's identity once at the
// handshake and stash it module-side. The tool gate falls back to this when
// there's no HTTP caller — routing the local agent through the same
// register → approve → access flow as remote agents.
let _stdioCaller: CallerContext | null = null;

/** True when local (stdio) agents must register + be approved (default true). */
function localAgentsGated(): boolean {
  if (process.env.MAILPOUCH_TRUST_LOCAL === "1") return false;
  return (loadConfig()?.gateLocalAgents ?? true) !== false;
}

// Capture the local client's identity at the MCP handshake, register a pending
// grant (which surfaces the approval notice), and arm the gate. No-op when
// local gating is disabled (legacy auto-trust) — _stdioCaller stays null, so
// the gate keeps bypassing stdio.
server.oninitialized = () => {
  try {
    if (!localAgentsGated()) return;
    const info = server.getClientVersion(); // { name, version? } | undefined
    const name = info?.name || "(unnamed local client)";
    const clientId = localAgentId(name);
    if (!agentGrants.get(clientId)) {
      agentGrants.createPending({ clientId, clientName: name });
    }
    agentGrants.recordConnection(clientId, {
      mcpClientName: info?.name,
      mcpClientVersion: info?.version,
      transport: "stdio",
    });
    _stdioCaller = { clientId, clientName: name };
  } catch (err: unknown) {
    logger.debug("Failed to register local stdio agent", "MCPServer", err);
  }
};

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
async function launchProtonBridge(bridgeConfig: ProtonMailConfig = config): Promise<void> {
  const platform = process.platform;
  let cmd: string;
  let args: string[];
  // Strip surrounding quotes that users sometimes paste in (e.g. from
  // Explorer) without mutating the module-level active-account snapshot.
  const bridgePath = bridgeConfig.bridgePath?.trim().replace(/^["']|["']$/g, "") || undefined;
  // User-configured path takes top priority. Don't pre-check existsSync —
  // that creates a TOCTOU window where an attacker with write access to the
  // containing directory could swap the binary between check and spawn.
  // spawn() itself will surface ENOENT via the 'error' event below.
  if (bridgePath) {
    try {
      // Detach + unref lets Bridge outlive us, but an ENOENT (stale path
      // across platforms, missing perms) arrives as an async 'error' event.
      // Without a listener Node converts it to an unhandled throw that
      // crashes the whole MCP server — attach a no-op handler and let the
      // reachability poll below surface the failure naturally.
      const bridgeProc = spawn(bridgePath, [], {
        stdio: "ignore", detached: true, shell: false,
      });
      launchedBridgePid = bridgeProc.pid ?? null;
      bridgeProc.on("error", (err) => {
        logger.warn("Proton Bridge launch process emitted error", "MCPServer", err);
      });
      bridgeProc.unref();
      logger.info("Proton Bridge launch command sent — waiting up to 15 s for ports to open…", "MCPServer");
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise<void>(r => setTimeout(r, 1500));
        const [smtpOk, imapOk] = await Promise.all([
          isBridgeReachable(bridgeConfig.smtp.host, bridgeConfig.smtp.port),
          isBridgeReachable(bridgeConfig.imap.host, bridgeConfig.imap.port),
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
    // Same async-error concern as the user-configured path above: attach a
    // listener before .unref() so a spawn failure can't crash the MCP server.
    const bridgeProc = spawn(cmd, args, { stdio: "ignore", detached: true, shell: false });
    launchedBridgePid = bridgeProc.pid ?? null;
    bridgeProc.on("error", (err) => {
      logger.warn("Proton Bridge launch process emitted error", "MCPServer", err);
    });
    bridgeProc.unref();
    logger.info("Proton Bridge launch command sent — waiting up to 15 s for ports to open…", "MCPServer");
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await new Promise<void>(r => setTimeout(r, 1500));
      const [smtpOk, imapOk] = await Promise.all([
        isBridgeReachable(bridgeConfig.smtp.host, bridgeConfig.smtp.port),
        isBridgeReachable(bridgeConfig.imap.host, bridgeConfig.imap.port),
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

/** Terminate the Proton Bridge process launched by this server.
 *
 *  Prefer killing by PID we recorded at spawn — that's deterministic and can
 *  never hit an unrelated process. The previous implementation used
 *  `pkill -f proton-bridge`, which matches the full command line: any other
 *  process whose argv happens to contain "proton-bridge" (a developer running
 *  `vim --servername proton-bridge`, for example) would die.
 *
 *  If we never launched Bridge (PID is null — e.g., Bridge was already running
 *  when we started), we do nothing. The user can stop it themselves; we should
 *  not kill a process we didn't create. */
async function killProtonBridge(): Promise<void> {
  if (launchedBridgePid === null) {
    logger.debug("Proton Bridge not launched by this server — skipping kill", "MCPServer");
    return;
  }
  const pid = launchedBridgePid;
  try {
    process.kill(pid, "SIGTERM");
    // Give Bridge ~2 s to exit cleanly, then SIGKILL if still alive.
    await new Promise<void>(r => setTimeout(r, 2000));
    try { process.kill(pid, 0); } catch { launchedBridgePid = null; logger.info(`Proton Bridge (pid ${pid}) terminated`, "MCPServer"); return; }
    try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    logger.info(`Proton Bridge (pid ${pid}) force-killed`, "MCPServer");
  } catch (e: unknown) {
    logger.debug(`Could not terminate Proton Bridge (pid ${pid})`, "MCPServer", e);
  } finally {
    launchedBridgePid = null;
  }
}

/**
 * Background watchdog — runs every 30 s when autoStartBridge is enabled.
 * If Bridge ports become unreachable it attempts up to BRIDGE_MAX_RESTARTS relaunches.
 * After all attempts are exhausted it logs a critical alert and stops watching.
 */
function stopBridgeWatchdog(): void {
  // Clearing an interval does not cancel an async callback which has already
  // begun. Bumping the generation makes that callback fail closed at its next
  // await boundary before it can launch Bridge for a now-disabled account.
  bridgeWatchdogGeneration += 1;
  if (bridgeWatchdogTimer) {
    clearInterval(bridgeWatchdogTimer);
    bridgeWatchdogTimer = null;
  }
  bridgeRestartAttempts = 0;
}

/** The recovery-relevant route for the live active account, if enabled. */
function activeBridgeWatchdogRoute(): BridgeWatchdogRoute | null {
  if (!bridgeWatchdogPermitted || _shutdownInProgress || !config.autoStartBridge) return null;
  try {
    const services = accountManager.getActive();
    return bridgeWatchdogRouteForAccount(services, services.spec);
  } catch {
    return null;
  }
}

/** True only while this exact timer still owns the currently active account. */
function isCurrentBridgeWatchdog(
  generation: number,
  services: AccountServices,
): boolean {
  if (
    bridgeWatchdogTimer === null ||
    bridgeWatchdogGeneration !== generation ||
    !bridgeWatchdogPermitted ||
    _shutdownInProgress ||
    !config.autoStartBridge ||
    !services.spec.autoStartBridge
  ) {
    return false;
  }
  try {
    return accountManager.getActive() === services
      && bridgeWatchdogRouteTracker.matches(bridgeWatchdogRouteForAccount(services, services.spec));
  } catch {
    return false;
  }
}

/**
 * Start a watchdog for the active account. Callers must have synchronized the
 * active-account snapshot into `config` first; `reconcileBridgeWatchdog()` is
 * the normal entry point after a settings/account change.
 */
function startBridgeWatchdog(): void {
  if (bridgeWatchdogTimer || !bridgeWatchdogPermitted || !config.autoStartBridge || _shutdownInProgress) return;
  const generation = ++bridgeWatchdogGeneration;
  bridgeWatchdogTimer = setInterval(() => {
    void runBridgeWatchdogTick(generation);
  }, 30_000).unref();
}

/**
 * Reconcile the timer with the active account every time its settings are
 * rebound. Only a recovery-relevant route change restarts it: Settings also
 * rebuilds the AccountManager for unrelated saves, which must not erase a
 * watchdog's bounded/exhausted restart state.
 */
function reconcileBridgeWatchdog(): void {
  const nextRoute = activeBridgeWatchdogRoute();
  if (!bridgeWatchdogRouteTracker.reconcile(nextRoute)) return;
  stopBridgeWatchdog();
  if (nextRoute) startBridgeWatchdog();
}

async function runBridgeWatchdogTick(generation: number): Promise<void> {
  let services: AccountServices;
  try {
    services = accountManager.getActive();
  } catch {
    return;
  }
  if (!isCurrentBridgeWatchdog(generation, services)) return;

  // Capture one immutable active-account view for this tick. The generation
  // checks below discard it as soon as Settings changes the active account or
  // turns off auto-start, instead of relaunching with stale module globals.
  const bridgeConfig = configForAccount(services);

  try {
    const [smtpOk, imapOk] = await Promise.all([
      isBridgeReachable(bridgeConfig.smtp.host, bridgeConfig.smtp.port),
      isBridgeReachable(bridgeConfig.imap.host, bridgeConfig.imap.port),
    ]);
    if (!isCurrentBridgeWatchdog(generation, services)) return;

    if (smtpOk && imapOk) {
      // Bridge healthy — reset consecutive-failure counter.
      if (bridgeRestartAttempts > 0) {
        logger.info("Proton Bridge is reachable again", "MCPServer");
        bridgeRestartAttempts = 0;
      }
      return;
    }

    // Bridge is down. Re-check immediately before launch: a disabled account
    // can switch in while the socket probes above are still awaiting.
    if (!isCurrentBridgeWatchdog(generation, services)) return;
    bridgeRestartAttempts += 1;
    if (bridgeRestartAttempts > BRIDGE_MAX_RESTARTS) {
      // Already gave up — don't spam logs.
      return;
    }

    logger.warn(
      `Proton Bridge went away — restart attempt ${bridgeRestartAttempts}/${BRIDGE_MAX_RESTARTS}`,
      "MCPServer"
    );
    // This must receive the captured account configuration rather than the
    // mutable global `config`; a switch cannot redirect an in-flight launch.
    await launchProtonBridge(bridgeConfig);
    if (!isCurrentBridgeWatchdog(generation, services)) return;

    // Try to reconnect the same account's IMAP client if Bridge came back.
    if (bridgeRestartAttempts === 0) {
      // launchProtonBridge reset the counter → it succeeded.
      try {
        if (!isCurrentBridgeWatchdog(generation, services)) return;
        // Reconnect through AccountManager's per-account queue/version fence.
        // A same-ID credential or certificate edit can race this watchdog;
        // the manager retires a stale winner before starting IDLE with the
        // current spec, while a direct service.connect() could resurrect it.
        await accountManager.connectAccount(services.spec.id);
        if (isCurrentBridgeWatchdog(generation, services)) {
          logger.info("IMAP reconnected after Bridge restart", "MCPServer");
        }
      } catch (e: unknown) {
        if (isCurrentBridgeWatchdog(generation, services)) {
          logger.warn("IMAP reconnect failed after Bridge restart", "MCPServer", e);
        }
      }
    }

    if (bridgeRestartAttempts >= BRIDGE_MAX_RESTARTS && isCurrentBridgeWatchdog(generation, services)) {
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
      stopBridgeWatchdog();
    }
  } catch (e: unknown) {
    // An async error here (Promise.all reject, launchProtonBridge throw) would
    // otherwise become an unhandledRejection → gracefulShutdown → process exit.
    if (isCurrentBridgeWatchdog(generation, services)) {
      logger.warn("Bridge watchdog tick failed — will retry next interval", "MCPServer", e);
    }
  }
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

/** Refresh derived state for one mailbox without relying on the active account. */
async function syncAccountBackground(services: AccountServices): Promise<void> {
  const { imap, spec } = services;
  const accountId = spec.id;
  if (!imap.isActive()) return;

  // Hold both a runtime generation and the durable mailbox fingerprint while
  // the network read is outstanding. A settings edit can replace this account
  // ID with a different mailbox in the meantime; that old result must then be
  // discarded rather than indexed, cached, or used to cancel its reminders.
  const generation = accountRuntime.generationFor(accountId);
  let accountIdentity: string;
  try {
    accountIdentity = accountManager.identityForAccount(accountId);
  } catch {
    return;
  }

  try {
    const [inbox, sent] = await Promise.all([
      imap.getEmails("INBOX", 50),
      imap.getEmails("Sent", 50),
    ]);
    let stillCurrent = accountRuntime.isCurrentGeneration(accountId, generation);
    try {
      const current = accountManager.getForAccount(accountId);
      stillCurrent = stillCurrent
        && current.imap === imap
        && accountManager.identityForAccount(accountId) === accountIdentity;
    } catch {
      stillCurrent = false;
    }
    if (!stillCurrent) {
      logger.debug(`Discarded stale background sync for account ${accountId}`, "Scheduler");
      return;
    }

    accountRuntime.updateAnalytics(accountId, inbox, sent, trimForAnalytics);
    logger.debug(`Background sync (${accountId}): ${inbox.length} inbox, ${sent.length} sent`, "Scheduler");

    // Derived indexes are owned by the source account. A failure in optional
    // SQLite support must not prevent reminder detection or other accounts.
    try {
      accountRuntime.getFts(accountId, accountIdentity).upsertMany([...inbox, ...sent].map(recordFromEmail));
    } catch (err: unknown) {
      logger.debug(`FTS incremental upsert failed for account ${accountId}`, "Scheduler", err);
    }

    try {
      const cancelled = reminderService.detectRepliesAndCancel(inbox, accountId);
      if (cancelled.length > 0) {
        logger.info(`Auto-cancelled ${cancelled.length} reminder(s) after replies arrived`, "Scheduler", { accountId });
      }
    } catch (err: unknown) {
      logger.debug(`Reminder reply-detection failed for account ${accountId}`, "Scheduler", err);
    }
  } catch (err: unknown) {
    logger.debug(`Background sync failed for account ${accountId}`, "Scheduler", err);
  }
}

/** Run background work for every configured account; a bad mailbox is isolated. */
async function syncAllAccountsBackground(): Promise<void> {
  await Promise.all(accountManager.list().map(syncAccountBackground));
}

// ─── Daemon: Tray Icon ───────────────────────────────────────────────────────
// Icon generator lives in src/utils/icon.ts and produces a brand-matching
// rounded-square gradient envelope (64×64 base, multi-resolution ICO on
// Windows). Lazy-computed at module load so tests that import index.ts for
// non-tray reasons don't pay the raster cost when they never touch it.
import { makeIconPng, makeTrayIconBytes, makeWarningIconPng, makeWarningTrayIconBytes } from "./utils/icon.js";
import { createTray, preflightTrayBinary, trayPreconditionSkip, inheritDisplayFromParent, type TrayHandle, type TrayItem } from "./utils/tray.js";
import { buildSettingsTrayMenu } from "./utils/tray-menu.js";

// ─── Daemon: Settings Server + Tray State ────────────────────────────────────

let _settingsStop:    (() => Promise<void>) | null = null;
let _settingsEnabled: boolean = false;
let _settingsUrl:     string  = "";
// When the settings UI can't bind, this records why (e.g. "ports 8766–8776 all
// in use") so the tray can surface it instead of the "Open Settings" entry
// silently vanishing. Cleared whenever the UI comes up.
let _settingsUnavailableReason: string | undefined;
/**
 * True when `_settingsUrl` points at a standalone `mailpouch-settings`
 * daemon we did NOT spawn — the port was already owned by another
 * mailpouch UI at boot, and we're deferring to it. The tray "Disable
 * Settings UI" action must not try to kill a process we don't own; it
 * just detaches our own references.
 */
let _settingsExternal: boolean = false;
let _trayInstance:    TrayHandle | null = null;
let _trayTooltip:     string = "mailpouch";
// ── Health blink: while the mail connection is failing (IMAP login failure or
// an ongoing connection problem), the tray icon alternates between the normal
// envelope and a red ⚠ triangle every 5s so the operator can't miss it. ─────
let _trayHealthTimer: ReturnType<typeof setInterval> | null = null;
let _trayDegraded:    boolean = false; // currently in the blink regime
let _trayBlinkWarn:   boolean = false; // which icon is showing this tick
let _normalTrayBytes: Buffer | null = null;
let _warnTrayBytes:   Buffer | null = null;

/** True while mailpouch can't maintain its mail connection — drives the blink. */
function _mailConnectionFailing(): boolean {
  return !!(imapService.idleAuthFailure || imapService.idleLastIssue);
}

/** Runs every 5s. Blinks the icon while failing; restores it once recovered. */
function _tickTrayHealth(): void {
  if (!_trayInstance || !_normalTrayBytes || !_warnTrayBytes) return;
  try {
    if (_mailConnectionFailing()) {
      _trayDegraded = true;
      _trayBlinkWarn = !_trayBlinkWarn;
      _trayInstance.setIcon(_trayBlinkWarn ? _warnTrayBytes : _normalTrayBytes);
      const reason = imapService.idleAuthFailure?.message
        ?? imapService.idleLastIssue?.message
        ?? "mail connection problem";
      const tip = `mailpouch · ⚠ ${reason}`;
      if (tip !== _trayTooltip) { _trayInstance.setTooltip(tip); _trayTooltip = tip; }
    } else if (_trayDegraded) {
      // Recovered — stop blinking, restore the normal icon + tooltip/menu.
      _trayDegraded = false;
      _trayBlinkWarn = false;
      _trayInstance.setIcon(_normalTrayBytes);
      _rebuildTray();
    }
  } catch (err: unknown) {
    logger.debug("Tray health tick failed", "MCPServer", err);
  }
}

/**
 * Probe whether a mailpouch settings UI is already serving on `port`.
 * Returns the base URL if the port is occupied by another mailpouch UI
 * (identified by a valid `/api/status` response with the expected shape),
 * or null if the port is free or occupied by something else.
 *
 * Used so we can defer to a user-run `mailpouch-settings` daemon instead
 * of retrying + warning — the common "standalone settings UI plus stdio
 * MCP in separate processes" setup was previously noisy.
 */
async function _probeExistingMailpouchUi(port: number): Promise<string | null> {
  const http = await import("node:http");
  return new Promise<string | null>((resolve) => {
    let settled = false;
    const finish = (url: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(url);
    };
    const req = http.request(
      { host: "127.0.0.1", port, path: "/api/status", method: "GET", timeout: 750 },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          body += chunk;
          // Body-size cap: a legit /api/status payload is well under 256 B.
          // Anything >4 KB is either a chatty non-mailpouch listener or an
          // attempt to RAM-bomb the probe; either way, abort + resolve so
          // the Promise doesn't hang when we tear the socket down (res
          // destroy does not reliably emit 'end' on an abort path).
          if (body.length > 4096) { res.destroy(); finish(null); }
        });
        res.on("end", () => {
          try {
            const parsed = JSON.parse(body) as Record<string, unknown>;
            if (typeof parsed.hasConfig === "boolean") {
              finish(`http://localhost:${port}`);
              return;
            }
          } catch { /* not JSON — not a mailpouch UI */ }
          finish(null);
        });
        res.on("error",   () => finish(null));
        res.on("close",   () => finish(null));
        res.on("aborted", () => finish(null));
      },
    );
    req.on("error", () => finish(null));
    req.on("timeout", () => { req.destroy(); finish(null); });
    req.end();
  });
}

async function _startSettingsServerDaemon(): Promise<void> {
  const basePort = config.settingsPort ?? 8766;

  // If a user-run `mailpouch-settings` instance is already serving on the
  // configured port, reuse it silently rather than retry-and-warn. Probes with
  // a short GET /api/status — any non-mailpouch listener (e.g. a stray
  // `python3 -m http.server`) responds with a different shape and falls through
  // to the bind-then-fallback path below.
  const existing = await _probeExistingMailpouchUi(basePort);
  if (existing) {
    _settingsUrl      = existing;
    _settingsEnabled  = true;
    _settingsExternal = true;
    _settingsUnavailableReason = undefined;
    logger.info(`Reusing existing Settings UI at ${existing}`, "MCPServer");
    return;
  }

  // Bind the configured port; if it's held by a FOREIGN process (not a
  // reusable mailpouch UI — the probe above already ruled that out), retrying
  // the same port forever is pointless, so fall back to the next ports. The
  // configured port still gets a couple of quick retries first to cover the
  // transient "a mailpouch is restarting on it" window.
  const PORT_FALLBACK_SPAN = 10;     // try basePort … basePort+10
  const BASE_PORT_RETRIES  = 3;      // transient EADDRINUSE on the configured port
  const retryMs            = 1000;
  for (let offset = 0; offset <= PORT_FALLBACK_SPAN; offset++) {
    const port = basePort + offset;
    if (port > 65535) break; // never try an out-of-range port (Node rejects >65535)
    const retries = offset === 0 ? BASE_PORT_RETRIES : 1; // only the base port waits
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const { scheme, stop } = await startSettingsServer(port, false, true /* quiet */, {
          onRestartRequested: () => setImmediate(() => gracefulShutdown("update_restart")),
          onShutdownRequested: () => setImmediate(() => gracefulShutdown("ui-shutdown").catch(() => process.exit(1))),
          // Live snapshot for GET /api/status so `mailpouch status` reads the
          // running instance's authoritative connection + agent state.
          onStatus: () => ({
            connected: sharedState.smtpStatus.connected,
            account: config.smtp.username || "",
            pendingCount: agentGrants.list({ status: "pending" }).length,
            activeCount: agentGrants.list({ status: "active" }).length,
          }),
        });
        _settingsStop    = stop;
        _settingsUrl     = `${scheme}://localhost:${port}`;
        _settingsEnabled = true;
        _settingsUnavailableReason = undefined;
        if (offset === 0) {
          logger.info(`Settings UI started at ${_settingsUrl}`, "MCPServer");
        } else {
          logger.warn(
            `Settings UI: configured port ${basePort} was occupied by another process — bound to ${port} instead. ` +
            `Open ${_settingsUrl}. To pin a port, set settingsPort in ~/.mailpouch.json.`,
            "MCPServer",
          );
        }
        return;
      } catch (err: unknown) {
        const isInUse = (err as NodeJS.ErrnoException).code === "EADDRINUSE";
        if (isInUse && attempt < retries) {
          logger.debug(`Settings UI port ${port} in use, retrying (${attempt}/${retries})…`, "MCPServer");
          await new Promise(r => setTimeout(r, retryMs));
          continue;
        }
        if (isInUse) {
          // This candidate port is taken; move on to the next one.
          logger.debug(`Settings UI port ${port} in use; trying ${port + 1}.`, "MCPServer");
          break;
        }
        // Non-EADDRINUSE failure (e.g. bad bind address) — don't keep trying.
        logger.warn("Settings UI failed to start", "MCPServer", err);
        _markSettingsUnavailable("settings server failed to start");
        return;
      }
    }
  }

  // Every candidate port was occupied.
  const span = `${basePort}–${basePort + PORT_FALLBACK_SPAN}`;
  logger.warn(
    `Settings UI could not bind any port in ${span} — all are in use by other processes. ` +
    `Free one, or set settingsPort in ~/.mailpouch.json (or the PORT env var) to a free port, and restart.`,
    "MCPServer",
  );
  _markSettingsUnavailable(`ports ${span} all in use`);
}

async function _stopSettingsServerDaemon(): Promise<void> {
  // When we're reusing a standalone `mailpouch-settings` instance we
  // didn't spawn, there's no process for us to stop — just detach our
  // references so the tray toggle state stays consistent. Killing it
  // would be wrong (we don't own its lifetime) AND impossible (no stop
  // function was ever handed to us).
  if (_settingsExternal) {
    logger.info("Detaching from external Settings UI (process keeps running)", "MCPServer");
    _settingsExternal = false;
    _settingsEnabled  = false;
    _settingsUrl      = "";
    return;
  }
  if (_settingsStop) {
    try {
      await _settingsStop();
      logger.info("Settings UI stopped", "MCPServer");
    } catch (err: unknown) {
      logger.warn("Settings UI stop error", "MCPServer", err);
    } finally {
      _settingsStop    = null;
      _settingsEnabled = false;
      _settingsUrl     = "";
    }
  }
}

function _buildTrayItems(): { items: TrayItem[]; tooltip: string } {
  // Pure menu construction lives in buildSettingsTrayMenu (unit-tested); this
  // adapter just snapshots the live state it reads from.
  return buildSettingsTrayMenu({
    version:         _pkgVersion,
    connected:       sharedState.smtpStatus.connected,
    account:         config.smtp.username || "",
    pendingCount:    agentGrants.list({ status: "pending" }).length,
    activeCount:     agentGrants.list({ status: "active" }).length,
    settingsEnabled: _settingsEnabled,
    settingsUrl:     _settingsUrl,
    settingsUnavailableReason: _settingsUnavailableReason,
  });
}

/**
 * UI-015: collapse the settings-UI state to "off, no URL" and rebuild the tray.
 * Called on every failed bind so the menu never shows "Open Settings" with an
 * empty `_settingsUrl`. The `_settingsEnabled === !!_settingsUrl` invariant must
 * hold after every state change.
 */
function _markSettingsUnavailable(reason?: string): void {
  _settingsEnabled = false;
  _settingsUrl     = "";
  _settingsUnavailableReason = reason;
  _rebuildTray();
}

function _rebuildTray(): void {
  if (!_trayInstance) return;
  try {
    const { items, tooltip } = _buildTrayItems();
    _trayInstance.setMenu(items);
    if (tooltip !== _trayTooltip) {
      _trayInstance.setTooltip(tooltip);
      _trayTooltip = tooltip;
    }
  } catch (err: unknown) {
    logger.debug("Tray menu update failed", "MCPServer", err);
  }
}

async function _initTray(): Promise<void> {
  // Claude Desktop / VS Code strip DISPLAY from stdio-spawned children
  // even on graphical hosts — copy it from the parent's environ before
  // the precondition check so GTK can connect.
  inheritDisplayFromParent();

  const skipReason = trayPreconditionSkip();
  if (skipReason) {
    logger.debug(`Tray: ${skipReason}`, "MCPServer");
    return;
  }
  // Fix the mode-0644 shipping bug before the systray2 fallback's spawn.
  preflightTrayBinary();

  try {
    const { items, tooltip } = _buildTrayItems();
    _trayTooltip = tooltip;
    const tray = createTray({
      iconPng: makeIconPng(64),
      iconLegacyOverride: process.platform === "win32" ? makeTrayIconBytes("win32") : undefined,
      tooltip,
      items,
      onClick: (id) => {
        switch (id) {
          case "open":
            openBrowser(_settingsUrl);
            break;
          case "disable":
            _stopSettingsServerDaemon()
              .then(() => _rebuildTray())
              .catch((err: unknown) => logger.warn("Settings disable failed", "MCPServer", err));
            break;
          case "enable":
            _startSettingsServerDaemon()
              .then(() => _rebuildTray())
              .catch((err: unknown) => logger.warn("Settings enable failed", "MCPServer", err));
            break;
          case "quit":
            gracefulShutdown("tray-quit").catch(() => process.exit(1));
            break;
        }
      },
    });
    _trayInstance = tray;
    logger.info(`System tray icon active (${tray.backend} backend)`, "MCPServer");

    // Precompute the normal + warning icon bytes once, in the format this
    // backend's setIcon() expects (native takes PNG; systray2 the platform
    // bytes — ICO on Windows), then start the 5s health-blink timer.
    const usePng = tray.backend !== "systray2";
    _normalTrayBytes = usePng ? makeIconPng(64) : makeTrayIconBytes();
    _warnTrayBytes   = usePng ? makeWarningIconPng(64) : makeWarningTrayIconBytes();
    _trayHealthTimer = setInterval(_tickTrayHealth, 5000);
    _trayHealthTimer.unref();

    // Keep the tray menu in sync with grant changes (new pending → badge,
    // approved/revoked → count update).
    agentNotifications.subscribe(() => {
      try { _rebuildTray(); } catch { /* swallow */ }
    });
  } catch (err: unknown) {
    logger.warn("Tray icon failed to start", "MCPServer", err);
    _trayInstance = null;
  }
}

async function main() {
  // Resolve the invocation up front. Known subcommands and --help/--version are
  // handled and EXIT; an unknown positional command is an error and exits — it
  // never falls through to boot a server. Only a bare or flag-only invocation
  // (the MCP stdio child an MCP client spawns) reaches the server path below.
  // This is the fix for `mailpouch status` / `--help` silently booting a second
  // full server in the foreground beside the real daemon.
  const invocation = resolveInvocation(process.argv);

  if (invocation.kind === "help") {
    process.stdout.write(`${USAGE}\n\nPaths:\n  config: ${getConfigPath()}\n  log:    ${getLogFilePath()}\n`);
    process.exit(0);
  }
  if (invocation.kind === "version") {
    // --version is used by tarball-smoke and routinely to identify the binary.
    process.stdout.write(`mailpouch v${_pkgVersion}\n`);
    process.exit(0);
  }
  if (invocation.kind === "unknown") {
    process.stderr.write(`mailpouch: unknown command '${invocation.arg}'\n\n${USAGE}\n`);
    process.exit(2);
  }

  // Offline admin subcommands run before any server side effects (no Bridge
  // connect, no transport) and exit. `daemon` is the exception — it continues
  // into the server path below in HTTP mode. Args are taken after the
  // subcommand token so `mailpouch <cmd> [flags]` parses correctly.
  if (invocation.kind === "subcommand" && invocation.name !== "daemon") {
    const subIdx = process.argv.indexOf(invocation.name, 2);
    const subArgs = subIdx >= 0 ? process.argv.slice(subIdx + 1) : [];
    switch (invocation.name) {
      case "agent": {
        const { runAgentCli } = await import("./cli/agent-cli.js");
        process.exit(await runAgentCli(subArgs, { serviceAccounts, agentGrants }));
        break;
      }
      case "setup": {
        const { runSetupCli } = await import("./cli/setup-cli.js");
        process.exit(await runSetupCli(subArgs));
        break;
      }
      case "doctor": {
        const { runDoctorCli } = await import("./cli/doctor-cli.js");
        process.exit(await runDoctorCli(subArgs));
        break;
      }
      case "status": {
        const { runStatusCli } = await import("./cli/status-cli.js");
        process.exit(await runStatusCli(subArgs));
        break;
      }
    }
  }

  // `mailpouch daemon [--host H] [--port P]` runs the shared HTTP daemon
  // explicitly — forces the HTTP transport regardless of `remoteMode` so many
  // clients (Claude Code over HTTP, cowork, headless service accounts) share
  // one IMAP connection. It is a deliberate, user-started process (run it in a
  // tmux / login session) — NOT an autostart.
  const argVal = (flag: string): string | undefined => {
    const i = process.argv.indexOf(flag);
    return i >= 0 ? process.argv[i + 1] : undefined;
  };
  const daemonMode = invocation.kind === "subcommand" && invocation.name === "daemon";
  const daemonHostOverride = daemonMode ? argVal("--host") : undefined;
  const daemonPortOverride = daemonMode ? argVal("--port") : undefined;

  const noTray       = process.argv.includes("--no-tray");
  const noSettingsUi = process.argv.includes("--no-settings-ui");
  // `--settings-only` runs JUST the settings UI + tray: no MCP transport, no
  // Bridge backends. Historically this flag was UNRECOGNISED, so the process
  // fell through to the stdio MCP server whose lifetime is bound to stdin —
  // launched without a live MCP client holding stdin open (autostart, nohup, a
  // wrapper), stdin hit EOF immediately and the process shut itself down within
  // seconds. That self-termination read as "it keeps crashing." Treating it as
  // a real mode keeps the process alive on the settings HTTP server instead.
  const settingsOnly = process.argv.includes("--settings-only");
  if (settingsOnly && noSettingsUi) {
    logger.error(
      "--settings-only and --no-settings-ui are contradictory (there would be nothing to run). " +
      "Pass one or the other.",
      "MCPServer",
    );
    process.exit(1);
  }

  // Clear log file from previous run so each session starts fresh
  try { writeFileSync(getLogFilePath(), "", { encoding: "utf8", mode: 0o600 }); } catch { /* ignore */ }

  logger.info(`Starting mailpouch v${_pkgVersion}`, "MCPServer");

  // Live-mail E2E uses a private, short-lived config clone. It must neither
  // migrate that clone's plaintext into the operator's real keychain slots nor
  // let an existing legacy keychain entry override the clone. The bypass is
  // accepted only when the exact UUID token and canonical temp filename agree;
  // setting the environment flag against a normal config fails closed.
  const startupCredentialAccess = new StartupCredentialAccess(process.env, getConfigPath());

  // Migrate plaintext credentials to OS keychain if available
  try {
    const migrated = await startupCredentialAccess.migrate(migrateCredentials);
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

      // Surface a clear startup warning when bridgeCertPath is configured
      // but unreachable on disk — common after moving config across machines
      // (e.g. a Windows path copied to a Linux install). Connection-time
      // errors arrive buried inside tool responses; the startup warning gets
      // the fix in front of the operator before they hit the first failure.
      if (cn.bridgeCertPath) {
        const cpath = cn.bridgeCertPath;
        if (!existsSync(cpath)) {
          const looksWindowsOnUnix = process.platform !== "win32" && /^[A-Za-z]:[\\/]/.test(cpath);
          const looksUnixOnWindows = process.platform === "win32" && cpath.startsWith("/");
          const platformHint = looksWindowsOnUnix
            ? ` — the path looks Windows-style but this host is ${process.platform}.`
            : looksUnixOnWindows
              ? " — the path looks POSIX-style but this host is Windows."
              : "";
          logger.warn(
            `bridgeCertPath '${cpath}' does not exist on disk${platformHint} ` +
            `Open the settings UI → Bridge TLS Certificate to re-export the cert, ` +
            `or enable 'Allow insecure Bridge' for a loopback-only install.`,
            "MCPServer",
          );
        }
      }
      config.debug              = !!cn.debug;
      config.autoStartBridge    = !!cn.autoStartBridge;
      config.bridgePath         = cn.bridgePath || undefined;
      config.settingsPort       = fileConfig.settingsPort ?? 8766;

      // CRED-001: Pass PAT + SimpleLogin API key are keychain-routable. Use
      // the same replacement path as live Settings saves so startup and
      // hot-refresh semantics cannot drift.
      await refreshAuxiliaryServicesFromConfig(startupCredentialAccess);
      logger.setDebugMode(!!cn.debug);
      tracer.setEnabled(!!cn.debug);

      // Password: keychain takes priority over config file plaintext
      // The strict E2E clone carries the normal quarantine marker plus
      // encrypted-file fields, so this helper decrypts the clone while
      // skipping every OS-keychain read. Normal configs retain the existing
      // keychain-first behavior.
      const keychainCreds = await startupCredentialAccess.readMailbox(
        loadCredentialsFromConfigFile,
        loadCredentialsFromKeychain,
      );
      // CRED-010: an encrypted blob that failed authenticated decryption is a
      // tamper indicator. loadCredentialsFromKeychain signals this distinctly so
      // we must NOT fall back to the coexisting plaintext field — leave the
      // password/token empty (send/receive fails closed until re-encrypted).
      if (keychainCreds?.storage === "decrypt-failed") {
        logger.error(
          "Encrypted Bridge credential failed authenticated decryption — refusing to use any plaintext credential from the same config. Re-enter the credential in Settings to re-encrypt.",
          "MCPServer",
        );
      } else if (keychainCreds?.password) {
        config.smtp.password = keychainCreds.password;
        config.imap.password = keychainCreds.password;
        logger.debug(`Bridge password loaded from ${keychainCreds.storage}`, "MCPServer");
      } else if (cn.password) {
        config.smtp.password = cn.password;
        config.imap.password = cn.password;
        logger.debug("Bridge password loaded from config file", "MCPServer");
      }
      if (keychainCreds?.storage === "decrypt-failed") {
        // already logged above; do not fall back to plaintext smtpToken either
      } else if (keychainCreds?.smtpToken) {
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

  // ── Instance singleton guard (Cluster 2, 2026-05-31 report) ───────────────
  // The MCP is launched per client (Claude Desktop, VS Code, every
  // `claude --continue` session). Each instance otherwise opens its OWN IMAP
  // IDLE/auth loop against the same mailbox — a compounded connection leak.
  // This process connects EVERY account in one configuration profile, so the
  // lock must cover the profile rather than only its currently active mailbox.
  // Otherwise two processes with different active accounts can each acquire a
  // lock yet both open IDLE sessions for all overlapping mailboxes. Stale
  // records are deliberately fail-closed rather than automatically removed:
  // a PID-check followed by unlink can erase a freshly-acquired rival lock.
  // MAILPOUCH_NO_SINGLETON=1 remains the explicit escape hatch for intentional
  // multi-instance setups.
  if (process.env.MAILPOUCH_NO_SINGLETON !== "1") {
    try {
      const outcome = acquireSingletonLock(`profile:${getConfigPath()}`);
      if (outcome.status === "held-by-live-instance") {
        logger.info(
          `Another mailpouch instance for this configuration profile is already running (pid ${outcome.pid}); ` +
          `exiting so we don't open duplicate IMAP connections for its accounts. ` +
          `Set MAILPOUCH_NO_SINGLETON=1 to allow multiple instances.`,
          "MCPServer",
        );
        process.exit(0);
        return;
      }
      if (outcome.status === "stale-lock") {
        const holder = outcome.pid === null ? "an invalid owner record" : `dead pid ${outcome.pid}`;
        logger.error(
          `Singleton lock at ${outcome.path} contains ${holder}. ` +
          "It was not removed automatically because doing so can race a newly-starting daemon. " +
          "After confirming no mailpouch process owns this profile, remove that lock manually and retry. " +
          "Set MAILPOUCH_NO_SINGLETON=1 only when intentionally running multiple instances.",
          "MCPServer",
        );
        process.exit(1);
        return;
      }
      if (outcome.status === "unavailable") {
        logger.error(
          `Could not safely acquire singleton lock at ${outcome.path}; refusing to start duplicate mailbox connections. ` +
          "Check the lock path and its parent permissions, then retry.",
          "MCPServer",
        );
        process.exit(1);
        return;
      }
      _singletonLockPath = outcome.path;
    } catch (e: unknown) {
      // A lock error must not turn into an unguarded second daemon. The helper
      // normally returns `unavailable`; retain this catch for coding/runtime
      // faults and fail closed too.
      logger.error("Singleton lock check failed; refusing unguarded startup", "MCPServer", e);
      process.exit(1);
      return;
    }
  }

  // Rebuild service pairs from the account registry now that keychain-backed
  // credentials are available. Do not fan the legacy top-level credential out
  // to every account: each account's keychain entry is its sole authority.
  try {
    await accountManager.rebuildFromRegistryAsync();
  } catch (e: unknown) {
    logger.warn("Async registry rebuild failed (falling back to sync view)", "MCPServer", e);
  }
  // Background records outlive the active account. Bind their owner resolver
  // only after the account registry (and keychain-backed services) is ready,
  // then migrate pre-account records to the persisted active mailbox with the
  // services' timestamped owner-only backups.
  schedulerService.configureAccountRouting(
    () => accountManager.activeAccountId(),
    (accountId) => {
      try { return accountManager.getForAccount(accountId).smtp; }
      catch { return undefined; }
    },
    (accountId) => {
      try { return accountManager.identityForAccount(accountId); }
      catch { return undefined; }
    },
  );
  reminderService.configureAccountRouting(
    () => accountManager.activeAccountId(),
    (accountId) => {
      try { return accountManager.identityForAccount(accountId); }
      catch { return undefined; }
    },
  );
  smtpService.reinitialize();

  // ── Settings UI: bind BEFORE any backend connectivity (Cluster 4) ─────────
  // The bind used to be sequenced after the IMAP/SMTP connect block below.
  // When a backend probe/verify hung (observed after 3-day uptime), the
  // settings HTTP server NEVER bound — leaving the UI unreachable precisely
  // when the operator needed it to fix the misconfiguration. Bind first so the
  // UI is up whether or not Bridge is reachable. A watchdog logs every 15s
  // while the bind is still pending, naming what it's waiting on.
  if (!noSettingsUi) {
    const bindWatchdog = setInterval(() => {
      if (!_settingsEnabled) {
        logger.warn(
          `Settings UI not yet bound on port ${config.settingsPort ?? 8766} — still waiting on the HTTP server bind. ` +
          `The UI should be reachable independent of Bridge connectivity; if this repeats, the port may be occupied.`,
          "MCPServer",
        );
      }
    }, 15_000);
    bindWatchdog.unref();
    try {
      await _startSettingsServerDaemon();
    } finally {
      clearInterval(bindWatchdog);
    }
  }
  // Only the process that owns the settings server gets a tray. If another MCP
  // already holds the port, _settingsExternal is true and that process already
  // has the tray — skip to avoid duplicates.
  if (!noTray && !_settingsExternal) {
    _initTray().catch((err: unknown) => logger.warn("Tray init error", "MCPServer", err));
  }

  // ── Settings-only mode: stop here ─────────────────────────────────────────
  // The settings UI + tray are up. We deliberately do NOT connect to Bridge,
  // start the scheduler/IDLE loop, or attach an MCP transport — none of those
  // belong to a standalone settings launcher, and the stdio transport's
  // stdin-close handler is exactly what made `--settings-only` self-terminate.
  // The settings HTTP server (and tray) keep the event loop alive; the process
  // runs until the tray's Quit or a signal. If the settings server failed to
  // bind there is nothing left to keep us alive, so fail loudly rather than
  // exit silently looking like another "crash."
  if (settingsOnly) {
    if (!_settingsEnabled && !_settingsExternal) {
      logger.error(
        `Settings UI failed to bind (port ${config.settingsPort ?? 8766} may be occupied) and --settings-only was requested — ` +
        "nothing left to run. Free the port, or set settingsPort in ~/.mailpouch.json (or the PORT env var), then retry.",
        "MCPServer",
      );
      process.exit(1);
    }
    logger.info(
      "Settings-only mode: settings UI + tray are running; MCP transport and Bridge backends are NOT started. " +
      "Quit via the tray menu or Ctrl-C.",
      "MCPServer",
    );
    return;
  }

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
  }

  // Settings-only mode returns before this point, so account rebuild events
  // can never arm a Bridge watchdog in its UI-only process. Once the initial
  // probe/optional launch has settled, let active-account changes reconcile
  // the recurring watchdog from the live configuration.
  bridgeWatchdogPermitted = true;
  reconcileBridgeWatchdog();

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
        const status = { connected: true, lastCheck: new Date() };
        sharedState.smtpStatus = status;
        accountRuntime.setSmtpStatus(accountManager.activeAccountId(), status);
        logger.info("SMTP connection verified", "MCPServer");
      }).catch((e: unknown) => {
        const status = { connected: false, lastCheck: new Date(), error: diagnosticErrorMessage(e) };
        sharedState.smtpStatus = status;
        accountRuntime.setSmtpStatus(accountManager.activeAccountId(), status);
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

    // Start background IDLE for push cache invalidation — for EVERY account,
    // not just the active one, so a non-active account still receives INBOX
    // EXISTS/EXPUNGE push invalidations instead of degrading to manual syncs.
    // startIdle() is idempotent (guarded by idleActive), and since every
    // account watches from boot, an account hot-swap needs no extra wiring.
    if (config.debug) {
      logger.debug('Starting IMAP IDLE background watcher for all accounts', 'MCPServer');
    }
    for (const svcs of accountManager.list()) {
      svcs.imap.startIdle().catch(err => logger.debug('IDLE startup failed', 'MCPServer', err));
    }

    // Start the email scheduler (loads persisted pending emails, begins 60s poll)
    schedulerService.start();

    // PERM-010: periodically flush per-agent call counters to disk. recordCall
    // bumps totalCalls/lastCallAt in memory and defers the fsync for hot-path
    // cheapness; without a periodic flush (and the shutdown flush below) every
    // restart silently dropped the counts since the last grant status change.
    setInterval(() => {
      try { agentGrants.flushCounters(); }
      catch (err: unknown) { logger.debug("agent-grant counter flush failed", "MCPServer", err); }
    }, 5 * 60_000).unref();

    // Expire pending agent approvals after 5 minutes: if the user doesn't
    // Approve/Deny in time, the request is deleted (token revoked) and the
    // agent must connect/auth again. Swept every 30s for promptness.
    const PENDING_APPROVAL_TTL_MS = 5 * 60_000;
    setInterval(() => {
      try {
        const n = agentGrants.expireStalePending(PENDING_APPROVAL_TTL_MS);
        if (n > 0) logger.info(`Expired ${n} pending agent approval request(s) after ${PENDING_APPROVAL_TTL_MS / 60_000} min`, "MCPServer");
      } catch (err: unknown) { logger.debug("pending-approval expiry sweep failed", "MCPServer", err); }
    }, 30_000).unref();

    // ── Background auto-sync ────────────────────────────────────────────────
    if (config.autoSync && (config.syncInterval ?? 0) > 0) {
      const intervalMs = (config.syncInterval as number) * 60 * 1000;
      setInterval(async () => {
        await syncAllAccountsBackground();
      }, intervalMs).unref(); // .unref() so the timer doesn't prevent clean exit
    }

    // Transport selection: HTTP when remoteMode=true in the config (with a
    // bearer token or OAuth), otherwise the default stdio transport that
    // Claude Desktop spawns.
    const loadedCfg = loadConfig();
    const remoteCn = loadedCfg?.connection;
    // Prefer keychain-stored remote secrets over the (legacy) plaintext
    // config-file values. When both are present the keychain wins, matching
    // the loadCredentialsFromKeychain priority chain for password/smtpToken.
    const { loadRemoteSecrets } = await import("./security/keychain.js");
    const remoteSecrets = await startupCredentialAccess.readExternal(loadRemoteSecrets);
    // OAuth is now the ONLY remote-auth mechanism: every agent authenticates as
    // its own client (authorization_code for interactive, client_credentials for
    // service accounts) so each is independently gated, audited, and revocable.
    // The legacy shared static bearer was removed — a present remoteBearerToken
    // is ignored with a migration warning. An admin password was already gone.
    const hasOAuth  = !!remoteCn?.remoteOauthEnabled;
    if (remoteSecrets?.remoteBearerToken || remoteCn?.remoteBearerToken) {
      logger.warn(
        "remoteBearerToken is configured but the static shared bearer was removed and will be ignored — " +
        "it bypassed per-agent gating and audit. For programmatic/headless access, issue a service account: " +
        "`mailpouch agent issue --name <name> --preset <preset>`. Remove remoteBearerToken from your config.",
        "MCPServer",
      );
    }
    if (remoteSecrets?.remoteOauthAdminPassword || remoteCn?.remoteOauthAdminPassword) {
      logger.warn(
        "remoteOauthAdminPassword is configured but is no longer supported and will be ignored — " +
        "OAuth uses automatic consent; agents are gated solely by per-agent Approve/Deny in the Agents tab.",
        "MCPServer",
      );
    }
    // MAILPOUCH_FORCE_STDIO=1 forces stdio for this spawn even when the config
    // has remoteMode:true — lets a stdio MCP-client entry (e.g. Claude Code)
    // coexist with the shared HTTP daemon config without a duplicate file.
    // `mailpouch daemon` forces HTTP regardless of remoteMode (and ignores
    // FORCE_STDIO — running the daemon is an explicit HTTP intent).
    const forceStdio = !daemonMode && forceStdioFromEnv(process.env.MAILPOUCH_FORCE_STDIO);
    if (forceStdio && remoteCn?.remoteMode) {
      logger.info("MAILPOUCH_FORCE_STDIO is set — using stdio transport despite remoteMode=true in config.", "MCPServer");
    }
    if (chooseTransport({ remoteMode: remoteCn?.remoteMode, forceStdio, forceHttp: daemonMode }) === "http") {
      if (!hasOAuth) {
        logger.error(
          (daemonMode
            ? "`mailpouch daemon` runs the shared HTTP daemon, which requires OAuth. "
            : "remoteMode is set but remoteOauthEnabled is not. ") +
          "The static shared bearer was removed — OAuth is required so every agent authenticates as its own gated client. " +
          "Set remoteOauthEnabled=true in ~/.mailpouch.json and issue a service account for headless clients " +
          "(`mailpouch agent issue ...`). Refusing to start without OAuth.",
          "MCPServer"
        );
        process.exit(1);
      }
      const daemonPort = daemonPortOverride ? Number(daemonPortOverride) : undefined;
      if (daemonPortOverride && (!Number.isInteger(daemonPort) || daemonPort! < 1 || daemonPort! > 65535)) {
        logger.error(`Invalid --port '${daemonPortOverride}'.`, "MCPServer");
        process.exit(1);
      }
      const { startHttpTransport } = await import("./transports/http.js");
      const handle = await startHttpTransport({
        server,
        createServer: createSessionServer,
        host: daemonHostOverride || remoteCn?.remoteHost || "127.0.0.1",
        port: daemonPort ?? remoteCn?.remotePort ?? 8788,
        path: remoteCn?.remotePath || "/mcp",
        tlsCertPath: remoteCn?.remoteTlsCertPath || undefined,
        tlsKeyPath:  remoteCn?.remoteTlsKeyPath  || undefined,
        oauthEnabled: !!remoteCn?.remoteOauthEnabled,
        oauthIssuer: remoteCn?.remoteOauthIssuer || undefined,
        rateLimitPerSecond: remoteCn?.remoteRateLimitPerSecond ?? undefined,
        rateLimitBurst: remoteCn?.remoteRateLimitBurst ?? undefined,
        agentGrants,
        serviceAccounts,
        oauthTokensPath: OAUTH_TOKENS_PATH,
      });
      logger.info(`mailpouch started on HTTP transport at ${handle.url}${handle.issuer ? ` (OAuth issuer ${handle.issuer})` : ""}`, "MCPServer");
      (globalThis as unknown as { __mailpouchHttpHandle?: { close(): Promise<void> } }).__mailpouchHttpHandle = handle;
    } else {
      const transport = new StdioServerTransport();
      await server.connect(transport);
      logger.info("mailpouch started on stdio transport.", "MCPServer");
      // When the MCP client (Claude cowork) exits, stdin closes.  Treat that
      // as a graceful-quit signal so the tray and settings server shut down
      // rather than keeping the process alive indefinitely.
      process.stdin.on("close", () => {
        gracefulShutdown("stdin-closed").catch(() => process.exit(1));
      });
    }

    // NOTE: the settings HTTP server + system tray are now started ABOVE,
    // before the Bridge reachability probe and backend connect (Cluster 4),
    // so the UI is reachable even when a backend hangs. Nothing to do here.
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
  if (_shutdownInProgress) return;
  _shutdownInProgress = true;
  logger.info(`Received ${signal}, shutting down gracefully...`, "MCPServer");

  // Bridge is often off at quit time; disconnect() can wait on a dead TCP socket.
  // Guarantee process exit within 5 s regardless of cleanup outcome.
  const hardExit = setTimeout(() => {
    if (_trayInstance) { try { _trayInstance.destroy(); } catch { } }
    process.exit(0);
  }, 5000);
  hardExit.unref();

  try {
    // 0. Destroy tray first so the icon vanishes immediately on click.
    if (_trayHealthTimer) { clearInterval(_trayHealthTimer); _trayHealthTimer = null; }
    if (_trayInstance) {
      try { _trayInstance.destroy(); } catch { /* ignore */ }
      _trayInstance = null;
    }

    // 0b. Stop settings server
    await _stopSettingsServerDaemon();

    // 1. Stop bridge watchdog and invalidate any async tick already in flight.
    bridgeWatchdogPermitted = false;
    stopBridgeWatchdog();

    // PERM-010: flush any unpersisted per-agent call counters before exit.
    try { agentGrants.flushCounters(); }
    catch (err: unknown) { logger.debug("agent-grant counter flush on shutdown failed", "MCPServer", err); }
    // Closes only the SQLite connection; durable quota state remains intact
    // for the rolling window after a restart (no forced checkpoint/deletion).
    try { agentGrants.close(); }
    catch (err: unknown) { logger.debug("agent-grant quota ledger close failed", "MCPServer", err); }

    // 2. Stop scheduler (persists pending items before close)
    schedulerService.stop();

    // 3. Stop and scrub EVERY account, not just the current active binding.
    // Each account owns a separate main IMAP client, IDLE client, SMTP pool,
    // cache, and credentials; leaving a non-active service alive would retain
    // an authenticated mailbox connection after shutdown.
    await accountManager.closeAll();

    // 4. Scrub derived sensitive data from memory
    accountRuntime.disposeAll();

    // Release the profile singleton lock only after every account connection
    // has been retired. Releasing it earlier permits a replacement process to
    // open duplicate IMAP/IDLE sessions while this process is still closing.
    if (_singletonLockPath) {
      try { releaseSingletonLock(_singletonLockPath); } catch { /* best-effort */ }
      _singletonLockPath = null;
    }

    // 5. Wipe top-level config credentials
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
    clearTimeout(hardExit);
    // Brief pause so the native tray's D-Bus deregistration message can flush
    // before file descriptors close on exit.
    await new Promise(r => setTimeout(r, 50));
    process.exit(0);
  } catch (error) {
    logger.error(`Error during ${signal} shutdown`, "MCPServer", error);
    clearTimeout(hardExit);
    process.exit(1);
  }
}

// Last-resort wipe on any exit path
process.on("exit", () => {
  try {
    accountManager.wipeAll();
    accountRuntime.disposeAll();
  } catch { /* best-effort */ }
  // Release the singleton lock even on the hard-exit timeout path, so a stale
  // lock never outlives the process when gracefulShutdown's body didn't finish.
  if (_singletonLockPath) {
    try { releaseSingletonLock(_singletonLockPath); } catch { /* best-effort */ }
    _singletonLockPath = null;
  }
});

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

main().catch((error) => {
  logger.error("Fatal server error", "MCPServer", error);
  process.exit(1);
});
