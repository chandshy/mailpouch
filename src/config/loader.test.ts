import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { homedir } from "os";
import { buildPermissions, defaultConfig, getConfigPath, configExists, loadConfig, saveConfig, loadCredentialsFromConfigFile, loadCredentialsFromKeychain, loadAuxiliaryCredentialsFromKeychain, saveConfigWithCredentials, migrateCredentials } from "./loader.js";
import { ALL_TOOLS, TOOL_CATEGORIES, DEFAULT_RESPONSE_LIMITS } from "./schema.js";
import { CredentialEncryption } from "../crypto/credential-encryption.js";
import { logger } from "../utils/logger.js";

// ─── fs mocking for loadConfig / saveConfig / configExists ─────────────────────
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    statSync: vi.fn(),   // returns undefined by default → mtime check throws → cache invalidated
    // CRED-008 config-lock primitives: no-op in unit tests so the lock around
    // saveConfig doesn't touch the real home dir. Concurrency behavior is
    // covered by config-lock.test.ts against a real filesystem.
    mkdirSync: vi.fn(),
    rmdirSync: vi.fn(),
    openSync: vi.fn(() => 3),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    appendFile: vi.fn((_path: string, _data: string, _enc: string, cb: () => void) => cb()),
  };
});

// ─── keychain mocking ──────────────────────────────────────────────────────────
vi.mock("../security/keychain.js", () => ({
  isKeychainAvailable: vi.fn(),
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  loadAuxiliaryCredentials: vi.fn(),
  saveAuxiliaryCredentials: vi.fn(),
  loadRemoteSecrets: vi.fn(),
  deleteRemoteSecrets: vi.fn(),
  migrateFromConfig: vi.fn(),
}));

import { loadCredentials as mockLoadKeychainCredentials, saveCredentials as mockSaveKeychainCredentials, loadAuxiliaryCredentials as mockLoadAuxiliaryCredentials, saveAuxiliaryCredentials as mockSaveKeychainAuxCredentials, loadRemoteSecrets as mockLoadRemoteSecrets, deleteRemoteSecrets as mockDeleteRemoteSecrets, migrateFromConfig as mockMigrateFromConfig } from "../security/keychain.js";

// Import mocked fs functions for use in tests
import { existsSync, readFileSync, writeFileSync, renameSync } from "fs";

describe("buildPermissions", () => {
  describe("read_only", () => {
    const perms = buildPermissions("read_only");

    it("enables reading, analytics, and system tools", () => {
      for (const tool of TOOL_CATEGORIES.reading.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
      for (const tool of TOOL_CATEGORIES.analytics.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
      for (const tool of TOOL_CATEGORIES.system.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("enables get_folders", () => {
      expect(perms.tools.get_folders.enabled).toBe(true);
    });

    it("disables sending tools", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });

    it("disables deletion tools", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });

    it("disables actions tools (except those in allowed set)", () => {
      for (const tool of TOOL_CATEGORIES.actions.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });
  });

  describe("full", () => {
    const perms = buildPermissions("full");

    it("enables all tools", () => {
      for (const tool of ALL_TOOLS) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("has no rate limits on any tool", () => {
      for (const tool of ALL_TOOLS) {
        expect(perms.tools[tool].rateLimit).toBeNull();
      }
    });
  });

  describe("supervised", () => {
    const perms = buildPermissions("supervised");

    it("enables all tools", () => {
      for (const tool of ALL_TOOLS) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("rate-limits deletion tools to 20", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].rateLimit).toBe(20);
      }
    });

    it("rate-limits sending tools to 200", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].rateLimit).toBe(200);
      }
    });

    it("rate-limits bulk action tools to 100", () => {
      const bulkActions = TOOL_CATEGORIES.actions.tools.filter((t) =>
        t.startsWith("bulk_"),
      );
      expect(bulkActions.length).toBeGreaterThan(0);
      for (const tool of bulkActions) {
        expect(perms.tools[tool].rateLimit).toBe(100);
      }
    });
  });

  describe("send_only", () => {
    const perms = buildPermissions("send_only");

    it("enables sending tools", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("enables reading tools", () => {
      for (const tool of TOOL_CATEGORIES.reading.tools) {
        expect(perms.tools[tool].enabled).toBe(true);
      }
    });

    it("enables get_folders, get_connection_status, and get_logs", () => {
      expect(perms.tools.get_folders.enabled).toBe(true);
      expect(perms.tools.get_connection_status.enabled).toBe(true);
      expect(perms.tools.get_logs.enabled).toBe(true);
    });

    it("disables deletion tools", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });

    it("disables actions tools", () => {
      for (const tool of TOOL_CATEGORIES.actions.tools) {
        expect(perms.tools[tool].enabled).toBe(false);
      }
    });
  });
});

