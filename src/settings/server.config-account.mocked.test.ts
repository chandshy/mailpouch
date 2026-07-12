import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { ServerConfig } from "../config/schema.js";

const mocks = vi.hoisted(() => ({
  config: null as ServerConfig | null,
  saveConfig: vi.fn(),
  withConfigWriteLockAsync: vi.fn(async <T>(fn: () => Promise<T>) => fn()),
  readRegistry: vi.fn(),
  updateAccount: vi.fn(),
  createAccount: vi.fn(),
  deleteAccount: vi.fn(),
  setActiveAccount: vi.fn(),
  saveAuxiliaryCredentials: vi.fn(),
  deleteAuxiliaryCredentials: vi.fn(),
  isKeychainAvailable: vi.fn(),
  refreshAuxiliaryServices: vi.fn(),
  disableAuxiliaryServices: vi.fn(),
  deleteCredentials: vi.fn(),
  deleteAccountCredentials: vi.fn(),
  deleteRemoteSecrets: vi.fn(),
  getPendingEscalations: vi.fn(),
  approveEscalation: vi.fn(),
  denyEscalation: vi.fn(),
  getAuditLog: vi.fn(),
  manager: null as {
    rebuildFromRegistryAsync: () => Promise<void>;
    rebuildFromRegistryWithoutKeychain: () => void;
    activeAccountId: () => string;
    connectAccount: (accountId: string) => Promise<void>;
  } | null,
}));

vi.mock("../config/loader.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../config/loader.js")>();
  return {
    ...actual,
    // Model an on-disk snapshot. In particular, concurrent settings-server
    // processes do not share a mutable loader-cache object, so each request
    // must be safe even when it began from its own stale clone.
    loadConfig: () => mocks.config ? structuredClone(mocks.config) : null,
    saveConfig: (config: ServerConfig) => {
      mocks.saveConfig(config);
      mocks.config = structuredClone(config);
    },
    configExists: () => true,
    getConfigPath: () => "/tmp/mailpouch-settings-test.json",
    withConfigWriteLockAsync: mocks.withConfigWriteLockAsync,
  };
});

vi.mock("../accounts/registry.js", () => ({
  readRegistry: mocks.readRegistry,
  updateAccount: mocks.updateAccount,
  createAccount: mocks.createAccount,
  deleteAccount: mocks.deleteAccount,
  setActiveAccount: mocks.setActiveAccount,
}));

vi.mock("../accounts/manager.js", () => ({
  getAccountManager: () => mocks.manager,
}));

vi.mock("../security/keychain.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../security/keychain.js")>();
  return {
    ...actual,
    saveAuxiliaryCredentials: mocks.saveAuxiliaryCredentials,
    deleteAuxiliaryCredentials: mocks.deleteAuxiliaryCredentials,
    isKeychainAvailable: mocks.isKeychainAvailable,
    deleteCredentials: mocks.deleteCredentials,
    deleteAccountCredentials: mocks.deleteAccountCredentials,
    deleteRemoteSecrets: mocks.deleteRemoteSecrets,
  };
});

vi.mock("../services/auxiliary-service-runtime.js", () => ({
  refreshAuxiliaryServices: mocks.refreshAuxiliaryServices,
  disableAuxiliaryServices: mocks.disableAuxiliaryServices,
}));

vi.mock("../permissions/escalation.js", () => ({
  getPendingEscalations: mocks.getPendingEscalations,
  approveEscalation: mocks.approveEscalation,
  denyEscalation: mocks.denyEscalation,
  getAuditLog: mocks.getAuditLog,
}));

import { defaultConfig } from "../config/loader.js";

let createSettingsServer: typeof import("./server.js").createSettingsServer;

beforeAll(async () => {
  ({ createSettingsServer } = await import("./server.js"));
});

function account(id: string, name: string) {
  return {
    id,
    name,
    providerType: "imap" as const,
    smtpHost: `${id}.smtp.example.test`,
    smtpPort: 587,
    imapHost: `${id}.imap.example.test`,
    imapPort: 993,
    username: `${id}@example.test`,
    password: "",
    smtpToken: undefined,
  };
}

