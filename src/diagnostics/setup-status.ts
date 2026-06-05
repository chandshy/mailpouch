/**
 * Shared install/connect diagnosis.
 *
 * One place computes "what state is this install in, and what is the single
 * next action" so the answer is identical whether an AI calls the ungated
 * `setup_status` MCP tool, a human runs `mailpouch doctor`, or a test asserts
 * the decision logic. The pure `computeSetupStatus()` holds the decision tree;
 * `gatherSetupStatus()` does the IO (config + keychain + TCP probe) and calls it.
 *
 * Deliberately light: it does NOT perform a live IMAP/SMTP auth handshake (that
 * needs the running services and is what `get_connection_status` is for, after
 * approval). It reports configured-ness, TCP reachability, and grant state —
 * the three things that block a fresh install from connecting — plus the exact
 * command/action to unblock each one.
 */

import net from "net";
import { loadConfig, configExists, getConfigPath } from "../config/loader.js";
import { readRegistryWithSecrets } from "../accounts/registry.js";
import type { AccountSpec } from "../accounts/types.js";
import type { AgentGrantStatus } from "../agents/types.js";

export type SetupState =
  | "unconfigured"
  | "bridge-unreachable"
  | "pending-approval"
  | "revoked"
  | "ready";

export interface SetupStatusInput {
  configExists: boolean;
  configPath: string;
  username: string;
  hasPassword: boolean;
  credentialStorage: "keychain" | "encrypted-file" | "config" | null;
  imap: { host: string; port: number; reachable: boolean };
  smtp: { host: string; port: number; reachable: boolean };
  allowInsecureBridge: boolean;
  bridgeCertConfigured: boolean;
  settingsPort: number;
  /** True when the config file exists on disk but could not be parsed (invalid JSON). */
  configError?: boolean;
  /** Per-agent grant state for the calling client, when the agent gate is active. */
  grant?: { status: AgentGrantStatus; clientName?: string };
}

export interface SetupStatusResult {
  state: SetupState;
  configured: boolean;
  bridgeReachable: boolean;
  configExists: boolean;
  configPath: string;
  username: string | null;
  credentialStorage: string | null;
  imap: { host: string; port: number; reachable: boolean };
  smtp: { host: string; port: number; reachable: boolean };
  insecureTls: boolean;
  grantStatus: AgentGrantStatus | null;
  /** Single most-important action for the current state. */
  nextStep: string;
  /** Human-readable multi-line summary (shared by the tool text and `doctor`). */
  summary: string;
}

const SETUP_HINT =
  "Run:  npx -y mailpouch setup --username <you@proton.me> --password-stdin\n" +
  "  (paste your Proton BRIDGE password — Bridge app -> Settings -> IMAP/SMTP -> Password — " +
  "NOT your Proton login password.)\n" +
  "  Or launch the interactive wizard:  npx -y mailpouch-settings";

/** Mask an email's local part so it isn't disclosed to an unapproved caller. */
function maskEmail(email: string): string {
  const at = email.indexOf("@");
  return at > 0 ? `***${email.slice(at)}` : "***";
}