describe("defaultConfig", () => {
  const config = defaultConfig();

  it("uses read_only preset", () => {
    expect(config.permissions.preset).toBe("read_only");
  });

  it("has correct default SMTP port", () => {
    expect(config.connection.smtpPort).toBe(1025);
  });

  it("has correct default IMAP port", () => {
    expect(config.connection.imapPort).toBe(1143);
  });
});

describe("getConfigPath", () => {
  function withCleanEnv<T>(fn: () => T): T {
    const saved = process.env.MAILPOUCH_CONFIG;
    delete process.env.MAILPOUCH_CONFIG;
    try { return fn(); } finally {
      if (saved !== undefined) process.env.MAILPOUCH_CONFIG = saved;
      else delete process.env.MAILPOUCH_CONFIG;
    }
  }

  it("returns the ~/.mailpouch.json default when MAILPOUCH_CONFIG is unset", () => {
    withCleanEnv(() => {
      expect(getConfigPath()).toBe(join(homedir(), ".mailpouch.json"));
    });
  });

  it("respects MAILPOUCH_CONFIG env var when path is within home dir", () => {
    withCleanEnv(() => {
      const customPath = join(homedir(), "custom-mailpouch.json");
      process.env.MAILPOUCH_CONFIG = customPath;
      expect(getConfigPath()).toBe(customPath);
    });
  });

  it("throws when MAILPOUCH_CONFIG points outside home dir", () => {
    withCleanEnv(() => {
      process.env.MAILPOUCH_CONFIG = "/tmp/evil-config.json";
      expect(() => getConfigPath()).toThrow("must point to a path within the home directory");
    });
  });
});

// ─── configExists ──────────────────────────────────────────────────────────────

describe("configExists", () => {
  const mockedExistsSync = vi.mocked(existsSync);

  it("returns true when the config file exists", () => {
    mockedExistsSync.mockReturnValue(true);
    expect(configExists()).toBe(true);
  });

  it("returns false when the config file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(configExists()).toBe(false);
  });
});

// ─── loadConfig ────────────────────────────────────────────────────────────────

