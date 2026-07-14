/**
 * Tests for the account registry.
 *
 * The registry persists via saveConfig / loadConfig, both of which touch
 * disk. We mock the fs module so tests run in memory without polluting
 * the user's home directory.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { homedir } from "os";
import { join } from "path";
import type { ServerConfig } from "../config/schema.js";
import { CredentialEncryption } from "../crypto/credential-encryption.js";

// Resolve the config path the SAME way the loader does (`path.join(homedir(), ...)`),
// not via `${process.env.HOME}/...` — that would fail on Windows twice:
//   1. process.env.HOME is undefined there (Windows uses USERPROFILE).
//   2. Even after switching to homedir(), template-string concat produces
//      mixed-slash paths (`C:\Users\x/.mailpouch.json`) while `path.join`
//      normalizes to all backslashes. The fs mock is keyed by the normalized
//      form the loader writes, so the test must match it byte-for-byte.
const CONFIG_PATH = join(homedir(), ".mailpouch.json");

// Mock fs: one in-memory "disk" shared across the loader and the registry.
let diskByPath = new Map<string, string>();
let stableConfigMtimeMs: number | null = null;

vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    existsSync: vi.fn((p: string) => diskByPath.has(String(p))),
    readFileSync: vi.fn((p: string) => {
      const s = diskByPath.get(String(p));
      if (s === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return s;
    }),
    writeFileSync: vi.fn((p: string, data: string | Buffer) => {
      diskByPath.set(String(p), typeof data === "string" ? data : data.toString("utf-8"));
    }),
    renameSync: vi.fn((from: string, to: string) => {
      const s = diskByPath.get(String(from));
      if (s === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      diskByPath.delete(String(from));
      diskByPath.set(String(to), s);
    }),
    statSync: vi.fn((p: string) => {
      if (stableConfigMtimeMs !== null && String(p) === CONFIG_PATH) {
        return { mtimeMs: stableConfigMtimeMs, mode: 0o600 };
      }
      // Default test mode: make the loader's cache check fail so existing
      // cases continue to observe the in-memory disk directly.
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }),
    // CRED-008 config-lock primitives: no-op so writeRegistry's lock doesn't
    // touch the real home dir. Real concurrency is covered by config-lock.test.ts.
    mkdirSync: vi.fn(),
    rmdirSync: vi.fn(),
    openSync: vi.fn(() => 3),
    fsyncSync: vi.fn(),
    closeSync: vi.fn(),
    unlinkSync: vi.fn(),
    appendFile: vi.fn((_path: string, _data: string, _enc: string, cb: () => void) => cb()),
  };
});

vi.mock("../security/keychain.js", () => ({
  isKeychainAvailable: vi.fn(() => false),
  loadCredentials: vi.fn(),
  saveCredentials: vi.fn(),
  migrateFromConfig: vi.fn(),
  // Per-account helpers added for multi-account keychain routing.
  // Returning false / null across the board makes the registry's
  // writeRegistry fall back to its plaintext-on-disk legacy path,
  // matching what these tests were originally written against.
  loadAccountCredentials: vi.fn(() => Promise.resolve(null)),
  saveAccountCredentials: vi.fn(() => Promise.resolve({ passwordStored: false, smtpTokenStored: false })),
  deleteAccountCredentials: vi.fn(() => Promise.resolve(false)),
}));

import {
  readRegistry,
  readRegistryWithSecrets,
  createAccount,
  updateAccount,
  deleteAccount,
  setActiveAccount,
  listStatuses,
} from "./registry.js";
import { defaultConfig, invalidateConfigCache } from "../config/loader.js";

function seedConfig(cfg: Partial<ServerConfig>): void {
  const base = defaultConfig();
  const merged = { ...base, ...cfg };
  diskByPath.set(CONFIG_PATH, JSON.stringify(merged));
}

/**
 * Populate the loader cache with a pre-reset registry, then atomically replace
 * the mocked file with defaults without changing its observable mtime.
 */