/** Pure decision tree — given a resolved snapshot, pick the state + next step. */
export function computeSetupStatus(input: SetupStatusInput): SetupStatusResult {
  const configured = input.configExists && !!input.username && input.hasPassword && !input.configError;
  const bridgeReachable = input.imap.reachable && input.smtp.reachable;
  const insecureTls = input.allowInsecureBridge && !input.bridgeCertConfigured;
  const agentsUrl = `http://localhost:${input.settingsPort}/#/agents`;

  // Information-disclosure guard: setup_status is dispatched PRE-GATE, so a
  // registered-but-unapproved (or revoked) caller — including a remote OAuth
  // client — can reach it. Don't hand such a caller the real mailbox address or
  // the absolute config path (which leaks the OS username). A caller with no
  // grant (local/trusted, or `doctor` on the box) sees full detail.
  const redact = !!input.grant && input.grant.status !== "active";
  const displayUsername = input.username
    ? (redact ? maskEmail(input.username) : input.username)
    : "";
  const displayConfigPath = redact ? "~/.mailpouch.json" : input.configPath;

  let state: SetupState;
  let nextStep: string;

  if (!configured) {
    state = "unconfigured";
    const missing = input.configError
      ? "Config file exists but could not be parsed (invalid JSON?). Fix it or re-run setup."
      : !input.configExists
        ? "No config file yet."
        : !input.username
          ? "No mailbox username configured."
          : "No Bridge password configured.";
    nextStep = `${missing}\n${SETUP_HINT}`;
  } else if (!bridgeReachable) {
    state = "bridge-unreachable";
    const down: string[] = [];
    if (!input.imap.reachable) down.push(`IMAP ${input.imap.host}:${input.imap.port}`);
    if (!input.smtp.reachable) down.push(`SMTP ${input.smtp.host}:${input.smtp.port}`);
    nextStep =
      `Proton Bridge is not reachable (${down.join(", ")}). ` +
      "Start the Proton Bridge desktop app and make sure it is signed in. " +
      "If Bridge listens elsewhere, re-run `mailpouch setup` with " +
      "--imap-host/--imap-port/--smtp-host/--smtp-port. " +
      "Note: use 127.0.0.1, not localhost — Bridge listens on IPv4 only.";
  } else if (input.grant && (input.grant.status === "revoked" || input.grant.status === "expired")) {
    state = "revoked";
    nextStep =
      `This agent's access was ${input.grant.status}. ` +
      `Ask the operator to re-approve it at ${agentsUrl}.`;
  } else if (input.grant && input.grant.status === "pending") {
    state = "pending-approval";
    nextStep =
      "This is EXPECTED on first connect — the agent is registered but waiting for a human to " +
      `approve it. Ask the operator to open ${agentsUrl} and click Approve ` +
      "(pending requests expire after 5 minutes). This is not an error; retry your tool call after approval.";
  } else {
    state = "ready";
    nextStep =
      "Setup looks good. Call get_connection_status to confirm live IMAP/SMTP authentication, " +
      "then use the mail tools." +
      (insecureTls
        ? " (Warning: TLS validation is disabled — set a Bridge TLS certificate path in Settings for a secure connection.)"
        : "");
  }

  const summary = [
    `mailpouch setup status: ${state.toUpperCase()}`,
    "",
    `  config file     : ${input.configExists ? displayConfigPath : "(none)"}`,
    `  username        : ${displayUsername || "(not set)"}`,
    `  password        : ${input.hasPassword ? `set (${input.credentialStorage ?? "config"})` : "(not set)"}`,
    `  IMAP            : ${input.imap.host}:${input.imap.port} ${input.imap.reachable ? "reachable" : "UNREACHABLE"}`,
    `  SMTP            : ${input.smtp.host}:${input.smtp.port} ${input.smtp.reachable ? "reachable" : "UNREACHABLE"}`,
    `  TLS             : ${insecureTls ? "INSECURE (no pinned cert)" : "secure / cert configured"}`,
    ...(input.grant ? [`  agent grant     : ${input.grant.status}${input.grant.clientName ? ` (${input.grant.clientName})` : ""}`] : []),
    "",
    "Next step:",
    ...nextStep.split("\n").map((l) => `  ${l}`),
  ].join("\n");

  return {
    state,
    configured,
    bridgeReachable,
    configExists: input.configExists,
    // Always go through displayConfigPath — never the raw absolute path — so a
    // pending/unapproved caller can't read the home dir (and OS username) even
    // on first run when the config file doesn't exist yet.
    configPath: displayConfigPath,
    username: displayUsername || null,
    credentialStorage: input.credentialStorage,
    imap: input.imap,
    smtp: input.smtp,
    insecureTls,
    grantStatus: input.grant?.status ?? null,
    nextStep,
    summary,
  };
}

/** Lightweight TCP reachability probe (connect-then-drop). Never throws. */
export function probeTcp(host: string, port: number, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    try {
      socket.connect(port, host);
      socket.unref(); // don't let the probe keep the event loop alive
    } catch {
      finish(false);
    }
  });
}

export interface GatherSetupStatusOptions {
  /** Calling agent's grant state, when the per-agent gate is active. */
  grant?: { status: AgentGrantStatus; clientName?: string };
  /** Injectable TCP probe (tests). Defaults to {@link probeTcp}. */
  probe?: (host: string, port: number, timeoutMs?: number) => Promise<boolean>;
}

/** Read config, resolve the active account, probe the Bridge ports, and compute the diagnosis. */
export async function gatherSetupStatus(opts: GatherSetupStatusOptions = {}): Promise<SetupStatusResult> {
  const probe = opts.probe ?? probeTcp;
  const exists = configExists();
  const cfg = exists ? loadConfig() : null;
  const cn = cfg?.connection;
  // loadConfig() returns null on a parse error too; distinguish "no file" from
  // "file present but unreadable" so the diagnosis can say so.
  const configError = exists && cfg === null;

  // Resolve the ACTIVE account the same way the server does when it connects:
  // per-account keychain (`bridge-password:<id>`, authoritative) → legacy
  // keychain → on-disk. Reading only the legacy `bridge-password` key would
  // falsely report a multi-account install (the default since per-account
  // keychain) as `unconfigured`.
  let active: AccountSpec | undefined;
  try {
    const reg = await readRegistryWithSecrets();
    active = reg.accounts.find((a) => a.id === reg.activeAccountId) ?? reg.accounts[0];
  } catch {
    /* fall back to the connection block below */
  }

  const imapHost = active?.imapHost || cn?.imapHost || "127.0.0.1";
  const imapPort = active?.imapPort || cn?.imapPort || 1143;
  const smtpHost = active?.smtpHost || cn?.smtpHost || "127.0.0.1";
  const smtpPort = active?.smtpPort || cn?.smtpPort || 1025;

  const [imapReachable, smtpReachable] = await Promise.all([
    probe(imapHost, imapPort, 1000),
    probe(smtpHost, smtpPort, 1000),
  ]);

  return computeSetupStatus({
    configExists: exists,
    configPath: getConfigPath(),
    username: (active?.username || cn?.username || "").trim(),
    hasPassword: !!active?.password,
    credentialStorage: cfg?.credentialStorage ?? null,
    imap: { host: imapHost, port: imapPort, reachable: imapReachable },
    smtp: { host: smtpHost, port: smtpPort, reachable: smtpReachable },
    allowInsecureBridge: active?.allowInsecureBridge ?? cn?.allowInsecureBridge ?? false,
    bridgeCertConfigured: !!(active?.bridgeCertPath || cn?.bridgeCertPath),
    settingsPort: cfg?.settingsPort ?? 8766,
    configError,
    grant: opts.grant,
  });
}