describe("loadConfig", () => {
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when the config file does not exist", () => {
    mockedExistsSync.mockReturnValue(false);
    expect(loadConfig()).toBeNull();
  });

  it("returns null when the config file contains invalid JSON", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("NOT JSON{{{" as unknown as Buffer);
    expect(loadConfig()).toBeNull();
  });

  it("returns a parsed ServerConfig for a valid minimal config file", () => {
    mockedExistsSync.mockReturnValue(true);
    const minimal = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143, username: "u", password: "p", smtpToken: "", bridgeCertPath: "", debug: false },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(minimal as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.permissions.preset).toBe("full");
    expect(cfg!.connection.smtpHost).toBe("localhost");
  });

  it("handles config file without configVersion, connection, or tools fields (undefined ?? fallbacks)", () => {
    mockedExistsSync.mockReturnValue(true);
    // Minimal config with no configVersion, no connection, no tools → exercises ?? fallbacks
    const sparse = JSON.stringify({
      permissions: { preset: "full" }, // no tools field → ?? {} fallback
      // no configVersion → ?? base fallback
      // no connection → ?? {} fallback
    });
    mockedReadFileSync.mockReturnValue(sparse as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    expect(cfg!.permissions.preset).toBe("full");
  });

  it("falls back to read_only preset when config has an unknown preset value", () => {
    mockedExistsSync.mockReturnValue(true);
    const malicious = JSON.stringify({
      configVersion: 1,
      connection: {},
      permissions: { preset: "superuser", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(malicious as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.permissions.preset).toBe("read_only");
  });

  it("filters out unknown tool names from config on disk", () => {
    mockedExistsSync.mockReturnValue(true);
    const withUnknown = JSON.stringify({
      configVersion: 1,
      connection: {},
      permissions: {
        preset: "full",
        tools: {
          get_emails: { enabled: true, rateLimit: null },
          __proto__: { enabled: true, rateLimit: null },
          evil_tool: { enabled: true, rateLimit: null },
        },
      },
    });
    mockedReadFileSync.mockReturnValue(withUnknown as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg).not.toBeNull();
    // Known tools are kept
    expect(cfg!.permissions.tools["get_emails"]).toBeDefined();
    // Unknown tools are stripped
    expect((cfg!.permissions.tools as Record<string, unknown>)["evil_tool"]).toBeUndefined();
  });

  it("migrates a legacy bulk_delete policy onto bulk_delete_emails", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 1,
      connection: {},
      permissions: {
        preset: "full",
        tools: { bulk_delete: { enabled: false, rateLimit: 7 } },
      },
    }) as unknown as Buffer);

    const cfg = loadConfig();
    expect(cfg!.permissions.tools.bulk_delete_emails).toMatchObject({ enabled: false, rateLimit: 7 });
    expect((cfg!.permissions.tools as Record<string, unknown>).bulk_delete).toBeUndefined();
  });

  it("clamps maxResponseBytes to [100_000, 1_048_576]", () => {
    mockedExistsSync.mockReturnValue(true);
    // Provide a value below the minimum
    const cfg1json = JSON.stringify({
      configVersion: 1, connection: {}, permissions: { preset: "full", tools: {} },
      responseLimits: { maxResponseBytes: 1, maxEmailBodyChars: 5000, maxEmailListResults: 10, maxAttachmentBytes: 500 },
    });
    mockedReadFileSync.mockReturnValue(cfg1json as unknown as Buffer);
    const cfg1 = loadConfig();
    expect(cfg1!.responseLimits!.maxResponseBytes).toBe(100_000);

    // Provide a value above the maximum
    const cfg2json = JSON.stringify({
      configVersion: 1, connection: {}, permissions: { preset: "full", tools: {} },
      responseLimits: { maxResponseBytes: 99_999_999, maxEmailBodyChars: 5000, maxEmailListResults: 10, maxAttachmentBytes: 500 },
    });
    mockedReadFileSync.mockReturnValue(cfg2json as unknown as Buffer);
    const cfg2 = loadConfig();
    expect(cfg2!.responseLimits!.maxResponseBytes).toBe(1_048_576);
  });

  it("clamps maxEmailListResults to [1, 200]", () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgjson = JSON.stringify({
      configVersion: 1, connection: {}, permissions: { preset: "full", tools: {} },
      responseLimits: { maxResponseBytes: 500000, maxEmailBodyChars: 5000, maxEmailListResults: 9999, maxAttachmentBytes: 500 },
    });
    mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.responseLimits!.maxEmailListResults).toBe(200);
  });

  it("clamps non-finite responseLimits values to the minimum", () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgjson = JSON.stringify({
      configVersion: 1, connection: {}, permissions: { preset: "full", tools: {} },
      responseLimits: { maxResponseBytes: null, maxEmailBodyChars: null, maxEmailListResults: null, maxAttachmentBytes: null },
    });
    mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
    const cfg = loadConfig();
    // clamp(null, min, max) → min because !isFinite(null) → !isFinite(0) is false actually
    // JSON null → 0 in number context; isFinite(0) is true, so clamp(0, 100000, ...) → 100000
    expect(cfg!.responseLimits!.maxResponseBytes).toBe(100_000);
  });

  it("grandfathers v1 configs without allowInsecureBridge into the legacy insecure mode", () => {
    mockedExistsSync.mockReturnValue(true);
    // v1 file: no cert, no explicit flag — legacy insecure Bridge behavior
    const v1 = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143, username: "u", password: "p", smtpToken: "", bridgeCertPath: "", debug: false },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(v1 as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.connection.allowInsecureBridge).toBe(true);
    // Loaded config is migrated to the current schema version
    expect(cfg!.configVersion).toBe(3);
  });

  it("does NOT grandfather v1 configs that already set allowInsecureBridge explicitly", () => {
    mockedExistsSync.mockReturnValue(true);
    const v1Explicit = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", imapHost: "localhost", bridgeCertPath: "", allowInsecureBridge: false },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(v1Explicit as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.connection.allowInsecureBridge).toBe(false);
  });

  it("does NOT grandfather v1 configs that already have a bridgeCertPath", () => {
    mockedExistsSync.mockReturnValue(true);
    const v1WithCert = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", imapHost: "localhost", bridgeCertPath: "/path/to/cert.pem" },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(v1WithCert as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.connection.allowInsecureBridge).toBe(false);
  });

  it("defaults requireDestructiveConfirm to true when the field is absent on disk", () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgjson = JSON.stringify({
      configVersion: 2,
      connection: {},
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.requireDestructiveConfirm).toBe(true);
  });

  it("preserves an explicit requireDestructiveConfirm: false from disk", () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgjson = JSON.stringify({
      configVersion: 2,
      connection: {},
      permissions: { preset: "full", tools: {} },
      requireDestructiveConfirm: false,
    });
    mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.requireDestructiveConfirm).toBe(false);
  });

  it("loads tosAcknowledged when present on disk", () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgjson = JSON.stringify({
      configVersion: 2,
      connection: {},
      permissions: { preset: "full", tools: {} },
      tosAcknowledged: { accepted: true, timestamp: "2026-04-17T00:00:00Z" },
    });
    mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.tosAcknowledged).toEqual({ accepted: true, timestamp: "2026-04-17T00:00:00Z" });
  });

  it("preserves settingsPort across load so the UI doesn't revert to 8765", () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgjson = JSON.stringify({
      configVersion: 2,
      connection: {},
      permissions: { preset: "full", tools: {} },
      settingsPort: 8766,
    });
    mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
    const cfg = loadConfig();
    expect(cfg!.settingsPort).toBe(8766);
  });

  it("preserves a valid configResetGeneration across a disk load", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 3,
      configResetGeneration: 12,
      connection: {},
      permissions: { preset: "read_only", tools: {} },
    }) as unknown as Buffer);

    expect(loadConfig()!.configResetGeneration).toBe(12);
  });

  it("preserves only valid per-secret auxiliary keychain quarantines", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 3,
      connection: {},
      permissions: { preset: "read_only", tools: {} },
      keychainAuxiliaryCredentialsQuarantined: {
        passAccessToken: true,
        simpleloginApiKey: "yes",
        unknown: true,
      },
    }) as unknown as Buffer);

    expect(loadConfig()!.keychainAuxiliaryCredentialsQuarantined).toEqual({
      passAccessToken: true,
    });
  });

  it("fails closed to generation zero for malformed configResetGeneration values", () => {
    mockedExistsSync.mockReturnValue(true);
    for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, "4", null]) {
      mockedReadFileSync.mockReturnValue(JSON.stringify({
        configVersion: 3,
        configResetGeneration: value,
        connection: {},
        permissions: { preset: "read_only", tools: {} },
      }) as unknown as Buffer);
      expect(loadConfig()!.configResetGeneration).toBe(0);
    }
  });

  it("drops invalid settingsPort (string / out-of-range / null / NaN)", () => {
    mockedExistsSync.mockReturnValue(true);
    for (const badValue of ["8766", 0, 65536, null, Number.NaN]) {
      const cfgjson = JSON.stringify({
        configVersion: 2,
        connection: {},
        permissions: { preset: "full", tools: {} },
        settingsPort: badValue,
      });
      mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
      const cfg = loadConfig();
      expect(cfg!.settingsPort).toBeUndefined();
    }
  });

  it("rounds non-integer settingsPort (matches POST /api/config behavior)", () => {
    mockedExistsSync.mockReturnValue(true);
    // 8766.5 → Math.round → 8767; 8765.4 → 8765. Symmetric with the write path.
    const cases: [number, number][] = [[8766.5, 8767], [8765.4, 8765], [3.9, 4]];
    for (const [input, expected] of cases) {
      const cfgjson = JSON.stringify({
        configVersion: 2,
        connection: {},
        permissions: { preset: "full", tools: {} },
        settingsPort: input,
      });
      mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
      const cfg = loadConfig();
      expect(cfg!.settingsPort).toBe(expected);
    }
  });

  it("preserves credentialStorage across load so the UI badge stays accurate", () => {
    mockedExistsSync.mockReturnValue(true);
    for (const value of ["keychain", "config"] as const) {
      const cfgjson = JSON.stringify({
        configVersion: 2,
        connection: {},
        permissions: { preset: "full", tools: {} },
        credentialStorage: value,
      });
      mockedReadFileSync.mockReturnValue(cfgjson as unknown as Buffer);
      const cfg = loadConfig();
      expect(cfg!.credentialStorage).toBe(value);
    }
  });

  it("reports config storage when plaintext auxiliary or account credentials coexist with encryption", () => {
    process.env.MAILPOUCH_MACHINE_SECRET = "test-machine-secret-deterministic";
    mockedExistsSync.mockReturnValue(true);
    const encrypted = CredentialEncryption.encrypt("encrypted-password");
    const cases = [
      {
        connection: { passwordEncrypted: encrypted, passAccessToken: "plaintext-pass-token" },
      },
      {
        connection: { passwordEncrypted: encrypted },
        accounts: [{ id: "a", password: "plaintext-account-password" }],
      },
    ];
    for (const extra of cases) {
      mockedReadFileSync.mockReturnValue(JSON.stringify({
        configVersion: 3,
        permissions: { preset: "read_only", tools: {} },
        credentialStorage: "keychain",
        ...extra,
      }) as unknown as Buffer);
      expect(loadConfig()!.credentialStorage).toBe("config");
    }
  });
});

