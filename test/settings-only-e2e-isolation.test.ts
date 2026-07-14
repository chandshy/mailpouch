import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { e2eConfigOnlyCredentialsRequested } from "../src/config/e2e-credential-mode.js";
import { StartupCredentialAccess } from "../src/config/startup-credential-access.js";
import {
  buildSettingsOnlyIsolation,
  SETTINGS_ONLY_RUNTIME_FILES,
} from "./e2e/support/settings-only-isolation.js";

const TOKEN = "mpE2E-12345678-1234-4abc-8def-1234567890ab";

describe("settings-only E2E child isolation", () => {
  it("uses an exact config-only token, durable quarantines, and private runtime paths", async () => {
    const fixture = buildSettingsOnlyIsolation({
      KEEP_ME: "yes",
      GH_TOKEN: "operator-github-token",
      MAILPOUCH_MACHINE_SECRET: "operator-machine-secret",
      MAILPOUCH_E2E_RUN_TOKEN: TOKEN,
      MAILPOUCH_E2E_BRIDGE_CONFIG: "/home/test/.mailpouch.json",
      MAILPOUCH_NO_SINGLETON: "1",
      MAILPOUCH_INSECURE_BRIDGE: "1",
      MAILPOUCH_AGENTS: "/home/test/.mailpouch-agents.json",
      MAILPOUCH_LOG_FILE: "/home/test/.mailpouch.log",
      MAILPOUCH_SCHEDULER_STORE: "/home/test/.mailpouch-scheduled.json",
    }, "/home/test", 8_977, TOKEN);

    expect(fixture.configPath).toBe(join(
      fixture.stateRoot,
      `.mailpouch-e2e-greenmail-${TOKEN}.json`,
    ));
    expect(e2eConfigOnlyCredentialsRequested(fixture.env, fixture.configPath)).toBe(true);
    expect(fixture.env).toMatchObject({
      KEEP_ME: "yes",
      MAILPOUCH_CONFIG: fixture.configPath,
      MAILPOUCH_E2E_CONFIG_ONLY_CREDENTIALS: "1",
      MAILPOUCH_E2E_CREDENTIAL_TOKEN: TOKEN,
    });
    expect(fixture.env.MAILPOUCH_E2E_RUN_TOKEN).toBeUndefined();
    expect(fixture.env.MAILPOUCH_E2E_BRIDGE_CONFIG).toBeUndefined();
    expect(fixture.env.MAILPOUCH_NO_SINGLETON).toBeUndefined();
    expect(fixture.env.MAILPOUCH_INSECURE_BRIDGE).toBeUndefined();
    expect(fixture.env.GH_TOKEN).toBeUndefined();
    expect(fixture.env.MAILPOUCH_MACHINE_SECRET).toBeUndefined();

    for (const [name, basename] of Object.entries(SETTINGS_ONLY_RUNTIME_FILES)) {
      expect(fixture.env[name]).toBe(join(fixture.stateRoot, basename));
    }
    expect(fixture.config.connection.password).toBe("");
    expect(fixture.config.connection.smtpToken).toBe("");
    expect(fixture.config.keychainMailboxCredentialsQuarantined).toBe(true);
    expect(fixture.config.keychainAuxiliaryCredentialsQuarantined).toEqual({
      passAccessToken: true,
      simpleloginApiKey: true,
    });

    // Tie the fixture to the executable startup policy: neither migration nor
    // any external keychain reader may run for this exact child profile.
    const access = new StartupCredentialAccess(fixture.env, fixture.configPath);
    const migrate = vi.fn(async () => true);
    const external = vi.fn(async () => "operator-secret");
    const mailboxFromConfig = vi.fn(async () => "");
    const mailboxFromKeychain = vi.fn(async () => "operator-mailbox-secret");
    await expect(access.migrate(migrate)).resolves.toBe(false);
    await expect(access.readExternal(external)).resolves.toBeNull();
    await expect(access.readMailbox(mailboxFromConfig, mailboxFromKeychain)).resolves.toBe("");
    expect(migrate).not.toHaveBeenCalled();
    expect(external).not.toHaveBeenCalled();
    expect(mailboxFromConfig).toHaveBeenCalledOnce();
    expect(mailboxFromKeychain).not.toHaveBeenCalled();
  });

  it("refuses a non-UUID credential token before creating any paths", () => {
    expect(() => buildSettingsOnlyIsolation(
      {},
      "/home/test",
      8_977,
      "mpE2E-not-a-uuid",
    )).toThrow(/exact mpE2E UUIDv4 token/i);
  });
});
