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
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { expect } from "vitest";
import { buildPermissions } from "../../src/config/loader.js";
import { localAgentId } from "../../src/agents/caller-context.js";
import { ImapFixtures } from "./fixtures/imap-fixtures.js";
import { GREENMAIL_IMAP_PORT, GREENMAIL_SMTP_PORT, TEST_USER } from "./support/docker.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER = join(__dirname, "..", "..", "dist", "index.js");
const HOME = process.env.HOME ?? "/root";

export type TextContent = { type: "text"; text: string };
export type CallResult = { content: TextContent[]; isError?: boolean; structuredContent?: unknown };
export type RawOutcome =
  | ({ ok: true } & CallResult)
  | { ok: false; code?: number; message: string };

export interface E2EHarness {
  client: Client;
  imap: ImapFixtures;
  call(name: string, args?: Record<string, unknown>): Promise<CallResult>;
  callRaw(name: string, args?: Record<string, unknown>): Promise<RawOutcome>;
  json<T = unknown>(result: CallResult): T;
  domainErrorText(result: CallResult): string;
  isPermissionBlocked(r: CallResult | RawOutcome): boolean;
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
}

export type HarnessMode = "greenmail" | "bridge";

export interface StartE2EOptions {
  mode?: HarnessMode;
  /** Override Greenmail user. Ignored in bridge mode. */
  user?: { email: string; username: string; password: string };
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

/** Phase 1 — write a Greenmail-targeted mailpouch config under $HOME. */
function writeGreenmailConfig(user: { email: string; username: string; password: string }): string {
  const path = join(HOME, `.mailpouch-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
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
  const path = process.env.MAILPOUCH_E2E_BRIDGE_CONFIG;
  return typeof path === "string" && existsSync(path);
}

/** Shape of the subset of mailpouch's config we need to talk IMAP. */
interface BridgeConnectionConfig {
  imapHost: string;
  imapPort: number;
  username: string;
  password: string;
}

/** Read the Bridge config file and extract just the IMAP connection fields
 *  ImapFixtures needs. Throws if any required field is missing — the harness
 *  can't usefully run against a half-configured Bridge. */
function readBridgeConnection(configPath: string): BridgeConnectionConfig {
  const raw = JSON.parse(readFileSync(configPath, "utf-8")) as {
    connection?: Partial<BridgeConnectionConfig>;
  };
  const conn = raw.connection ?? {};
  if (!conn.imapHost || !conn.imapPort || !conn.username || !conn.password) {
    throw new Error(
      `Bridge config at ${configPath} is missing connection.imapHost / imapPort / username / password. ` +
        `ImapFixtures cannot connect without all four.`
    );
  }
  return {
    imapHost: conn.imapHost,
    imapPort: conn.imapPort,
    username: conn.username,
    password: conn.password,
  };
}

export async function startE2E(opts: StartE2EOptions = {}): Promise<E2EHarness> {
  // Mode resolution:
  //   - explicit opts.mode wins
  //   - else MAILPOUCH_E2E_BRIDGE_CONFIG present → bridge (so the same
  //     scenarios re-run via `test:e2e:bridge` actually target Bridge)
  //   - else default to greenmail
  const mode = opts.mode ?? (bridgeConfigAvailable() ? "bridge" : "greenmail");
  const greenmailUser = opts.user ?? TEST_USER;

  let configPath: string;
  let isTempConfig = false;
  let imapHost: string;
  let imapPort: number;
  let imapUser: string;
  let imapPass: string;
  if (mode === "greenmail") {
    configPath = writeGreenmailConfig(greenmailUser);
    isTempConfig = true;
    imapHost = "127.0.0.1";
    imapPort = GREENMAIL_IMAP_PORT;
    imapUser = greenmailUser.username;
    imapPass = greenmailUser.password;
  } else {
    // Clone the operator-supplied Bridge config to a unique temp path with
    // `credentialStorage: "config"` baked in. Without this, mailpouch's
    // startup migration (CRED-001) routes the on-disk password to keychain
    // and blanks the disk field — the next test in the same run then sees
    // an empty password and throws "missing connection.password". The clone
    // also keeps the operator's durable bridge-test config from being
    // mutated by the test harness at all.
    const sourcePath = resolveBridgeConfig();
    const bridge = readBridgeConnection(sourcePath);
    const raw = JSON.parse(readFileSync(sourcePath, "utf-8")) as Record<string, unknown>;
    (raw as { credentialStorage?: string }).credentialStorage = "config";
    configPath = join(HOME, `.mailpouch-e2e-bridge-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(configPath, JSON.stringify(raw, null, 2), { mode: 0o600 });
    isTempConfig = true;
    imapHost = bridge.imapHost;
    imapPort = bridge.imapPort;
    imapUser = bridge.username;
    imapPass = bridge.password;
  }

  // Greenmail provisions users with bare logins ("alice") but rejects
  // outbound SMTP when MAIL FROM lacks a domain. Real Bridge has full-email
  // usernames so this is normally a no-op. The MAILPOUCH_SMTP_FROM env var
  // (production unaware of it) supplies a domain-qualified From for the
  // Greenmail-only harness; bridge mode leaves it unset.
  const smtpFromOverride = mode === "greenmail"
    ? `${imapUser}@test.local`
    : undefined;
  const agentsPath = writeApprovedAgentGrant();
  const transport = new StdioClientTransport({
    command: "node",
    args: [SERVER],
    env: {
      ...process.env,
      MAILPOUCH_CONFIG: configPath,
      MAILPOUCH_AGENTS: agentsPath,
      MAILPOUCH_INSECURE_BRIDGE: "1",
      MAILPOUCH_TIER: "complete",
      // Greenmail's embedded SMTP does not advertise STARTTLS. This
      // test-only switch relaxes the requireTLS upgrade for the Greenmail
      // lane WITHOUT touching the production insecure-cert path (which keeps
      // STARTTLS required). Bridge mode leaves it unset — real Bridge
      // advertises STARTTLS, so requireTLS stays on there.
      ...(mode === "greenmail" ? { MAILPOUCH_SMTP_ALLOW_PLAINTEXT: "1" } : {}),
      ...(smtpFromOverride ? { MAILPOUCH_SMTP_FROM: smtpFromOverride } : {}),
    },
  });

  const client = new Client(
    { name: HARNESS_CLIENT_NAME, version: "1.0.0" },
    { capabilities: { tools: {} } }
  );
  await client.connect(transport);
  // Cache outputSchemas so callTool() returns structuredContent for tools that declare one.
  await client.listTools();

  const imap = new ImapFixtures({
    host: imapHost,
    port: imapPort,
    user: imapUser,
    pass: imapPass,
  });
  await imap.connect();

  const call = (name: string, args: Record<string, unknown> = {}): Promise<CallResult> =>
    client.callTool({ name, arguments: args }) as Promise<CallResult>;

  const callRaw = async (name: string, args: Record<string, unknown> = {}): Promise<RawOutcome> => {
    try {
      const res = await client.callTool({ name, arguments: args });
      return { ok: true, ...(res as CallResult) };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      const code = (err as Record<string, unknown>)?.code as number | undefined;
      return { ok: false, code, message: msg };
    }
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
    await imap.wipe();
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
    try {
      await imap.close();
    } catch {
      // ignore
    }
    try {
      await client.close();
    } catch {
      // ignore
    }
    if (isTempConfig) {
      try {
        unlinkSync(configPath);
      } catch {
        // ignore
      }
    }
    try {
      unlinkSync(agentsPath);
    } catch {
      // ignore
    }
  };

  return { client, imap, call, callRaw, json, domainErrorText, isPermissionBlocked, resetState, close };
}