function freshConfig(): ServerConfig {
  const config = defaultConfig();
  const accountA = account("account-a", "Mailbox A");
  const accountB = account("account-b", "Mailbox B");
  config.accounts = [accountA, accountB];
  config.activeAccountId = accountB.id;
  config.connection = {
    ...config.connection,
    smtpHost: accountB.smtpHost,
    smtpPort: accountB.smtpPort,
    imapHost: accountB.imapHost,
    imapPort: accountB.imapPort,
    username: accountB.username,
    password: "legacy-password-must-not-survive",
    smtpToken: "legacy-token-must-not-survive",
    debug: false,
  };
  return config;
}

beforeEach(() => {
  mocks.config = freshConfig();
  mocks.saveConfig.mockReset();
  // Tests that model a queued writer replace the implementation below. Reset
  // it here (rather than merely clearing call history) so that scheduling
  // state cannot leak into the next HTTP-server instance.
  mocks.withConfigWriteLockAsync.mockReset();
  mocks.withConfigWriteLockAsync.mockImplementation(async <T>(fn: () => Promise<T>) => fn());
  mocks.readRegistry.mockReset();
  mocks.readRegistry.mockImplementation(() => ({
    accounts: mocks.config!.accounts!,
    activeAccountId: mocks.config!.activeAccountId!,
  }));
  mocks.updateAccount.mockReset();
  mocks.updateAccount.mockImplementation(async (id: string, patch: Record<string, unknown>) => {
    const config = mocks.config!;
    const index = config.accounts!.findIndex(candidate => candidate.id === id);
    if (index < 0) return null;
    const updated = { ...config.accounts![index], ...patch, id };
    config.accounts![index] = updated;
    config.connection = {
      ...config.connection,
      smtpHost: updated.smtpHost,
      smtpPort: updated.smtpPort,
      imapHost: updated.imapHost,
      imapPort: updated.imapPort,
      username: updated.username,
      password: "",
      smtpToken: "",
      bridgeCertPath: updated.bridgeCertPath ?? "",
      allowInsecureBridge: updated.allowInsecureBridge,
      tlsMode: updated.tlsMode,
      autoStartBridge: updated.autoStartBridge,
      bridgePath: updated.bridgePath,
    };
    return updated;
  });
  mocks.createAccount.mockReset();
  mocks.deleteAccount.mockReset();
  mocks.setActiveAccount.mockReset();
  mocks.saveAuxiliaryCredentials.mockReset();
  mocks.saveAuxiliaryCredentials.mockResolvedValue(true);
  mocks.deleteAuxiliaryCredentials.mockReset();
  mocks.deleteAuxiliaryCredentials.mockResolvedValue(true);
  mocks.isKeychainAvailable.mockReset();
  mocks.isKeychainAvailable.mockResolvedValue(true);
  mocks.refreshAuxiliaryServices.mockReset();
  mocks.refreshAuxiliaryServices.mockResolvedValue(true);
  mocks.disableAuxiliaryServices.mockReset();
  mocks.disableAuxiliaryServices.mockResolvedValue(true);
  mocks.deleteCredentials.mockReset();
  mocks.deleteCredentials.mockResolvedValue(true);
  mocks.deleteAccountCredentials.mockReset();
  mocks.deleteAccountCredentials.mockResolvedValue(true);
  mocks.deleteRemoteSecrets.mockReset();
  mocks.deleteRemoteSecrets.mockResolvedValue(true);
  mocks.getPendingEscalations.mockReset();
  mocks.getPendingEscalations.mockReturnValue([]);
  mocks.approveEscalation.mockReset();
  mocks.approveEscalation.mockReturnValue({ ok: true, targetPreset: "full" });
  mocks.denyEscalation.mockReset();
  mocks.denyEscalation.mockReturnValue({ ok: true });
  mocks.getAuditLog.mockReset();
  mocks.getAuditLog.mockReturnValue([]);
  const rebuildFromRegistryAsync = vi.fn().mockResolvedValue(undefined);
  const rebuildFromRegistryWithoutKeychain = vi.fn();
  const connectAccount = vi.fn().mockResolvedValue(undefined);
  mocks.manager = {
    rebuildFromRegistryAsync,
    rebuildFromRegistryWithoutKeychain,
    activeAccountId: () => "account-b",
    connectAccount,
  };
});