function cachePreResetRegistryThenReplaceWithDefaults(): void {
  stableConfigMtimeMs = 1_234_567;
  const stale = defaultConfig();
  stale.accounts = [
    {
      id: "primary",
      name: "Old primary",
      providerType: "imap",
      smtpHost: "smtp.old.example",
      smtpPort: 587,
      imapHost: "imap.old.example",
      imapPort: 993,
      username: "old@example.com",
      password: "",
    },
    {
      id: "stale-account",
      name: "Must stay reset",
      providerType: "imap",
      smtpHost: "smtp.stale.example",
      smtpPort: 587,
      imapHost: "imap.stale.example",
      imapPort: 993,
      username: "stale@example.com",
      password: "",
    },
  ];
  stale.activeAccountId = "stale-account";
  diskByPath.set(CONFIG_PATH, JSON.stringify(stale));
  invalidateConfigCache();
  expect(readRegistry().accounts.map(account => account.id)).toContain("stale-account");

  // Model another process completing reset via atomic rename. Some filesystems
  // expose the replacement with the same timestamp, so mtime-based cache
  // validation alone cannot distinguish these two snapshots.
  diskByPath.set(CONFIG_PATH, JSON.stringify(defaultConfig()));
}

describe("accounts registry", () => {
  beforeEach(() => {
    diskByPath = new Map();
    stableConfigMtimeMs = null;
    invalidateConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("migrates a legacy single-account config into an accounts array on first read", () => {
    seedConfig({
      connection: {
        smtpHost: "localhost", smtpPort: 1025,
        imapHost: "localhost", imapPort: 1143,
        username: "me@example.com", password: "pw", smtpToken: "",
        bridgeCertPath: "", debug: false,
      },
    });
    const reg = readRegistry();
    expect(reg.accounts).toHaveLength(1);
    expect(reg.accounts[0].id).toBe("primary");
    expect(reg.accounts[0].providerType).toBe("proton-bridge");
    expect(reg.accounts[0].username).toBe("me@example.com");
    expect(reg.activeAccountId).toBe("primary");
  });

  it("classifies non-localhost connections as generic imap", () => {
    seedConfig({
      connection: {
        smtpHost: "smtp.fastmail.com", smtpPort: 587,
        imapHost: "imap.fastmail.com", imapPort: 993,
        username: "me@fastmail.com", password: "pw", smtpToken: "",
        bridgeCertPath: "", debug: false,
      },
    });
    expect(readRegistry().accounts[0].providerType).toBe("imap");
  });

  it("createAccount appends, writes back, and assigns a short id", async () => {
    seedConfig({}); // minimal — triggers legacy migration to one primary account
    const created = await createAccount({
      name: "Work Fastmail", providerType: "imap",
      smtpHost: "smtp.fastmail.com", smtpPort: 587,
      imapHost: "imap.fastmail.com", imapPort: 993,
      username: "u@example.com", password: "pw",
    });
    expect(created.id).toMatch(/^acct-[0-9a-f]{8}$/);
    const reg = readRegistry();
    expect(reg.accounts).toHaveLength(2);
    expect(reg.accounts.map(a => a.id)).toContain(created.id);
  });

  it("updateAccount patches fields and preserves the id", async () => {
    seedConfig({});
    const created = await createAccount({
      name: "Test", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    const patched = await updateAccount(created.id, { name: "Renamed" });
    expect(patched?.name).toBe("Renamed");
    expect(patched?.id).toBe(created.id);
  });

  it("serializes concurrent read-modify-write updates without dropping either account", async () => {
    seedConfig({});
    const extra = await createAccount({
      name: "Concurrent B", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "b", password: "pw",
    });

    await Promise.all([
      updateAccount("primary", { name: "Concurrent A updated" }),
      updateAccount(extra.id, { name: "Concurrent B updated" }),
    ]);

    const reg = readRegistry();
    expect(reg.accounts.find(a => a.id === "primary")?.name).toBe("Concurrent A updated");
    expect(reg.accounts.find(a => a.id === extra.id)?.name).toBe("Concurrent B updated");
  });

  it("createAccount does not restore a same-mtime cached registry after an external reset", async () => {
    cachePreResetRegistryThenReplaceWithDefaults();

    const created = await createAccount({
      name: "New after reset",
      providerType: "imap",
      smtpHost: "smtp.new.example",
      smtpPort: 587,
      imapHost: "imap.new.example",
      imapPort: 993,
      username: "new@example.com",
      password: "",
    });

    const persisted = JSON.parse(diskByPath.get(CONFIG_PATH)!) as ServerConfig;
    expect(persisted.accounts?.map(account => account.id)).toEqual(["primary", created.id]);
    expect(persisted.accounts?.some(account => account.id === "stale-account")).toBe(false);
  });

  it("updateAccount does not patch an account that only exists in a same-mtime stale cache", async () => {
    cachePreResetRegistryThenReplaceWithDefaults();

    await expect(updateAccount("stale-account", { name: "Restored by stale update" }))
      .resolves.toBeNull();
    expect(JSON.parse(diskByPath.get(CONFIG_PATH)!).accounts).toBeUndefined();
  });

  it("deleteAccount does not restore a same-mtime stale registry while deleting from it", async () => {
    cachePreResetRegistryThenReplaceWithDefaults();

    await expect(deleteAccount("stale-account")).resolves.toBe(false);
    expect(JSON.parse(diskByPath.get(CONFIG_PATH)!).accounts).toBeUndefined();
  });

  it("setActiveAccount does not reactivate an account from a same-mtime stale cache", async () => {
    cachePreResetRegistryThenReplaceWithDefaults();

    await expect(setActiveAccount("stale-account")).resolves.toBeNull();
    const persisted = JSON.parse(diskByPath.get(CONFIG_PATH)!) as ServerConfig;
    expect(persisted.accounts).toBeUndefined();
    expect(persisted.activeAccountId).toBeUndefined();
  });

  it("returns detached account specs so keychain hydration cannot mutate the config cache", async () => {
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.loadAccountCredentials).mockResolvedValue({ password: "keychain-password", smtpToken: "keychain-token" });
    seedConfig({
      accounts: [
        { id: "primary", name: "A", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "a", password: "", smtpToken: "" },
      ],
      activeAccountId: "primary",
    } as Partial<ServerConfig>);

    const hydrated = await readRegistryWithSecrets();
    expect(hydrated.accounts[0]).toMatchObject({ password: "keychain-password", smtpToken: "keychain-token" });
    // A fresh registry read comes from the persisted/config-cache snapshot,
    // not the secret-filled object returned to AccountManager.
    expect(readRegistry().accounts[0]).toMatchObject({ password: "", smtpToken: "" });
  });

  it("does not hydrate stale keychain credentials when reset persisted the mailbox quarantine", async () => {
    const keychain = await import("../security/keychain.js");
    const loadAccount = vi.mocked(keychain.loadAccountCredentials);
    const loadLegacy = vi.mocked(keychain.loadCredentials);
    loadAccount.mockReset();
    loadLegacy.mockReset();
    loadAccount.mockResolvedValue({ password: "stale-account-password", smtpToken: "stale-account-token" });
    loadLegacy.mockResolvedValue({ password: "stale-legacy-password", smtpToken: "stale-legacy-token" });
    seedConfig({
      keychainMailboxCredentialsQuarantined: true,
      accounts: [
        { id: "primary", name: "Reset", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "", password: "", smtpToken: "" },
      ],
      activeAccountId: "primary",
    } as Partial<ServerConfig>);

    const reg = await readRegistryWithSecrets();

    expect(loadAccount).not.toHaveBeenCalled();
    expect(loadLegacy).not.toHaveBeenCalled();
    expect(reg.accounts[0]).toMatchObject({ password: "", smtpToken: "" });
  });

  it("hydrates only the selected account from an exact quarantined E2E encrypted clone without OS keychain reads", async () => {
    const token = "mpE2E-00000000-0000-4000-8000-000000000004";
    const configPath = join(homedir(), `.mailpouch-e2e-bridge-${token}.json`);
    vi.stubEnv("MAILPOUCH_CONFIG", configPath);
    vi.stubEnv("MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS", "1");
    vi.stubEnv("MAILPOUCH_E2E_RUN_TOKEN", token);
    vi.stubEnv("MAILPOUCH_MACHINE_SECRET", "registry-e2e-machine-secret");

    const keychain = await import("../security/keychain.js");
    const loadAccount = vi.mocked(keychain.loadAccountCredentials);
    const loadLegacy = vi.mocked(keychain.loadCredentials);
    loadAccount.mockClear();
    loadLegacy.mockClear();

    const cfg = defaultConfig();
    cfg.keychainMailboxCredentialsQuarantined = true;
    cfg.connection.passwordEncrypted = CredentialEncryption.encrypt("clone-password");
    cfg.connection.smtpTokenEncrypted = CredentialEncryption.encrypt("clone-smtp-token");
    cfg.accounts = [
      { id: "account-a", name: "A", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "a", password: "", smtpToken: "" },
      { id: "account-b", name: "B", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "b", password: "", smtpToken: "" },
    ];
    cfg.activeAccountId = "account-b";
    diskByPath.set(configPath, JSON.stringify(cfg));
    invalidateConfigCache();

    const reg = await readRegistryWithSecrets();

    expect(reg.activeAccountId).toBe("account-b");
    expect(reg.accounts.find(account => account.id === "account-a")).toMatchObject({ password: "" });
    expect(reg.accounts.find(account => account.id === "account-a")?.smtpToken).toBeUndefined();
    expect(reg.accounts.find(account => account.id === "account-b")).toMatchObject({
      password: "clone-password",
      smtpToken: "clone-smtp-token",
    });
    expect(loadAccount).not.toHaveBeenCalled();
    expect(loadLegacy).not.toHaveBeenCalled();
  });

  it("hydrates an exact quarantined Greenmail profile from config without any OS keychain read", async () => {
    const token = "mpE2E-00000000-0000-4000-8000-000000000006";
    const configPath = join(homedir(), `.mailpouch-e2e-greenmail-${token}.json`);
    vi.stubEnv("MAILPOUCH_CONFIG", configPath);
    vi.stubEnv("MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS", "1");
    vi.stubEnv("MAILPOUCH_E2E_CREDENTIAL_TOKEN", token);

    const keychain = await import("../security/keychain.js");
    const loadAccount = vi.mocked(keychain.loadAccountCredentials);
    const loadLegacy = vi.mocked(keychain.loadCredentials);
    loadAccount.mockClear();
    loadLegacy.mockClear();

    const cfg = defaultConfig();
    cfg.keychainMailboxCredentialsQuarantined = true;
    cfg.connection.username = "alice";
    cfg.connection.password = "greenmail-password";
    cfg.connection.smtpToken = "";
    diskByPath.set(configPath, JSON.stringify(cfg));
    invalidateConfigCache();

    const reg = await readRegistryWithSecrets();

    expect(reg.accounts).toHaveLength(1);
    expect(reg.accounts[0]).toMatchObject({
      id: "primary",
      username: "alice",
      password: "greenmail-password",
    });
    expect(loadAccount).not.toHaveBeenCalled();
    expect(loadLegacy).not.toHaveBeenCalled();
  });

  it("leaves the active exact-E2E account blank when encrypted clone authentication fails", async () => {
    const token = "mpE2E-00000000-0000-4000-8000-000000000005";
    const configPath = join(homedir(), `.mailpouch-e2e-bridge-${token}.json`);
    vi.stubEnv("MAILPOUCH_CONFIG", configPath);
    vi.stubEnv("MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS", "1");
    vi.stubEnv("MAILPOUCH_E2E_RUN_TOKEN", token);
    vi.stubEnv("MAILPOUCH_MACHINE_SECRET", "registry-e2e-machine-secret");

    const encrypted = CredentialEncryption.encrypt("real-clone-password");
    const bytes = Buffer.from(encrypted.encryptedData, "base64");
    bytes[0] ^= 0xff;

    const cfg = defaultConfig();
    cfg.keychainMailboxCredentialsQuarantined = true;
    cfg.connection.password = "untrusted-legacy-plaintext";
    cfg.connection.passwordEncrypted = { ...encrypted, encryptedData: bytes.toString("base64") };
    cfg.accounts = [
      { id: "account-a", name: "A", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "a", password: "non-active-value", smtpToken: "non-active-token" },
      { id: "account-b", name: "B", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "b", password: "untrusted-account-plaintext", smtpToken: "untrusted-account-token" },
    ];
    cfg.activeAccountId = "account-b";
    diskByPath.set(configPath, JSON.stringify(cfg));
    invalidateConfigCache();

    const reg = await readRegistryWithSecrets();

    expect(reg.accounts.find(account => account.id === "account-b")).toMatchObject({ password: "" });
    expect(reg.accounts.find(account => account.id === "account-b")?.smtpToken).toBeUndefined();
    expect(reg.accounts.find(account => account.id === "account-a")).toMatchObject({ password: "" });
    expect(reg.accounts.find(account => account.id === "account-a")?.smtpToken).toBeUndefined();
    expect(vi.mocked((await import("../security/keychain.js")).loadAccountCredentials)).not.toHaveBeenCalled();
    expect(vi.mocked((await import("../security/keychain.js")).loadCredentials)).not.toHaveBeenCalled();
  });

  it("updateAccount returns null for an unknown id", async () => {
    seedConfig({});
    expect(await updateAccount("acct-missing", { name: "X" })).toBeNull();
  });

  it("deleteAccount refuses to drop the last remaining account", async () => {
    seedConfig({});
    const reg = readRegistry();
    expect(await deleteAccount(reg.activeAccountId)).toBe(false);
    expect(readRegistry().accounts).toHaveLength(1);
  });

  it("deleteAccount drops a non-active account and leaves the rest alone", async () => {
    seedConfig({});
    const extra = await createAccount({
      name: "Extra", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    expect(await deleteAccount(extra.id)).toBe(true);
    expect(readRegistry().accounts.some(a => a.id === extra.id)).toBe(false);
  });

  it("deleteAccount reassigns the active id when the active account is dropped", async () => {
    seedConfig({});
    const extra = await createAccount({
      name: "Extra", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    await setActiveAccount(extra.id);
    expect(readRegistry().activeAccountId).toBe(extra.id);
    await deleteAccount(extra.id);
    const reg = readRegistry();
    expect(reg.activeAccountId).not.toBe(extra.id);
    expect(reg.accounts).toHaveLength(1);
  });

  it("setActiveAccount switches which account mirrors into connection", async () => {
    seedConfig({});
    const other = await createAccount({
      name: "Other", providerType: "imap",
      smtpHost: "smtp.other", smtpPort: 587, imapHost: "imap.other", imapPort: 993,
      username: "other@x", password: "pw",
    });
    await setActiveAccount(other.id);
    // Loading config should now show the mirrored settings.
    const cfg = JSON.parse(diskByPath.get(CONFIG_PATH) ?? "{}") as ServerConfig;
    expect(cfg.connection.smtpHost).toBe("smtp.other");
    expect(cfg.activeAccountId).toBe(other.id);
  });

  it("setActiveAccount returns null for an unknown id", async () => {
    seedConfig({});
    expect(await setActiveAccount("acct-bogus")).toBeNull();
  });

  it("listStatuses exposes the isActive flag and last-check metadata", async () => {
    seedConfig({});
    const extra = await createAccount({
      name: "B", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    await setActiveAccount(extra.id);
    const statuses = listStatuses();
    expect(statuses).toHaveLength(2);
    const active = statuses.find(s => s.isActive);
    expect(active?.id).toBe(extra.id);
  });

  it("SECURITY: writeRegistry via createAccount keeps plaintext passwords off disk when keychain is available", async () => {
    // Override the shared keychain mock just for this test to simulate
    // a working OS keychain. saveAccountCredentials returning true
    // signals "stored in keychain, caller should scrub the on-disk
    // copy." This is the regression test for the bug the user hit:
    // adding an account via the Accounts tab dumped plaintext into
    // ~/.mailpouch.json.
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.saveAccountCredentials).mockResolvedValue({ passwordStored: true, smtpTokenStored: false });
    seedConfig({});
    await createAccount({
      name: "Secret", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "PLAINTEXT-SHOULD-NOT-PERSIST",
    });
    const onDisk = JSON.parse(diskByPath.get(CONFIG_PATH) ?? "{}") as ServerConfig;
    const acct = onDisk.accounts?.find(a => a.name === "Secret");
    expect(acct).toBeDefined();
    expect(acct!.password).toBe("");                             // scrubbed
    expect(onDisk.connection.password).toBe("");                 // legacy mirror scrubbed
    expect(onDisk.credentialStorage).toBe("keychain");           // marker set
  });

  // ─── CRED-004 (audit 2026-05-28): backend detection from real result ─────

  it("CRED-004: password-only account with keychain available is marked 'keychain'", async () => {
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.saveAccountCredentials).mockResolvedValue({ passwordStored: true, smtpTokenStored: false });
    seedConfig({});
    await createAccount({
      name: "PwOnly", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "only-a-password", // no smtpToken
    });
    const onDisk = JSON.parse(diskByPath.get(CONFIG_PATH) ?? "{}") as ServerConfig;
    expect(onDisk.credentialStorage).toBe("keychain");
  });

  it("CRED-004: keychain FAILURE marks 'config' even when the scrubbed spec has no smtpToken", async () => {
    // The brittle predicate (`!password && !smtpToken`) used to infer keychain
    // success from the on-disk shape. A password-only account whose keychain
    // save FAILS keeps plaintext on disk — and must be reported as "config",
    // never "keychain". This guards the false-clean-badge regression.
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.saveAccountCredentials).mockResolvedValue({ passwordStored: false, smtpTokenStored: false });
    seedConfig({});
    await createAccount({
      name: "FailHost", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "stays-on-disk", // no smtpToken → scrubbed smtpToken is undefined
    });
    const onDisk = JSON.parse(diskByPath.get(CONFIG_PATH) ?? "{}") as ServerConfig;
    const acct = onDisk.accounts?.find(a => a.name === "FailHost");
    expect(acct!.password).toBe("stays-on-disk");  // keychain failed → plaintext kept
    expect(acct!.smtpToken).toBeUndefined();        // empty token coerced to undefined
    expect(onDisk.credentialStorage).toBe("config"); // NOT keychain
  });

  it("preserves only the failed credential field in config after a partial keychain write", async () => {
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.saveAccountCredentials).mockResolvedValue({
      passwordStored: true,
      smtpTokenStored: false,
    });
    seedConfig({});

    const created = await createAccount({
      name: "Partial", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "new-password", smtpToken: "new-config-token",
    });

    const onDisk = JSON.parse(diskByPath.get(CONFIG_PATH) ?? "{}") as ServerConfig;
    const persisted = onDisk.accounts?.find(account => account.id === created.id);
    expect(persisted).toMatchObject({ password: "", smtpToken: "new-config-token" });
    expect(onDisk.credentialStorage).toBe("config");

    // The token entry predates the failed rotation. Hydration must merge by
    // field: use the newly-stored password, but retain the newer config token.
    vi.mocked(keychain.loadAccountCredentials).mockResolvedValue({
      password: "new-password",
      smtpToken: "stale-keychain-token",
    });
    const hydrated = await readRegistryWithSecrets();
    expect(hydrated.accounts.find(account => account.id === created.id)).toMatchObject({
      password: "new-password",
      smtpToken: "new-config-token",
    });
  });

  // ─── CRED-005 — readRegistryWithSecrets fetches the keychain at most once ──

  it("CRED-005: hits loadAccountCredentials once per account, not twice", async () => {
    const keychain = await import("../security/keychain.js");
    const loadAcct = vi.mocked(keychain.loadAccountCredentials);
    loadAcct.mockReset();
    loadAcct.mockResolvedValue({ password: "pw", smtpToken: "tok" });
    // Two accounts, both with blank password+token on disk so both need a fetch.
    seedConfig({
      accounts: [
        { id: "primary", name: "A", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "a", password: "", smtpToken: "" },
        { id: "acct-2", name: "B", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "b", password: "", smtpToken: "" },
      ],
      activeAccountId: "primary",
    } as Partial<ServerConfig>);

    const reg = await readRegistryWithSecrets();
    // One keychain fetch per account (was two: one for password, one for token).
    expect(loadAcct).toHaveBeenCalledTimes(2);
    expect(reg.accounts.find(a => a.id === "primary")?.password).toBe("pw");
    expect(reg.accounts.find(a => a.id === "primary")?.smtpToken).toBe("tok");
  });

  it("keeps a non-empty config fallback ahead of stale per-account keychain fields", async () => {
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.loadAccountCredentials).mockReset();
    // These entries can be stale when a later per-field write failed.
    vi.mocked(keychain.loadAccountCredentials).mockResolvedValue({ password: "stale-per-account", smtpToken: "stale-tok" });
    vi.mocked(keychain.loadCredentials).mockResolvedValue({ password: "stale-legacy", smtpToken: "stale-tok" });
    // Non-empty fields are the new fallback values retained after that failure.
    seedConfig({
      accounts: [
        { id: "primary", name: "A", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "a", password: "new-config-password", smtpToken: "new-config-token" },
      ],
      activeAccountId: "primary",
    } as Partial<ServerConfig>);

    const reg = await readRegistryWithSecrets();
    expect(reg.accounts.find(a => a.id === "primary")?.password).toBe("new-config-password");
    expect(reg.accounts.find(a => a.id === "primary")?.smtpToken).toBe("new-config-token");
  });

  it("falls back to the existing value when no per-account keychain entry exists (single-account safe)", async () => {
    const keychain = await import("../security/keychain.js");
    vi.mocked(keychain.loadAccountCredentials).mockReset();
    vi.mocked(keychain.loadAccountCredentials).mockResolvedValue(null); // no per-account entry
    vi.mocked(keychain.loadCredentials).mockResolvedValue(null);
    seedConfig({
      accounts: [
        { id: "primary", name: "A", providerType: "imap", smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1, username: "a", password: "config-plaintext", smtpToken: "" },
      ],
      activeAccountId: "primary",
    } as Partial<ServerConfig>);

    const reg = await readRegistryWithSecrets();
    // No keychain entry → keep the value already on the spec (config plaintext / broadcast).
    expect(reg.accounts.find(a => a.id === "primary")?.password).toBe("config-plaintext");
  });
});
