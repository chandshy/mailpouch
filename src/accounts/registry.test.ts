/**
 * Tests for the account registry.
 *
 * The registry persists via saveConfig / loadConfig, both of which touch
 * disk. We mock the fs module so tests run in memory without polluting
 * the user's home directory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "os";
import { join } from "path";
import type { ServerConfig } from "../config/schema.js";

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
  saveAccountCredentials: vi.fn(() => Promise.resolve(false)),
  deleteAccountCredentials: vi.fn(() => Promise.resolve(false)),
}));

import {
  readRegistry,
  createAccount,
  updateAccount,
  deleteAccount,
  setActiveAccount,
  listStatuses,
} from "./registry.js";
import { defaultConfig } from "../config/loader.js";

function seedConfig(cfg: Partial<ServerConfig>): void {
  const base = defaultConfig();
  const merged = { ...base, ...cfg };
  diskByPath.set(CONFIG_PATH, JSON.stringify(merged));
}

describe("accounts registry", () => {
  beforeEach(() => { diskByPath = new Map(); });

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
    vi.mocked(keychain.saveAccountCredentials).mockResolvedValue(true);
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
});