function listen(server: http.Server): Promise<{ port: number; close: () => void }> {
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve({
    port: (server.address() as AddressInfo).port,
    close: () => server.close(),
  })));
}

function request(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, method, path, headers }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

async function csrfFrom(port: number): Promise<string> {
  const response = await request(port, "GET", "/");
  return /<meta name="csrf-token" content="([^"]+)">/.exec(response.body)![1];
}

async function saveConnection(port: number, csrf: string, connection: Record<string, unknown>) {
  const response = await request(port, "POST", "/api/config", {
    "x-csrf-token": csrf,
    origin: `http://127.0.0.1:${port}`,
    "content-type": "application/json",
  }, JSON.stringify({ connection }));
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

async function saveSettingsPatch(port: number, csrf: string, patch: Record<string, unknown>) {
  return postJson(port, "/api/config", csrf, patch);
}

async function postJson(
  port: number,
  path: string,
  csrf: string,
  body: Record<string, unknown>,
  opts: { includeOrigin?: boolean } = {},
) {
  const headers: Record<string, string> = {
    "x-csrf-token": csrf,
    "content-type": "application/json",
  };
  if (opts.includeOrigin !== false) headers.origin = `http://127.0.0.1:${port}`;
  const response = await request(port, "POST", path, headers, JSON.stringify(body));
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

async function readConfig(port: number): Promise<{ status: number; body: Record<string, unknown>; raw: string }> {
  const response = await request(port, "GET", "/api/config");
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown>, raw: response.body };
}

async function resetConfig(port: number, csrf: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await request(port, "POST", "/api/reset", {
    "x-csrf-token": csrf,
    origin: `http://127.0.0.1:${port}`,
  });
  return { status: response.status, body: JSON.parse(response.body) as Record<string, unknown> };
}

describe("POST /api/config account-scoped connection saves", () => {
  it("redacts fallback account and legacy remote credentials from GET /api/config", async () => {
    mocks.config!.accounts![0] = {
      ...mocks.config!.accounts![0],
      password: "account-password-secret",
      smtpToken: "account-smtp-token-secret",
    };
    mocks.config!.connection = {
      ...mocks.config!.connection,
      password: "legacy-password-secret",
      smtpToken: "legacy-smtp-token-secret",
      remoteBearerToken: "remote-bearer-secret",
      remoteOauthAdminPassword: "remote-admin-secret",
    };
    mocks.config!.webhooks = [{
      id: "grant-events",
      url: "https://hooks.example.test/events/opaque-webhook-url-secret?token=also-secret",
      secret: "webhook-signing-secret",
    }];
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await readConfig(port);
      expect(response.status).toBe(200);
      for (const secret of [
        "account-password-secret", "account-smtp-token-secret",
        "legacy-password-secret", "legacy-smtp-token-secret",
        "remote-bearer-secret", "remote-admin-secret", "webhook-signing-secret",
        "opaque-webhook-url-secret", "also-secret",
      ]) expect(response.raw).not.toContain(secret);
      const accounts = response.body.accounts as Array<Record<string, unknown>>;
      expect(accounts[0]).toMatchObject({ password: "••••••••", smtpToken: "••••••••" });
      const connection = response.body.connection as Record<string, unknown>;
      expect(connection.remoteBearerToken).toBe("••••••••");
      expect(connection.remoteOauthAdminPassword).toBe("••••••••");
      expect((response.body.webhooks as Array<Record<string, unknown>>)[0].secret).toBe("••••••••");
      expect((response.body.webhooks as Array<Record<string, unknown>>)[0].url).toBe("https://hooks.example.test/…");
    } finally {
      close();
    }
  });

  it("updates only the active registry account and never writes shared bridge credentials", async () => {
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveConnection(port, await csrfFrom(port), {
        smtpHost: "smtp.updated.example.test",
        smtpPort: 465,
        imapHost: "imap.updated.example.test",
        imapPort: 993,
        username: "updated@example.test",
        password: "account-b-password",
        smtpToken: "account-b-token",
        tlsMode: "ssl",
        simpleloginApiKey: "sl-new-key",
        passAccessToken: "pass-new-token",
      });
      expect(response.status).toBe(200);
      expect(mocks.updateAccount).toHaveBeenCalledWith("account-b", expect.objectContaining({
        password: "account-b-password",
        smtpToken: "account-b-token",
        smtpHost: "smtp.updated.example.test",
      }));
      expect(mocks.saveAuxiliaryCredentials).toHaveBeenCalledWith("pass-new-token", "sl-new-key");
      expect(mocks.refreshAuxiliaryServices).toHaveBeenCalledTimes(1);
      expect(mocks.refreshAuxiliaryServices.mock.invocationCallOrder[0])
        .toBeGreaterThan(mocks.saveConfig.mock.invocationCallOrder[0]);
      const saved = mocks.saveConfig.mock.lastCall![0] as ServerConfig;
      expect(saved.connection.password).toBe("");
      expect(saved.connection.smtpToken).toBe("");
      expect(saved.connection.passwordEncrypted).toBeUndefined();
      expect(saved.connection.smtpTokenEncrypted).toBeUndefined();
      expect(saved.connection.simpleloginApiKey).toBeUndefined();
      expect(saved.connection.passAccessToken).toBeUndefined();
      expect(mocks.manager!.rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(mocks.manager!.connectAccount).toHaveBeenCalledWith("account-b");
    } finally {
      close();
    }
  });

  it("retains undisclosed keychain-backed auxiliary secrets on an ordinary blank setup save", async () => {
    // Keychain-backed secrets are intentionally absent from GET /api/config,
    // so the normal browser form submits these fields as empty strings.
    mocks.config!.credentialStorage = "keychain";
    mocks.config!.connection = {
      ...mocks.config!.connection,
      simpleloginApiKey: "",
      passAccessToken: "",
    };
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveConnection(port, await csrfFrom(port), {
        simpleloginApiKey: "",
        passAccessToken: "",
      });
      expect(response.status).toBe(200);
      expect(mocks.deleteAuxiliaryCredentials).not.toHaveBeenCalled();
      expect(mocks.saveAuxiliaryCredentials).not.toHaveBeenCalled();
      expect(mocks.refreshAuxiliaryServices).not.toHaveBeenCalled();
      expect(mocks.saveConfig).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it("clears configuration-backed auxiliary secrets when no OS keychain is available", async () => {
    mocks.config!.credentialStorage = "config";
    mocks.config!.connection = {
      ...mocks.config!.connection,
      simpleloginApiKey: "simplelogin-config-secret",
      passAccessToken: "pass-config-secret",
    };
    mocks.deleteAuxiliaryCredentials.mockResolvedValue(false);
    mocks.isKeychainAvailable.mockResolvedValue(false);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveConnection(port, await csrfFrom(port), {
        simpleloginApiKey: "",
        passAccessToken: "",
        clearSimpleloginApiKey: true,
        clearPassAccessToken: true,
      });
      expect(response.status).toBe(200);
      expect(mocks.deleteAuxiliaryCredentials).toHaveBeenCalledWith({
        passAccessToken: true,
        simpleloginApiKey: true,
      });
      expect(mocks.isKeychainAvailable).toHaveBeenCalledTimes(1);
      const saved = mocks.saveConfig.mock.lastCall![0] as ServerConfig;
      expect(saved.connection.simpleloginApiKey).toBeUndefined();
      expect(saved.connection.passAccessToken).toBeUndefined();
      expect(mocks.refreshAuxiliaryServices).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it("fails an explicit auxiliary-secret clear when its keychain entry cannot be deleted", async () => {
    mocks.deleteAuxiliaryCredentials.mockResolvedValue(false);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveConnection(port, await csrfFrom(port), {
        simpleloginApiKey: "",
        passAccessToken: "",
        clearSimpleloginApiKey: true,
        clearPassAccessToken: true,
      });
      expect(response.status).toBe(503);
      expect(mocks.deleteAuxiliaryCredentials).toHaveBeenCalledWith({ passAccessToken: true, simpleloginApiKey: true });
      expect(mocks.updateAccount).not.toHaveBeenCalled();
      expect(mocks.saveConfig).not.toHaveBeenCalled();
      expect(mocks.refreshAuxiliaryServices).not.toHaveBeenCalled();
      // A keychain batch can remove one secret and still return false for the
      // other. The daemon must immediately drop both old in-memory clients
      // instead of leaving a partially-cleared credential usable until restart.
      expect(mocks.disableAuxiliaryServices).toHaveBeenCalledTimes(1);
      expect(mocks.manager!.rebuildFromRegistryAsync).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("refreshes live integrations after a successful auxiliary-secret clear", async () => {
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveConnection(port, await csrfFrom(port), {
        simpleloginApiKey: "",
        passAccessToken: "",
        clearSimpleloginApiKey: true,
        clearPassAccessToken: true,
      });
      expect(response.status).toBe(200);
      expect(mocks.deleteAuxiliaryCredentials).toHaveBeenCalledWith({ passAccessToken: true, simpleloginApiKey: true });
      expect(mocks.refreshAuxiliaryServices).toHaveBeenCalledTimes(1);
      expect(response.body.restartRequired).toBe(false);
    } finally {
      close();
    }
  });

  it("reports restartRequired when a base-url/CLI update has no live runtime to refresh", async () => {
    mocks.refreshAuxiliaryServices.mockResolvedValue(false);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveConnection(port, await csrfFrom(port), {
        simpleloginBaseUrl: "https://simplelogin.example.test",
        passCliPath: process.execPath,
      });
      expect(response.status).toBe(200);
      expect(mocks.refreshAuxiliaryServices).toHaveBeenCalledTimes(1);
      expect(response.body.restartRequired).toBe(true);
    } finally {
      close();
    }
  });

  it("rejects malformed per-tool permission policies instead of persisting raw objects", async () => {
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const response = await saveSettingsPatch(port, await csrfFrom(port), {
        permissions: {
          preset: "custom",
          tools: {
            send_email: { enabled: true, rateLimit: 1.5, rateLimitWindow: "hour" },
          },
        },
      });
      expect(response.status).toBe(400);
      expect(response.body.error).toContain("rateLimit");
      expect(mocks.saveConfig).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });
});

describe("POST /api/config read-modify-write ordering (SEC-CONFIG-RMW-001)", () => {
  it("rejects a full settings form loaded before reset instead of recreating its old mailbox and policy", async () => {
    mocks.config!.configResetGeneration = 0;
    mocks.config!.permissions = { ...mocks.config!.permissions, preset: "full" };
    mocks.config!.requireDestructiveConfirm = false;

    let saveReachedLock!: () => void;
    const saveAtLock = new Promise<void>(resolve => { saveReachedLock = resolve; });
    let releaseSave!: () => void;
    const saveMayEnter = new Promise<void>(resolve => { releaseSave = resolve; });
    let lockCall = 0;
    mocks.withConfigWriteLockAsync.mockImplementation(async <T>(fn: () => Promise<T>) => {
      if (lockCall++ === 0) {
        saveReachedLock();
        await saveMayEnter;
      }
      return fn();
    });

    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const csrf = await csrfFrom(port);
      const staleSave = saveSettingsPatch(port, csrf, {
        configResetGeneration: 0,
        connection: {
          username: "old@example.test",
          password: "old-password",
          smtpHost: "smtp.old.example.test",
          smtpPort: 587,
          imapHost: "imap.old.example.test",
          imapPort: 993,
          debug: true,
          autoStartBridge: true,
          allowInsecureBridge: true,
          tlsMode: "starttls",
        },
        requireDestructiveConfirm: false,
        desktopNotificationsEnabled: false,
        surfaceSecurityNotifications: true,
        autoOpenApprovalWindow: false,
        permissions: { preset: "full", tools: {} },
      });
      await saveAtLock;

      const reset = await resetConfig(port, csrf);
      expect(reset.status).toBe(200);
      releaseSave();

      const saved = await staleSave;
      expect(saved.status).toBe(409);
      expect(mocks.updateAccount).not.toHaveBeenCalled();
      const defaults = defaultConfig();
      expect(mocks.config).toMatchObject({
        configResetGeneration: 1,
        connection: defaults.connection,
        permissions: defaults.permissions,
        requireDestructiveConfirm: defaults.requireDestructiveConfirm,
      });
      expect(mocks.config?.accounts).toBeUndefined();
    } finally {
      close();
    }
  });

  it("does not let a save queued before reset restore the reset configuration", async () => {
    // The old implementation built `current` before entering the lock. Pause
    // this request immediately before its critical section, let reset win, and
    // then release it. A correct implementation loads the default config only
    // after it owns the lock and applies just this request's settingsPort patch.
    mocks.config!.permissions = {
      ...mocks.config!.permissions,
      preset: "full",
    };
    mocks.config!.requireDestructiveConfirm = false;
    mocks.config!.connection = {
      ...mocks.config!.connection,
      password: "pre-reset-password-must-not-return",
      smtpToken: "pre-reset-token-must-not-return",
    };

    let saveReachedLock!: () => void;
    const saveAtLock = new Promise<void>(resolve => { saveReachedLock = resolve; });
    let releaseSave!: () => void;
    const saveMayEnter = new Promise<void>(resolve => { releaseSave = resolve; });
    let lockCall = 0;
    mocks.withConfigWriteLockAsync.mockImplementation(async <T>(fn: () => Promise<T>) => {
      // The first call is the stale config-save. It has parsed/validated its
      // payload but has not acquired the write lock yet. Reset's nested calls
      // run normally, modelling a reset that wins the lock race.
      if (lockCall++ === 0) {
        saveReachedLock();
        await saveMayEnter;
      }
      return fn();
    });

    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const csrf = await csrfFrom(port);
      const staleSave = saveSettingsPatch(port, csrf, { settingsPort: 48231 });
      await saveAtLock;

      const reset = await resetConfig(port, csrf);
      expect(reset.status).toBe(200);

      releaseSave();
      const saved = await staleSave;
      expect(saved.status).toBe(200);

      // The one new patch is allowed, but no stale account, connection, or
      // security-policy state may be written back over the reset defaults.
      const defaults = defaultConfig();
      expect(mocks.config).toMatchObject({
        settingsPort: 48231,
        connection: {
          username: defaults.connection.username,
          password: defaults.connection.password,
          smtpToken: defaults.connection.smtpToken,
        },
        permissions: defaults.permissions,
        requireDestructiveConfirm: defaults.requireDestructiveConfirm,
      });
      expect(mocks.config?.accounts).toBeUndefined();
    } finally {
      close();
    }
  });

  it("retains both disjoint settings patches when requests queue before either save", async () => {
    // Both requests arrive and parse against the same old snapshot. Their
    // critical sections then run one-at-a-time. Loading and patching inside
    // each critical section is what lets the second writer retain the first
    // writer's settingsPort rather than saving its stale full config object.
    let firstReachedLock!: () => void;
    const firstAtLock = new Promise<void>(resolve => { firstReachedLock = resolve; });
    let secondReachedLock!: () => void;
    const secondAtLock = new Promise<void>(resolve => { secondReachedLock = resolve; });
    let releaseFirst!: () => void;
    const firstMayEnter = new Promise<void>(resolve => { releaseFirst = resolve; });
    let releaseSecond!: () => void;
    const secondMayEnter = new Promise<void>(resolve => { releaseSecond = resolve; });
    let lockCall = 0;
    mocks.withConfigWriteLockAsync.mockImplementation(async <T>(fn: () => Promise<T>) => {
      const call = lockCall++;
      if (call === 0) {
        firstReachedLock();
        await firstMayEnter;
      } else if (call === 1) {
        secondReachedLock();
        await secondMayEnter;
      }
      return fn();
    });

    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const csrf = await csrfFrom(port);
      const first = saveSettingsPatch(port, csrf, { settingsPort: 48232 });
      await firstAtLock;
      const second = saveSettingsPatch(port, csrf, { requireDestructiveConfirm: true });
      await secondAtLock;

      releaseFirst();
      expect((await first).status).toBe(200);
      releaseSecond();
      expect((await second).status).toBe(200);

      expect(mocks.config).toMatchObject({
        settingsPort: 48232,
        requireDestructiveConfirm: true,
      });
    } finally {
      close();
    }
  });
});

describe("preset and escalation saves after a competing reset (SEC-CONFIG-RMW-001)", () => {
  function seedPreResetConfiguration(): void {
    mocks.config!.permissions = {
      ...mocks.config!.permissions,
      preset: "read_only",
    };
    mocks.config!.requireDestructiveConfirm = false;
    mocks.config!.connection = {
      ...mocks.config!.connection,
      password: "pre-reset-password-must-not-return",
      smtpToken: "pre-reset-token-must-not-return",
    };
  }

  function resetImmediatelyBeforeFirstLockedCallback(): () => boolean {
    let resetApplied = false;
    mocks.withConfigWriteLockAsync.mockImplementation(async <T>(fn: () => Promise<T>) => {
      // Model reset finishing after this request has been queued but before it
      // owns the lock. The endpoint must then load the new defaults inside the
      // callback instead of saving a config snapshot it captured beforehand.
      if (!resetApplied) {
        mocks.config = defaultConfig();
        resetApplied = true;
      }
      return fn();
    });
    return () => resetApplied;
  }

  function expectOnlyFreshPresetPatch(preset: string): void {
    const defaults = defaultConfig();
    expect(mocks.config).toMatchObject({
      connection: {
        username: defaults.connection.username,
        password: defaults.connection.password,
        smtpToken: defaults.connection.smtpToken,
      },
      permissions: { preset },
      requireDestructiveConfirm: defaults.requireDestructiveConfirm,
    });
    expect(mocks.config?.accounts).toBeUndefined();
  }

  it("applies /api/preset to the post-reset config rather than restoring a stale snapshot", async () => {
    seedPreResetConfiguration();
    const resetApplied = resetImmediatelyBeforeFirstLockedCallback();
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await postJson(port, "/api/preset", await csrfFrom(port), { preset: "full" });
      expect(result.status).toBe(200);
      expect(resetApplied()).toBe(true);
      expect(mocks.withConfigWriteLockAsync).toHaveBeenCalledTimes(1);
      expectOnlyFreshPresetPatch("full");
    } finally {
      close();
    }
  });

  it("applies an approved escalation preset to the post-reset config rather than restoring a stale snapshot", async () => {
    seedPreResetConfiguration();
    const resetApplied = resetImmediatelyBeforeFirstLockedCallback();
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const id = "a".repeat(32);
      const result = await postJson(
        port,
        `/api/escalations/${id}/approve`,
        await csrfFrom(port),
        { confirm: "APPROVE" },
        { includeOrigin: false },
      );
      expect(result.status).toBe(200);
      expect(mocks.approveEscalation).toHaveBeenCalledWith(id, "browser_ui");
      expect(resetApplied()).toBe(true);
      expect(mocks.withConfigWriteLockAsync).toHaveBeenCalledTimes(1);
      expectOnlyFreshPresetPatch("full");
    } finally {
      close();
    }
  });
});

