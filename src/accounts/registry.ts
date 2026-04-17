/**
 * Account registry — CRUD + active-selection over the AccountSpec array.
 *
 * Persistence piggybacks on the main config file (ServerConfig.accounts and
 * ServerConfig.activeAccountId). Writes go through the existing saveConfig
 * atomic-rename path. Migration from a pre-accounts config is lazy: when
 * the registry is first loaded and the accounts array is empty, the
 * top-level connection fields are lifted into a "primary" account so the
 * existing single-account behavior is preserved byte-for-byte.
 */

import { randomBytes } from "crypto";
import type { ServerConfig } from "../config/schema.js";
import { loadConfig, saveConfig, defaultConfig } from "../config/loader.js";
import type { AccountSpec, AccountRegistry, AccountStatus } from "./types.js";

export function shortId(): string {
  return `acct-${randomBytes(4).toString("hex")}`;
}

/**
 * Build a sanitized AccountSpec from the legacy top-level connection fields
 * on a ServerConfig. Used for the one-time migration when a user with a
 * pre-accounts config first opens the new UI.
 */
function specFromLegacy(cfg: ServerConfig): AccountSpec {
  const c = cfg.connection;
  const isBridge =
    (c.smtpHost === "localhost" || c.smtpHost === "127.0.0.1")
    && (c.imapHost === "localhost" || c.imapHost === "127.0.0.1");
  return {
    id: "primary",
    name: isBridge ? "Proton Mail (Bridge)" : (c.username || "Primary account"),
    providerType: isBridge ? "proton-bridge" : "imap",
    smtpHost: c.smtpHost, smtpPort: c.smtpPort,
    imapHost: c.imapHost, imapPort: c.imapPort,
    username: c.username, password: c.password,
    smtpToken: c.smtpToken || undefined,
    bridgeCertPath: c.bridgeCertPath || undefined,
    allowInsecureBridge: c.allowInsecureBridge,
    tlsMode: c.tlsMode,
    autoStartBridge: c.autoStartBridge,
    bridgePath: c.bridgePath || undefined,
  };
}

export function readRegistry(): AccountRegistry {
  const cfg = loadConfig() ?? defaultConfig();
  if (cfg.accounts && cfg.accounts.length > 0) {
    const activeId = cfg.activeAccountId
      && cfg.accounts.some(a => a.id === cfg.activeAccountId)
      ? cfg.activeAccountId
      : cfg.accounts[0].id;
    return { accounts: cfg.accounts, activeAccountId: activeId };
  }
  // Legacy migration path — lift the singleton connection into an account.
  const primary = specFromLegacy(cfg);
  return { accounts: [primary], activeAccountId: primary.id };
}

/** Persist the registry into the server config file. */
export function writeRegistry(reg: AccountRegistry): void {
  const cfg = loadConfig() ?? defaultConfig();
  cfg.accounts = reg.accounts;
  cfg.activeAccountId = reg.activeAccountId;
  // Mirror the *active* account's connection fields back into the
  // legacy top-level shape so the existing service bootstrap still
  // finds them at startup. This is how switching account without
  // refactoring every consumer can work.
  const active = reg.accounts.find(a => a.id === reg.activeAccountId) ?? reg.accounts[0];
  if (active) {
    cfg.connection = {
      ...cfg.connection,
      smtpHost: active.smtpHost, smtpPort: active.smtpPort,
      imapHost: active.imapHost, imapPort: active.imapPort,
      username: active.username, password: active.password,
      smtpToken: active.smtpToken ?? "",
      bridgeCertPath: active.bridgeCertPath ?? "",
      allowInsecureBridge: active.allowInsecureBridge,
      tlsMode: active.tlsMode,
      autoStartBridge: active.autoStartBridge,
      bridgePath: active.bridgePath,
    };
  }
  saveConfig(cfg);
}

export function listStatuses(): AccountStatus[] {
  const reg = readRegistry();
  return reg.accounts.map(a => ({
    id: a.id,
    name: a.name,
    providerType: a.providerType,
    isActive: a.id === reg.activeAccountId,
    lastCheckedAt: a.lastCheckedAt,
    lastCheckResult: a.lastCheckResult,
  }));
}

export function createAccount(spec: Omit<AccountSpec, "id">): AccountSpec {
  const reg = readRegistry();
  const account: AccountSpec = { ...spec, id: shortId() };
  reg.accounts.push(account);
  writeRegistry(reg);
  return account;
}

/** Patch fields on an existing account. Unknown IDs return null. */
export function updateAccount(id: string, patch: Partial<AccountSpec>): AccountSpec | null {
  const reg = readRegistry();
  const idx = reg.accounts.findIndex(a => a.id === id);
  if (idx < 0) return null;
  const merged = { ...reg.accounts[idx], ...patch, id };
  reg.accounts[idx] = merged;
  writeRegistry(reg);
  return merged;
}

export function deleteAccount(id: string): boolean {
  const reg = readRegistry();
  if (reg.accounts.length <= 1) {
    // Refuse to delete the last account — leaves the server without
    // anywhere to connect.
    return false;
  }
  const before = reg.accounts.length;
  reg.accounts = reg.accounts.filter(a => a.id !== id);
  if (reg.accounts.length === before) return false;
  if (reg.activeAccountId === id) {
    reg.activeAccountId = reg.accounts[0].id;
  }
  writeRegistry(reg);
  return true;
}

export function setActiveAccount(id: string): AccountSpec | null {
  const reg = readRegistry();
  const match = reg.accounts.find(a => a.id === id);
  if (!match) return null;
  reg.activeAccountId = id;
  writeRegistry(reg);
  return match;
}
