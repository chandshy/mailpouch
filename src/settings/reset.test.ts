import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerConfig } from "../config/schema.js";

const mocks = vi.hoisted(() => ({
  config: null as ServerConfig | null,
  saveConfig: vi.fn(),
  withConfigWriteLockAsync: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  deleteCredentials: vi.fn(),
  deleteAccountCredentials: vi.fn(),
  deleteAuxiliaryCredentials: vi.fn(),
  deleteRemoteSecrets: vi.fn(),
}));

vi.mock("../config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...actual,
    loadConfig: () => mocks.config,
    saveConfig: (config: ServerConfig) => {
      mocks.saveConfig(config);
      mocks.config = structuredClone(config);
    },
    withConfigWriteLockAsync: mocks.withConfigWriteLockAsync,
  };
});

vi.mock("../security/keychain.js", () => ({
  deleteCredentials: mocks.deleteCredentials,
  deleteAccountCredentials: mocks.deleteAccountCredentials,
  deleteAuxiliaryCredentials: mocks.deleteAuxiliaryCredentials,
  deleteRemoteSecrets: mocks.deleteRemoteSecrets,
}));

import { defaultConfig } from "../config/loader.js";
import { resetConfiguration } from "./reset.js";

function configuredMailbox(): ServerConfig {
  const config = defaultConfig();
  config.accounts = [
    {
      id: "personal",
      name: "Personal",
      providerType: "imap",
      smtpHost: "smtp.personal.example.test",
      smtpPort: 587,
      imapHost: "imap.personal.example.test",
      imapPort: 993,
      username: "personal@example.test",
      password: "password-a",
      smtpToken: "token-a",
    },
    {
      id: "work",
      name: "Work",
      providerType: "imap",
      smtpHost: "smtp.work.example.test",
      smtpPort: 587,
      imapHost: "imap.work.example.test",
      imapPort: 993,
      username: "work@example.test",
      password: "password-b",
      smtpToken: "token-b",
    },
  ];
  config.activeAccountId = "work";
  config.connection = {
    ...config.connection,
    password: "legacy-password",
    smtpToken: "legacy-token",
    remoteBearerToken: "remote-bearer",
    remoteOauthAdminPassword: "remote-admin",
    passAccessToken: "pass-token",
    simpleloginApiKey: "simplelogin-token",
  };
  return config;
}

describe("resetConfiguration", () => {
  beforeEach(() => {
    mocks.config = configuredMailbox();
    mocks.saveConfig.mockReset();
    mocks.withConfigWriteLockAsync.mockClear();
    mocks.deleteCredentials.mockReset();
    mocks.deleteCredentials.mockResolvedValue(true);
    mocks.deleteAccountCredentials.mockReset();
    mocks.deleteAccountCredentials.mockResolvedValue(true);
    mocks.deleteAuxiliaryCredentials.mockReset();
    mocks.deleteAuxiliaryCredentials.mockResolvedValue(true);
    mocks.deleteRemoteSecrets.mockReset();
    mocks.deleteRemoteSecrets.mockResolvedValue(true);
  });

  it("atomically resets config after targeting legacy, account, integration, and remote secrets", async () => {
    // A later verified reset is the explicit recovery path for a prior
    // failed-reset quarantine.
    mocks.config!.keychainMailboxCredentialsQuarantined = true;
    const result = await resetConfiguration();

    expect(mocks.withConfigWriteLockAsync).toHaveBeenCalledTimes(1);
    expect(mocks.deleteCredentials).toHaveBeenCalledTimes(1);
    // `primary` is included to clean up credentials left by a migration from
    // the legacy single-account layout even when accounts[] now exists.
    expect(mocks.deleteAccountCredentials).toHaveBeenCalledTimes(3);
    expect(mocks.deleteAccountCredentials).toHaveBeenCalledWith("primary");
    expect(mocks.deleteAccountCredentials).toHaveBeenCalledWith("personal");
    expect(mocks.deleteAccountCredentials).toHaveBeenCalledWith("work");
    expect(mocks.deleteAuxiliaryCredentials).toHaveBeenCalledWith({
      passAccessToken: true,
      simpleloginApiKey: true,
    });
    expect(mocks.deleteRemoteSecrets).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      credentialCleanup: {
        accountIds: ["primary", "personal", "work"],
        legacyCredentialsCleared: true,
        accountCredentialsCleared: true,
        auxiliaryCredentialsCleared: true,
        remoteSecretsCleared: true,
      },
      credentialsCleared: true,
      mailboxCredentialsCleared: true,
      keychainMailboxCredentialsQuarantined: false,
    });

    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    expect(mocks.config).toMatchObject({
      configResetGeneration: 1,
      connection: {
        username: "",
        password: "",
        smtpToken: "",
      },
      permissions: { preset: "read_only" },
    });
    expect(mocks.config?.accounts).toBeUndefined();
    expect(mocks.config?.activeAccountId).toBeUndefined();
    expect(mocks.config?.keychainMailboxCredentialsQuarantined).toBeUndefined();
  });

  it("still performs the durable reset and reports an incomplete cleanup", async () => {
    mocks.config!.configResetGeneration = 7;
    mocks.deleteRemoteSecrets.mockResolvedValue(false);
    mocks.deleteAccountCredentials.mockImplementation(async (id: string) => id !== "work");

    const result = await resetConfiguration();

    expect(result.credentialsCleared).toBe(false);
    expect(result.credentialCleanup.accountCredentialsCleared).toBe(false);
    expect(result.credentialCleanup.remoteSecretsCleared).toBe(false);
    expect(result.mailboxCredentialsCleared).toBe(false);
    expect(result.keychainMailboxCredentialsQuarantined).toBe(true);
    expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    expect(mocks.config).toMatchObject({
      configResetGeneration: 8,
      connection: { password: "", smtpToken: "" },
      permissions: { preset: "read_only" },
      keychainMailboxCredentialsQuarantined: true,
    });
  });

  it("durably quarantines both auxiliary entries when reset cannot verify their deletion", async () => {
    mocks.deleteAuxiliaryCredentials.mockResolvedValue(false);

    const result = await resetConfiguration();

    expect(result.credentialsCleared).toBe(false);
    expect(result.mailboxCredentialsCleared).toBe(true);
    expect(result.credentialCleanup.auxiliaryCredentialsCleared).toBe(false);
    expect(mocks.config?.keychainMailboxCredentialsQuarantined).toBeUndefined();
    expect(mocks.config?.keychainAuxiliaryCredentialsQuarantined).toEqual({
      passAccessToken: true,
      simpleloginApiKey: true,
    });
  });

  it("increments the reset generation on every reset instead of reusing one", async () => {
    mocks.config!.configResetGeneration = 4;

    await resetConfiguration();
    expect(mocks.config?.configResetGeneration).toBe(5);

    await resetConfiguration();
    expect(mocks.config?.configResetGeneration).toBe(6);
  });
});
