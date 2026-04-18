/**
 * Tests for the account registry.
 *
 * The registry persists via saveConfig / loadConfig, both of which touch
 * disk. We mock the fs module so tests run in memory without polluting
 * the user's home directory.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { homedir } from "os";
import type { ServerConfig } from "../config/schema.js";

// Resolve the config path the SAME way the loader does (os.homedir()),
// not via process.env.HOME — that variable is unset on Windows, where
// node uses USERPROFILE under the hood. Using homedir() keeps the
// in-memory fs mock's keys aligned with the real loader's resolved path.
const CONFIG_PATH = `${homedir()}/.mailpouch.json`;

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

  it("createAccount appends, writes back, and assigns a short id", () => {
    seedConfig({}); // minimal — triggers legacy migration to one primary account
    const created = createAccount({
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

  it("updateAccount patches fields and preserves the id", () => {
    seedConfig({});
    const created = createAccount({
      name: "Test", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    const patched = updateAccount(created.id, { name: "Renamed" });
    expect(patched?.name).toBe("Renamed");
    expect(patched?.id).toBe(created.id);
  });

  it("updateAccount returns null for an unknown id", () => {
    seedConfig({});
    expect(updateAccount("acct-missing", { name: "X" })).toBeNull();
  });

  it("deleteAccount refuses to drop the last remaining account", () => {
    seedConfig({});
    const reg = readRegistry();
    expect(deleteAccount(reg.activeAccountId)).toBe(false);
    expect(readRegistry().accounts).toHaveLength(1);
  });

  it("deleteAccount drops a non-active account and leaves the rest alone", () => {
    seedConfig({});
    const extra = createAccount({
      name: "Extra", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    expect(deleteAccount(extra.id)).toBe(true);
    expect(readRegistry().accounts.some(a => a.id === extra.id)).toBe(false);
  });

  it("deleteAccount reassigns the active id when the active account is dropped", () => {
    seedConfig({});
    const extra = createAccount({
      name: "Extra", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    setActiveAccount(extra.id);
    expect(readRegistry().activeAccountId).toBe(extra.id);
    deleteAccount(extra.id);
    const reg = readRegistry();
    expect(reg.activeAccountId).not.toBe(extra.id);
    expect(reg.accounts).toHaveLength(1);
  });

  it("setActiveAccount switches which account mirrors into connection", () => {
    seedConfig({});
    const other = createAccount({
      name: "Other", providerType: "imap",
      smtpHost: "smtp.other", smtpPort: 587, imapHost: "imap.other", imapPort: 993,
      username: "other@x", password: "pw",
    });
    setActiveAccount(other.id);
    // Loading config should now show the mirrored settings.
    const cfg = JSON.parse(diskByPath.get(CONFIG_PATH) ?? "{}") as ServerConfig;
    expect(cfg.connection.smtpHost).toBe("smtp.other");
    expect(cfg.activeAccountId).toBe(other.id);
  });

  it("setActiveAccount returns null for an unknown id", () => {
    seedConfig({});
    expect(setActiveAccount("acct-bogus")).toBeNull();
  });

  it("listStatuses exposes the isActive flag and last-check metadata", () => {
    seedConfig({});
    const extra = createAccount({
      name: "B", providerType: "imap",
      smtpHost: "s", smtpPort: 1, imapHost: "i", imapPort: 1,
      username: "u", password: "pw",
    });
    setActiveAccount(extra.id);
    const statuses = listStatuses();
    expect(statuses).toHaveLength(2);
    const active = statuses.find(s => s.isActive);
    expect(active?.id).toBe(extra.id);
  });
});