// ─── saveConfig ────────────────────────────────────────────────────────────────

describe("saveConfig", () => {
  const mockedWriteFileSync = vi.mocked(writeFileSync);
  const mockedRenameSync = vi.mocked(renameSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("calls writeFileSync and renameSync to perform an atomic write", () => {
    const cfg = defaultConfig();
    saveConfig(cfg);
    // The lock ownership record is written through a numeric fd; the adjacent
    // config temp file is the one path-targeted write this assertion covers.
    const configWrites = mockedWriteFileSync.mock.calls.filter(([target]) => typeof target === "string");
    expect(configWrites).toHaveLength(1);
    expect(mockedRenameSync).toHaveBeenCalledTimes(1);
  });

  it("writes valid JSON containing the config", () => {
    const cfg = defaultConfig();
    cfg.connection.username = "testuser";
    saveConfig(cfg);
    const [, payload] = mockedWriteFileSync.mock.calls.find(([target]) => typeof target === "string")! as [string, string];
    const parsed = JSON.parse(payload);
    expect(parsed.connection.username).toBe("testuser");
  });
});

// ─── loadCredentialsFromKeychain ───────────────────────────────────────────────

describe("loadCredentialsFromKeychain", () => {
  const mockedLoad = vi.mocked(mockLoadKeychainCredentials);
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns keychain credentials when keychain has password", async () => {
    mockedLoad.mockResolvedValue({ password: "kc-pass", smtpToken: "kc-token" });
    const result = await loadCredentialsFromKeychain();
    expect(result).toEqual({ password: "kc-pass", smtpToken: "kc-token", storage: "keychain" });
  });

  it("merges a keychain password with the newer encrypted fallback for a failed SMTP write", async () => {
    process.env.MAILPOUCH_MACHINE_SECRET = "test-machine-secret-deterministic";
    mockedLoad.mockResolvedValue({ password: "new-keychain-pass", smtpToken: "stale-keychain-token" });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 3,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u", password: "", smtpToken: "",
        smtpTokenEncrypted: CredentialEncryption.encrypt("new-fallback-token"),
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    }) as unknown as Buffer);

    expect(await loadCredentialsFromKeychain()).toEqual({
      password: "new-keychain-pass",
      smtpToken: "new-fallback-token",
      storage: "encrypted-file",
    });
  });

  it("prefers a retained plaintext field over its stale keychain entry after partial migration", async () => {
    mockedLoad.mockResolvedValue({ password: "new-keychain-pass", smtpToken: "stale-keychain-token" });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 3,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u", password: "", smtpToken: "new-config-token",
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    }) as unknown as Buffer);

    expect(await loadCredentialsFromKeychain()).toEqual({
      password: "new-keychain-pass",
      smtpToken: "new-config-token",
      storage: "config",
    });
  });

  it("does not rehydrate a stale legacy keychain credential after reset quarantined it", async () => {
    mockedLoad.mockResolvedValue({ password: "stale-keychain-password", smtpToken: "stale-keychain-token" });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 3,
      keychainMailboxCredentialsQuarantined: true,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "", password: "", smtpToken: "", bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "read_only", tools: {} },
    }) as unknown as Buffer);

    const result = await loadCredentialsFromKeychain();

    expect(mockedLoad).not.toHaveBeenCalled();
    expect(result).toBeNull();
  });

  it("config-file-only loading never reads the OS keychain even without a quarantine marker", async () => {
    process.env.MAILPOUCH_MACHINE_SECRET = "test-machine-secret-deterministic";
    mockedLoad.mockResolvedValue({ password: "operator-password", smtpToken: "operator-token" });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 3,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "e2e@example.test", password: "", smtpToken: "",
        passwordEncrypted: CredentialEncryption.encrypt("clone-password"),
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    }) as unknown as Buffer);

    await expect(loadCredentialsFromConfigFile()).resolves.toEqual({
      password: "clone-password",
      smtpToken: "",
      storage: "encrypted-file",
    });
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("falls back to config file when keychain returns empty credentials", async () => {
    mockedLoad.mockResolvedValue({ password: "", smtpToken: "" });
    mockedExistsSync.mockReturnValue(true);
    const cfgJson = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143, username: "u", password: "cfg-pass", smtpToken: "cfg-token", bridgeCertPath: "", debug: false },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgJson as unknown as Buffer);
    const result = await loadCredentialsFromKeychain();
    expect(result).toEqual({ password: "cfg-pass", smtpToken: "cfg-token", storage: "config" });
  });

  it("falls back to config with smtpToken only (password empty — || smtpToken branch)", async () => {
    mockedLoad.mockResolvedValue({ password: "", smtpToken: "" });
    mockedExistsSync.mockReturnValue(true);
    const cfgJson = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143, username: "u", password: "", smtpToken: "smtp-only", bridgeCertPath: "", debug: false },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgJson as unknown as Buffer);
    const result = await loadCredentialsFromKeychain();
    expect(result).toEqual({ password: "", smtpToken: "smtp-only", storage: "config" });
  });

  it("returns null when both keychain and config have no credentials", async () => {
    mockedLoad.mockResolvedValue({ password: "", smtpToken: "" });
    mockedExistsSync.mockReturnValue(false);
    const result = await loadCredentialsFromKeychain();
    expect(result).toBeNull();
  });

  // ─── CRED-010 (audit 2026-05-28): fail-closed on decrypt failure ─────────

  it("refuses to fall through to plaintext when a valid-shaped encrypted blob fails to decrypt (CRED-010)", async () => {
    process.env.MAILPOUCH_MACHINE_SECRET = "test-machine-secret-deterministic";
    mockedLoad.mockResolvedValue({ password: "", smtpToken: "" });
    mockedExistsSync.mockReturnValue(true);

    // Produce a real, valid-shaped v3 blob, then tamper the ciphertext so the
    // GCM tag no longer authenticates — isValidEncrypted stays true (16-byte
    // tag, salt present) but decrypt() throws.
    const good = CredentialEncryption.encrypt("the-real-password");
    const buf = Buffer.from(good.encryptedData, "base64");
    buf[0] ^= 0xff;
    const tampered = { ...good, encryptedData: buf.toString("base64") };
    expect(CredentialEncryption.isValidEncrypted(tampered)).toBe(true);

    const cfgJson = JSON.stringify({
      configVersion: 1,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u",
        // Attacker-injected plaintext coexisting with a failed-auth blob.
        password: "attacker-known-string", smtpToken: "",
        passwordEncrypted: tampered,
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgJson as unknown as Buffer);

    const result = await loadCredentialsFromKeychain();
    // Fail closed — never serve the coexisting plaintext from the same file.
    // A DISTINCT "decrypt-failed" sentinel is returned (not null and not the
    // plaintext) so the caller can tell tamper apart from "no credentials" and
    // refuse the plaintext fallback explicitly (see index.ts).
    expect(result).not.toBeNull();
    expect(result?.storage).toBe("decrypt-failed");
    expect(result?.password).toBe("");
    expect(result?.smtpToken).toBe("");
    expect(result?.password).not.toBe("attacker-known-string");
  });

  it("still serves valid encrypted-file credentials when decrypt succeeds (no regression)", async () => {
    process.env.MAILPOUCH_MACHINE_SECRET = "test-machine-secret-deterministic";
    mockedLoad.mockResolvedValue({ password: "", smtpToken: "" });
    mockedExistsSync.mockReturnValue(true);

    const enc = CredentialEncryption.encrypt("decryptable-secret");
    const cfgJson = JSON.stringify({
      configVersion: 1,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u", password: "", smtpToken: "",
        passwordEncrypted: enc,
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgJson as unknown as Buffer);

    const result = await loadCredentialsFromKeychain();
    expect(result).toEqual({ password: "decryptable-secret", smtpToken: "", storage: "encrypted-file" });
  });
});

