/**
 * E2E harness — spawns a real mailpouch server (dist/index.js) over MCP
 * stdio, points it at Greenmail (or Proton Bridge), and exposes call/json
 * helpers plus an ImapFixtures instance for asserting on actual IMAP state.
 *
 * Pattern lifted from test/agent-harness.test.ts:41-102 (call/callRaw/json
 * helpers) and the per-preset spawnClientWithConfig() at line 668 (temp
 * config file + StdioClientTransport spawn).
 *
 * Phase 1 (Greenmail) writes a fresh config under $HOME (required by the
 * MAILPOUCH_CONFIG security check in src/config/loader.ts:51) pointing at
 * 127.0.0.1:3143/3025.
 *
 * Phase 2 (Bridge) uses the user's checked-in Bridge config at the path in
 * MAILPOUCH_E2E_BRIDGE_CONFIG.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";
import { expect } from "vitest";
import { buildPermissions } from "../../src/config/loader.js";
import { localAgentId } from "../../src/agents/caller-context.js";
import type { AccountSpecShape } from "../../src/config/schema.js";
import { CredentialEncryption } from "../../src/crypto/credential-encryption.js";
import {
  __setKeyringForTests,
  loadAccountCredentials,
  loadCredentials,
} from "../../src/security/keychain.js";
import { buildBridgeTlsOptions, readPinnedBridgeCert } from "../../src/services/bridge-tls.js";
import { bridgeModeRequested, resolveE2EBackend } from "./support/backend.js";
import {
  ImapFixtures,
  type AppendedSeedIdentity,
  type MailboxSafetySnapshot,
} from "./fixtures/imap-fixtures.js";
import { guardBridgeCall, type BridgePostcondition } from "./support/bridge-safety.js";
import { assertNoRetainedBridgeRecoveryRuns } from "./support/bridge-run-barrier.js";
import { acquireBridgeRunLease, type BridgeRunLease } from "./support/bridge-run-lease.js";
import {
  bridgeMailboxScopeKeyFromConfig,
  resolveBridgeAuthorityScope,
  type BridgeAuthorityScope,
} from "./support/bridge-authority-root.mjs";
import {
  createBridgeSetupJournal,
  retireBridgeSetupJournal,
  type BridgeSetupJournalRecord,
} from "./support/bridge-setup-journal.mjs";
import { shutdownMcpBounded } from "./support/bounded-mcp-shutdown.js";
import { observeMcpStdioChild, type McpChildExitLatch } from "./support/mcp-child-exit.js";
import { coordinateStandaloneBridgeRecovery } from "./support/cleanup-recovery.js";
import { createFailClosedSetupAbort, runDeadlinePhase } from "./support/deadline-race.mjs";
import {
  commitVerifiedBridgeArtifacts,
  harnessArtifactPolicy,
  shouldCommitBridgeOwnership,
} from "./support/harness-finalization.js";
import {
  runToken,
  ScratchSession,
  type ScratchKind,
} from "./support/scratch.js";
import {
  recoverBridgeRunStandalone,
  standaloneRecoveryTerminationConfirmed,
} from "./support/standalone-recovery.js";
import {
  BRIDGE_BASELINE_VERIFY_MS,
  BRIDGE_CLEANUP_SETTLE_MS,
  BRIDGE_MCP_CLIENT_CLOSE_MS,
  BRIDGE_MCP_REQUEST_MS,
  BRIDGE_MCP_TRANSPORT_CLOSE_MS,
  BRIDGE_SETUP_MS,
  BRIDGE_STANDALONE_PARENT_MARGIN_MS,
  bridgeStandaloneProcessBudgetMs,
} from "./support/time-budgets.mjs";
import { GREENMAIL_IMAP_PORT, GREENMAIL_SMTP_PORT, TEST_USER } from "./support/docker.js";
import type { SeedEmail } from "./support/mime-builder.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "..", "dist", "index.js");
const HOME = homedir();

export type TextContent = { type: "text"; text: string };
export type CallResult = { content: TextContent[]; isError?: boolean; structuredContent?: unknown };
export type RawOutcome =
  | ({ ok: true } & CallResult)
  | { ok: false; code?: number; message: string };

/** Scenario-facing assertion/seed surface. Keep cleanup internals and raw IMAP
 * mutation escape hatches unreachable from future scenario refactors. */
export type E2EImapFacade = Pick<ImapFixtures,
  | "appendScratch"
  | "appendSeed"
  | "countMessages"
  | "createMailbox"
  | "findMessageByProof"
  | "getFlags"
  | "getFlagsForUids"
  | "getSubject"
  | "isOwnedUid"
  | "listMailboxes"
  | "listUids"
  | "mailboxExists"
  | "provenMissingUids"
  | "searchSubject"
  | "searchSubjects"
  | "uidExists"
>;

export interface E2EHarness {
  imap: E2EImapFacade;
  /** Narrow read-only discovery surface; raw callTool is intentionally not exposed. */
  listTools(): ReturnType<Client["listTools"]>;
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<RawOutcome>;
  json<T = unknown>(result: CallResult): T;
  domainErrorText(result: CallResult): string;
  isPermissionBlocked(r: CallResult | RawOutcome): boolean;
  /** Backend selected for this harness. Bridge is always ownership-scoped. */
  mode: HarnessMode;
  /** Configured mailbox address. Bridge send/draft scenarios may target only this address. */
  accountEmail: string;
  /**
   * Wipe IMAP state via ImapFixtures, then nudge mailpouch back online.
   * Deleting mailboxes that mailpouch has IDLE'd on causes the server to
   * terminate the connection; mailpouch reconnects on read-path calls
   * (ensureConnection is invoked by sync_emails / get_folders) but NOT on
   * mutations. Use this helper in beforeEach to guarantee a fresh state +
   * a live mailpouch connection before the next tool call.
   */
  resetState(): Promise<void>;
  close(): Promise<void>;
  /** SAFE mode only: the token-scoped scratch namespace. Use `scratch.create()`
   *  for folders and `imap.appendScratch(path, runToken, seed)` for messages.
   *  Live Bridge cleanup removes owned messages but retains verified-empty
   *  folders for manual cleanup; disposable Greenmail may delete them.
   *  Undefined in destructive (wipe-based) modes. */
  scratch?: ScratchSession;
  /** SAFE mode only: the unique per-run token every scratch folder name carries. */
  runToken?: string;
  /** Allocate (but do not create) one strict run-owned scratch path. */
  scratchPath(kind?: ScratchKind): string;
  /** Allocate a strict run-owned label name without the Labels/ prefix. */
  scratchLabel(): string;
  /** Return a UID proven absent from `folder` by the fixture immediately before use. */
  provenMissingUid(folder?: string): Promise<string>;
  /** APPEND an identified seed, then wait until the independently spawned MCP
   * process can fetch its current folder-local UID. Bridge mode requires the
   * exact run ownership header throughout this resolution. */
  appendVisibleSeed(
    folder: string,
    seed: SeedEmail,
    flags?: string[],
    timeoutMs?: number,
  ): Promise<{ identity: AppendedSeedIdentity; uid: number; email: Record<string, unknown> }>;
}

export type HarnessMode = "greenmail" | "bridge";

export function scenarioImapFacade(imap: ImapFixtures): E2EImapFacade {
  return Object.freeze({
    appendScratch: imap.appendScratch.bind(imap),
    appendSeed: imap.appendSeed.bind(imap),
    countMessages: imap.countMessages.bind(imap),
    createMailbox: imap.createMailbox.bind(imap),
    findMessageByProof: imap.findMessageByProof.bind(imap),
    getFlags: imap.getFlags.bind(imap),
    getFlagsForUids: imap.getFlagsForUids.bind(imap),
    getSubject: imap.getSubject.bind(imap),
    isOwnedUid: imap.isOwnedUid.bind(imap),
    listMailboxes: imap.listMailboxes.bind(imap),
    listUids: imap.listUids.bind(imap),
    mailboxExists: imap.mailboxExists.bind(imap),
    provenMissingUids: imap.provenMissingUids.bind(imap),
    searchSubject: imap.searchSubject.bind(imap),
    searchSubjects: imap.searchSubjects.bind(imap),
    uidExists: imap.uidExists.bind(imap),
  });
}

export interface StartE2EOptions {
  mode?: HarnessMode;
  /** Override Greenmail user. Ignored in bridge mode. */
  user?: { email: string; username: string; password: string };
  /** Greenmail-only scoped mode. Bridge is always non-destructive regardless
   *  of this option; explicitly passing false for Bridge is rejected. */
  safe?: boolean;
}

/** MCP client name the harness connects under. Local-agent gating derives the
 *  grant's clientId from this (localAgentId), so the pre-seeded grant below must
 *  use the same name. */
