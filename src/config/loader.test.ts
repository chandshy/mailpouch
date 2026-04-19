import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { join } from "path";
import { homedir } from "os";
import { buildPermissions, defaultConfig, getConfigPath, configExists, loadConfig, saveConfig, loadCredentialsFromKeychain, saveConfigWithCredentials, migrateCredentials } from "./loader.js";
import { ALL_TOOLS, TOOL_CATEGORIES, DEFAULT_RESPONSE_LIMITS } from "./schema.js";

// ─── fs mocking for loadConfig / saveConfig / configExists ─────────────────────
vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    appendFile: vi.fn((_path: string, _data: string, _enc: string, cb: () => void) => cb()),
  };
});

// ─── keychain mocking ──────────────────────────────────────────────────────────
vi.mock("../security/keychain.js", () => ({
  isKeychainAvailable: vi.fn(),
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  migrateFromConfig: vi.fn(),
}));

import { loadCredentials as mockLoadKeychainCredentials, saveCredentials as mockSaveKeychainCredentials, migrateFromConfig as mockMigrateFromConfig } from "../security/keychain.js";

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

    it("rate-limits deletion tools to 5", () => {
      for (const tool of TOOL_CATEGORIES.deletion.tools) {
        expect(perms.tools[tool].rateLimit).toBe(5);
      }
    });

    it("rate-limits sending tools to 20", () => {
      for (const tool of TOOL_CATEGORIES.sending.tools) {
        expect(perms.tools[tool].rateLimit).toBe(20);
      }
    });

    it("rate-limits bulk action tools to 10", () => {
      const bulkActions = TOOL_CATEGORIES.actions.tools.filter((t) =>
        t.startsWith("bulk_"),
      );
      expect(bulkActions.length).toBeGreaterThan(0);
      for (const tool of bulkActions) {
        expect(perms.tools[tool].rateLimit).toBe(10);
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

  it("drops invalid settingsPort (string / out-of-range / non-integer)", () => {
    mockedExistsSync.mockReturnValue(true);
    for (const badValue of ["8766", 0, 65536, 3.14, null]) {
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
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockedRenameSync).toHaveBeenCalledTimes(1);
  });

  it("writes valid JSON containing the config", () => {
    const cfg = defaultConfig();
    cfg.connection.username = "testuser";
    saveConfig(cfg);
    const [, payload] = mockedWriteFileSync.mock.calls[0] as [string, string];
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
});

// ─── saveConfigWithCredentials ─────────────────────────────────────────────────

describe("saveConfigWithCredentials", () => {
  const mockedSave = vi.mocked(mockSaveKeychainCredentials);
  const mockedWriteFileSync = vi.mocked(writeFileSync);
  const mockedRenameSync = vi.mocked(renameSync);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("stores credentials in keychain and blanks them in config file when keychain succeeds", async () => {
    mockedSave.mockResolvedValue(true);
    const cfg = defaultConfig();
    cfg.connection.password = "secret";
    cfg.connection.smtpToken = "token";
    const result = await saveConfigWithCredentials(cfg);
    expect(result).toBe("keychain");
    expect(cfg.connection.password).toBe("");
    expect(cfg.connection.smtpToken).toBe("");
    expect(cfg.credentialStorage).toBe("keychain");
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockedRenameSync).toHaveBeenCalledTimes(1);
  });

  it("falls back to config file when keychain save fails", async () => {
    mockedSave.mockResolvedValue(false);
    const cfg = defaultConfig();
    cfg.connection.password = "secret";
    const result = await saveConfigWithCredentials(cfg);
    expect(result).toBe("config");
    expect(cfg.credentialStorage).toBe("config");
    expect(mockedWriteFileSync).toHaveBeenCalledTimes(1);
    expect(mockedRenameSync).toHaveBeenCalledTimes(1);
  });
});

// ─── migrateCredentials ────────────────────────────────────────────────────────

describe("migrateCredentials", () => {
  const mockedMigrate = vi.mocked(mockMigrateFromConfig);
  const mockedExistsSync = vi.mocked(existsSync);
  const mockedReadFileSync = vi.mocked(readFileSync);

  beforeEach(() => {
    vi.resetAllMocks();
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
});