describe("loadAuxiliaryCredentialsFromKeychain", () => {
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);
  const mockedLoadAuxiliary = vi.mocked(mockLoadAuxiliaryCredentials);

  beforeEach(() => {
    vi.resetAllMocks();
    mockedExistsSync.mockReturnValue(true);
  });

  function configWith(connection: Record<string, unknown>, quarantine?: Record<string, unknown>): string {
    return JSON.stringify({
      configVersion: 3,
      connection,
      permissions: { preset: "read_only", tools: {} },
      ...(quarantine ? { keychainAuxiliaryCredentialsQuarantined: quarantine } : {}),
    });
  }

  it("merges a keychain Pass token with a config-backed SimpleLogin key", async () => {
    mockedLoadAuxiliary.mockResolvedValue({ passAccessToken: "pass-keychain", simpleloginApiKey: "" });
    mockedReadFileSync.mockReturnValue(configWith({ simpleloginApiKey: "sl-config" }) as unknown as Buffer);

    expect(await loadAuxiliaryCredentialsFromKeychain()).toEqual({
      passAccessToken: "pass-keychain",
      simpleloginApiKey: "sl-config",
      storage: "keychain",
    });
  });

  it("keeps a newer config replacement ahead of a stale same-field keychain value", async () => {
    mockedLoadAuxiliary.mockResolvedValue({
      passAccessToken: "stale-pass-keychain",
      simpleloginApiKey: "stale-sl-keychain",
    });
    mockedReadFileSync.mockReturnValue(configWith({
      passAccessToken: "new-pass-config",
      simpleloginApiKey: "new-sl-config",
    }) as unknown as Buffer);

    expect(await loadAuxiliaryCredentialsFromKeychain()).toEqual({
      passAccessToken: "new-pass-config",
      simpleloginApiKey: "new-sl-config",
      storage: "config",
    });
  });

  it("suppresses only a quarantined secret across both durable stores", async () => {
    mockedLoadAuxiliary.mockResolvedValue({ passAccessToken: "stale-pass", simpleloginApiKey: "sl-keychain" });
    mockedReadFileSync.mockReturnValue(configWith(
      { passAccessToken: "pass-config", simpleloginApiKey: "sl-config" },
      { passAccessToken: true },
    ) as unknown as Buffer);

    expect(await loadAuxiliaryCredentialsFromKeychain()).toEqual({
      passAccessToken: "",
      simpleloginApiKey: "sl-config",
      storage: "config",
    });
  });
});