describe("POST /api/reset", () => {
  it("clears persisted configuration, rebuilds live services, and reports a live reset", async () => {
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await resetConfig(port, await csrfFrom(port));

      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        restartRequired: false,
        credentialsCleared: true,
        manualKeychainCleanupRequired: false,
      });
      expect(mocks.deleteCredentials).toHaveBeenCalledTimes(1);
      expect(mocks.deleteAccountCredentials).toHaveBeenCalledWith("primary");
      expect(mocks.deleteAccountCredentials).toHaveBeenCalledWith("account-a");
      expect(mocks.deleteAccountCredentials).toHaveBeenCalledWith("account-b");
      expect(mocks.deleteAuxiliaryCredentials).toHaveBeenCalledWith({
        passAccessToken: true,
        simpleloginApiKey: true,
      });
      expect(mocks.deleteRemoteSecrets).toHaveBeenCalledTimes(1);
      expect(mocks.config).toMatchObject({
        connection: { username: "", password: "", smtpToken: "" },
        permissions: { preset: "read_only" },
      });
      expect(mocks.config?.accounts).toBeUndefined();
      expect(mocks.manager!.rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(mocks.manager!.rebuildFromRegistryWithoutKeychain).not.toHaveBeenCalled();
      expect(mocks.disableAuxiliaryServices).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it("requires restart when the settings process has no live AccountManager", async () => {
    mocks.manager = null;
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await resetConfig(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, restartRequired: true });
    } finally {
      close();
    }
  });

  it("keeps mailbox hydration live but disables auxiliary clients when only auxiliary reset cleanup fails", async () => {
    mocks.deleteAuxiliaryCredentials.mockResolvedValue(false);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await resetConfig(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        credentialsCleared: false,
        restartRequired: true,
        manualKeychainCleanupRequired: true,
      });
      // The mailbox keychain deletes succeeded, so only the integration
      // failure needs a restart/manual cleanup. Do not unnecessarily suspend
      // fresh mailbox hydration merely because an auxiliary secret failed.
      expect(mocks.manager!.rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(mocks.manager!.rebuildFromRegistryWithoutKeychain).not.toHaveBeenCalled();
      expect(mocks.disableAuxiliaryServices).toHaveBeenCalledTimes(1);
      // Reset must not refresh from a keychain entry that failed to delete.
      expect(mocks.refreshAuxiliaryServices).not.toHaveBeenCalled();
    } finally {
      close();
    }
  });

  it("suspends mailbox hydration when a mailbox credential delete fails", async () => {
    mocks.deleteAccountCredentials.mockImplementation(async (accountId: string) => accountId !== "account-a");
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await resetConfig(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        credentialsCleared: false,
        restartRequired: true,
        manualKeychainCleanupRequired: true,
      });
      expect(mocks.manager!.rebuildFromRegistryWithoutKeychain).toHaveBeenCalledTimes(1);
      expect(mocks.manager!.rebuildFromRegistryAsync).not.toHaveBeenCalled();
      expect(mocks.disableAuxiliaryServices).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it("force-disables live auxiliary clients even when the AccountManager rebuild fails", async () => {
    const rebuildFromRegistryAsync = vi.fn().mockRejectedValue(new Error("rebuild failed"));
    mocks.manager = {
      rebuildFromRegistryAsync,
      rebuildFromRegistryWithoutKeychain: vi.fn(),
      activeAccountId: () => "account-b",
      connectAccount: vi.fn().mockResolvedValue(undefined),
    };
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await resetConfig(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, restartRequired: true });
      expect(rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(mocks.disableAuxiliaryServices).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });

  it("requires restart if auxiliary services cannot be disabled after a live reset", async () => {
    mocks.disableAuxiliaryServices.mockResolvedValue(false);
    const server = createSettingsServer({ port: 8765, lan: false, accessToken: null, scheme: "http" });
    const { port, close } = await listen(server);
    try {
      const result = await resetConfig(port, await csrfFrom(port));
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({ ok: true, restartRequired: true });
      expect(mocks.manager!.rebuildFromRegistryAsync).toHaveBeenCalledTimes(1);
      expect(mocks.disableAuxiliaryServices).toHaveBeenCalledTimes(1);
    } finally {
      close();
    }
  });
});
