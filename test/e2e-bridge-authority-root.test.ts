import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  bridgeMailboxScopeKeyFromConfig,
  resolveBridgeAuthorityScope,
} from "./e2e/support/bridge-authority-root.mjs";

const roots: string[] = [];
const mailboxConfig = (username = "owner@proton.test", host = "localhost") => ({
  connection: { imapHost: host, imapPort: 1143, username },
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Bridge E2E stable authority root", () => {
  it("maps symlink aliases of one config to the same private user scope", () => {
    const root = mkdtempSync(join(tmpdir(), "mailpouch-bridge-authority-"));
    roots.push(root);
    const homeRoot = join(root, "home");
    const configPath = join(root, "operator.json");
    const aliasPath = join(root, "operator-alias.json");
    mkdirSync(homeRoot);
    writeFileSync(configPath, JSON.stringify(mailboxConfig()), { mode: 0o600 });
    symlinkSync(configPath, aliasPath);

    const direct = resolveBridgeAuthorityScope({ authorityConfigPath: configPath, homeRoot });
    const alias = resolveBridgeAuthorityScope({ authorityConfigPath: aliasPath, homeRoot });

    expect(alias.scopeId).toBe(direct.scopeId);
    expect(alias.scopeRoot).toBe(direct.scopeRoot);
    expect(lstatSync(direct.baseRoot).isSymbolicLink()).toBe(false);
    if (process.platform !== "win32") {
      expect(lstatSync(dirname(direct.baseRoot)).mode & 0o777).toBe(0o700);
      expect(lstatSync(direct.baseRoot).mode & 0o777).toBe(0o700);
      expect(lstatSync(direct.scopeRoot).mode & 0o777).toBe(0o700);
    }
  });

  it("maps distinct profiles selecting the same normalized mailbox to one scope", () => {
    const root = mkdtempSync(join(tmpdir(), "mailpouch-bridge-authority-mailbox-"));
    roots.push(root);
    const homeRoot = join(root, "home");
    const firstPath = join(root, "first.json");
    const secondPath = join(root, "second.json");
    const otherPath = join(root, "other.json");
    mkdirSync(homeRoot);
    writeFileSync(firstPath, JSON.stringify(mailboxConfig("Owner@Proton.Test", "localhost")));
    writeFileSync(secondPath, JSON.stringify(mailboxConfig("owner@proton.test", "127.0.0.1")));
    writeFileSync(otherPath, JSON.stringify(mailboxConfig("other@proton.test", "localhost")));

    const first = resolveBridgeAuthorityScope({ authorityConfigPath: firstPath, homeRoot });
    const second = resolveBridgeAuthorityScope({ authorityConfigPath: secondPath, homeRoot });
    const other = resolveBridgeAuthorityScope({ authorityConfigPath: otherPath, homeRoot });

    expect(second.authorityConfigPath).not.toBe(first.authorityConfigPath);
    expect(second.mailboxScopeKey).toBe(first.mailboxScopeKey);
    expect(second.scopeRoot).toBe(first.scopeRoot);
    expect(other.scopeRoot).not.toBe(first.scopeRoot);
    expect(first.scopeId).not.toContain("owner@proton.test");
  });

  it("selects the active account when deriving mailbox identity", () => {
    const key = bridgeMailboxScopeKeyFromConfig({
      connection: mailboxConfig("legacy@proton.test").connection,
      activeAccountId: "selected",
      accounts: [
        { id: "other", ...mailboxConfig("other@proton.test").connection },
        { id: "selected", ...mailboxConfig("owner@proton.test").connection },
      ],
    });
    expect(key).toBe(bridgeMailboxScopeKeyFromConfig(mailboxConfig()));
  });
});