// ─── saveConfigWithCredentials ─────────────────────────────────────────────────

describe("saveConfigWithCredentials", () => {
  const mockedSave = vi.mocked(mockSaveKeychainCredentials);
  const mockedSaveAuxiliary = vi.mocked(mockSaveKeychainAuxCredentials);
  const mockedWriteFileSync = vi.mocked(writeFileSync);
  const mockedRenameSync = vi.mocked(renameSync);

  beforeEach(() => {
    vi.resetAllMocks();
    // Avoid having CredentialEncryption write a machine-id fallback file when
    // every fs call is mocked — supply the secret via env override so the
    // config-save assertions below filter out the lock ownership record.
    process.env.MAILPOUCH_MACHINE_SECRET = "test-machine-secret-deterministic";
  });

  it("stores credentials in keychain and blanks them in config file when keychain succeeds", async () => {
    mockedSave.mockResolvedValue({ passwordStored: true, smtpTokenStored: true });
    const cfg = defaultConfig();
    cfg.connection.password = "secret";
    cfg.connection.smtpToken = "token";
    const result = await saveConfigWithCredentials(cfg);
    expect(result).toBe("keychain");
    expect(cfg.connection.password).toBe("");
    expect(cfg.connection.smtpToken).toBe("");
    expect(cfg.credentialStorage).toBe("keychain");
    expect(mockedWriteFileSync.mock.calls.filter(([target]) => typeof target === "string")).toHaveLength(1);
    expect(mockedRenameSync).toHaveBeenCalledTimes(1);
  });

  it("encrypts to config file when keychain save fails", async () => {
    mockedSave.mockResolvedValue({ passwordStored: false, smtpTokenStored: false });
    const cfg = defaultConfig();
    cfg.connection.password = "secret";
    const result = await saveConfigWithCredentials(cfg);
    expect(result).toBe("encrypted-file");
    expect(cfg.credentialStorage).toBe("encrypted-file");
    // Plaintext blanked; encrypted blob present
    expect(cfg.connection.password).toBe("");
    expect(cfg.connection.passwordEncrypted).toBeDefined();
    expect(cfg.connection.passwordEncrypted?.algorithm).toBe("aes-256-gcm");
    expect(mockedWriteFileSync.mock.calls.filter(([target]) => typeof target === "string")).toHaveLength(1);
    expect(mockedRenameSync).toHaveBeenCalledTimes(1);
  });

  it("keeps a failed sibling authoritative in encrypted fallback after a partial keychain save", async () => {
    mockedSave.mockResolvedValue({ passwordStored: true, smtpTokenStored: false });
    const cfg = defaultConfig();
    cfg.connection.password = "new-password";
    cfg.connection.smtpToken = "new-token";

    const result = await saveConfigWithCredentials(cfg);

    expect(result).toBe("encrypted-file");
    expect(cfg.credentialStorage).toBe("encrypted-file");
    expect(cfg.connection.password).toBe("");
    expect(cfg.connection.passwordEncrypted).toBeUndefined();
    expect(cfg.connection.smtpToken).toBe("");
    expect(cfg.connection.smtpTokenEncrypted).toBeDefined();
    expect(CredentialEncryption.decrypt(cfg.connection.smtpTokenEncrypted!)).toBe("new-token");
  });

  it("reports config storage when an auxiliary keychain save fails and plaintext remains", async () => {
    mockedSave.mockResolvedValue({ passwordStored: true, smtpTokenStored: true });
    mockedSaveAuxiliary.mockResolvedValue(false);
    const cfg = defaultConfig();
    cfg.connection.password = "bridge-password";
    cfg.connection.passAccessToken = "plaintext-pass-token";

    const result = await saveConfigWithCredentials(cfg);

    expect(result).toBe("config");
    expect(cfg.credentialStorage).toBe("config");
    expect(cfg.connection.password).toBe("");
    expect(cfg.connection.passAccessToken).toBe("plaintext-pass-token");
  });
});