const HARNESS_CLIENT_NAME = "e2e-harness";
/**
 * Local-agent gating (every stdio agent must register + be approved) would
 * leave the harness's grant "pending" with no human in CI to approve it,
 * blocking every mutating tool. Mirror the real out-of-band approval path:
 * pre-seed an *active* grant for the harness's derived clientId, pointed at by
 * MAILPOUCH_AGENTS. This exercises the gate (grant must be active) rather than
 * bypassing it.
 */
function writeApprovedAgentGrant(): string {
  const path = join(HOME, `.mailpouch-e2e-agents-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  const now = new Date().toISOString();
  const store = {
    version: 1,
    grants: [
      {
        clientId: localAgentId(HARNESS_CLIENT_NAME),
        clientName: HARNESS_CLIENT_NAME,
        status: "active",
        preset: "full",
        createdAt: now,
        approvedAt: now,
        totalCalls: 0,
        transport: "stdio",
        note: "e2e harness — pre-approved for CI",
      },
    ],
  };
  writeFileSync(path, JSON.stringify(store, null, 2), { mode: 0o600 });
  return path;
}

/** Phase 1 — write an exact-token Greenmail config under $HOME. The matching
 * child environment enables config-only credential access, preventing test
 * passwords from reading or overwriting the operator's global keychain. */
function writeGreenmailConfig(
  user: { email: string; username: string; password: string },
  credentialToken: string,
): string {
  const path = join(HOME, `.mailpouch-e2e-greenmail-${credentialToken}.json`);
  const config = {
    configVersion: 3,
    connection: {
      smtpHost: "127.0.0.1",
      smtpPort: GREENMAIL_SMTP_PORT,
      imapHost: "127.0.0.1",
      imapPort: GREENMAIL_IMAP_PORT,
      username: user.username,
      password: user.password,
      smtpToken: "",
      bridgeCertPath: "",
      allowInsecureBridge: true,
      autoStartBridge: false,
      tlsMode: "starttls",
      simpleloginApiKey: "",
      passAccessToken: "",
    },
    // buildPermissions("full") populates the per-tool enabled flags. Writing
    // just { preset: "full" } loses to the loader's default deep-merge which
    // initializes per-tool flags from read_only, blocking every mutation.
    permissions: buildPermissions("full"),
    credentialStorage: "config",
    // AccountManager has its own registry hydration path. Quarantine is the
    // executable switch that routes this exact token profile back to its
    // config credential and prevents any per-account or legacy keychain read.
    keychainMailboxCredentialsQuarantined: true,
    keychainAuxiliaryCredentialsQuarantined: {
      passAccessToken: true,
      simpleloginApiKey: true,
    },
    requireDestructiveConfirm: true,
  };
  writeFileSync(path, JSON.stringify(config, null, 2), { mode: 0o600 });
  return path;
}

/** Phase 2 — resolve the Bridge config from MAILPOUCH_E2E_BRIDGE_CONFIG. */
function resolveBridgeConfig(): string {
  const path = process.env.MAILPOUCH_E2E_BRIDGE_CONFIG;
  if (!path) {
    throw new Error("MAILPOUCH_E2E_BRIDGE_CONFIG is not set — bridge mode requires a config path.");
  }
  if (!existsSync(path)) {
    throw new Error(`Bridge config not found at ${path}`);
  }
  return path;
}

export function bridgeConfigAvailable(): boolean {
  // Compatibility name retained for scenario predicates. Selection is based
  // only on the invoking command, never on whether a config variable happens
  // to be inherited. startE2E separately validates that the selected Bridge
  // config exists before any network connection is opened.
  return bridgeModeRequested();
}

/** Shape of the subset of mailpouch's config we need to talk IMAP. */
interface BridgeConnectionConfig {
  smtpHost?: string;
  smtpPort?: number;
  imapHost: string;
  imapPort: number;
  username: string;
  password: string;
  smtpToken?: string;
  bridgeCertPath?: string;
  allowInsecureBridge?: boolean;
  tlsMode?: "starttls" | "ssl";
  autoStartBridge?: boolean;
  bridgePath?: string;
}

type BridgeSourceConfig = Record<string, unknown> & {
  connection?: Partial<BridgeConnectionConfig> & {
    smtpToken?: string;
    passwordEncrypted?: unknown;
    smtpTokenEncrypted?: unknown;
  };
  accounts?: AccountSpecShape[];
  activeAccountId?: string;
  keychainMailboxCredentialsQuarantined?: boolean;
};

interface BridgeCredentialReaders {
  loadLegacy(): Promise<{ password: string; smtpToken: string } | null>;
  loadAccount(accountId: string): Promise<{ password: string; smtpToken: string } | null>;
}

function decryptConfigField(value: unknown, field: string): string {
  if (!CredentialEncryption.isValidEncrypted(value)) return "";
  try {
    return CredentialEncryption.decrypt(value);
  } catch {
    throw new Error(`Bridge E2E refused: ${field} failed authenticated decryption.`);
  }
}

/** Detached, injectable credential hydration used by the live harness and
 * unit tests. It never mutates the caller's parsed source object. */
export async function hydrateBridgeConfigForE2E(
  source: BridgeSourceConfig,
  readers: BridgeCredentialReaders = {
    loadLegacy: loadCredentials,
    loadAccount: loadAccountCredentials,
  },
): Promise<BridgeSourceConfig> {
  const raw = structuredClone(source);
  if (raw.keychainMailboxCredentialsQuarantined === true) {
    throw new Error("Bridge E2E refused: mailbox keychain credentials are quarantined after a failed reset.");
  }

  const accounts = Array.isArray(raw.accounts) ? raw.accounts.map((account) => ({ ...account })) : [];
  const active = accounts.find((account) => account.id === raw.activeAccountId) ?? accounts[0];
  const legacy = !active || active.id === "primary" ? await readers.loadLegacy() : null;

  if (active) {
    const hasEncryptedPassword = CredentialEncryption.isValidEncrypted(active.passwordEncrypted);
    const hasEncryptedSmtpToken = CredentialEncryption.isValidEncrypted(active.smtpTokenEncrypted);
    if (active.passwordEncrypted !== undefined && !hasEncryptedPassword) {
      throw new Error("Bridge E2E refused: active account passwordEncrypted has an invalid shape.");
    }
    if (active.smtpTokenEncrypted !== undefined && !hasEncryptedSmtpToken) {
      throw new Error("Bridge E2E refused: active account smtpTokenEncrypted has an invalid shape.");
    }
    const encryptedPassword = hasEncryptedPassword
      ? decryptConfigField(active.passwordEncrypted, "active account passwordEncrypted")
      : "";
    const encryptedSmtpToken = hasEncryptedSmtpToken
      ? decryptConfigField(active.smtpTokenEncrypted, "active account smtpTokenEncrypted")
      : "";
    if (hasEncryptedPassword) active.password = encryptedPassword;
    if (hasEncryptedSmtpToken) active.smtpToken = encryptedSmtpToken;

    // An authenticated encrypted value is authoritative even when it decrypts
    // to an empty string. Only fields with no encrypted representation may
    // consult plaintext/keychain fallbacks (the production CRED-010 rule).
    const needsKeychain = (!hasEncryptedPassword && !active.password)
      || (!hasEncryptedSmtpToken && !active.smtpToken);
    const perAccount = needsKeychain ? await readers.loadAccount(active.id) : null;
    if (!hasEncryptedPassword && !active.password) {
      active.password = perAccount?.password
        || (active.id === "primary" ? legacy?.password : "")
        || "";
    }
    if (!hasEncryptedSmtpToken && !active.smtpToken) {
      active.smtpToken = perAccount?.smtpToken
        || (active.id === "primary" ? legacy?.smtpToken : "")
        || undefined;
    }
    // Never hydrate or copy credentials for inactive mailboxes into the E2E
    // process. The detached clone represents exactly one selected account.
    raw.accounts = [active];
    raw.activeAccountId = active.id;
  } else {
    raw.accounts = [];
  }

  const conn = { ...(raw.connection ?? {}) };
  raw.connection = conn;
  if (active) {
    // Keep the singleton connection block and active account clone consistent;
    // different startup paths consume each shape.
    conn.imapHost = active.imapHost;
    conn.imapPort = active.imapPort;
    conn.smtpHost = active.smtpHost;
    conn.smtpPort = active.smtpPort;
    conn.username = active.username;
    conn.password = active.password;
    conn.smtpToken = active.smtpToken ?? "";
    conn.bridgeCertPath = active.bridgeCertPath;
    conn.allowInsecureBridge = active.allowInsecureBridge;
    conn.tlsMode = active.tlsMode;
    conn.autoStartBridge = active.autoStartBridge;
    conn.bridgePath = active.bridgePath;
  } else {
    const hasEncryptedPassword = CredentialEncryption.isValidEncrypted(conn.passwordEncrypted);
    const hasEncryptedSmtpToken = CredentialEncryption.isValidEncrypted(conn.smtpTokenEncrypted);
    const encryptedPassword = hasEncryptedPassword
      ? decryptConfigField(conn.passwordEncrypted, "connection.passwordEncrypted")
      : "";
    const encryptedSmtpToken = hasEncryptedSmtpToken
      ? decryptConfigField(conn.smtpTokenEncrypted, "connection.smtpTokenEncrypted")
      : "";
    conn.password = hasEncryptedPassword
      ? encryptedPassword
      : conn.password || legacy?.password || "";
    conn.smtpToken = hasEncryptedSmtpToken
      ? encryptedSmtpToken
      : conn.smtpToken || legacy?.smtpToken || "";
  }
  return raw;
}

/**
 * Read a Bridge source config and hydrate only the detached in-memory clone.
 * Existing installations normally keep mailbox secrets in OS keychain slots,
 * so requiring plaintext here made the safe gate unusable against the normal
 * ~/.mailpouch.json. The source file is never written and secrets are never
 * logged; only the private, short-lived test clone receives them.
 */
async function readBridgeSource(configPath: string): Promise<{
  raw: BridgeSourceConfig;
  connection: BridgeConnectionConfig;
}> {
  const parsed = JSON.parse(readFileSync(configPath, "utf-8")) as BridgeSourceConfig;
  // Vitest executes transformed modules in a VM context where the keychain
  // adapter's Function-constructed import has no native dynamic-import
  // callback. Load the optional module through Vitest's ordinary import path
  // and inject only its Entry constructor into this test-harness process. The
  // real MCP child remains config-only and never receives keychain access.
  try {
    const keyringSpecifier = "@napi-rs/keyring";
    const keyring = await import(keyringSpecifier);
    __setKeyringForTests(keyring as Parameters<typeof __setKeyringForTests>[0]);
  } catch {
    // Hydration below preserves its normal config/keychain fallback and emits
    // one credential-shape error without exposing native-loader diagnostics.
  }
  const raw = await hydrateBridgeConfigForE2E(parsed);
  const conn = { ...(raw.connection ?? {}) };
  raw.connection = conn;

  if (!conn.imapHost || !conn.imapPort || !conn.username || !conn.password) {
    throw new Error(
      `Bridge config at ${configPath} is missing usable IMAP host, port, username, or credentials. ` +
        `The source file and OS keychain must describe one active account.`
    );
  }
  return {
    raw,
    connection: {
      imapHost: conn.imapHost,
      imapPort: conn.imapPort,
      username: conn.username,
      password: conn.password,
      bridgeCertPath: conn.bridgeCertPath,
      allowInsecureBridge: conn.allowInsecureBridge,
    },
  };
}

/** Build the only config shape written by a live Bridge E2E run. */
export function buildBridgeChildConfig(
  source: BridgeSourceConfig,
  bridge: BridgeConnectionConfig,
): BridgeSourceConfig {
  const raw = structuredClone(source);
  const connection = { ...(raw.connection ?? {}) } as Record<string, unknown>;
  connection.password = "";
  connection.smtpToken = "";
  connection.passwordEncrypted = CredentialEncryption.encrypt(bridge.password);
  const smtpToken = typeof source.connection?.smtpToken === "string" ? source.connection.smtpToken : "";
  if (smtpToken) connection.smtpTokenEncrypted = CredentialEncryption.encrypt(smtpToken);
  else delete connection.smtpTokenEncrypted;
  connection.passAccessToken = "";
  connection.simpleloginApiKey = "";
  connection.remoteBearerToken = "";
  connection.remoteOauthAdminPassword = "";
  connection.remoteMode = false;
  connection.remoteOauthEnabled = false;
  // The E2E child attaches to an operator-managed Bridge. It must never start,
  // watchdog, or terminate that external process as part of its own lifecycle.
  connection.autoStartBridge = false;
  delete connection.bridgePath;
  raw.connection = connection as BridgeSourceConfig["connection"];
  delete raw.accounts;
  delete raw.activeAccountId;
  delete raw.webhooks;
  // The attestation exercises the complete tool surface independently of the
  // operator profile's day-to-day permission preset. The detached child and
  // its pre-approved local grant are private to this run; live-mail mutation
  // authority still comes only from guardBridgeCall's exact ownership proofs.
  raw.permissions = buildPermissions("full");
  raw.keychainMailboxCredentialsQuarantined = true;
  raw.keychainAuxiliaryCredentialsQuarantined = {
    passAccessToken: true,
    simpleloginApiKey: true,
  };
  (raw as { credentialStorage?: string }).credentialStorage = "encrypted-file";
  return raw;
}

export function buildE2EChildEnv(
  base: NodeJS.ProcessEnv,
  mode: "bridge" | "greenmail",
  configPath: string,
  agentsPath: string,
  ownershipToken?: string,
  smtpFromOverride?: string,
  credentialToken?: string,
): Record<string, string> {
  const childEnv: Record<string, string> = Object.fromEntries(
    Object.entries(base).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
  // The MCP child needs the local process environment, not the operator's
  // cloud/registry/CI credentials. Keep the one machine secret required to
  // decrypt this same-host clone; strip generic credential-shaped variables
  // before adding the exact E2E authorities below.
  for (const name of Object.keys(childEnv)) {
    if (name === "MAILPOUCH_MACHINE_SECRET") continue;
    if (/^(?:GH_TOKEN|GITHUB_TOKEN|NODE_AUTH_TOKEN|NPM_TOKEN|SSH_AUTH_SOCK|GPG_AGENT_INFO|GIT_ASKPASS|SSH_ASKPASS|DOCKER_CONFIG|KUBECONFIG|CI_JOB_JWT)$/i.test(name)
      || /^(?:AWS|AZURE|GOOGLE|GCP)_/i.test(name)
      || /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|API_KEY|ACCESS_KEY|CREDENTIALS?)$/i.test(name)) {
      delete childEnv[name];
    }
  }
  for (const name of [
    "MAILPOUCH_AGENT_AUDIT",
    "MAILPOUCH_AUDIT",
    "MAILPOUCH_FTS_DB",
    "MAILPOUCH_LOCK_PATH",
    "MAILPOUCH_LOG_FILE",
    "MAILPOUCH_NO_SINGLETON",
    "MAILPOUCH_OAUTH_TOKENS",
    "MAILPOUCH_PASS_AUDIT",
    "MAILPOUCH_PENDING",
    "MAILPOUCH_REMINDERS",
    "MAILPOUCH_SCHEDULER_STORE",
    "MAILPOUCH_SERVICE_ACCOUNTS",
    "MAILPOUCH_TEST_DEFAULT_PROFILE_PATH",
    "MAILPOUCH_TEST_PATH",
    "MAILPOUCH_TEST_RUNTIME_PATH",
    "MAILPOUCH_TRUST_LOCAL",
    "MAILPOUCH_E2E_SIMPLELOGIN",
    "MAILPOUCH_E2E_PASS",
    "MAILPOUCH_E2E_REARM_RESCUE_COPY",
    "MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE",
  ]) delete childEnv[name];

  if (mode === "bridge") {
    if (!ownershipToken) throw new Error("Bridge child environment requires an ownership token");
    delete childEnv.MAILPOUCH_E2E_CREDENTIAL_TOKEN;
    delete childEnv.MAILPOUCH_INSECURE_BRIDGE;
    delete childEnv.MAILPOUCH_SMTP_ALLOW_PLAINTEXT;
    delete childEnv.MAILPOUCH_SMTP_FROM;
    childEnv.MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS = "1";
    childEnv.MAILPOUCH_E2E_RUN_TOKEN = ownershipToken;
  } else {
    if (!credentialToken) throw new Error("Greenmail child environment requires a credential token");
    // Keep Greenmail out of the live mutation fence while activating a
    // separate, exact-profile token for config-only credential access.
    delete childEnv.MAILPOUCH_E2E_RUN_TOKEN;
    childEnv.MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS = "1";
    childEnv.MAILPOUCH_E2E_CREDENTIAL_TOKEN = credentialToken;
    childEnv.MAILPOUCH_INSECURE_BRIDGE = "1";
    childEnv.MAILPOUCH_SMTP_ALLOW_PLAINTEXT = "1";
    if (smtpFromOverride) childEnv.MAILPOUCH_SMTP_FROM = smtpFromOverride;
  }

  // Every E2E child gets a private runtime namespace. Disposable Greenmail
  // must not share the operator's logs, audits, scheduler, reminders, OAuth
  // tokens, FTS database, or singleton lock either.
  const stateToken = mode === "bridge" ? ownershipToken! : credentialToken!;
  const stateDir = join(dirname(configPath), `.mailpouch-e2e-state-${stateToken}`);
  childEnv.MAILPOUCH_FORCE_STDIO = "1";
  childEnv.MAILPOUCH_AGENT_AUDIT = join(stateDir, "agent-audit.jsonl");
  childEnv.MAILPOUCH_AUDIT = join(stateDir, "audit.jsonl");
  childEnv.MAILPOUCH_FTS_DB = join(stateDir, "fts.db");
  childEnv.MAILPOUCH_LOCK_PATH = join(stateDir, "singleton.lock");
  childEnv.MAILPOUCH_LOG_FILE = join(stateDir, "mailpouch.log");
  childEnv.MAILPOUCH_OAUTH_TOKENS = join(stateDir, "oauth-tokens.json");
  childEnv.MAILPOUCH_PASS_AUDIT = join(stateDir, "pass-audit.jsonl");
  childEnv.MAILPOUCH_PENDING = join(stateDir, "pending.json");
  childEnv.MAILPOUCH_REMINDERS = join(stateDir, "reminders.json");
  childEnv.MAILPOUCH_SCHEDULER_STORE = join(stateDir, "scheduler.json");
  childEnv.MAILPOUCH_SERVICE_ACCOUNTS = join(stateDir, "service-accounts.json");
  childEnv.MAILPOUCH_CONFIG = configPath;
  childEnv.MAILPOUCH_AGENTS = agentsPath;
  childEnv.MAILPOUCH_TIER = "complete";
  return childEnv;
}

function writePrivateJsonExclusive(path: string, value: unknown): void {
  let fd: number | undefined;
  let created = false;
  try {
    fd = openSync(path, "wx", 0o600);
    created = true;
    writeFileSync(fd, JSON.stringify(value, null, 2), "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    if (process.platform !== "win32") {
      const dirFd = openSync(dirname(path), "r");
      try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
    }
  } catch (error) {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* preserve the primary write error */ }
    }
    if (created) {
      try {
        unlinkSync(path);
        if (process.platform !== "win32") {
          const dirFd = openSync(dirname(path), "r");
          try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
        }
      } catch { /* a surviving exact path stays visible for manual repair */ }
    }
    throw error;
  }
}

export function quotePosixShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function retireBridgeRecoveryConfig(path: string, token: string, allowMissing = false): void {
  const expected = `.mailpouch-e2e-bridge-${token}.json`;
  if (basename(path) !== expected) {
    throw new Error(`Refusing to retire non-run Bridge config ${path}; expected ${expected}`);
  }
  try {
    unlinkSync(path);
  } catch (error) {
    if (!(allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    return;
  }
  if (process.platform !== "win32") {
    const fd = openSync(dirname(path), "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
  }
}

/** TLS options ImapFixtures needs to reach Bridge's self-signed CN=127.0.0.1
 *  cert over host `localhost` — the same handling production uses. With a pinned
 *  cert: trust it as the CA + skip the hostname check (buildBridgeTlsOptions).
 *  Otherwise, if the operator opted into insecure Bridge, disable verification.
 *  Greenmail needs none. */
function bridgeImapTls(bridge: BridgeConnectionConfig): Record<string, unknown> | undefined {
  if (bridge.bridgeCertPath) {
    try {
      return buildBridgeTlsOptions(readPinnedBridgeCert(bridge.bridgeCertPath));
    } catch { /* fall through to insecure / none */ }
  }
  if (bridge.allowInsecureBridge) {
    return { rejectUnauthorized: false, minVersion: "TLSv1.2" };
  }
  return undefined;
}

export async function startE2E(opts: StartE2EOptions = {}): Promise<E2EHarness> {
  // The invoking command must select a backend explicitly. A Bridge config is
  // only configuration, never a mode switch; this prevents both false-green
  // Bridge runs and local runs accidentally inheriting live-mail mode.
  const mode = resolveE2EBackend(opts.mode);
  if (mode === "bridge" && opts.safe === false) {
    throw new Error("Bridge E2E refused: safe:false is not supported; live Bridge is always ownership-scoped.");
  }
  if (mode === "bridge" && process.env.MAILPOUCH_E2E_ALLOW_WIPE === "1") {
    throw new Error(
      "Bridge E2E refused: MAILPOUCH_E2E_ALLOW_WIPE is obsolete. Live Bridge runs never wipe a mailbox.",
    );
  }
  let bridgeAuthorityConfigPath = mode === "bridge" ? resolveBridgeConfig() : undefined;
  let bridgeAuthorityScope: BridgeAuthorityScope | undefined;
  let bridgeRunLease: BridgeRunLease | undefined;
  if (mode === "bridge") {
    bridgeAuthorityScope = resolveBridgeAuthorityScope({
      authorityConfigPath: bridgeAuthorityConfigPath,
    });
    // Pin every later read, recovery command, and child handoff to the exact
    // canonical source captured while selecting this mailbox authority. A
    // relative path or retargeted symlink must not move recovery state.
    bridgeAuthorityConfigPath = bridgeAuthorityScope.authorityConfigPath;
    // Acquire before scanning so two separate Vitest processes cannot both
    // observe an empty barrier window. The lease remains held through the
    // final manifest/config commit in close().
    bridgeRunLease = acquireBridgeRunLease({ leaseRoot: bridgeAuthorityScope.scopeRoot });
    try {
      // Vitest can continue with later files after an afterAll failure even with
      // bail enabled. Never let an unresolved prior run become part of a new
      // mailbox baseline; this check happens before config cloning or network IO.
      assertNoRetainedBridgeRecoveryRuns({
        manifestRoot: bridgeAuthorityScope.scopeRoot,
        mailboxScopeKey: bridgeAuthorityScope.mailboxScopeKey,
        recoveryConfigRoot: HOME,
      });
    } catch (error) {
      bridgeRunLease.release();
      if (existsSync(bridgeRunLease.path)) {
        throw new Error(
          `Bridge E2E preflight failed and its run lease could not be released at ${bridgeRunLease.path}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  // Bridge is intrinsically scoped. Greenmail may opt into the same scratch
  // behavior for exercising safety logic, but its default remains disposable.
  const safe = mode === "bridge" || opts.safe === true || process.env.MAILPOUCH_E2E_SAFE === "1";
  const ownershipToken = safe ? runToken() : undefined;
  const credentialToken = mode === "bridge" ? ownershipToken! : runToken();
  const recoveryCommand = (path: string, token: string): string =>
    `MAILPOUCH_E2E_AUTHORITY_CONFIG=${quotePosixShellArgument(bridgeAuthorityConfigPath!)} ` +
    `MAILPOUCH_E2E_BRIDGE_CONFIG=${quotePosixShellArgument(path)} ` +
    `MAILPOUCH_E2E_RUN_TOKEN=${quotePosixShellArgument(token)} npm run test:e2e:bridge:cleanup`;
  const greenmailUser = opts.user ?? TEST_USER;
  const setupDeadline = Date.now() + BRIDGE_SETUP_MS;

  let configPath: string;
  let isTempConfig = false;
  let imapHost: string;
  let imapPort: number;
  let imapUser: string;
  let imapPass: string;
  let imapTls: Record<string, unknown> | undefined;
  let bridgeSetupJournal: BridgeSetupJournalRecord | undefined;
  // wipe() is available only to disposable Greenmail. There is no Bridge env
  // override or opt-in path.
  let allowWipe: boolean;
  if (mode === "greenmail") {
    configPath = writeGreenmailConfig(greenmailUser, credentialToken);
    isTempConfig = true;
    imapHost = "127.0.0.1";
    imapPort = GREENMAIL_IMAP_PORT;
    imapUser = greenmailUser.username;
    imapPass = greenmailUser.password;
    imapTls = undefined;
    allowWipe = true;
  } else {
    try {
    // Build a minimal, active-account-only clone. Credentials are encrypted on
    // disk, inactive accounts and auxiliary/remote secrets are omitted, and a
    // strict UUID filename activates config-only credential loading in the
    // child. The operator's source config and keychain are never mutated.
    const sourcePath = bridgeAuthorityConfigPath!;
    const source = await runDeadlinePhase(
      () => readBridgeSource(sourcePath),
      {
        deadline: setupDeadline,
        label: "Bridge credential setup",
        // Credential hydration is read-only and no transport exists yet.
        onDeadline: () => undefined,
      },
    );
    const hydratedMailboxScopeKey = bridgeMailboxScopeKeyFromConfig(source.raw);
    if (hydratedMailboxScopeKey !== bridgeAuthorityScope!.mailboxScopeKey) {
      throw new Error(
        "Bridge E2E refused: the active mailbox identity changed while acquiring its run authority.",
      );
    }
    const bridge = source.connection;
    const raw = buildBridgeChildConfig(source.raw, bridge);
    configPath = join(HOME, `.mailpouch-e2e-bridge-${ownershipToken!}.json`);
    bridgeSetupJournal = createBridgeSetupJournal({
      scopeRoot: bridgeAuthorityScope!.scopeRoot,
      token: ownershipToken!,
      recoveryConfigPath: configPath,
    });
    writePrivateJsonExclusive(configPath, raw);
    isTempConfig = true;
    imapHost = bridge.imapHost;
    imapPort = bridge.imapPort;
    imapUser = bridge.username;
    imapPass = bridge.password;
    imapTls = bridgeImapTls(bridge);
    allowWipe = false;
    } catch (error) {
      const artifactErrors: string[] = [];
      if (bridgeSetupJournal && configPath!) {
        let cloneRetired = false;
        try {
          retireBridgeRecoveryConfig(configPath, ownershipToken!, true);
          cloneRetired = true;
        } catch (cleanupError) {
          artifactErrors.push(
            `encrypted clone rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
          );
        }
        if (cloneRetired) {
          try {
            retireBridgeSetupJournal({
              scopeRoot: bridgeAuthorityScope!.scopeRoot,
              token: ownershipToken!,
              recoveryConfigPath: configPath,
              journalId: bridgeSetupJournal.journalId,
            });
            bridgeSetupJournal = undefined;
          } catch (cleanupError) {
            artifactErrors.push(
              `setup-journal rollback failed: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
            );
          }
        }
      }
      bridgeRunLease?.release();
      if (bridgeRunLease && existsSync(bridgeRunLease.path)) {
        throw new Error(
          `Bridge E2E credential setup failed and its run lease remains at ${bridgeRunLease.path}`,
          { cause: error },
        );
      }
      if (artifactErrors.length > 0) {
        throw new Error(
          `Bridge E2E credential setup failed: ${error instanceof Error ? error.message : String(error)}; ` +
          `safety rollback: ${artifactErrors.join("; ")}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
  // Safe mode NEVER wipes, regardless of backend — defense in depth on top of
  // the token-scoped scratch namespace.
  if (safe) allowWipe = false;

  // Greenmail provisions users with bare logins ("alice") but rejects
  // outbound SMTP when MAIL FROM lacks a domain. Real Bridge has full-email
  // usernames so this is normally a no-op. The MAILPOUCH_SMTP_FROM env var
  // (production unaware of it) supplies a domain-qualified From for the
  // Greenmail-only harness; bridge mode leaves it unset.
  const smtpFromOverride = mode === "greenmail"
    ? `${imapUser}@test.local`
    : undefined;
  let agentsPath = "";
  let client!: Client;
  let clientCreated = false;
  let transport!: StdioClientTransport;
  let transportCreated = false;
  let mcpChildExit: McpChildExitLatch | undefined;
  let imap!: ImapFixtures;
  let imapConnected = false;
  let safetySnapshot: MailboxSafetySnapshot | undefined;
  let scratch: ScratchSession | undefined;
  let stateDir = "";
  const releaseBridgeLease = (recordFailure: (message: string) => void): boolean => {
    if (!bridgeRunLease) return true;
    bridgeRunLease.release();
    if (!existsSync(bridgeRunLease.path)) return true;
    recordFailure(
      `Bridge E2E run lease could not be released at ${bridgeRunLease.path}; ` +
      `verify no E2E/cleanup process is running before manual removal`,
    );
    return false;
  };
  const abortSetup = createFailClosedSetupAbort({
    abortImap: (reason) => imap?.abortCleanupSession(reason),
    closeClient: () => clientCreated ? client.close() : undefined,
    closeTransport: () => transportCreated ? transport.close() : undefined,
  });
  const runSetupPhase = <T>(label: string, operation: () => T | Promise<T>): Promise<T> =>
    runDeadlinePhase(operation, {
      deadline: setupDeadline,
      label,
      onDeadline: () => abortSetup(`${label} exceeded the ${BRIDGE_SETUP_MS}ms E2E setup deadline`),
    });

  try {
    // Capture the live mailbox baseline before the MCP process starts. This
    // makes startup itself part of the non-destructive audit instead of
    // silently accepting any startup-time folder, message, or flag changes.
    imap = new ImapFixtures({
      host: imapHost,
      port: imapPort,
      user: imapUser,
      pass: imapPass,
      tls: imapTls,
      allowWipe,
      allowCreateSystemFolders: mode === "greenmail",
      // The live-Bridge lane must be able to create its OWN token-scoped
      // scratch mailboxes, or ScratchSession — which this harness constructs
      // for every bridge run — can never create anything, and any test that
      // needs a scratch Labels/ mailbox dies at setup. That is exactly what
      // happened to the remove_label unlabel-survival regression test: it is
      // Bridge-only by necessity (Greenmail cannot express the invariant, as
      // there a Labels/ mailbox is an ordinary folder), so it errored on every
      // run and never actually guarded the invariant it was written for.
      //
      // This does NOT loosen the live-mailbox safety model. Two other guards
      // remain, and they are the ones doing the work:
      //   - createMailbox still requires assertScratch(path, ownershipToken)
      //     and exclusive creation whenever allowCreateSystemFolders is false
      //     (which it is, above, for bridge) — so creation is confined to the
      //     mpE2E-<uuid> namespace and can never adopt a pre-existing mailbox.
      //   - the MCP-level refusal of create_folder/delete_folder/rename_folder
      //     lives in bridge-safety.ts and is untouched by this flag, so the
      //     "refuses live folder creation before MCP dispatch" test still holds.
      // `safe` is always true for bridge (see the guard above rejecting
      // safe:false), so this reads as "greenmail, or an ownership-scoped run".
      allowMailboxCreate: mode === "greenmail" || safe,
      requireUidPlusForMutations: mode === "bridge",
      ownershipManifestRoot: bridgeAuthorityScope?.scopeRoot,
    });
    await runSetupPhase("fixture IMAP connection and authentication", () => imap.connect());
    imapConnected = true;
    safetySnapshot = mode === "bridge"
      ? await runSetupPhase("live mailbox baseline capture", () => imap.captureSafetySnapshot())
      : undefined;

    // SAFE mode: a token-scoped scratch namespace. Preflight asserts the
    // unique token is not already present before the server can mutate state.
    scratch = safe ? new ScratchSession(imap, ownershipToken) : undefined;
    if (scratch) await runSetupPhase("scratch namespace preflight", () => scratch!.preflight());
    if (safetySnapshot && scratch) {
      imap.persistSafetyBaseline(safetySnapshot, scratch.token);
      if (bridgeSetupJournal) {
        retireBridgeSetupJournal({
          scopeRoot: bridgeAuthorityScope!.scopeRoot,
          token: scratch.token,
          recoveryConfigPath: configPath,
          journalId: bridgeSetupJournal.journalId,
        });
        bridgeSetupJournal = undefined;
      }
    } else if (scratch) {
      // Disposable Greenmail has no live-mail baseline, but still needs the
      // ownership header injection used by safe-mode fixtures.
      imap.setOwnershipToken(scratch.token);
    }

    agentsPath = writeApprovedAgentGrant();
    const childEnv = buildE2EChildEnv(
      process.env,
      mode,
      configPath,
      agentsPath,
      ownershipToken,
      smtpFromOverride,
      credentialToken,
    );
    stateDir = join(dirname(configPath), `.mailpouch-e2e-state-${credentialToken}`);

    transport = new StdioClientTransport({
      command: "node",
      args: [SERVER, "--no-settings-ui", "--no-tray"],
      env: childEnv,
    });
    mcpChildExit = observeMcpStdioChild(transport);
    transportCreated = true;

    client = new Client(
      { name: HARNESS_CLIENT_NAME, version: "1.0.0" },
      { capabilities: { tools: {} } },
    );
    clientCreated = true;
    await runSetupPhase("MCP child connection and initialization", () => client.connect(transport));
    // Cache outputSchemas so callTool() returns structuredContent for tools
    // that declare one.
    await runSetupPhase("MCP tool discovery", () => client.listTools());
  } catch (error) {
    const cleanupErrors: string[] = [];
    let setupTempConfigRemoved = false;
    let setupMcpStopped = !clientCreated && !transportCreated;
    // A setup-deadline abort already initiated and observed both close
    // operations. Never await either again: the same transport bug that hung
    // initialization can also return a never-settling close Promise.
    if (!abortSetup.aborted && clientCreated && transportCreated) {
      const shutdown = await shutdownMcpBounded({
        closeClient: () => client.close(),
        closeTransport: () => transport.close(),
        isChildStopped: () => mcpChildExit?.isStopped() === true,
        clientTimeoutMs: BRIDGE_MCP_CLIENT_CLOSE_MS,
        transportTimeoutMs: BRIDGE_MCP_TRANSPORT_CLOSE_MS,
      });
      setupMcpStopped = shutdown.stopped;
      cleanupErrors.push(...shutdown.errors);
    } else if (!abortSetup.aborted && transportCreated) {
      const shutdown = await shutdownMcpBounded({
        closeClient: () => transport.close(),
        closeTransport: () => transport.close(),
        isChildStopped: () => mcpChildExit?.isStopped() === true,
        clientTimeoutMs: BRIDGE_MCP_CLIENT_CLOSE_MS,
        transportTimeoutMs: BRIDGE_MCP_TRANSPORT_CLOSE_MS,
      });
      setupMcpStopped = shutdown.stopped;
      cleanupErrors.push(...shutdown.errors);
    }
    if (!setupMcpStopped && (clientCreated || transportCreated)) {
      cleanupErrors.push("MCP child shutdown could not be confirmed; recovery state retained");
    }
    // startE2E has not returned, so scenario code cannot have created or
    // mutated any run-owned artifact. In particular, a preflight collision is
    // evidence that the matching folder predates this run; entering cleanup
    // here would let a failed setup claim and delete someone else's state.
    // Verify the captured baseline below, then remove the empty manifest only
    // when that audit succeeds.
    if (safetySnapshot && imapConnected && setupMcpStopped) {
      try {
        const verification = await imap.verifySafetySnapshot(
          safetySnapshot,
          mode === "bridge" ? BRIDGE_BASELINE_VERIFY_MS : undefined,
        );
        if (verification.drift?.length) {
          // Never silent: a narrowed scope must be visible, or it becomes
          // indistinguishable from a mailbox that simply did not change.
          process.stderr.write(
            `Baseline drift outside this run's mutation scope (reported, not E2E damage): `
              + `${verification.drift.join("; ")}\n`,
          );
        }
        if (!verification.ok) cleanupErrors.push(`baseline changed: ${verification.errors.join("; ")}`);
      } catch (verifyError) {
        cleanupErrors.push(`baseline verification failed: ${verifyError instanceof Error ? verifyError.message : String(verifyError)}`);
      }
    }
    if (scratch && mode === "bridge" && imap.hasOwnershipRun(scratch.token) && cleanupErrors.length === 0) {
      try {
        commitVerifiedBridgeArtifacts({
          retireRecoveryConfig: () => {
            retireBridgeRecoveryConfig(configPath, scratch!.token);
            setupTempConfigRemoved = true;
          },
          completeOwnership: () => imap.completeOwnershipRun(scratch!.token),
        });
      }
      catch (completeError) {
        setupTempConfigRemoved = setupTempConfigRemoved || !existsSync(configPath);
        cleanupErrors.push(`verified setup artifact commit failed: ${completeError instanceof Error ? completeError.message : String(completeError)}`);
      }
    }
    if (imapConnected) {
      try { await imap.close(); }
      catch (closeError) {
        cleanupErrors.push(`fixture IMAP close failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`);
      }
    }
    const setupArtifacts = harnessArtifactPolicy({
      mode,
      isTempConfig,
      ownershipRunActive: scratch !== undefined && imap.hasOwnershipRun(scratch.token),
      mcpStopped: setupMcpStopped,
    });
    if (setupArtifacts.removeTempConfig && !setupTempConfigRemoved) {
      try {
        if (mode === "bridge") retireBridgeRecoveryConfig(configPath, ownershipToken!);
        else unlinkSync(configPath);
        setupTempConfigRemoved = true;
      }
      catch (unlinkError) {
        cleanupErrors.push(`temporary config removal failed: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`);
      }
    }
    const ownershipRunActive = scratch !== undefined && imap.hasOwnershipRun(scratch.token);
    if (bridgeSetupJournal && setupTempConfigRemoved && !ownershipRunActive) {
      try {
        retireBridgeSetupJournal({
          scopeRoot: bridgeAuthorityScope!.scopeRoot,
          token: ownershipToken!,
          recoveryConfigPath: configPath,
          journalId: bridgeSetupJournal.journalId,
        });
        bridgeSetupJournal = undefined;
      } catch (journalError) {
        cleanupErrors.push(
          `setup-journal retirement failed: ${journalError instanceof Error ? journalError.message : String(journalError)}`,
        );
      }
    }
    if (setupArtifacts.recoveryRetained) {
      if (existsSync(configPath)) {
        cleanupErrors.push(
          `recovery config retained at ${configPath}; recover with: ${recoveryCommand(configPath, scratch!.token)}`,
        );
      } else {
        cleanupErrors.push(
          `ownership manifest retained for ${scratch!.token}, but its exact encrypted recovery clone was already retired`,
        );
      }
    } else if (isTempConfig && !setupMcpStopped) {
      cleanupErrors.push(`temporary config retained at ${configPath} because MCP shutdown was not confirmed`);
    }
    if (agentsPath) {
      try { unlinkSync(agentsPath); }
      catch (unlinkError) {
        cleanupErrors.push(`temporary grant removal failed: ${unlinkError instanceof Error ? unlinkError.message : String(unlinkError)}`);
      }
    }
    if (stateDir && setupArtifacts.removeRuntimeState) {
      try { rmSync(stateDir, { recursive: true, force: true }); }
      catch (stateError) {
        cleanupErrors.push(`temporary runtime-state removal failed: ${stateError instanceof Error ? stateError.message : String(stateError)}`);
      }
    } else if (stateDir) {
      cleanupErrors.push(`temporary runtime state retained at ${stateDir} because MCP shutdown was not confirmed`);
    }
    if (setupArtifacts.releaseRunLease) {
      releaseBridgeLease((message) => cleanupErrors.push(message));
    } else if (bridgeRunLease) {
      cleanupErrors.push(
        `Bridge E2E run lease retained at ${bridgeRunLease.path}; terminate the unconfirmed child before manual removal`,
      );
    }
    const original = error instanceof Error ? error.message : String(error);
    throw new Error(
      cleanupErrors.length > 0
        ? `E2E harness setup failed: ${original}; safety cleanup: ${cleanupErrors.join("; ")}`
        : `E2E harness setup failed: ${original}`,
      { cause: error },
    );
  }

  const accountEmail = mode === "greenmail" ? greenmailUser.email : imapUser;
  type AdoptionFixture = ImapFixtures & {
    beginSentMessageAdoption?: (
      expectedSubject: string,
      token: string,
      expectedBodyToken?: string,
    ) => string;
    beginDraftMessageAdoption?: (folder: string, expectedSubject: string, token: string) => string;
    adoptOwnedUid?: (
      folder: string,
      uid: number,
      token: string,
      expectedSubject: string,
      pendingId: string,
    ) => Promise<void>;
    registerSentMessageId?: (
      messageId: string,
      token: string,
      expectedSubject?: string,
      expectedBodyToken?: string,
      pendingId?: string,
    ) => Promise<void>;
  };
  const adoptionFixture = imap as AdoptionFixture;

  const assertAdoptionSupported = (post: BridgePostcondition | undefined): void => {
    if (!post) return;
    if (post.kind === "adopt-draft"
      && (typeof adoptionFixture.beginDraftMessageAdoption !== "function"
        || typeof adoptionFixture.adoptOwnedUid !== "function")) {
      throw new Error("Bridge E2E safety guard refused: draft ownership adoption is unavailable.");
    }
    if (post.kind === "adopt-sent"
      && (typeof adoptionFixture.beginSentMessageAdoption !== "function"
        || typeof adoptionFixture.registerSentMessageId !== "function")) {
      throw new Error("Bridge E2E safety guard refused: sent-message ownership adoption is unavailable.");
    }
  };

  const beginPostcondition = (post: BridgePostcondition | undefined): string | undefined => {
    if (!post) return undefined;
    if (post.kind === "adopt-draft") {
      return adoptionFixture.beginDraftMessageAdoption!(post.folder, post.expectedSubject, scratch!.token);
    }
    return adoptionFixture.beginSentMessageAdoption!(post.expectedSubject, scratch!.token, post.expectedBodyToken);
  };

  const structuredResult = (result: CallResult): Record<string, unknown> => {
    if (result.structuredContent && typeof result.structuredContent === "object") {
      return result.structuredContent as Record<string, unknown>;
    }
    const text = result.content[0]?.text;
    if (!text) return {};
    try {
      const parsed = JSON.parse(text) as unknown;
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  };

  const applyPostcondition = async (
    post: BridgePostcondition | undefined,
    result: CallResult,
    pendingId: string | undefined,
  ): Promise<void> => {
    if (!post || result.isError === true) return;
    if (!pendingId) throw new Error("Bridge E2E safety guard: durable pending ownership proof is missing.");
    const structured = structuredResult(result);
    if (post.kind === "adopt-draft") {
      const uid = structured.uid;
      if (typeof uid !== "number" || !Number.isSafeInteger(uid) || uid < 1) {
        throw new Error("Bridge E2E safety guard: save_draft succeeded without a usable UID; ownership cannot be adopted.");
      }
      await adoptionFixture.adoptOwnedUid!(
        post.folder,
        uid,
        scratch!.token,
        post.expectedSubject,
        pendingId,
      );
      return;
    }
    const messageId = structured.messageId;
    if (typeof messageId !== "string" || messageId.trim() === "") {
      throw new Error("Bridge E2E safety guard: SMTP send succeeded without a Message-ID; ownership cannot be adopted.");
    }
    await adoptionFixture.registerSentMessageId!(
      messageId,
      scratch!.token,
      post.expectedSubject,
      post.expectedBodyToken,
      pendingId,
    );
  };

  const invoke = async (name: string, args: Record<string, unknown>): Promise<CallResult> => {
    const post = mode === "bridge"
      ? await guardBridgeCall(name, args, {
        token: scratch!.token,
        accountEmail,
        imap,
      })
      : undefined;
    // Folder safety checks SELECT the target through the independent fixture.
    // Release that session before Bridge receives DELETE/RENAME; some servers
    // (notably Greenmail) terminate the mutating session when another client
    // still has the target selected.
    if (mode === "bridge" && (name === "delete_folder" || name === "rename_folder")) {
      await imap.prepareMailboxDeletion();
    }
    // Refuse before dispatch when cleanup cannot adopt the result. A check
    // after SMTP/APPEND would discover the problem only after creating residue.
    assertAdoptionSupported(post);
    // Persist a narrowly constrained proof before dispatch. If transport,
    // response parsing, or postcondition validation fails after the server
    // created the message, crash cleanup can still find it by exact tokenized
    // subject (and body token for the fixed-subject probe).
    const pendingId = beginPostcondition(post);
    const result = await client.callTool(
      { name, arguments: args },
      undefined,
      {
        timeout: BRIDGE_MCP_REQUEST_MS,
        maxTotalTimeout: BRIDGE_MCP_REQUEST_MS,
        resetTimeoutOnProgress: false,
      },
    ) as CallResult;
    await applyPostcondition(post, result, pendingId);
    if (name === "create_folder" && result.isError !== true && scratch) {
      const folderName = args.folderName;
      const structured = structuredResult(result);
      if (typeof folderName !== "string" || structured.success !== true) {
        throw new Error("Bridge E2E safety guard: create_folder succeeded without positive creation proof");
      }
      await scratch.claimCreated(folderName);
    }
    return result;
  };

  const call = (name: string, args: Record<string, unknown> = {}): Promise<CallResult> =>
    invoke(name, args);

  const callRaw = async (name: string, args: Record<string, unknown> = {}): Promise<RawOutcome> => {
    try {
      const res = await invoke(name, args);
      return { ok: true, ...res };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as Record<string, unknown>)?.code as number | undefined;
      return { ok: false, code, message: msg };
    }
  };

  const appendVisibleSeed = async (
    folder: string,
    seed: SeedEmail,
    flags: string[] = [],
    timeoutMs = mode === "bridge" ? 60_000 : 10_000,
  ): Promise<{ identity: AppendedSeedIdentity; uid: number; email: Record<string, unknown> }> => {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 120_000) {
      throw new Error(`Invalid identified-seed visibility timeout: ${timeoutMs}`);
    }
    const identity = await imap.appendIdentifiedSeed(folder, seed, flags);
    const ownership = mode === "bridge" ? scratch!.token : undefined;
    const deadline = Date.now() + timeoutMs;
    let lastDetail = "the exact seed identity was not yet projected";

    do {
      let currentUids: number[] = [];
      try {
        currentUids = await imap.findSeedIdentityUids(
          folder,
          identity.messageId,
          identity.subject,
          ownership,
        );
      } catch (error) {
        lastDetail = `fixture identity resolution failed: ${error instanceof Error ? error.message : String(error)}`;
      }

      // APPENDUID is normally stable, but Bridge projections can briefly expose
      // a different current UID. Prefer APPENDUID when still present and try all
      // exact-identity candidates without widening to any other message.
      const candidates = [...new Set([
        ...(currentUids.includes(identity.uid) ? [identity.uid] : []),
        ...currentUids,
      ])];
      for (const uid of candidates) {
        try {
          const result = await call("get_email_by_id", { emailId: String(uid), folder });
          if (result.isError === true) {
            lastDetail = result.content[0]?.text ?? `UID ${uid} was not readable`;
            continue;
          }
          const email = structuredResult(result);
          if (email.subject === identity.subject) return { identity, uid, email };
          lastDetail = `UID ${uid} resolved with unexpected subject ${JSON.stringify(email.subject)}`;
        } catch (error) {
          lastDetail = `MCP UID read failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      // Nudge only the local cache/connection. This is explicitly classified as
      // a safe local refresh and does not alter the live mailbox.
      try { await call("sync_emails", { folder, limit: 1 }); } catch { /* retry the exact read */ }
      if (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, Math.min(500, deadline - Date.now())));
      }
    } while (Date.now() < deadline);

    throw new Error(
      `MCP did not expose exact-owned seed ${identity.messageId} in '${folder}' within ${timeoutMs}ms: ${lastDetail}`,
    );
  };

  const json = <T = unknown>(result: CallResult): T => {
    expect(result.isError).toBeFalsy();
    // Tools that declare an outputSchema return their structured output in
    // `structuredContent`; `content[0].text` is a human-readable summary
    // (e.g. "Done.", "Completed: 2 of 2 (0 failed)"). Prefer the structured
    // object when present; fall back to JSON-parsing the text otherwise.
    if (result.structuredContent !== undefined && result.structuredContent !== null) {
      return result.structuredContent as T;
    }
    expect(result.content[0]?.type).toBe("text");
    return JSON.parse(result.content[0].text) as T;
  };

  const domainErrorText = (result: CallResult): string => {
    expect(result.isError).toBe(true);
    return result.content[0]?.text ?? "";
  };

  const isPermissionBlocked = (r: CallResult | RawOutcome): boolean => {
    const text = "content" in r ? r.content[0]?.text ?? "" : "message" in r ? r.message : "";
    return (
      ("isError" in r && r.isError === true && (text.includes("disabled in server settings") || text.includes("blocked"))) ||
      ("ok" in r && !r.ok && text.includes("disabled in server settings"))
    );
  };

  const resetState = async (): Promise<void> => {
    // SAFE mode never wipes — scenarios isolate via unique scratch folders. We
    // still bounce the mailpouch connection online (read-only sync).
    if (!safe) {
      await imap.wipe();
    }
    // sync_emails (and the get_emails fallback) calls ensureConnection() —
    // mutations don't, so without this the next move/star/delete will hit
    // "IMAP client not connected".
    try {
      await call("sync_emails", { folder: "INBOX", limit: 1 });
    } catch {
      // If sync fails (e.g. INBOX empty after wipe), still try a folder list
      // which also bounces the connection.
      try {
        await call("get_folders");
      } catch {
        // give up — next test call will surface the error
      }
    }
  };

  const close = async (): Promise<void> => {
    let cleanupFailure: Error | undefined;
    let scratchVerified = scratch === undefined;
    let baselineVerified = safetySnapshot === undefined;
    let recoveryChildTerminationConfirmed = true;
    let standaloneRecoveryCommitted = false;
    let tempConfigRemoved = false;
    let fixtureClosed = false;
    let fixtureCloseSucceeded = false;
    const appendFailure = (message: string): void => {
      cleanupFailure = cleanupFailure
        ? new Error(`${cleanupFailure.message}; ${message}`)
        : new Error(message);
    };
    const closeFixture = async (): Promise<boolean> => {
      if (fixtureClosed) return fixtureCloseSucceeded;
      fixtureClosed = true;
      try {
        await imap.close();
        fixtureCloseSucceeded = true;
      } catch (error) {
        appendFailure(`fixture IMAP close failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      return fixtureCloseSucceeded;
    };
    // Stop the MCP process first so it cannot mutate mailbox state while the
    // independent fixture performs exact ownership cleanup and the final
    // baseline audit.
    const shutdown = await shutdownMcpBounded({
      closeClient: () => client.close(),
      closeTransport: () => transport.close(),
      isChildStopped: () => mcpChildExit?.isStopped() === true,
      clientTimeoutMs: BRIDGE_MCP_CLIENT_CLOSE_MS,
      transportTimeoutMs: BRIDGE_MCP_TRANSPORT_CLOSE_MS,
    });
    if (!shutdown.clean) {
      for (const error of shutdown.errors) appendFailure(error);
    }
    if (!shutdown.stopped) {
      appendFailure("MCP child shutdown could not be confirmed; ownership cleanup was not started");
    }
    // Scoped mode: cleanup is safety-critical. Owned-message residue,
    // unverified folders, or incomplete verification make the E2E red.
    // Positively-created empty Bridge folders are allowed only when they are
    // explicitly classified and reported for manual cleanup.
    if (scratch && shutdown.stopped) {
      const hadPendingOwnership = imap.pendingOwnershipProofCount() > 0;
      try {
        const report = await scratch.cleanup({
          retainEmptyFolders: mode === "greenmail",
          settleAfterPurgeMs: mode === "bridge" ? BRIDGE_CLEANUP_SETTLE_MS : 0,
          deferOwnershipCompletion: mode === "bridge",
        });
        if (!report.ok) {
          const details = [
            ...report.errors,
            ...(report.retained.length ? [`retained: ${report.retained.join(", ")}`] : []),
            ...(report.manualFolderCleanup.length
              ? [`manual folder cleanup: ${report.manualFolderCleanup.join(", ")}`]
              : []),
            ...(report.residue.length ? [`residue: ${report.residue.join(", ")}`] : []),
            ...(Object.keys(report.ownedMessageResidue).length
              ? [`owned message residue: ${JSON.stringify(report.ownedMessageResidue)}`]
              : []),
          ];
          const failureMessage =
            `Bridge E2E cleanup did not complete for ${scratch.token}: ` +
            (details.join("; ") || "unknown cleanup failure");

          const recovery = await coordinateStandaloneBridgeRecovery({
            mode,
            report,
            hasPriorTeardownFailure: cleanupFailure !== undefined,
            closePoisonedFixture: closeFixture,
            recover: () => recoverBridgeRunStandalone({
                token: scratch.token,
                configPath,
                authorityConfigPath: bridgeAuthorityConfigPath,
                leaseOwnerToken: bridgeRunLease?.ownerToken,
                manifestPath: bridgeAuthorityScope
                  ? join(bridgeAuthorityScope.scopeRoot, `bridge-run-${scratch.token}.json`)
                  : undefined,
                timeoutMs: bridgeStandaloneProcessBudgetMs(hadPendingOwnership)
                  + BRIDGE_STANDALONE_PARENT_MARGIN_MS,
            }),
          });
          if (recovery.recovered) {
            // The standalone process independently re-discovers exact
            // ownership and verifies the persisted pre-run baseline before
            // it removes the manifest. Its success replaces both checks on
            // the now-poisoned fixture session.
            scratchVerified = true;
            baselineVerified = true;
            standaloneRecoveryCommitted = true;
            try {
              const childOutput = [recovery.result.stdout.trim(), recovery.result.stderr.trim()]
                .filter(Boolean)
                .join("\n");
              console.warn(
                `Bridge E2E recovered ambiguous cleanup for ${scratch.token} in one fresh process.` +
                (childOutput ? `\n${childOutput}` : ""),
              );
            } catch {
              // Cleanup is independently verified and committed; warning
              // output cannot recreate recovery authority.
            }
          } else {
            if (recovery.attempted
              && !standaloneRecoveryTerminationConfirmed(recovery.error)) {
              recoveryChildTerminationConfirmed = false;
            }
            appendFailure(
              recovery.attempted
                ? `${failureMessage}; automatic fresh-process recovery failed: ` +
                  `${recovery.error instanceof Error ? recovery.error.message : String(recovery.error)}`
                : failureMessage,
            );
          }
        } else {
          scratchVerified = true;
          if (mode === "bridge" && report.manualFolderCleanup.length > 0) {
            try {
              console.warn(
                `Bridge E2E retained ${report.manualFolderCleanup.length} positively-created empty folder(s) ` +
                `for manual deletion; live cleanup never issues IMAP mailbox DELETE: ` +
                report.manualFolderCleanup.join(", "),
              );
            } catch {
              // Mailbox/message cleanup is already verified; warning output is
              // best-effort and cannot create recovery authority.
            }
          }
        }
      } catch (error) {
        const code = error && typeof error === "object"
          ? (error as { code?: unknown }).code
          : undefined;
        if (code === "MAILPOUCH_E2E_MUTATION_OUTCOME_UNKNOWN"
          || code === "MAILPOUCH_E2E_CLEANUP_TIMEOUT") {
          await closeFixture();
        }
        appendFailure(
          `Bridge E2E cleanup threw for ${scratch.token}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (safetySnapshot && shutdown.stopped && recoveryChildTerminationConfirmed
      && !baselineVerified && !fixtureClosed) {
      try {
        const verification = await imap.verifySafetySnapshot(
          safetySnapshot,
          mode === "bridge" ? BRIDGE_BASELINE_VERIFY_MS : undefined,
        );
        if (verification.drift?.length) {
          process.stderr.write(
            `Baseline drift outside this run's mutation scope (reported, not E2E damage): `
              + `${verification.drift.join("; ")}\n`,
          );
        }
        if (!verification.ok) {
          const snapshotFailure = new Error(
            `Bridge E2E changed pre-existing mailbox state: ${verification.errors.join("; ")}`,
          );
          appendFailure(snapshotFailure.message);
        } else {
          baselineVerified = true;
        }
      } catch (error) {
        const snapshotFailure = new Error(
          `Bridge E2E could not verify pre-existing mailbox state: ${error instanceof Error ? error.message : String(error)}`,
        );
        appendFailure(snapshotFailure.message);
      }
    }
    if (shouldCommitBridgeOwnership({
      mode,
      hasScratch: scratch !== undefined,
      scratchVerified,
      baselineVerified,
      hasTeardownFailure: cleanupFailure !== undefined,
    })) {
      try {
        commitVerifiedBridgeArtifacts({
          retireRecoveryConfig: () => {
            retireBridgeRecoveryConfig(configPath, scratch.token, standaloneRecoveryCommitted);
            tempConfigRemoved = true;
          },
          completeOwnership: () => imap.completeOwnershipRun(scratch.token),
        });
      }
      catch (error) {
        tempConfigRemoved = tempConfigRemoved || !existsSync(configPath);
        appendFailure(`verified Bridge artifact commit failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    await closeFixture();
    const artifacts = harnessArtifactPolicy({
      mode,
      isTempConfig,
      ownershipRunActive: scratch !== undefined && imap.hasOwnershipRun(scratch.token),
      mcpStopped: shutdown.stopped && recoveryChildTerminationConfirmed,
    });
    if (artifacts.removeTempConfig && !tempConfigRemoved) {
      try {
        if (mode === "bridge") retireBridgeRecoveryConfig(configPath, ownershipToken!);
        else unlinkSync(configPath);
        tempConfigRemoved = true;
      } catch (error) {
        appendFailure(`temporary E2E config removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (artifacts.recoveryRetained) {
      if (existsSync(configPath)) {
        appendFailure(
          `recovery config retained at ${configPath}; recover with: ${recoveryCommand(configPath, scratch!.token)}`,
        );
      } else {
        appendFailure(
          `ownership manifest retained for ${scratch!.token}, but its exact encrypted recovery clone was already retired; ` +
          `inspect the manifest before removing that credential-free orphan`,
        );
      }
    } else if (isTempConfig && !shutdown.stopped) {
      appendFailure(`temporary E2E config retained at ${configPath} because MCP shutdown was not confirmed`);
    }
    try {
      unlinkSync(agentsPath);
    } catch (error) {
      appendFailure(`temporary E2E grant removal failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (stateDir && artifacts.removeRuntimeState) {
      try { rmSync(stateDir, { recursive: true, force: true }); }
      catch (error) {
        appendFailure(`temporary E2E runtime-state removal failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else if (stateDir) {
      appendFailure(`temporary E2E runtime state retained at ${stateDir} because MCP shutdown was not confirmed`);
    }
    if (artifacts.releaseRunLease) {
      releaseBridgeLease(appendFailure);
    } else if (bridgeRunLease) {
      appendFailure(
        `Bridge E2E run lease retained at ${bridgeRunLease.path}; ` +
        `terminate the unconfirmed child before manual removal`,
      );
    }
    if (cleanupFailure) throw cleanupFailure;
  };

  const scratchPath = (kind: ScratchKind = "folders"): string => {
    if (!scratch) throw new Error("scratchPath() requires an ownership-scoped E2E harness");
    return scratch.path(kind);
  };
  const scratchLabel = (): string => scratchPath("labels").slice("Labels/".length);
  const provenMissingUid = async (folder = "INBOX"): Promise<string> => {
    if (mode === "bridge") {
      throw new Error("Live Bridge E2E does not dispatch absent or unowned UID mutation probes");
    }
    const existing = new Set(await imap.listUids(folder));
    for (let candidate = 0xffff_ffff; candidate > 0xffff_ff00; candidate--) {
      if (!existing.has(candidate) && !(await imap.uidExists(folder, candidate))) return String(candidate);
    }
    throw new Error(`Could not prove an absent UID in '${folder}'`);
  };

  return {
    imap: scenarioImapFacade(imap),
    listTools: () => client.listTools(),
    call,
    callRaw,
    json,
    domainErrorText,
    isPermissionBlocked,
    resetState,
    close,
    scratch,
    runToken: scratch?.token,
    mode,
    accountEmail,
    scratchPath,
    scratchLabel,
    provenMissingUid,
    appendVisibleSeed,
  };
}
