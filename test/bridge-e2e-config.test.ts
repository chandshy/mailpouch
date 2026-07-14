import { describe, expect, it, vi } from "vitest";
import { buildPermissions } from "../src/config/loader.js";
import { CredentialEncryption } from "../src/crypto/credential-encryption.js";
import {
  buildBridgeChildConfig,
  buildE2EChildEnv,
  hydrateBridgeConfigForE2E,
  quotePosixShellArgument,
} from "./e2e/mcp-client.js";

const TOKEN = "mpE2E-12345678-1234-4abc-8def-1234567890ab";

function account(over: Record<string, unknown> = {}) {
  return {
    id: "primary",
    name: "Bridge",
    providerType: "proton-bridge" as const,
    smtpHost: "localhost",
    smtpPort: 1025,
    imapHost: "localhost",
    imapPort: 1143,
    username: "owner@proton.test",
    password: "",
    ...over,
  };
}

describe("Bridge E2E config credential hydration", () => {
  it("single-quotes recovery command operands without shell expansion", () => {
    expect(quotePosixShellArgument("/tmp/$HOME/$(touch pwned)/`id`/'quoted'"))
      .toBe("'/tmp/$HOME/$(touch pwned)/`id`/'\"'\"'quoted'\"'\"''");
  });

  it("hydrates the active account from per-account keychain fields into only the detached clone", async () => {
    const source = {
      connection: {
        imapHost: "localhost",
        imapPort: 1143,
        username: "owner@proton.test",
        password: "",
      },
      accounts: [account()],
      activeAccountId: "primary",
    };
    const readers = {
      loadLegacy: vi.fn(async () => null),
      loadAccount: vi.fn(async () => ({ password: "keychain-password", smtpToken: "keychain-token" })),
    };

    const hydrated = await hydrateBridgeConfigForE2E(source, readers);
    expect(hydrated).not.toBe(source);
    expect(hydrated.accounts?.[0].password).toBe("keychain-password");
    expect(hydrated.accounts?.[0].smtpToken).toBe("keychain-token");
    expect(hydrated.connection?.password).toBe("keychain-password");
    expect(hydrated.connection?.smtpToken).toBe("keychain-token");
    expect(source.accounts[0].password).toBe("");
    expect(source.connection.password).toBe("");
  });

  it("preserves per-field config fallbacks instead of overwriting them with stale keychain values", async () => {
    const hydrated = await hydrateBridgeConfigForE2E({
      connection: { imapHost: "localhost", imapPort: 1143, username: "owner@proton.test", password: "" },
      accounts: [account({ password: "config-password", smtpToken: "config-token" })],
    }, {
      loadLegacy: async () => ({ password: "legacy-stale", smtpToken: "legacy-stale" }),
      loadAccount: async () => ({ password: "account-stale", smtpToken: "account-stale" }),
    });
    expect(hydrated.accounts?.[0].password).toBe("config-password");
    expect(hydrated.accounts?.[0].smtpToken).toBe("config-token");
    expect(hydrated.connection?.password).toBe("config-password");
    expect(hydrated.connection?.smtpToken).toBe("config-token");
  });

  it("falls back to the legacy primary keychain slots", async () => {
    const hydrated = await hydrateBridgeConfigForE2E({
      connection: { imapHost: "localhost", imapPort: 1143, username: "owner@proton.test", password: "" },
      accounts: [account()],
    }, {
      loadLegacy: async () => ({ password: "legacy-password", smtpToken: "legacy-token" }),
      loadAccount: async () => null,
    });
    expect(hydrated.accounts?.[0].password).toBe("legacy-password");
    expect(hydrated.connection?.password).toBe("legacy-password");
  });

  it("hydrates and retains only the selected account", async () => {
    const readers = {
      loadLegacy: vi.fn(async () => ({ password: "legacy", smtpToken: "legacy-token" })),
      loadAccount: vi.fn(async (id: string) => ({ password: `${id}-password`, smtpToken: `${id}-token` })),
    };
    const hydrated = await hydrateBridgeConfigForE2E({
      connection: { imapHost: "localhost", imapPort: 1143, username: "stale", password: "" },
      accounts: [
        account({ id: "inactive", username: "inactive@proton.test" }),
        account({
          id: "selected",
          username: "selected@proton.test",
          smtpHost: "smtp.selected.test",
          smtpPort: 1465,
          tlsMode: "ssl",
          autoStartBridge: false,
          bridgePath: "/selected/bridge",
        }),
      ],
      activeAccountId: "selected",
    }, readers);

    expect(hydrated.accounts).toHaveLength(1);
    expect(hydrated.accounts?.[0]).toMatchObject({
      id: "selected",
      username: "selected@proton.test",
      password: "selected-password",
      smtpToken: "selected-token",
      smtpHost: "smtp.selected.test",
      smtpPort: 1465,
      tlsMode: "ssl",
      autoStartBridge: false,
      bridgePath: "/selected/bridge",
    });
    expect(hydrated.connection).toMatchObject({
      username: "selected@proton.test",
      password: "selected-password",
      smtpToken: "selected-token",
    });
    expect(readers.loadAccount).toHaveBeenCalledOnce();
    expect(readers.loadAccount).toHaveBeenCalledWith("selected");
    expect(readers.loadLegacy).not.toHaveBeenCalled();
  });

  it("does not let legacy plaintext bypass a tampered encrypted credential", async () => {
    const encrypted = CredentialEncryption.encrypt("authentic-password");
    const tampered = {
      ...encrypted,
      authTag: `${encrypted.authTag[0] === "A" ? "B" : "A"}${encrypted.authTag.slice(1)}`,
    };
    await expect(hydrateBridgeConfigForE2E({
      connection: {
        imapHost: "localhost",
        imapPort: 1143,
        username: "owner@proton.test",
        password: "attacker-plaintext",
        passwordEncrypted: tampered,
      },
    }, {
      loadLegacy: async () => null,
      loadAccount: async () => null,
    })).rejects.toThrow(/authenticated decryption/i);
  });

  it("treats an authenticated encrypted empty value as authoritative over plaintext", async () => {
    const hydrated = await hydrateBridgeConfigForE2E({
      connection: {
        imapHost: "localhost",
        imapPort: 1143,
        username: "owner@proton.test",
        password: "stale-plaintext",
        passwordEncrypted: CredentialEncryption.encrypt(""),
      },
    }, {
      loadLegacy: async () => ({ password: "stale-keychain", smtpToken: "" }),
      loadAccount: async () => null,
    });
    expect(hydrated.connection?.password).toBe("");
  });

  it("decrypts active-account fields without falling back to stale keychain values", async () => {
    const readers = {
      loadLegacy: vi.fn(async () => ({ password: "legacy-stale", smtpToken: "legacy-stale" })),
      loadAccount: vi.fn(async () => ({ password: "account-stale", smtpToken: "account-stale" })),
    };
    const hydrated = await hydrateBridgeConfigForE2E({
      connection: { imapHost: "stale", imapPort: 1, username: "stale", password: "" },
      accounts: [account({
        password: "plaintext-stale",
        smtpToken: "plaintext-stale",
        passwordEncrypted: CredentialEncryption.encrypt("encrypted-password"),
        smtpTokenEncrypted: CredentialEncryption.encrypt("encrypted-token"),
      })],
      activeAccountId: "primary",
    }, readers);

    expect(hydrated.accounts?.[0].password).toBe("encrypted-password");
    expect(hydrated.accounts?.[0].smtpToken).toBe("encrypted-token");
    expect(hydrated.connection?.password).toBe("encrypted-password");
    expect(hydrated.connection?.smtpToken).toBe("encrypted-token");
    expect(readers.loadAccount).not.toHaveBeenCalled();
  });

  it("treats an encrypted empty active-account password as authoritative", async () => {
    const readers = {
      loadLegacy: vi.fn(async () => ({ password: "legacy-stale", smtpToken: "" })),
      loadAccount: vi.fn(async () => ({ password: "account-stale", smtpToken: "" })),
    };
    const hydrated = await hydrateBridgeConfigForE2E({
      accounts: [account({
        password: "plaintext-stale",
        passwordEncrypted: CredentialEncryption.encrypt(""),
      })],
      activeAccountId: "primary",
    }, readers);

    expect(hydrated.accounts?.[0].password).toBe("");
    expect(hydrated.connection?.password).toBe("");
  });

  it("fails closed on a tampered encrypted active-account password", async () => {
    const encrypted = CredentialEncryption.encrypt("authentic-password");
    const tampered = {
      ...encrypted,
      authTag: `${encrypted.authTag[0] === "A" ? "B" : "A"}${encrypted.authTag.slice(1)}`,
    };
    await expect(hydrateBridgeConfigForE2E({
      accounts: [account({ password: "plaintext-stale", passwordEncrypted: tampered })],
      activeAccountId: "primary",
    }, {
      loadLegacy: async () => ({ password: "legacy-stale", smtpToken: "" }),
      loadAccount: async () => ({ password: "account-stale", smtpToken: "" }),
    })).rejects.toThrow(/authenticated decryption/i);
  });

  it("refuses keychain hydration while mailbox credentials are quarantined", async () => {
    const readers = {
      loadLegacy: vi.fn(async () => null),
      loadAccount: vi.fn(async () => null),
    };
    await expect(hydrateBridgeConfigForE2E({
      connection: { imapHost: "localhost", imapPort: 1143, username: "owner@proton.test", password: "" },
      accounts: [account()],
      keychainMailboxCredentialsQuarantined: true,
    }, readers)).rejects.toThrow(/quarantined/i);
    expect(readers.loadLegacy).not.toHaveBeenCalled();
    expect(readers.loadAccount).not.toHaveBeenCalled();
  });

  it("builds an encrypted single-account child config without auxiliary secrets", () => {
    const source = {
      connection: {
        imapHost: "localhost",
        imapPort: 1143,
        username: "owner@proton.test",
        password: "mailbox-secret",
        smtpToken: "smtp-secret",
        passAccessToken: "pass-secret",
        simpleloginApiKey: "alias-secret",
        remoteBearerToken: "remote-secret",
        remoteOauthAdminPassword: "admin-secret",
        autoStartBridge: true,
        bridgePath: "/operator/proton-bridge",
      } as never,
      accounts: [account({ password: "mailbox-secret" })],
      activeAccountId: "primary",
      permissions: buildPermissions("read_only"),
      webhooks: [{ url: "https://example.test/hook", secret: "webhook-secret" }],
    };
    const child = buildBridgeChildConfig(source, {
      imapHost: "localhost",
      imapPort: 1143,
      username: "owner@proton.test",
      password: "mailbox-secret",
    });

    expect(child.accounts).toBeUndefined();
    expect(child.activeAccountId).toBeUndefined();
    expect(child.webhooks).toBeUndefined();
    expect(child.keychainMailboxCredentialsQuarantined).toBe(true);
    expect(child.keychainAuxiliaryCredentialsQuarantined).toEqual({
      passAccessToken: true,
      simpleloginApiKey: true,
    });
    expect(child.credentialStorage).toBe("encrypted-file");
    expect(child.permissions).toEqual(buildPermissions("full"));
    expect(source.permissions).toEqual(buildPermissions("read_only"));
    expect(child.connection).toMatchObject({
      password: "",
      smtpToken: "",
      passAccessToken: "",
      simpleloginApiKey: "",
      remoteBearerToken: "",
      remoteOauthAdminPassword: "",
      autoStartBridge: false,
    });
    expect(child.connection?.bridgePath).toBeUndefined();
    expect(CredentialEncryption.decrypt(child.connection!.passwordEncrypted as never)).toBe("mailbox-secret");
    expect(CredentialEncryption.decrypt(child.connection!.smtpTokenEncrypted as never)).toBe("smtp-secret");
    expect(JSON.stringify(child)).not.toContain("pass-secret");
    expect(JSON.stringify(child)).not.toContain("remote-secret");
    expect(JSON.stringify(child)).not.toContain("webhook-secret");
  });

  it("strips disposable transport overrides from the live Bridge child", () => {
    const env = buildE2EChildEnv({
      MAILPOUCH_INSECURE_BRIDGE: "1",
      MAILPOUCH_SMTP_ALLOW_PLAINTEXT: "1",
      MAILPOUCH_SMTP_FROM: "attacker@example.test",
      MAILPOUCH_E2E_SIMPLELOGIN: "1",
      MAILPOUCH_E2E_PASS: "1",
      MAILPOUCH_E2E_REARM_RESCUE_COPY: TOKEN,
      MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE: "ab".repeat(32),
      MAILPOUCH_SCHEDULER_STORE: "/home/test/operator-scheduler.json",
      GH_TOKEN: "github-secret",
      AWS_ACCESS_KEY_ID: "aws-secret",
      DATABASE_PASSWORD: "database-secret",
      SSH_AUTH_SOCK: "/tmp/operator-agent.sock",
      MAILPOUCH_MACHINE_SECRET: "required-decryption-secret",
      KEEP_ME: "yes",
    }, "bridge", "/tmp/config.json", "/tmp/agents.json", TOKEN);

    expect(env).toMatchObject({
      KEEP_ME: "yes",
      MAILPOUCH_MACHINE_SECRET: "required-decryption-secret",
      MAILPOUCH_CONFIG: "/tmp/config.json",
      MAILPOUCH_AGENTS: "/tmp/agents.json",
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
      MAILPOUCH_FORCE_STDIO: "1",
    });
    expect(env.MAILPOUCH_INSECURE_BRIDGE).toBeUndefined();
    expect(env.MAILPOUCH_SMTP_ALLOW_PLAINTEXT).toBeUndefined();
    expect(env.MAILPOUCH_SMTP_FROM).toBeUndefined();
    expect(env.MAILPOUCH_E2E_SIMPLELOGIN).toBeUndefined();
    expect(env.MAILPOUCH_E2E_PASS).toBeUndefined();
    expect(env.MAILPOUCH_E2E_REARM_RESCUE_COPY).toBeUndefined();
    expect(env.MAILPOUCH_E2E_REARM_RESCUE_COPY_NONCE).toBeUndefined();
    expect(env.MAILPOUCH_E2E_CREDENTIAL_TOKEN).toBeUndefined();
    expect(env.GH_TOKEN).toBeUndefined();
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.DATABASE_PASSWORD).toBeUndefined();
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.MAILPOUCH_SCHEDULER_STORE).toContain(`.mailpouch-e2e-state-${TOKEN}`);
    expect(env.MAILPOUCH_SCHEDULER_STORE).not.toContain("operator-scheduler");
  });

  it("isolates Greenmail credentials and runtime state without enabling the live-mail fence", () => {
    const env = buildE2EChildEnv({
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
      MAILPOUCH_AGENT_AUDIT: "/home/test/operator-audit.jsonl",
      KEEP_ME: "yes",
    }, "greenmail", `/tmp/.mailpouch-e2e-greenmail-${TOKEN}.json`, "/tmp/agents.json", undefined, undefined, TOKEN);

    expect(env.KEEP_ME).toBe("yes");
    expect(env.MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS).toBe("1");
    expect(env.MAILPOUCH_E2E_CREDENTIAL_TOKEN).toBe(TOKEN);
    expect(env.MAILPOUCH_E2E_RUN_TOKEN).toBeUndefined();
    expect(env.MAILPOUCH_AGENT_AUDIT).toContain(`.mailpouch-e2e-state-${TOKEN}`);
    expect(env.MAILPOUCH_AGENT_AUDIT).not.toContain("operator-audit");
    expect(env.MAILPOUCH_FORCE_STDIO).toBe("1");
  });
});