// ─── migrateCredentials ────────────────────────────────────────────────────────

describe("migrateCredentials", () => {
  const mockedMigrate = vi.mocked(mockMigrateFromConfig);
  const mockedLoadRemote = vi.mocked(mockLoadRemoteSecrets);
  const mockedDeleteRemote = vi.mocked(mockDeleteRemoteSecrets);
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
    mockedLoadRemote.mockResolvedValue(null);
  });

  it("returns false when no config file exists", async () => {
    mockedExistsSync.mockReturnValue(false);
    const result = await migrateCredentials();
    expect(result).toBe(false);
    expect(mockedMigrate).not.toHaveBeenCalled();
  });

  it("calls migrateFromConfig and returns its result when config file exists", async () => {
    mockedExistsSync.mockReturnValue(true);
    const cfgJson = JSON.stringify({
      configVersion: 1,
      connection: { smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143, username: "u", password: "p", smtpToken: "", bridgeCertPath: "", debug: false },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgJson as unknown as Buffer);
    mockedMigrate.mockResolvedValue(true);
    const result = await migrateCredentials();
    expect(result).toBe(true);
    expect(mockedMigrate).toHaveBeenCalledTimes(1);
  });

  it("scrubs deprecated remote credentials from config and keychain", async () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 1,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u", password: "", smtpToken: "",
        remoteBearerToken: "legacy-bearer",
        remoteOauthAdminPassword: "legacy-admin",
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    }) as unknown as Buffer);
    mockedLoadRemote.mockResolvedValue({
      remoteBearerToken: "keychain-bearer",
      remoteOauthAdminPassword: "keychain-admin",
    });
    mockedDeleteRemote.mockResolvedValue(true);

    expect(await migrateCredentials()).toBe(false);
    expect(mockedDeleteRemote).toHaveBeenCalledTimes(1);
    const configWrite = vi.mocked(writeFileSync).mock.calls.find(([target]) => typeof target === "string")!;
    const persisted = JSON.parse(configWrite[1] as string);
    expect(persisted.connection.remoteBearerToken).toBe("");
    expect(persisted.connection.remoteOauthAdminPassword).toBe("");
  });

  it("does not claim keychain deletion when deprecated secret cleanup fails", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(JSON.stringify({
      configVersion: 1,
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u", password: "", smtpToken: "",
        remoteBearerToken: "config-bearer", bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    }) as unknown as Buffer);
    mockedLoadRemote.mockResolvedValue({
      remoteBearerToken: "keychain-bearer",
      remoteOauthAdminPassword: "",
    });
    mockedDeleteRemote.mockResolvedValue(false);

    expect(await migrateCredentials()).toBe(false);
    expect(mockedDeleteRemote).toHaveBeenCalledTimes(1);
    const configWrite = vi.mocked(writeFileSync).mock.calls.find(([target]) => typeof target === "string")!;
    const persisted = JSON.parse(configWrite[1] as string);
    expect(persisted.connection.remoteBearerToken).toBe("");
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("deletion could not be verified"),
      "Config",
    );
  });

  // ── CRED-011 — v1→v2 re-encrypt is atomic across both credential fields ──
  it("CRED-011: does not save a half-migrated config when the second re-encrypt throws", async () => {
    mockedExistsSync.mockReturnValue(true);
    const blob = { algorithm: "aes-256-gcm", v: 1 } as unknown;
    const cfgJson = JSON.stringify({
      configVersion: 1,
      credentialStorage: "encrypted-file",
      connection: {
        smtpHost: "localhost", smtpPort: 1025, imapHost: "localhost", imapPort: 1143,
        username: "u", password: "", smtpToken: "",
        passwordEncrypted: blob, smtpTokenEncrypted: blob,
        bridgeCertPath: "", debug: false,
      },
      permissions: { preset: "full", tools: {} },
    });
    mockedReadFileSync.mockReturnValue(cfgJson as unknown as Buffer);

    vi.spyOn(CredentialEncryption, "isValidEncrypted").mockReturnValue(true);
    vi.spyOn(CredentialEncryption, "needsReencrypt").mockReturnValue(true);
    vi.spyOn(CredentialEncryption, "decrypt").mockReturnValue("plaintext");
    let calls = 0;
    vi.spyOn(CredentialEncryption, "encrypt").mockImplementation(() => {
      calls += 1;
      if (calls >= 2) throw new Error("boom on second encrypt");
      return { algorithm: "aes-256-gcm", v: 2 } as never;
    });
    const writeSpy = vi.mocked(writeFileSync);
    writeSpy.mockClear();

    const result = await migrateCredentials();
    expect(result).toBe(false);
    // Atomic: nothing persisted because the second field's encrypt failed.
    expect(writeSpy.mock.calls.filter(([target]) => typeof target === "string")).toHaveLength(0);
  });
});
